"""主播查房官网正式发布：固定代码快照、独立只读 API、原子切换与回滚。"""

import argparse
import hashlib
import ipaddress
import json
import os
import re
import shlex
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
HELPER = TOOL_ROOT / "public-website/remote/release.py"
CONFIG = TOOL_ROOT / "config/public-website.production.local.env"
BRANCH = "feat/P1-WEB-01-public-property-website"
REMOTE_PYTHON = "/srv/loumai-backend/backend-current/.venv/bin/python"


def run(command, **kwargs):
    return subprocess.run(
        command, check=True, text=True, capture_output=True, **kwargs
    ).stdout.strip()


def load_config(path):
    values = {}
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    for prefix in ("PRODUCTION", "OLD"):
        target = values[f"WEBSITE_{prefix}_TARGET"]
        assert re.fullmatch(r"[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+", target)
        assert Path(values[f"WEBSITE_{prefix}_KEY"]).is_file()
        ipaddress.IPv4Address(values[f"WEBSITE_{prefix}_IPV4"])
    assert values["WEBSITE_PRODUCTION_TARGET"] != values["WEBSITE_OLD_TARGET"]
    return values


def ssh_arguments(config, old=False):
    prefix = "OLD" if old else "PRODUCTION"
    return [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-i",
        config[f"WEBSITE_{prefix}_KEY"],
        config[f"WEBSITE_{prefix}_TARGET"],
    ]


def remote(config, action, *args, old=False, payload=None):
    # Helper source is fixed, carries no secrets. Sensitive JSON stdin is never echoed.
    command = shlex.join(
        ["sudo", "-n", REMOTE_PYTHON, "-c", HELPER.read_text(), action, *args]
    )
    result = subprocess.run(
        [*ssh_arguments(config, old), command],
        input=payload,
        text=True,
        capture_output=True,
        timeout=240,
    )
    if result.returncode:
        try:
            report = json.loads(result.stdout.splitlines()[-1])
        except (ValueError, IndexError):
            report = {
                "action": action,
                "detail": "Remote operation failed; sensitive output withheld",
            }
        print(json.dumps(report, ensure_ascii=False))
        raise SystemExit(1)
    print(result.stdout.strip(), flush=True)
    return result.stdout


def repository_commit(repo):
    repo = Path(repo)
    assert run(["git", "branch", "--show-current"], cwd=repo) == BRANCH, (
        "Wrong source branch"
    )
    assert not run(["git", "status", "--porcelain"], cwd=repo), (
        "Source worktree must be clean"
    )
    head = run(["git", "rev-parse", "HEAD"], cwd=repo)
    assert head == run(["git", "rev-parse", "origin/" + BRANCH], cwd=repo), (
        "Source is not pushed"
    )
    return head


def validate_site(folder):
    assert (folder / "index.html").is_file() and (folder / "assets").is_dir()
    for path in folder.rglob("*"):
        assert not path.is_symlink()
        relative = path.relative_to(folder)
        assert not any(part.startswith(".") for part in relative.parts)
        assert path.suffix.lower() not in {
            ".env",
            ".pem",
            ".key",
            ".sql",
            ".db",
            ".log",
            ".map",
        }
    source = "\n".join(
        path.read_text()
        for path in folder.rglob("*")
        if path.suffix in {".html", ".js", ".css"}
    )
    assert (
        re.search(r"https?://(?:127\.|192\.168\.|10\.|test\.|admin-test\.)", source)
        is None
    ), "Local/test address in build"
    assert "蜀ICP备2026032754号-1" in source, "ICP display is missing"
    assert "/public-website" in source, "Public API binding is missing"
    assert all(
        key not in source
        for key in ("TENCENT_COS_SECRET_KEY", "DATABASE_URL=", "Bearer eyJ")
    )


def stage(config):
    backend = Path(config["WEBSITE_BACKEND_REPO"])
    frontend = Path(config["WEBSITE_FRONTEND_REPO"])
    backend_commit = repository_commit(backend)
    frontend_commit = repository_commit(frontend)
    tool_commit = repository_commit(TOOL_ROOT)
    # Every production staging reruns the full isolated gate; no cached receipt or --skip-tests.
    gate_environment = {
        **os.environ,
        "DATABASE_URL": config["WEBSITE_LOCAL_GATE_DATABASE_URL"],
        "PYTHON_BIN": config["WEBSITE_LOCAL_PYTHON"],
        "PRE_PUSH_RUN_TESTS": "1",
    }
    gate_url = config["WEBSITE_LOCAL_GATE_DATABASE_URL"]
    assert re.search(
        r"@(?:127\.0\.0\.1|localhost):5432/(?:postgres|loumai_dev)$", gate_url
    ), "Gate must target local PostgreSQL"
    print("[1/5] 完整隔离数据库门禁", flush=True)
    subprocess.run(
        ["./scripts/check_before_push.sh"],
        cwd=backend,
        env=gate_environment,
        check=True,
    )
    frontend_environment = {**os.environ, "VITE_API_BASE_URL": "/api/v1"}
    for command in (["npm", "ci"], ["npm", "test"], ["npm", "run", "build"]):
        subprocess.run(
            command, cwd=frontend / "website", env=frontend_environment, check=True
        )
    validate_site(frontend / "website/dist")
    assert (
        repository_commit(backend) == backend_commit
        and repository_commit(frontend) == frontend_commit
    )
    release_id = (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + backend_commit[:10]
    )
    with tempfile.TemporaryDirectory(prefix="public-website-release-") as directory:
        folder = Path(directory)
        print("[2/5] 固定源码与产物哈希", flush=True)
        source = folder / "backend.tar"
        with source.open("wb") as output:
            subprocess.run(
                ["git", "archive", "HEAD"], cwd=backend, stdout=output, check=True
            )
        extracted = folder / "backend"
        extracted.mkdir()
        with tarfile.open(source) as package:
            assert all(
                not member.issym() and not member.islnk()
                for member in package.getmembers()
            )
            package.extractall(extracted, filter="data")
        metadata = dict(
            release_id=release_id,
            backend_commit=backend_commit,
            frontend_commit=frontend_commit,
            tool_commit=tool_commit,
            branch=BRANCH,
            database_mode="read-only",
            database_migration=False,
        )
        (folder / "release.json").write_text(json.dumps(metadata, indent=2))
        artifact = folder / "release.tar.gz"
        with tarfile.open(artifact, "w:gz") as package:
            package.add(extracted, arcname="backend")
            package.add(frontend / "website/dist", arcname="site")
            package.add(TOOL_ROOT / "public-website/remote", arcname="ops")
            package.add(folder / "release.json", arcname="release.json")
        sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        print("[3/5] 安全上传至独立暂存目录", flush=True)
        temporary = run(
            [*ssh_arguments(config), "mktemp -d /tmp/loumai-public-website.XXXXXXXX"]
        )
        assert re.fullmatch(r"/tmp/loumai-public-website\.[A-Za-z0-9]+", temporary)
        destination = temporary + "/release.tar.gz"
        subprocess.run(
            [
                "scp",
                "-q",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-i",
                config["WEBSITE_PRODUCTION_KEY"],
                str(artifact),
                config["WEBSITE_PRODUCTION_TARGET"] + ":" + destination,
            ],
            check=True,
        )
        print("[4/5] 校验哈希、独立环境与真实只读权限", flush=True)
        remote(config, "stage", "--archive", destination, "--sha256", sha)
        print("[5/5] 已暂存；尚未切域名或停止旧官网", flush=True)
    print(json.dumps(metadata, ensure_ascii=False), flush=True)


def import_certificate(config):
    reader = (
        "import base64,json; from pathlib import Path; "
        "root=Path('/etc/letsencrypt/live/yinlizhangyu.com'); "
        "print(json.dumps({key:base64.b64encode((root/(key+'.pem')).read_bytes()).decode() "
        "for key in ('fullchain','privkey')}))"
    )
    command = shlex.join(["sudo", "-n", REMOTE_PYTHON, "-c", reader])
    data = run([*ssh_arguments(config, old=True), command])
    remote(config, "certificate-import", payload=data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "stage",
            "activate",
            "backup-old",
            "retire-old",
            "import-certificate",
            "status",
            "rollback",
        ],
    )
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--release")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    config = load_config(args.config)
    if args.action != "status" and not args.yes:
        parser.error("修改服务器必须显式 --yes；stage 不切换线上或 DNS")
    if args.action in {"activate", "rollback"} and not re.fullmatch(
        r"\d{8}T\d{6}Z-[0-9a-f]{10}", args.release or ""
    ):
        parser.error("必须给出已核验 release ID")
    if args.action == "stage":
        stage(config)
    elif args.action == "backup-old":
        remote(config, "old-backup", old=True)
    elif args.action == "import-certificate":
        import_certificate(config)
    elif args.action == "activate":
        remote(
            config,
            "activate",
            "--release",
            args.release,
            "--ipv4",
            config["WEBSITE_OLD_IPV4"],
        )
    elif args.action == "retire-old":
        remote(
            config,
            "old-retire",
            "--ipv4",
            config["WEBSITE_PRODUCTION_IPV4"],
            old=True,
            payload=json.dumps(
                {
                    "nginx_forwarder": (
                        HELPER.parent / "nginx-old-site-forward.conf"
                    ).read_text()
                }
            ),
        )
    elif args.action == "status":
        remote(config, "status")
    elif args.action == "rollback":
        remote(config, "rollback", "--release", args.release)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(
            json.dumps(
                {
                    "error_type": type(error).__name__,
                    "detail": "Release stopped; credentials withheld",
                }
            )
        )
        raise SystemExit(1)
