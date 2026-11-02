# Native gallery build

The downstream patch extends OpenCloud Web's existing `preview-media` app. It
keeps the native filmstrip and media controls. Web is rebuilt as one source tree
because its apps share generated chunks, CSS and the `WEB_APPS_MAP` in
`index.html`; an independently bundled replacement would not share that build.

`source.json` pins the upstream tag, commit and package manager. The build rejects
a different `WEB_ASSETS_VERSION` in `services/web/Makefile`, an unexpected commit,
a moved tag, a changed package manager, local source edits or incompatible patch
hunks. Updating Web requires reviewing the patch and pin together. Upstream is
read-only; all downstream work stays in this repository.

`apply.mjs` applies `native-gallery.patch` and copies only the four integration
modules from `extras/web-preview/src` into
`packages/web-app-preview/src/extra`. Type declarations in that directory and
native component tests are included in the patch. Copying the modules preserves
the declarations. The integration modules retain their own npm test suite.

Web 8.2 loads media through `useMediaFileLoader` and uses `canOpen` for both file
actions and gallery membership. The patch extends those native paths. Native
media keeps neighbor preloading; extra conversions load only for the active file
and discard aborted or outdated responses.

From this repository root, with Node 24 and the pinned pnpm on `PATH`:

```sh
node --test extras/web-gallery/build.test.mjs
node extras/web-gallery/build.mjs fetch /tmp/opencloud-extra-web-build
node extras/web-gallery/build.mjs install /tmp/opencloud-extra-web-build
node extras/web-gallery/build.mjs build /tmp/opencloud-extra-web-build
```

Use a fresh checkout for each application of the patch. `fetch` refuses to
replace an existing directory. `install` uses `--frozen-lockfile`; optionally set
`OPENCLOUD_EXTRA_PNPM_STORE` to reuse a pnpm store. `build` applies the patch,
runs the root strict Vue/TypeScript check and native gallery component tests,
builds all Web assets, and generates upstream dependency license notices. The
build output is `dist/` in the checkout.

`Dockerfile.extra` exposes `extra-web-tests` and `native-web` targets for focused
checks. It preserves normal OpenCloud/IDP generation, replaces the complete
`services/web/assets/core` output, then embeds it into the Go binary. No separate
preview app is installed under `assets/apps`. The runtime includes Web's license
and dependency notices under `/usr/share/licenses/opencloud-extra/web`.

```sh
docker build -f Dockerfile.extra --target native-web .
```

## Packaging checks

The source pin and patch guards are release-sensitive build logic. Gate 0 is
off; Gate 1 is on, with its decisions covered by the real filesystem/Git tests
instead of a duplicate pure unit suite. Gate 2 is on because mocks would miss
patch application and checkout identity. Gate 3 is off for these non-UI scripts.
Gate 4 is off because scripts and image ship together. Gate 5 remains on through
the existing Docker/browser publication gates. Gate 6 is off for the finite
source-policy cases.

```yaml
selected_types:
  - rationale: Real temporary Git repositories prove the source guards preserve files and fail before patch application.
    type: integration
    size: medium
    framework: node:test
    dependencies: [Git, temporary directories]
    gate: Gate 2
  - rationale: The complete image must load the patched native gallery through its actual runtime.
    type: smoke
    size: large
    framework: existing container and Playwright gates
    dependencies: [Docker, Chromium]
    gate: Gate 5
rejected_types:
  - reason: Decision branches are already covered by the filesystem integration cases.
    type: unit
  - reason: These scripts have no user interface.
    type: component
  - reason: There is no independently deployed consumer of the build scripts.
    type: contract
  - reason: Finite source-policy cases give direct evidence of the required failures.
    type: property-based
deliberately_skipped:
  - why: The native component suite and existing browser gates validate the generated application.
    what: Snapshot comparisons of generated bundles
```

- Apply to the pinned source and copy the integration modules, preserving the patch's type declarations.
- Reject a changed upstream version, unexpected commit or moved tag.
- Preserve local work when a checkout is dirty.
- Reject incompatible patch context before copying modules.
