import { test, expect } from '@playwright/test'
import { authHeaders, expectNativeGallery, expectRenderedImage, openAssetInformation, openFile, personalDrive, protectedLink, selectFile, signIn } from './helpers.mjs'

test.beforeEach(async ({ page }) => { await signIn(page) })

for (const [mode, selector] of [['resource-table', '#files-space-table'], ['resource-tiles', '#tiles-view']]) {
  test(`Space opens the native gallery from ${mode}`, async ({ page }) => {
    const folder = new URL(page.url())
    folder.searchParams.set('view-mode', mode)
    await page.goto(folder.href)
    const list = page.locator(selector)
    await expect(list).toBeVisible()
    const order = await list.locator('[data-test-selection-resource-name]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-test-selection-resource-name')))
    const index = order.indexOf('layered.psd')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(order.length - 1)
    await selectFile(page, 'layered.psd')
    await page.keyboard.press('Space')
    await expectRenderedImage(page, 'layered.psd')
    await expect(page.locator('.preview-controls-action-count')).toContainText(`${index + 1} of ${order.length}`)
    await page.keyboard.press('ArrowRight')
    await expectNativeGallery(page, order[index + 1])
    await expect(page.locator('.stage_media img')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expectRenderedImage(page, 'layered.psd')
    await page.keyboard.press('Space')
    await expect(page.locator('#preview')).toHaveCount(0)
    await expect(page.locator(selector)).toBeVisible()
  })
}

test('native gallery navigation can leave a failed preview', async ({ page }) => {
  await openFile(page, 'artwork.ai')
  await expectRenderedImage(page, 'artwork.ai')
  await page.keyboard.press('ArrowRight')
  await expectNativeGallery(page, 'broken.ai')
  await expect(page.locator('.stage_media')).toContainText('Failed to load')
  await page.keyboard.press('ArrowRight')
  await expectNativeGallery(page, 'hevc.mp4')
  await expect(page.locator('.stage_media video')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#preview')).toHaveCount(0)
  await expect(page.locator('[data-test-resource-name="artwork.ai"]').first()).toBeVisible()
})

test('native photo roll selects a rendered font beside ordinary images', async ({ page }) => {
  await openFile(page, 'native.jpg')
  await expectNativeGallery(page, 'native.jpg')
  await page.locator('.photo-roll').getByRole('button', { name: 'typeface.woff2', exact: true }).click()
  await expectRenderedImage(page, 'typeface.woff2')
  const details = await openAssetInformation(page)
  await expect(details).toContainText('DejaVu Sans')
  await page.screenshot({ path: test.info().outputPath('native-font-asset-details.png') })
})

test('Details loads source facts on demand without original downloads', async ({ page }) => {
  const originals = []
  const metadataRequests = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/layered.psd')) {
      if (!url.searchParams.has('preview')) originals.push(url.href)
      if (url.searchParams.get('processor') === 'extra-metadata-v1') metadataRequests.push(url.href)
    }
  })
  await openFile(page, 'layered.psd')
  await expectRenderedImage(page, 'layered.psd')
  expect(metadataRequests).toEqual([])
  const details = await openAssetInformation(page)
  await expect(details).toContainText('2,400 × 1,600 px')
  await expect(details).toContainText('PSD')
  expect(metadataRequests.length).toBeGreaterThan(0)
  expect(originals).toEqual([])
  await page.locator('.preview-controls-next').click()
  await expectNativeGallery(page, 'native.jpg')
  await expect(details).toBeVisible()
  await expect(details).toContainText('JPEG')
  await expect(details).not.toContainText('PSD')
  await page.getByRole('button', { name: 'Close file sidebar', exact: true }).click()
  await expect(details).toHaveCount(0)
})

test('native video keeps its player while Details reports codecs', async ({ page }) => {
  await selectFile(page, 'hevc.mp4')
  await page.keyboard.press('Space')
  await expectNativeGallery(page, 'hevc.mp4')
  const video = page.locator('.stage_media video')
  await expect(video).toBeVisible()
  await video.focus()
  await page.keyboard.press('Space')
  await expect(page.locator('#preview')).toBeVisible()
  const details = await openAssetInformation(page)
  await expect(details).toContainText(/hevc/i)
  await expect(details).toContainText('160 × 96 px')
})

test('Space opens PDF first pages inside the same native gallery', async ({ page }) => {
  await selectFile(page, 'native.pdf')
  await page.keyboard.press('Space')
  await expectRenderedImage(page, 'native.pdf')
  const details = await openAssetInformation(page)
  await expect(details).toContainText('2,400 × 1,600 pt')
})

test('public folder navigation stays inside the native gallery share', async ({ browser, request }) => {
  const drive = await personalDrive(request)
  const folderName = 'quick-look-share'
  const rootDav = drive.root.webDavUrl.replace(/\/$/, '')
  const dav = `${rootDav}/${folderName}`
  expect(new URL(dav).origin).toBe('https://localhost:9200')
  const folder = await request.fetch(dav, { method: 'MKCOL', headers: authHeaders })
  expect([201, 405]).toContain(folder.status())
  for (const [source, name] of [['artwork.ai', 'first.ai'], ['layered.psd', 'second.psd']]) {
    const original = await request.get(`${rootDav}/${source}`, { headers: authHeaders })
    expect(original.ok()).toBe(true)
    const upload = await request.put(`${dav}/${name}`, {
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' }, data: await original.body()
    })
    expect([201, 204]).toContain(upload.status())
  }
  const password = 'Extra-Quick-Look-47!'
  const url = await protectedLink(request, drive, folderName, password)
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const page = await anonymous.newPage()
    await page.goto(url)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await selectFile(page, 'first.ai')
    await page.keyboard.press('Space')
    await expectRenderedImage(page, 'first.ai')
    await expect(page.locator('.preview-controls-action-count')).toContainText('1 of 2')
    await page.keyboard.press('ArrowRight')
    await expectRenderedImage(page, 'second.psd')
    await expect(page.locator('.preview-controls-action-count')).toContainText('2 of 2')
    const details = await openAssetInformation(page)
    await expect(details).toContainText('2,400 × 1,600 px')
    await expect(details).toContainText('PSD')
    await page.locator('.preview-controls-next').click()
    await expectRenderedImage(page, 'first.ai')
    await expect(page.locator('.preview-controls-action-count')).toContainText('1 of 2')
    await expect(details).toContainText('2,400 × 1,600 pt')
    await page.keyboard.press('Escape')
    await expect(page.locator('#preview')).toHaveCount(0)
    await expect(page.locator('[data-test-resource-name="first.ai"]').first()).toBeVisible()
    await expect(page.locator('[data-test-resource-name="artwork.ai"]')).toHaveCount(0)
  } finally {
    await anonymous.close()
  }
})

test('native Details uses the existing mobile drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openFile(page, 'layered.psd')
  await expectRenderedImage(page, 'layered.psd')
  const details = await openAssetInformation(page)
  await expect(details).toContainText('2,400 × 1,600 px')
  await expect(page.locator('#mobile-right-sidebar #app-sidebar')).toBeVisible()
  await expect(page.getByTestId('extra-source-dimensions')).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('native-mobile-asset-details.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Close file sidebar', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(page.locator('.preview-controls-next')).toBeVisible()
})
