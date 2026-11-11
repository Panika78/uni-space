/* global process, console, URL, document, innerWidth, localStorage, sessionStorage, setTimeout, AbortController, performance, Navigator, Storage, DOMException, navigator, fetch, window, Event */
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
let currentProfile
context.on('response', async (response) => {
  if (
    !currentProfile &&
    new URL(response.url()).pathname === '/api/v1/users/me' &&
    response.status() === 200
  )
    currentProfile = await response.json()
})
context.on('request', (request) => {
  if (new URL(request.url()).pathname.startsWith('/api/'))
    requests.push(new URL(request.url()).pathname)
})
const check = (name) => console.log(`PASS ${name}`)
const heading = (target, name) => target.getByRole('heading', { name, exact: true }).waitFor()
const loginHeading = (target) => heading(target, 'Вход в систему')
async function hasVisibleLogoutAction(target) {
  const trigger = target.getByRole('button', { name: 'Меню пользователя', exact: true })
  if ((await trigger.count()) === 0) return false
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  return (await target.getByRole('button', { name: 'Выйти', exact: true }).count()) > 0
}
async function clickLogout(target) {
  assert.equal(await hasVisibleLogoutAction(target), true, 'Avatar disclosure should expose logout')
  await target.getByRole('button', { name: 'Выйти', exact: true }).click()
  const dialog = target.getByRole('dialog', { name: 'Выйти из аккаунта?' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Выйти', exact: true }).click()
}
async function login(target, name, waitForRateWindow = false) {
  await target.goto(`${baseURL}/login`)
  await target.getByLabel('Логин', { exact: true }).fill(name)
  await target.getByLabel('Пароль', { exact: true }).fill(password)
  await target.getByRole('button', { name: 'Войти', exact: true }).click()
  if (waitForRateWindow) {
    await target.waitForFunction(
      () =>
        window.location.pathname === '/schedule' ||
        document.querySelector('[role="status"]')?.textContent?.includes('Слишком много попыток'),
    )
    if (new URL(target.url()).pathname === '/login') {
      const message = await target.getByRole('status').innerText()
      const seconds = /через (\d+) сек/.exec(message)
      assert.ok(seconds, 'rate limit must provide a retry interval')
      const countBeforeWait = requests.filter((path) => path.endsWith('/login')).length
      await new Promise((resolve) => setTimeout(resolve, (Number(seconds[1]) + 1) * 1000))
      assert.equal(requests.filter((path) => path.endsWith('/login')).length, countBeforeWait)
      await target.getByRole('button', { name: 'Войти', exact: true }).click()
    }
  }
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
  await loginHeading(page)
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, 1)
  assert.ok(!(await page.locator('body').innerText()).includes('связаться с сервером'))
  check('initial invalid_refresh redirects without a loop')
  await page.getByLabel('Логин', { exact: true }).fill(loginA)
  await page.getByLabel('Пароль', { exact: true }).fill('incorrect-fictional-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByText('Неверный логин или пароль.', { exact: true }).waitFor()
  assert.equal(
    await page.getByLabel('Пароль', { exact: true }).inputValue(),
    'incorrect-fictional-password',
  )
  check('real invalid_credentials feedback')
  const afterRejectedLogin = requests.length
  await page.reload()
  await loginHeading(page)
  assert.equal(await page.getByRole('status').count(), 0)
  assert.equal(requests.length, afterRejectedLogin)
  check(
    'confirmed absence followed by rejected login stays quiet after reload without refresh or login retry',
  )
  await login(page, loginA)
  const beforeCancelledLogout = requests.length
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  const cancellationDialog = page.getByRole('dialog', { name: 'Выйти из аккаунта?' })
  await cancellationDialog.waitFor()
  assert.equal(await cancellationDialog.evaluate((element) => element.matches(':modal')), true)
  assert.equal(requests.length, beforeCancelledLogout)
  const notificationBox = await page
    .getByRole('link', {
      name: 'Уведомления — функция пока недоступна',
    })
    .boundingBox()
  assert.ok(notificationBox)
  await page.mouse.click(
    notificationBox.x + notificationBox.width / 2,
    notificationBox.y + notificationBox.height / 2,
  )
  await heading(page, 'Расписание')
  assert.equal(await cancellationDialog.count(), 1, 'modal must block mobile background clicks')
  await cancellationDialog.getByRole('button', { name: 'Отмена' }).click()
  await heading(page, 'Расписание')
  assert.equal(requests.length, beforeCancelledLogout)
  assert.equal(
    await page
      .getByRole('button', { name: 'Меню пользователя' })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.keyboard.press('Escape')
  await heading(page, 'Расписание')
  assert.equal(requests.length, beforeCancelledLogout)
  check('logout confirmation cancel and Escape preserve authentication without a POST')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Выйти из аккаунта?' })
  assert.equal(await modal.evaluate((element) => element.matches(':modal')), true)
  const sidebarToggle = page.getByRole('button', { name: 'Свернуть меню' })
  const sidebarBox = await sidebarToggle.boundingBox()
  assert.ok(sidebarBox)
  await page.mouse.click(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + sidebarBox.height / 2)
  assert.equal(await sidebarToggle.count(), 1, 'modal must block sidebar clicks')
  for (let index = 0; index < 4; index++) {
    await page.keyboard.press('Tab')
    assert.equal(
      await page.evaluate(() => document.activeElement?.closest('dialog')?.matches(':modal')),
      true,
    )
  }
  await page.keyboard.press('Escape')
  assert.equal(await modal.count(), 0)
  assert.equal(
    await page
      .getByRole('button', { name: 'Меню пользователя' })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  check('native logout dialog blocks desktop sidebar and traps focus until Escape')
  await page.getByRole('button', { name: 'Свернуть меню' }).click()
  assert.equal(await page.getByTestId('prototype-disclaimer').isVisible(), true)
  await page.getByRole('button', { name: 'Развернуть меню' }).click()
  await page.setViewportSize({ width: 360, height: 800 })
  assert.equal(await page.getByTestId('prototype-disclaimer').isVisible(), true)
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
  check('prototype disclaimer remains visible on collapsed desktop and 360px mobile layouts')
  const avatarTrigger = page.getByRole('button', { name: 'Меню пользователя', exact: true })
  await avatarTrigger.focus()
  await page.keyboard.press('Enter')
  assert.equal(await avatarTrigger.getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('Tab')
  assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /Мой профиль/)
  await page.keyboard.press('Escape')
  assert.equal(await avatarTrigger.getAttribute('aria-expanded'), 'false')
  assert.equal(await avatarTrigger.evaluate((element) => element === document.activeElement), true)
  check('avatar disclosure supports native keyboard focus and Escape restoration')
  const notificationLink = page.getByRole('link', {
    name: 'Уведомления — функция пока недоступна',
  })
  await notificationLink.focus()
  await page.keyboard.press('Enter')
  await heading(page, 'Уведомления')
  await page.getByText('Функция пока недоступна', { exact: true }).waitFor()
  await page.goBack()
  await heading(page, 'Расписание')
  check('notification link is keyboard accessible and routes to its unavailable page')
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
  for (const destination of [
    `${baseURL}/outside-api-capture`,
    'https://external.example/api/v1/redirect-capture',
  ]) {
    let redirectedRequests = 0
    await context.route(destination, (route) => {
      redirectedRequests++
      return route.fulfill({ json: { unexpected: true } })
    })
    await context.route(`**${testPath}`, (route) =>
      route.fulfill({ status: 302, headers: { Location: destination } }),
    )
    assert.equal((await callProtected(page)).code, 'network_error')
    assert.equal(redirectedRequests, 0)
    await context.unroute(destination)
    await context.unroute(`**${testPath}`)
  }
  check('authenticated redirects neither leave the API prefix nor contact another origin')

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
  await clickLogout(page)
  await loginHeading(page)
  await login(page, loginB)
  await loginHeading(second)
  releaseLate()
  assert.equal((await oldResponse).error, 'AbortError')
  await context.unroute(`**${testPath}`)
  check('account change in another tab hides old UI and rejects delayed data')

  const fallbackCookie = (await context.cookies()).find(
    (value) => value.name === 'uni_space_refresh',
  )
  assert.ok(fallbackCookie)
  await context.clearCookies()
  const fallbackRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/v1/auth/logout',
  )
  fault = 'lose-logout'
  await clickLogout(page)
  await page.getByText(/Не удалось завершить выход/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  const sentLogout = await fallbackRequest
  assert.ok((await sentLogout.headerValue('authorization'))?.startsWith('Bearer '))
  assert.ok(!(await sentLogout.headerValue('cookie'))?.includes('uni_space_refresh='))
  const beforeReload = requests.length
  await page.reload()
  await loginHeading(page)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  assert.equal(requests.slice(beforeReload).filter((path) => path.endsWith('/logout')).length, 0)
  assert.equal(requests.slice(beforeReload).filter((path) => path.endsWith('/refresh')).length, 0)
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  fault = ''
  await login(page, loginA)
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  check('lost logout response is not retried on reload or online; ordinary login restores access')
  const replacementCookie = (await context.cookies()).find(
    (value) => value.name === 'uni_space_refresh',
  )
  assert.ok(replacementCookie)
  // This refresh was current and unused when the cookie was removed.
  await context.addCookies([fallbackCookie])
  const revokedRefresh = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/refresh', { method: 'POST' })
    return { status: response.status, code: (await response.json()).error?.code }
  })
  assert.deepEqual(revokedRefresh, { status: 401, code: 'invalid_refresh' })
  await context.addCookies([replacementCookie])
  check(
    'logout without a cookie sends Bearer and revokes the real session despite its lost response',
  )

  await context.route(`**${testPath}`, (route) =>
    route.fulfill({ status: 401, json: apiError('access_expired') }),
  )
  fault = 'lose-refresh'
  await callProtected(page)
  await loginHeading(page)
  const lostRefreshCount = requests.filter((path) => path.endsWith('/refresh')).length
  await page.reload()
  await second.reload()
  await Promise.all([loginHeading(page), loginHeading(second)])
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
  await loginHeading(second)
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, countAfterClose)
  fault = ''
  check('closing the lock holder after rotation leaves a durable recovery barrier')
  // Cleanup may mark the lost response blocked; if the document closes first,
  // pending alone still prevents reuse of the potentially consumed cookie.
  const journal = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('uni-space.auth-state')),
  )
  assert.equal(journal.pending, true)
  assert.notEqual(journal.ended, true)
  await page.reload()
  await Promise.all([loginHeading(page), loginHeading(second)])
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  const refreshAfterFailure = requests.filter((path) => path.endsWith('/refresh')).length
  await login(page, loginA, true)
  await Promise.all([page.reload(), second.reload()])
  await Promise.all([heading(page, 'Расписание'), heading(second, 'Расписание')])
  assert.equal(requests.filter((path) => path.endsWith('/refresh')).length, refreshAfterFailure + 2)
  check(
    'failed refresh returns to login; an ordinary login restores both tabs without replaying refresh',
  )

  await clickLogout(page)
  await loginHeading(page)
  check('confirmed logout returns to login before controlled error scenarios')

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
  assert.equal(await page.getByLabel('Пароль', { exact: true }).inputValue(), password)
  check('controlled Retry-After feedback')
  await context.unroute('**/api/v1/auth/login')
  for (const scenario of ['server', 'network', 'timeout']) {
    let releaseLogin = () => {}
    const heldLogin = new Promise((resolve) => {
      releaseLogin = resolve
    })
    await context.route('**/api/v1/auth/login', async (route) => {
      if (scenario === 'server')
        await route.fulfill({ status: 500, json: apiError('internal_error') })
      else if (scenario === 'network') await route.abort('failed')
      else {
        await heldLogin
        await route.abort('failed').catch(() => {})
      }
    })
    const countBefore = requests.filter((path) => path.endsWith('/login')).length
    await page.getByLabel('Логин', { exact: true }).fill(loginA)
    await page.getByLabel('Пароль', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const expected =
      scenario === 'server'
        ? 'Не удалось выполнить вход'
        : scenario === 'network'
          ? 'Проверьте соединение'
          : 'Проверьте соединение'
    await page.getByText(new RegExp(expected)).waitFor()
    const message = await page.getByRole('status').innerText()
    assert.ok(!/Web Locks|internal server detail|Проверьте данные/.test(message))
    releaseLogin()
    await context.unroute('**/api/v1/auth/login')
    assert.equal(requests.filter((path) => path.endsWith('/login')).length, countBefore + 1)
    const beforeRecovery = requests.length
    await page.reload()
    await loginHeading(page)
    assert.equal(requests.length, beforeRecovery)
    check(`controlled login ${scenario} has correct feedback, one POST and no automatic recovery`)
  }

  // These fixtures exercise the real Web Locks manager without changing backend auth.
  async function holdAuthLock() {
    await second.evaluate(
      () =>
        new Promise((acquired) => {
          globalThis.authTestHeldLock = navigator.locks.request('uni-space.auth', () => {
            acquired()
            return new Promise((release) => {
              globalThis.authTestReleaseLock = release
            })
          })
        }),
    )
  }
  async function releaseAuthLock() {
    await second.evaluate(async () => {
      globalThis.authTestReleaseLock()
      await globalThis.authTestHeldLock
    })
  }
  const countAuth = () => requests.filter((path) => path.startsWith('/api/v1/auth/')).length
  // Only synthetic login fixtures need a matching identity fixture. Real sessions above
  // continue using the real /users/me endpoint, including role and session checks.
  assert.ok(currentProfile, 'Real student profile must have loaded before lock fixtures')
  await context.route('**/api/v1/users/me', (route) =>
    route.request().headers().authorization === 'Bearer fictional-browser-token'
      ? route.fulfill({ json: currentProfile })
      : route.continue(),
  )
  await context.route('**/api/v1/auth/login', (route) =>
    route.fulfill({
      json: { access_token: 'fictional-browser-token', token_type: 'bearer', expires_in: 600 },
    }),
  )
  await page.getByLabel('Логин', { exact: true }).fill(loginA)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await heading(page, 'Расписание')
  let logoutRedirects = 0
  const logoutTarget = 'https://external.example/api/v1/logout-capture'
  await context.route(logoutTarget, (route) => {
    logoutRedirects++
    return route.fulfill({ status: 204 })
  })
  await context.route('**/api/v1/auth/logout', (route) =>
    route.fulfill({ status: 307, headers: { Location: logoutTarget } }),
  )
  await clickLogout(page)
  await page.getByText(/Не удалось завершить выход/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  assert.equal(logoutRedirects, 0)
  await context.unroute('**/api/v1/auth/logout')
  await context.unroute(logoutTarget)
  check('logout with a captured access refuses redirects without contacting the target')
  await page.getByLabel('Логин', { exact: true }).fill(loginA)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await heading(page, 'Расписание')
  await context.unroute('**/api/v1/auth/login')
  await context.unroute('**/api/v1/users/me')
  await holdAuthLock()
  const beforeWaitingLogout = countAuth()
  await clickLogout(page)
  await loginHeading(page)
  await page.getByText(/Не удалось завершить выход/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Повторить выход', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Войти', exact: true }).isEnabled(), true)
  assert.equal(countAuth(), beforeWaitingLogout)
  await releaseAuthLock()
  await page.reload()
  await loginHeading(page)
  assert.equal(countAuth(), beforeWaitingLogout)
  check(
    'logout waiter times out, hides private UI, never posts after release, and stays blocked after reload',
  )

  await holdAuthLock()
  const beforeWaitingLogin = countAuth()
  await page.getByLabel('Логин', { exact: true }).fill(loginA)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByText(/Попробуйте ещё раз/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Войти', exact: true }).isEnabled(), true)
  await releaseAuthLock()
  await page.reload()
  await loginHeading(page)
  assert.equal(countAuth(), beforeWaitingLogin)
  check('login waiter times out without a POST, stuck busy state or late dispatch')

  // Reset this isolated fixture only after the real server session was logged out.
  await context.clearCookies()
  await page.evaluate(() => localStorage.clear())
  await holdAuthLock()
  const beforeWaitingRefresh = countAuth()
  const bootstrapping = await context.newPage()
  await bootstrapping.goto(`${baseURL}/schedule`)
  await bootstrapping.getByText('Проверяем сессию…', { exact: true }).waitFor()
  await loginHeading(bootstrapping)
  assert.equal(await bootstrapping.getByRole('status').count(), 0)
  assert.equal(countAuth(), beforeWaitingRefresh)
  await releaseAuthLock()
  await bootstrapping.close()
  assert.equal(countAuth(), beforeWaitingRefresh)
  check('initial refresh waiter exits initializing to ordinary login and never dispatches late')

  for (const unavailable of ['locks', 'storage']) {
    const unsupportedContext = await browser.newContext({ viewport: { width: 360, height: 800 } })
    await unsupportedContext.addInitScript((mode) => {
      if (mode === 'locks')
        Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined })
      else
        Object.defineProperty(Storage.prototype, 'setItem', {
          value() {
            throw new DOMException('blocked by test', 'SecurityError')
          },
        })
    }, unavailable)
    const unsupported = await unsupportedContext.newPage()
    let unsupportedRequests = 0
    unsupported.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/')) unsupportedRequests++
    })
    await unsupported.goto(`${baseURL}/login`)
    await loginHeading(unsupported)
    await unsupported.getByLabel('Логин', { exact: true }).fill(loginA)
    await unsupported.getByLabel('Пароль', { exact: true }).fill(password)
    await unsupported.getByRole('button', { name: 'Войти', exact: true }).click()
    await unsupported
      .getByText(
        'Для безопасного входа нужен современный браузер с поддержкой нескольких вкладок и хранилища сайта.',
        { exact: true },
      )
      .waitFor()
    assert.equal(unsupportedRequests, 0)
    await unsupportedContext.close()
    check(`unavailable ${unavailable} shows browser feedback without HTTP requests`)
  }
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  assert.ok(!storage.includes('access_token') && !storage.includes(password))
  check('no tokens or credentials in persistent storage')
  const refreshStatuses = upstreamStatuses.filter(({ path }) => path.endsWith('/refresh'))
  // Exactly two intended rejections: initial absence and the SEC-01 revocation proof.
  assert.equal(refreshStatuses.filter(({ status }) => status === 401).length, 2)
  assert.ok(refreshStatuses.every(({ status }) => status === 200 || status === 401))
  check('upstream refresh has only the two expected rejections, without unexpected auth failures')
} finally {
  await context.close()
  await browser.close()
  proxy.closeAllConnections()
  await new Promise((resolve) => proxy.close(resolve))
}
