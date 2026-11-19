/* global process, console, document, URL, window, Event, requestAnimationFrame */
// Real PostgreSQL/API/browser acceptance; routes only delay or drop real replies
// and inject supplementary transport failures, never replace domain data.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.AUTH_TEST_URL || 'http://localhost:5173'
const data = JSON.parse(
  readFileSync(process.env.NOTIFICATION_FIXTURE_FILE || 'work/notifications-fixture.json', 'utf8'),
)
const check = (message) => console.log(`PASS ${message}`)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
const page = await context.newPage()
let token
async function login(owner) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(data.logins[owner])
  await page.getByLabel('Пароль', { exact: true }).fill(data.password)
  let response
  for (;;) {
    const pending = page.waitForResponse((r) => r.url().endsWith('/auth/login'))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    response = await pending
    if (response.status() !== 429) break
    await page.waitForTimeout((Number(response.headers()['retry-after']) + 1) * 1000)
  }
  assert.equal(response.status(), 200)
  token = (await response.json()).access_token
  await page.getByRole('button', { name: 'Уведомления', exact: true }).waitFor()
}
async function api(path, method = 'GET') {
  return context.request.fetch(`${baseURL}/api/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Origin: new URL(baseURL).origin },
  })
}
async function count(expected) {
  const response = await api('notifications/unread-count')
  assert.equal(response.status(), 200)
  assert.equal((await response.json()).count, expected)
}
const bell = () => page.getByRole('button', { name: 'Уведомления', exact: true })
const drawer = () => page.getByRole('dialog', { name: 'Уведомления', exact: true })
const row = (key) =>
  drawer()
    .locator('article.notification-item')
    .filter({ has: page.getByText(`NOTIFY ${key}`, { exact: true }) })
async function open() {
  await bell().click()
  await drawer().waitFor()
}
async function close() {
  await page.keyboard.press('Escape')
  await drawer().waitFor({ state: 'hidden' })
}
async function logout() {
  if (await drawer().count()) await close()
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Выйти из аккаунта?' })
    .getByRole('button', { name: 'Выйти', exact: true })
    .click()
  await page.getByRole('heading', { name: 'Вход в систему', exact: true }).waitFor()
}
async function badge(expected) {
  await page
    .getByRole('status', { name: `Непрочитанных: ${expected}`, exact: true })
    .waitFor({ state: 'attached' })
}
async function read(key) {
  await row(key).getByRole('button', { name: 'Отметить прочитанным', exact: true }).click()
}
async function navigate(key, expected) {
  await open()
  await row(key).getByRole('button', { name: 'Открыть объект', exact: true }).click()
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expected)
  await drawer().waitFor({ state: 'hidden' })
}
const mutate = (...args) =>
  execFileSync(
    'uv',
    [
      'run',
      '--locked',
      '--python',
      process.env.NOTIFICATION_TEST_PYTHON_VERSION || '3.12.16',
      '--project',
      'backend',
      'python',
      'frontend/e2e/notifications-fixtures.py',
      ...args,
    ],
    { env: { ...process.env, PYTHONPATH: 'backend' }, stdio: 'pipe' },
  )
try {
  await login('student')
  await badge(30)
  await count(30)
  await open()
  await row('general').waitFor()
  await count(30)
  assert.equal(
    await row('general').getByRole('button', { name: 'Открыть объект', exact: true }).count(),
    0,
  )
  assert.equal(
    await row('unknown').getByRole('button', { name: 'Открыть объект', exact: true }).count(),
    0,
  )
  assert.equal(
    await row('partial').getByRole('button', { name: 'Открыть объект', exact: true }).count(),
    0,
  )
  for (const key of ['unknown', 'partial', 'general']) {
    assert.equal((await api(`notifications/${data.ids[key]}/target`)).status(), 404)
  }
  await drawer().getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await row('old-21').waitFor()
  await count(30)
  check('360px real all-page count, pagination, unknown type, legacy/partial targets, no auto-read')

  for (const [index, key] of ['foreign', 'deleted'].entries()) {
    await row(key).getByRole('button', { name: 'Открыть объект', exact: true }).click()
    await row(key).getByRole('alert').filter({ hasText: 'Объект недоступен' }).waitFor()
    assert.equal(new URL(page.url()).pathname, '/schedule')
    await count(30 - index)
    await read(key)
  }
  await badge(28)
  await read('general')
  await badge(27)
  await count(27)
  const original = await (await api(`notifications/${data.ids.general}/read`, 'PATCH')).json()
  assert.deepEqual(
    await (await api(`notifications/${data.ids.general}/read`, 'PATCH')).json(),
    original,
  )
  const foreign = await api(`notifications/${data.ids.other}/read`, 'PATCH')
  const missing = await api('notifications/9223372036854775807/read', 'PATCH')
  assert.equal(foreign.status(), 404)
  assert.equal(missing.status(), 404)
  assert.deepEqual(await foreign.json(), await missing.json())
  check(
    'unavailable targets remain unread; explicit read is idempotent; foreign/missing are indistinguishable',
  )

  // Network uncertainty after a real committed PATCH must not produce UI success.
  const lostPatch = `**/api/v1/notifications/${data.ids.unknown}/read`
  await page.route(lostPatch, async (route) => {
    await route.fetch()
    await route.abort('failed')
  })
  await read('unknown')
  await drawer().getByRole('alert').waitFor()
  await count(26)
  assert.equal(
    await row('unknown').getByRole('button', { name: 'Отметить прочитанным', exact: true }).count(),
    1,
  )
  await page.unroute(lostPatch)
  await read('unknown')
  await badge(26)
  await count(26)
  check('lost PATCH response retains retry; repeat converges with server without duplicate read')
  await close()

  // Hold a genuine resolver response until after Escape. GET must not mutate,
  // and a callback from a closed drawer cannot navigate or trigger PATCH.
  let releaseResolver
  let enteredResolver
  let finishResolver
  const resolverFinished = new Promise((resolve) => {
    finishResolver = resolve
  })
  const resolverEntered = new Promise((resolve) => {
    enteredResolver = resolve
  })
  const resolverGate = new Promise((resolve) => {
    releaseResolver = resolve
  })
  const delayedResolver = `**/api/v1/notifications/${data.ids.application}/target`
  await page.route(delayedResolver, async (route) => {
    const response = await route.fetch()
    enteredResolver()
    await resolverGate
    await route.fulfill({ response }).catch(() => {})
    finishResolver()
  })
  await open()
  await row('application').getByRole('button', { name: 'Открыть объект', exact: true }).click()
  await resolverEntered
  await close()
  const beforeLateResolver = page.url()
  releaseResolver()
  await resolverFinished
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await page.unroute(delayedResolver)
  await count(26)
  assert.equal(page.url(), beforeLateResolver)
  check('late real resolver after Escape cannot navigate or mark read')

  await page.route('**/api/v1/notifications/unread-count', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'internal_error', message: 'private server detail', details: [] } },
    }),
  )
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page
    .getByRole('status', { name: 'Не удалось загрузить счётчик уведомлений', exact: true })
    .waitFor()
  assert.equal(await page.getByText('private server detail', { exact: true }).count(), 0)
  await page.unroute('**/api/v1/notifications/unread-count')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await badge(26)
  check('counter 503 hides stale count, safe error and focus retry use real server')

  await navigate('application', `/applications/${data.application}`)
  await page
    .getByRole('heading', { name: `Заявление № ${data.application}`, exact: true })
    .waitFor()
  await page.goBack()
  await bell().waitFor()
  await navigate('course', `/academics/courses/${data.course}`)
  await page.getByRole('heading', { name: 'Дисциплина уведомлений', exact: true }).waitFor()
  await page.goBack()
  await navigate('lesson', `/schedule?date=${data.day}&mode=day&lesson_id=${data.lesson}`)
  await page.locator(`[data-lesson-id="${data.lesson}"]`).waitFor()
  await page.goBack()
  await bell().waitFor()
  await page.goForward()
  await bell().waitFor()
  await count(23)
  check(
    'real application/course/lesson routes and Back/Forward; final APIs authorize independently',
  )

  await open()
  const lostAll = '**/api/v1/notifications/read-all'
  await page.route(lostAll, async (route) => {
    await route.fetch()
    await route.abort('failed')
  })
  await drawer().getByRole('button', { name: 'Отметить все прочитанными', exact: true }).click()
  await drawer().getByRole('alert').waitFor()
  await count(0)
  await page.unroute(lostAll)
  await drawer().getByRole('button', { name: 'Отметить все прочитанными', exact: true }).click()
  await badge(0)
  assert.deepEqual(await (await api('notifications/read-all', 'POST')).json(), { updated_count: 0 })
  await drawer().getByText('NOTIFY application', { exact: true }).waitFor()
  check('lost read-all response retries atomically over all pages; read history stays visible')
  await close()
  await logout()

  for (const owner of ['teacher', 'admin', 'staff']) {
    await login(owner)
    await badge(owner === 'staff' ? 2 : 1)
    await open()
    await row(owner).waitFor()
    assert.equal(await drawer().getByText('NOTIFY general', { exact: true }).count(), 0)
    await read(owner)
    await badge(owner === 'staff' ? 1 : 0)
    const confirmed = (await (await api('notifications?limit=100')).json()).items.find(
      (item) => item.id === data.ids[owner],
    )
    assert.ok(confirmed.read_at)
    await close()
    if (owner === 'staff') {
      await navigate('review', `/staff/applications/${data.application}`)
      await page
        .getByRole('heading', { name: `Заявление № ${data.application}`, exact: true })
        .waitFor()
      // Resolve first, then revoke the real grant; final API remains authoritative.
      assert.equal((await api(`notifications/${data.ids.review}/target`)).status(), 200)
      mutate('revoke', data.staff_profile)
      assert.equal((await api(`notifications/${data.ids.review}/target`)).status(), 404)
      const final = await api(`staff/applications/${data.application}`)
      assert.ok([403, 404].includes(final.status()))
    }
    await logout()
  }
  check('teacher/staff/admin private centers and reads; staff target grant revoked in real DB')

  await login('student')
  mutate('transfer', data.student, data.other_group)
  assert.equal((await api(`notifications/${data.ids.course}/target`)).status(), 404)
  assert.equal((await api(`academics/courses/${data.course}`)).status(), 404)
  check('group change independently revokes resolver and direct course API')
  await logout()
  await login('other')
  await badge(1)
  await open()
  await row('other').waitFor()
  assert.equal(await drawer().getByText('NOTIFY application', { exact: true }).count(), 0)
  await close()
  await page.setViewportSize({ width: 1440, height: 900 })
  await open()
  await page.keyboard.press('Tab')
  assert.equal(await drawer().evaluate((el) => el.contains(document.activeElement)), true)
  await close()
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Уведомления"]') === document.activeElement,
  )
  assert.equal(await bell().evaluate((el) => el === document.activeElement), true)
  check('account isolation, 1440px keyboard focus and Escape')
  await open()
  await context.setOffline(true)
  await read('other')
  await drawer().getByRole('alert').waitFor()
  assert.equal(
    await row('other').getByRole('button', { name: 'Отметить прочитанным', exact: true }).count(),
    1,
  )
  await context.setOffline(false)
  await count(1)
  await close()
  check('offline read reports failure and preserves unread state until confirmed retry')
  let releasePatch
  let enteredPatch
  let finishPatch
  const patchFinished = new Promise((resolve) => {
    finishPatch = resolve
  })
  const patchEntered = new Promise((resolve) => {
    enteredPatch = resolve
  })
  const patchGate = new Promise((resolve) => {
    releasePatch = resolve
  })
  const delayedPatch = `**/api/v1/notifications/${data.ids.other}/read`
  await page.route(delayedPatch, async (route) => {
    const response = await route.fetch()
    enteredPatch()
    await patchGate
    await route.fulfill({ response }).catch(() => {})
    finishPatch()
  })
  await open()
  await read('other')
  await patchEntered
  await badge(1)
  await close()
  await logout()
  await login('student')
  await badge(0)
  releasePatch()
  await patchFinished
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await page.unroute(delayedPatch)
  await open()
  await row('application').waitFor()
  assert.equal(await drawer().getByText('NOTIFY other', { exact: true }).count(), 0)
  await badge(0)
  await close()
  check(
    'late committed PATCH after close/logout/account switch cannot restore previous personal state',
  )
  const revoked = await api('auth/logout', 'POST')
  assert.equal(revoked.status(), 200)
  assert.equal((await api('notifications/unread-count')).status(), 401)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('heading', { name: 'Вход в систему', exact: true }).waitFor()
  assert.equal(await page.getByRole('status', { name: 'Непрочитанных: 0', exact: true }).count(), 0)
  check('real revoked session yields 401 and clears private counter/UI')
  await login('empty')
  await badge(0)
  await count(0)
  await open()
  await drawer().getByText('Пока нет уведомлений.', { exact: true }).waitFor()
  assert.equal(await drawer().locator('article.notification-item').count(), 0)
  assert.equal(
    await drawer().getByRole('button', { name: 'Отметить все прочитанными', exact: true }).count(),
    0,
  )
  await close()
  check('real empty feed and zero count expose no invented rows or read-all action')
} finally {
  await context.close()
  await browser.close()
}
