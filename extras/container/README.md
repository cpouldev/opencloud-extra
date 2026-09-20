# Container build and verification

`Dockerfile.extra` builds the downstream Go source and its pinned upstream web
assets, then installs the renderer in an Alpine 3.24 runtime. It supports native
`linux/amd64` and `linux/arm64` builds. Run from the repository root:

```sh
docker build -f Dockerfile.extra \
  --build-arg VERSION=8.0.1-extra.1 \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  -t opencloud-extra:local .
docker run --rm --network none \
  --entrypoint /usr/local/bin/opencloud-extra-smoke opencloud-extra:local
```

The default `final` stage preserves the official image's user 1000, persistent
directories `/var/lib/opencloud` and `/etc/opencloud`, port 9200, and
`opencloud server` entrypoint. The upstream Dockerfile is unchanged.

The following targets shorten focused checks:

| Target | Purpose |
| --- | --- |
| `runtime-deps` | Converter libraries and executables |
| `runtime` | Converters, renderer, and smoke command; no OpenCloud binary |
| `extra-web` | Bundled preview app build and component tests |
| `build` | Generated assets, embedded preview app and compiled Go binary |
| `go-test` | Thumbnail, Graph/WebDAV service, and libvips thumbnail tests |
| `final` | Deployable OpenCloud Extra image |

```sh
docker build -f Dockerfile.extra --target runtime -t opencloud-extra:runtime .
docker run --rm --network none \
  --entrypoint /usr/local/bin/opencloud-extra-smoke \
  opencloud-extra:runtime --runtime-only
docker run --rm --network none -v "$PWD:/src:ro" \
  -e OPENCLOUD_EXTRA_REQUIRE_CONVERTERS=1 --entrypoint python3 \
  opencloud-extra:runtime -m unittest discover -s /src/extras/tests
docker build -f Dockerfile.extra --target go-test .
```

The smoke command runs real HEIC, AVIF, JPEG XL, JPEG 2000, OpenEXR, HDR, TGA,
and ICO conversions and checks the installed video decoders, libvips loaders,
fonts, and ImageMagick policy. The renderer integration suite exercises the other
families. The final image smoke also boots a disposable OpenCloud instance and
checks its status endpoint and web assets. Both commands run without a network
and as the image's service user.

The authenticated preview smoke also checks real 2048-pixel AI, PSD, SVG and font
previews, repeat requests, and denial of anonymous access to private previews:

```sh
docker run --rm --network none -v "$PWD:/src:ro" \
  --entrypoint python3 opencloud-extra:local /src/extras/container/preview-smoke.py
```

The browser suite starts a disposable, seeded server on `127.0.0.1:9200`, signs
in through OpenCloud's login page, and opens actual files. It checks full
previews, zoom/pan/fit, loading and error states, and existing JPEG/PDF viewers.
The server and its temporary data are removed afterward. Port 9200 must be free.

```sh
cd extras/browser
npm ci
npx playwright install --with-deps chromium
OPENCLOUD_EXTRA_TEST_IMAGE=opencloud-extra:local npm test
```

On a development Mac with Google Chrome installed, set
`OPENCLOUD_EXTRA_BROWSER_CHANNEL=chrome` to use it. CI installs the pinned
Playwright Chromium build and runs the suite against both native image builds.

## Runtime packages

Dependencies come from Alpine's main and community repositories for the same
stable distribution as upstream. In particular, codec plugins are explicit:

| Capability | Packages |
| --- | --- |
| Video and audio | `ffmpeg` with HEVC, H.264, AV1, VP8/9 and audio decoders |
| Raster images | `vips`, `vips-tools`, `vips-heif`, `vips-jxl`, `vips-magick` |
| HEIC/AVIF codecs | `libheif-libde265`, `libheif-dav1d`; `libheif-x265`, `libheif-aom` also supply smoke fixture encoders |
| PSD, PSB, XCF, image fallbacks | `imagemagick` and HEIC, JPEG, JP2, JXL, OpenEXR, RAW, SVG, TIFF and WebP modules |
| PDF and Illustrator | `poppler-utils`, `vips-poppler` |
| Office documents | `libreoffice-writer`, `libreoffice-calc`, `libreoffice-impress`, `libreoffice-draw` |
| Camera RAW | `libraw-tools` (`simple_dcraw`, `dcraw_emu`) |
| RAR comics | `libarchive-tools` (`bsdtar`) |
| Font specimens, text and archive previews | `python3`, `py3-pillow`, `py3-fonttools`, `py3-brotli` |
| Font fallbacks | `font-dejavu`, `font-noto`, `font-liberation`, `font-carlito` |

LibreOffice and its import filters account for much of the approximately 1.1 GiB
installed dependency footprint. The application license is installed at
`/usr/share/licenses/opencloud-extra/LICENSE`.
Review the [Alpine package index](https://pkgs.alpinelinux.org/packages?branch=v3.24)
when updating the base distribution or changing converter packages.

The image defaults to two concurrent thumbnail requests, a 1 GB source-file
limit, and a 90-second renderer deadline. ImageMagick has bounded memory, disk,
image dimensions, thread count, and execution time. Its delegates and filters
are disabled, and only the required raster coders are enabled. PDF, SVG, RAW and
Office conversion use their dedicated tools. The renderer adds process resource
limits and per-format validation; the container itself can also be deployed with
the operator's memory and CPU limits.
