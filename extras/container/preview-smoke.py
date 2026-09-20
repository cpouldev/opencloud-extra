#!/usr/bin/env python3
"""Exercise authenticated uploads and previews against a disposable OpenCloud."""

import base64
import io
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw
from fontTools.ttLib import TTFont


BASE = "https://localhost:9200"
PASSWORD = "extra-local-smoke-password"
AUTH = "Basic " + base64.b64encode(f"admin:{PASSWORD}".encode()).decode()
TLS = ssl._create_unverified_context()  # Disposable localhost certificate only.


def request(path, method="GET", data=None, headers=None, authenticated=True):
    if path.startswith(BASE + "/"):
        url = path
    elif path.startswith("/"):
        url = BASE + path
    else:
        raise ValueError("Smoke requests must stay on the disposable localhost server")
    hdr = dict(headers or {})
    if authenticated:
        hdr["Authorization"] = AUTH
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, context=TLS, timeout=100) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers


def fixtures(root):
    picture = Image.new("RGB", (160, 96), "#2463b0")
    ImageDraw.Draw(picture).rectangle((20, 20, 100, 70), fill="#e8a52c")
    png = root / "source.png"
    picture.save(png)
    picture.save(root / "artwork.ai", "PDF")
    subprocess.run(["magick", str(png), str(root / "layered.psd")], check=True, capture_output=True)
    (root / "vector.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96">'
        '<rect width="160" height="96" fill="#2463b0"/>'
        '<circle cx="80" cy="48" r="28" fill="#e8a52c"/></svg>'
    )
    font_path = next(Path("/usr/share/fonts").rglob("DejaVuSans.ttf"))
    with TTFont(font_path) as font:
        font.flavor = "woff2"
        font.save(root / "typeface.woff2")
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=2",
        "-t", "1", "-c:v", "libx265", "-preset", "ultrafast",
        "-x265-params", "pools=1:frame-threads=1:log-level=error", "-an",
        str(root / "hevc.mp4"),
    ], check=True, capture_output=True, timeout=30)
    return [root / name for name in ("vector.svg", "layered.psd", "artwork.ai", "typeface.woff2", "hevc.mp4")]


def check_previews(root):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            code, data, _ = request("/graph/v1.0/me/drives")
            if code == 200:
                drives = json.loads(data)["value"]
                personal = next((drive for drive in drives if drive["driveType"] == "personal"), None)
                if personal:
                    break
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.5)
    else:
        raise RuntimeError("Personal drive did not become ready")
    dav = personal["root"]["webDavUrl"].rstrip("/")
    propfind = (
        '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
        '<d:prop><oc:has-preview/></d:prop></d:propfind>'
    ).encode()
    names = []
    for fixture in fixtures(root):
        target = dav + "/" + urllib.parse.quote(fixture.name)
        code, body, _ = request(target, "PUT", fixture.read_bytes(), {"Content-Type": "application/octet-stream"})
        if code not in (201, 204):
            raise RuntimeError(f"{fixture.name}: upload returned {code}: {body[:400]!r}")
        # Processing completion can lag the upload response briefly.
        for _ in range(10):
            code, body, _ = request(target + "?preview=1&x=128&y=128&processor=fit")
            if code == 200:
                break
            if code not in (404, 425, 429, 503):
                break
            time.sleep(0.5)
        if code != 200:
            raise RuntimeError(f"{fixture.name}: preview returned {code}: {body[:400]!r}")
        with Image.open(io.BytesIO(body)) as preview:
            preview.load()
            if max(preview.size) > 128 or min(preview.size) < 1:
                raise RuntimeError(f"{fixture.name}: unexpected preview size {preview.size}")
            if all(low == high for low, high in preview.convert("RGB").getextrema()):
                raise RuntimeError(f"{fixture.name}: thumbnail contains no visible content")
        code, body, _ = request(target, "PROPFIND", propfind, {"Depth": "0", "Content-Type": "application/xml"})
        if code != 207 or not any(node.tag.endswith("}has-preview") and node.text == "1" for node in ET.fromstring(body).iter()):
            raise RuntimeError(f"{fixture.name}: WebDAV did not advertise a preview ({code}): {body[:1500]!r}")
        code, _, headers = request(target + "?preview=1&x=128&y=128", authenticated=False)
        if code == 200 and headers.get("Content-Type", "").startswith("image/"):
            raise RuntimeError("Unauthenticated request retrieved a private thumbnail")
        names.append(fixture.name)
        print(f"PASS authenticated upload, preview, WebDAV metadata: {fixture.name}", flush=True)
    code, body, _ = request("/graph/v1.0/me/drive/root/children?$expand=thumbnails")
    if code != 200:
        raise RuntimeError(f"Graph children returned {code}")
    items = {item["name"]: item for item in json.loads(body)["value"]}
    for name in names:
        if not items.get(name, {}).get("thumbnails"):
            raise RuntimeError(f"{name}: Graph did not advertise a preview")
    print("PASS Graph thumbnail metadata", flush=True)


def main():
    with tempfile.TemporaryDirectory(prefix="extra-preview-smoke-") as directory:
        root = Path(directory)
        env = dict(os.environ, OC_CONFIG_DIR=str(root / "config"), OC_BASE_DATA_PATH=str(root / "data"),
                   OC_URL=BASE, OC_INSECURE="true", PROXY_ENABLE_BASIC_AUTH="true",
                   IDM_ADMIN_PASSWORD=PASSWORD, OC_LOG_LEVEL="error")
        subprocess.run(["opencloud", "init", "--insecure", "true"], env=env,
                       check=True, capture_output=True, timeout=30)
        with (root / "server.log").open("w+") as log:
            process = subprocess.Popen(["opencloud", "server"], env=env, stdout=log, stderr=log, start_new_session=True)
            try:
                check_previews(root)
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-5000:])
                raise
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                except ProcessLookupError:
                    process.wait()


if __name__ == "__main__":
    main()
