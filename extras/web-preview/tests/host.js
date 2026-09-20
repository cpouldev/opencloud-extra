// A single host boundary is substituted in component tests. Browser smoke
// tests exercise the real Web v8 wrapper, routing and PreviewService.
export function usePreviewService() {
  return globalThis.__extraPreviewService
}
