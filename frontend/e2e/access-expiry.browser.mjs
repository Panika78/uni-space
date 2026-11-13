/* global process, console, Buffer */
// Real expiry: run after restarting the isolated API with ACCESS_TTL_SECONDS=2.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.DEMO_TEST_URL || 'http://localhost:5173'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  executablePath: process.env.CHROMIUM_PATH || undefined,
})
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
  context.setDefaultTimeout(15000)
  const page = await context.newPage()
  await page.goto(`${base}/login`)
  await page.getByLabel('Логин').fill('demo-pz101')
  await page.getByLabel('Пароль').fill(process.env.DEMO_STUDENT_A_PASSWORD)
  const pending = page.waitForResponse((r) => r.url().endsWith('/auth/login'))
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  const response = await pending
  assert.equal(response.status(), 200)
  const token = await response.json()
  assert.equal(token.expires_in, 2, 'This boundary test requires the isolated short-lived API')
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  const expiresAt =
    JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url')).exp * 1000
  // Wait for the signed expiration boundary, not an arbitrary test delay.
  await page.waitForFunction((boundary) => Date.now() >= boundary, expiresAt)
  const expired = await context.request.get(`${base}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  })
  assert.equal(expired.status(), 401)
  assert.equal((await expired.json()).error.code, 'access_expired')
  let refreshes = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/auth/refresh')) refreshes++
  })
  // Reload forces a real coordinated refresh, restoring protected UI after expiry.
  const renewed = page.waitForResponse((r) => r.url().endsWith('/auth/refresh'))
  await page.reload()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  assert.equal(refreshes, 1)
  const freshToken = await (await renewed).json()
  const nextExpiry =
    JSON.parse(Buffer.from(freshToken.access_token.split('.')[1], 'base64url')).exp * 1000
  await page.waitForFunction((boundary) => Date.now() >= boundary, nextExpiry)
  const servicesStatuses = []
  page.on('response', (r) => {
    if (r.url().endsWith('/services')) servicesStatuses.push(r.status())
  })
  // Invoke the configured production client once; React dev StrictMode mounts
  // pages twice and would introduce two independent originals into this assertion.
  const services = await page.evaluate(async () => {
    const { apiFetch } = await import('/src/shared/api/client.ts')
    return apiFetch('/api/v1/services', { authenticated: true })
  })
  assert.ok(services.items.some((item) => item.code === 'study_certificate'))
  assert.equal(refreshes, 2)
  assert.deepEqual(servicesStatuses, [401, 200], 'One expired response and one successful replay')
  console.log(
    'PASS real access_expired, single refresh on reload, protected profile restored, one services replay at 360px',
  )
} finally {
  await browser.close()
}
