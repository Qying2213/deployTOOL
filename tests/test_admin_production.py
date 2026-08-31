"""Production helper tests: temp files/mocks only; no SSH, systemd or real DB."""

import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = (
    Path(__file__).resolve().parents[1]
    / "admin-backend/remote/loumai-company-management-production-release"
)
LOADER = importlib.machinery.SourceFileLoader("admin_production", str(SOURCE))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
helper = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(helper)
RELEASE = "20260828T120000Z-0123456789"
OLD_RELEASE = "20260827T120000Z-0123456789"
PUBLIC = "https://admin.loumai.cn/admin-api"
MAIN = {
    "LOUMAI_BACKEND_CLOUD_DATABASE_HOST": "postgres.prod.loumai.cn",
    "LOUMAI_BACKEND_DATABASE_NAME": "loumai_prod",
}


def runtime_values():
    return {
        "APP_ENVIRONMENT": "production",
        "API_DOCS_ENABLED": "false",
        "SCHEMA_CHECK_ENABLED": "true",
        "ADMIN_JWT_SECRET_KEY": "private-random-fixture-with-more-than-32-characters",
        "BACKEND_ALLOWED_HOSTS": "admin.loumai.cn",
        "BACKEND_CORS_ORIGINS": "https://admin.loumai.cn",
        "FILE_STORAGE_PROVIDER": "tencent_cos",
        "TENCENT_COS_SECRET_ID": "fixture-id",
        "TENCENT_COS_SECRET_KEY": "fixture-key",
        "TENCENT_COS_REGION": "ap-chengdu",
        "TENCENT_COS_BUCKET": "fixture-123",
        "LOUMAI_DATABASE_PROFILE": "cloud",
        "LOUMAI_DATABASE_NAME": "loumai_prod",
        "DATABASE_URL": "postgresql+psycopg://admin_app:fixture@postgres.prod.loumai.cn:5432/loumai_prod?sslmode=verify-full&sslrootcert=/etc/loumai/certs/tencentdb-ca.pem",
    }


def artifact(directory, release=RELEASE, environment="production"):
    directory.mkdir(parents=True)
    files = {
        "app/main.py": "value = 1\n",
        "pyproject.toml": "[project]\n",
        "runtime-constraints.txt": "fastapi==0.141.1\n",
        "release.json": json.dumps(
            {"environment": environment, "release_id": release, "commit": "a" * 40}
        ),
    }
    for name, content in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    (directory / "SHA256SUMS").write_text(
        "\n".join(
            f"{hashlib.sha256(value.encode()).hexdigest()}  {name}"
            for name, value in files.items()
        )
        + "\n"
    )


class ProductionAdminTest(unittest.TestCase):
    def test_environment_parser_never_executes_shell_and_rejects_duplicates(self):
        self.assertEqual(
            helper.parse_env('A="one two"\nB=three\n'), {"A": "one two", "B": "three"}
        )
        for text in ("A=1\nA=2", "A=$(id)", "A=`id`", "BROKEN"):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                helper.parse_env(text)

    def test_runtime_values_bind_production_domain_and_database(self):
        helper.validate_runtime_values(runtime_values(), PUBLIC, MAIN)
        for change in (
            {"API_DOCS_ENABLED": "true"},
            {"APP_ENVIRONMENT": "test"},
            {"SCHEMA_CHECK_ENABLED": "false"},
            {"BACKEND_ALLOWED_HOSTS": "*"},
            {"BACKEND_CORS_ORIGINS": "https://test.loumai.cn"},
            {"MIGRATION_DATABASE_URL": "not-real"},
            {"JWT_SECRET_KEY": "not-real"},
            {"LOUMAI_DATABASE_PROFILE": "local"},
            {"ADMIN_JWT_SECRET_KEY": "REPLACE_THIS_SECRET_AT_LEAST_32_CHARS"},
        ):
            with self.subTest(change=list(change)), self.assertRaises(RuntimeError):
                helper.validate_runtime_values(
                    {**runtime_values(), **change}, PUBLIC, MAIN
                )

    def test_tls_requires_verified_ca_same_host_and_database(self):
        original = runtime_values()["DATABASE_URL"]
        for url in (
            original.replace("verify-full", "require"),
            original.replace("postgres.prod.loumai.cn", "127.0.0.1"),
            original.replace("/loumai_prod?", "/loumai_test?"),
            original + "&options=-csearch_path=evil",
        ):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                helper.validate_runtime_values(
                    {**runtime_values(), "DATABASE_URL": url}, PUBLIC, MAIN
                )

    def test_production_domain_cannot_be_test_ip_or_placeholder(self):
        for url in (
            "https://admin.example.com/admin-api",
            "https://admin-test.yinlizhangyu.com/admin-api",
            "http://admin.loumai.cn/admin-api",
            "https://127.0.0.1/admin-api",
        ):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                helper.validate_runtime_values(runtime_values(), url, MAIN)

    def test_archive_rejects_all_unsafe_headers_before_writing(self):
        for name, kind in (
            ("../escape", tarfile.REGTYPE),
            ("/tmp/escape", tarfile.REGTYPE),
            ("backend/link", tarfile.SYMTYPE),
            ("backend/link", tarfile.LNKTYPE),
            ("backend/.env", tarfile.REGTYPE),
            ("backend/.runtime/evil", tarfile.REGTYPE),
            ("backend/fifo", tarfile.FIFOTYPE),
        ):
            with (
                self.subTest(name=name, kind=kind),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                archive = root / "bad.tar"
                with tarfile.open(archive, "w") as output:
                    good = tarfile.TarInfo("backend/first.py")
                    good.size = 1
                    output.addfile(good, io.BytesIO(b"x"))
                    bad = tarfile.TarInfo(name)
                    bad.type = kind
                    bad.linkname = "/tmp/escape"
                    output.addfile(bad)
                destination = root / "unpack"
                destination.mkdir()
                with self.assertRaises(RuntimeError):
                    helper.unpack_archive(archive, destination)
                self.assertEqual(list(destination.iterdir()), [])

    def test_archive_duplicate_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "bad.tar"
            with tarfile.open(archive, "w") as output:
                output.addfile(tarfile.TarInfo("backend/file"))
                output.addfile(tarfile.TarInfo("backend/file"))
            with self.assertRaises(RuntimeError):
                helper.unpack_archive(archive, root)

    def test_release_verifies_exact_file_set_and_hashes(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "secure_directory"),
        ):
            target = Path(directory) / "backend"
            artifact(target)
            helper.verify_release(target, RELEASE)
            (target / "extra.py").write_text("not in manifest")
            with self.assertRaises(RuntimeError):
                helper.verify_release(target, RELEASE)
            (target / "extra.py").unlink()
            (target / "app/main.py").write_text("tampered")
            with self.assertRaises(RuntimeError):
                helper.verify_release(target, RELEASE)

    def test_test_release_is_never_accepted_on_production(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "secure_directory"),
        ):
            target = Path(directory) / "backend"
            artifact(target, environment="test")
            with self.assertRaises(RuntimeError):
                helper.verify_release(target, RELEASE)

    def test_current_symlink_must_stay_within_controlled_release(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "ROOT", Path(directory).resolve()),
        ):
            self.assertEqual(helper.current_target(), "NONE")
            target = helper.release_path(RELEASE)
            target.mkdir(parents=True)
            helper.switch_current(str(target))
            self.assertEqual(helper.current_target(), str(target))
            helper.switch_current("NONE")
            (Path(directory) / "current").symlink_to(directory)
            with self.assertRaises(RuntimeError):
                helper.current_target()

    def test_healthy_activation_enables_service(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "ROOT", Path(directory).resolve()),
            patch.object(helper, "probe_release"),
            patch.object(helper, "health"),
            patch.object(helper, "command") as command,
        ):
            target = helper.release_path(RELEASE)
            target.mkdir(parents=True)
            helper.activate_target(target, "NONE", {}, {})
            self.assertEqual(helper.current_target(), str(target))
            self.assertTrue(
                any("enable" in call.args[0] for call in command.call_args_list)
            )

    def test_failed_initial_activation_stops_disables_and_removes_current(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "ROOT", Path(directory).resolve()),
            patch.object(helper, "probe_release"),
            patch.object(helper, "health", side_effect=RuntimeError("unhealthy")),
            patch.object(helper, "command") as command,
        ):
            target = helper.release_path(RELEASE)
            target.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "previous state restored"):
                helper.activate_target(target, "NONE", {}, {})
            self.assertEqual(helper.current_target(), "NONE")
            self.assertTrue(
                any("disable" in call.args[0] for call in command.call_args_list)
            )

    def test_failed_update_restores_and_checks_old_release(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "ROOT", Path(directory).resolve()),
            patch.object(helper, "probe_release"),
            patch.object(
                helper, "health", side_effect=[RuntimeError("new failed"), None]
            ) as health,
            patch.object(helper, "command"),
        ):
            old = helper.release_path(OLD_RELEASE)
            old.mkdir(parents=True)
            target = helper.release_path(RELEASE)
            target.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "previous state restored"):
                helper.activate_target(target, str(old), {}, {})
            self.assertEqual(helper.current_target(), str(old))
            self.assertEqual(health.call_count, 2)

    def test_failed_restore_is_reported_and_service_remains_disabled(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "ROOT", Path(directory).resolve()),
            patch.object(helper, "probe_release"),
            patch.object(helper, "health", side_effect=RuntimeError("failed")),
            patch.object(helper, "command") as command,
        ):
            old = helper.release_path(OLD_RELEASE)
            old.mkdir(parents=True)
            target = helper.release_path(RELEASE)
            target.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "CRITICAL"):
                helper.activate_target(target, str(old), {}, {})
            self.assertTrue(
                any("disable" in call.args[0] for call in command.call_args_list)
            )

    def test_schema_probe_failure_happens_before_current_switch(self):
        with (
            patch.object(helper, "probe_release", side_effect=RuntimeError("DDL role")),
            patch.object(helper, "switch_current") as switch,
        ):
            with self.assertRaises(RuntimeError):
                helper.activate_target(Path("/fixture"), "NONE", {}, {})
            switch.assert_not_called()

    def test_prepare_cas_or_recovery_gate_prevents_changes(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(helper, "ROOT", Path(directory).resolve()),
            patch.object(helper.os, "geteuid", return_value=0),
            patch.object(helper, "locks", return_value=contextlib.nullcontext()),
            patch.object(helper, "contract", return_value=({}, {})),
        ):
            with self.assertRaisesRegex(RuntimeError, "current changed"):
                helper.main(["prepare", RELEASE, "/wrong/current"])
            self.assertEqual(list(Path(directory).iterdir()), [])
        with (
            patch.object(helper.os, "geteuid", return_value=0),
            patch.object(
                helper, "contract", side_effect=RuntimeError("recovery required")
            ),
            patch.object(helper, "report") as report,
        ):
            with self.assertRaisesRegex(RuntimeError, "recovery required"):
                helper.main(["preflight"])
            report.assert_not_called()

    def test_runtime_probe_checks_memberships_ddl_temp_and_schema(self):
        for marker in (
            "pg_has_role",
            "rolsuper",
            "rolbypassrls",
            "'TEMP'",
            "has_schema_privilege",
            "validate_shared_schema",
        ):
            self.assertIn(marker, helper.PROBE)
        self.assertNotIn("CREATE TABLE", helper.PROBE)
        self.assertNotIn("alembic", helper.PROBE)

    def test_child_failures_do_not_print_secret_urls(self):
        result = subprocess.CompletedProcess(
            ["python"], 1, "secret URL", "DATABASE_URL=secret"
        )
        with (
            patch.object(helper.subprocess, "run", return_value=result),
            self.assertRaisesRegex(RuntimeError, "command failed") as raised,
        ):
            helper.command(["python"])
        self.assertNotIn("secret", str(raised.exception))

    def test_main_backend_contract_mode_is_read_only_and_does_not_start_writers(self):
        with (
            patch.object(helper.os, "geteuid", return_value=0),
            patch.object(helper, "contract") as contract,
            patch.object(helper, "command") as command,
            patch.object(helper, "switch_current") as switch,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            helper.main(["contract"])
            contract.assert_called_once_with(allow_recovery=True)
            command.assert_not_called()
            switch.assert_not_called()

    def test_restart_holds_shared_lock_and_cannot_bypass_recovery(self):
        with (
            patch.object(helper.os, "geteuid", return_value=0),
            patch.object(
                helper, "locks", return_value=contextlib.nullcontext()
            ) as locks,
            patch.object(
                helper, "contract", side_effect=RuntimeError("recovery required")
            ),
            patch.object(helper, "activate_target") as activate,
        ):
            with self.assertRaisesRegex(RuntimeError, "recovery required"):
                helper.main(["restart", "NONE"])
            locks.assert_called_once()
            activate.assert_not_called()

    def test_production_main_and_admin_contract_have_no_recursive_or_mutating_call(
        self,
    ):
        source = SOURCE.read_text()
        self.assertIn('MAIN_ROOT / ".backend-release.lock"', source)
        self.assertIn(
            'SERVICE in main.get("LOUMAI_BACKEND_AUXILIARY_DATABASE_SERVICES"', source
        )
        self.assertIn("admin requires an independent DML database role", source)
        self.assertIn("probe_release(target, environment)", source)
        self.assertNotIn("alembic upgrade", source)

    @unittest.skipUnless(
        shutil.which("nginx") and shutil.which("openssl"),
        "local nginx/openssl unavailable",
    )
    def test_production_nginx_passes_real_syntax_without_starting_server(self):
        with tempfile.TemporaryDirectory(
            prefix="loumai-admin-production-nginx-"
        ) as directory:
            root = Path(directory)
            result = subprocess.run(
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
                    "/CN=admin.loumai.cn",
                    "-out",
                    str(root / "fullchain.pem"),
                    "-keyout",
                    str(root / "privkey.pem"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            remote = SOURCE.parents[2] / "admin-frontend/remote"
            site = (remote / "nginx-admin-production.conf.example").read_text()
            site = site.replace(
                "/etc/letsencrypt/live/admin.example.com", str(root)
            ).replace("admin.example.com", "admin.loumai.cn")
            config = root / "nginx.conf"
            config.write_text(
                f"error_log {root}/error.log;\npid {root}/nginx.pid;\nevents {{}}\nhttp {{\n"
                + (
                    remote / "nginx-admin-production-rate-limit.conf.example"
                ).read_text()
                + site
                + "\n}\n"
            )
            result = subprocess.run(
                ["nginx", "-t", "-p", str(root), "-c", str(config)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
