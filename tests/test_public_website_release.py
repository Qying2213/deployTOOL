"""官网发布器回归：临时文件和 mock，不访问 SSH、systemd 或生产库。"""

import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


local = module("website_local", "public-website/release.py")
remote = module("website_remote", "public-website/remote/release.py")
RELEASE = "20261008T010000Z-0123456789"


def metadata(**changes):
    values = dict(
        release_id=RELEASE,
        branch=local.BRANCH,
        backend_commit="a" * 40,
        frontend_commit="b" * 40,
        tool_commit="c" * 40,
        database_mode="read-only",
        database_migration=False,
    )
    return {**values, **changes}


def archive(path, values=None, extra=None):
    files = {
        "release.json": json.dumps(values or metadata()),
        "backend/app/public_website_main.py": "# entry\n",
        "site/index.html": "<html></html>",
        "ops/loumai-public-website.service": "# unit\n",
    }
    with tarfile.open(path, "w:gz") as output:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content.encode())
            output.addfile(info, io.BytesIO(content.encode()))
        if extra:
            output.addfile(extra, io.BytesIO(b"x") if extra.size else None)


class PublicWebsiteReleaseTest(unittest.TestCase):
    def test_sources_must_be_matching_clean_and_pushed(self):
        with patch.object(
            local, "run", side_effect=[local.BRANCH, "", "a" * 40, "a" * 40]
        ):
            self.assertEqual(local.repository_commit("/fake"), "a" * 40)
        for responses in (
            ["master"],
            [local.BRANCH, " M app/main.py"],
            [local.BRANCH, "", "a" * 40, "b" * 40],
        ):
            with (
                self.subTest(responses=responses),
                patch.object(local, "run", side_effect=responses),
            ):
                with self.assertRaises(AssertionError):
                    local.repository_commit("/fake")

    def test_static_bundle_requires_public_api_and_icp(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "assets").mkdir()
            index = root / "index.html"
            content = "蜀ICP备2026032754号-1 /api/v1/public-website"
            index.write_text(content)
            local.validate_site(root)
            for invalid in (
                "/api/v1/public-website",
                "蜀ICP备2026032754号-1",
                content + " https://test.example.com",
            ):
                index.write_text(invalid)
                with self.subTest(invalid=invalid), self.assertRaises(AssertionError):
                    local.validate_site(root)

    def test_static_bundle_rejects_secret_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "assets").mkdir()
            (root / "index.html").write_text(
                "蜀ICP备2026032754号-1 /api/v1/public-website"
            )
            for name in ("private.pem", "database.sql", ".env", "source.map"):
                file = root / name
                file.write_text("private")
                with self.subTest(name=name), self.assertRaises(AssertionError):
                    local.validate_site(root)
                file.unlink()
            (root / "link").symlink_to(root / "index.html")
            with self.assertRaises(AssertionError):
                local.validate_site(root)

    def test_archive_accepts_fixed_readonly_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "releases").mkdir()
            source = root / "artifact.tar.gz"
            archive(source)
            with patch.object(remote, "ROOT", root):
                target = remote.unpack_release(source)
                self.assertEqual(target, root / "releases" / RELEASE)
                self.assertTrue((target / "site/index.html").is_file())
                with self.assertRaises(AssertionError):
                    remote.unpack_release(source)

    def test_archive_rejects_bad_headers_before_writing(self):
        for name, kind in (
            ("../escape", tarfile.REGTYPE),
            ("/tmp/escape", tarfile.REGTYPE),
            ("site/link", tarfile.SYMTYPE),
            ("site/link", tarfile.LNKTYPE),
            ("site/fifo", tarfile.FIFOTYPE),
            ("other/file", tarfile.REGTYPE),
            ("site/index.html", tarfile.REGTYPE),
        ):
            with (
                self.subTest(name=name, kind=kind),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                (root / "releases").mkdir()
                source = root / "artifact.tar.gz"
                bad = tarfile.TarInfo(name)
                bad.type = kind
                bad.linkname = "/tmp/escape"
                bad.size = 1 if kind == tarfile.REGTYPE else 0
                archive(source, extra=bad)
                with (
                    patch.object(remote, "ROOT", root),
                    self.assertRaises(AssertionError),
                ):
                    remote.unpack_release(source)
                self.assertEqual(list((root / "releases").iterdir()), [])

    def test_archive_rejects_wrong_source_and_database_metadata(self):
        for changes in (
            {"branch": "master"},
            {"database_mode": "read-write"},
            {"database_migration": True},
            {"release_id": "../evil"},
            {"backend_commit": "not-a-commit"},
        ):
            with (
                self.subTest(changes=changes),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                (root / "releases").mkdir()
                source = root / "artifact.tar.gz"
                archive(source, metadata(**changes))
                with (
                    patch.object(remote, "ROOT", root),
                    self.assertRaises(AssertionError),
                ):
                    remote.unpack_release(source)
                self.assertEqual(list((root / "releases").iterdir()), [])

    def test_current_link_rejects_outside_release_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"
            outside.mkdir()
            (root / "current").symlink_to(outside)
            with patch.object(remote, "ROOT", root), self.assertRaises(AssertionError):
                remote.current_target()

    def test_atomic_swap_rejects_missing_or_outside_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.object(remote, "ROOT", root):
                for target in (root / "missing", root / "releases" / RELEASE):
                    with self.assertRaises(AssertionError):
                        remote.swap_current(target)
                self.assertFalse((root / "current").exists())
                target = root / "releases" / RELEASE
                target.mkdir(parents=True)
                remote.swap_current(target)
                self.assertEqual(remote.current_target(), target)

    def test_file_backup_restores_and_removes_only_scoped_new_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "existing"
            original.write_text("before")
            link = root / "link"
            link.symlink_to(original)
            new = root / "new"
            with patch.object(remote, "BACKUPS", root / "backups"):
                backup = remote.backup_files(
                    "test", [str(original), str(link), str(new)]
                )
                original.write_text("after")
                new.write_text("new")
                remote.restore_files(backup)
            self.assertEqual(original.read_text(), "before")
            self.assertEqual(link.resolve(), original.resolve())
            self.assertFalse(new.exists())
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)

    def test_systemd_only_starts_standalone_readonly_entry(self):
        source = (
            ROOT / "public-website/remote/loumai-public-website.service"
        ).read_text()
        self.assertIn("app.public_website_main:app", source)
        self.assertIn("--host 127.0.0.1 --port 8011", source)
        self.assertIn("User=loumai-website", source)
        self.assertIn("ProtectSystem=strict", source)
        self.assertNotIn("app.main:app", source)
        self.assertNotIn("alembic", source)

    def test_gateway_limits_and_redacted_logs_do_not_trust_arbitrary_forwarding(self):
        site = (ROOT / "public-website/remote/nginx-public-website.conf").read_text()
        http = (
            ROOT / "public-website/remote/nginx-public-website-http.conf"
        ).read_text()
        self.assertIn("set_real_ip_from @OLD_IPV4@;", site)
        self.assertNotIn("set_real_ip_from 0.0.0.0", site)
        self.assertIn("rate=5r/s", http)
        self.assertIn("burst=20", site)
        self.assertIn("Retry-After 1 always", site)
        self.assertIn("$request_method $uri", http)
        self.assertNotIn("$request_uri", http)
        self.assertNotIn("$args", http)
        self.assertIn("return 405", site)

    def test_old_forwarder_verifies_tls_and_overwrites_client_identity(self):
        source = (
            ROOT / "public-website/remote/nginx-old-site-forward.conf"
        ).read_text()
        self.assertIn("proxy_ssl_verify on;", source)
        self.assertIn("proxy_ssl_name yinlizhangyu.com;", source)
        self.assertIn("proxy_set_header X-Real-IP $remote_addr;", source)
        self.assertNotIn("$proxy_add_x_forwarded_for", source)
        self.assertNotIn("root /srv/workway-site", source)

    def test_certificate_validation_failure_does_not_install_tls_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(remote, "production"),
                patch.object(remote, "CONFIG", root),
                patch.object(
                    remote.sys,
                    "stdin",
                    io.StringIO('{"fullchain":"broken","privkey":"broken"}'),
                ),
            ):
                with self.assertRaises(Exception):
                    remote.import_certificate()
            self.assertFalse((root / "tls").exists())

    def test_remote_failure_withholds_unstructured_secret_output(self):
        result = type(
            "Result",
            (),
            {"returncode": 1, "stdout": "private-password", "stderr": "secret"},
        )()
        with (
            patch.object(local, "ssh_arguments", return_value=[]),
            patch.object(local.subprocess, "run", return_value=result),
            patch("sys.stdout", new_callable=io.StringIO) as output,
        ):
            with self.assertRaises(SystemExit):
                local.remote({}, "stage")
            self.assertNotIn("private-password", output.getvalue())
            self.assertNotIn("secret", output.getvalue())


if __name__ == "__main__":
    unittest.main()
