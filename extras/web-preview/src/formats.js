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

export function extensionOf(resource) {
  return (resource?.extension || resource?.name?.split('.').pop() || '').toLowerCase()
}

export function previewDescription(resource) {
  const extension = extensionOf(resource)
  if (extension === 'ai') return 'First artboard from the PDF-compatible artwork'
  if (['psd', 'psb'].includes(extension)) return 'Saved composite image; layers are flattened'
  if (['ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2'].includes(extension)) return 'Font specimen; first face in collections'
  if (['epub', 'cbz', 'cbr'].includes(extension)) return 'Cover or first page'
  if (officeExtensions.includes(extension)) return 'First page or slide'
  if (['kra', 'ora', 'sketch'].includes(extension)) return 'Embedded document preview'
  return 'Rendered image preview'
}

export function unavailableReason(resource) {
  if (resource?.isInVault) return 'Encrypted files cannot be rendered on the server.'
  if (!resource?.canDownload?.()) return 'You do not have permission to preview this file.'
  return ''
}

export function conversionHint(resource) {
  const extension = extensionOf(resource)
  if (extension === 'ai') return 'Illustrator files must be saved with Create PDF Compatible File enabled.'
  if (['psd', 'psb'].includes(extension)) return 'Photoshop files need a saved composite image. Save with Maximize Compatibility enabled.'
  if (['kra', 'ora', 'sketch'].includes(extension)) return 'This file must contain an embedded preview.'
  return 'The file may use an unsupported format variant, exceed the rendering limits, or be damaged.'
}
