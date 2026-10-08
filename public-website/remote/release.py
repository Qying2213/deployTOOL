"""官网专用生产安装器；固定命名空间，不运行迁移或操作业务服务。"""

import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
import pwd
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from dotenv import dotenv_values
from sqlalchemy.engine import make_url

ROOT = Path("/srv/loumai-public-website")
CONFIG = Path("/etc/loumai-public-website")
BACKUPS = Path("/var/backups/loumai-public-website")
SITE = Path("/etc/nginx/sites-available/loumai-public-website")
ENABLED = Path("/etc/nginx/sites-enabled/loumai-public-website")
SERVICE = Path("/etc/systemd/system/loumai-public-website.service")
SERVICES = (
    "loumai-api",
    "loumai-im-worker",
    "loumai-video-worker",
    "loumai-company-management",
)
PROTECTED = (
    "/etc/loumai/backend.env",
    "/etc/loumai/database-profiles/cloud.env",
    "/etc/nginx/sites-enabled/loumai-production-api.conf",
)


def run(args, **kwargs):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, **kwargs
    ).stdout.strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def current_target():
    link = ROOT / "current"
    if not link.exists():
        assert not link.is_symlink(), "Broken current link"
        return None
    assert link.is_symlink(), "Current must be a symlink"
    target = link.resolve()
    assert target.parent == ROOT / "releases", "Current outside website releases"
    return target


def business_state():
    state = {file: digest(file) for file in PROTECTED}
    for service in SERVICES:
        state[service] = run(
            ["systemctl", "show", service, "--property=ActiveState,MainPID"]
        )
        assert "ActiveState=active" in state[service], "Business service is not active"
    state["backend_current"] = str(
        Path("/srv/loumai-backend/backend-current").resolve()
    )
    return state


def production():
    assert os.geteuid() == 0, "Root required for controlled installation"
    release = dotenv_values("/etc/loumai/backend-release.env", interpolate=False)
    assert release.get("LOUMAI_BACKEND_ENVIRONMENT") == "production", (
        "Wrong server environment"
    )


def backup_files(label, files):
    folder = BACKUPS / (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + label
    )
    folder.mkdir(parents=True, mode=0o700, exist_ok=False)
    state = {}
    for file in files:
        path = Path(file)
        state[file] = dict(exists=path.exists(), symlink=path.is_symlink())
        if path.is_symlink():
            state[file]["target"] = os.readlink(path)
        elif path.exists():
            saved = folder / str(len(state))
            shutil.copy2(path, saved)
            saved.chmod(0o600)
            state[file]["saved"] = str(saved)
    (folder / "state.json").write_text(json.dumps(state, indent=2))
    return folder


def restore_files(folder):
    state = json.loads((folder / "state.json").read_text())
    for file, info in state.items():
        path = Path(file)
        if info["symlink"]:
            if path.is_symlink():
                path.unlink()
            path.symlink_to(info["target"])
        elif info["exists"]:
            shutil.copy2(info["saved"], path)
        elif path.exists() or path.is_symlink():
            path.unlink()


def swap_current(target):
    assert target.parent == ROOT / "releases" and target.is_dir(), (
        "Invalid website target"
    )
    temporary = ROOT / ".current.next"
    assert not temporary.exists() and not temporary.is_symlink(), (
        "Another switch is pending"
    )
    temporary.symlink_to(target)
    os.replace(temporary, ROOT / "current")


def check_health():
    for _ in range(20):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8011/health", timeout=3
            ) as response:
                health = json.load(response)
            if health == {"status": "ok", "database": "ok", "read_only": True}:
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("Website read-only health check failed")


def stage(archive, expected_sha):
    production()
    before = business_state()
    assert (
        re.fullmatch(r"[0-9a-f]{64}", expected_sha) and digest(archive) == expected_sha
    )
    for member_root in (ROOT, ROOT / "releases", CONFIG, BACKUPS):
        member_root.mkdir(parents=True, exist_ok=True)
        assert not member_root.is_symlink()
    ROOT.chmod(0o755)
    (ROOT / "releases").chmod(0o755)
    BACKUPS.chmod(0o700)
    target = unpack_release(archive)
    release_id = target.name
    for path in target.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
    assert (target / "backend/app/public_website_main.py").is_file()
    assert (target / "site/index.html").is_file()
    runtime = Path(before["backend_current"]) / ".venv"
    assert runtime.is_dir()
    # 复制已验证的库环境，不安装／更新业务 .venv，避免后续依赖旧业务 release。
    shutil.copytree(runtime, target / "backend/.venv", symlinks=True)
    for path in (target / "backend/.venv").rglob("*"):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    try:
        identity = pwd.getpwnam("loumai-website")
    except KeyError:
        run(
            [
                "useradd",
                "--system",
                "--user-group",
                "--home-dir",
                "/nonexistent",
                "--no-create-home",
                "--shell",
                "/usr/sbin/nologin",
                "loumai-website",
            ]
        )
        identity = pwd.getpwnam("loumai-website")
    assert identity.pw_shell == "/usr/sbin/nologin"
    os.chown(CONFIG, 0, identity.pw_gid)
    CONFIG.chmod(0o750)
    profile = dotenv_values(PROTECTED[1], interpolate=False)
    database = make_url(profile["BACKUP_DATABASE_URL"])
    assert (
        database.database == "loumai_production"
        and database.username == "loumai_backup"
    )
    assert database.query.get("sslmode") == "verify-full"
    ca = CONFIG / "db-ca.pem"
    shutil.copy2(database.query["sslrootcert"], ca)
    ca.chmod(0o644)
    database = database.set(drivername="postgresql+psycopg").update_query_dict(
        {
            "sslrootcert": str(ca),
            "connect_timeout": "5",
            "options": "-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000",
        }
    )
    source = dotenv_values(PROTECTED[0], interpolate=False)
    old_environment = dotenv_values(CONFIG / "website.env", interpolate=False)
    values = dict(
        APP_ENVIRONMENT="public_website",
        PUBLIC_WEBSITE_ENABLED="true",
        DATABASE_URL=database.render_as_string(hide_password=False),
        BACKEND_ALLOWED_HOSTS=json.dumps(
            ["yinlizhangyu.com", "www.yinlizhangyu.com", "localhost", "127.0.0.1"]
        ),
        API_DOCS_ENABLED="false",
        ALLOW_INSECURE_TEST_SETTINGS="false",
        ALLOW_MOCK_WECHAT="false",
        AI_ENABLED="false",
        DEEPSEEK_ENABLED="false",
        TENCENT_IM_ENABLED="false",
        FILE_STORAGE_PROVIDER="tencent_cos",
        IMAGE_VARIANTS_ENABLED="true",
        IMAGE_DIRECT_DOWNLOAD_ENABLED="false",
        VIDEO_TRANSCODE_ENABLED="true",
        VIDEO_DIRECT_DOWNLOAD_ENABLED="false",
        VIDEO_TRANSCODE_WORKER_ID="public-website-readonly",
        VIDEO_MEDIA_TICKET_SECRET_KEY=old_environment.get(
            "VIDEO_MEDIA_TICKET_SECRET_KEY"
        )
        or secrets.token_urlsafe(48),
    )
    for key in (
        "TENCENT_COS_SECRET_ID",
        "TENCENT_COS_SECRET_KEY",
        "TENCENT_COS_REGION",
        "TENCENT_COS_BUCKET",
    ):
        assert source.get(key), "Production media settings are incomplete"
        values[key] = source[key]
    environment = target / "ops/website.env"
    environment.write_text(
        "\n".join(f"{key}={json.dumps(value)}" for key, value in values.items()) + "\n"
    )
    environment.chmod(0o600)
    child_environment = {**os.environ, **values, "PYTHONDONTWRITEBYTECODE": "1"}
    check = subprocess.run(
        [
            "runuser",
            "-u",
            "loumai-website",
            "--",
            str(target / "backend/.venv/bin/python"),
            "-c",
            "from app.public_website_main import engine,verify_read_only_database; "
            "verify_read_only_database(engine); engine.dispose(); print('readonly_verified')",
        ],
        cwd=target / "backend",
        env=child_environment,
        capture_output=True,
        text=True,
    )
    assert check.returncode == 0 and check.stdout.strip() == "readonly_verified", (
        "Staged read-only runtime check failed"
    )
    assert business_state() == before, "Protected business state changed"
    (target / "ops/business-before.json").write_text(json.dumps(before, indent=2))
    print(
        json.dumps(
            {
                "staged_release": release_id,
                "archive_sha256": expected_sha,
                "read_only": True,
            }
        )
    )


def unpack_release(archive):
    """先验证整个包，禁止链接、特殊文件、重复路径及逃逸，再写独立 release。"""
    with tarfile.open(archive, "r:gz") as package:
        members = package.getmembers()
        seen = set()
        for member in members:
            name = Path(member.name)
            assert not name.is_absolute() and ".." not in name.parts and name.parts
            assert member.isfile() or member.isdir(), "Only regular files/directories"
            assert str(name) not in seen, "Duplicate archive path"
            seen.add(str(name))
            assert member.name == "release.json" or name.parts[0] in {
                "backend",
                "site",
                "ops",
            }
        assert sum(member.size for member in members) < 256 * 1024 * 1024
        metadata = json.load(package.extractfile("release.json"))
        release_id = metadata["release_id"]
        assert re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{10}", release_id)
        for key in ("backend_commit", "frontend_commit", "tool_commit"):
            assert re.fullmatch(r"[0-9a-f]{40}", metadata[key])
        assert metadata["branch"] == "feat/P1-WEB-01-public-property-website"
        assert metadata["database_mode"] == "read-only"
        assert metadata["database_migration"] is False
        target = ROOT / "releases" / release_id
        assert not target.exists(), "Release already exists"
        target.mkdir(mode=0o755)
        # root 的 umask=077 会把 mkdir 的755收紧成700；非特权服务须可遍历。
        target.chmod(0o755)
        package.extractall(target, filter="data")
    return target


def import_certificate():
    production()
    data = json.load(sys.stdin)
    assert set(data) == {"fullchain", "privkey"}
    tls = CONFIG / "tls"
    assert not tls.exists(), "Refusing to overwrite existing website TLS directory"
    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="tls-staging-", dir=CONFIG) as temporary:
        staged = Path(temporary)
        validate_certificate(data, staged)
        tls.mkdir(mode=0o700)
        for name in ("fullchain.pem", "privkey.pem"):
            os.replace(staged / name, tls / name)
    print(
        json.dumps(
            {
                "certificate_valid": True,
                "domains": ["yinlizhangyu.com", "www.yinlizhangyu.com"],
            }
        )
    )


def validate_certificate(data, tls):
    for key in data:
        file = tls / (key + ".pem")
        assert not file.exists(), (
            "Refusing to overwrite an existing website certificate"
        )
        file.write_bytes(base64.b64decode(data[key], validate=True))
        file.chmod(0o600)
    run(
        [
            "openssl",
            "x509",
            "-in",
            str(tls / "fullchain.pem"),
            "-noout",
            "-checkend",
            "604800",
        ]
    )
    certificate_key = run(
        ["openssl", "x509", "-in", str(tls / "fullchain.pem"), "-pubkey", "-noout"]
    )
    private_key = run(["openssl", "pkey", "-in", str(tls / "privkey.pem"), "-pubout"])
    assert certificate_key == private_key, "Certificate/key mismatch"
    names = run(
        [
            "openssl",
            "x509",
            "-in",
            str(tls / "fullchain.pem"),
            "-noout",
            "-ext",
            "subjectAltName",
        ]
    )
    assert "DNS:yinlizhangyu.com" in names and "DNS:www.yinlizhangyu.com" in names


def activate(release_id, old_ipv4):
    production()
    ipaddress.IPv4Address(old_ipv4)
    assert re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{10}", release_id)
    target = ROOT / "releases" / release_id
    assert target.is_dir()
    before = business_state()
    previous = current_target()
    nginx_files = [
        str(SITE),
        str(ENABLED),
        str(SERVICE),
        str(CONFIG / "website.env"),
        "/etc/nginx/conf.d/public-website-http.conf",
        "/etc/nginx/snippets/public-website-proxy.conf",
        "/etc/nginx/snippets/public-website-headers.conf",
    ]
    backup = backup_files("activate-" + release_id, nginx_files)
    try:
        for name in ("public-website-proxy.conf", "public-website-headers.conf"):
            shutil.copy2(target / "ops" / name, Path("/etc/nginx/snippets") / name)
        shutil.copy2(
            target / "ops/nginx-public-website-http.conf",
            "/etc/nginx/conf.d/public-website-http.conf",
        )
        SITE.write_text(
            (target / "ops/nginx-public-website.conf")
            .read_text()
            .replace("@OLD_IPV4@", old_ipv4)
        )
        if not ENABLED.is_symlink():
            assert not ENABLED.exists(), "Unexpected site-enabled file"
            ENABLED.symlink_to(SITE)
        shutil.copy2(target / "ops/loumai-public-website.service", SERVICE)
        shutil.copy2(target / "ops/website.env", CONFIG / "website.env")
        (CONFIG / "website.env").chmod(0o600)
        run(["nginx", "-t"])
        swap_current(target)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "loumai-public-website"])
        run(["systemctl", "restart", "loumai-public-website"])
        check_health()
        run(["systemctl", "reload", "nginx"])
        for path in (
            "/_site_health",
            "/api/v1/public-website/properties?page_size=1",
            "/",
        ):
            run(
                [
                    "curl",
                    "--silent",
                    "--show-error",
                    "--fail",
                    "--max-time",
                    "15",
                    "--noproxy",
                    "*",
                    "--resolve",
                    "yinlizhangyu.com:443:127.0.0.1",
                    "https://yinlizhangyu.com" + path,
                ]
            )
        assert business_state() == before, "Protected business state changed"
    except Exception:
        restore_files(backup)
        if previous:
            swap_current(previous)
            run(["systemctl", "daemon-reload"])
            run(["systemctl", "restart", "loumai-public-website"])
        else:
            (ROOT / "current").unlink(missing_ok=True)
            subprocess.run(
                ["systemctl", "stop", "loumai-public-website"], capture_output=True
            )
            subprocess.run(
                ["systemctl", "disable", "loumai-public-website"], capture_output=True
            )
            run(["systemctl", "daemon-reload"])
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
        raise
    receipt = dict(
        release_id=release_id,
        previous=str(previous) if previous else None,
        configuration_backup=str(backup),
        protected_business_state=before,
    )
    (CONFIG / "activation.json").write_text(json.dumps(receipt, indent=2))
    print(
        json.dumps(
            {
                "activated_release": release_id,
                "health": "ok",
                "configuration_backup": str(backup),
            }
        )
    )


def backup_old_site():
    assert os.geteuid() == 0
    old_current = Path("/srv/workway-site/current")
    assert old_current.exists() and old_current.is_symlink()
    assert old_current.resolve().is_relative_to("/srv/workway-site/releases")
    config = Path("/etc/nginx/sites-available/workway-official")
    assert "yinlizhangyu.com" in config.read_text()
    folder = backup_files(
        "old-site", [str(config), "/etc/nginx/sites-enabled/workway-official"]
    )
    with tarfile.open(folder / "old-site.tar.gz", "w:gz") as archive:
        archive.add(old_current.resolve(), arcname="site", recursive=True)
    for name in ("fullchain.pem", "privkey.pem"):
        shutil.copy2(
            Path("/etc/letsencrypt/live/yinlizhangyu.com") / name, folder / name
        )
        (folder / name).chmod(0o600)
    metadata = dict(
        original_release=str(old_current.resolve()),
        site_archive_sha256=digest(folder / "old-site.tar.gz"),
    )
    (folder / "old-site.json").write_text(json.dumps(metadata, indent=2))
    print(json.dumps({"old_site_backup": str(folder), **metadata}))


def retire_old_site(new_ipv4):
    assert os.geteuid() == 0
    ipaddress.IPv4Address(new_ipv4)
    config = Path("/etc/nginx/sites-available/workway-official")
    assert config.is_file() and Path("/srv/workway-site/current").exists()
    before = {
        name: run(["systemctl", "show", name, "--property=MainPID,ActiveState"])
        for name in SERVICES
    }
    bundle = json.load(sys.stdin)
    source = bundle["nginx_forwarder"]
    assert "@NEW_IPV4@" in source and "proxy_ssl_verify on;" in source
    backup = backup_files("old-forwarder", [str(config)])
    try:
        config.write_text(source.replace("@NEW_IPV4@", new_ipv4))
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
        output = run(
            [
                "curl",
                "--silent",
                "--show-error",
                "--fail",
                "--max-time",
                "15",
                "--noproxy",
                "*",
                "--resolve",
                "yinlizhangyu.com:443:127.0.0.1",
                "https://yinlizhangyu.com/_site_health",
            ]
        )
        assert json.loads(output).get("read_only") is True
        assert before == {
            name: run(["systemctl", "show", name, "--property=MainPID,ActiveState"])
            for name in SERVICES
        }
    except Exception:
        restore_files(backup)
        run(["nginx", "-t"])
        run(["systemctl", "reload", "nginx"])
        raise
    print(
        json.dumps(
            {
                "old_static_site_retired": True,
                "forwarder_to": new_ipv4,
                "backup": str(backup),
            }
        )
    )


def status():
    production()
    current = current_target()
    state = {"current": str(current) if current else None, "business": business_state()}
    if current:
        state["release"] = json.loads((current / "release.json").read_text())
        state["service"] = run(
            [
                "systemctl",
                "show",
                "loumai-public-website",
                "--property=ActiveState,MainPID",
            ]
        )
        check_health()
        state["read_only_health"] = True
    print(json.dumps(state, indent=2))


def rollback(release_id):
    production()
    assert re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{10}", release_id)
    target = ROOT / "releases" / release_id
    assert target.is_dir()
    previous = current_target()
    assert previous and previous != target
    before = business_state()
    try:
        swap_current(target)
        run(["systemctl", "restart", "loumai-public-website"])
        check_health()
        assert business_state() == before
    except Exception:
        swap_current(previous)
        run(["systemctl", "restart", "loumai-public-website"])
        raise
    print(json.dumps({"rolled_back_to": release_id, "read_only": True}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "stage",
            "activate",
            "certificate-import",
            "old-backup",
            "old-retire",
            "status",
            "rollback",
        ],
    )
    parser.add_argument("--archive")
    parser.add_argument("--sha256")
    parser.add_argument("--release")
    parser.add_argument("--ipv4")
    args = parser.parse_args()
    try:
        # 独立锁，不使用或影响主后端发布锁。进程退出自动释放。
        lock = None
        if args.action != "status":
            assert os.geteuid() == 0
            lock = open("/run/lock/loumai-public-website.lock", "a")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "stage":
            stage(args.archive, args.sha256)
        elif args.action == "activate":
            activate(args.release, args.ipv4)
        elif args.action == "certificate-import":
            import_certificate()
        elif args.action == "old-backup":
            backup_old_site()
        elif args.action == "old-retire":
            retire_old_site(args.ipv4)
        elif args.action == "status":
            status()
        elif args.action == "rollback":
            rollback(args.release)
    except Exception as error:
        print(
            json.dumps(
                {
                    "failed_action": args.action,
                    "error_type": type(error).__name__,
                    "detail": "Release failed; credentials and upstream error bodies withheld",
                }
            )
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
