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
`extra-preview-stage`, `extra-preview-zoom`, `extra-preview-position` and
`extra-asset-info`. Toolbar controls have descriptive accessible names; the stage
accepts `+`, `-`, `0` (fit), Left/Right (files), Shift+arrows (pan), Space and Escape
(close).

Quick Look captures only the rendered folder page via Web v8's `data-item-id`
hooks before the host replaces its resources store. Preserve the table/tile
browser tests when updating Web. The Space capture handler yields to inputs,
dialogs, unrelated controls, modified keys, multiple selections and other routes.
Normal file-handler registration is unchanged; native formats get an explicit
Quick Look context action. Direct links have no captured sibling list.

`AssetInfo.vue` mounts only when requested. Its loader uses the same host preview
transport with `processor: 'extra-metadata-v1'` and `dimensions: [1, 1]`, returning
bounded schema-versioned JSON. Image and metadata client caches stay independent;
the server keys metadata by source identity and revision. Field formatting keeps
pixel dimensions distinct from document points. Panel failures never replace a
working image. Abort and URL cleanup apply to both private and public requests.
