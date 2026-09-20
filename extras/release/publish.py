#!/usr/bin/env python3
"""Publish already-tested image archives, without overwriting version tags."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

import release

REPOSITORY = "cpoul/opencloud-extra"
MEDIA = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


class Registry:
    def __init__(self):
        self.token = None
        self.expires = 0

    def ensure_repository(self):
        """Bootstrap the one authorized public repository before its first push."""
        release.guard()
        request = urllib.request.Request("https://hub.docker.com/v2/auth/token",
            data=json.dumps({"identifier": "cpoul", "secret": os.environ["DOCKERHUB_TOKEN"]}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            token = json.load(response)["access_token"]
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        url = f"https://hub.docker.com/v2/namespaces/cpoul/repositories/{REPOSITORY.split('/')[1]}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60):
                return
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
        request = urllib.request.Request("https://hub.docker.com/v2/namespaces/cpoul/repositories",
            data=json.dumps({"name": "opencloud-extra", "namespace": "cpoul",
                             "registry": "docker.io", "is_private": False,
                             "description": "OpenCloud with additional thumbnail formats"}).encode(),
            headers=headers)
        with urllib.request.urlopen(request, timeout=60):
            pass

    def get(self, kind, reference):
        if self.expires < time.monotonic():
            credentials = base64.b64encode(f"cpoul:{os.environ['DOCKERHUB_TOKEN']}".encode()).decode()
            request = urllib.request.Request(
                f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{REPOSITORY}:pull",
                headers={"Authorization": f"Basic {credentials}"})
            with urllib.request.urlopen(request, timeout=60) as response:
                auth = json.load(response)
            self.token = auth["token"]
            self.expires = time.monotonic() + auth.get("expires_in", 60) - 30
        request = urllib.request.Request(
            f"https://registry-1.docker.io/v2/{REPOSITORY}/{kind}/{reference}",
            headers={"Authorization": f"Bearer {self.token}", "Accept": MEDIA})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response), response.headers.get("Docker-Content-Digest")
        except urllib.error.HTTPError as error:
            if error.code == 404 and kind == "manifests":
                return None, None
            raise  # Network/authentication failures must never mean "tag absent".


def validate_config(config, plan, architecture):
    labels = config.get("config", {}).get("Labels") or {}
    if (config.get("architecture") != architecture or config.get("os") != "linux"
            or labels.get("org.opencontainers.image.revision") != plan["candidate"]
            or labels.get("org.opencontainers.image.version") != plan["version"]):
        raise RuntimeError("Image identity does not match the tested release")


def platform_digest(registry, tag, plan, architecture):
    manifest, digest = registry.get("manifests", tag)
    if manifest is None:
        return None
    if not digest or not DIGEST.fullmatch(digest) or "config" not in manifest:
        raise RuntimeError(f"Unexpected platform manifest for {tag}")
    config, _ = registry.get("blobs", manifest["config"]["digest"])
    validate_config(config, plan, architecture)
    return digest


def validate_index(manifest, expected):
    actual = {}
    for item in manifest.get("manifests", []):
        platform = item.get("platform", {})
        architecture = platform.get("architecture")
        if platform.get("os") != "linux" or architecture in actual:
            raise RuntimeError("Unexpected release image platform")
        actual[architecture] = item["digest"]
    if actual != expected:
        raise RuntimeError("Existing version tag differs from the tested platform images")


def publish(plan, directory, registry=None):
    release.guard()
    if release.remote_ref(f"refs/tags/{plan['version']}") != plan["candidate"]:
        raise RuntimeError("Reserve the tested Git release tag before publishing images")
    registry = registry or Registry()
    registry.ensure_repository()
    expected = {}
    for architecture in ("amd64", "arm64"):
        tag = f"{plan['version']}-{architecture}"
        digest = platform_digest(registry, tag, plan, architecture)
        if digest is None:
            local = f"opencloud-extra:test-{architecture}"
            release.run("docker", "load", "--input", str(directory / f"image-{architecture}.tar"))
            config = json.loads(release.run("docker", "image", "inspect", local))[0]
            # Docker CLI inspection uses different casing from the registry blob.
            validate_config({"architecture": config["Architecture"], "os": config["Os"],
                             "config": config["Config"]}, plan, architecture)
            destination = f"{release.IMAGE}:{tag}"
            release.run("docker", "tag", local, destination)
            release.run("docker", "push", destination)
            digest = platform_digest(registry, tag, plan, architecture)
            if digest is None:
                raise RuntimeError("Published image is missing from the registry")
        expected[architecture] = digest
    manifest, digest = registry.get("manifests", plan["version"])
    if manifest is None:
        release.run("docker", "buildx", "imagetools", "create", "--tag",
                    f"{release.IMAGE}:{plan['version']}",
                    *(f"{release.IMAGE}@{value}" for value in expected.values()))
        manifest, digest = registry.get("manifests", plan["version"])
    if manifest is None or not digest or not DIGEST.fullmatch(digest):
        raise RuntimeError("Published release manifest is missing")
    validate_index(manifest, expected)
    # Only mutable aliases are overwritten, using the verified immutable digest.
    release.run("docker", "buildx", "imagetools", "create",
                "--tag", f"{release.IMAGE}:stable", "--tag", f"{release.IMAGE}:latest",
                f"{release.IMAGE}@{digest}")
    for alias in ("stable", "latest"):
        _, actual = registry.get("manifests", alias)
        if actual != digest:
            raise RuntimeError(f"The {alias} alias does not point to the released digest")
    print(f"Published {release.IMAGE}:{plan['version']}@{digest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path("/tmp/extra-release"))
    args = parser.parse_args()
    publish(release.load_plan(args.directory), args.directory)
