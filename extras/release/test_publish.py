import copy
import io
import json
import os
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import publish


class ImageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.plan = {"candidate": "a" * 40, "version": "8.0.1-extra.1"}
        self.config = {"architecture": "amd64", "os": "linux", "config": {"Labels": {
            "org.opencontainers.image.revision": self.plan["candidate"],
            "org.opencontainers.image.version": self.plan["version"],
        }}}

    def test_tested_image_matches(self):
        publish.validate_config(self.config, self.plan, "amd64")

    def test_different_commit_is_rejected(self):
        self.config["config"]["Labels"]["org.opencontainers.image.revision"] = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "identity"):
            publish.validate_config(self.config, self.plan, "amd64")

    def test_wrong_architecture_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "identity"):
            publish.validate_config(self.config, self.plan, "arm64")

    def test_missing_architecture_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "differs"):
            publish.validate_index({"manifests": []}, {"amd64": "sha256:a", "arm64": "sha256:b"})

    def test_duplicate_architecture_is_rejected(self):
        manifest = {"manifests": [
            {"platform": {"os": "linux", "architecture": "amd64"}, "digest": "sha256:a"},
            {"platform": {"os": "linux", "architecture": "amd64"}, "digest": "sha256:a"},
        ]}
        with self.assertRaisesRegex(RuntimeError, "platform"):
            publish.validate_index(manifest, {"amd64": "sha256:a"})

    def test_retry_preserves_existing_version_images(self):
        digests = {"amd64": "sha256:" + "1" * 64, "arm64": "sha256:" + "2" * 64}
        index_digest = "sha256:" + "3" * 64
        index = {"manifests": [
            {"platform": {"os": "linux", "architecture": arch}, "digest": digest}
            for arch, digest in digests.items()
        ]}
        config = self.config

        class ExistingRegistry:
            def ensure_repository(self):
                pass

            def get(self, kind, ref):
                for arch, digest in digests.items():
                    if ref == f"8.0.1-extra.1-{arch}":
                        return {"config": {"digest": arch}}, digest
                    if kind == "blobs" and ref == arch:
                        item = copy.deepcopy(config)
                        item["architecture"] = arch
                        return item, None
                return index, index_digest

        with patch.object(publish.release, "guard"), \
                patch.object(publish.release, "remote_ref", return_value=self.plan["candidate"]), \
                patch.object(publish.release, "run") as commands:
            publish.publish(self.plan, Path("/no-images-needed"), ExistingRegistry())
        # Retrying only moves aliases; no load, push or version-tag replacement.
        self.assertEqual(commands.call_count, 1)
        command = commands.call_args.args
        self.assertIn("docker.io/cpoul/opencloud-extra:stable", command)
        self.assertNotIn("docker.io/cpoul/opencloud-extra:8.0.1-extra.1", command)


class RegistryHTTPTests(unittest.TestCase):
    @staticmethod
    def response(data):
        response = MagicMock()
        response.__enter__.return_value = io.StringIO(json.dumps(data))
        return response

    def test_bootstrap_creates_only_expected_repository(self):
        missing = urllib.error.HTTPError("https://hub.docker.com", 404, "Not Found", {}, None)
        with patch.object(publish.release, "guard"), \
                patch.dict(os.environ, {"DOCKERHUB_TOKEN": "test-token"}), \
                patch.object(publish.urllib.request, "urlopen", side_effect=[
                    self.response({"access_token": "test-session"}), missing, self.response({})
                ]) as request:
            publish.Registry().ensure_repository()
        created = request.call_args.args[0]
        self.assertEqual(created.full_url, "https://hub.docker.com/v2/namespaces/cpoul/repositories")
        self.assertEqual(json.loads(created.data)["name"], "opencloud-extra")
        self.assertFalse(json.loads(created.data)["is_private"])

    def test_registry_auth_failure_is_not_tag_absence(self):
        registry = publish.Registry()
        registry.token = "test-session"
        registry.expires = float("inf")
        for status in (401, 403, 429, 500):
            with self.subTest(status=status), patch.object(publish.urllib.request, "urlopen",
                    side_effect=urllib.error.HTTPError("https://registry-1.docker.io", status, "failed", {}, None)):
                with self.assertRaises(urllib.error.HTTPError):
                    registry.get("manifests", "8.0.1-extra.1")

    def test_registry_404_is_tag_absence(self):
        registry = publish.Registry()
        registry.token = "test-session"
        registry.expires = float("inf")
        with patch.object(publish.urllib.request, "urlopen",
                side_effect=urllib.error.HTTPError("https://registry-1.docker.io", 404, "missing", {}, None)):
            self.assertEqual(registry.get("manifests", "8.0.1-extra.1"), (None, None))


if __name__ == "__main__":
    unittest.main()
