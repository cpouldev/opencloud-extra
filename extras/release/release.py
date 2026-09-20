#!/usr/bin/env python3
"""Prepare and promote tested downstream releases. Upstream is read-only."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

FORK = "cpouldev/opencloud-extra"
UPSTREAM = "opencloud-eu/opencloud"
BRANCH = "extra/stable"
IMAGE = "docker.io/cpoul/opencloud-extra"
METADATA = "extras/release/upstream.json"
STABLE_TAG = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
EXTRA_TAG = re.compile(r"(\d+\.\d+\.\d+)-extra\.([1-9]\d*)\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")


def run(*args):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE).stdout.strip()


def git(*args):
    return run("git", *args)


def guard():
    """Require the known fork even when a caller accidentally copies this workflow."""
    if os.environ.get("GITHUB_REPOSITORY") != FORK:
        raise RuntimeError(f"Mutations are allowed only in {FORK}")
    if os.environ.get("GITHUB_REF") != f"refs/heads/{BRANCH}":
        raise RuntimeError(f"Releases must run from {BRANCH}")
    if os.environ.get("GITHUB_SERVER_URL", "https://github.com") != "https://github.com":
        raise RuntimeError("Unexpected GitHub server")
    if os.environ.get("GH_HOST", "github.com") != "github.com":
        raise RuntimeError("Unexpected GitHub CLI host")
    allowed = {f"https://github.com/{FORK}", f"https://github.com/{FORK}.git",
               f"git@github.com:{FORK}.git", f"ssh://git@github.com/{FORK}.git"}
    urls = git("remote", "get-url", "--push", "--all", "origin").splitlines()
    if len(urls) != 1 or urls[0] not in allowed:
        raise RuntimeError("Origin push URL must point only to the downstream fork")


def github_get(repo, resource):
    if repo not in {FORK, UPSTREAM}:
        raise ValueError("Unexpected GitHub repository")
    headers = {"Accept": "application/vnd.github+json"}
    if token := os.environ.get("GH_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/{resource}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def stable_version(tag):
    match = STABLE_TAG.fullmatch(tag)
    if not match:
        raise ValueError(f"Not a stable release tag: {tag}")
    return tuple(map(int, match.groups()))


def latest_upstream():
    tags = []
    page = 1
    while True:
        releases = github_get(UPSTREAM, f"releases?per_page=100&page={page}")
        if releases is None:
            raise RuntimeError("Cannot read upstream releases")
        tags.extend(r["tag_name"] for r in releases if not r["draft"] and not r["prerelease"]
                    and STABLE_TAG.fullmatch(r["tag_name"]))
        if len(releases) < 100:
            break
        page += 1
    if not tags:
        raise RuntimeError("Upstream has no stable releases")
    return max(tags, key=stable_version)


def version_tags(upstream):
    version = ".".join(map(str, stable_version(upstream)))
    tags = []
    for tag in git("tag", "--list", f"{version}-extra.*").splitlines():
        if match := EXTRA_TAG.fullmatch(tag):
            tags.append((int(match[2]), tag))
    return sorted(tags)


def published(tag):
    release = github_get(FORK, f"releases/tags/{tag}")
    return release is not None and not release["draft"] and not release["prerelease"]


def release_choice(upstream, base, force=False):
    """Return an existing unfinished version before allocating the next version."""
    tags = version_tags(upstream)
    if tags:
        _, newest = tags[-1]
        if git("rev-parse", f"{newest}^{{commit}}") == base:
            if not published(newest):
                return newest, True
            if not force:
                return None, False
    number = tags[-1][0] + 1 if tags else 1
    version = ".".join(map(str, stable_version(upstream)))
    return f"{version}-extra.{number}", False


def merge_upstream(tag):
    stable_version(tag)
    # An explicit URL with no push remote keeps upstream out of every mutation path.
    git("fetch", "--no-tags", f"https://github.com/{UPSTREAM}.git", f"refs/tags/{tag}")
    commit = git("rev-parse", "FETCH_HEAD^{commit}")
    try:
        git("merge", "--no-ff", "--no-edit", commit)
    except subprocess.CalledProcessError:
        conflicts = git("diff", "--name-only", "--diff-filter=U")
        git("merge", "--abort")
        raise RuntimeError(f"Upstream merge needs manual resolution in {FORK}:\n{conflicts}") from None
    Path(METADATA).write_text(json.dumps({"tag": tag}, indent=2) + "\n")
    git("add", METADATA)
    git("commit", "-m", f"chore(extra): track upstream {tag}")


def prepare(directory, force=False):
    guard()
    git("fetch", "--tags", "origin", f"refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}")
    base = git("rev-parse", f"refs/remotes/origin/{BRANCH}")
    git("checkout", "--detach", base)
    git("config", "user.name", "opencloud-extra[bot]")
    git("config", "user.email", "opencloud-extra@users.noreply.github.com")
    current = json.loads(Path(METADATA).read_text())["tag"]
    stable_version(current)
    version, retry = release_choice(current, base, force)
    upstream = current if retry else latest_upstream()
    if stable_version(upstream) < stable_version(current):
        raise RuntimeError("Refusing to downgrade the tracked upstream release")
    if stable_version(upstream) > stable_version(current):
        merge_upstream(upstream)
        version, _ = release_choice(upstream, git("rev-parse", "HEAD"), True)
    directory.mkdir(parents=True, exist_ok=True)
    if version is None:
        plan = {"needed": False, "base": base}
    else:
        candidate = git("rev-parse", "HEAD")
        plan = {"needed": True, "base": base, "candidate": candidate,
                "upstream": upstream, "version": version}
        git("update-ref", "refs/heads/extra/candidate", candidate)
        # Include base so even a no-merge release has a nonempty bundle. Consumers
        # checkout base with full history before importing the candidate objects.
        git("bundle", "create", str(directory / "candidate.bundle"),
            "refs/heads/extra/candidate", f"^{base}^")
    (directory / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            for key, value in plan.items():
                stream.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")
    print(json.dumps(plan))


def load_plan(directory):
    plan = json.loads((directory / "plan.json").read_text())
    if not plan.get("needed") or not SHA.fullmatch(plan["base"]) or not SHA.fullmatch(plan["candidate"]):
        raise ValueError("Invalid release commit")
    if not EXTRA_TAG.fullmatch(plan["version"]):
        raise ValueError("Invalid release version")
    if tuple(map(int, plan["version"].split("-")[0].split("."))) != stable_version(plan["upstream"]):
        raise ValueError("Release version does not match upstream")
    return plan


def import_candidate(directory, checkout=False):
    plan = load_plan(directory)
    git("fetch", str(directory / "candidate.bundle"),
        "refs/heads/extra/candidate:refs/remotes/extra/candidate")
    if git("rev-parse", "refs/remotes/extra/candidate") != plan["candidate"]:
        raise RuntimeError("Candidate bundle does not match release plan")
    git("merge-base", "--is-ancestor", plan["base"], plan["candidate"])
    upstream = json.loads(git("show", f"{plan['candidate']}:{METADATA}"))["tag"]
    if upstream != plan["upstream"]:
        raise RuntimeError("Candidate upstream metadata does not match release plan")
    if checkout:
        git("checkout", "--detach", plan["candidate"])
    return plan


def remote_ref(ref):
    result = git("ls-remote", "origin", ref).split()
    return result[0] if result else None


def advance(plan):
    guard()
    branch = f"refs/heads/{BRANCH}"
    tag = f"refs/tags/{plan['version']}"
    base, candidate = plan["base"], plan["candidate"]
    git("merge-base", "--is-ancestor", base, candidate)
    head, existing = remote_ref(branch), remote_ref(tag)
    if existing is not None and existing != candidate:
        raise RuntimeError("Release tag already points at another commit")
    if head == candidate and existing == candidate:
        return  # Safe retry after a failed Docker/GitHub publication.
    if head != base:
        raise RuntimeError("Stable branch moved during validation; run again")
    # The lease is a compare-and-swap; the ancestry check above prohibits rewinds.
    # Both branch and immutable tag update together, or neither update does.
    git("push", "--atomic", f"--force-with-lease={branch}:{base}",
        f"--force-with-lease={tag}:{existing or ''}", "origin",
        f"{candidate}:{branch}", f"{candidate}:{tag}")


def finish(plan):
    guard()
    version, candidate = plan["version"], plan["candidate"]
    if remote_ref(f"refs/tags/{version}") != candidate:
        raise RuntimeError("Release tag no longer matches the tested commit")
    if published(version):
        return
    notes = (f"OpenCloud Extra based on upstream {plan['upstream']}.\n\n"
             f"Tested source: `{candidate}`\n\n"
             f"Docker: `{IMAGE}:{version}` (linux/amd64 and linux/arm64).\n\n"
             "The `stable` and `latest` aliases point to this release.\n")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md") as file:
        file.write(notes)
        file.flush()
        run("gh", "release", "create", version, "--repo", FORK,
            "--verify-tag", "--target", candidate, "--title", f"OpenCloud Extra {version}",
            "--notes-file", file.name)


def diagnose():
    guard()
    run_id = os.environ["GITHUB_RUN_ID"]
    if not run_id.isdecimal():
        raise ValueError("Invalid workflow run ID")
    title = "OpenCloud Extra release automation needs attention"
    body = (f"[Failed workflow run](https://github.com/{FORK}/actions/runs/{run_id}).\n\n"
            "Inspect the failed job for merge conflicts, failed tests, image publication, "
            "or branch protection/workflow permission errors. Fix or merge the change in this "
            "fork, then rerun the workflow. Existing versioned images remain available.\n\n"
            "Do not open a pull request or make any changes in the upstream repository.\n")
    issues = json.loads(run("gh", "issue", "list", "--repo", FORK, "--state", "open",
                            "--search", f'"{title}" in:title', "--json", "number,title"))
    number = next((i["number"] for i in issues if i["title"] == title), None)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md") as file:
        file.write(body)
        file.flush()
        if number is None:
            run("gh", "issue", "create", "--repo", FORK, "--title", title, "--body-file", file.name)
        else:
            run("gh", "issue", "edit", str(number), "--repo", FORK, "--body-file", file.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "restore", "advance", "finish", "diagnose"])
    parser.add_argument("--directory", type=Path, default=Path("/tmp/extra-release"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.directory, args.force)
    elif args.command == "restore":
        import_candidate(args.directory, checkout=True)
    elif args.command == "advance":
        advance(import_candidate(args.directory))
    elif args.command == "finish":
        finish(load_plan(args.directory))
    else:
        diagnose()


if __name__ == "__main__":
    main()
