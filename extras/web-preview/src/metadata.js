export const METADATA_PROCESSOR = 'extra-metadata-v1'
export const MAX_METADATA_BYTES = 16384

const textFields = [
  'format', 'colorSpace', 'colorProfile', 'videoCodec', 'audioCodec',
  'fontFamily', 'fontStyle', 'fontFullName', 'fontVersion'
]
const positiveIntegerFields = [
  'width', 'height', 'bitDepth', 'pages', 'sampleRate', 'channels', 'fontFaces'
]
const positiveNumberFields = ['pageWidth', 'pageHeight', 'frameRate']

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function parseMetadata(source) {
  const input = JSON.parse(source)
  if (!input || Array.isArray(input) || input.schemaVersion !== 1) {
    throw new Error('Unsupported source information response')
  }

  // Copy only the known scalar fields. Bad optional fields must not turn into
  // plausible-looking facts, or prevent other valid source facts from showing.
  const result = { schemaVersion: 1 }
  for (const key of textFields) {
    if (text(input[key])) result[key] = text(input[key])
  }
  for (const key of positiveIntegerFields) {
    if (positiveInteger(input[key])) result[key] = input[key]
  }
  for (const key of positiveNumberFields) {
    if (positiveNumber(input[key])) result[key] = input[key]
  }
  if (typeof input.duration === 'number' && Number.isFinite(input.duration) && input.duration >= 0) {
    result.duration = input.duration
  }
  if (Number.isSafeInteger(input.glyphs) && input.glyphs >= 0) result.glyphs = input.glyphs
  if (typeof input.fontVariable === 'boolean') result.fontVariable = input.fontVariable
  return result
}

export function metadataUnavailableReason(resource) {
  if (!resource) return 'Select a file to see its information.'
  if (resource.isFolder || resource.type === 'folder') return 'Source information is available for files.'
  if (resource.isInVault) return 'Source information is unavailable for encrypted files.'
  try {
    if (resource.canDownload?.()) return ''
  } catch {
    // Missing permission context is a denial, not a reason to send a request.
  }
  return 'You do not have permission to view source information for this file.'
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Source information request aborted', 'AbortError')
}

async function readMetadata(response, signal) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const error = new Error('Source information request failed')
    error.status = response.status
    throw error
  }
  if (Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Source information response is too large')
  }
  if (!response.body) throw new Error('Source information response is empty')

  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const chunks = []
  let length = 0
  try {
    while (true) {
      checkAbort(signal)
      const { done, value } = await reader.read()
      checkAbort(signal)
      if (done) break
      length += value.byteLength
      if (length > MAX_METADATA_BYTES) throw new Error('Source information response is too large')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return parseMetadata(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export async function loadMetadata(previewService, { resource, space }, signal) {
  const blocked = metadataUnavailableReason(resource)
  if (blocked || !space) throw new Error(blocked || 'File location is unavailable')
  checkAbort(signal)
  let url
  let released = false
  const release = () => {
    if (!released && typeof url === 'string' && url.startsWith('blob:')) {
      URL.revokeObjectURL(url)
      released = true
    }
  }
  signal?.addEventListener('abort', release, { once: true })
  try {
    // This uses the host's authenticated preview path, including signed public
    // URLs. Neither the app wrapper nor the panel downloads the original file.
    url = await previewService.loadPreview({
      space, resource, dimensions: [1, 1], processor: METADATA_PROCESSOR
    }, false, false, signal)
    checkAbort(signal)
    if (typeof url !== 'string' || !url) throw new Error('No source information was returned')
    const response = await fetch(url, { signal })
    return await readMetadata(response, signal)
  } finally {
    signal?.removeEventListener('abort', release)
    release()
  }
}

function number(value, locale, digits = 2) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)
}

export function formatFileSize(value, locale) {
  if (typeof value === 'string') value = /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isSafeInteger(value) || value < 0) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const unit = value ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0
  return `${number(value / 1024 ** unit, locale)} ${units[unit]}`
}

export function formatDuration(value, locale) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  if (value > Number.MAX_SAFE_INTEGER / 100) return `${number(value, locale)} s`
  const total = Math.round(value * 100)
  const hours = Math.floor(total / 360000)
  const minutes = Math.floor((total % 360000) / 6000)
  const seconds = (total % 6000) / 100
  return [
    hours ? `${number(hours, locale, 0)} hr` : '',
    minutes ? `${minutes} min` : '',
    seconds || (!hours && !minutes) ? `${number(seconds, locale)} s` : ''
  ].filter(Boolean).join(' ')
}

export function fileFacts(resource, { locale, timeZone } = {}) {
  const rows = []
  const add = (key, label, value, extra = {}) => {
    if (value) rows.push({ key, label, value, ...extra })
  }
  add('name', 'Name', text(resource?.name))
  add('size', 'File size', formatFileSize(resource?.size, locale))
  const extension = text(resource?.extension).replace(/^\./, '')
  add('type', 'Type', text(resource?.mimeType) || (extension ? `${extension.toUpperCase()} file` : ''))
  if (text(resource?.mdate)) {
    const modified = new Date(resource.mdate)
    if (!Number.isNaN(modified.getTime())) {
      add('modified', 'Modified', new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium', timeStyle: 'short', timeZone
      }).format(modified), { dateTime: modified.toISOString() })
    }
  }
  return rows
}

export function sourceFacts(metadata, { locale } = {}) {
  if (!metadata) return []
  const rows = []
  const add = (key, label, value) => {
    if (value !== undefined) rows.push({ key, label, value })
  }
  const count = (key, label, suffix = '') => {
    if (metadata[key] !== undefined) add(key, label, `${number(metadata[key], locale)}${suffix}`)
  }
  add('format', 'Format', metadata.format)
  if (metadata.width && metadata.height) {
    add('dimensions', 'Source dimensions', `${number(metadata.width, locale)} × ${number(metadata.height, locale)} px`)
  } else {
    count('width', 'Source width', ' px')
    count('height', 'Source height', ' px')
  }
  add('colorSpace', 'Color space', metadata.colorSpace)
  add('colorProfile', 'Color profile', metadata.colorProfile)
  count('bitDepth', 'Bit depth', ' bit')
  count('pages', 'Pages')
  if (metadata.pageWidth && metadata.pageHeight) {
    add('pageSize', 'Page size', `${number(metadata.pageWidth, locale)} × ${number(metadata.pageHeight, locale)} pt`)
  } else {
    count('pageWidth', 'Page width', ' pt')
    count('pageHeight', 'Page height', ' pt')
  }
  if (metadata.duration !== undefined) add('duration', 'Duration', formatDuration(metadata.duration, locale))
  add('videoCodec', 'Video codec', metadata.videoCodec)
  count('frameRate', 'Frame rate', ' fps')
  add('audioCodec', 'Audio codec', metadata.audioCodec)
  if (metadata.sampleRate !== undefined) {
    const rate = metadata.sampleRate
    add('sampleRate', 'Sample rate', `${number(rate >= 1000 ? rate / 1000 : rate, locale)} ${rate >= 1000 ? 'kHz' : 'Hz'}`)
  }
  count('channels', 'Audio channels')
  add('fontFamily', 'Font family', metadata.fontFamily)
  add('fontStyle', 'Font style', metadata.fontStyle)
  add('fontFullName', 'Full font name', metadata.fontFullName)
  add('fontVersion', 'Font version', metadata.fontVersion)
  count('glyphs', 'Glyphs')
  count('fontFaces', 'Font faces')
  if (metadata.fontVariable !== undefined) add('fontVariable', 'Variable font', metadata.fontVariable ? 'Yes' : 'No')
  return rows
}
