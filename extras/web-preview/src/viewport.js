export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4

export function clampZoom(value) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

export function fitZoom(viewport, image) {
  if (!viewport.width || !viewport.height || !image.width || !image.height) return 1
  return Math.min(1, viewport.width / image.width, viewport.height / image.height)
}

// Keep a zoomed image reachable while allowing every edge to be inspected.
export function constrainPan(pan, viewport, image, zoom) {
  const maximumX = Math.max(0, (image.width * zoom - viewport.width) / 2)
  const maximumY = Math.max(0, (image.height * zoom - viewport.height) / 2)
  return {
    x: maximumX ? Math.max(-maximumX, Math.min(maximumX, pan.x)) : 0,
    y: maximumY ? Math.max(-maximumY, Math.min(maximumY, pan.y)) : 0
  }
}
