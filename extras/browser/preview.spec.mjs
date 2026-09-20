import { test, expect } from '@playwright/test'
import { expectNativeGallery, expectRenderedImage, openAssetInformation, openFile, personalDrive, protectedLink, signIn } from './helpers.mjs'

test.beforeEach(async ({ page }) => { await signIn(page) })

for (const name of ['artwork.ai', 'layered.psd', 'typeface.woff2']) {
  test(`opens ${name} in the native gallery without downloading its original`, async ({ page }) => {
    const originalDownloads = []
    const previewRequests = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() !== 'GET' || !url.pathname.endsWith(`/${name}`)) return
      if (!url.searchParams.has('preview')) originalDownloads.push(url.href)
      if (url.searchParams.get('x') === '2048') previewRequests.push(url)
    })
    await openFile(page, name)
    await expectRenderedImage(page, name)
    await expect(page.locator('.photo-roll')).toBeVisible()
    await expect(page.locator('.preview-controls-rotate-right')).toBeVisible()
    expect(previewRequests.length).toBeGreaterThan(0)
    expect(previewRequests[0].searchParams.get('processor')).toBe('fit')
    expect(originalDownloads).toEqual([])
    await page.locator('#app-top-bar-close').click()
    await expect(page.locator(`[data-test-resource-name="${name}"]`).first()).toBeVisible()
    await expect(page.locator('#preview')).toHaveCount(0)
  })
}

test('native gallery controls manipulate a rendered Illustrator preview', async ({ page }) => {
  await openFile(page, 'artwork.ai')
  const image = await expectRenderedImage(page, 'artwork.ai')
  await expect.poll(() => image.evaluate((element) => element.style.transform)).toContain('scale(1)')
  const fitted = await image.evaluate((element) => element.style.transform)
  await page.locator('.preview-controls-image-zoom').click()
  await expect.poll(() => image.evaluate((element) => element.style.transform)).not.toBe(fitted)
  const beforePan = await image.evaluate((element) => element.style.transform)
  const box = await page.locator('.stage_media').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => image.evaluate((element) => element.style.transform)).not.toBe(beforePan)
  await page.locator('.preview-controls-rotate-right').click()
  await expect.poll(() => image.evaluate((element) => element.style.transform)).toContain('rotate(90deg)')
  await page.locator('.preview-controls-image-reset').click()
  await expect.poll(() => image.evaluate((element) => element.style.transform)).toBe(fitted)
  await page.getByTestId('toggle-photo-roll').click()
  await expect(page.locator('.photo-roll')).toHaveCount(0)
  await page.getByTestId('toggle-photo-roll').click()
  await expect(page.locator('.photo-roll')).toBeVisible()
  await page.locator('.preview-controls-fullscreen').click()
  await expect(page.locator('.stage')).toHaveClass(/lightbox/)
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true)
  await page.locator('.preview-controls-fullscreen').click()
  await expect(page.locator('.stage')).not.toHaveClass(/lightbox/)
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
})

test('native gallery shows loading while a rendered preview is pending', async ({ page }) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  await page.route((url) => url.searchParams.get('preview') === '1' && url.searchParams.get('x') === '2048', async (route) => {
    await gate
    await route.continue()
  })
  try {
    await openFile(page, 'layered.psd')
    await expect(page.locator('#preview')).toBeVisible()
    await expect(page.locator('.stage_media').getByRole('img', { name: 'Loading media file' })).toBeVisible()
  } finally {
    release()
  }
  await expectRenderedImage(page, 'layered.psd')
})

test('native gallery explains an unsupported Illustrator file', async ({ page }) => {
  await openFile(page, 'broken.ai')
  await expectNativeGallery(page, 'broken.ai')
  await expect(page.locator('.stage_media')).toContainText('PDF Compatible')
  await expect(page.locator('.stage_media img')).toHaveCount(0)
  const retried = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/broken.ai') && url.searchParams.get('x') === '2048'
  })
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click()
  expect((await retried).status()).toBe(404)
  await expect(page.locator('.stage_media')).toContainText('Failed to load')
})

test('native JPEG uses the same gallery with asset information in Details', async ({ page }) => {
  await openFile(page, 'native.jpg')
  await expectNativeGallery(page, 'native.jpg')
  await expect(page.locator('.stage_media img[alt="native.jpg"]')).toBeVisible()
  const details = await openAssetInformation(page)
  await expect(details).toContainText('JPEG')
  await expect(details).toContainText('2,400 × 1,600 px')
  await expect(page.locator('#sidebar-panel-details')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('native-jpeg-asset-details.png') })
})

test('ordinary PDF clicks keep the native PDF viewer', async ({ page }) => {
  await openFile(page, 'native.pdf')
  await expect(page).toHaveURL(/\/pdf-viewer\//)
  await expect(page.locator('object.pdf-viewer')).toBeVisible()
  await expect(page.locator('#preview')).toHaveCount(0)
})

test('protected public file links open the native gallery without signing in', async ({ browser, request }) => {
  const password = 'Extra-Preview-Link-93!'
  const drive = await personalDrive(request)
  const url = await protectedLink(request, drive, 'artwork.ai', password)
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const page = await anonymous.newPage()
    await page.goto(url)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expectRenderedImage(page, 'artwork.ai')
    const details = await openAssetInformation(page)
    await expect(details).toContainText('2,400 × 1,600 pt')
    await expect(page.locator('.preview-controls-action-count')).toContainText('1 of 1')
  } finally {
    await anonymous.close()
  }
})

test('existing custom-preview links redirect into the native gallery', async ({ page }) => {
  await openFile(page, 'layered.psd')
  await expectRenderedImage(page, 'layered.psd')
  const legacy = new URL(page.url())
  legacy.pathname = legacy.pathname.replace('/preview/', '/extra-preview/')
  await page.goto(legacy.href)
  await expectRenderedImage(page, 'layered.psd')
  await page.locator('#app-top-bar-close').click()
  await expect(page.locator('[data-test-resource-name="layered.psd"]').first()).toBeVisible()
})
