"""Root-only, test-only setup; sent over verified SSH, never sourced from a ZIP."""

import base64
import fcntl
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

DOMAIN = "admin-test.yinlizhangyu.com"
EXPECTED_IP = "132.232.220.115"
ROOT = Path("/srv/loumai-admin-frontend")
ACME = Path("/var/www/loumai-admin-acme")
HELPER = Path("/usr/local/sbin/loumai-admin-frontend-release")
CONFIG = Path("/etc/loumai/admin-frontend-release.env")
SITE = Path("/etc/nginx/sites-available/loumai-admin-test")
ENABLED = Path("/etc/nginx/sites-enabled/loumai-admin-test")
RATE_LIMIT = Path("/etc/nginx/conf.d/loumai-admin-frontend-rate-limit.conf")
CERT_ROOT = Path("/etc/letsencrypt/live") / DOMAIN
BACKUP_ROOT = Path("/var/backups/loumai-admin-frontend")
HOOK = Path("/etc/letsencrypt/renewal-hooks/deploy/loumai-admin-frontend-reload")
TIMER_NAME = "loumai-admin-frontend-cert-renew.timer"
TIMER = Path("/etc/systemd/system") / TIMER_NAME
SERVICE = Path("/etc/systemd/system/loumai-admin-frontend-cert-renew.service")
MARKER = "# Managed by loumai admin-frontend; independent test site.\n"
ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C.UTF-8",
}


def command(args, *, check=True, timeout=30):
    result = subprocess.run(
        args, env=ENV, capture_output=True, text=True, timeout=timeout, check=False
    )
    if check and result.returncode:
        # Commands never carry credentials; do not print any environment file contents.
        # Certbot emits the actual challenge failure on stdout, not stderr.
        details = "\n".join(
            output.strip()[-16384:]
            for output in (result.stdout, result.stderr)
            if output and output.strip()
        )
        if not details:
            details = f"exit={result.returncode}"
        if (
            Path(args[0]).name == "certbot"
            and "caa" in details.lower()
            and "servfail" in details.lower()
        ):
            details += (
                "\n证书机构的 CAA/DNS 查询失败：DNS_READY 只校验 A/AAAA 地址，"
                "不代表 CAA 校验通过。请核查权威 DNS 和 DNSSEC；"
                "没有配置 CAA 本身不是错误。不要连续重试签发或跳过 HTTPS 校验。"
            )
        raise RuntimeError(f"{args[0]} 执行失败：{details}")
    return result


def secure_directory(path, *, create=False):
    if not path.exists() and not path.is_symlink() and create:
        secure_directory(path.parent, create=True)
        path.mkdir(mode=0o755)
        # main uses umask 077 for backups; Nginx must still traverse new web roots.
        path.chmod(0o755)
    current = path
    while True:
        metadata = current.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != 0
            or metadata.st_mode & 0o022
        ):
            raise RuntimeError(
                f"目录必须由 root 持有且禁止其他用户写入/软链接：{current}"
            )
        if current == current.parent:
            break
        current = current.parent


def secure_file(path):
    secure_directory(path.parent)
    metadata = path.lstat()
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_mode & 0o022
    ):
        raise RuntimeError(f"配置必须为 root 控制的普通文件：{path}")


def dns_ready():
    try:
        records = socket.getaddrinfo(DOMAIN, 443, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    ipv4 = {item[4][0] for item in records if item[0] == socket.AF_INET}
    ipv6 = {item[4][0] for item in records if item[0] == socket.AF_INET6}
    return ipv4 == {EXPECTED_IP} and not ipv6


def certificate_ready():
    certificate = CERT_ROOT / "fullchain.pem"
    if not certificate.exists() or not (CERT_ROOT / "privkey.pem").exists():
        return False
    for arguments in (["-checkend", "86400"], ["-checkhost", DOMAIN]):
        result = command(
            ["openssl", "x509", "-in", str(certificate), "-noout", *arguments],
            check=False,
        )
        if result.returncode:
            return False
    return True


def http_site():
    return (
        MARKER
        + f"""server {{
    listen 80;
    listen [::]:80;
    server_name {DOMAIN};
    access_log off;
    location ^~ /.well-known/acme-challenge/ {{
        root {ACME};
        try_files $uri =404;
    }}
    location / {{ return 308 https://{DOMAIN}$request_uri; }}
}}
"""
    )


def nginx_site():
    security_headers = """    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Strict-Transport-Security "max-age=31536000" always;
"""
    proxy = """        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header Origin "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
"""
    # Only this host's same-origin requests are forwarded. The backend still validates
    # its independent administrator Bearer token; no CORS wildcard or auth bypass.
    result = (
        http_site()
        + f"""
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {DOMAIN};
    ssl_certificate {CERT_ROOT}/fullchain.pem;
    ssl_certificate_key {CERT_ROOT}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    root {ROOT}/frontend-current;
    index index.html;
    access_log off;
    client_max_body_size 32m;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    if ($http_origin !~ "^$|^https://admin-test\\.yinlizhangyu\\.com$") {{ return 403; }}
{security_headers}

    location = /admin-api/api/v1/admin-auth/password-login {{
        limit_req zone=loumai_admin_frontend_login burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8100/api/v1/admin-auth/password-login;
{proxy}    }}
    location ^~ /admin-api/api/v1/ {{
        proxy_pass http://127.0.0.1:8100/api/v1/;
{proxy}    }}
    location = /admin-api/health {{
        proxy_pass http://127.0.0.1:8100/health;
{proxy}    }}
    location = /admin-api/ready {{
        proxy_pass http://127.0.0.1:8100/ready;
{proxy}    }}
    location /admin-api/ {{ return 404; }}
    location = /SHA256SUMS {{ return 404; }}
    location ~ /\\. {{ return 404; }}
    location ~* \\.(env|pem|key|p12|pfx|sql|sqlite|db|bak|map)$ {{ return 404; }}
    location = /index.html {{
        add_header Cache-Control "no-store" always;
{security_headers}
        try_files $uri =404;
    }}
    location = /release.json {{
        add_header Cache-Control "no-store" always;
{security_headers}
        try_files $uri =404;
    }}
    location /assets/ {{
        add_header Cache-Control "public, max-age=31536000, immutable";
{security_headers}
        try_files $uri =404;
    }}
    location / {{
        add_header Cache-Control "no-cache" always;
{security_headers}
        try_files $uri $uri/ /index.html;
    }}
}}
"""
    )
    return result


def environment_check():
    if os.geteuid() != 0:
        raise RuntimeError("仅允许通过 sudo 运行服务器预检/安装")
    marker = Path("/etc/loumai/backend-release.env")
    secure_file(marker)
    values = {}
    for line in marker.read_text().splitlines():
        match = re.fullmatch(
            r"(LOUMAI_BACKEND_ENVIRONMENT|LOUMAI_BACKEND_PUBLIC_HEALTH_URL)=(.*)", line
        )
        if match:
            values[match[1]] = match[2].strip().strip("\"'")
    if (
        values.get("LOUMAI_BACKEND_ENVIRONMENT") != "test"
        or values.get("LOUMAI_BACKEND_PUBLIC_HEALTH_URL")
        != "https://test.yinlizhangyu.com/health"
    ):
        raise RuntimeError("远端不是约定的测试环境，拒绝安装")
    for name in (
        "nginx",
        "openssl",
        "certbot",
        "systemctl",
        "curl",
        "bash",
        "flock",
        "rsync",
        "tar",
        "sha256sum",
        "runuser",
    ):
        if not shutil.which(name, path=ENV["PATH"]):
            raise RuntimeError(
                f"服务器缺少 {name}；本工具不自动 apt 安装或升级系统软件"
            )
    # Verify the actual backend health response, not just an open port or an HTML fallback.
    health = json.loads(
        command(
            [
                "curl",
                "--noproxy",
                "*",
                "-fsS",
                "--max-time",
                "10",
                "http://127.0.0.1:8100/health",
            ]
        ).stdout
    )
    if (
        health.get("data", {}).get("service") != "loumai-company-management"
        or health.get("data", {}).get("status") != "UP"
    ):
        raise RuntimeError("管理后台后端 8100 健康检查失败")
    command(["nginx", "-t"])


def initialized():
    for path in (SITE, CONFIG, HELPER, RATE_LIMIT, HOOK, TIMER, SERVICE):
        if not path.exists():
            return False
        secure_file(path)
    if not SITE.read_text().startswith(MARKER):
        raise RuntimeError("独立站点配置已存在但不是本工具创建，拒绝覆盖")
    secure_directory(ENABLED.parent)
    return (
        ENABLED.is_symlink()
        and os.readlink(ENABLED) == str(SITE)
        and SITE.read_text() == nginx_site()
        and certificate_ready()
        and command(
            ["systemctl", "is-active", "--quiet", TIMER_NAME], check=False
        ).returncode
        == 0
        and command(
            ["systemctl", "is-enabled", "--quiet", TIMER_NAME], check=False
        ).returncode
        == 0
    )


def refuse_conflicting_site():
    source = ""
    for line in command(["nginx", "-T"]).stdout.splitlines():
        if line.startswith("# configuration file "):
            source = line.removeprefix("# configuration file ").removesuffix(":")
        if re.search(
            r"\bserver_name\s+[^;]*\badmin-test\.yinlizhangyu\.com\b", line
        ) and source not in {str(SITE), str(ENABLED)}:
            raise RuntimeError(f"独立域名已被其他配置接管，拒绝覆盖：{source}")


def atomic_write(path, content, mode=0o644):
    secure_directory(path.parent, create=True)
    if path.exists() or path.is_symlink():
        secure_file(path)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def probe_https_api():
    options = [
        "curl",
        "--noproxy",
        "*",
        "-fsS",
        "--connect-timeout",
        "2",
        "--max-time",
        "3",
        "--resolve",
        f"{DOMAIN}:443:127.0.0.1",
    ]
    payload = json.loads(
        command([*options, f"https://{DOMAIN}/admin-api/health"], timeout=5).stdout
    )
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("data"), dict)
        or payload["data"].get("service") != "loumai-company-management"
        or payload["data"].get("status") != "UP"
    ):
        raise RuntimeError("独立域名的后台 API 代理验收失败")
    response = command(
        [
            "curl",
            "--noproxy",
            "*",
            "-sS",
            "--connect-timeout",
            "2",
            "--max-time",
            "3",
            "--resolve",
            f"{DOMAIN}:443:127.0.0.1",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            f"https://{DOMAIN}/admin-api/api/v1/admin-auth/me",
        ],
        timeout=5,
    ).stdout.strip()
    if response != "401":
        raise RuntimeError(f"后台未登录保护验收失败（期望 401，实际 {response}）")


def wait_for_https_api(*, timeout=20):
    # systemctl reload only acknowledges HUP. New workers may not yet be serving
    # this SNI name, so the first fresh connection can see the old default cert.
    # Retry read-only probes, never certificate issuance or insecure TLS requests.
    deadline = time.monotonic() + timeout
    announced = False
    while True:
        try:
            probe_https_api()
            return
        except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(
                    f"等待 Nginx 新站点就绪超时（{timeout} 秒等待窗口）；"
                    f"证书、后台健康或未登录保护未通过，仍将回退配置。最后错误：{exc}"
                ) from exc
            if not announced:
                print(
                    "WAITING_HTTPS=true（等待新配置生效，保持严格证书校验）", flush=True
                )
                announced = True
            time.sleep(min(0.5, remaining))


def prepare(helper_source):
    if not dns_ready():
        raise RuntimeError(
            "DNS 尚未就绪：请设置 admin-test A=132.232.220.115，且无 AAAA"
        )
    if (
        not helper_source.startswith("#!/bin/bash\n")
        or 'readonly CONFIG_FILE="/etc/loumai/admin-frontend-release.env"'
        not in helper_source
    ):
        raise RuntimeError("后台 helper 来源/配置不匹配")
    refuse_conflicting_site()
    for directory in (
        ROOT,
        ROOT / "frontend-releases",
        ROOT / "incoming",
        ACME,
        BACKUP_ROOT,
    ):
        secure_directory(directory, create=True)
    lock_path = ROOT / ".frontend-release.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prepare_locked(helper_source)


def prepare_locked(helper_source):
    config_text = (
        MARKER
        + f"""LOUMAI_H5_ENVIRONMENT=test
LOUMAI_H5_REMOTE_ROOT={ROOT}
LOUMAI_H5_STAGING_ROOT={ROOT}/incoming
LOUMAI_H5_DEPLOY_USER=ubuntu
LOUMAI_H5_PUBLIC_URL=https://{DOMAIN}
LOUMAI_H5_WEB_USER=www-data
LOUMAI_H5_NGINX_BIN=/usr/sbin/nginx
"""
    )
    renewal_hook = """#!/bin/sh
# Managed by loumai admin-frontend; independent test site.
set -eu
case " ${RENEWED_DOMAINS:-} " in
  *" admin-test.yinlizhangyu.com "*) /usr/sbin/nginx -t && /usr/bin/systemctl reload nginx ;;
esac
"""
    certbot = shutil.which("certbot", path=ENV["PATH"])
    files = {
        HELPER: (helper_source.encode(), 0o755),
        CONFIG: (config_text.encode(), 0o644),
        RATE_LIMIT: (
            (
                MARKER
                + "limit_req_zone $binary_remote_addr zone=loumai_admin_frontend_login:10m rate=10r/m;\n"
            ).encode(),
            0o644,
        ),
        SITE: (nginx_site().encode(), 0o644),
        HOOK: (renewal_hook.encode(), 0o755),
        SERVICE: (
            (
                MARKER
                + f"""[Unit]
Description=Renew only the loumai admin test TLS certificate
[Service]
Type=oneshot
ExecStart={certbot} renew --cert-name {DOMAIN} --non-interactive --quiet
"""
            ).encode(),
            0o644,
        ),
        TIMER: (
            (
                MARKER
                + """[Unit]
Description=Renew loumai admin test TLS twice a day
[Timer]
OnCalendar=*-*-* 03,15:15:00
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
"""
            ).encode(),
            0o644,
        ),
    }
    secure_directory(ENABLED.parent)
    if ENABLED.exists() or ENABLED.is_symlink():
        if not ENABLED.is_symlink() or os.readlink(ENABLED) != str(SITE):
            raise RuntimeError("独立站点启用项不是预期软链接，拒绝接管")
    for path in files:
        if path.exists() or path.is_symlink():
            secure_file(path)
            if path != HELPER and MARKER.strip() not in path.read_text():
                raise RuntimeError(f"文件不是本工具管理，拒绝覆盖：{path}")
            if (
                path == HELPER
                and 'readonly CONFIG_FILE="/etc/loumai/admin-frontend-release.env"'
                not in path.read_text()
            ):
                raise RuntimeError("helper 路径已有其他程序，拒绝覆盖")
    backup = Path(tempfile.mkdtemp(prefix="prepare-", dir=BACKUP_ROOT))
    backup.chmod(0o700)
    snapshots = {
        path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
        if path.exists()
        else None
        for path in files
    }
    for index, (path, snapshot) in enumerate(snapshots.items()):
        if snapshot:
            (backup / f"{index}-{path.name}").write_bytes(snapshot[0])
    (backup / "paths.json").write_text(json.dumps([str(path) for path in files]))
    print(f"CONFIG_BACKUP={backup}", flush=True)
    link_existed = ENABLED.is_symlink()
    timer_active = (
        command(
            ["systemctl", "is-active", "--quiet", TIMER_NAME], check=False
        ).returncode
        == 0
    )
    timer_enabled = (
        command(
            ["systemctl", "is-enabled", "--quiet", TIMER_NAME], check=False
        ).returncode
        == 0
    )
    try:
        for path, (content, mode) in files.items():
            if path == SITE:
                continue
            atomic_write(path, content, mode)
        command(["bash", "-n", str(HELPER)])
        needs_certificate = not certificate_ready()
        if needs_certificate:
            atomic_write(SITE, http_site().encode())
        else:
            atomic_write(SITE, nginx_site().encode())
        if not link_existed:
            ENABLED.symlink_to(SITE)
        if needs_certificate:
            command(["nginx", "-t"])
            command(["systemctl", "reload", "nginx"])
            command(
                [
                    certbot,
                    "certonly",
                    "--webroot",
                    "-w",
                    str(ACME),
                    "-d",
                    DOMAIN,
                    "--cert-name",
                    DOMAIN,
                    "--non-interactive",
                    "--agree-tos",
                    "--email",
                    "602491730@qq.com",
                    "--keep-until-expiring",
                    "--preferred-challenges",
                    "http",
                ],
                timeout=150,
            )
        if not certificate_ready():
            raise RuntimeError("证书签发后检查未通过")
        atomic_write(SITE, nginx_site().encode())
        command(["nginx", "-t"])
        command(["systemctl", "reload", "nginx"])
        wait_for_https_api()
        command(["systemctl", "daemon-reload"])
        command(["systemctl", "enable", "--now", TIMER_NAME])
        print("INITIALIZED=true\nHTTPS_READY=true", flush=True)
    except BaseException:
        # Restore only this tool's exact files; never touch the test H5/server blocks or databases.
        if not timer_active:
            command(["systemctl", "stop", TIMER_NAME], check=False)
        if not timer_enabled:
            command(["systemctl", "disable", TIMER_NAME], check=False)
        for path, snapshot in snapshots.items():
            if snapshot:
                atomic_write(path, snapshot[0], snapshot[1])
            else:
                path.unlink(missing_ok=True)
        if not link_existed:
            ENABLED.unlink(missing_ok=True)
        command(["systemctl", "daemon-reload"], check=False)
        checked = command(["nginx", "-t"], check=False)
        reloaded = (
            command(["systemctl", "reload", "nginx"], check=False)
            if checked.returncode == 0
            else None
        )
        if reloaded is None or reloaded.returncode:
            print(
                f"ERROR: 配置已还原但 Nginx reload 失败，请检查备份 {backup}",
                file=sys.stderr,
            )
        print(
            "安装失败：已还原本工具的站点配置；若已签发证书则保留证书供后续重试。",
            file=sys.stderr,
        )
        raise


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "check"
    if action not in {"check", "prepare"}:
        raise RuntimeError("仅支持 check / prepare")
    os.umask(0o077)

    def interrupted(signum, frame):
        raise RuntimeError(f"操作被信号 {signum} 中断")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    environment_check()
    print(f"PUBLIC_URL=https://{DOMAIN}", flush=True)
    print(f"DNS_READY={str(dns_ready()).lower()}", flush=True)
    print(f"INITIALIZED={str(initialized()).lower()}", flush=True)
    if action == "prepare":
        if len(sys.argv) != 3 or len(sys.argv[2]) > 200000:
            raise RuntimeError("必须提供受控 helper 源码")
        prepare(base64.b64decode(sys.argv[2], validate=True).decode())


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
