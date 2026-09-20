import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AssetInfo from '../src/AssetInfo.vue'

const file = (changes = {}) => ({
  id: 'file-a', name: 'artwork.ai', etag: 'etag-a', extension: 'ai',
  size: 1536, mimeType: 'application/postscript', mdate: '2026-09-20T10:30:00Z',
  permissions: 'RDNVW', canDownload: () => true, ...changes
})
const space = { id: 'space-a' }
const response = (metadata = { width: 6000, height: 4000 }) => new Response(JSON.stringify({ schemaVersion: 1, ...metadata }))
let wrapper
let loadPreview
let fetchMetadata
let revokeObjectURL

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function render(resource = file(), selectedSpace = space) {
  wrapper = mount(AssetInfo, { props: { resource, space: selectedSpace } })
  return wrapper
}

beforeEach(() => {
  loadPreview = vi.fn().mockResolvedValue('blob:metadata-a')
  globalThis.__extraPreviewService = { loadPreview }
  fetchMetadata = vi.fn().mockImplementation(() => Promise.resolve(response()))
  vi.stubGlobal('fetch', fetchMetadata)
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete globalThis.__extraPreviewService
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('asset information panel', () => {
  it('shows ordinary file facts while source information loads', async () => {
    loadPreview.mockReturnValue(deferred().promise)
    render()
    expect(wrapper.get('h2').text()).toBe('File information')
    expect(wrapper.get('[data-testid="extra-asset-info-loading"]').attributes('role')).toBe('status')
    const facts = wrapper.get('[data-testid="extra-asset-file-facts"]').text()
    expect(facts).toContain('artwork.ai')
    expect(facts).toContain('1.5 KiB')
    expect(facts).toContain('application/postscript')
    expect(wrapper.get('time').attributes('datetime')).toBe('2026-09-20T10:30:00.000Z')
    expect(fetchMetadata).not.toHaveBeenCalled()
  })

  it('uses the authenticated metadata preview processor', async () => {
    render()
    await flushPromises()
    const [options, cached, silent, signal] = loadPreview.mock.calls[0]
    expect(options).toMatchObject({
      resource: { id: 'file-a' }, space, dimensions: [1, 1], processor: 'extra-metadata-v1'
    })
    expect([cached, silent]).toEqual([false, false])
    expect(fetchMetadata).toHaveBeenCalledWith('blob:metadata-a', { signal })
    expect(signal.aborted).toBe(false)
  })

  it('displays actual source dimensions instead of preview pixels', async () => {
    render(file({ image: { width: 2048, height: 1024 } }))
    await flushPromises()
    const facts = wrapper.get('[data-testid="extra-asset-source-facts"]').text()
    expect(facts).toContain('Source dimensions')
    expect(facts).toContain('6,000 × 4,000 px')
    expect(facts).not.toContain('2,048')
    expect(wrapper.find('[data-testid="extra-asset-info-loading"]').exists()).toBe(false)
  })

  it('displays names as safe untruncated text', async () => {
    const name = `${'very-long-'.repeat(30)}<img src=x onerror=alert(1)>.psd`
    fetchMetadata.mockResolvedValue(response({ colorProfile: '<script>alert(1)</script>' }))
    render(file({ name }))
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-asset-file-facts"]').text()).toContain(name)
    expect(wrapper.get('[data-testid="extra-asset-source-facts"]').text()).toContain('<script>alert(1)</script>')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('honestly reports missing extraction facts', async () => {
    fetchMetadata.mockResolvedValue(response({}))
    render()
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-asset-info-empty"]').text()).toContain('No additional source details')
    expect(wrapper.get('[data-testid="extra-asset-file-facts"]').text()).toContain('artwork.ai')
    expect(wrapper.find('[data-testid="extra-asset-source-facts"]').exists()).toBe(false)
  })

  it('revokes a successfully consumed blob URL', async () => {
    render()
    await flushPromises()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:metadata-a')
  })

  it('isolates metadata failures from the file preview', async () => {
    loadPreview.mockRejectedValue(new Error('failed'))
    render()
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-asset-info-error"]').text()).toContain('You can still use the preview')
    expect(wrapper.get('[data-testid="extra-asset-file-facts"]').text()).toContain('artwork.ai')
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('retries a failed metadata request', async () => {
    fetchMetadata.mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(response({ fontFamily: 'DejaVu Sans' }))
    render()
    await flushPromises()
    await wrapper.get('[aria-label="Retry file information"]').trigger('click')
    await flushPromises()
    expect(loadPreview).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="extra-asset-source-facts"]').text()).toContain('DejaVu Sans')
    expect(wrapper.find('[data-testid="extra-asset-info-error"]').exists()).toBe(false)
  })

  for (const code of [401, 403]) {
    it(`explains a ${code} response`, async () => {
      fetchMetadata.mockResolvedValue(new Response('', { status: code }))
      render()
      await flushPromises()
      expect(wrapper.get('[data-testid="extra-asset-info-error"]').text()).toContain('permission')
      expect(wrapper.get('[data-testid="extra-asset-info-error"]').text()).toContain('session has expired')
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:metadata-a')
    })
  }

  it('explains an oversized source file', async () => {
    fetchMetadata.mockResolvedValue(new Response('', { status: 413 }))
    render()
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-asset-info-error"]').text()).toContain('too large to inspect')
    expect(wrapper.get('[data-testid="extra-asset-file-facts"]').text()).toContain('artwork.ai')
  })

  for (const { name, resource, message } of [
    { name: 'download permission denied', resource: file({ canDownload: () => false }), message: 'permission' },
    { name: 'missing permission check', resource: file({ canDownload: undefined }), message: 'permission' },
    { name: 'unavailable permission context', resource: file({ canDownload: () => { throw new Error('not ready') } }), message: 'permission' },
    { name: 'encrypted vault file', resource: file({ isInVault: true }), message: 'encrypted' },
    { name: 'folder resource', resource: file({ isFolder: true }), message: 'available for files' }
  ]) {
    it(`makes no request for ${name}`, async () => {
      render(resource)
      await flushPromises()
      expect(loadPreview).not.toHaveBeenCalled()
      expect(fetchMetadata).not.toHaveBeenCalled()
      expect(wrapper.get('[data-testid="extra-asset-info-error"]').text()).toContain(message)
      expect(wrapper.find('[aria-label="Retry file information"]').exists()).toBe(false)
    })
  }

  it('waits for a file location before making a request', async () => {
    render(file(), null)
    await flushPromises()
    expect(loadPreview).not.toHaveBeenCalled()
    expect(fetchMetadata).not.toHaveBeenCalled()
  })

  it('discards a late SDK URL after navigation', async () => {
    const pending = deferred()
    loadPreview.mockReturnValueOnce(pending.promise).mockResolvedValueOnce('blob:metadata-b')
    fetchMetadata.mockResolvedValue(response({ fontFamily: 'New font' }))
    render()
    const signal = loadPreview.mock.calls[0][3]
    await wrapper.setProps({ resource: file({ id: 'file-b', name: 'new-font.otf' }) })
    pending.resolve('blob:stale-metadata')
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(fetchMetadata).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stale-metadata')
    expect(wrapper.get('[data-testid="extra-asset-source-facts"]').text()).toContain('New font')
  })

  it('prevents an old fetch from replacing the current source facts', async () => {
    const pending = deferred()
    loadPreview.mockResolvedValueOnce('blob:metadata-a').mockResolvedValueOnce('blob:metadata-b')
    fetchMetadata.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response({ fontFamily: 'New font' }))
    render()
    await flushPromises()
    const signal = fetchMetadata.mock.calls[0][1].signal
    await wrapper.setProps({ resource: file({ id: 'file-b', name: 'new-font.otf' }) })
    expect(signal.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:metadata-a')
    pending.resolve(response({ width: 9999, height: 9999 }))
    await flushPromises()
    const facts = wrapper.get('[data-testid="extra-asset-source-facts"]').text()
    expect(facts).toContain('New font')
    expect(facts).not.toContain('9,999')
    expect(revokeObjectURL.mock.calls.filter(([url]) => url === 'blob:metadata-a')).toHaveLength(1)
  })

  it('reloads metadata for a new source revision', async () => {
    render()
    await flushPromises()
    fetchMetadata.mockResolvedValueOnce(response({ width: 12000, height: 8000 }))
    await wrapper.setProps({ resource: file({ etag: 'etag-b' }) })
    await flushPromises()
    expect(loadPreview).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="extra-asset-source-facts"]').text()).toContain('12,000 × 8,000 px')
  })

  it('reloads metadata when the share location changes', async () => {
    render()
    await flushPromises()
    await wrapper.setProps({ space: { id: 'space-b' } })
    await flushPromises()
    expect(loadPreview).toHaveBeenCalledTimes(2)
    expect(loadPreview.mock.calls[1][0].space.id).toBe('space-b')
  })

  it('removes extracted facts when permission is revoked', async () => {
    render()
    await flushPromises()
    await wrapper.setProps({ resource: file({ canDownload: () => false }) })
    await flushPromises()
    expect(loadPreview).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="extra-asset-source-facts"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="extra-asset-info-error"]').text()).toContain('permission')
  })

  it('aborts the pending fetch when the panel closes', async () => {
    fetchMetadata.mockReturnValue(deferred().promise)
    render()
    await flushPromises()
    const signal = fetchMetadata.mock.calls[0][1].signal
    wrapper.unmount()
    wrapper = null
    expect(signal.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:metadata-a')
  })

  it('cancels an unfinished metadata body when the panel closes', async () => {
    const canceled = vi.fn()
    const pendingResponse = new Response(new ReadableStream({ cancel: canceled }))
    fetchMetadata.mockResolvedValue(pendingResponse)
    render()
    await flushPromises()
    wrapper.unmount()
    wrapper = null
    await flushPromises()
    expect(canceled).toHaveBeenCalledOnce()
    expect(pendingResponse.body.locked).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:metadata-a')
  })

  it('revokes a URL returned after the panel has closed', async () => {
    const pending = deferred()
    loadPreview.mockReturnValue(pending.promise)
    render()
    wrapper.unmount()
    wrapper = null
    pending.resolve('blob:late-metadata')
    await flushPromises()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:late-metadata')
    expect(fetchMetadata).not.toHaveBeenCalled()
  })

  it('revokes the blob for malformed JSON', async () => {
    fetchMetadata.mockResolvedValue(new Response('not JSON'))
    render()
    await flushPromises()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:metadata-a')
    expect(wrapper.find('[data-testid="extra-asset-info-error"]').exists()).toBe(true)
  })

  it('loads signed public URLs without revoking them', async () => {
    const url = 'https://example.test/preview?processor=extra-metadata-v1&signature=public'
    loadPreview.mockResolvedValue(url)
    render()
    await flushPromises()
    expect(fetchMetadata.mock.calls[0][0]).toBe(url)
    expect(wrapper.get('[data-testid="extra-asset-source-facts"]').text()).toContain('6,000 × 4,000 px')
    wrapper.unmount()
    wrapper = null
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('delegates panel visibility to its parent', async () => {
    render()
    await wrapper.get('[aria-label="Close file information"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
