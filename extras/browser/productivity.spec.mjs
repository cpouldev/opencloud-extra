import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.locator('#oc-login-username').fill('admin')
  await page.locator('#oc-login-password').fill('extra-local-smoke-password')
  await page.locator('button[type="submit"]').click()
  await expect(page.locator('[data-test-resource-name="artwork.ai"]').first()).toBeVisible({ timeout: 45_000 })
})

async function selectFile(page, name) {
  await page.locator(`[data-test-selection-resource-name="${name}"] input`).check()
}

async function expectFile(page, name) {
  await expect(page.locator('.extra-preview-title strong')).toHaveText(name)
}

for (const [mode, selector] of [['resource-table', '#files-space-table'], ['resource-tiles', '#tiles-view']]) {
  test(`Quick Look follows visible ${mode} order and closes with Space`, async ({ page }) => {
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
    await expectFile(page, 'layered.psd')
    await expect(page.getByTestId('extra-preview-image')).toBeVisible()
    await expect(page.getByTestId('extra-preview-position')).toHaveText(`${index + 1} of ${order.length}`)
    await page.keyboard.press('ArrowRight')
    await expectFile(page, order[index + 1])
    await expect(page.getByTestId('extra-preview-image')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expectFile(page, 'layered.psd')
    await expect(page.getByTestId('extra-preview-image')).toBeVisible()
    await page.keyboard.press('Space')
    await expect(page.getByTestId('extra-preview')).toHaveCount(0)
    await expect(page.locator(selector)).toBeVisible()
  })
}

test('extra-file clicks gain navigation and can leave a failed preview', async ({ page }) => {
  await page.locator('[data-test-resource-name="artwork.ai"]').first().click()
  await expectFile(page, 'artwork.ai')
  await expect(page.getByRole('button', { name: 'Previous file', exact: true })).toBeDisabled()
  await expect(page.getByTestId('extra-preview-image')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expectFile(page, 'broken.ai')
  await expect(page.getByTestId('extra-preview-error')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expectFile(page, 'hevc.mp4')
  await expect(page.getByTestId('extra-preview-image')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('extra-preview')).toHaveCount(0)
  await expect(page.locator('[data-test-resource-name="artwork.ai"]').first()).toBeVisible()
})

test('asset information loads on demand and reports source facts without original downloads', async ({ page }) => {
  const originalDownloads = []
  const metadataRequests = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname.endsWith('/layered.psd')) {
      if (!url.searchParams.has('preview')) originalDownloads.push(url.href)
      if (url.searchParams.get('processor') === 'extra-metadata-v1') metadataRequests.push(url.href)
    }
  })
  await page.locator('[data-test-resource-name="layered.psd"]').first().click()
  await expect(page.getByTestId('extra-preview-image')).toBeVisible()
  expect(metadataRequests).toEqual([])
  await page.getByRole('button', { name: 'Asset information', exact: true }).click()
  const panel = page.getByTestId('extra-asset-info')
  await expect(panel).toContainText('2,400 × 1,600')
  await expect(panel).toContainText('PSD')
  expect(metadataRequests.length).toBeGreaterThan(0)
  expect(originalDownloads).toEqual([])
  await page.getByRole('button', { name: 'Next file', exact: true }).click()
  await expectFile(page, 'native.jpg')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('JPEG')
  await expect(panel).not.toContainText('layered.psd')
  await page.getByRole('button', { name: 'Asset information', exact: true }).click()
  await expect(panel).toHaveCount(0)
})

test('asset information updates between fonts and video', async ({ page }) => {
  await selectFile(page, 'hevc.mp4')
  await page.keyboard.press('Space')
  await expectFile(page, 'hevc.mp4')
  await page.getByRole('button', { name: 'Asset information', exact: true }).click()
  const panel = page.getByTestId('extra-asset-info')
  await expect(panel).toContainText(/hevc/i)
  await expect(panel).toContainText('160 × 96')
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await page.locator('[data-test-resource-name="typeface.woff2"]').first().click()
  await page.getByRole('button', { name: 'Asset information', exact: true }).click()
  await expect(panel).toContainText('DejaVu Sans')
  await expect(panel).not.toContainText('160 × 96')
  await page.screenshot({ path: test.info().outputPath('font-asset-info.png') })
})

test('public folder Quick Look stays inside the share and shows source information', async ({ browser, request }) => {
  const headers = { Authorization: `Basic ${Buffer.from('admin:extra-local-smoke-password').toString('base64')}` }
  const drives = await request.get('/graph/v1.0/me/drives', { headers })
  expect(drives.ok()).toBe(true)
  const drive = (await drives.json()).value.find((item) => item.driveType === 'personal')
  const folderName = 'quick-look-share'
  const dav = `${drive.root.webDavUrl.replace(/\/$/, '')}/${folderName}`
  expect(new URL(dav).origin).toBe('https://localhost:9200')
  const folder = await request.fetch(dav, { method: 'MKCOL', headers })
  expect([201, 405]).toContain(folder.status())
  for (const name of ['first.svg', 'second.svg']) {
    const upload = await request.put(`${dav}/${name}`, {
      headers: { ...headers, 'Content-Type': 'image/svg+xml' },
      data: '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000"><rect width="3000" height="2000" fill="navy"/></svg>'
    })
    expect([201, 204]).toContain(upload.status())
  }
  const children = await request.get('/graph/v1.0/me/drive/root/children', { headers })
  const item = (await children.json()).value.find((entry) => entry.name === folderName)
  const password = 'Extra-Quick-Look-47!'
  const shared = await request.post(`/graph/v1beta1/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(item.id)}/createLink`, {
    headers, data: { type: 'view', password }
  })
  expect(shared.ok(), await shared.text()).toBe(true)
  const url = (await shared.json()).link.webUrl
  expect(new URL(url).origin).toBe('https://localhost:9200')
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    const page = await anonymous.newPage()
    await page.goto(url)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await selectFile(page, 'first.svg')
    await page.keyboard.press('Space')
    await expectFile(page, 'first.svg')
    await expect(page.getByTestId('extra-preview-position')).toHaveText('1 of 2')
    await expect(page.getByRole('button', { name: 'Previous file', exact: true })).toBeDisabled()
    await expect(page.getByTestId('extra-preview-image')).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expectFile(page, 'second.svg')
    await expect(page.getByTestId('extra-preview-image')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next file', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Asset information', exact: true }).click()
    await expect(page.getByTestId('extra-asset-info')).toContainText('2,250 × 1,500 pt')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('extra-preview')).toHaveCount(0)
    await expect(page.locator('[data-test-resource-name="first.svg"]').first()).toBeVisible()
    await expect(page.locator('[data-test-resource-name="artwork.ai"]')).toHaveCount(0)
  } finally {
    await anonymous.close()
  }
})

test('asset information remains usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-test-resource-name="layered.psd"]').first().click()
  await expect(page.getByTestId('extra-preview-image')).toBeVisible()
  await page.getByRole('button', { name: 'Asset information', exact: true }).click()
  const panel = page.getByTestId('extra-asset-info')
  await expect(panel).toContainText('2,400 × 1,600')
  const body = page.getByTestId('extra-preview')
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('mobile-asset-info.png') })
  await page.getByRole('button', { name: 'Close file information', exact: true }).click()
  await expect(panel).toHaveCount(0)
})
