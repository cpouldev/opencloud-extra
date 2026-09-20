import { computed, ref, shallowRef } from 'vue'
import { useRouter } from '@opencloud-eu/web-pkg'
import { extensionOf, fallbackExtensions, previewExtensions, unavailableReason } from './formats.js'

export const previewRouteName = 'extra-preview-file'
const publicFolderRouteName = 'files-public-link'
const folderRouteNames = new Set(['files-spaces-generic', publicFolderRouteName])

// Native formats are available through the explicit action only. Their normal
// click handlers still belong to the image, PDF, media and Office applications.
const extensions = new Set([
  ...previewExtensions, ...fallbackExtensions,
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'pdf',
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'mts', 'm2ts',
  '3gp', 'flv', 'wmv', 'hevc', 'h265',
  'mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav', 'aiff'
])

// This is a short-lived, in-memory snapshot, never persisted between sessions.
// The host replaces its resource list with the opened file, so take the page
// before navigation. Every entry keeps the original authenticated/share route.
export const quickLookSession = shallowRef(null)

export function isQuickLookEligible(resource) {
  return Boolean(resource?.id && !resource.isFolder && !resource.driveType &&
    (!resource.type || resource.type === 'file') &&
    !resource.processing && !resource.disabled && !Object.hasOwn(resource, 'ddate') &&
    !unavailableReason(resource) && extensions.has(extensionOf(resource)))
}

export function isEditableTarget(target) {
  return Boolean(target?.closest?.(
    'input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"]), ' +
    '[role="textbox"], [role="combobox"], [role="slider"], [role="listbox"], ' +
    '[data-custom-key-bindings-disabled="true"]'
  ))
}

const rowSelector = '#files-space-table [data-item-id], #tiles-view [data-item-id]'

function isVisible(element) {
  return !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0
}

export function visibleResources(document, resources) {
  const byId = new Map(resources.map((resource) => [String(resource.id), resource]))
  const seen = new Set()
  return [...document.querySelectorAll(rowSelector)].flatMap((row) => {
    const id = row.getAttribute('data-item-id')
    const resource = byId.get(id)
    if (seen.has(id) || !isVisible(row) ||
      row.matches('.oc-table-disabled, .oc-tile-card-disabled') ||
      !isQuickLookEligible(resource)) return []
    seen.add(id)
    return [resource]
  })
}

function spaceKey(space) {
  return `${space?.driveType || ''}:${space?.id || ''}:${space?.driveAlias || ''}`
}

export function createQuickLookController({ router, resourcesStore, spacesStore, getEditorRouteOpts,
  document: page = document, session = quickLookSession }) {
  function capture() {
    const location = router.currentRoute.value
    if (!folderRouteNames.has(location.name)) return null
    const space = spacesStore.currentSpace
    if (!space?.id || !resourcesStore.currentFolder) return null
    if (location.name === publicFolderRouteName && (space.driveType !== 'public' ||
      String(location.params?.driveAliasAndItem).split('/')[1] !== space.id)) return null
    const entries = visibleResources(page, resourcesStore.activeResources).map((resource) => ({
      id: resource.id,
      fileId: resource.fileId,
      resource,
      route: getEditorRouteOpts(previewRouteName, space, resource,
        space.driveType === 'share' ? space.id : undefined)
    }))
    return { entries, space: spaceKey(space), infoOpen: false }
  }

  function open(space, resource) {
    if (!space?.id || !isQuickLookEligible(resource)) return
    const route = getEditorRouteOpts(previewRouteName, space, resource,
      space.driveType === 'share' ? space.id : undefined)
    // Quick Look stays in this tab; editor preferences still apply to ordinary
    // file clicks. A new tab would lose the visible page and keyboard context.
    return router.push(route)
  }

  const removeGuard = router.beforeEach((to, from) => {
    if (to.name === previewRouteName && folderRouteNames.has(from.name)) {
      const snapshot = capture()
      const target = snapshot?.entries.find(({ route }) =>
        route.params.driveAliasAndItem === to.params.driveAliasAndItem)
      session.value = target ? snapshot : null
    } else if (to.name !== previewRouteName) {
      session.value = null
    }
  })

  function onKeydown(event) {
    if (event.key !== ' ' || event.repeat || event.isComposing || event.defaultPrevented ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      !folderRouteNames.has(router.currentRoute.value.name) || isEditableTarget(event.target) ||
      page.defaultView?.getSelection()?.type === 'Range') return
    if ([...page.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="menu"]')].some(isVisible)) return

    const selected = resourcesStore.selectedResources
    if (selected.length > 1) return
    const focusedRow = event.target?.closest?.(rowSelector)
    const focusedId = focusedRow?.getAttribute('data-item-id')
    const control = event.target?.closest?.('button, a, input, [role="button"], [role="checkbox"]')
    if (control && !((control.matches('input[type="checkbox"]') &&
      control.closest('[data-test-selection-resource-name]')) ||
      control.closest('.oc-resource'))) return
    if (!focusedRow && event.target !== page.body && event.target !== page.documentElement) return
    if (selected.length && focusedId && String(selected[0].id) !== focusedId) return

    const snapshot = capture()
    const id = selected[0]?.id || focusedId
    const entry = snapshot?.entries.find((entry) => String(entry.id) === String(id))
    if (!entry) return
    event.preventDefault()
    // Upstream Space toggles the checkbox. Intercept only after all eligibility
    // and focus checks have passed, before its bubbling document listener.
    event.stopImmediatePropagation()
    open(spacesStore.currentSpace, entry.resource)
  }

  page.addEventListener('keydown', onKeydown, true)
  return {
    open,
    dispose() {
      page.removeEventListener('keydown', onKeydown, true)
      removeGuard()
      session.value = null
    }
  }
}

export function useQuickLookNavigation(props, session = quickLookSession) {
  const router = useRouter()
  const navigating = ref(false)
  const localInfoOpen = ref(false)
  const entries = computed(() => {
    const current = session.value
    if (!current || current.space !== spaceKey(props.space)) return []
    return current.entries.filter(({ resource }) => isQuickLookEligible(resource))
  })
  const index = computed(() => entries.value.findIndex(({ id, fileId }) =>
    id === props.resource?.id || (fileId && fileId === props.resource?.fileId)))
  const count = computed(() => index.value >= 0 ? entries.value.length : 1)
  const position = computed(() => index.value >= 0 ? index.value + 1 : 1)
  const canPrevious = computed(() => !navigating.value && index.value > 0)
  const canNext = computed(() => !navigating.value && index.value >= 0 && index.value < entries.value.length - 1)
  const infoOpen = computed({
    get: () => index.value >= 0 ? Boolean(session.value.infoOpen) : localInfoOpen.value,
    set(value) {
      // The host unmounts the viewer between files. Keep only this UI preference
      // in the captured page; extracted metadata belongs to each mounted panel.
      if (index.value >= 0) session.value = { ...session.value, infoOpen: Boolean(value) }
      else localInfoOpen.value = Boolean(value)
    }
  })

  async function move(direction) {
    if ((direction !== -1 && direction !== 1) ||
      !(direction === -1 ? canPrevious.value : canNext.value)) return
    navigating.value = true
    try {
      // Reuse the folder context captured on entry. Deriving a new route from
      // the current preview would make Close return to another preview.
      await router.replace(entries.value[index.value + direction].route)
    } finally {
      navigating.value = false
    }
  }

  return { count, position, canPrevious, canNext, move, infoOpen }
}
