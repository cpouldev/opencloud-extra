# Native gallery helpers

These modules are compiled into OpenCloud's existing `preview` application by
[the pinned Web build](../web-gallery/README.md). There is no standalone viewer
or separately loaded `extra-preview` application.

The native app retains `preview-media`, its photo roll, media stage and bottom
controls. Its downstream source patch extends file registration and loading for
server-rendered extra formats. The normal PDF, Office and EPUB handlers retain
priority; their gallery preview is available through Quick Look or a fallback
Preview action.

`useExtraPreview` registers the guarded Space opener, Quick Look/fallback actions,
a redirect for old `/extra-preview/` links, and source metadata rows in
`app.files.sidebar.file-details.table`. `AssetDetails.vue` consumes the native
Details panel's injected resource and space refs. The host handles its sidebar,
mobile drawer, current selection and ordinary file facts.

`metadata.js` uses the authenticated host preview transport with
`processor: 'extra-metadata-v1'` and `dimensions: [1, 1]`. It accepts bounded,
schema-versioned JSON, keeps source pixel dimensions distinct from document
points, and aborts requests and releases blob URLs on navigation or closure.
The server checks permissions before reading its revision-aware metadata cache.

Run helper tests with:

```sh
npm ci --no-audit --no-fund
npm test
```

The full native Web build runs the upstream gallery component tests plus the
native patch's behavioral tests. Browser checks in `../browser` exercise the
actual `#preview` gallery, `.photo-roll`, `.preview-controls-*`, and native
`#oc-file-details-sidebar` on desktop and mobile. Preserve those checks when
updating Web; mocked helper tests do not establish host integration.
