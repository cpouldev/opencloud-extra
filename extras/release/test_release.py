import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import release


class VersionTests(unittest.TestCase):
    def test_stable_tags(self):
        for value in ("v8.0.1", "8.0.1"):
            with self.subTest(value=value):
                self.assertEqual(release.stable_version(value), (8, 0, 1))

    def test_nonstable_tags_are_rejected(self):
        for value in ("v8.0.1-rc.1", "v8.0.1+build", "main", "v08.0.1", "--all", "8.0.1\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.stable_version(value)

    def test_latest_release_uses_semantic_order(self):
        releases = [
            {"tag_name": "v8.9.1", "draft": False, "prerelease": False},
            {"tag_name": "v8.10.0", "draft": False, "prerelease": False},
            {"tag_name": "v9.0.0", "draft": False, "prerelease": True},
            {"tag_name": "v10.0.0", "draft": True, "prerelease": False},
            {"tag_name": "rolling", "draft": False, "prerelease": False},
        ]
        with patch.object(release, "github_get", return_value=releases):
            self.assertEqual(release.latest_upstream(), "v8.10.0")


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "GITHUB_REPOSITORY": release.FORK,
            "GITHUB_REF": "refs/heads/extra/stable",
            "GITHUB_SERVER_URL": "https://github.com",
            "GH_HOST": "github.com",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_expected_fork_is_allowed(self):
        with patch.object(release, "git", return_value=f"https://github.com/{release.FORK}.git"):
            release.guard()

    def test_upstream_repository_is_rejected(self):
        os.environ["GITHUB_REPOSITORY"] = release.UPSTREAM
        with self.assertRaisesRegex(RuntimeError, "only in"):
            release.guard()

    def test_wrong_branch_is_rejected(self):
        os.environ["GITHUB_REF"] = "refs/heads/main"
        with self.assertRaisesRegex(RuntimeError, "must run from"):
            release.guard()

    def test_unsafe_push_url_is_rejected(self):
        for value in (f"https://github.com/{release.UPSTREAM}.git",
                      f"https://github.com/{release.FORK}.git.evil",
                      f"https://github.com/{release.FORK}.git\nhttps://github.com/{release.UPSTREAM}.git"):
            with self.subTest(value=value), patch.object(release, "git", return_value=value):
                with self.assertRaisesRegex(RuntimeError, "push URL"):
                    release.guard()


class GitReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.previous = Path.cwd()
        self.root = Path(self.temp.name)
        self.repo = self.root / "work"
        self.repo.mkdir()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, self.previous)
        release.git("init", "--initial-branch=extra/stable")
        release.git("config", "user.name", "Release Test")
        release.git("config", "user.email", "test@example.invalid")
        self.commit("shared.txt", "upstream\n")
        release.git("tag", "v8.0.1")
        Path("extras/release").mkdir(parents=True)
        Path(release.METADATA).write_text('{"tag":"v8.0.1"}\n')
        self.commit("extra.txt", "custom thumbnail support\n")
        self.base = release.git("rev-parse", "HEAD")
        self.remote = self.root / "fork.git"
        release.git("init", "--bare", str(self.remote))
        release.git("remote", "add", "origin", str(self.remote))
        release.git("push", "origin", "extra/stable")
        # Actual mutations below are confined to temporary local repositories.
        self.guarded = patch.object(release, "guard")
        self.guarded.start()
        self.addCleanup(self.guarded.stop)

    def commit(self, filename, content):
        Path(filename).write_text(content)
        release.git("add", ".")
        release.git("commit", "-m", f"update {filename}")
        return release.git("rev-parse", "HEAD")

    def plan(self, candidate=None, version="8.0.1-extra.1"):
        return {"needed": True, "base": self.base, "candidate": candidate or self.base,
                "version": version, "upstream": "v8.0.1"}

    def upstream(self, text):
        release.git("checkout", "-b", "upstream-next", "v8.0.1")
        self.commit("shared.txt", text)
        release.git("tag", "v8.0.2")
        release.git("checkout", "extra/stable")
        actual = release.git

        def local_fetch(*args):
            if args[:2] == ("fetch", "--no-tags"):
                args = (*args[:2], str(self.repo), *args[3:])
            return actual(*args)

        return patch.object(release, "git", side_effect=local_fetch)

    def test_first_extra_revision(self):
        self.assertEqual(release.release_choice("v8.0.1", self.base), ("8.0.1-extra.1", False))

    def test_completed_unchanged_release_is_skipped(self):
        release.git("tag", "8.0.1-extra.1")
        with patch.object(release, "published", return_value=True):
            self.assertEqual(release.release_choice("v8.0.1", self.base), (None, False))

    def test_failed_publication_reuses_reserved_version(self):
        release.git("tag", "8.0.1-extra.1")
        with patch.object(release, "published", return_value=False):
            self.assertEqual(release.release_choice("v8.0.1", self.base), ("8.0.1-extra.1", True))

    def test_new_revision_after_custom_changes(self):
        for count in (1, 2, 3):
            release.git("tag", f"8.0.1-extra.{count}")
        candidate = self.commit("extra.txt", "more extras\n")
        self.assertEqual(release.release_choice("v8.0.1", candidate), ("8.0.1-extra.4", False))

    def test_manual_rebuild_allocates_next_revision(self):
        release.git("tag", "8.0.1-extra.1")
        with patch.object(release, "published", return_value=True):
            self.assertEqual(release.release_choice("v8.0.1", self.base, True), ("8.0.1-extra.2", False))

    def test_merge_preserves_custom_files(self):
        with self.upstream("new upstream\n"):
            release.merge_upstream("v8.0.2")
        self.assertEqual(Path("extra.txt").read_text(), "custom thumbnail support\n")
        self.assertEqual(Path("shared.txt").read_text(), "new upstream\n")
        self.assertEqual(json.loads(Path(release.METADATA).read_text()), {"tag": "v8.0.2"})

    def test_conflicting_merge_aborts_without_push(self):
        custom = self.commit("shared.txt", "our customization\n")
        with self.upstream("upstream changed the same line\n"):
            with self.assertRaisesRegex(RuntimeError, "manual resolution"):
                release.merge_upstream("v8.0.2")
        self.assertEqual(release.git("rev-parse", "HEAD"), custom)
        self.assertEqual(release.remote_ref("refs/heads/extra/stable"), self.base)
        self.assertEqual(release.git("status", "--porcelain"), "")

    def test_candidate_bundle_restores_exact_commit(self):
        directory = self.root / "artifact"
        with patch.object(release, "latest_upstream", return_value="v8.0.1"):
            release.prepare(directory)
        plan = release.load_plan(directory)
        release.git("checkout", "--detach", "v8.0.1")
        release.import_candidate(directory, checkout=True)
        self.assertEqual(release.git("rev-parse", "HEAD"), plan["candidate"])

    def test_advance_is_atomic(self):
        candidate = self.commit("extra.txt", "next customization\n")
        release.advance(self.plan(candidate))
        self.assertEqual(release.remote_ref("refs/heads/extra/stable"), candidate)
        self.assertEqual(release.remote_ref("refs/tags/8.0.1-extra.1"), candidate)

    def test_repeated_advance_is_idempotent(self):
        release.advance(self.plan())
        release.advance(self.plan())
        self.assertEqual(release.remote_ref("refs/tags/8.0.1-extra.1"), self.base)

    def test_stale_base_rejects_promotion(self):
        candidate = self.commit("extra.txt", "validated\n")
        release.git("checkout", "--detach", self.base)
        changed = self.commit("new.txt", "concurrent maintainer change\n")
        release.git("push", "origin", f"{changed}:refs/heads/extra/stable")
        with self.assertRaisesRegex(RuntimeError, "moved"):
            release.advance(self.plan(candidate))
        self.assertIsNone(release.remote_ref("refs/tags/8.0.1-extra.1"))
        self.assertEqual(release.remote_ref("refs/heads/extra/stable"), changed)

    def test_existing_tag_is_never_overwritten(self):
        release.git("push", "origin", f"{self.base}:refs/tags/8.0.1-extra.1")
        candidate = self.commit("extra.txt", "different commit\n")
        with self.assertRaisesRegex(RuntimeError, "another commit"):
            release.advance(self.plan(candidate))
        self.assertEqual(release.remote_ref("refs/heads/extra/stable"), self.base)

    def test_race_after_head_read_rejects_atomic_push(self):
        candidate = self.commit("extra.txt", "validated\n")
        release.git("checkout", "--detach", self.base)
        concurrent = self.commit("new.txt", "concurrent maintainer change\n")
        actual = release.git

        def race(*args):
            if args[:2] == ("push", "--atomic"):
                actual("push", "origin", f"{concurrent}:refs/heads/extra/stable")
            return actual(*args)

        with patch.object(release, "git", side_effect=race):
            with self.assertRaises(subprocess.CalledProcessError):
                release.advance(self.plan(candidate))
        self.assertIsNone(release.remote_ref("refs/tags/8.0.1-extra.1"))
        self.assertEqual(release.remote_ref("refs/heads/extra/stable"), concurrent)

    def test_rewind_is_rejected(self):
        older = release.git("rev-parse", "v8.0.1")
        with self.assertRaises(subprocess.CalledProcessError):
            release.advance(self.plan(older))


if __name__ == "__main__":
    unittest.main()
