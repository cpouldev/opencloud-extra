"""Real converters, tiny generated fixtures, and hostile-input regression checks.

Run with `python3 -m unittest discover -s extras/tests -v`. The runtime container
sets OPENCLOUD_EXTRA_REQUIRE_CONVERTERS=1 so a missing dependency fails the suite.
No test downloads documents or relies on a network connection.
"""

import base64
import gzip
import importlib.util
import io
import math
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import wave
import zipfile
import zlib

from PIL import Image, ImageDraw


SCRIPT = Path(__file__).resolve().parents[1] / "thumbnailer.py"
SPEC = importlib.util.spec_from_file_location("thumbnailer", SCRIPT)
thumbnailer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(thumbnailer)


def command(args, timeout=90):
    result = subprocess.run(list(map(str, args)), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise AssertionError(f"fixture/converter command failed: {args}\n{result.stderr.decode(errors='replace')[-3000:]}")
    return result


def image_bytes(color="red"):
    stream = io.BytesIO()
    image = Image.new("RGB", (160, 96), color)
    ImageDraw.Draw(image).rectangle((0, 0, 12, 95), fill="blue")
    image.save(stream, "PNG")
    return stream.getvalue()


def write_zip(path, members):
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, contents in members.items():
            archive.writestr(name, contents)


def write_rar(path, name, data):
    """A stored RAR 4 file, generated from the published archive header layout."""
    def block(header):
        return struct.pack("<H", zlib.crc32(header) & 0xFFFF) + header

    filename = name.encode()
    main = block(struct.pack("<BHHHI", 0x73, 0, 13, 0, 0))
    file = block(struct.pack("<BHHIIBIIBBHI", 0x74, 0x8000, 32 + len(filename),
                             len(data), len(data), 3, zlib.crc32(data), 0,
                             20, 0x30, len(filename), 0o100644) + filename)
    end = block(struct.pack("<BHH", 0x7B, 0, 7))
    path.write_bytes(b"Rar!\x1a\x07\x00" + main + file + data + end)


def write_dng(path):
    """Create a genuine 16-bit RGGB Bayer DNG, with DNG color calibration.

    This exercises LibRaw demosaicing, rather than renaming a rendered TIFF.
    The synthetic sensor is 64x48 and intentionally has no embedded preview.
    """
    width, height = 64, 48
    short = lambda *items: struct.pack("<" + "H" * len(items), *items)
    long = lambda *items: struct.pack("<" + "I" * len(items), *items)
    rational = lambda *items: b"".join(struct.pack("<ii", number, divisor) for number, divisor in items)
    tags = {
        256: (4, 1, long(width)), 257: (4, 1, long(height)), 258: (3, 1, short(16)),
        259: (3, 1, short(1)), 262: (3, 1, short(32803)),
        271: (2, 16, b"OpenCloud Extra\x00\x00"), 272: (2, 12, b"Test Sensor\x00"),
        273: (4, 1, long(0)), 277: (3, 1, short(1)), 278: (4, 1, long(height)),
        279: (4, 1, long(width * height * 2)), 284: (3, 1, short(1)),
        33421: (3, 2, short(2, 2)), 33422: (1, 4, b"\x00\x01\x01\x02"),
        50706: (1, 4, b"\x01\x04\x00\x00"), 50707: (1, 4, b"\x01\x01\x00\x00"),
        50708: (2, 18, b"Extra Test Sensor\x00"), 50714: (4, 1, long(0)),
        50717: (4, 1, long(65535)),
        50721: (10, 9, rational(*[(1 if row == col else 0, 1) for row in range(3) for col in range(3)])),
        50728: (5, 3, rational((1, 1), (1, 1), (1, 1))), 50778: (3, 1, short(21)),
    }
    data_offset = 8 + 2 + 12 * len(tags) + 4
    extra = bytearray()
    entries = []
    for tag, (kind, count, value) in sorted(tags.items()):
        if len(value) > 4:
            offset = data_offset + len(extra)
            extra += value
            if len(extra) % 2:
                extra += b"\x00"
            value = long(offset)
        entries.append((tag, kind, count, value.ljust(4, b"\x00")))
    sensor_offset = data_offset + len(extra)
    directory = b"".join(struct.pack("<HHI", tag, kind, count) + (long(sensor_offset) if tag == 273 else value)
                         for tag, kind, count, value in entries)
    sensor = b"".join(short(50000 if x % 2 == 0 and y % 2 == 0 else 8000 if x % 2 and y % 2 else 18000)
                      for y in range(height) for x in range(width))
    path.write_bytes(b"II\x2a\x00" + long(8) + short(len(tags)) + directory + long(0) + extra + sensor)


def write_font(path, cff=False):
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.t2CharStringPen import T2CharStringPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    builder = FontBuilder(1000, isTTF=not cff)
    chars = {code: "glyph" + str(code) for code in range(32, 127)}
    names = [".notdef", *chars.values()]
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap(chars)
    glyphs = {}
    for name in names:
        pen = T2CharStringPen(600, None) if cff else TTGlyphPen(None)
        if name != "glyph32":
            pen.moveTo((80, 0))
            pen.lineTo((300, 700))
            pen.lineTo((520, 0))
            pen.lineTo((380, 0))
            pen.lineTo((300, 350))
            pen.lineTo((220, 0))
            pen.closePath()
        glyphs[name] = pen.getCharString() if cff else pen.glyph()
    if cff:
        builder.setupCFF("ExtraSpecimen-Regular", {"FullName": "Extra Specimen", "FamilyName": "Extra Specimen", "Weight": "Regular"}, glyphs, {})
    else:
        builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({name: (600, 0) for name in names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Extra Specimen", "styleName": "Regular", "uniqueFontIdentifier": "ExtraSpecimen-Regular",
                           "fullName": "Extra Specimen", "psName": "ExtraSpecimen-Regular", "version": "Version 1.0"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    builder.save(path)


def write_xcf(path):
    """One RGBA layer and one RLE-compressed tile (GIMP XCF version 0).

    Layout reference: https://developer.gimp.org/core/standards/xcf/
    """
    word = lambda *values: struct.pack(">" + "I" * len(values), *values)
    blob = bytearray(b"gimp xcf file\x00" + word(32, 24, 0))
    blob += word(17, 1) + b"\x01" + word(0, 0)  # RLE tile compression.
    layer_pointer = len(blob)
    blob += word(0, 0, 0)  # Layer pointer, end layers, end channels.
    blob[layer_pointer:layer_pointer + 4] = word(len(blob))
    blob += word(32, 24, 1, 6) + b"Layer\x00"
    blob += word(6, 4, 255, 8, 4, 1, 7, 4, 0, 15, 8, 0, 0, 0, 0)
    hierarchy_pointer = len(blob)
    blob += word(0, 0)
    blob[hierarchy_pointer:hierarchy_pointer + 4] = word(len(blob))
    blob += word(32, 24, 4, len(blob) + 20, 0)
    blob += word(32, 24, len(blob) + 16, 0)
    blob += b"".join(b"\x7f\x03\x00" + bytes([value]) for value in (255, 0, 0, 255))
    path.write_bytes(blob)


class RendererTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="extra-test-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def require(self, *programs):
        missing = [name for name in programs if not shutil.which(name)]
        if missing:
            message = "required converter missing: " + ", ".join(missing)
            if os.environ.get("OPENCLOUD_EXTRA_REQUIRE_CONVERTERS") == "1":
                self.fail(message)
            self.skipTest(message)

    def render(self, source, kind, success=True, size=256):
        destination = self.root / (source.name + ".png")
        result = subprocess.run([sys.executable, SCRIPT, "--kind", kind, "--input", source,
                                 "--output", destination, "--size", str(size)],
                                capture_output=True, timeout=90)
        if not success:
            self.assertNotEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
            self.assertFalse(destination.exists())
            return result.stderr.decode(errors="replace")
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        with Image.open(destination) as image:
            self.assertEqual(image.format, "PNG")
            self.assertGreater(min(image.size), 0)
            self.assertLessEqual(max(image.size), size)
            self.assertIn(image.mode, {"RGB", "RGBA"})
            return image.copy()

    def test_text_formats(self):
        for extension, kind in ((".md", "text"), (".ts", "video"), (".csv", "text"), (".json", "text")):
            with self.subTest(extension=extension):
                source = self.root / ("example" + extension)
                source.write_text("const message = 'OpenCloud Extra';\nprint(message)\n")
                image = self.render(source, kind)
                self.assertTrue(any(low != high for low, high in image.getextrema()))

    def test_binary_text_fails(self):
        source = self.root / "example.txt"
        source.write_bytes(b"bad\x00binary\x01\x02")
        self.assertIn("binary", self.render(source, "text", success=False))

    def test_converter_deadline_is_enforced(self):
        source = self.root / "source.txt"
        source.write_text("hello")
        renderer = thumbnailer.Renderer(source, self.root / "result.png", 256, self.root)
        renderer.deadline = time.monotonic() + 0.1
        with self.assertRaisesRegex(thumbnailer.RenderError, "deadline"):
            renderer.run([sys.executable, "-c", "import time; time.sleep(10)"])

    def test_malformed_font_fails_without_a_traceback(self):
        source = self.root / "broken.woff2"
        source.write_bytes(b"not a font")
        error = self.render(source, "font", success=False)
        self.assertIn("thumbnail unavailable", error)
        self.assertNotIn("Traceback", error)

    def test_existing_output_is_preserved(self):
        source = self.root / "example.txt"
        source.write_text("Hello")
        destination = self.root / "existing.png"
        destination.write_bytes(b"keep this file")
        result = subprocess.run([sys.executable, SCRIPT, "--kind", "text", "--input", source, "--output", destination], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(destination.read_bytes(), b"keep this file")

    def test_size_limit_rejection(self):
        source = self.root / "oversized.txt"
        with source.open("wb") as stream:
            stream.truncate(thumbnailer.MAX_INPUT + 1)
        self.assertIn("bounded", self.render(source, "text", success=False))
        source.write_text("hello")
        self.assertIn("size", self.render(source, "text", success=False, size=2000))

    def test_svg_formats(self):
        self.require("vips")
        drawing = b'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" fill="red"/></svg>'
        for extension in (".svg", ".svgz"):
            source = self.root / ("drawing" + extension)
            source.write_bytes(gzip.compress(drawing) if extension == ".svgz" else drawing)
            image = self.render(source, "svg")
            self.assertGreater(image.getpixel((image.width // 2, image.height // 2))[0], 240)
        source = self.root / "embedded.svg"
        encoded = base64.b64encode(image_bytes()).decode()
        source.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><image width="160" height="96" href="data:image/png;base64,{encoded}"/></svg>')
        image = self.render(source, "svg")
        self.assertGreater(image.convert("RGB").getpixel((80, 40))[0], 240)

    def test_svg_rejects_unsafe_resources(self):
        documents = [
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/style";</style></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://example.com/a.svg)"/></svg>',
            '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>',
        ]
        for index, contents in enumerate(documents):
            source = self.root / f"unsafe{index}.svg"
            source.write_text(contents)
            self.render(source, "svg", success=False)
        with self.assertRaises(thumbnailer.RenderError):
            thumbnailer.xml_document(documents[-1].encode("utf-16"))

    def test_document_previews(self):
        self.require("pdftoppm")
        for extension, kind in ((".pdf", "pdf"), (".ai", "illustrator")):
            source = self.root / ("drawing" + extension)
            Image.new("RGB", (160, 96), "red").save(source, "PDF")
            image = self.render(source, kind)
            red, green, blue = image.convert("RGB").getpixel((30, 30))
            self.assertGreater(red, 200)
            self.assertLess(green + blue, 100)
        source = self.root / "postscript.ai"
        source.write_bytes(b"%!PS-Adobe-3.0 EPSF-3.0\nshowpage")
        self.assertIn("PDF-compatible", self.render(source, "illustrator", success=False))

    def test_raster_formats(self):
        self.require("magick")
        original = self.root / "original.png"
        original.write_bytes(image_bytes())
        for extension in (".heic", ".heif", ".avif", ".jxl", ".jp2", ".j2k", ".exr", ".hdr", ".tga", ".ico", ".psd", ".psb"):
            with self.subTest(extension=extension):
                source = self.root / ("drawing" + extension)
                command(["magick", original, source])
                image = self.render(source, "photoshop" if extension in {".psd", ".psb"} else "image")
                pixel = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
                self.assertGreater(pixel[0], pixel[1] + 80)

    def test_raster_rejects_svg_disguised_as_image(self):
        self.require("magick")
        source = self.root / "disguised.tga"
        source.write_text('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>')
        self.render(source, "image", success=False)

    def test_gimp_xcf(self):
        self.require("magick")
        source = self.root / "drawing.xcf"
        write_xcf(source)
        image = self.render(source, "image")
        self.assertEqual(image.convert("RGB").getpixel((16, 12)), (255, 0, 0))

    def test_font_formats(self):
        from fontTools.ttLib import TTFont, TTCollection

        ttf = self.root / "specimen.ttf"
        otf = self.root / "specimen.otf"
        write_font(ttf)
        write_font(otf, cff=True)
        for flavor in ("woff", "woff2"):
            with TTFont(ttf) as font:
                font.flavor = flavor
                font.save(self.root / ("specimen." + flavor))
        for extension, member in ((".ttc", ttf), (".otc", otf)):
            collection = TTCollection()
            collection.fonts = [TTFont(member)]
            collection.save(self.root / ("specimen" + extension))
            collection.close()
        for extension in (".ttf", ".otf", ".ttc", ".otc", ".woff", ".woff2"):
            with self.subTest(extension=extension):
                image = self.render(self.root / ("specimen" + extension), "font")
                self.assertTrue(any(low != high for low, high in image.getextrema()))

    def test_video_formats(self):
        self.require("ffmpeg", "ffprobe")
        formats = {
            ".mp4": ("libx265", "mp4"), ".mov": ("libx265", "mov"), ".mkv": ("libx265", "matroska"),
            ".m4v": ("libx264", "mp4"), ".webm": ("libvpx-vp9", "webm"), ".avi": ("mpeg4", "avi"),
            ".mpg": ("mpeg2video", "mpeg"), ".mpeg": ("mpeg2video", "mpeg"),
            ".mts": ("mpeg2video", "mpegts"), ".m2ts": ("mpeg2video", "mpegts"), ".ts": ("mpeg2video", "mpegts"),
            ".3gp": ("mpeg4", "3gp"), ".flv": ("flv", "flv"), ".wmv": ("wmv2", "asf"),
            ".hevc": ("libx265", "hevc"), ".h265": ("libx265", "hevc"),
        }
        for extension, (codec, container) in formats.items():
            with self.subTest(extension=extension):
                source = self.root / ("clip" + extension)
                parameters = ["-x265-params", "pools=1:frame-threads=1:log-level=error"] if codec == "libx265" else []
                command(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                         "color=c=red:s=160x120:r=25:d=0.4", "-an", "-c:v", codec, "-threads", "1",
                         *parameters, "-pix_fmt", "yuv420p", "-f", container, source])
                image = self.render(source, "video")
                red, green, blue = image.convert("RGB").getpixel((30, 30))
                self.assertGreater(red, 200)
                self.assertLess(green + blue, 100)

    def test_audio_previews(self):
        self.require("ffmpeg", "ffprobe")
        original = self.root / "tone.wav"
        with wave.open(str(original), "wb") as audio:
            audio.setparams((1, 2, 22050, 0, "NONE", "not compressed"))
            audio.writeframes(b"".join(struct.pack("<h", int(16000 * math.sin(index * 2 * math.pi * 440 / 22050))) for index in range(11025)))
        for extension, codec in ((".mp3", "libmp3lame"), (".flac", "flac"), (".ogg", "libvorbis"),
                                 (".m4a", "aac"), (".opus", "libopus"), (".aiff", "pcm_s16be"), (".wav", None)):
            with self.subTest(extension=extension):
                source = self.root / ("audio" + extension)
                if codec:
                    command(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", original, "-c:a", codec, source])
                else:
                    shutil.copyfile(original, source)
                image = self.render(source, "audio")
                self.assertGreater(image.width, image.height)
                self.assertTrue(any(low != high for low, high in image.getextrema()))
        cover = self.root / "cover.png"
        cover.write_bytes(image_bytes())
        attached = self.root / "attached.mp3"
        command(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", original, "-i", cover,
                 "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "png", "-disposition:v", "attached_pic", attached])
        image = self.render(attached, "audio")
        self.assertGreater(image.convert("RGB").getpixel((image.width // 2, image.height // 2))[0], 240)

    def test_archive_previews(self):
        self.require("magick", "bsdtar")
        for extension, member in ((".kra", "mergedimage.png"), (".ora", "mergedimage.png"),
                                  (".sketch", "previews/preview.png"), (".cbz", "pages/2.png")):
            source = self.root / ("archive" + extension)
            write_zip(source, {member: image_bytes(), "pages/10.png": image_bytes("green")})
            image = self.render(source, "archive")
            self.assertGreater(image.convert("RGB").getpixel((60, 30))[0], 240)
        source = self.root / "comic.cbr"
        write_rar(source, "cover.png", image_bytes())
        image = self.render(source, "archive")
        self.assertGreater(image.convert("RGB").getpixel((60, 30))[0], 240)

    def test_epub_cover_from_metadata(self):
        self.require("magick")
        source = self.root / "book.epub"
        write_zip(source, {
            "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
            "OPS/book.opf": '<package><manifest><item id="art" href="../images/cover.png" media-type="image/png" properties="cover-image"/></manifest></package>',
            "images/cover.png": image_bytes(),
            "000.png": image_bytes("green"),
        })
        image = self.render(source, "epub")
        self.assertGreater(image.convert("RGB").getpixel((60, 30))[0], 240)

    def test_unsafe_archive_rejection(self):
        source = self.root / "unsafe.cbz"
        write_zip(source, {"../escape.png": image_bytes()})
        self.assertIn("unsafe", self.render(source, "archive", success=False))
        with zipfile.ZipFile(source, "w") as archive:
            info = zipfile.ZipInfo("cover.png")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "/etc/passwd")
        self.assertIn("symbolic", self.render(source, "archive", success=False))
        write_zip(source, {"cover.png": image_bytes()})
        with thumbnailer.SafeZip(source) as archive:
            with self.assertRaises(thumbnailer.RenderError):
                archive.read("cover.png", limit=8)
        source.write_bytes(b"not a zip")
        self.render(source, "archive", success=False)

    def test_raw_dng_demosaicing(self):
        self.require("simple_dcraw", "dcraw_emu", "raw-identify", "magick")
        source = self.root / "sensor.dng"
        write_dng(source)
        image = self.render(source, "raw")
        self.assertGreaterEqual(image.width, 16)
        self.assertGreater(image.convert("RGB").getpixel((image.width // 2, image.height // 2))[0], 40)

    def test_office_formats(self):
        self.require("soffice", "pdftoppm")
        originals = self.root / "originals"
        originals.mkdir()
        writer = originals / "document.rtf"
        writer.write_text(r"{\rtf1\ansi\b OpenCloud Extra\b0\par Office thumbnail fixture.}")
        calc = originals / "sheet.fods"
        calc.write_text('''<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell office:value-type="string"><text:p>OpenCloud Extra</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>''')
        slides = originals / "slides.fodp"
        slides.write_text('''<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation><draw:page draw:name="Page1"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="15cm" svg:height="5cm"><draw:text-box><text:p>OpenCloud Extra</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>''')
        targets = [(writer, "doc:MS Word 97"), (writer, "docx"), (writer, "odt"),
                   (calc, "xls:MS Excel 97"), (calc, "xlsx"), (calc, "ods"),
                   (slides, "ppt:MS PowerPoint 97"), (slides, "pptx"), (slides, "odp")]
        for original, target in targets:
            with self.subTest(format=target):
                profile = self.root / "fixture-office-profile"
                command(["soffice", "-env:UserInstallation=" + profile.as_uri(), "--headless", "--convert-to", target,
                         "--outdir", self.root, original])
                source = self.root / (original.stem + "." + target.split(":")[0])
                self.assertTrue(source.is_file(), f"LibreOffice failed to generate {target}")
                image = self.render(source, "office")
                self.assertTrue(any(low != high for low, high in image.getextrema()))
        image = self.render(writer, "office")
        self.assertTrue(any(low != high for low, high in image.getextrema()))

    def test_office_rejects_external_resources_before_conversion(self):
        source = self.root / "unsafe.docx"
        write_zip(source, {"word/_rels/document.xml.rels": '<Relationships><Relationship TargetMode="External" Type="image" Target="file:///etc/passwd"/></Relationships>'})
        self.assertIn("external", self.render(source, "office", success=False))
        source = self.root / "unsafe.rtf"
        source.write_text(r'{\rtf1 {\field{\*\fldinst INCLUDETEXT "file:///etc/passwd"}}}')
        self.render(source, "office", success=False)


if __name__ == "__main__":
    unittest.main()
