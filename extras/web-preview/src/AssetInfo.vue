<template>
  <aside class="extra-asset-info" data-testid="extra-asset-info" :aria-labelledby="headingId">
    <div class="extra-asset-info-heading">
      <h2 :id="headingId">File information</h2>
      <button type="button" aria-label="Close file information" @click="$emit('close')">Close</button>
    </div>
    <dl v-if="ordinaryFacts.length" class="extra-asset-info-facts" data-testid="extra-asset-file-facts">
      <template v-for="fact in ordinaryFacts" :key="fact.key">
        <dt>{{ fact.label }}</dt>
        <dd>
          <time v-if="fact.dateTime" :datetime="fact.dateTime">{{ fact.value }}</time>
          <template v-else>{{ fact.value }}</template>
        </dd>
      </template>
    </dl>

    <section class="extra-asset-source" :aria-labelledby="sourceHeadingId" :aria-busy="status === 'loading'">
      <h3 :id="sourceHeadingId">Source details</h3>
      <p v-if="status === 'loading'" class="extra-asset-info-message" role="status" data-testid="extra-asset-info-loading">
        Loading source information…
      </p>
      <div v-else-if="status === 'error' || status === 'blocked'" class="extra-asset-info-message" role="status" data-testid="extra-asset-info-error">
        <p>{{ failure }}</p>
        <button v-if="status === 'error'" type="button" aria-label="Retry file information" @click="load">Try again</button>
      </div>
      <dl v-else-if="extractedFacts.length" class="extra-asset-info-facts" data-testid="extra-asset-source-facts">
        <template v-for="fact in extractedFacts" :key="fact.key">
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </template>
      </dl>
      <p v-else class="extra-asset-info-message" data-testid="extra-asset-info-empty">
        No additional source details are available for this file.
      </p>
    </section>
  </aside>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { usePreviewService } from '@opencloud-eu/web-pkg'
import { fileFacts, loadMetadata, metadataUnavailableReason, sourceFacts } from './metadata.js'

// The parent mounts this panel only after Info is opened. Declaring only these
// props also avoids the host wrapper's original-file download props.
const props = defineProps({ resource: Object, space: Object })
defineEmits(['close'])
const previewService = usePreviewService()
const headingId = `extra-asset-info-${useId()}`
const sourceHeadingId = `${headingId}-source`
const status = ref('loading')
const failure = ref('')
const metadata = ref(null)
const ordinaryFacts = computed(() => fileFacts(props.resource))
const extractedFacts = computed(() => sourceFacts(metadata.value))
const blocked = computed(() => metadataUnavailableReason(props.resource))
let controller
let generation = 0

async function load() {
  const request = ++generation
  controller?.abort()
  metadata.value = null
  failure.value = ''
  if (blocked.value || !props.space) {
    status.value = 'blocked'
    failure.value = blocked.value || 'The file location is unavailable.'
    return
  }
  status.value = 'loading'
  controller = new AbortController()
  const { signal } = controller
  try {
    const result = await loadMetadata(previewService, {
      resource: props.resource, space: props.space
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
  props.resource, props.resource?.id, props.resource?.etag, props.resource?.name,
  props.resource?.permissions, props.space, props.space?.id, blocked.value
], load, { immediate: true })

onBeforeUnmount(() => {
  ++generation
  controller?.abort()
})
</script>

<style scoped>
.extra-asset-info {
  box-sizing: border-box;
  flex: 0 0 22rem;
  width: 22rem;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 1rem;
  border-inline-start: 1px solid var(--extra-border, var(--oc-role-outline-variant, #c7d1d5));
  color: var(--extra-ink, var(--oc-role-on-surface, #192f38));
  background: var(--extra-surface, var(--oc-role-surface, #fff));
  font-size: .875rem;
  overflow-wrap: anywhere;
  user-select: text;
}
.extra-asset-info-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.extra-asset-info h2 { margin: 0; font-size: 1rem; font-weight: 600; line-height: 1.4; }
.extra-asset-info h3 { margin: 0 0 .875rem; font-size: .875rem; font-weight: 600; }
.extra-asset-info-facts { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.4fr); gap: .75rem 1rem; margin: 0; line-height: 1.5; }
.extra-asset-info-facts dt { margin: 0; color: var(--oc-role-on-surface-variant, #50616a); }
.extra-asset-info-facts dd { min-width: 0; margin: 0; font-variant-numeric: tabular-nums; }
.extra-asset-source { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--extra-border, var(--oc-role-outline-variant, #c7d1d5)); }
.extra-asset-info-message { margin: 0; line-height: 1.5; }
.extra-asset-info-message p { margin: 0 0 .75rem; }
.extra-asset-info button { flex-shrink: 0; min-height: 36px; padding: 6px 10px; border: 1px solid var(--extra-border, var(--oc-role-outline-variant, #c7d1d5)); border-radius: 5px; color: inherit; background: var(--extra-surface, var(--oc-role-surface, #fff)); font: inherit; cursor: pointer; }
.extra-asset-info button:hover { background: var(--oc-role-surface-container, #edf3f5); }
.extra-asset-info button:focus-visible { outline: 2px solid var(--oc-role-primary, #236375); outline-offset: 2px; }
@media (max-width: 700px) {
  .extra-asset-info { flex-basis: auto; width: 100%; max-height: 45vh; border-inline-start: 0; border-top: 1px solid var(--extra-border, var(--oc-role-outline-variant, #c7d1d5)); }
  .extra-asset-info button { min-height: 40px; }
}
</style>
