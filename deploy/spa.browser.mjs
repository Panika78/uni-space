/* global process, console, URL, document, getComputedStyle */
// Anonymous smoke test against the real production Compose stack, without route mocks.
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = new URL(process.env.PRODUCTION_TEST_URL)
assert.equal(origin.protocol, 'https:')
assert.equal(origin.hostname, '127.0.0.1', 'Use only the isolated loopback test stack')
const certificate = new X509Certificate(readFileSync(process.env.PRODUCTION_TEST_CERT_FILE))
const fingerprint = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  // Trust only this generated test certificate's public key, never all HTTPS errors.
  args: ['--no-sandbox', `--ignore-certificate-errors-spki-list=${fingerprint}`],
})
try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const page = await context.newPage()
  const errors = []
  const resources = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) => {
    errors.push(`Failed request: ${new URL(request.url()).pathname}`)
  })
  page.on('response', (response) => {
    const type = response.request().resourceType()
    if (type === 'script' || type === 'stylesheet') {
      resources.push({
        type,
        url: response.url(),
        status: response.status(),
        contentType: response.headers()['content-type'],
      })
    }
  })
  const refresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/auth/refresh',
  )
  const response = await page.goto(new URL('/schedule', origin).href, { waitUntil: 'load' })
  assert.equal(response.status(), 200, 'Nginx serves the registered deep link')
  assert.equal(
    new URL(response.url()).pathname,
    '/schedule',
    'Initial navigation has no server redirect',
  )
  await page.waitForURL(new URL('/login', origin).href)
  await page.getByRole('heading', { name: 'Вход', exact: true }).waitFor()
  assert.ok(await page.getByLabel('Логин', { exact: true }).isVisible())
  assert.ok(await page.getByLabel('Пароль', { exact: true }).isVisible())
  assert.ok(await page.getByRole('button', { name: 'Войти', exact: true }).isVisible())
  assert.equal((await refresh).status(), 401, 'Real backend rejects the absent session')
  for (const type of ['script', 'stylesheet']) {
    const matches = resources.filter((resource) => resource.type === type)
    assert.ok(matches.length > 0, `Actual ${type} resources loaded from the HTML`)
    for (const resource of matches) {
      const url = new URL(resource.url)
      assert.equal(url.origin, origin.origin)
      assert.ok(url.pathname.startsWith('/assets/'))
      assert.equal(resource.status, 200, `Resource failed: ${url.pathname}`)
      assert.match(resource.contentType, type === 'script' ? /javascript/ : /text\/css/)
    }
  }
  assert.ok(
    await page.evaluate(() =>
      [...document.styleSheets].some(
        (sheet) => sheet.href && new URL(sheet.href).pathname.startsWith('/assets/'),
      ),
    ),
    'Production CSS is attached to the document',
  )
  assert.equal(
    await page.locator('.site-header').evaluate((el) => getComputedStyle(el).display),
    'flex',
  )
  assert.deepEqual(errors, [], 'No JavaScript exceptions or failed resource requests')
  await context.close()
  console.log(
    'PASS: browser /schedule -> /login, real JS/CSS, anonymous refresh, no resource/JS failures',
  )
} finally {
  await browser.close()
}
