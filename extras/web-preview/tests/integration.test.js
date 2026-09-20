import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useExtraPreview } from '../src/index.ts'

const file = (changes = {}) => ({
  id: 'file-a', name: 'artwork.ai', extension: 'ai', canDownload: () => true, ...changes
})
const space = { id: 'space-a', driveType: 'personal', driveAlias: 'personal/me' }
let app
let router
let cleanup
let removeRoute
let legacyRoute
let getEditorRouteOpts

function setup() {
  app = useExtraPreview(['image/jpeg', 'video/mp4'])
  app.mounted({ instance: { onUnmount: (callback) => { cleanup = callback } } })
  return app.extensions.value
}

function action(name) {
  return app.extensions.value.find((extension) => extension.id === name).action
}

beforeEach(() => {
  removeRoute = vi.fn()
  router = {
    currentRoute: ref({ name: 'files-spaces-generic' }),
    push: vi.fn(),
    addRoute: vi.fn((route) => { legacyRoute = route; return removeRoute })
  }
  getEditorRouteOpts = vi.fn((name, space, resource, shareId) => ({
    name, params: { driveAliasAndItem: `${space.driveAlias}/${resource.name}` },
    query: { fileId: resource.id, ...(shareId && { shareId }) }
  }))
  globalThis.__extraPreviewRouter = router
  globalThis.__extraFileActions = { getEditorRouteOpts }
  globalThis.__extraResourcesStore = { currentFolder: { id: 'folder' }, activeResources: [], selectedResources: [] }
  globalThis.__extraSpacesStore = { currentSpace: space }
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  delete globalThis.__extraPreviewRouter
  delete globalThis.__extraFileActions
  delete globalThis.__extraResourcesStore
  delete globalThis.__extraSpacesStore
})

describe('native preview integration', () => {
  it('opens an explicit Quick Look action in the native gallery', async () => {
    setup()
    await action('extra-quick-look').handler({ space, resources: [file()] })
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ name: 'preview-media' }))
    expect(action('extra-quick-look').category).toBe('secondary')
  })

  it.each([
    { name: 'native JPEG', resource: file({ extension: 'jpg', mimeType: 'image/jpeg' }), visible: true },
    { name: 'rendered font', resource: file({ extension: 'otf' }), visible: true },
    { name: 'rendered video frame', resource: file({ extension: 'mkv' }), visible: true },
    { name: 'unknown file', resource: file({ extension: 'dat' }), visible: false },
    { name: 'missing permission', resource: file({ canDownload: undefined }), visible: false },
    { name: 'vault file', resource: file({ isInVault: true }), visible: false }
  ])('shows Quick Look appropriately for a $name', ({ resource, visible }) => {
    setup()
    expect(action('extra-quick-look').isVisible({ space, resources: [resource] })).toBe(visible)
  })

  it('keeps Office fallback behind native file handlers', () => {
    setup()
    const fallback = action('extra-preview-fallback')
    expect(fallback.isVisible({ space, resources: [file({ extension: 'docx' })] })).toBe(true)
    expect(fallback.hasPriority).toBeUndefined()
    expect(fallback.route({ space, resources: [file({ extension: 'docx' })] }).name).toBe('preview-media')
    expect(fallback.isVisible({ space, resources: [file({ extension: 'pdf' })] })).toBe(false)
  })

  it('preserves authenticated share context for fallback links', () => {
    setup()
    const resource = file({ extension: 'docx' })
    action('extra-preview-fallback').route({ space: { ...space, driveType: 'share' }, resources: [resource] })
    expect(getEditorRouteOpts).toHaveBeenCalledWith('preview-media', expect.any(Object), resource, 'space-a')
  })

  it('redirects an old custom viewer link without losing its close context', () => {
    setup()
    const target = {
      params: { driveAliasAndItem: 'public/share-token/artwork.ai' },
      query: { fileId: 'file-a', contextRouteName: 'files-public-link', contextRouteQuery: '{}', sort: 'name' },
      hash: '#source'
    }
    expect(legacyRoute.path).toBe('/extra-preview/:driveAliasAndItem(.*)?')
    expect(legacyRoute.redirect(target)).toEqual({ name: 'preview-media', ...target })
  })

  it('removes the legacy route when the native app is unmounted', () => {
    setup()
    cleanup()
    cleanup = undefined
    expect(removeRoute).toHaveBeenCalledOnce()
  })
})
