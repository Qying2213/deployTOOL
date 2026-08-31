"""Offline tests: never contact, mutate, or authenticate against a real server."""

import importlib.util
import shutil
import socket
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch

SOURCE = (
    Path(__file__).resolve().parents[1]
    / "admin-frontend/remote/prepare-admin-frontend.py"
)
SPEC = importlib.util.spec_from_file_location("admin_frontend_setup", SOURCE)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


@contextmanager
def isolated_setup(*, fail_at=None, old=False, cert_ready=True):
    with (
        tempfile.TemporaryDirectory(prefix="loumai-admin-setup-test-") as directory,
        ExitStack() as stack,
    ):
        root = Path(directory)
        paths = {
            name: root / name.lower()
            for name in (
                "ROOT",
                "ACME",
                "HELPER",
                "CONFIG",
                "SITE",
                "ENABLED",
                "RATE_LIMIT",
                "BACKUP_ROOT",
                "HOOK",
                "TIMER",
                "SERVICE",
                "CERT_ROOT",
            )
        }
        for name in ("ROOT", "ACME", "BACKUP_ROOT", "CERT_ROOT"):
            paths[name].mkdir()
        stack.enter_context(patch.multiple(setup, **paths))
        stack.enter_context(patch.object(setup, "secure_directory"))
        stack.enter_context(patch.object(setup, "secure_file"))
        stack.enter_context(
            patch.object(setup.shutil, "which", return_value="/usr/local/bin/certbot")
        )
        stack.enter_context(
            patch.object(setup, "certificate_ready", return_value=cert_ready)
        )
        probe = stack.enter_context(patch.object(setup, "probe_https_api"))
        calls = []
        previous = {}
        if old:
            for name in (
                "HELPER",
                "CONFIG",
                "SITE",
                "RATE_LIMIT",
                "HOOK",
                "TIMER",
                "SERVICE",
            ):
                content = setup.MARKER + name + "\n"
                if name == "HELPER":
                    content += 'readonly CONFIG_FILE="/etc/loumai/admin-frontend-release.env"\n'
                paths[name].write_text(content)
                paths[name].chmod(0o640)
                previous[name] = paths[name].read_bytes()
            paths["ENABLED"].symlink_to(paths["SITE"])
        failed = False

        def command(args, **kwargs):
            nonlocal failed
            calls.append(args)
            if fail_at and fail_at in args and not failed:
                failed = True
                raise RuntimeError("simulated setup failure")
            code = 1 if len(args) > 1 and args[1] in {"is-active", "is-enabled"} else 0
            return subprocess.CompletedProcess(args, code, stdout="", stderr="")

        stack.enter_context(patch.object(setup, "command", side_effect=command))
        yield paths, calls, previous, probe


class AdminFrontendSetupTest(unittest.TestCase):
    def test_https_reload_waits_for_new_certificate_without_insecure_requests(self):
        good_health = subprocess.CompletedProcess(
            ["curl"],
            0,
            stdout='{"data":{"service":"loumai-company-management","status":"UP"}}',
            stderr="",
        )
        unauthorized = subprocess.CompletedProcess(["curl"], 0, stdout="401", stderr="")
        with (
            patch.object(
                setup,
                "command",
                side_effect=[
                    RuntimeError("curl: (60) certificate subject name mismatch"),
                    good_health,
                    unauthorized,
                ],
            ) as commands,
            patch.object(setup.time, "monotonic", return_value=0),
            patch.object(setup.time, "sleep") as sleep,
        ):
            setup.wait_for_https_api()
            self.assertEqual(commands.call_count, 3)
            sleep.assert_called_once_with(0.5)
            for call in commands.call_args_list:
                arguments = call.args[0]
                self.assertEqual(arguments[0], "curl")
                self.assertNotIn("-k", arguments)
                self.assertNotIn("--insecure", arguments)
                self.assertIn("--noproxy", arguments)
                self.assertIn(f"{setup.DOMAIN}:443:127.0.0.1", arguments)

    def test_https_reload_timeout_fails_closed_with_last_error(self):
        with (
            patch.object(
                setup,
                "probe_https_api",
                side_effect=RuntimeError("curl: (60) wrong certificate"),
            ) as probe,
            patch.object(setup.time, "monotonic", side_effect=[0, 20]),
            patch.object(setup.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "超时.*wrong certificate"):
                setup.wait_for_https_api(timeout=20)
            probe.assert_called_once()
            sleep.assert_not_called()

    def test_https_probe_requires_healthy_backend_and_unauthenticated_401(self):
        for payload, unauthorized_status, error in (
            (
                '{"data":{"service":"wrong-service","status":"UP"}}',
                "401",
                "代理验收失败",
            ),
            (
                '{"data":{"service":"loumai-company-management","status":"DOWN"}}',
                "401",
                "代理验收失败",
            ),
            (
                '{"data":{"service":"loumai-company-management","status":"UP"}}',
                "200",
                "未登录保护验收失败",
            ),
            ('{"data":null}', "401", "代理验收失败"),
        ):
            with self.subTest(payload=payload, status=unauthorized_status):
                with patch.object(
                    setup,
                    "command",
                    side_effect=[
                        subprocess.CompletedProcess(["curl"], 0, stdout=payload),
                        subprocess.CompletedProcess(
                            ["curl"], 0, stdout=unauthorized_status
                        ),
                    ],
                ):
                    with self.assertRaisesRegex(RuntimeError, error):
                        setup.probe_https_api()

    def test_failed_https_readiness_restores_configuration_and_keeps_issued_cert(self):
        with isolated_setup() as (paths, calls, _, probe):
            certificate = paths["CERT_ROOT"] / "fullchain.pem"
            certificate.write_text("issued cert must survive rollback")
            probe.side_effect = RuntimeError("curl: (60) certificate mismatch")
            with patch.object(setup.time, "monotonic", side_effect=[0, 20]):
                with self.assertRaisesRegex(RuntimeError, "超时"):
                    setup.prepare_locked("#!/bin/bash\n")
            self.assertEqual(
                certificate.read_text(), "issued cert must survive rollback"
            )
            self.assertFalse(paths["ENABLED"].exists())
            self.assertFalse(paths["SITE"].exists())
            self.assertNotIn("certonly", [token for call in calls for token in call])
            self.assertNotIn(["systemctl", "enable", "--now", setup.TIMER_NAME], calls)

    def test_certbot_failure_preserves_challenge_detail_from_stdout(self):
        result = subprocess.CompletedProcess(
            ["/usr/local/bin/certbot"],
            1,
            stdout=(
                "During secondary validation: While processing CAA for "
                "admin-test.yinlizhangyu.com: DNS problem: SERVFAIL\n"
            ),
            stderr="Saving debug log to /var/log/letsencrypt/letsencrypt.log\nSome challenges have failed.\n",
        )
        with patch.object(setup.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as caught:
                setup.command(["/usr/local/bin/certbot", "certonly"])
            message = str(caught.exception)
            self.assertIn("During secondary validation", message)
            self.assertIn("SERVFAIL", message)
            self.assertIn("Some challenges have failed", message)
            self.assertIn("没有配置 CAA 本身不是错误", message)
            self.assertIs(
                setup.command(["/usr/local/bin/certbot"], check=False), result
            )

    def test_command_failure_without_output_reports_exit_code(self):
        result = subprocess.CompletedProcess(["nginx"], 2, stdout="", stderr="")
        with patch.object(setup.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "nginx 执行失败：exit=2"):
                setup.command(["nginx", "-t"])

    @unittest.skipUnless(
        shutil.which("nginx") and shutil.which("openssl"),
        "local nginx/openssl unavailable",
    )
    def test_generated_nginx_passes_real_syntax_check_without_starting_server(self):
        with tempfile.TemporaryDirectory(
            prefix="loumai-admin-nginx-test-"
        ) as directory:
            root = Path(directory)
            certificate = root / "fullchain.pem"
            private_key = root / "privkey.pem"
            generated = subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    "1",
                    "-subj",
                    "/CN=admin-test.yinlizhangyu.com",
                    "-out",
                    str(certificate),
                    "-keyout",
                    str(private_key),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(generated.returncode, 0, generated.stderr)
            with patch.object(setup, "CERT_ROOT", root):
                site = setup.nginx_site()
            configuration = root / "nginx.conf"
            configuration.write_text(
                f"error_log {root}/error.log;\npid {root}/nginx.pid;\nevents {{}}\nhttp {{\n"
                "limit_req_zone $binary_remote_addr zone=loumai_admin_frontend_login:10m rate=10r/m;\n"
                + site
                + "\n}\n"
            )
            result = subprocess.run(
                ["nginx", "-t", "-p", str(root), "-c", str(configuration)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_dns_requires_exact_test_ipv4_without_ipv6(self):
        def record(address, family=socket.AF_INET):
            return family, socket.SOCK_STREAM, 6, "", (address, 443)

        for records, expected in (
            ([record(setup.EXPECTED_IP)], True),
            ([record("139.155.246.46")], False),
            ([record(setup.EXPECTED_IP), record("198.18.0.125")], False),
            ([record(setup.EXPECTED_IP), record("::1", socket.AF_INET6)], False),
            ([], False),
        ):
            with patch.object(setup.socket, "getaddrinfo", return_value=records):
                self.assertEqual(setup.dns_ready(), expected)
        with patch.object(setup.socket, "getaddrinfo", side_effect=socket.gaierror):
            self.assertFalse(setup.dns_ready())

    def test_dns_failure_prevents_any_install_writes(self):
        with (
            patch.object(setup, "dns_ready", return_value=False),
            patch.object(setup, "secure_directory") as directories,
        ):
            with self.assertRaisesRegex(RuntimeError, "DNS 尚未就绪"):
                setup.prepare("anything")
            directories.assert_not_called()

    def test_nginx_isolated_root_same_origin_api_auth_and_cache(self):
        config = setup.nginx_site()
        self.assertIn("server_name admin-test.yinlizhangyu.com", config)
        self.assertIn("root /srv/loumai-admin-frontend/frontend-current", config)
        self.assertNotIn("root /srv/loumai-h5", config)
        self.assertIn('proxy_set_header Origin "";', config)
        self.assertIn("proxy_set_header Host 127.0.0.1;", config)
        self.assertIn("if ($http_origin !~", config)
        self.assertIn("return 403", config)
        self.assertNotIn("proxy_set_header Authorization", config)
        self.assertNotIn("Access-Control-Allow-Origin", config)
        self.assertIn("limit_req zone=loumai_admin_frontend_login", config)
        self.assertIn("proxy_pass http://127.0.0.1:8100/api/v1/", config)
        self.assertIn('Cache-Control "no-store"', config)
        self.assertIn("location = /SHA256SUMS { return 404; }", config)
        self.assertIn("/.well-known/acme-challenge/", setup.http_site())
        self.assertNotIn("listen 443", setup.http_site())

    def test_check_is_read_only_and_rejects_non_root(self):
        with patch.object(setup.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(RuntimeError, "sudo"):
                setup.environment_check()
        with (
            patch.object(setup.sys, "argv", ["setup.py", "check"]),
            patch.object(setup, "environment_check"),
            patch.object(setup, "dns_ready", return_value=False),
            patch.object(setup, "initialized", return_value=False),
            patch.object(setup, "prepare") as prepare,
            patch.object(setup.os, "umask"),
            patch.object(setup.signal, "signal"),
        ):
            setup.main()
            prepare.assert_not_called()

    def test_certificate_existing_setup_uses_no_new_certificate_and_only_own_timer(
        self,
    ):
        with isolated_setup() as (paths, calls, _, probe):
            setup.prepare_locked(
                '#!/bin/bash\nreadonly CONFIG_FILE="/etc/loumai/admin-frontend-release.env"\n'
            )
            self.assertEqual(paths["SITE"].read_text(), setup.nginx_site())
            self.assertEqual(paths["ENABLED"].resolve(), paths["SITE"].resolve())
            self.assertEqual(paths["HELPER"].stat().st_mode & 0o777, 0o755)
            self.assertNotIn("certonly", [token for call in calls for token in call])
            self.assertIn(["systemctl", "enable", "--now", setup.TIMER_NAME], calls)
            self.assertIn(
                "--cert-name admin-test.yinlizhangyu.com", paths["SERVICE"].read_text()
            )
            probe.assert_called_once()
            self.assertEqual(calls.count(["systemctl", "reload", "nginx"]), 1)
            self.assertNotIn("restart", [token for call in calls for token in call])

    def test_first_install_failure_restores_only_new_tool_files(self):
        with isolated_setup(fail_at="certonly", cert_ready=False) as (
            paths,
            calls,
            _,
            probe,
        ):
            unrelated = paths["ROOT"].parent / "business-h5.conf"
            unrelated.write_text("do not change")
            with self.assertRaisesRegex(RuntimeError, "simulated"):
                setup.prepare_locked("#!/bin/bash\n")
            for name in (
                "HELPER",
                "CONFIG",
                "SITE",
                "ENABLED",
                "RATE_LIMIT",
                "HOOK",
                "TIMER",
                "SERVICE",
            ):
                self.assertFalse(paths[name].exists(), name)
            self.assertEqual(unrelated.read_text(), "do not change")
            self.assertEqual(
                len(list(paths["BACKUP_ROOT"].glob("prepare-*/paths.json"))), 1
            )
            self.assertIn(["systemctl", "reload", "nginx"], calls)
            probe.assert_not_called()

    def test_failed_update_restores_original_content_and_permissions(self):
        with isolated_setup(fail_at="enable", old=True) as (paths, _, previous, _):
            with self.assertRaisesRegex(RuntimeError, "simulated"):
                setup.prepare_locked("#!/bin/bash\n")
            for name, content in previous.items():
                self.assertEqual(paths[name].read_bytes(), content)
                self.assertEqual(paths[name].stat().st_mode & 0o777, 0o640)
            self.assertTrue(paths["ENABLED"].is_symlink())

    def test_refuses_takeover_of_unmanaged_files(self):
        with isolated_setup() as (paths, calls, _, _):
            paths["SITE"].write_text("unrelated site")
            with self.assertRaisesRegex(RuntimeError, "拒绝覆盖"):
                setup.prepare_locked("#!/bin/bash\n")
            self.assertEqual(paths["SITE"].read_text(), "unrelated site")
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
