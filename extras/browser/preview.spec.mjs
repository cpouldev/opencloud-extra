import { test, expect } from '@playwright/test'

async function signIn(page) {
  await page.goto('/')
  await page.locator('#oc-login-username').fill('admin')
  await page.locator('#oc-login-password').fill('extra-local-smoke-password')
  await page.locator('button[type="submit"]').click()
  await expect(page.locator('[data-test-resource-name="artwork.ai"]').first()).toBeVisible({ timeout: 45_000 })
}

async function openFile(page, name) {
  await page.locator(`[data-test-resource-name="${name}"]`).first().click()
}

async function expectRenderedImage(page) {
  const image = page.getByTestId('extra-preview-image')
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => Math.max(element.naturalWidth, element.naturalHeight))).toBe(2048)
  return image
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

for (const name of ['artwork.ai', 'layered.psd', 'typeface.woff2']) {
  test(`opens a rendered ${name} preview`, async ({ page }) => {
    const originalDownloads = []
    const previewRequests = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (request.method() !== 'GET') return
      if (url.pathname.endsWith(`/${name}`)) {
        if (!url.searchParams.has('preview')) originalDownloads.push(request.url())
        if (url.searchParams.get('x') === '2048') previewRequests.push(url)
      }
    })
    await openFile(page, name)
    await expect(page).toHaveURL(/\/extra-preview\//)
    await expectRenderedImage(page)
    expect(previewRequests.length).toBeGreaterThan(0)
    expect(previewRequests[0].searchParams.get('processor')).toBe('fit')
    expect(originalDownloads).toEqual([])
    await page.getByRole('button', { name: 'Close preview', exact: true }).click()
    await expect(page.locator(`[data-test-resource-name="${name}"]`).first()).toBeVisible()
    await expect(page.getByTestId('extra-preview')).toHaveCount(0)
  })
}

test('provides interactive view controls', async ({ page }) => {
  await openFile(page, 'artwork.ai')
  const image = await expectRenderedImage(page)
  const zoom = page.getByTestId('extra-preview-zoom')
  const fitted = await zoom.textContent()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(zoom).not.toHaveText(fitted)
  await page.getByRole('button', { name: 'Actual size', exact: true }).click()
  await expect(zoom).toHaveText('100%')
  const before = await image.evaluate((element) => getComputedStyle(element).transform)
  const stage = page.getByTestId('extra-preview-stage')
  const box = await stage.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 4 })
  await page.mouse.up()
  await expect.poll(() => image.evaluate((element) => getComputedStyle(element).transform)).not.toBe(before)
  await page.getByRole('button', { name: 'Fit to window', exact: true }).click()
  await expect(zoom).toHaveText(fitted)
  await page.screenshot({ path: test.info().outputPath('rendered-preview.png') })
})

test('shows loading until the preview arrives', async ({ page }) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  await page.route((url) => url.searchParams.get('preview') === '1' && url.searchParams.get('x') === '2048', async (route) => {
    await gate
    await route.continue()
  })
  try {
    await openFile(page, 'layered.psd')
    await expect(page.getByTestId('extra-preview-loading')).toBeVisible()
  } finally {
    release()
  }
  await expectRenderedImage(page)
  await expect(page.getByTestId('extra-preview-loading')).toHaveCount(0)
})

test('explains an unsupported Illustrator file', async ({ page }) => {
  await openFile(page, 'broken.ai')
  await expect(page.getByTestId('extra-preview-error')).toContainText('PDF Compatible')
  await expect(page.getByTestId('extra-preview-image')).toHaveCount(0)
  const retried = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/broken.ai') && url.searchParams.get('x') === '2048'
  })
  await page.getByRole('button', { name: 'Retry preview', exact: true }).click()
  expect((await retried).status()).toBe(404)
  await expect(page.getByTestId('extra-preview-error')).toBeVisible()
})

test('keeps the native JPEG viewer', async ({ page }) => {
  await openFile(page, 'native.jpg')
  await expect(page).toHaveURL(/\/preview\//)
  await expect(page.locator('img[alt="native.jpg"]')).toBeVisible()
  await expect(page.getByTestId('extra-preview')).toHaveCount(0)
})

test('keeps the native PDF viewer', async ({ page }) => {
  await openFile(page, 'native.pdf')
  await expect(page).toHaveURL(/\/pdf-viewer\//)
  await expect(page.locator('object.pdf-viewer')).toBeVisible()
  await expect(page.getByTestId('extra-preview')).toHaveCount(0)
})

test('opens a protected public-link preview without signing in', async ({ browser, request }) => {
  const linkPassword = 'Extra-Preview-Link-93!'
  const headers = { Authorization: `Basic ${Buffer.from('admin:extra-local-smoke-password').toString('base64')}` }
  const drivesResponse = await request.get('/graph/v1.0/me/drives', { headers })
  expect(drivesResponse.ok()).toBe(true)
  const drive = (await drivesResponse.json()).value.find((item) => item.driveType === 'personal')
  const childrenResponse = await request.get('/graph/v1.0/me/drive/root/children', { headers })
  expect(childrenResponse.ok()).toBe(true)
  const file = (await childrenResponse.json()).value.find((item) => item.name === 'artwork.ai')
  const linkResponse = await request.post(`/graph/v1beta1/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(file.id)}/createLink`, {
    headers,
    data: { type: 'view', password: linkPassword }
  })
  const linkBody = await linkResponse.text()
  expect(linkResponse.ok(), linkBody).toBe(true)
  const url = JSON.parse(linkBody).link.webUrl
  expect(new URL(url).origin).toBe('https://localhost:9200')
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const page = await anonymous.newPage()
    await page.goto(url)
    await page.getByLabel('Password', { exact: true }).fill(linkPassword)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expectRenderedImage(page)
    await page.getByRole('button', { name: 'Asset information', exact: true }).click()
    await expect(page.getByTestId('extra-asset-info')).toContainText('2,400 × 1,600 pt')
    await expect(page.getByRole('button', { name: 'Previous file', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Next file', exact: true })).toBeDisabled()
  } finally {
    await anonymous.close()
  }
})
