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
