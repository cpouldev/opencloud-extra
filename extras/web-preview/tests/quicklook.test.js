import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createQuickLookController, isQuickLookEligible, visibleResources } from '../src/quicklook.js'

const file = (id, changes = {}) => ({
  id, fileId: id, name: `${id}.ai`, extension: 'ai', type: 'file',
  canDownload: () => true, ...changes
})
const folderRoute = { name: 'files-spaces-generic', params: { driveAliasAndItem: 'personal/me' }, query: {} }
const publicFolderRoute = { name: 'files-public-link', params: { driveAliasAndItem: 'public/public-token' }, query: {} }
let controller
let router
let resourcesStore
let spacesStore
let session
let guard

function addRows(ids, view = 'table') {
  const container = document.createElement(view === 'table' ? 'table' : 'div')
  container.id = view === 'table' ? 'files-space-table' : 'tiles-view'
  for (const id of ids) {
    const row = document.createElement(view === 'table' ? 'tr' : 'div')
    row.dataset.itemId = id
    row.getClientRects = () => [{}]
    container.append(row)
  }
  document.body.append(container)
  return container
}

function key(target = document.body, changes = {}) {
  const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...changes })
  target.dispatchEvent(event)
  return event
}

function start() {
  controller = createQuickLookController({
    router, resourcesStore, spacesStore, session,
    getEditorRouteOpts: (name, space, resource, shareId) => ({
      name, params: { driveAliasAndItem: `${space.driveAlias}/${resource.name}` },
      query: { fileId: resource.fileId, ...(shareId && { shareId }), contextRouteName: router.currentRoute.value.name }
    })
  })
}

beforeEach(() => {
  session = ref(null)
  router = {
    currentRoute: ref(folderRoute),
    push: vi.fn().mockResolvedValue(undefined),
    beforeEach: vi.fn((callback) => { guard = callback; return vi.fn() })
  }
  resourcesStore = {
    currentFolder: { id: 'folder' },
    activeResources: [file('a'), file('b'), file('c')],
    selectedResources: [file('a')]
  }
  spacesStore = { currentSpace: { id: 'space', driveType: 'personal', driveAlias: 'personal/me' } }
})

afterEach(() => {
  controller?.dispose()
  controller = undefined
  document.body.replaceChildren()
})

describe('Quick Look eligibility', () => {
  it.each([
    { name: 'Illustrator artwork', resource: file('a'), expected: true },
    { name: 'native JPEG', resource: file('a', { extension: 'jpg' }), expected: true },
    { name: 'native PDF', resource: file('a', { extension: 'pdf' }), expected: true },
    { name: 'video frame', resource: file('a', { extension: 'mp4' }), expected: true },
    { name: 'audio artwork', resource: file('a', { extension: 'flac' }), expected: true },
    { name: 'Office first page', resource: file('a', { extension: 'docx' }), expected: true },
    { name: 'unknown original', resource: file('a', { extension: 'dat' }), expected: false },
    { name: 'excluded EPS', resource: file('a', { extension: 'eps' }), expected: false },
    { name: 'folder', resource: file('a', { isFolder: true }), expected: false },
    { name: 'folder type', resource: file('a', { type: 'folder' }), expected: false },
    { name: 'project space', resource: file('a', { driveType: 'project' }), expected: false },
    { name: 'deleted file', resource: file('a', { ddate: '2026-01-01' }), expected: false },
    { name: 'encrypted file', resource: file('a', { isInVault: true }), expected: false },
    { name: 'denied file', resource: file('a', { canDownload: () => false }), expected: false },
    { name: 'processing file', resource: file('a', { processing: true }), expected: false },
    { name: 'disabled file', resource: file('a', { disabled: true }), expected: false }
  ])('handles $name', ({ resource, expected }) => {
    expect(isQuickLookEligible(resource)).toBe(expected)
  })
})

describe('displayed resource snapshot', () => {
  it.each(['table', 'tiles'])('keeps %s order rather than store order', (view) => {
    addRows(['c', 'a'], view)
    expect(visibleResources(document, resourcesStore.activeResources).map(({ id }) => id)).toEqual(['c', 'a'])
  })

  it('excludes invisible rows', () => {
    const rows = addRows(['a', 'b', 'c']).children
    rows[0].hidden = true
    rows[1].getClientRects = () => []
    expect(visibleResources(document, resourcesStore.activeResources).map(({ id }) => id)).toEqual(['c'])
  })

  it('excludes ineligible resources even when the host renders a row', () => {
    resourcesStore.activeResources[0].isInVault = true
    resourcesStore.activeResources[1].canDownload = () => false
    addRows(['a', 'b', 'c', 'not-in-store'])
    expect(visibleResources(document, resourcesStore.activeResources).map(({ id }) => id)).toEqual(['c'])
  })

  it('ignores resource rows outside the file list', () => {
    const other = document.createElement('div')
    other.dataset.itemId = 'b'
    document.body.append(other)
    addRows(['a'])
    expect(visibleResources(document, resourcesStore.activeResources).map(({ id }) => id)).toEqual(['a'])
  })
})

describe('Space opener', () => {
  it.each(['table', 'tiles'])('opens the selected public folder resource in %s view', (view) => {
    router.currentRoute.value = publicFolderRoute
    spacesStore.currentSpace = { id: 'public-token', driveType: 'public', driveAlias: 'public/public-token' }
    const row = addRows(['a', 'b'], view).firstElementChild
    const label = document.createElement('span')
    label.dataset.testSelectionResourceName = 'a.ai'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    label.append(checkbox)
    row.append(label)
    start()
    const event = key(checkbox)
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
      params: { driveAliasAndItem: 'public/public-token/a.ai' },
      query: expect.objectContaining({ contextRouteName: 'files-public-link' })
    }))
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([
    { name: 'a stale private space', space: { id: 'space', driveType: 'personal', driveAlias: 'personal/me' } },
    { name: 'a different public token', space: { id: 'other', driveType: 'public', driveAlias: 'public/other' } }
  ])('ignores public folder selection with $name', ({ space }) => {
    router.currentRoute.value = publicFolderRoute
    spacesStore.currentSpace = space
    addRows(['a'])
    start()
    key()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('opens the selected resource before the host toggles selection', () => {
    addRows(['a', 'b'])
    start()
    const toggle = vi.fn()
    document.addEventListener('keydown', toggle, { once: true })
    const event = key()
    document.removeEventListener('keydown', toggle)
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({
      name: 'extra-preview-file', params: { driveAliasAndItem: 'personal/me/a.ai' }
    }))
    expect(event.defaultPrevented).toBe(true)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('opens a selected row while its checkbox has focus', () => {
    const row = addRows(['a']).firstElementChild
    const label = document.createElement('span')
    label.dataset.testSelectionResourceName = 'a.ai'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    label.append(checkbox)
    row.append(label)
    start()
    key(checkbox)
    expect(router.push).toHaveBeenCalledOnce()
  })

  it('opens the focused resource name when no row is selected', () => {
    resourcesStore.selectedResources = []
    const row = addRows(['a']).firstElementChild
    const resource = document.createElement('div')
    resource.className = 'oc-resource'
    const link = document.createElement('a')
    resource.append(link)
    row.append(resource)
    start()
    key(link)
    expect(router.push).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'Control shortcut', event: { ctrlKey: true } },
    { name: 'Command shortcut', event: { metaKey: true } },
    { name: 'Alt shortcut', event: { altKey: true } },
    { name: 'Shift shortcut', event: { shiftKey: true } },
    { name: 'held Space key', event: { repeat: true } },
    { name: 'composition event', event: { isComposing: true } },
    { name: 'unrelated key', event: { key: 'Enter' } }
  ])('ignores $name', ({ event }) => {
    addRows(['a'])
    start()
    const dispatched = key(document.body, event)
    expect(router.push).not.toHaveBeenCalled()
    expect(dispatched.defaultPrevented).toBe(false)
  })

  it.each(['input', 'textarea', 'select', 'button'])('preserves Space in a %s', (tag) => {
    const input = document.createElement(tag)
    document.body.append(input)
    addRows(['a'])
    start()
    key(input)
    expect(router.push).not.toHaveBeenCalled()
  })

  it('preserves Space in a contenteditable field', () => {
    const input = document.createElement('div')
    input.setAttribute('contenteditable', 'true')
    document.body.append(input)
    addRows(['a'])
    start()
    key(input)
    expect(router.push).not.toHaveBeenCalled()
  })

  it.each(['runtime.login', 'files-search', 'files-trash', 'extra-preview-file'])('ignores route %s', (name) => {
    router.currentRoute.value = { name }
    addRows(['a'])
    start()
    key()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('preserves Space while a dialog is open', () => {
    addRows(['a'])
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.getClientRects = () => [{}]
    document.body.append(dialog)
    start()
    key()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('does not guess which file to open in a multiple selection', () => {
    resourcesStore.selectedResources = [file('a'), file('b')]
    addRows(['a', 'b'])
    start()
    key()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('ignores a selected file outside the visible page', () => {
    addRows(['b', 'c'])
    start()
    key()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('removes its document listener when disposed', () => {
    addRows(['a'])
    start()
    controller.dispose()
    key()
    expect(router.push).not.toHaveBeenCalled()
  })
})

describe('navigation capture', () => {
  it('captures the current page before the host replaces its resource store', () => {
    addRows(['c', 'a'])
    start()
    guard({ name: 'extra-preview-file', params: { driveAliasAndItem: 'personal/me/a.ai' } }, folderRoute)
    resourcesStore.activeResources = [file('a')]
    expect(session.value.entries.map(({ id }) => id)).toEqual(['c', 'a'])
  })

  it('keeps every public entry within the current public token', () => {
    router.currentRoute.value = publicFolderRoute
    spacesStore.currentSpace = { id: 'public-token', driveType: 'public', driveAlias: 'public/public-token' }
    addRows(['a', 'c'])
    start()
    guard({ name: 'extra-preview-file', params: { driveAliasAndItem: 'public/public-token/a.ai' } }, publicFolderRoute)
    expect(session.value.entries.map(({ route }) => route.params.driveAliasAndItem)).toEqual([
      'public/public-token/a.ai', 'public/public-token/c.ai'
    ])
    expect(session.value.entries.every(({ route }) => route.query.contextRouteName === 'files-public-link')).toBe(true)
  })

  it('clears a private snapshot when leaving the preview', () => {
    addRows(['a', 'b'])
    start()
    guard({ name: 'extra-preview-file', params: { driveAliasAndItem: 'personal/me/a.ai' } }, folderRoute)
    guard({ name: 'runtime.login' }, { name: 'extra-preview-file' })
    expect(session.value).toBeNull()
  })

  it('does not reuse folder entries for an unrelated direct file route', () => {
    addRows(['a', 'b'])
    start()
    guard({ name: 'extra-preview-file', params: { driveAliasAndItem: 'public/other/a.ai' } }, folderRoute)
    expect(session.value).toBeNull()
  })
})
