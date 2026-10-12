# OpenCloud Extra

OpenCloud Extra is our fork of [OpenCloud](https://github.com/opencloud-eu/opencloud),
built for the creative files, documents and media we use every day. It adds more
thumbnails, previews and useful file details, packaged in a ready-to-run Docker
image.

This fork is **vibe coded**. We run it internally for our own workflows, where it
has been running flawlessly. We build and maintain it around those workflows,
and share it for anyone who finds the same extras useful.

The fork adds:

- **More thumbnails:** Photoshop, PDF-compatible Illustrator files, fonts,
  camera RAW, HEIC/AVIF/JXL and other images, Office documents, creative archives,
  books, audio artwork and source files. Video thumbnails include HEVC.
- **Previews in the native gallery:** open design files, fonts, RAW photos and
  other extra formats using OpenCloud's existing photo roll, navigation, zoom,
  rotation and fullscreen controls. Rendered previews reach up to 2048 pixels.
- **Source details:** dimensions, color profiles, media codecs and font
  information in the native Details sidebar, including its mobile layout.
- **A complete container:** the converters and Web integration are included for
  Linux amd64 and arm64.
- **Upstream release tracking:** daily release checks merge upstream releases
  while preserving the extras. Container builds, real-file conversions and
  browser checks gate publication.

Use this image in your OpenCloud deployment:

```yaml
image: docker.io/cpoul/opencloud-extra:stable
```

Keep your existing configuration and data volumes. For setup, supported formats,
configuration limits and version pinning, see the
[OpenCloud Extra guide](docs/opencloud-extra.md).

Illustrator files need PDF-compatible content; Photoshop files need a saved
composite. PostScript/EPS and 3D rendering are outside this fork's scope. The
[format guide](docs/opencloud-extra.md#thumbnail-formats) covers the details.

Development happens on `extra/stable`, based on upstream release tags. Use this
fork's [issues](https://github.com/cpouldev/opencloud-extra/issues) and
[pull requests](https://github.com/cpouldev/opencloud-extra/pulls) for the extras.
Build and validation instructions are in the
[container guide](extras/container/README.md); contribution boundaries are in
[AGENTS.md](AGENTS.md).

OpenCloud's backend retains its [Apache 2.0 license](LICENSE). Web components and
dependencies retain their respective licenses and notices.
