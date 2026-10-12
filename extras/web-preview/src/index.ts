import { computed, markRaw } from 'vue'
import { useFileActions, useRouter } from '@opencloud-eu/web-pkg'
import type { ClassicApplicationScript, Extension, FileActionOptions } from '@opencloud-eu/web-pkg'
import AssetDetails from './AssetDetails.vue'
import { canPreviewFallback } from './formats.js'

const previewRouteName = 'preview-media'

// Called by the native preview application. There is no second application,
// viewer route, toolbar or details panel to keep in sync with the gallery.
export function useExtraPreview(): Pick<ClassicApplicationScript, 'extensions' | 'mounted'> {
  const router = useRouter()
  const { getEditorRouteOpts } = useFileActions()
  const previewRoute = ({ space, resources }: FileActionOptions) => getEditorRouteOpts(
    previewRouteName, space, resources[0], space.driveType === 'share' ? space.id : undefined
  )
  const removeLegacyRoute = router.addRoute({
    path: '/extra-preview/:driveAliasAndItem(.*)?',
    name: 'extra-preview-file',
    redirect: (to) => ({
      name: previewRouteName, params: to.params, query: to.query, hash: to.hash
    })
  })

  return {
    mounted: ({ instance }) => instance.onUnmount(removeLegacyRoute),
    extensions: computed<Extension[]>(() => [{
      id: 'extra-asset-details',
      type: 'customComponent',
      extensionPointIds: ['app.files.sidebar.file-details.table'],
      content: markRaw(AssetDetails)
    }, {
      id: 'extra-preview-fallback',
      type: 'action',
      extensionPointIds: ['global.files.context-actions'],
      action: {
        name: 'extra-preview-fallback',
        icon: 'eye',
        category: 'primary',
        label: () => 'Preview',
        handler: (options: FileActionOptions) => {
          if (!options.space?.id || options.resources.length !== 1 || !canPreviewFallback(options.resources[0])) return
          return router.push(previewRoute(options))
        },
        route: previewRoute,
        // Native Office/EPUB editors still rank ahead of this fallback action.
        isVisible: ({ space, resources }: FileActionOptions) => Boolean(space?.id) && resources.length === 1 &&
          canPreviewFallback(resources[0])
      }
    }])
  }
}
