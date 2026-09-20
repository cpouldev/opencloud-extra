# Rendered preview app

This app uses the OpenCloud Web **8.0.0** extension SDK and the host's
`AppWrapperRoute` and `PreviewService`. It registers explicit file extensions
for additional image, design, font, RAW and comic formats. Office and EPUB
previews are fallback actions, so configured native editors/readers keep
precedence.

```sh
npm ci
npm test
npm run build
```

The official SDK writes `dist/manifest.json`, a hashed module-federation remote
entry and its assets. Copy all of `dist/` into the built-in web asset directory
`services/web/assets/apps/extra-preview/` after generating upstream Web assets.
`@opencloud-eu/web-pkg` and the Web client are provided by the host at runtime.
Their pinned build-only packages let Module Federation discover named exports;
these SDK dependencies are not bundled into the viewer or runtime image.

The component declares only `resource` and `space` wrapper props. Declaring
`url` or `currentContent` would make the wrapper fetch the complete source file;
do not add those props. Preview requests use the host service with
`dimensions: [2048, 2048]` and `processor: 'fit'`. The service enforces download
permissions and uses authenticated requests or public-share signed URLs.
Encrypted vault files cannot be rendered server-side. The app owns and revokes
its blob URLs while OpenCloud's server handles cached rendering.

Component tests cover loading, conversion errors and retry, zoom/fit/keyboard
pan, access restrictions, request cancellation and URL cleanup. Geometry tests
cover image fitting and zoom/pan boundaries. The container browser smoke checks
the real wrapper, app discovery, file-click routing, credentials and renderer;
no static registration snapshots substitute for that check.

Browser test hooks use `data-testid` values `extra-preview`,
`extra-preview-loading`, `extra-preview-error`, `extra-preview-image`,
`extra-preview-stage` and `extra-preview-zoom`. Toolbar controls have descriptive
accessible names; the stage accepts `+`, `-`, arrow keys, `0` (fit), and Escape.
