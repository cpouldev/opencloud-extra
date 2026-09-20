import {
  extensionOf, fallbackExtensions, mediaFallbackExtensions, previewExtensions, unavailableReason
} from './formats.js'

export const previewRouteName = 'preview-media'
const publicFolderRouteName = 'files-public-link'
const folderRouteNames = new Set(['files-spaces-generic', publicFolderRouteName])
const renderedExtensions = new Set([
  ...previewExtensions, ...fallbackExtensions, ...mediaFallbackExtensions, 'pdf'
])

export function isQuickLookEligible(resource, nativeMimeTypes = []) {
  return Boolean(resource?.id && !resource.isFolder && !resource.driveType &&
    (!resource.type || resource.type === 'file') &&
    !resource.processing && !resource.disabled && !Object.hasOwn(resource, 'ddate') &&
    !unavailableReason(resource) && (renderedExtensions.has(extensionOf(resource)) ||
      nativeMimeTypes.includes(resource.mimeType?.toLowerCase())))
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

export function visibleResources(document, resources, nativeMimeTypes = []) {
  const byId = new Map(resources.map((resource) => [String(resource.id), resource]))
  const seen = new Set()
  return [...document.querySelectorAll(rowSelector)].flatMap((row) => {
    const id = row.getAttribute('data-item-id')
    const resource = byId.get(id)
    if (seen.has(id) || !isVisible(row) ||
      row.matches('.oc-table-disabled, .oc-tile-card-disabled') ||
      !isQuickLookEligible(resource, nativeMimeTypes)) return []
    seen.add(id)
    return [resource]
  })
}

// The gallery owns its folder loading, ordering, navigation and close context.
// This controller only opens the currently selected/focused visible file.
export function createQuickLookController({ router, resourcesStore, spacesStore, getEditorRouteOpts,
  nativeMimeTypes = [], document: page = document }) {
  function folderSpace() {
    const location = router.currentRoute.value
    if (!folderRouteNames.has(location.name)) return null
    const space = spacesStore.currentSpace
    if (!space?.id || !resourcesStore.currentFolder) return null
    if (location.name === publicFolderRouteName && (space.driveType !== 'public' ||
      String(location.params?.driveAliasAndItem).split('/')[1] !== space.id)) return null
    return space
  }

  function open(space, resource) {
    if (!space?.id || !isQuickLookEligible(resource, nativeMimeTypes)) return
    const route = getEditorRouteOpts(previewRouteName, space, resource,
      space.driveType === 'share' ? space.id : undefined)
    // Quick Look keeps the keyboard and close context in the current tab.
    return router.push(route)
  }

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

    const space = folderSpace()
    if (!space) return
    const id = selected[0]?.id || focusedId
    const resource = visibleResources(page, resourcesStore.activeResources, nativeMimeTypes)
      .find((entry) => String(entry.id) === String(id))
    if (!resource) return
    event.preventDefault()
    // Upstream Space toggles selection. Intercept only after all eligibility
    // and focus checks pass, before the host's bubbling document listener.
    event.stopImmediatePropagation()
    open(space, resource)
  }

  page.addEventListener('keydown', onKeydown, true)
  return {
    open,
    dispose() {
      page.removeEventListener('keydown', onKeydown, true)
    }
  }
}
