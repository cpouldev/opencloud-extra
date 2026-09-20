import { defineConfig } from '@opencloud-eu/extension-sdk'

// The pinned host supplies Vue and web-pkg through Module Federation. The SDK
// emits the remote entry, its CSS dependencies and OpenCloud's app manifest.
export default defineConfig({ name: 'opencloud-extra-preview' })
