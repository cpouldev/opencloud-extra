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
  app = useExtraPreview()
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
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  delete globalThis.__extraPreviewRouter
  delete globalThis.__extraFileActions
})

describe('native preview integration', () => {
  it.each([
    { name: 'personal folder', target: space },
    { name: 'public folder', target: { id: 'public-token', driveType: 'public', driveAlias: 'public/public-token' } },
    { name: 'authenticated share', target: { id: 'share-a', driveType: 'share', driveAlias: 'share/share-a' } }
  ])('opens a fallback preview from a $name in the native gallery', async ({ target }) => {
    setup()
    await action('extra-preview-fallback').handler({ space: target, resources: [file({ name: 'document.docx', extension: 'docx' })] })
    expect(router.push).toHaveBeenCalledWith({
      name: 'preview-media', params: { driveAliasAndItem: `${target.driveAlias}/document.docx` },
      query: { fileId: 'file-a', ...(target.driveType === 'share' && { shareId: target.id }) }
    })
  })

  it.each([
    { name: 'Office document', changes: {}, visible: true },
    { name: 'EPUB book', changes: { extension: 'epub' }, visible: true },
    { name: 'native JPEG', changes: { extension: 'jpg', mimeType: 'image/jpeg' }, visible: false },
    { name: 'native PDF', changes: { extension: 'pdf' }, visible: false },
    { name: 'unknown file', changes: { extension: 'dat' }, visible: false },
    { name: 'missing permission', changes: { canDownload: undefined }, visible: false },
    { name: 'denied file', changes: { canDownload: () => false }, visible: false },
    { name: 'broken permission context', changes: { canDownload: () => { throw new Error('not loaded') } }, visible: false },
    { name: 'vault file', changes: { isInVault: true }, visible: false },
    { name: 'folder', changes: { isFolder: true }, visible: false },
    { name: 'folder type', changes: { type: 'folder' }, visible: false },
    { name: 'project space', changes: { driveType: 'project' }, visible: false },
    { name: 'deleted file', changes: { ddate: '2026-01-01' }, visible: false },
    { name: 'processing file', changes: { processing: true }, visible: false },
    { name: 'disabled file', changes: { disabled: true }, visible: false },
    { name: 'missing identity', changes: { id: undefined }, visible: false }
  ])('offers the fallback appropriately for a $name', async ({ changes, visible }) => {
    setup()
    const options = { space, resources: [file({ extension: 'docx', ...changes })] }
    const fallback = action('extra-preview-fallback')
    expect(fallback.isVisible(options)).toBe(visible)
    await fallback.handler(options)
    expect(router.push).toHaveBeenCalledTimes(visible ? 1 : 0)
  })

  it.each([
    { name: 'no selection', resources: [] },
    { name: 'multiple selection', resources: [file({ extension: 'docx' }), file({ id: 'file-b', extension: 'docx' })] },
    { name: 'missing space', resources: [file({ extension: 'docx' })], target: {} }
  ])('does not open a fallback with $name', async ({ resources, target = space }) => {
    setup()
    const options = { space: target, resources }
    expect(action('extra-preview-fallback').isVisible(options)).toBe(false)
    await action('extra-preview-fallback').handler(options)
    expect(router.push).not.toHaveBeenCalled()
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
