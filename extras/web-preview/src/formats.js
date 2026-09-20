// Extension-only registration matters: AI often arrives as application/pdf or
// application/postscript, and creative archives often arrive as application/zip.
// Registering those MIME types would replace unrelated native viewers.
export const previewExtensions = [
  'ai', 'psd', 'psb',
  'heic', 'heif', 'avif', 'jxl', 'jp2', 'j2k', 'exr', 'hdr', 'tga', 'ico', 'xcf', 'svgz',
  'ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2',
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2',
  'kra', 'ora', 'sketch', 'cbz', 'cbr'
]

export const officeExtensions = ['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods']
export const fallbackExtensions = [...officeExtensions, 'epub']

// Native supported MIME types retain playback. Other media files can still
// appear in the gallery as a server-rendered frame or embedded cover artwork.
export const mediaFallbackExtensions = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'mts', 'm2ts',
  '3gp', 'flv', 'wmv', 'hevc', 'h265',
  'mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav', 'aiff'
]

export function extensionOf(resource) {
  return (resource?.extension || resource?.name?.split('.').pop() || '').toLowerCase()
}

export function unavailableReason(resource) {
  if (resource?.isInVault) return 'Encrypted files cannot be rendered on the server.'
  try {
    if (resource?.canDownload?.()) return ''
  } catch {
    // An incomplete host permission context must not start a preview request.
  }
  return 'You do not have permission to preview this file.'
}

export function conversionHint(resource) {
  const extension = extensionOf(resource)
  if (extension === 'ai') return 'Illustrator files must be saved with Create PDF Compatible File enabled.'
  if (['psd', 'psb'].includes(extension)) return 'Photoshop files need a saved composite image. Save with Maximize Compatibility enabled.'
  if (['kra', 'ora', 'sketch'].includes(extension)) return 'This file must contain an embedded preview.'
  return 'The file may use an unsupported format variant, exceed the rendering limits, or be damaged.'
}
