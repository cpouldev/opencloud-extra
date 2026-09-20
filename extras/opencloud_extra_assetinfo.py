"""Bounded source metadata extraction for OpenCloud Extra's information panel.

The caller supplies the same isolated, deadline-limited runner as thumbnails.
Only explicitly selected display fields leave this process; raw EXIF, paths,
comments and arbitrary container tags are never returned.
"""

import gzip
import math
import re
import struct
import unicodedata
import xml.etree.ElementTree as ET
import json


MAX_METADATA = 16384
MAX_XML = 8 * 1024 * 1024
MAX_FONT = 32 * 1024 * 1024
RASTER_CODERS = {
    ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif",
    ".webp": "webp", ".bmp": "bmp", ".tif": "tiff", ".tiff": "tiff",
    ".heic": "heic", ".heif": "heic", ".avif": "avif", ".jxl": "jxl",
    ".jp2": "jp2", ".j2k": "j2k", ".exr": "exr", ".hdr": "hdr",
    ".tga": "tga", ".ico": "ico", ".xcf": "xcf", ".psd": "psd", ".psb": "psd",
}


def text(value):
    """Keep small, single-line display strings, including non-Latin font names."""
    return " ".join("".join(char for char in str(value)
                           if not unicodedata.category(char).startswith("C")).split())[:256]


def positive(value, integral=False):
    try:
        number = float(value)
        if not math.isfinite(number) or not 0 < number <= 1_000_000_000:
            return None
        if integral:
            return int(number) if number.is_integer() else None
        return round(number, 6)
    except (ValueError, TypeError, OverflowError):
        return None


def add_number(info, key, value, integral=False):
    number = positive(value, integral)
    if number is not None:
        info[key] = number


def image_info(renderer):
    coder = RASTER_CODERS.get(renderer.source.suffix.lower())
    if not coder:
        raise ValueError("unsupported image metadata format")
    identify = [renderer.magick(), "identify"] if renderer.magick() == "magick" else ["identify"]
    # Explicit coders and the installed delegate policy also apply to probing.
    data = renderer.run([*identify, "-ping", "-format",
                         "%m\n%w\n%h\n%z\n%[colorspace]\n%[icc:description]",
                         f"{coder}:{renderer.source}[0]"], limit=MAX_METADATA)
    parts = data.decode("utf-8", "replace").split("\n", 5)
    if len(parts) != 6:
        raise ValueError("invalid image metadata")
    info = {"format": text(parts[0]), "colorSpace": text(parts[4])}
    for key, value in zip(("width", "height", "bitDepth"), parts[1:4]):
        add_number(info, key, value, integral=True)
    if not info.get("width") or not info.get("height"):
        raise ValueError("invalid source dimensions")
    profile = text(parts[5])
    if profile:
        info["colorProfile"] = profile
    return info


def pdf_info(renderer, illustrator=False):
    with renderer.source.open("rb") as stream:
        if b"%PDF-" not in stream.read(1024):
            raise ValueError("file has no PDF-compatible content")
    data = renderer.run(["pdfinfo", "-f", "1", "-l", "1", str(renderer.source)],
                        limit=65536).decode("utf-8", "replace")
    info = {"format": "PDF-compatible Illustrator" if illustrator else "PDF"}
    pages = re.search(r"^Pages:\s+(\d+)\s*$", data, re.M)
    if pages:
        add_number(info, "pages", pages[1], integral=True)
    size = re.search(r"^Page(?:\s+1)?\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts", data, re.M)
    if size:
        add_number(info, "pageWidth", size[1])
        add_number(info, "pageHeight", size[2])
    return info


def media_info(renderer, audio=False):
    fields = ("format=format_name,duration:stream=codec_type,codec_name,width,height,"
              "avg_frame_rate,sample_rate,channels,color_space,bits_per_raw_sample:"
              "stream_disposition=attached_pic")
    data = renderer.run(["ffprobe", "-v", "error", *renderer.media_input(audio),
                         "-show_entries", fields, "-of", "json"], limit=65536)
    result = json.loads(data)
    container = result.get("format", {})
    info = {}
    if container.get("format_name"):
        info["format"] = text(container["format_name"])
    add_number(info, "duration", container.get("duration"))
    for stream in result.get("streams", []):
        kind = stream.get("codec_type")
        codec = text(stream.get("codec_name", ""))
        if kind == "video" and not stream.get("disposition", {}).get("attached_pic") and "videoCodec" not in info:
            if codec:
                info["videoCodec"] = codec
            for key in ("width", "height"):
                add_number(info, key, stream.get(key), integral=True)
            try:
                numerator, denominator = stream.get("avg_frame_rate", "0/0").split("/")
                add_number(info, "frameRate", float(numerator) / float(denominator))
            except (ValueError, ZeroDivisionError):
                pass
            add_number(info, "bitDepth", stream.get("bits_per_raw_sample"), integral=True)
            color = stream.get("color_space")
            if color and color not in ("unknown", "unspecified"):
                info["colorSpace"] = text(color)
        if kind == "audio" and "audioCodec" not in info:
            if codec:
                info["audioCodec"] = codec
            add_number(info, "sampleRate", stream.get("sample_rate"), integral=True)
            add_number(info, "channels", stream.get("channels"), integral=True)
    return info


def font_info(renderer):
    from fontTools.ttLib import TTFont

    if renderer.source.stat().st_size > MAX_FONT:
        raise ValueError("font exceeds the metadata size limit")
    faces = 1
    with renderer.source.open("rb") as stream:
        header = stream.read(12)
    if header[:4] == b"ttcf" and len(header) == 12:
        faces = struct.unpack(">I", header[8:12])[0]
        if not 1 <= faces <= 10000:
            raise ValueError("font collection exceeds the face limit")
    with TTFont(renderer.source, fontNumber=0, lazy=True) as font:
        info = {"format": renderer.source.suffix[1:].upper(), "fontFaces": faces,
                "fontVariable": "fvar" in font}
        names = font["name"]
        for key, ids in (("fontFamily", (16, 1)), ("fontStyle", (17, 2)),
                         ("fontFullName", (4,)), ("fontVersion", (5,))):
            value = next((names.getDebugName(number) for number in ids if names.getDebugName(number)), None)
            if value:
                info[key] = text(value)
        if "maxp" in font:
            add_number(info, "glyphs", font["maxp"].numGlyphs, integral=True)
    return info


def svg_info(renderer):
    opener = gzip.open if renderer.source.suffix.lower() == ".svgz" else open
    with opener(renderer.source, "rb") as stream:
        data = stream.read(MAX_XML + 1)
    if len(data) > MAX_XML or re.search(br"<!\s*(?:DOCTYPE|ENTITY)", data.replace(b"\x00", b""), re.I):
        raise ValueError("SVG metadata contains an entity or exceeds the size limit")
    root = ET.fromstring(data)
    if root.tag.split("}")[-1] != "svg":
        raise ValueError("input is not SVG")
    info = {"format": "SVG"}
    # SVG dimensions are document dimensions, not raster pixel counts. Percent
    # and relative lengths, and a viewBox alone, do not establish physical size.
    points = {"": .75, "px": .75, "pt": 1, "pc": 12, "in": 72, "cm": 72 / 2.54, "mm": 72 / 25.4}
    for attribute, key in (("width", "pageWidth"), ("height", "pageHeight")):
        match = re.fullmatch(r"\s*(\d+(?:\.\d*)?|\.\d+)\s*(px|pt|pc|in|cm|mm)?\s*", root.get(attribute, ""))
        if match:
            add_number(info, key, float(match[1]) * points[match[2] or ""])
    return info


def raw_info(renderer):
    data = renderer.run(["raw-identify", "-s", str(renderer.source)], limit=65536)
    parts = data.decode("utf-8", "replace").rstrip().rsplit("\t", 2)
    if len(parts) != 3:
        raise ValueError("invalid RAW metadata")
    info = {"format": renderer.source.suffix[1:].upper()}
    add_number(info, "width", parts[1], integral=True)
    add_number(info, "height", parts[2], integral=True)
    if "width" not in info or "height" not in info:
        raise ValueError("invalid RAW dimensions")
    return info


def extract_metadata(kind, renderer):
    handlers = {"image": image_info, "photoshop": image_info, "pdf": pdf_info,
                "illustrator": lambda runner: pdf_info(runner, True), "video": media_info,
                "audio": lambda runner: media_info(runner, True), "font": font_info,
                "svg": svg_info, "raw": raw_info}
    info = {"schemaVersion": 1}
    if kind in handlers:
        info.update(handlers[kind](renderer))
    data = json.dumps(info, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_METADATA:
        raise ValueError("asset metadata exceeds the size limit")
    renderer.output.write_bytes(data)
