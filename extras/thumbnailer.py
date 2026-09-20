#!/usr/bin/env python3
"""Render one OpenCloud Extra thumbnail; all filenames are private local files.

The Go thumbnail service supplies a deadline, concurrency limit, and process group.
This helper adds decoder, archive, pixel, and child-process limits. It deliberately
does not fetch external resources or run a shell. Converter packages are pinned by
the container distribution; their supported codecs determine format coverage.
"""

import argparse
import base64
import gzip
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import resource
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import warnings
import xml.etree.ElementTree as ET
import zipfile

from PIL import Image, ImageDraw, ImageFont, ImageOps


MAX_INPUT = 1024 * 1024 * 1024
MAX_OUTPUT = 128 * 1024 * 1024
MAX_PREVIEW = 64 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
MAX_PIXELS = 64 * 1024 * 1024
MAX_SIZE = 2048
MAX_MEMBERS = 10000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

VIDEO_FORMATS = {
    ".mp4": "mov", ".m4v": "mov", ".mov": "mov", ".3gp": "mov",
    ".mkv": "matroska", ".webm": "matroska", ".avi": "avi",
    ".mpg": "mpeg", ".mpeg": "mpeg", ".mts": "mpegts",
    ".m2ts": "mpegts", ".ts": "mpegts", ".flv": "flv", ".wmv": "asf",
    ".hevc": "hevc", ".h265": "hevc",
}
AUDIO_FORMATS = {
    ".mp3": "mp3", ".flac": "flac", ".ogg": "ogg", ".opus": "ogg",
    ".m4a": "mov", ".wav": "wav", ".aiff": "aiff", ".aif": "aiff",
}
RASTER_CODERS = {
    ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif",
    ".webp": "webp", ".bmp": "bmp", ".tif": "tiff", ".tiff": "tiff",
    ".heic": "heic", ".heif": "heic", ".avif": "avif", ".jxl": "jxl",
    ".jp2": "jp2", ".j2k": "j2k", ".exr": "exr", ".hdr": "hdr",
    ".tga": "tga", ".ico": "ico", ".xcf": "xcf", ".psd": "psd",
    ".psb": "psd", ".ppm": "ppm", ".pgm": "pgm",
}
COVER_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"}
FAMILIES = (
    "video", "image", "photoshop", "illustrator", "pdf", "svg", "font",
    "raw", "office", "archive", "epub", "audio", "text",
)


class RenderError(Exception):
    """Unsupported or unsafe input, missing decoder, or failed conversion."""


def bounded_read(source, limit):
    data = source.read(limit + 1)
    if len(data) > limit:
        raise RenderError("embedded content exceeds the size limit")
    return data


def xml_document(data):
    # ElementTree does not resolve external entities, but reject all DTDs and
    # declared entities as well, including internally expanded entity bombs.
    if len(data) > MAX_XML or re.search(br"<!\s*(?:DOCTYPE|ENTITY)", data.replace(b"\x00", b""), re.I):
        raise RenderError("XML contains a DTD/entity or exceeds the size limit")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise RenderError("invalid XML") from exc


def safe_member(name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or ".." in path.parts or "\\" in name
            or ":" in name or any(ord(char) < 32 for char in name)):
        raise RenderError("archive contains an unsafe member name")
    return name


def natural_key(name):
    return [int(part) if part.isdigit() else part.casefold()
            for part in re.split(r"(\d+)", name)]


def safe_svg_reference(value):
    if not value or value.startswith("#"):
        return True
    match = re.fullmatch(r"data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)", value, re.I)
    if not match or len(value) > MAX_XML:
        return False
    try:
        data = base64.b64decode(re.sub(r"\s", "", match[2]), validate=True)
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "GIF", "WEBP"} or image.width * image.height > MAX_PIXELS:
                return False
            image.verify()
        return True
    except (ValueError, OSError):
        return False


class SafeZip:
    def __init__(self, source):
        self.archive = zipfile.ZipFile(source)
        members = self.archive.infolist()
        if len(members) > MAX_MEMBERS or sum(m.file_size for m in members) > MAX_INPUT:
            self.archive.close()
            raise RenderError("archive exceeds the member or expanded-size limit")
        self.members = {}
        try:
            for member in members:
                safe_member(member.filename)
                if member.filename in self.members:
                    raise RenderError("archive contains duplicate members")
                if stat.S_ISLNK(member.external_attr >> 16):
                    raise RenderError("archive contains a symbolic link")
                self.members[member.filename] = member
        except Exception:
            self.archive.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.archive.close()

    def read(self, name, limit=MAX_PREVIEW):
        member = self.members.get(safe_member(name))
        if member is None or member.is_dir() or member.flag_bits & 1:
            raise RenderError("archive preview is missing or encrypted")
        if member.file_size > limit:
            raise RenderError("archive preview exceeds the size limit")
        with self.archive.open(member) as source:
            return bounded_read(source, limit)


class Renderer:
    def __init__(self, source, output, size, work):
        self.source = Path(source).resolve()
        self.output = Path(output).resolve()
        self.size = size
        self.work = Path(work)
        self.deadline = time.monotonic() + 80
        self.env = dict(os.environ, HOME=str(self.work), TMPDIR=str(self.work),
                        VIPS_CONCURRENCY="1", OMP_NUM_THREADS="1",
                        MAGICK_THREAD_LIMIT="1", SAL_USE_VCLPLUGIN="svp",
                        LANG="C.UTF-8", LC_ALL="C.UTF-8")

    def run(self, args, stdout=None, timeout=40, limit=MAX_OUTPUT):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise RenderError("rendering deadline exceeded")
        executable = shutil.which(args[0])
        if not executable:
            raise RenderError(f"required converter is unavailable: {args[0]}")
        target = open(stdout, "wb") if stdout else tempfile.TemporaryFile(dir=self.work)
        try:
            with tempfile.TemporaryFile(dir=self.work) as errors:
                process = subprocess.Popen(
                    [executable, *map(str, args[1:])], stdin=subprocess.DEVNULL,
                    stdout=target, stderr=errors, cwd=self.work, env=self.env,
                )
                try:
                    process.wait(timeout=min(timeout, remaining))
                except subprocess.TimeoutExpired as exc:
                    process.kill()
                    process.wait()
                    raise RenderError(f"{args[0]} exceeded the rendering deadline") from exc
                if target.tell() > limit:
                    raise RenderError("converter output exceeds the size limit")
                if process.returncode:
                    errors.seek(0)
                    detail = errors.read(1500).decode("utf-8", "replace").strip()
                    raise RenderError(f"{args[0]} failed: {detail}")
                if stdout is None:
                    target.seek(0)
                    return bounded_read(target, limit)
                return b""
        finally:
            target.close()

    def finish(self, source):
        source = Path(source)
        if not source.is_file() or source.stat().st_size > MAX_OUTPUT:
            raise RenderError("converter did not produce a bounded image")
        with Image.open(source) as original:
            if original.width * original.height > MAX_PIXELS:
                raise RenderError("image exceeds the pixel limit")
            # Convert before saving to strip parser-specific metadata and retain
            # only a conventional, single-frame RGB/RGBA PNG for the Go decoder.
            oriented = ImageOps.exif_transpose(original)
            oriented.thumbnail((self.size, self.size), Image.Resampling.LANCZOS)
            result = oriented.convert("RGBA" if "A" in oriented.getbands() else "RGB")
            result.save(self.output, format="PNG")

    def magick(self):
        return "magick" if shutil.which("magick") else "convert"

    def raster(self, source=None):
        source = Path(source or self.source)
        extension = source.suffix.lower()
        coder = RASTER_CODERS.get(extension)
        if not coder:
            raise RenderError("unsupported raster preview format")
        # An explicit decoder avoids interpreting an SVG/PDF/URL disguised as
        # an image. In PSD/PSB frame zero is the saved, merged composite.
        spec = f"{coder}:{source}[0]"
        identify = [self.magick(), "identify"] if self.magick() == "magick" else ["identify"]
        dimensions = self.run([*identify, "-ping", "-format", "%w %h", spec], limit=1024)
        try:
            width, height = map(int, dimensions.split())
        except ValueError as exc:
            raise RenderError("cannot determine image dimensions") from exc
        if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
            raise RenderError("image exceeds the pixel limit")
        destination = self.work / "raster.png"
        args = [self.magick(), "-limit", "memory", "256MiB", "-limit", "map", "512MiB"]
        if extension == ".xcf":
            args += [f"xcf:{source}", "-background", "none", "-flatten"]
        else:
            args += [spec]
        if extension in {".exr", ".hdr"}:
            args += ["-auto-level", "-colorspace", "sRGB"]
        args += ["-auto-orient", "-thumbnail", f"{self.size}x{self.size}>",
                 "-strip", f"png:{destination}"]
        self.run(args)
        self.finish(destination)

    def pdf(self, source=None, illustrator=False):
        source = Path(source or self.source)
        with source.open("rb") as stream:
            if b"%PDF-" not in stream.read(1024):
                message = "Illustrator files must contain PDF-compatible content" if illustrator else "invalid PDF header"
                raise RenderError(message)
        prefix = self.work / "page"
        self.run(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", str(self.size),
                  "-png", str(source), str(prefix)])
        self.finish(prefix.with_suffix(".png"))

    def svg(self, source=None):
        source = Path(source or self.source)
        opener = gzip.open if source.suffix.lower() == ".svgz" else open
        with opener(source, "rb") as stream:
            root = xml_document(bounded_read(stream, MAX_XML))
        if root.tag.split("}")[-1] != "svg":
            raise RenderError("input is not an SVG document")
        for element in root.iter():
            tag = element.tag.split("}")[-1]
            if tag in {"script", "foreignObject"}:
                raise RenderError("SVG contains active content")
            values = [element.text or ""] if tag == "style" else []
            for key, value in element.attrib.items():
                local = key.split("}")[-1]
                if local in {"href", "src", "base"} and not safe_svg_reference(value):
                    raise RenderError("SVG external resources are not supported")
                if local.lower().startswith("on"):
                    raise RenderError("SVG contains event handlers")
                values.append(value)
            for value in values:
                # Disallow CSS escapes too: url/file/import must not be hidden
                # with escapes or comments from the resource checks below.
                if "\\" in value or "@import" in value.lower() or "/*" in value:
                    raise RenderError("SVG contains unsupported CSS resources")
                for reference in re.findall(r"url\s*\((.*?)\)", value, re.I | re.S):
                    if not safe_svg_reference(reference.strip(" \t\r\n\"'")):
                        raise RenderError("SVG external resources are not supported")
        sanitized = self.work / "sanitized.svg"
        # libvips' format sniffing expects an unprefixed <svg> root.
        ET.register_namespace("", "http://www.w3.org/2000/svg")
        ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
        ET.ElementTree(root).write(sanitized, encoding="utf-8", xml_declaration=True)
        destination = self.work / "svg.png"
        self.run(["vips", "thumbnail", str(sanitized), str(destination), str(self.size),
                  "--height", str(self.size), "--size", "down"])
        self.finish(destination)

    def media_input(self, audio=False):
        formats = AUDIO_FORMATS if audio else VIDEO_FORMATS
        demuxer = formats.get(self.source.suffix.lower())
        if not demuxer:
            raise RenderError("unsupported media container")
        return ["-protocol_whitelist", "file,pipe", "-f", demuxer, "-i", str(self.source)]

    def media_info(self, audio=False):
        data = self.run(["ffprobe", "-v", "error", *self.media_input(audio),
                         "-show_entries", "format=duration:stream=index,codec_type,width,height:stream_disposition=attached_pic",
                         "-of", "json"], limit=1024 * 1024)
        try:
            info = json.loads(data)
            for stream in info.get("streams", []):
                if stream.get("width", 0) * stream.get("height", 0) > MAX_PIXELS:
                    raise RenderError("media frame exceeds the pixel limit")
            return info
        except (ValueError, TypeError) as exc:
            raise RenderError("invalid media metadata") from exc

    def video(self):
        if self.source.suffix.lower() == ".ts":
            with self.source.open("rb") as stream:
                sample = stream.read(4096)
            if sample and b"\x00" not in sample:
                try:
                    decoded = sample.decode("utf-8")
                    if all(char.isprintable() or char in "\r\n\t" for char in decoded):
                        return self.text()
                except UnicodeDecodeError:
                    pass
        info = self.media_info()
        streams = [stream for stream in info.get("streams", [])
                   if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")]
        if not streams:
            raise RenderError("media contains no video stream")
        try:
            duration = float(info.get("format", {}).get("duration", 0))
            seek = min(duration * 0.1, 30) if math.isfinite(duration) and duration > 0 else 0
        except (TypeError, ValueError):
            seek = 0
        destination = self.work / "video.png"
        base = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "1"]
        for position in [seek, 0] if seek else [0]:
            try:
                seek_options = ["-ss", str(position)] if position > 0 else []
                self.run([*base, *seek_options, *self.media_input(),
                          "-map", f"0:{streams[0]['index']}", "-frames:v", "1", "-an",
                          "-vf", f"scale={self.size}:{self.size}:force_original_aspect_ratio=decrease",
                          "-threads", "1", str(destination)])
                if destination.is_file() and destination.stat().st_size:
                    return self.finish(destination)
            except RenderError:
                if position == 0:
                    raise
        raise RenderError("video contains no decodable frame")

    def audio(self):
        info = self.media_info(audio=True)
        destination = self.work / "audio.png"
        base = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "1", *self.media_input(audio=True)]
        for stream in info.get("streams", []):
            if stream.get("disposition", {}).get("attached_pic"):
                self.run([*base, "-map", f"0:{stream['index']}", "-frames:v", "1", "-an",
                          "-vf", f"scale={self.size}:{self.size}:force_original_aspect_ratio=decrease",
                          "-threads", "1", str(destination)])
                return self.finish(destination)
        # At most the first minute is decoded, even for multi-hour recordings.
        height = max(64, self.size // 3)
        self.run([*base, "-filter_complex",
                  f"[0:a:0]atrim=duration=60,aformat=channel_layouts=mono,showwavespic=s={self.size}x{height}:colors=0x365d86:draw=full[wave]",
                  "-map", "[wave]", "-frames:v", "1", "-threads", "1", str(destination)])
        self.finish(destination)

    def font(self):
        from fontTools.ttLib import TTFont

        if self.source.stat().st_size > MAX_PREVIEW:
            raise RenderError("font exceeds the size limit")
        with TTFont(self.source, fontNumber=0, lazy=False) as font:
            name = font["name"].getDebugName(4) or font["name"].getDebugName(1) or "Font specimen"
            characters = font.getBestCmap() or {}
            font.flavor = None  # Expand WOFF/WOFF2 into a FreeType-readable SFNT.
            decoded = self.work / "font.otf"
            font.save(decoded)
        canvas = Image.new("RGB", (self.size, max(1, self.size * 3 // 4)), "#f5f2eb")
        draw = ImageDraw.Draw(canvas)
        margin = max(8, self.size // 20)
        label_font = fallback_font(max(10, self.size // 30))
        draw.text((margin, margin), printable(name)[:80], font=label_font, fill="#3b4148")
        samples = ["Aa Bb Cc", "The quick brown fox", "jumps over the lazy dog.", "0123456789 !?&@"]
        if sum(ord(char) in characters for char in "ABCDEFGHIJKLMNOPQRSTUVWXYZ") < 15:
            glyphs = [chr(code) for code in sorted(characters)
                      if code >= 32 and unicodedata.category(chr(code))[0] in "LNSP"]
            if not glyphs:
                raise RenderError("font contains no printable glyphs")
            samples = [" ".join(glyphs[:8])] + ["".join(glyphs[start:start + 20]) for start in (8, 28, 48)]
        top = self.size // 7
        for index, sample in enumerate(samples):
            point_size = max(12, self.size // (9 if index == 0 else 22))
            face = ImageFont.truetype(str(decoded), point_size)
            while draw.textbbox((0, 0), sample, font=face)[2] > self.size - 2 * margin and point_size > 8:
                point_size -= 1
                face = ImageFont.truetype(str(decoded), point_size)
            draw.text((margin, top), sample, font=face, fill="#152b3c")
            top += self.size // (5 if index == 0 else 8)
        canvas.save(self.output, "PNG")

    def raw(self):
        # The LibRaw sample writes its preview beside its input. Give it a link
        # in the private directory, never the caller's original file location.
        local = self.work / ("camera" + self.source.suffix.lower())
        try:
            os.link(self.source, local)
        except OSError:
            shutil.copyfile(self.source, local)
        try:
            self.run(["simple_dcraw", "-e", str(local)])
            previews = [path for path in self.work.glob("camera*.thumb.*") if path.is_file()]
            if previews:
                return self.raster(previews[0])
        except RenderError:
            pass  # Cameras without a saved preview need demosaicing.
        metadata = self.run(["raw-identify", "-s", str(local)], limit=65536)
        try:
            width, height = map(int, metadata.rstrip().rsplit(b"\t", 2)[-2:])
        except ValueError as exc:
            raise RenderError("cannot determine RAW image dimensions") from exc
        if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
            raise RenderError("RAW image exceeds the pixel limit and has no usable preview")
        destination = self.work / "raw.tiff"
        self.run(["dcraw_emu", "-h", "-w", "-T", "-Z", str(destination), str(local)], timeout=60)
        self.raster(destination)

    def embedded(self, data, suffix):
        destination = self.work / ("embedded" + suffix.lower())
        destination.write_bytes(data)
        if suffix.lower() in {".svg", ".svgz"}:
            return self.svg(destination)
        return self.raster(destination)

    def archive(self):
        extension = self.source.suffix.lower()
        if extension == ".cbr":
            return self.rar()
        preferred = {
            ".kra": ("mergedimage.png", "preview.png"),
            ".ora": ("mergedimage.png", "Thumbnails/thumbnail.png"),
            ".sketch": ("previews/preview.png", "preview.png"),
        }
        with SafeZip(self.source) as archive:
            if extension == ".cbz":
                names = cover_names(archive.members)
            else:
                names = [name for name in preferred.get(extension, ()) if name in archive.members]
            if not names:
                raise RenderError("archive contains no supported embedded preview")
            self.embedded(archive.read(names[0]), Path(names[0]).suffix)

    def rar(self):
        with self.source.open("rb") as stream:
            if not stream.read(8).startswith(b"Rar!\x1a\x07"):
                raise RenderError("CBR file is not a RAR archive")
        listing = self.run(["bsdtar", "-tf", str(self.source)], limit=1024 * 1024)
        names = listing.decode("utf-8", "strict").splitlines()
        if len(names) > MAX_MEMBERS or len(set(names)) != len(names):
            raise RenderError("archive exceeds the member limit or contains duplicates")
        for name in names:
            safe_member(name)
            if any(char in name for char in "*?["):
                raise RenderError("RAR member names with wildcard characters are unsupported")
        covers = cover_names(names)
        if not covers:
            raise RenderError("comic archive contains no supported cover")
        destination = self.work / ("cover" + Path(covers[0]).suffix.lower())
        # -O writes bytes to our already-open file, so even an archive symlink
        # cannot cause a filesystem extraction or follow a destination link.
        self.run(["bsdtar", "-xOf", str(self.source), "--", covers[0]],
                 stdout=destination, limit=MAX_PREVIEW)
        self.raster(destination)

    def epub(self):
        with SafeZip(self.source) as archive:
            container = xml_document(archive.read("META-INF/container.xml", MAX_XML))
            rootfile = next((node.get("full-path") for node in container.iter()
                             if node.tag.split("}")[-1] == "rootfile"), None)
            if not rootfile:
                raise RenderError("EPUB has no package document")
            package = xml_document(archive.read(rootfile, MAX_XML))
            cover_id = next((node.get("content") for node in package.iter()
                             if node.tag.split("}")[-1] == "meta" and node.get("name") == "cover"), None)
            items = [node for node in package.iter() if node.tag.split("}")[-1] == "item"]
            cover = next((node for node in items if "cover-image" in node.get("properties", "").split()
                          or cover_id and node.get("id") == cover_id), None)
            if cover is not None:
                from urllib.parse import unquote, urlsplit

                reference = urlsplit(cover.get("href", ""))
                if reference.scheme or reference.netloc:
                    raise RenderError("EPUB cover refers to an external resource")
                if reference.path.startswith("/") or "\\" in reference.path:
                    raise RenderError("EPUB cover refers to an external resource")
                name = posixpath.normpath(str(PurePosixPath(rootfile).parent / unquote(reference.path)))
                safe_member(name)
                return self.embedded(archive.read(name), Path(name).suffix)
            names = cover_names(archive.members)
            if not names:
                raise RenderError("EPUB contains no supported cover image")
            names.sort(key=lambda name: ("cover" not in name.lower(), natural_key(name)))
            self.embedded(archive.read(names[0]), Path(names[0]).suffix)

    def office(self):
        self.check_office()
        profile = self.work / "office-profile"
        (profile / "user").mkdir(parents=True)
        # A fresh profile has no trusted macro locations. Disable link updates
        # for both Writer and Calc, and disable document event macros globally.
        settings = '''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>1</value></prop></item>
</oor:items>'''
        (profile / "user" / "registrymodifications.xcu").write_text(settings)
        extension = self.source.suffix.lower()
        exporter = "calc" if extension in {".xls", ".xlsx", ".ods"} else "impress" if extension in {".ppt", ".pptx", ".odp"} else "writer"
        options = ':{"PageRange":{"type":"string","value":"1"}}'
        office = "soffice" if shutil.which("soffice") else "libreoffice"
        self.run([office, "-env:UserInstallation=" + profile.as_uri(),
                  "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
                  "--convert-to", f"pdf:{exporter}_pdf_Export{options}",
                  "--outdir", str(self.work), str(self.source)], timeout=65)
        destination = self.work / (self.source.stem + ".pdf")
        if not destination.is_file():
            raise RenderError("Office document is encrypted or cannot be converted")
        self.pdf(destination)

    def check_office(self):
        extension = self.source.suffix.lower()
        with self.source.open("rb") as stream:
            header = stream.read(8)
        if extension in {".doc", ".xls", ".ppt"}:
            if header != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
                raise RenderError("invalid binary Office document")
            return
        if extension == ".rtf":
            with self.source.open("rb") as stream:
                data = bounded_read(stream, MAX_PREVIEW)
            if not data.startswith(b"{\\rtf") or re.search(br"INCLUDE(?:PICTURE|TEXT)|DDEAUTO|\\object", data, re.I):
                raise RenderError("RTF contains external/active content or is invalid")
            return
        with SafeZip(self.source) as archive:
            for name in archive.members:
                if not name.endswith((".xml", ".rels")):
                    continue
                root = xml_document(archive.read(name, MAX_XML))
                for node in root.iter():
                    if node.get("TargetMode") == "External" and not node.get("Type", "").endswith("/hyperlink"):
                        raise RenderError("Office document contains external resources")
                    for key, value in node.attrib.items():
                        if key.split("}")[-1] == "href" and node.tag.split("}")[-1] != "a":
                            if value.startswith(("/", "\\")) or ":" in value or ".." in PurePosixPath(value).parts:
                                raise RenderError("Office document contains external resources")

    def text(self):
        with self.source.open("rb") as stream:
            data = stream.read(32768)
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            contents = data.decode("utf-16", "replace")
        else:
            if b"\x00" in data:
                raise RenderError("text input contains binary data")
            contents = data.decode("utf-8-sig", "replace")
        invalid = sum(unicodedata.category(char) == "Cc" and char not in "\n\r\t" for char in contents)
        if invalid > max(2, len(contents) // 100):
            raise RenderError("text input contains binary data")
        canvas = Image.new("RGB", (self.size, self.size), "#f7f6f2")
        draw = ImageDraw.Draw(canvas)
        margin = max(6, self.size // 25)
        face = fallback_font(max(9, self.size // 45), mono=True)
        line_height = max(12, self.size // 34)
        top = margin
        for line in contents.expandtabs(4).splitlines()[:80]:
            if top + line_height > self.size - margin:
                break
            draw.text((margin, top), printable(line)[:160], font=face, fill="#25364a")
            top += line_height
        canvas.save(self.output, "PNG")


def cover_names(names):
    return sorted((name for name in names if Path(name).suffix.lower() in COVER_EXTENSIONS
                   and not any(part.startswith(".") or part == "__MACOSX" for part in PurePosixPath(name).parts)),
                  key=natural_key)


def printable(text):
    return "".join(char for char in text if char.isprintable())


def fallback_font(size, mono=False):
    name = "DejaVuSansMono.ttf" if mono else "DejaVuSans.ttf"
    for path in (f"/usr/share/fonts/dejavu/{name}", f"/usr/share/fonts/truetype/dejavu/{name}",
                 f"/usr/share/fonts/TTF/{name}", name,
                 "/System/Library/Fonts/Menlo.ttc" if mono else "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def process_limits():
    # On macOS RLIMIT_AS is not a useful bound on its large shared-library VM
    # mappings. Production Linux enforces the address-space and output limits.
    if sys.platform.startswith("linux"):
        for kind, limit in ((resource.RLIMIT_AS, 2 * 1024**3), (resource.RLIMIT_FSIZE, MAX_OUTPUT),
                            (resource.RLIMIT_CPU, 75)):
            _, hard = resource.getrlimit(kind)
            value = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
            resource.setrlimit(kind, (value, value))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", required=True, choices=FAMILIES)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--size", type=int, default=1024)
    args = parser.parse_args(argv)
    output_validated = False
    try:
        if not 32 <= args.size <= MAX_SIZE:
            raise RenderError(f"thumbnail size must be between 32 and {MAX_SIZE}")
        if args.input.is_symlink() or not args.input.is_file() or not 0 < args.input.stat().st_size <= MAX_INPUT:
            raise RenderError("input is not a bounded, nonempty regular file")
        if args.input.resolve() == args.output.resolve() or args.output.exists() or args.output.is_symlink():
            raise RenderError("output must be a new file distinct from input")
        output_validated = True
        process_limits()
        with tempfile.TemporaryDirectory(prefix="opencloud-extra-", dir=args.input.resolve().parent) as work:
            renderer = Renderer(args.input, args.output, args.size, work)
            method = {"image": "raster", "photoshop": "raster", "illustrator": "pdf"}.get(args.kind, args.kind)
            options = {"illustrator": True} if args.kind == "illustrator" else {}
            getattr(renderer, method)(**options)
        return 0
    except Exception as exc:
        # A malformed document can raise different parser-specific exceptions.
        # This executable boundary reports a failed conversion without exposing
        # a traceback; interrupts and process termination still propagate.
        if output_validated and not args.output.is_symlink():
            args.output.unlink(missing_ok=True)
        print(f"thumbnail unavailable: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
