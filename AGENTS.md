# OpenCloud Extra

This repository is the downstream distribution `cpouldev/opencloud-extra`.

- Never create a pull request, issue, release, push, or other write in `opencloud-eu/opencloud`. Upstream access is read-only, including during release automation.
- Explicitly target `cpouldev/opencloud-extra` in every GitHub write. Do not rely on GitHub CLI's inferred repository for forks.
- Publish images only to `docker.io/cpoul/opencloud-extra`.
- Keep custom changes on `extra/stable`, based on upstream release tags. Preserve custom commits during upstream merges; never force-reset the release branch to upstream.
- Keep the upstream Go module path. Concentrate custom providers and packaging under `services/thumbnails/pkg/extra`, `extras`, and `Dockerfile.extra` to limit merge conflicts.
- The supported scope excludes PostScript/EPS and 3D rendering. Illustrator support is limited to PDF-compatible AI files.
- Validate converters using actual input files in the runtime image. A MIME allowlist or installed executable alone does not establish format support.
- Preserve the downstream filename-aware `hasPreview` check in vendored Reva's `ocdav/propfind` handler when updating dependencies. The live preview smoke checks this integration.
- Keep extra previews inside OpenCloud's native gallery, using its photo roll, bottom controls and Details sidebar. Do not restore a separate custom viewer.
- Keep `extras/web-gallery/source.json`, its native source patch and `extras/web-preview` helpers compatible with the Web version selected by `services/web/Makefile`. Review the patch before updating the pin; never bypass its drift checks. Preserve the full native Web build and browser checks on both architectures.
- Preserve Quick Look's table/tile and public-folder integration and metadata authorization before cache reads. Keep source request contexts, the bounded metadata schema, and source dimensions distinct from preview dimensions.
