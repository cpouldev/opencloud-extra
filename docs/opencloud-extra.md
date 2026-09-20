# OpenCloud Extra

OpenCloud Extra adds thumbnail providers to OpenCloud and publishes a complete
Docker image at `docker.io/cpoul/opencloud-extra`. The Go module path remains
unchanged so the downstream changes can be merged with upstream releases.

## Installation

Use `cpoul/opencloud-extra:stable` as the image in your existing OpenCloud deployment.
Keep the same configuration, data volumes, identity provider, and proxy setup.
Follow the upstream upgrade instructions when changing the underlying OpenCloud
version. Publishing an image does not automatically upgrade running servers.

For reproducible deployments, pin a version such as `8.0.1-extra.1` or an image
digest. `stable` and `latest` identify the most recently validated downstream
release. Both Linux amd64 and arm64 are published under the same tag.

The image includes LibreOffice and media libraries, so it is larger than the
standard OpenCloud image. It runs with the upstream user ID 1000 and uses
`/var/lib/opencloud` and `/etc/opencloud` for persistent data and configuration.

## Thumbnail formats

| Category | Extensions | Preview |
| --- | --- | --- |
| Video | mp4, m4v, mov, mkv, webm, avi, mpg, mpeg, mts, m2ts, ts, 3gp, flv, wmv, hevc, h265 | Representative frame; H.264, HEVC, VP8/VP9 and AV1 depend on the contained stream |
| Modern and additional images | heic, heif, avif, jxl, jp2, j2k, exr, hdr, tga, ico | Rendered image, with a displayable HDR preview |
| Photoshop | psd, psb | Saved composite |
| Illustrator | ai | First page of PDF-compatible content |
| PDF and vectors | pdf, svg, svgz | First page or artwork |
| Fonts | ttf, otf, ttc, otc, woff, woff2 | Font name and specimen; first face of a collection |
| Camera RAW | dng, cr2, cr3, nef, arw, raf, orf, rw2 | Embedded preview or LibRaw decoding |
| Office documents | doc, docx, odt, rtf, ppt, pptx, odp, xls, xlsx, ods | First rendered page, slide or sheet |
| Creative files | kra, ora, xcf, sketch | Embedded preview where available, or rendered XCF layers |
| Audio | mp3, flac, ogg, m4a, opus, wav, aiff | Embedded cover, with waveform fallback |
| Books and comics | epub, cbz, cbr | Cover or first image |
| Text and source | md, csv, json, yaml, yml, xml, log, go, py, js, jsx, ts, tsx, css, html, htm, sh, c, h, cpp, hpp, java, rs, rb, php, sql, toml, ini | Text excerpt; HTML is displayed as source |

Existing JPEG, PNG, GIF, BMP, TIFF, WebP, plain-text and GeoGebra support remains.
The [format manifest](../services/thumbnails/pkg/extra/formats.json) is used by the
backend to select extra providers. File names disambiguate types that storage
reports as generic binary files. Graph and WebDAV advertise those previews.

The vendored Reva `ocdav/propfind` handler has one downstream adaptation to call
the same filename-aware capability check. Preserve this change when regenerating
`vendor`; the authenticated preview smoke test catches its loss.

These extensions identify providers, not a promise that every file variant is
renderable. Encrypted, corrupt, oversized, or unsupported contents return no
preview. HEVC thumbnails do not enable HEVC playback in a browser. RAW support
depends on the camera model supported by the included LibRaw release. Fonts
without the sample glyphs use available glyphs. Complex Office layouts can differ
from Microsoft Office, particularly when original fonts are unavailable.

Save Illustrator files with **Create PDF Compatible File** enabled and Photoshop
files with **Maximize PSD and PSB File Compatibility** enabled. Native Illustrator
data without a PDF representation is not rendered. Creative archive files need
an embedded preview. PostScript/EPS and 3D files are deliberately excluded.
XCF rendering covers compatible 8-bit RGB/RGBA files; newer compression, high-bit
depth, indexed-color, and live-filter variants may not render with ImageMagick.

## Opening full previews

OpenCloud's native **Preview** gallery opens Illustrator, Photoshop, fonts, RAW,
additional image formats, creative files and comics alongside ordinary images.
It uses the existing thumbnail strip and bottom controls for navigation, zoom,
pan, rotation, reset and fullscreen. Extra formats load cached rendered images
of up to 2048 pixels through the authenticated preview service, without sending
their original file bytes to the browser. Smaller embedded previews retain their
available detail. Failed conversions show an explanation and a retry button.

Native audio/video playback remains available, subject to browser codec support.
PDF clicks retain the PDF viewer, EPUB retains its reader, and Office files use
a configured editor when available. **Quick Look** can show their first page,
slide or cover in the gallery. Extra media formats outside the native player's
supported MIME types can show a rendered frame or artwork through Quick Look.
Rendered previews do not edit Illustrator artwork or Photoshop layers. Existing
format requirements and size limits still apply.

The native gallery integration is included automatically in the image, including
deployments with existing data volumes. Recreate the OpenCloud containers with
the updated image and reload the web page. There is no need to re-upload files
or generate previews manually. Grid thumbnails and full previews are generated
on demand and cached separately.

### Quick Look and file information

In a folder's table or tile view, select one supported file and press **Space**
to open the native gallery. **Left/Right**, the previous/next buttons and the
thumbnail strip browse its files in the gallery's normal order. Navigation wraps
within that folder or public share. Single-file shares show only the shared file.
**Space** closes the gallery when its stage has focus; **Escape** and the native
top-bar close button also return to the previous view. Inputs, buttons and native
media controls keep their usual keyboard behavior. Search views retain their
existing keyboard behavior. The context menu also offers **Quick Look**.

The **Asset information** icon in the existing bottom toolbar opens the native
**Details** sidebar. Source properties appear beside OpenCloud's normal file
details and follow the current file while navigating:

- OpenCloud's existing file details, including size and modification time.
- Original raster/RAW dimensions, available color space, embedded ICC profile
  name and bit depth. These are source properties, not thumbnail dimensions.
- PDF-compatible Illustrator/PDF page count and first-page dimensions in points;
  SVG absolute viewport dimensions are also shown in points.
- Video/audio codecs, duration, frame dimensions/rate, sample rate and channels.
- Font family, style, full name, version, glyph count, collection face count and
  variable-font status; details describe the first face of a collection.

The ordinary top-bar details toggle opens the same sidebar. On narrow screens,
it uses OpenCloud's existing bottom drawer. Unavailable properties are omitted.
Office, text, archive and book files retain
basic file information without a separate source scan. Relative SVG dimensions
and a viewBox alone do not establish a physical page size. Source information is
cached by file identity and revision and uses the same download permissions and
public-link checks as previews. Metadata extraction never downloads the original
to the browser.

## Configuration and limits

| Variable | Image default | Purpose |
| --- | --- | --- |
| `THUMBNAILS_EXTRA_RENDERER` | `/usr/local/bin/opencloud-extra-thumbnail` | Converter executable |
| `THUMBNAILS_EXTRA_TIMEOUT` | `90s` | Deadline for streaming an extra source and converting it |
| `THUMBNAILS_MAX_INPUT_IMAGE_FILE_SIZE` | `1GB` | Maximum source size, including videos and documents |
| `THUMBNAILS_MAX_CONCURRENT_REQUESTS` | `2` | Concurrent thumbnail request limit |
| `THUMBNAILS_MAX_INPUT_WIDTH` / `THUMBNAILS_MAX_INPUT_HEIGHT` | Upstream defaults | Existing image decoder limits |

Extra providers use a 1024-pixel intermediate PNG for grid requests and up to
2048 pixels for larger preview requests. The existing thumbnail service then
applies the requested output size and caches the result. Higher requested
resolutions cannot recover additional detail from that intermediate image.
Files exceeding configured limits receive no preview.

If you override `THUMBNAILS_RESOLUTIONS`, include `2048x2048` before any
`512x2048` entry so fitted portrait previews keep their full resolution. The
extra image's default configuration already does this.

Extra sources are streamed to private temporary directories instead of being
loaded entirely into the Go process. Allow temporary disk space for the configured
input limit times the concurrency limit, plus conversion output. The renderer
adds decoder, archive, process-memory, and output bounds. Child processes do not
inherit OpenCloud credentials, and the whole process group is terminated on
timeout. Preview requests retain OpenCloud's download-permission checks.

## Automatic releases

The default branch must be `extra/stable` for scheduled workflows to run. The
**OpenCloud Extra stable release** workflow runs daily at 05:23 UTC, on changes to
that branch, and on manual dispatch. It reads published upstream releases,
excludes drafts/prereleases, and chooses the highest semantic version without
downgrading the tracked version.

1. Prepare a merge of the upstream release into the current downstream branch.
2. Test the candidate and build images on native amd64 and arm64 runners.
3. Exercise actual converters and the OpenCloud binary in the built images.
4. Advance the branch only if its starting commit has not changed, and reserve
   an immutable `<upstream-version>-extra.N` tag.
5. Publish those tested images, update `stable`/`latest`, and create a release in
   this fork.

Failures keep the previously published stable image available and create a
diagnostic issue in this fork. A failed publication can be retried using the same
reserved tag. Merge conflicts require a maintainer to preserve the downstream
changes and resolve them on `extra/stable`; automation never discards extras.
Use manual `force_release` to rebuild an unchanged release with updated container
dependencies under a new `extra.N` version.

### Credentials and repository boundary

Configure the Actions secret `DOCKERHUB_TOKEN` with permission to publish
`cpoul/opencloud-extra`; the Docker Hub username is fixed to `cpoul`.
GitHub operations use the fork's `GITHUB_TOKEN` with per-job permissions.
Enable Issues on the fork so failure diagnostics have a destination.

All mutations explicitly target `cpouldev/opencloud-extra`. Guards check the
repository, branch, and origin push URL. The upstream URL is used only for reads.
No workflow creates an upstream pull request or pushes to upstream. GitHub CLI
commands used manually should also specify `--repo cpouldev/opencloud-extra`.

GitHub's built-in token cannot update workflow files. If an upstream release
changes workflows and GitHub refuses the push, resolve that merge manually in
the fork using an appropriately authorized maintainer account. The failure is
reported without attempting a broader credential or upstream write.

## Building and testing

```sh
docker build -f Dockerfile.extra -t opencloud-extra:local .
docker run --rm --network none --entrypoint opencloud-extra-smoke opencloud-extra:local
```

`Dockerfile.extra` has `runtime` and `go-test` targets for converter and Go
integration checks. See [container checks](../extras/container/README.md) and
[test strategy](../extras/TESTING.md). Plain upstream builds do not install the
external renderer or its dependencies; use the extra Dockerfile for this distribution.
