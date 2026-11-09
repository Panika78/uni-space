/* global process, console, URL, document, innerWidth, localStorage, sessionStorage, setTimeout, AbortController, performance */
// Run against local Vite + the real backend using two prepared fictional accounts.
// Playwright is supplied by the environment; no production test route is installed.
import assert from 'node:assert/strict'
import { createServer, request as requestHttp } from 'node:http'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.AUTH_TEST_URL || 'http://localhost:5173'
const loginA = process.env.AUTH_TEST_LOGIN_A
const loginB = process.env.AUTH_TEST_LOGIN_B
const password = process.env.AUTH_TEST_PASSWORD
assert.ok(
  loginA && loginB && password,
  'Provide fictional AUTH_TEST_LOGIN_A/B and AUTH_TEST_PASSWORD',
)
// Vite must use API_PROXY_TARGET=http://127.0.0.1:18080 for this run.
// Faults live outside the page: closing a routed Playwright page can resume an
// intercepted request after route.fetch already forwarded it, creating test reuse.
const backendURL = process.env.AUTH_TEST_API_URL || 'http://127.0.0.1:8000'
let fault = ''
let notifyHeldRotation = () => {}
let releaseHeldRotation = Promise.resolve()
const upstreamStatuses = []
const proxy = createServer((request, response) => {
  const currentFault = fault
  const upstream = requestHttp(
    new URL(request.url, backendURL),
    {
      method: request.method,
      headers: { ...request.headers, host: new URL(backendURL).host },
    },
    (result) => {
      upstreamStatuses.push({ path: request.url, status: result.statusCode })
      const isRefresh = request.url.endsWith('/refresh')
      const isLogout = request.url.endsWith('/logout')
      if (
        (isRefresh && ['lose-refresh', 'hold-refresh'].includes(currentFault)) ||
        (isLogout && currentFault === 'lose-logout')
      ) {
        result.resume()
        result.on('end', async () => {
          if (currentFault === 'hold-refresh') {
            notifyHeldRotation()
            await releaseHeldRotation
          }
          response.destroy() // No response headers or Set-Cookie reach the browser.
        })
      } else {
        response.writeHead(result.statusCode, result.headers)
        result.pipe(response)
      }
    },
  )
  upstream.on('error', () => {
    response.destroy()
  })
  request.pipe(upstream)
})
await new Promise((resolve) => proxy.listen(18080, '127.0.0.1', resolve))
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
const page = await context.newPage()
const testPath = '/api/v1/task007-test-only'
const apiError = (code) => ({ error: { code, message: 'internal server detail', details: [] } })
const requests = []
context.on('request', (request) => {
  if (request.url().includes('/api/')) requests.push(new URL(request.url()).pathname)
})
const check = (name) => console.log(`PASS ${name}`)
const heading = (target, name) => target.getByRole('heading', { name, exact: true }).waitFor()
async function login(target, name) {
  await target.goto(`${baseURL}/login`)
  await target.getByLabel('Логин', { exact: true }).fill(name)
  await target.getByLabel('Пароль', { exact: true }).fill(password)
  await target.getByRole('button', { name: 'Войти', exact: true }).click()
  await heading(target, 'Расписание')
}
// Exercise the production HTTP client, with only the absent protected API controlled.
async function callProtected(target) {
  return target.evaluate(async (path) => {
    const clientURL = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => new URL(url).pathname === '/src/shared/api/client.ts')
      .at(-1)
    const { apiFetch } = await import(clientURL)
    try {
      return { value: await apiFetch(path, { authenticated: true }) }
    } catch (error) {
      return { error: error.name, code: error.code }
    }
  }, testPath)
}
try {
  await page.goto(`${baseURL}/schedule`)
  await heading(page, 'Вход')
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, 1)
  assert.ok(!(await page.locator('body').innerText()).includes('связаться с сервером'))
  check('initial invalid_refresh redirects without a loop')
  await page.getByLabel('Логин', { exact: true }).fill(loginA)
  await page.getByLabel('Пароль', { exact: true }).fill('incorrect-fictional-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByText('Неверный логин или пароль.', { exact: true }).waitFor()
  check('real invalid_credentials feedback')
  await login(page, loginA)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const cookie = (await context.cookies()).find((value) => value.name === 'uni_space_refresh')
  assert.ok(cookie?.httpOnly && cookie.path === '/api/v1/auth' && cookie.sameSite === 'Lax')
  await page.reload()
  await heading(page, 'Расписание')
  const second = await context.newPage()
  await second.goto(`${baseURL}/schedule`)
  await heading(second, 'Расписание')
  await Promise.all([page.reload(), second.reload()])
  await Promise.all([heading(page, 'Расписание'), heading(second, 'Расписание')])
  check('login, reload, mobile width, cookie flags and simultaneous tab reload')

  let protectedCalls = 0
  await context.route(`**${testPath}`, async (route) => {
    protectedCalls++
    await route.fulfill({
      status: protectedCalls === 1 ? 401 : 200,
      json: protectedCalls === 1 ? apiError('access_expired') : { ok: true },
    })
  })
  const refreshBefore = requests.filter((path) => path.endsWith('/refresh')).length
  assert.deepEqual(await callProtected(page), { value: { ok: true } })
  assert.equal(protectedCalls, 2)
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, refreshBefore + 1)
  check('controlled access_expired, real refresh and exactly one replay')
  await context.unroute(`**${testPath}`)
  await context.route(`**${testPath}`, (route) => route.abort('failed'))
  assert.equal((await callProtected(page)).code, 'network_error')
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, refreshBefore + 1)
  check('protected network failure causes no refresh')
  await context.unroute(`**${testPath}`)
  await context.route(`**${testPath}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({ json: { ok: true } }).catch(() => {})
  })
  const cancelled = await page.evaluate(async (path) => {
    const clientURL = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => new URL(url).pathname === '/src/shared/api/client.ts')
      .at(-1)
    const { apiFetch } = await import(clientURL)
    const controller = new AbortController()
    const request = apiFetch(path, { authenticated: true, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    try {
      await request
    } catch (error) {
      return error.name
    }
  }, testPath)
  assert.equal(cancelled, 'AbortError')
  check('real AbortController cancellation stays an abort')
  await context.unroute(`**${testPath}`)

  let releaseLate
  const held = new Promise((resolve) => {
    releaseLate = resolve
  })
  let notifyRequest
  const received = new Promise((resolve) => {
    notifyRequest = resolve
  })
  await context.route(`**${testPath}`, async (route) => {
    notifyRequest()
    await held
    await route.fulfill({ json: { previousUser: true } }).catch(() => {})
  })
  const oldResponse = callProtected(second)
  await received
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await heading(page, 'Вход')
  await login(page, loginB)
  await heading(second, 'Вход')
  releaseLate()
  assert.equal((await oldResponse).error, 'AbortError')
  await context.unroute(`**${testPath}`)
  check('account change in another tab hides old UI and rejects delayed data')

  fault = 'lose-logout'
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByText(/сервер не подтвердил выход/).waitFor()
  const beforeReload = requests.length
  await page.reload()
  await heading(page, 'Вход')
  assert.equal(requests.slice(beforeReload).filter((path) => path.endsWith('/refresh')).length, 0)
  fault = ''
  await page.getByRole('button', { name: 'Повторить выход', exact: true }).click()
  await page.getByText('Выход подтверждён сервером.', { exact: true }).waitFor()
  check('lost real logout response, reload blocks restoration and explicit retry succeeds')

  await login(page, loginA)
  await context.route(`**${testPath}`, (route) =>
    route.fulfill({ status: 401, json: apiError('access_expired') }),
  )
  fault = 'lose-refresh'
  await callProtected(page)
  await heading(page, 'Вход')
  const lostRefreshCount = requests.filter((path) => path.endsWith('/refresh')).length
  await page.reload()
  await second.reload()
  await Promise.all([heading(page, 'Вход'), heading(second, 'Вход')])
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, lostRefreshCount)
  check('lost real refresh response never retries the potentially consumed cookie')
  fault = ''
  await context.unroute(`**${testPath}`)
  await login(page, loginA)
  await second.reload()
  await heading(second, 'Расписание')
  const closing = await context.newPage()
  await closing.goto(`${baseURL}/schedule`)
  await heading(closing, 'Расписание')
  const rotated = new Promise((resolve) => {
    notifyHeldRotation = resolve
  })
  let releaseRotation
  releaseHeldRotation = new Promise((resolve) => {
    releaseRotation = resolve
  })
  fault = 'hold-refresh'
  const closingReload = closing.reload().catch(() => {})
  await rotated
  await closing.close()
  releaseRotation()
  await closingReload
  const countAfterClose = requests.filter((path) => path.endsWith('/refresh')).length
  await second.reload()
  await heading(second, 'Вход')
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, countAfterClose)
  fault = ''
  check('closing the lock holder after rotation leaves a durable recovery barrier')
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await Promise.all([heading(page, 'Вход'), heading(second, 'Вход')])
  check('confirmed logout hides protected screens in both tabs')

  // Auth errors controlled only for feedback; backend origin protection stays enabled.
  await context.route('**/api/v1/auth/login', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '37' },
      json: apiError('rate_limited'),
    }),
  )
  await page.getByLabel('Логин', { exact: true }).fill(loginA)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByText('Слишком много попыток. Повторите через 37 сек.', { exact: true }).waitFor()
  check('controlled Retry-After feedback')
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  assert.ok(!storage.includes('access_token') && !storage.includes(password))
  check('no tokens or credentials in persistent storage')
  assert.ok(
    upstreamStatuses
      .filter(({ path }) => path.endsWith('/refresh'))
      .every(({ status }, index) => (index === 0 ? status === 401 : status === 200)),
  )
  check('all subsequent upstream refresh responses are 200, without reuse')
} finally {
  await context.close()
  await browser.close()
  proxy.closeAllConnections()
  await new Promise((resolve) => proxy.close(resolve))
}
