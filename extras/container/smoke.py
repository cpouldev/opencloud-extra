#!/usr/bin/env python3
"""Verify installed decoders and real image conversions before publishing."""

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from PIL import Image
import brotli
from fontTools.ttLib import TTFont


def run(*args, timeout=90, env=None):
    result = subprocess.run(
        args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=timeout, env=env,
    )
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr[-4000:]}")
    return result.stdout


def check_server():
    """Boot a disposable instance without touching the operator's data/config."""
    with tempfile.TemporaryDirectory(prefix="extra-server-smoke-") as directory:
        work = Path(directory)
        config = work / "config"
        data = work / "data"
        config.mkdir()
        data.mkdir()
        env = os.environ.copy()
        env.update(
            OC_CONFIG_DIR=str(config), OC_BASE_DATA_PATH=str(data),
            OC_URL="https://localhost:9200", OC_INSECURE="true",
            OC_LOG_LEVEL="error", PROXY_HTTP_ADDR="127.0.0.1:9200",
        )
        run("opencloud", "init", "--insecure", "yes", "--quiet",
            "--config-path", str(config), env=env)
        with (work / "server.log").open("w+") as log:
            server = subprocess.Popen(
                ("opencloud", "server"), env=env, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                deadline = time.monotonic() + 90
                # The disposable instance uses its generated self-signed cert.
                context = ssl._create_unverified_context()
                while time.monotonic() < deadline and server.poll() is None:
                    try:
                        with urllib.request.urlopen(
                            "https://localhost:9200/status.php", context=context, timeout=2,
                        ) as response:
                            status = json.load(response)
                        if status.get("installed"):
                            with urllib.request.urlopen(
                                "https://localhost:9200/", context=context, timeout=5,
                            ) as response:
                                index = response.read(512 * 1024)
                            if b"<html" in index.lower():
                                return "status.php and web assets ready"
                    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                        pass
                    time.sleep(0.5)
                log.seek(0)
                raise RuntimeError(f"OpenCloud did not start: {log.read()[-4000:]}")
            finally:
                if server.poll() is None:
                    try:
                        os.killpg(server.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        server.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(server.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        server.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-only", action="store_true")
    args = parser.parse_args()

    required = (
        "opencloud-extra-thumbnail", "ffmpeg", "ffprobe", "vips", "vipsheader",
        "magick", "pdftoppm", "soffice", "dcraw_emu", "bsdtar",
    )
    for command in required:
        if not shutil.which(command):
            raise RuntimeError(f"missing runtime command: {command}")

    decoders = run("ffmpeg", "-hide_banner", "-decoders")
    for codec in ("h264", "hevc", "av1", "vp8", "vp9", "mpeg2video", "mp3", "flac", "opus"):
        if not any(line.split()[1:2] == [codec] for line in decoders.splitlines()):
            raise RuntimeError(f"missing FFmpeg decoder: {codec}")

    loaders = run("vips", "-l", "foreign")
    for loader in ("heifload", "jxlload", "jp2kload", "pdfload", "svgload", "magickload"):
        if loader not in loaders:
            raise RuntimeError(f"missing libvips loader: {loader}")

    assert brotli.decompress(brotli.compress(b"font preview")) == b"font preview"
    font = Path("/usr/share/fonts/dejavu/DejaVuSans.ttf")
    if not font.is_file():
        raise RuntimeError(f"missing specimen font: {font}")
    with TTFont(font) as specimen:
        if not specimen.getBestCmap():
            raise RuntimeError("specimen font has no characters")

    rejected = subprocess.run(
        ("magick", "label:policy-check", "png:-"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
    )
    if rejected.returncode == 0 or b"security policy" not in rejected.stderr:
        raise RuntimeError("ImageMagick policy did not reject its text coder")

    # Cover the less common raster codecs with actual files. A registered loader
    # alone does not prove that its separately packaged codec plugin is present.
    verified = []
    with tempfile.TemporaryDirectory(prefix="extra-smoke-") as directory:
        work = Path(directory)
        source = work / "source.png"
        fixture = Image.new("RGB", (128, 96), (40, 100, 180))
        fixture.paste((230, 140, 20), (64, 0, 128, 96))
        fixture.save(source)
        for extension in ("heic", "avif", "jxl", "jp2", "exr", "hdr", "tga", "ico"):
            encoded = work / f"source.{extension}"
            run("magick", str(source), str(encoded))
            output = work / f"{extension}.png"
            run(
                "opencloud-extra-thumbnail", "--kind", "image", "--input",
                str(encoded), "--output", str(output), "--size", "128",
            )
            with Image.open(output) as thumbnail:
                thumbnail.load()
                if thumbnail.format != "PNG" or max(thumbnail.size) > 128:
                    raise RuntimeError(f"invalid {extension} thumbnail")
                if not any(high - low > 20 for low, high in thumbnail.convert("RGB").getextrema()):
                    raise RuntimeError(f"empty {extension} thumbnail")
            verified.append(extension)

    result = {
        "uid": os.getuid(),
        "vips": run("vips", "--vips-version").strip(),
        "libreoffice": run("soffice", "--version").strip(),
        "image_conversions": verified,
    }
    if not args.runtime_only:
        result["opencloud"] = run("opencloud", "--version").strip()
        result["startup"] = check_server()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
