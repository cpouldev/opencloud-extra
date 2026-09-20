// A single host boundary is substituted in component tests. Browser smoke
// tests exercise the real Web v8 wrapper, routing and PreviewService.
export function usePreviewService() {
  return globalThis.__extraPreviewService
}

export function useRouter() {
  return globalThis.__extraPreviewRouter
}

export function useFileActions() {
  return globalThis.__extraFileActions
}

export function useResourcesStore() {
  return globalThis.__extraResourcesStore
}

export function useSpacesStore() {
  return globalThis.__extraSpacesStore
}

export function useSelectedResources() {
  return globalThis.__extraSelectedResources
}
