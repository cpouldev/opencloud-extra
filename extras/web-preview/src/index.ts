import { computed } from 'vue'
import {
  AppWrapperRoute,
  defineWebApplication,
  useFileActions,
  useResourcesStore,
  useRouter,
  useSpacesStore
} from '@opencloud-eu/web-pkg'
import { isShareSpaceResource, isTrashResource } from '@opencloud-eu/web-client'
import Preview from './Preview.vue'
import { extensionOf, fallbackExtensions, previewExtensions, unavailableReason } from './formats.js'
import { createQuickLookController, isQuickLookEligible, previewRouteName } from './quicklook.js'

const appId = 'extra-preview'
const routeName = previewRouteName

export default defineWebApplication({
  setup() {
    const { getEditorRouteOpts, openEditor } = useFileActions()
    const fileHandler = { app: appId, routeName }
    const quickLook = createQuickLookController({
      router: useRouter(),
      resourcesStore: useResourcesStore(),
      spacesStore: useSpacesStore(),
      getEditorRouteOpts
    })

    return {
      mounted: ({ instance }) => instance.onUnmount(quickLook.dispose),
      appInfo: {
        id: appId,
        name: 'Rendered preview',
        icon: 'eye',
        extensions: previewExtensions.map((extension) => ({
          extension,
          routeName,
          hasPriority: true,
          label: () => 'Rendered preview'
        }))
      },
      routes: [{
        path: '/:driveAliasAndItem(.*)?',
        name: 'file',
        component: AppWrapperRoute(Preview, {
          applicationId: appId,
          disableAutoSave: true
        }),
        meta: {
          authContext: 'hybrid',
          title: 'Rendered preview',
          patchCleanPath: true
        }
      }],
      // Native file handlers rank ahead of primary context actions in Web v8.
      // Office/EPUB previews remain a fallback to native editors and readers.
      extensions: computed(() => [{
        id: 'extra-quick-look',
        type: 'action',
        extensionPointIds: ['global.files.context-actions'],
        action: {
          name: 'extra-quick-look',
          icon: 'eye',
          category: 'secondary',
          label: () => 'Quick Look',
          shortcut: 'Space',
          handler: ({ space, resources }) => quickLook.open(space, resources[0]),
          isVisible: ({ space, resources }) => Boolean(space?.id) &&
            resources.length === 1 && isQuickLookEligible(resources[0])
        }
      }, {
        id: 'extra-preview-fallback',
        type: 'action',
        extensionPointIds: ['global.files.context-actions'],
        action: {
          name: 'extra-preview-fallback',
          icon: 'eye',
          category: 'primary',
          label: () => 'Rendered preview',
          handler: ({ space, resources }) => openEditor(fileHandler, space, resources[0]),
          route: ({ space, resources }) => getEditorRouteOpts(
            routeName, space, resources[0], isShareSpaceResource(space) ? space.id : undefined
          ),
          isVisible: ({ resources }) => resources.length === 1 &&
            fallbackExtensions.includes(extensionOf(resources[0])) &&
            !isTrashResource(resources[0]) && !unavailableReason(resources[0])
        }
      }])
    }
  }
})
