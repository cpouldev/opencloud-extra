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

Gate 0 is off: this change includes user-visible logic. Gate 3 is off: there is
no new UI. Gates 4 and 6 are deliberately excluded as described above.

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
  artifact: Bundled extra preview app and 2048-pixel rendering
  rationale: Clicking an extra file now crosses the web app, authenticated preview API, converter and image display boundaries.
  criticality: MEDIUM-HIGH
  selected_types:
    - rationale: Render-size selection, zoom bounds and loading/error transitions have branching behavior.
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
    - rationale: File-handler registration and host SDK loading must be verified by opening actual files in OpenCloud Web.
      type: e2e
      size: large
      framework: Playwright
      dependencies: [Chromium, disposable OpenCloud container]
      gate: Gate 3
    - rationale: The app must be embedded in the image and automatically discovered with an existing data directory.
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

- AC-1: Open AI, PSD and a font from the file list in the extra preview app;
  ordinary JPEG and PDF retain their existing viewers.
- AC-2: Show loading and conversion failure states; support zoom, fit, pan and
  closing back to files without a stale image.
- AC-3: Request a fitted 2048-pixel preview through the existing authenticated
  endpoint; retain denial of anonymous access to private files; open a public
  link in a separate unauthenticated browser context.
- AC-4: Check requested size boundaries around 1024 and 2048; render real output
  larger than 1024; retain small grid dimensions and repeatable cached output.
- AC-5: Discover the embedded application in the built image's web config and
  load its module through the actual Web runtime on both image architectures.

## Quick Look and asset information

```yaml
test_strategy:
  artifact: Keyboard file navigation and source asset metadata
  rationale: Keyboard handling crosses host selection and routes; source metadata crosses authenticated storage and untrusted decoder boundaries.
  criticality: HIGH
  selected_types:
    - rationale: Selection, keyboard guards, formatting, field validation and cache identity contain branching logic.
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
    - rationale: Real host selection, keyboard capture, sorted rows and signed public links cannot be established with component mocks.
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

- Space opens the selected file in table and tile views; Space/Escape closes;
  input fields, dialogs, modified shortcuts and unrelated routes are untouched.
- Previous/next follow displayed order, exclude folders and inaccessible files,
  disable at boundaries and never escape a public share. Shift+arrows still pan.
- Navigating during a pending preview or metadata request cannot display the
  previous file's results; URLs and pending requests are released on close.
- Metadata uses source pixel dimensions or explicitly labeled document points,
  preserves CMYK/profile information, and reports real codec/duration/font data.
- Missing fields remain absent; malformed, oversized and unsafe decoder output
  fails independently of the image preview. No original bytes reach the browser.
- Private metadata stays inaccessible without permission, including after cache
  population; source revision changes invalidate metadata independently of images.
