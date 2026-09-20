import { computed, markRaw } from 'vue'
import {
  useFileActions,
  useResourcesStore,
  useRouter,
  useSpacesStore
} from '@opencloud-eu/web-pkg'
import type { ClassicApplicationScript, Extension, FileActionOptions } from '@opencloud-eu/web-pkg'
import AssetDetails from './AssetDetails.vue'
import { extensionOf, fallbackExtensions } from './formats.js'
import { createQuickLookController, isQuickLookEligible, previewRouteName } from './quicklook.js'

// Called by the native preview application. There is no second application,
// viewer route, toolbar or details panel to keep in sync with the gallery.
export function useExtraPreview(nativeMimeTypes: string[] = []): Pick<ClassicApplicationScript, 'extensions' | 'mounted'> {
  const router = useRouter()
  const { getEditorRouteOpts } = useFileActions()
  const quickLook = createQuickLookController({
    router,
    resourcesStore: useResourcesStore(),
    spacesStore: useSpacesStore(),
    getEditorRouteOpts,
    nativeMimeTypes
  })
  const removeLegacyRoute = router.addRoute({
    path: '/extra-preview/:driveAliasAndItem(.*)?',
    name: 'extra-preview-file',
    redirect: (to) => ({
      name: previewRouteName, params: to.params, query: to.query, hash: to.hash
    })
  })

  return {
    mounted: ({ instance }) => instance.onUnmount(() => {
      quickLook.dispose()
      removeLegacyRoute()
    }),
    extensions: computed<Extension[]>(() => [{
      id: 'extra-asset-details',
      type: 'customComponent',
      extensionPointIds: ['app.files.sidebar.file-details.table'],
      content: markRaw(AssetDetails)
    }, {
      id: 'extra-quick-look',
      type: 'action',
      extensionPointIds: ['global.files.context-actions'],
      action: {
        name: 'extra-quick-look',
        icon: 'eye',
        category: 'secondary',
        label: () => 'Quick Look',
        shortcut: 'Space',
        handler: ({ space, resources }: FileActionOptions) => quickLook.open(space, resources[0]),
        isVisible: ({ space, resources }: FileActionOptions) => Boolean(space?.id) &&
          resources.length === 1 && isQuickLookEligible(resources[0], nativeMimeTypes)
      }
    }, {
      id: 'extra-preview-fallback',
      type: 'action',
      extensionPointIds: ['global.files.context-actions'],
      action: {
        name: 'extra-preview-fallback',
        icon: 'eye',
        category: 'primary',
        label: () => 'Preview',
        handler: ({ space, resources }: FileActionOptions) => quickLook.open(space, resources[0]),
        route: ({ space, resources }: FileActionOptions) => getEditorRouteOpts(
          previewRouteName, space, resources[0], space.driveType === 'share' ? space.id : undefined
        ),
        // Native Office/EPUB editors still rank ahead of this fallback action.
        isVisible: ({ space, resources }: FileActionOptions) => Boolean(space?.id) && resources.length === 1 &&
          fallbackExtensions.includes(extensionOf(resources[0])) &&
          isQuickLookEligible(resources[0], nativeMimeTypes)
      }
    }])
  }
}
