import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fileFacts, formatDuration, formatFileSize, loadMetadata, MAX_METADATA_BYTES,
  parseMetadata, sourceFacts
} from '../src/metadata.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const resource = { id: 'file-a', name: 'artwork.psd', canDownload: () => true }
const space = { id: 'space-a' }

function loadResponse(response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  return loadMetadata({ loadPreview: vi.fn().mockResolvedValue('https://example.test/signed-metadata') },
    { resource, space }, new AbortController().signal)
}

function payload(bytes) {
  const base = JSON.stringify({ schemaVersion: 1, format: 'PSD', padding: '' })
  return base.replace('"padding":""', `"padding":"${' '.repeat(bytes - base.length)}"`)
}

describe('source information validation', () => {
  for (const { name, value } of [
    { name: 'unknown version', value: { schemaVersion: 2 } },
    { name: 'missing version', value: {} },
    { name: 'string version', value: { schemaVersion: '1' } },
    { name: 'null response', value: null },
    { name: 'array response', value: [] }
  ]) {
    it(`rejects ${name}`, () => {
      expect(() => parseMetadata(JSON.stringify(value))).toThrow('Unsupported source information')
    })
  }

  it('omits invalid optional facts', () => {
    const metadata = parseMetadata(JSON.stringify({
      schemaVersion: 1, format: '  PSD  ', width: '6000', height: -1,
      pages: 0, bitDepth: 8.5, fontFaces: Number.MAX_SAFE_INTEGER + 1,
      colorProfile: { label: 'sRGB' }, videoCodec: '', duration: -2,
      pageWidth: 0, pageHeight: '792', glyphs: 1.5, fontVariable: 'false',
      previewWidth: 2048, thumbnail: { width: 2048, height: 1024 }
    }))
    expect(metadata).toEqual({ schemaVersion: 1, format: 'PSD' })
  })

  it('preserves factual zero values', () => {
    const metadata = parseMetadata(JSON.stringify({ schemaVersion: 1, duration: 0, glyphs: 0, fontVariable: false }))
    expect(sourceFacts(metadata, { locale: 'en-US' })).toEqual([
      { key: 'duration', label: 'Duration', value: '0 s' },
      { key: 'glyphs', label: 'Glyphs', value: '0' },
      { key: 'fontVariable', label: 'Variable font', value: 'No' }
    ])
  })

  for (const { name, bytes } of [
    { name: 'one byte below the response limit', bytes: MAX_METADATA_BYTES - 1 },
    { name: 'the exact response limit', bytes: MAX_METADATA_BYTES }
  ]) {
    it(`accepts ${name}`, async () => {
      await expect(loadResponse(new Response(payload(bytes)))).resolves.toEqual({ schemaVersion: 1, format: 'PSD' })
    })
  }

  it('rejects one byte beyond the response limit', async () => {
    await expect(loadResponse(new Response(payload(MAX_METADATA_BYTES + 1)))).rejects.toThrow('too large')
  })

  it('counts multibyte text against the byte limit', async () => {
    const body = JSON.stringify({ schemaVersion: 1, colorProfile: '界'.repeat(6000) })
    expect(body.length).toBeLessThan(MAX_METADATA_BYTES)
    await expect(loadResponse(new Response(body))).rejects.toThrow('too large')
  })

  it('stops reading an oversized streamed response', async () => {
    const canceled = vi.fn()
    let chunk = 0
    const response = new Response(new ReadableStream({
      pull(controller) {
        ++chunk
        controller.enqueue(new Uint8Array(8192))
      },
      cancel: canceled
    }))
    await expect(loadResponse(response)).rejects.toThrow('too large')
    expect(canceled).toHaveBeenCalledOnce()
    expect(chunk).toBeLessThanOrEqual(4)
  })

  it('refuses a declared oversized response before consuming its body', async () => {
    const response = new Response('{}', { headers: { 'content-length': String(MAX_METADATA_BYTES + 1) } })
    const reader = vi.spyOn(response.body, 'getReader')
    await expect(loadResponse(response)).rejects.toThrow('too large')
    expect(reader).not.toHaveBeenCalled()
  })

  it('rejects invalid UTF-8 before displaying facts', async () => {
    const bytes = new Uint8Array([0xc3, 0x28])
    await expect(loadResponse(new Response(bytes))).rejects.toThrow()
  })
})

describe('file information formatting', () => {
  for (const { name, value, expected } of [
    { name: 'empty file', value: 0, expected: '0 B' },
    { name: 'bytes below one KiB', value: 1023, expected: '1,023 B' },
    { name: 'exactly one KiB', value: 1024, expected: '1 KiB' },
    { name: 'fractional KiB', value: 1536, expected: '1.5 KiB' },
    { name: 'WebDAV byte string', value: '2097152', expected: '2 MiB' },
    { name: 'missing size', value: undefined, expected: '' },
    { name: 'empty size string', value: '', expected: '' },
    { name: 'negative size', value: -1, expected: '' },
    { name: 'nonintegral bytes', value: 1.5, expected: '' }
  ]) {
    it(`formats ${name}`, () => {
      expect(formatFileSize(value, 'en-US')).toBe(expected)
    })
  }

  for (const { name, value, expected } of [
    { name: 'zero duration', value: 0, expected: '0 s' },
    { name: 'subsecond duration', value: .25, expected: '0.25 s' },
    { name: 'duration below one minute', value: 59, expected: '59 s' },
    { name: 'exact minute duration', value: 60, expected: '1 min' },
    { name: 'duration above one minute', value: 61, expected: '1 min 1 s' },
    { name: 'hour duration', value: 3661.5, expected: '1 hr 1 min 1.5 s' },
    { name: 'rounded minute duration', value: 59.999, expected: '1 min' },
    { name: 'missing duration', value: undefined, expected: '' },
    { name: 'negative duration', value: -1, expected: '' }
  ]) {
    it(`formats ${name}`, () => {
      expect(formatDuration(value, 'en-US')).toBe(expected)
    })
  }

  it('formats ordinary resource facts without guessing source properties', () => {
    const facts = fileFacts({
      name: 'poster.ai', size: '1536', mimeType: 'application/postscript',
      mdate: '2026-09-20T10:30:00Z', image: { width: 2048, height: 1024 }
    }, { locale: 'en-US', timeZone: 'UTC' })
    expect(facts).toEqual([
      { key: 'name', label: 'Name', value: 'poster.ai' },
      { key: 'size', label: 'File size', value: '1.5 KiB' },
      { key: 'type', label: 'Type', value: 'application/postscript' },
      { key: 'modified', label: 'Modified', value: 'Sep 20, 2026, 10:30 AM', dateTime: '2026-09-20T10:30:00.000Z' }
    ])
  })

  it('omits missing resource facts', () => {
    expect(fileFacts({ name: 'untitled', mdate: 'invalid', size: -1 })).toEqual([
      { key: 'name', label: 'Name', value: 'untitled' }
    ])
  })

  it('falls back to the resource extension for its type', () => {
    expect(fileFacts({ extension: '.psd' })).toContainEqual({ key: 'type', label: 'Type', value: 'PSD file' })
  })

  it('labels source pixel dimensions separately from page points', () => {
    const facts = sourceFacts(parseMetadata(JSON.stringify({
      schemaVersion: 1, width: 6000, height: 4000, pageWidth: 612, pageHeight: 792
    })), { locale: 'en-US' })
    expect(facts).toEqual([
      { key: 'dimensions', label: 'Source dimensions', value: '6,000 × 4,000 px' },
      { key: 'pageSize', label: 'Page size', value: '612 × 792 pt' }
    ])
  })

  it('displays a known dimension without inventing its missing partner', () => {
    expect(sourceFacts({ schemaVersion: 1, width: 6000, pageHeight: 792 }, { locale: 'en-US' })).toEqual([
      { key: 'width', label: 'Source width', value: '6,000 px' },
      { key: 'pageHeight', label: 'Page height', value: '792 pt' }
    ])
  })

  it('formats the available extraction fields with their source units', () => {
    const facts = sourceFacts(parseMetadata(JSON.stringify({
      schemaVersion: 1, format: 'MOV', colorSpace: 'YCbCr', colorProfile: 'Display P3', bitDepth: 10,
      pages: 2, duration: 90, videoCodec: 'hevc', audioCodec: 'aac', frameRate: 29.97,
      sampleRate: 44100, channels: 2, fontFamily: 'DejaVu Sans', fontStyle: 'Book',
      fontFullName: 'DejaVu Sans Book', fontVersion: 'Version 2.37', glyphs: 6253,
      fontFaces: 1, fontVariable: true
    })), { locale: 'en-US' })
    expect(Object.fromEntries(facts.map(({ label, value }) => [label, value]))).toEqual({
      Format: 'MOV', 'Color space': 'YCbCr', 'Color profile': 'Display P3', 'Bit depth': '10 bit',
      Pages: '2', Duration: '1 min 30 s', 'Video codec': 'hevc', 'Audio codec': 'aac', 'Frame rate': '29.97 fps',
      'Sample rate': '44.1 kHz', 'Audio channels': '2', 'Font family': 'DejaVu Sans', 'Font style': 'Book',
      'Full font name': 'DejaVu Sans Book', 'Font version': 'Version 2.37', Glyphs: '6,253',
      'Font faces': '1', 'Variable font': 'Yes'
    })
  })
})
