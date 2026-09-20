"""Source metadata from real bounded decoders, with no network or private files."""

import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

from PIL import Image, ImageCms
from test_thumbnailer import SCRIPT, command, write_dng, write_font


class AssetInfoTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="extra-assetinfo-")
        self.root = Path(temporary.name)
        self.addCleanup(temporary.cleanup)

    def require(self, *names):
        missing = [name for name in names if not shutil.which(name)]
        if missing:
            if os.environ.get("OPENCLOUD_EXTRA_REQUIRE_CONVERTERS") == "1":
                self.fail("missing metadata tool: " + ", ".join(missing))
            self.skipTest("missing metadata tool: " + ", ".join(missing))

    def metadata(self, source, kind, success=True):
        output = self.root / (source.name + ".json")
        result = subprocess.run([sys.executable, SCRIPT, "--kind", kind, "--input", source,
                                 "--output", output, "--metadata"], capture_output=True, timeout=90)
        if not success:
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            return
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        raw = output.read_bytes()
        self.assertLessEqual(len(raw), 16384)
        self.assertNotIn(str(self.root).encode(), raw)
        data = json.loads(raw)
        self.assertEqual(data["schemaVersion"], 1)
        return data

    def test_image_source_dimensions_and_embedded_profile(self):
        self.require("magick")
        source = self.root / "image.png"
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        Image.new("RGB", (2400, 1600), "red").save(source, icc_profile=profile)
        info = self.metadata(source, "image")
        self.assertEqual((info["width"], info["height"]), (2400, 1600))
        self.assertEqual(info["bitDepth"], 8)
        self.assertIn("srgb", info["colorSpace"].lower())
        self.assertIn("srgb", info["colorProfile"].lower())

    def test_cmyk_is_not_reported_as_preview_rgb(self):
        self.require("magick")
        source = self.root / "print.jpg"
        Image.new("CMYK", (321, 234), (15, 80, 10, 20)).save(source)
        info = self.metadata(source, "image")
        self.assertEqual(info["colorSpace"], "CMYK")
        self.assertEqual((info["width"], info["height"]), (321, 234))
        self.assertNotIn("colorProfile", info)

    def test_photoshop_source_dimensions(self):
        self.require("magick")
        original = self.root / "source.png"
        Image.new("RGB", (2300, 1500), "navy").save(original)
        for extension in ("psd", "psb"):
            with self.subTest(extension=extension):
                source = self.root / ("artwork." + extension)
                command(["magick", original, source])
                info = self.metadata(source, "photoshop")
                self.assertEqual((info["width"], info["height"]), (2300, 1500))

    def test_illustrator_page_dimensions_have_point_units(self):
        self.require("pdfinfo")
        source = self.root / "artwork.ai"
        Image.new("RGB", (1200, 800), "red").save(source, "PDF", resolution=144)
        info = self.metadata(source, "illustrator")
        self.assertEqual(info["pages"], 1)
        self.assertEqual((info["pageWidth"], info["pageHeight"]), (600, 400))
        self.assertNotIn("width", info)

    def test_hevc_codec_duration_and_frame_rate(self):
        self.require("ffmpeg", "ffprobe")
        source = self.root / "video.mp4"
        command(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=4",
                 "-t", "1", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
                 "pools=1:frame-threads=1:log-level=error", "-an", source])
        info = self.metadata(source, "video")
        self.assertEqual(info["videoCodec"], "hevc")
        self.assertEqual((info["width"], info["height"]), (160, 96))
        self.assertAlmostEqual(info["duration"], 1, places=2)
        self.assertEqual(info["frameRate"], 4)

    def test_audio_stream_details(self):
        self.require("ffprobe")
        source = self.root / "sound.wav"
        with wave.open(str(source), "wb") as audio:
            audio.setparams((2, 2, 16000, 0, "NONE", "not compressed"))
            audio.writeframes(b"\x00\x00\x01\x00" * 16000)
        info = self.metadata(source, "audio")
        self.assertEqual((info["sampleRate"], info["channels"]), (16000, 2))
        self.assertEqual(info["audioCodec"], "pcm_s16le")
        self.assertEqual(info["duration"], 1)
        self.assertNotIn("width", info)

    def test_font_names_and_glyphs(self):
        from fontTools.ttLib import TTFont

        original = self.root / "typeface.ttf"
        write_font(original)
        source = self.root / "typeface.woff2"
        with TTFont(original) as font:
            font.flavor = "woff2"
            font.save(source)
        info = self.metadata(source, "font")
        self.assertIn("Extra", info["fontFamily"])
        self.assertEqual(info["glyphs"], 96)
        self.assertEqual(info["fontFaces"], 1)
        self.assertFalse(info["fontVariable"])

    def test_svg_absolute_dimensions_and_missing_physical_size(self):
        for number, attributes, expected in (
            (1, 'width="2in" height="25.4mm"', (144, 72)),
            (2, 'width="2400" height="1600"', (1800, 1200)),
            (3, 'viewBox="0 0 2400 1600" width="100%"', None),
        ):
            with self.subTest(attributes=attributes):
                source = self.root / f"vector{number}.svgz"
                source.write_bytes(gzip.compress(f'<svg xmlns="http://www.w3.org/2000/svg" {attributes}/>'.encode()))
                info = self.metadata(source, "svg")
                self.assertNotIn("width", info)
                if expected:
                    self.assertEqual((info["pageWidth"], info["pageHeight"]), expected)
                else:
                    self.assertNotIn("pageWidth", info)
                    self.assertNotIn("pageHeight", info)

    def test_raw_source_dimensions(self):
        self.require("raw-identify")
        source = self.root / "sensor.dng"
        write_dng(source)
        info = self.metadata(source, "raw")
        self.assertEqual((info["width"], info["height"]), (64, 48))

    def test_rejects_malformed_and_entity_inputs(self):
        for name, kind, data in (
            ("invalid.ai", "illustrator", b"not a PDF"),
            ("invalid.png", "image", b"not a PNG"),
            ("invalid.ttf", "font", b"not a font"),
            ("entity.svg", "svg", b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'),
            ("huge.svgz", "svg", gzip.compress(b" " * (8 * 1024 * 1024 + 1))),
        ):
            with self.subTest(name=name):
                source = self.root / name
                source.write_bytes(data)
                self.metadata(source, kind, success=False)

    def test_unavailable_metadata_is_empty_not_invented(self):
        source = self.root / "notes.txt"
        source.write_text("ordinary text")
        self.assertEqual(self.metadata(source, "text"), {"schemaVersion": 1})


if __name__ == "__main__":
    unittest.main()
