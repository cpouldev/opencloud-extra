import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Preview from '../src/Preview.vue'

const file = (changes = {}) => ({
  id: 'file-a', name: 'artwork.ai', extension: 'ai', etag: 'etag-a',
  permissions: 'RDNVW', canDownload: () => true, hasPreview: () => true,
  ...changes
})
const space = { id: 'space-a' }
let wrapper
let loadPreview
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

function render(resource = file()) {
  wrapper = mount(Preview, { props: { resource, space } })
  Object.defineProperties(wrapper.get('[data-testid="extra-preview-stage"]').element, {
    clientWidth: { value: 1000, configurable: true },
    clientHeight: { value: 600, configurable: true }
  })
  return wrapper
}

async function imageReady(width = 2048, height = 1024) {
  await flushPromises()
  const image = wrapper.get('[data-testid="extra-preview-image"]')
  Object.defineProperties(image.element, {
    naturalWidth: { value: width }, naturalHeight: { value: height }
  })
  await image.trigger('load')
  return image
}

beforeEach(() => {
  loadPreview = vi.fn().mockResolvedValue('blob:preview-a')
  globalThis.__extraPreviewService = { loadPreview }
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete globalThis.__extraPreviewService
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('rendered preview', () => {
  it('waits for a 2048-pixel fitted preview to finish loading', async () => {
    const request = deferred()
    loadPreview.mockReturnValue(request.promise)
    render()
    expect(wrapper.get('[data-testid="extra-preview-loading"]').text()).toContain('Generating preview')
    expect(wrapper.get('[aria-label="Zoom in"]').attributes('disabled')).toBeDefined()
    const [options, cache, silenceErrors, signal] = loadPreview.mock.calls[0]
    expect(options).toMatchObject({ resource: { id: 'file-a' }, space, dimensions: [2048, 2048], processor: 'fit' })
    expect([cache, silenceErrors]).toEqual([false, false])
    expect(signal.aborted).toBe(false)

    request.resolve('blob:preview-a')
    await flushPromises()
    expect(wrapper.find('[data-testid="extra-preview-loading"]').exists()).toBe(true)
    await imageReady()
    expect(wrapper.find('[data-testid="extra-preview-loading"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="extra-preview-image"]').attributes('alt')).toBe('Rendered preview of artwork.ai')
    expect(wrapper.get('[data-testid="extra-preview-zoom"]').text()).toBe('49%')
  })

  it('zooms the image then restores its fit', async () => {
    render()
    const image = await imageReady()
    await wrapper.get('[aria-label="Zoom in"]').trigger('click')
    expect(wrapper.get('[data-testid="extra-preview-zoom"]').text()).toBe('61%')
    expect(image.attributes('style')).toContain('scale(0.6103515625)')
    const fit = wrapper.findAll('button').find((button) => button.text() === 'Fit to window')
    await fit.trigger('click')
    expect(wrapper.get('[data-testid="extra-preview-zoom"]').text()).toBe('49%')
  })

  it('supports keyboard panning at actual size', async () => {
    render()
    const image = await imageReady()
    await wrapper.findAll('button').find((button) => button.text() === 'Actual size').trigger('click')
    const stage = wrapper.get('[data-testid="extra-preview-stage"]')
    await stage.trigger('keydown', { key: 'ArrowRight' })
    expect(image.attributes('style')).toContain('calc(-50% + -64px)')
    await stage.trigger('keydown', { key: '0' })
    expect(image.attributes('style')).toContain('calc(-50% + 0px)')
    expect(wrapper.get('[data-testid="extra-preview-zoom"]').text()).toBe('49%')
  })

  it('pans with a captured pointer until it is released', async () => {
    render()
    const image = await imageReady()
    await wrapper.findAll('button').find((button) => button.text() === 'Actual size').trigger('click')
    const stage = wrapper.get('[data-testid="extra-preview-stage"]')
    stage.element.setPointerCapture = vi.fn()
    stage.element.hasPointerCapture = () => true
    stage.element.releasePointerCapture = vi.fn()
    await stage.trigger('pointerdown', { pointerId: 7, button: 0, clientX: 100, clientY: 100 })
    await stage.trigger('pointermove', { pointerId: 7, clientX: 180, clientY: 140 })
    expect(image.attributes('style')).toContain('calc(-50% + 80px)')
    expect(image.attributes('style')).toContain('calc(-50% + 40px)')
    await stage.trigger('pointerup', { pointerId: 7 })
    expect(stage.element.releasePointerCapture).toHaveBeenCalledWith(7)
    await stage.trigger('pointermove', { pointerId: 7, clientX: 240, clientY: 220 })
    expect(image.attributes('style')).toContain('calc(-50% + 80px)')
  })

  it('delegates closing to the host wrapper', async () => {
    render()
    await wrapper.get('[aria-label="Close preview"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.get('[data-testid="extra-preview-stage"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('offers a retry with Illustrator-specific failure guidance', async () => {
    loadPreview.mockRejectedValueOnce(new Error('conversion failed'))
    render()
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-preview-error"]').text()).toContain('Create PDF Compatible File')
    await wrapper.get('[aria-label="Retry preview"]').trigger('click')
    await imageReady()
    expect(loadPreview).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="extra-preview-error"]').exists()).toBe(false)
  })

  it('shows a failure when the endpoint has no preview', async () => {
    loadPreview.mockResolvedValue(undefined)
    render()
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-preview-error"]').text()).toContain('could not generate a preview')
    expect(wrapper.find('[data-testid="extra-preview-image"]').exists()).toBe(false)
  })

  it('shows an expired-session error', async () => {
    loadPreview.mockRejectedValue({ response: { status: 401 } })
    render()
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-preview-error"]').text()).toContain('session has expired')
  })

  it('revokes an image that cannot be displayed', async () => {
    render()
    await flushPromises()
    await wrapper.get('[data-testid="extra-preview-image"]').trigger('error')
    expect(wrapper.get('[data-testid="extra-preview-error"]').text()).toContain('could not be loaded')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-a')
  })

  for (const { name, resource, expected } of [
    { name: 'denied download permission', resource: file({ canDownload: () => false }), expected: 'permission' },
    { name: 'encrypted vault content', resource: file({ isInVault: true }), expected: 'Encrypted files' }
  ]) {
    it(`does not request a preview for ${name}`, async () => {
      render(resource)
      await flushPromises()
      expect(loadPreview).not.toHaveBeenCalled()
      expect(wrapper.get('[data-testid="extra-preview-error"]').text()).toContain(expected)
      expect(wrapper.find('[aria-label="Retry preview"]').exists()).toBe(false)
    })
  }

  it('aborts pending work when navigating to a different file', async () => {
    const pending = deferred()
    loadPreview.mockReturnValueOnce(pending.promise).mockResolvedValueOnce('blob:preview-b')
    render()
    const signal = loadPreview.mock.calls[0][3]
    await wrapper.setProps({ resource: file({ id: 'file-b', name: 'other.psd', extension: 'psd' }) })
    expect(signal.aborted).toBe(true)
    pending.resolve('blob:stale-preview')
    await flushPromises()
    expect(wrapper.get('[data-testid="extra-preview-image"]').attributes('src')).toBe('blob:preview-b')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stale-preview')
  })

  it('releases the displayed blob when leaving the viewer', async () => {
    render()
    await imageReady()
    const signal = loadPreview.mock.calls[0][3]
    wrapper.unmount()
    wrapper = null
    expect(signal.aborted).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-a')
  })

  it('discards a pending response after leaving the viewer', async () => {
    const pending = deferred()
    loadPreview.mockReturnValue(pending.promise)
    render()
    wrapper.unmount()
    wrapper = null
    pending.resolve('blob:late-preview')
    await flushPromises()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:late-preview')
  })

  it('uses public preview URLs without revoking them as blobs', async () => {
    loadPreview.mockResolvedValue('https://example.test/preview?signature=signed')
    render()
    await imageReady()
    expect(wrapper.get('[data-testid="extra-preview-image"]').attributes('src')).toBe('https://example.test/preview?signature=signed')
    wrapper.unmount()
    wrapper = null
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })
})
