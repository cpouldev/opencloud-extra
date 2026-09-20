<template>
  <template v-if="visible">
    <template v-if="status === 'ready' && facts.length">
      <template v-for="fact in facts" :key="fact.key">
        <dt class="extra-source-label" :data-extra-source-field="fact.key">{{ fact.label }}</dt>
        <dd class="extra-source-value" :data-testid="`extra-source-${fact.key}`">{{ fact.value }}</dd>
      </template>
    </template>
    <template v-else>
      <dt>Source details</dt>
      <dd class="extra-source-value" :aria-busy="status === 'loading'">
        <span v-if="status === 'loading'" role="status" data-testid="extra-asset-info-loading">
          Loading source information…
        </span>
        <span v-else-if="status === 'error' || status === 'blocked'" role="status" data-testid="extra-asset-info-error">
          {{ failure }}
          <oc-button v-if="status === 'error'" appearance="raw" class="block mt-2"
            aria-label="Retry file information" @click="load">Try again</oc-button>
        </span>
        <span v-else data-testid="extra-asset-info-empty">
          No additional source details are available for this file.
        </span>
      </dd>
    </template>
  </template>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, ref, toRaw, unref, watch } from 'vue'
import { usePreviewService, useSelectedResources } from '@opencloud-eu/web-pkg'
import { extensionOf, fallbackExtensions, mediaFallbackExtensions, previewExtensions } from './formats.js'
import { loadMetadata, metadataUnavailableReason, sourceFacts } from './metadata.js'

// Native FileSideBar supplies these refs to its Details extension point. It
// mounts Details on demand and updates the resource when the gallery moves.
const injectedResource = inject('resource', ref(null))
const space = inject('space', ref(null))
const { selectedResources, selectedResourceSpace } = useSelectedResources()
const resource = computed(() => {
  const loaded = unref(injectedResource)
  const selection = unref(selectedResources)
  if (!loaded || !selection.length) return loaded
  const current = selection[0]
  const selectedSpace = unref(selectedResourceSpace)
  const detailsSpace = unref(space)
  if (selection.length !== 1 || current.id !== loaded.id || !selectedSpace?.id ||
    selectedSpace.id !== detailsSpace?.id || selectedSpace.driveType !== detailsSpace.driveType ||
    selectedSpace.driveAlias !== detailsSpace.driveAlias) return null
  // FileSideBar caches its injected object by ID. Keep its extra share fields,
  // but prefer the current revision/permissions from the same selected file.
  return toRaw(loaded) === toRaw(current) ? current : { ...loaded, ...current }
})
const previewService = usePreviewService()
// These source families match LookupMetadata in the thumbnails service.
// Office/archive/EPUB previews have no additional source extractor.
const excludedExtensions = new Set([
  ...fallbackExtensions, 'kra', 'ora', 'sketch', 'cbz', 'cbr',
  'eps', 'ps', 'stl', 'obj', 'gltf', 'glb'
])
const supportedExtensions = new Set([
  ...previewExtensions, ...mediaFallbackExtensions,
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'pdf'
])
const nativeMetadataMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/x-ms-bmp',
  'image/tiff', 'image/webp', 'image/svg+xml',
  'audio/flac', 'audio/x-flac', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav',
  'video/mp4', 'video/quicktime', 'video/webm'
])
const visible = computed(() => {
  const file = unref(resource)
  const extension = extensionOf(file)
  const mimeType = file?.mimeType?.split(';')[0].trim().toLowerCase()
  return Boolean(file?.id && !file.isFolder && !file.driveType &&
    (!file.type || file.type === 'file') && !Object.hasOwn(file, 'ddate') &&
    !excludedExtensions.has(extension) &&
    (supportedExtensions.has(extension) || nativeMetadataMimeTypes.has(mimeType)))
})
const status = ref('loading')
const failure = ref('')
const metadata = ref(null)
const facts = computed(() => sourceFacts(metadata.value))
const blocked = computed(() => metadataUnavailableReason(unref(resource)))
let controller
let generation = 0

async function load() {
  const request = ++generation
  controller?.abort()
  metadata.value = null
  failure.value = ''
  if (!visible.value) return
  if (blocked.value || !unref(space)) {
    status.value = 'blocked'
    failure.value = blocked.value || 'The file location is unavailable.'
    return
  }
  status.value = 'loading'
  controller = new AbortController()
  const { signal } = controller
  try {
    const result = await loadMetadata(previewService, {
      resource: unref(resource), space: unref(space)
    }, signal)
    if (signal.aborted || request !== generation) return
    metadata.value = result
    status.value = 'ready'
  } catch (error) {
    if (signal.aborted || request !== generation) return
    const code = error?.response?.status || error?.status
    if ([401, 403].includes(code)) {
      failure.value = 'You do not have permission to view source information, or your session has expired.'
    } else if (code === 413) {
      failure.value = 'This file is too large to inspect. You can still use the preview.'
    } else {
      failure.value = 'Source information could not be loaded. You can still use the preview.'
    }
    status.value = 'error'
  }
}

watch(() => [
  unref(resource), unref(resource)?.id, unref(resource)?.etag, unref(resource)?.name,
  unref(resource)?.permissions, unref(space), unref(space)?.id, visible.value, blocked.value
], load, { immediate: true })

onBeforeUnmount(() => {
  ++generation
  controller?.abort()
})
</script>

<style scoped>
.extra-source-value {
  min-width: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  user-select: text;
}
</style>
