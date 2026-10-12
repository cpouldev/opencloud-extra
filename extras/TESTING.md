# OpenCloud Extra validation

Every release validates the exact candidate source and publishes its already
tested image archives. Existing thumbnail, Graph and WebDAV package tests run
alongside the new checks, including the libvips build.

```yaml
test_strategy:
  artifact: OpenCloud Extra providers and release automation
  rationale: User-controlled files cross decoder and subprocess boundaries; releases write only to the downstream repositories.
  criticality: HIGH
  selected_types:
    - rationale: Routing, bounds, repository guards and release state transitions contain branching logic.
      type: unit
      size: small
      framework: go test and Python unittest
      dependencies: []
      gate: Gate 1
    - rationale: Actual decoders, subprocess cancellation, archives and Git state cannot be validated by mocks alone.
      type: integration
      size: medium
      framework: go test and Python unittest
      dependencies: [temporary files, temporary Git repositories, container converter tools]
      gate: Gate 2
    - rationale: Deployment must contain working codecs, generated web assets and an executable OpenCloud server.
      type: smoke
      size: large
      framework: container smoke scripts
      dependencies: [built Docker image]
      gate: Gate 5
  rejected_types:
    - reason: No new independently deployed API contract; the existing thumbnail endpoints are retained.
      type: contract
    - reason: No new UI component; endpoint and conversion integration tests cover the changed behavior.
      type: component
    - reason: Existing endpoints can be exercised directly without introducing browser automation for this backend change.
      type: e2e
  deliberately_skipped:
    - why: Explicit boundary and malformed-input cases cover the selected interfaces; broad decoder fuzzing belongs to their upstream projects.
      what: A new property-testing framework for native codecs (Gate 6 considered)
    - why: Vendor camera encodings and proprietary application variants are not all reproducible from generated fixtures.
      what: Exhaustive coverage of every camera model and every proprietary file version
```

For the provider and release-automation scope, Gate 0 is off because it includes
user-visible logic and Gate 3 is off because it has no UI. Gates 4 and 6 are
deliberately excluded as described above. Web validation is covered below.

## Cases covered

- Extension-aware routing: generic binary fonts/RAW, AI reported as PostScript,
  TypeScript versus MPEG transport streams, and excluded formats.
- Input sizes below, at, and above the byte limit.
- Output dimensions below, at, and above the preview bound; invalid PNG and
  symlink output rejection.
- Renderer failures, download cancellation, process-tree timeout and temporary
  file cleanup; no server credentials in converter environments.
- Graph metadata for normal files and shares, including filenames with generic
  MIME types.
- Real conversions across the media, document, font and embedded-preview paths;
  malformed inputs and archive bounds.
- Release decisions, guarded repository targets, immutable tags, retry behavior,
  and a branch changing while validation is running.
- Container codec availability, actual additional-image conversions, and
  OpenCloud startup with disposable configuration.
- Authenticated live uploads of SVG, PSD, AI, WOFF2 and HEVC MP4, decoded thumbnail
  output, WebDAV/Graph preview metadata, and denial of anonymous thumbnail access.

Generated fixtures keep tests small and deterministic. Tests must assert actual
decoded output and failures, rather than merely checking that an executable or
file extension is listed.

## Full preview viewer

```yaml
test_strategy:
  artifact: Native gallery extra formats and 2048-pixel rendering
  rationale: Clicking an extra file crosses the native gallery, authenticated preview API, converter and image display boundaries.
  criticality: MEDIUM-HIGH
  selected_types:
    - rationale: Render-size selection, native controls and loading/error transitions have branching behavior.
      type: unit
      size: small
      framework: go test, Python unittest and web app tests
      dependencies: [temporary files]
      gate: Gate 1
    - rationale: Larger real previews must preserve aspect ratio, permission checks and cache separation from grid thumbnails.
      type: integration
      size: medium
      framework: authenticated preview smoke
      dependencies: [built Docker image, converter tools]
      gate: Gate 2
    - rationale: Native file-handler registration and gallery integration must be verified by opening actual files in OpenCloud Web.
      type: e2e
      size: large
      framework: Playwright
      dependencies: [Chromium, disposable OpenCloud container]
      gate: Gate 3
    - rationale: The patched native gallery must be embedded in the image and available with an existing data directory.
      type: smoke
      size: large
      framework: container and browser smoke
      dependencies: [built Docker image]
      gate: Gate 5
  rejected_types:
    - reason: The app and API ship in one image; a separate consumer contract framework adds no deployment protection.
      type: contract
    - reason: Explicit file families and sizing boundaries cover the relevant finite cases without a new fuzzing framework.
      type: property-based
  deliberately_skipped:
    - why: Real browser checks cover registration and interactions; declarative extension snapshots do not prove that a file opens.
      what: Snapshots of route and file-handler declarations
    - why: Existing converter tests already cover individual codecs; the viewer needs representative rendered-image families.
      what: Repeating every codec fixture in the browser
```

Gate 0 is off because user-visible behavior changes. Gates 1, 2, 3 and 5 are on.
Gates 4 and 6 are off for the reasons above.

- AC-1: Open AI, PSD and a font from the file list in the native gallery;
  ordinary JPEG uses the same gallery and PDF retains its default viewer.
- AC-2: Show loading and conversion failure states; support native zoom, pan,
  rotation, reset and closing back to files without a stale image.
- AC-3: Request a fitted 2048-pixel preview through the existing authenticated
  endpoint; retain denial of anonymous access to private files; open a public
  link in a separate unauthenticated browser context.
- AC-4: Check requested size boundaries around 1024 and 2048; render real output
  larger than 1024; retain small grid dimensions and repeatable cached output.
- AC-5: Load the patched native gallery through the actual Web runtime on both
  image architectures, without a separate extra-preview application.

## Native file navigation and asset information

```yaml
test_strategy:
  artifact: Native file navigation and source asset metadata
  rationale: File actions cross host routes; source metadata crosses authenticated storage and untrusted decoder boundaries.
  criticality: HIGH
  selected_types:
    - rationale: Fallback eligibility, formatting, field validation and cache identity contain branching logic.
      type: unit
      size: small
      framework: Vitest and go test
      dependencies: [in-memory host doubles]
      gate: Gate 1
    - rationale: Source dimensions, profiles, codecs and font names must come from actual input files; authorization must precede cache access.
      type: integration
      size: medium
      framework: Python unittest and go test
      dependencies: [temporary files, runtime converter tools, local HTTP sources]
      gate: Gate 2
    - rationale: Native Space-key selection, file clicks, sorted rows and signed public links cannot be established with component mocks.
      type: e2e
      size: large
      framework: Playwright
      dependencies: [Chromium, disposable OpenCloud container]
      gate: Gate 3
    - rationale: Both native architecture images must embed the app and metadata helper before publication.
      type: smoke
      size: large
      framework: existing release validation
      dependencies: [built Docker image]
      gate: Gate 5
  rejected_types:
    - reason: Metadata producer and consumer ship together in one image.
      type: contract
    - reason: Explicit schema bounds and state-transition cases cover the new interfaces without another test framework.
      type: property-based
  deliberately_skipped:
    - why: Existing format conversion tests cover codec variants; metadata needs representative source families and malformed inputs.
      what: Repeating every supported file extension in a browser
    - why: Metadata requests are on demand and share existing bounded concurrency; no change to deployment scale is promised.
      what: A new performance or load-test harness
```

- AC-6: Space retains native checkbox selection in table/tile views and public
  folders without opening a preview. Clicking extra files opens the gallery;
  Space leaves it open and Escape closes it.
- AC-7: The fallback Preview action opens eligible Office/EPUB files in personal
  folders and shares. Empty/multiple selections, unavailable files and missing
  space contexts do not navigate. Permission failures remain contained.
- Previous/next follow the native gallery order, exclude folders and inaccessible
  files, and wrap within that folder or public share.
- Navigating during a pending preview or metadata request cannot display the
  previous file's results; URLs and pending requests are released on close.
- Metadata uses source pixel dimensions or explicitly labeled document points,
  preserves CMYK/profile information, and reports real codec/duration/font data.
- Missing fields remain absent; malformed, oversized and unsafe decoder output
  fails independently of the image preview. Metadata extraction and rendered
  extra previews do not send original file bytes to the browser.
- Private metadata stays inaccessible without permission, including after cache
  population; source revision changes invalidate metadata independently of images.

## Native gallery integration

The native gallery replaces the separate rendered viewer. Gates 1, 2, 3 and 5
remain on: filename classification and fallback eligibility need unit tests; native
Web components and Details injection need integration coverage; actual gallery
controls, public links and mobile layouts need browser checks; both native
architecture images gate release. Gate 0 is off because behavior changes. Gate 4
is off because Web and metadata ship together. Gate 6 is off because these
changes concern finite format classes and UI state transitions. Existing decoder
and metadata-schema suites remain the evidence for their unchanged boundaries.

- Extra AI/PSD/font files open in native `preview-media`, with the native photo
  roll and bottom controls; the old custom viewer is absent.
- JPEG uses that same gallery; PDF/Office default editors and media controls keep
  working. Rendered extras never cause original-file downloads in the browser.
- Native zoom, pan, rotation, reset, fullscreen and photo-roll selection work on
  rendered images. Folder order and return context follow native gallery rules.
- Space keeps native file selection and media controls; gallery opening uses
  file actions and closing uses Escape or the native close button.
- Native Details displays source properties for its currently selected file,
  loads on demand and cannot show stale facts after navigation or closure.
- Failed conversions leave native navigation usable and offer useful recovery.
- Private files, password-protected public files/folders and narrow screens use
  the same native interface. Public navigation cannot leave its shared scope.
- Source patch application is pinned and fails on drift; both published images
  contain the modified native Web assets and no separate extra-preview app.
