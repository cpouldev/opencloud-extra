<template>
  <section class="extra-preview" :class="$attrs.class" data-testid="extra-preview" aria-label="Rendered file preview">
    <div class="extra-preview-toolbar" role="toolbar" aria-label="Preview controls">
      <div class="extra-preview-title">
        <strong>{{ resource?.name || 'Rendered preview' }}</strong>
        <span>{{ description }}</span>
      </div>
      <div class="extra-preview-buttons">
        <button type="button" aria-label="Zoom out" :disabled="!ready || zoom <= MIN_ZOOM" @click="setZoom(zoom / 1.25)">−</button>
        <output data-testid="extra-preview-zoom" aria-label="Zoom level" aria-live="polite">{{ Math.round(zoom * 100) }}%</output>
        <button type="button" aria-label="Zoom in" :disabled="!ready || zoom >= MAX_ZOOM" @click="setZoom(zoom * 1.25)">+</button>
        <button type="button" :disabled="!ready" @click="fit">Fit to window</button>
        <button type="button" :disabled="!ready" @click="setZoom(1)">Actual size</button>
        <button type="button" aria-label="Close preview" @click="$emit('close')">Close</button>
      </div>
    </div>
    <div
      ref="stage"
      class="extra-preview-stage"
      :class="{ 'extra-preview-draggable': ready && canPan, 'extra-preview-dragging': dragging }"
      data-testid="extra-preview-stage"
      tabindex="0"
      aria-label="Preview image. Use plus and minus to zoom, arrow keys to pan, and zero to fit."
      :aria-busy="status === 'loading'"
      @keydown="onKeydown"
      @pointerdown="startPan"
      @pointermove="movePan"
      @pointerup="stopPan"
      @pointercancel="stopPan"
      @lostpointercapture="stopPan"
    >
      <div v-if="status === 'loading'" class="extra-preview-message" data-testid="extra-preview-loading" role="status">
        <span class="extra-preview-spinner" aria-hidden="true"></span>
        <strong>Generating preview…</strong>
        <span>The first preview can take a little longer.</span>
      </div>
      <div v-if="status === 'error'" class="extra-preview-message" data-testid="extra-preview-error" role="alert">
        <strong>Preview unavailable</strong>
        <p>{{ failure }}</p>
        <p v-if="!blocked">{{ hint }}</p>
        <button v-if="!blocked" type="button" aria-label="Retry preview" @click="load">Try again</button>
      </div>
      <img
        v-if="source"
        :key="source"
        class="extra-preview-image"
        :class="{ 'extra-preview-image-loading': !ready }"
        data-testid="extra-preview-image"
        :src="source"
        :alt="`Rendered preview of ${resource?.name || 'file'}`"
        draggable="false"
        :style="imageStyle"
        @load="imageLoaded"
        @error="imageFailed"
      />
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { usePreviewService } from '@opencloud-eu/web-pkg'
import { conversionHint, previewDescription, unavailableReason } from './formats.js'
import { clampZoom, constrainPan, fitZoom, MAX_ZOOM, MIN_ZOOM } from './viewport.js'

defineOptions({ inheritAttrs: false })

// AppWrapper uses the declared props to decide what to fetch. Do not add `url`
// or `currentContent`: either would download the complete original file.
const props = defineProps({ resource: Object, space: Object })
const emit = defineEmits(['close'])
const previewService = usePreviewService()
const stage = ref(null)
const source = ref('')
const status = ref('loading')
const failure = ref('')
const zoom = ref(1)
const pan = reactive({ x: 0, y: 0 })
const viewport = reactive({ width: 0, height: 0 })
const dimensions = reactive({ width: 0, height: 0 })
const dragging = ref(false)
let drag = null
let fitMode = true
let controller = null
let observer = null
let generation = 0

const ready = computed(() => status.value === 'ready')
const blocked = computed(() => unavailableReason(props.resource))
const description = computed(() => previewDescription(props.resource))
const hint = computed(() => conversionHint(props.resource))
const canPan = computed(() => dimensions.width * zoom.value > viewport.width || dimensions.height * zoom.value > viewport.height)
const imageStyle = computed(() => ({
  width: `${dimensions.width}px`,
  height: `${dimensions.height}px`,
  transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom.value})`
}))

function revoke(url) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}

function clearSource() {
  revoke(source.value)
  source.value = ''
}

async function load() {
  const request = ++generation
  controller?.abort()
  clearSource()
  stopPan()
  status.value = 'loading'
  failure.value = ''
  dimensions.width = dimensions.height = 0
  zoom.value = 1
  fitMode = true
  pan.x = pan.y = 0

  if (!props.resource || !props.space) return
  if (blocked.value) {
    failure.value = blocked.value
    status.value = 'error'
    return
  }

  controller = new AbortController()
  const { signal } = controller
  try {
    const url = await previewService.loadPreview({
      space: props.space,
      resource: props.resource,
      dimensions: [2048, 2048],
      processor: 'fit'
    }, false, false, signal)

    // Keep ownership of our URLs outside the shared client-side thumbnail
    // cache. The server cache still handles repeat rendering requests.
    if (signal.aborted || request !== generation) {
      revoke(url)
      return
    }
    if (!url) throw new Error('No preview was returned')
    source.value = url
  } catch (error) {
    if (signal.aborted || request !== generation) return
    const statusCode = error?.response?.status || error?.status
    failure.value = [401, 403].includes(statusCode)
      ? 'You do not have permission to preview this file, or your session has expired.'
      : 'OpenCloud could not generate a preview for this file.'
    status.value = 'error'
  }
}

function imageLoaded(event) {
  dimensions.width = event.target.naturalWidth
  dimensions.height = event.target.naturalHeight
  status.value = 'ready'
  measure()
  fit()
  nextTick(() => stage.value?.focus({ preventScroll: true }))
}

function imageFailed() {
  clearSource()
  failure.value = 'The rendered image could not be loaded.'
  status.value = 'error'
}

function measure() {
  if (!stage.value) return
  viewport.width = stage.value.clientWidth
  viewport.height = stage.value.clientHeight
  if (fitMode) fit()
  else Object.assign(pan, constrainPan(pan, viewport, dimensions, zoom.value))
}

function fit() {
  fitMode = true
  zoom.value = fitZoom(viewport, dimensions)
  pan.x = pan.y = 0
}

function setZoom(value) {
  if (!ready.value) return
  fitMode = false
  zoom.value = clampZoom(value)
  Object.assign(pan, constrainPan(pan, viewport, dimensions, zoom.value))
}

function startPan(event) {
  if (!ready.value || !canPan.value || event.button !== 0) return
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
  dragging.value = true
  stage.value.setPointerCapture(event.pointerId)
}

function movePan(event) {
  if (!drag || event.pointerId !== drag.id) return
  Object.assign(pan, constrainPan({
    x: drag.panX + event.clientX - drag.x,
    y: drag.panY + event.clientY - drag.y
  }, viewport, dimensions, zoom.value))
}

function stopPan() {
  const pointerId = drag?.id
  drag = null
  dragging.value = false
  if (pointerId !== undefined && stage.value?.hasPointerCapture(pointerId)) {
    stage.value.releasePointerCapture(pointerId)
  }
}

function onKeydown(event) {
  if (event.target !== stage.value || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (!ready.value) return
  if (event.key === '+' || event.key === '=') setZoom(zoom.value * 1.25)
  else if (event.key === '-') setZoom(zoom.value / 1.25)
  else if (event.key === '0') fit()
  else if (event.key.startsWith('Arrow')) {
    const moves = { ArrowLeft: [64, 0], ArrowRight: [-64, 0], ArrowUp: [0, 64], ArrowDown: [0, -64] }
    const [x, y] = moves[event.key] || [0, 0]
    Object.assign(pan, constrainPan({ x: pan.x + x, y: pan.y + y }, viewport, dimensions, zoom.value))
  } else return
  event.preventDefault()
}

watch(() => [props.resource?.id, props.resource?.etag, props.space?.id, props.resource?.isInVault, props.resource?.permissions], load, { immediate: true })

onMounted(() => {
  observer = new ResizeObserver(measure)
  observer.observe(stage.value)
  measure()
})

onBeforeUnmount(() => {
  generation++
  controller?.abort()
  observer?.disconnect()
  stopPan()
  clearSource()
})
</script>

<style>
.extra-preview {
  --extra-surface: var(--oc-role-surface, #fff);
  --extra-ink: var(--oc-role-on-surface, #192f38);
  --extra-border: var(--oc-role-outline-variant, #c7d1d5);
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  height: 100%;
  min-height: 0;
  color: var(--extra-ink);
  background: var(--extra-surface);
}
.extra-preview-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--extra-border); }
.extra-preview-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; overflow-wrap: anywhere; }
.extra-preview-title span { font-size: 12px; opacity: .78; }
.extra-preview-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.extra-preview button { min-height: 36px; min-width: 36px; padding: 6px 10px; border: 1px solid var(--extra-border); border-radius: 5px; color: inherit; background: var(--extra-surface); font: inherit; cursor: pointer; }
.extra-preview button:hover:not(:disabled) { background: var(--oc-role-surface-container, #edf3f5); }
.extra-preview button:disabled { opacity: .45; cursor: default; }
.extra-preview button:focus-visible, .extra-preview-stage:focus-visible { outline: 2px solid var(--oc-role-primary, #236375); outline-offset: -2px; }
.extra-preview output { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
.extra-preview-stage { position: relative; flex: 1; overflow: hidden; min-height: 160px; background: var(--oc-role-surface-container-low, #eef1f3); touch-action: none; }
.extra-preview-draggable { cursor: grab; }
.extra-preview-dragging { cursor: grabbing; }
.extra-preview-image { position: absolute; top: 50%; left: 50%; max-width: none; max-height: none; object-fit: contain; transform-origin: center; user-select: none; background: white; box-shadow: 0 2px 14px #0002; }
.extra-preview-image-loading { visibility: hidden; }
.extra-preview-message { position: absolute; inset: 0; padding: 24px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; text-align: center; }
.extra-preview-message p { margin: 0; max-width: 560px; }
.extra-preview-spinner { width: 28px; height: 28px; border: 3px solid var(--extra-border); border-top-color: var(--extra-ink); border-radius: 50%; animation: extra-preview-spin 1s linear infinite; }
@keyframes extra-preview-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .extra-preview-spinner { animation: none; } }
@media (max-width: 600px) { .extra-preview-toolbar { padding: 8px; } .extra-preview-buttons { gap: 5px; } .extra-preview button { min-height: 40px; } }
</style>
