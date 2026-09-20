import { expect } from '@playwright/test'

export const authHeaders = {
  Authorization: `Basic ${Buffer.from('admin:extra-local-smoke-password').toString('base64')}`
}

export async function signIn(page) {
  await page.goto('/')
  await page.locator('#oc-login-username').fill('admin')
  await page.locator('#oc-login-password').fill('extra-local-smoke-password')
  await page.locator('button[type="submit"]').click()
  await expect(page.locator('[data-test-resource-name="artwork.ai"]').first()).toBeVisible({ timeout: 45_000 })
}

export async function openFile(page, name) {
  await page.locator(`[data-test-resource-name="${name}"]`).first().click()
}

export async function selectFile(page, name) {
  await page.locator(`[data-test-selection-resource-name="${name}"] input`).check()
}

export async function expectNativeGallery(page, name) {
  await expect(page).toHaveURL(/\/preview\//)
  await expect(page.locator('#preview .stage_controls')).toBeVisible()
  await expect(page.locator('.photo-roll button[aria-current="true"]')).toHaveAttribute('aria-label', name)
  await expect(page.getByTestId('extra-preview')).toHaveCount(0)
}

export async function expectRenderedImage(page, name) {
  await expectNativeGallery(page, name)
  const image = page.locator('.stage_media').getByRole('img', { name, exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element) => Math.max(element.naturalWidth, element.naturalHeight))).toBe(2048)
  return image
}

export async function openAssetInformation(page) {
  await page.getByRole('button', { name: 'Asset information', exact: true }).click()
  const details = page.locator('#oc-file-details-sidebar')
  await expect(details).toBeVisible()
  return details
}

export async function personalDrive(request) {
  const response = await request.get('/graph/v1.0/me/drives', { headers: authHeaders })
  expect(response.ok()).toBe(true)
  return (await response.json()).value.find((item) => item.driveType === 'personal')
}

export async function protectedLink(request, drive, name, password) {
  const response = await request.get('/graph/v1.0/me/drive/root/children', { headers: authHeaders })
  expect(response.ok()).toBe(true)
  const item = (await response.json()).value.find((entry) => entry.name === name)
  expect(item).toBeTruthy()
  const shared = await request.post(`/graph/v1beta1/drives/${encodeURIComponent(drive.id)}/items/${encodeURIComponent(item.id)}/createLink`, {
    headers: authHeaders, data: { type: 'view', password }
  })
  expect(shared.ok(), await shared.text()).toBe(true)
  const url = (await shared.json()).link.webUrl
  expect(new URL(url).origin).toBe('https://localhost:9200')
  return url
}
