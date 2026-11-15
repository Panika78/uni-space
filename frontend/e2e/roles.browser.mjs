/* global process, console, window, document, Event, URL */
// Real FastAPI/PostgreSQL logins and permission changes. Fault injection is limited
// to supplementary error/late-response cases after a real login.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.ROLE_TEST_URL || 'http://localhost:5173'
const password = 'Fictional-Role-E2E-Password-2026'
const fixture = (mode) =>
  execFileSync(
    'uv',
    [
      'run',
      '--locked',
      '--python',
      '3.12.16',
      '--project',
      'backend',
      'python',
      'frontend/e2e/role-fixtures.py',
      mode,
    ],
    { env: { ...process.env, PYTHONPATH: 'backend' }, stdio: 'pipe' },
  )
fixture('seed')
fixture('review')
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const heading = (page, name) => page.getByRole('heading', { name, exact: true }).waitFor()
const check = (message) => console.log(`PASS ${message}`)
async function login(page, loginName, loginPassword = password) {
  await page.goto(`${baseURL}/login`)
  await heading(page, 'Вход в систему')
  await page.getByLabel('Логин', { exact: true }).fill(loginName)
  await page.getByLabel('Пароль', { exact: true }).fill(loginPassword)
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = page.waitForResponse((r) => r.url().endsWith('/auth/login'))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const result = await response
    if (result.status() !== 429) {
      assert.equal(result.status(), 200)
      return
    }
    await page.waitForTimeout((Number(result.headers()['retry-after']) + 1) * 1000)
  }
  throw new Error('Login remained rate limited')
}
async function logout(page) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Выйти из аккаунта?' })
    .getByRole('button', { name: 'Выйти', exact: true })
    .click()
  await heading(page, 'Вход в систему')
}
async function activate(page) {
  const response = page.waitForResponse((r) => r.url().endsWith('/auth/context'))
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await response
}
try {
  for (const [name, path, title] of [
    ['teacher', '/teacher/journals', 'Мои журналы'],
    ['admin', '/admin/users', 'Пользователи'],
    ['reviewer', '/staff/applications', 'Заявления'],
    ['editor', '/staff', 'Кабинет сотрудника'],
    ['empty', '/staff', 'Нет доступных разделов'],
  ]) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const requests = []
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/v1/')) requests.push(r.url())
    })
    await login(page, `role-e2e-${name}`)
    await heading(page, title)
    assert.equal(new URL(page.url()).pathname, path)
    await page.reload()
    await heading(page, title)
    assert.equal(new URL(page.url()).pathname, path)
    assert.ok(requests.every((url) => /\/auth\//.test(url)))
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      // The reused sidebar has a 180ms width transition across the breakpoint.
      await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
      if (width === 360) {
        const trigger = page.getByRole('button', { name: 'Открыть меню' })
        await trigger.click()
        const drawer = page.getByRole('dialog', { name: 'Мобильная навигация' })
        await drawer.waitFor()
        assert.equal(
          await drawer
            .getByRole('button', { name: 'Закрыть меню' })
            .evaluate((e) => e === document.activeElement),
          true,
        )
        await page.keyboard.press('Shift+Tab')
        assert.equal(await drawer.evaluate((e) => e.contains(document.activeElement)), true)
        await page.keyboard.press('Escape')
        await drawer.waitFor({ state: 'hidden' })
        assert.equal(await trigger.evaluate((e) => e === document.activeElement), true)
        if (name === 'teacher') {
          await trigger.click()
          await drawer.getByRole('link', { name: 'Расписание', exact: true }).click()
          await heading(page, 'Расписание')
          await drawer.waitFor({ state: 'hidden' })
          await trigger.click()
          await page.goBack()
          await heading(page, title)
          await drawer.waitFor({ state: 'hidden' })
        }
      } else if (name !== 'empty') {
        await page.getByRole('button', { name: 'Свернуть меню' }).click()
        await page.getByRole('button', { name: 'Развернуть меню' }).waitFor()
        if (name === 'teacher') {
          await page.getByRole('link', { name: 'Расписание', exact: true }).focus()
          await page.keyboard.press('Enter')
          await heading(page, 'Расписание')
          await page.goBack()
          await heading(page, title)
          await page.getByRole('button', { name: 'Развернуть меню' }).waitFor()
        }
      }
      await page.screenshot({ path: `work/role-${name}-${width}.png` })
      check(`${name}: login/reload, shell, keyboard, no overflow at ${width}px`)
    }
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
    assert.equal(await page.getByRole('link', { name: 'Мой профиль' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Уведомления' }).count(), 0)
    assert.equal(
      await page
        .getByRole('button', { name: /Создать|Удалить|Одобрить|Отклонить|Сохранить/ })
        .count(),
      0,
    )
    await page.goto(`${baseURL}/schedule`)
    await page.getByRole('alert').filter({ hasText: 'Доступ запрещён' }).waitFor()
    assert.ok(requests.every((url) => /\/auth\//.test(url)))
    if (name === 'reviewer') {
      await page.goto(`${baseURL}/staff/applications`)
      await heading(page, 'Заявления')
      fixture('edit')
      await activate(page)
      await page.getByRole('alert').filter({ hasText: 'Доступ запрещён' }).waitFor()
      assert.equal(await page.getByRole('link', { name: 'Заявления', exact: true }).count(), 0)
      await page.goto(`${baseURL}/staff`)
      await heading(page, 'Редактор расписания')
      fixture('revoke')
      await activate(page)
      await heading(page, 'Нет доступных разделов')
      await page.goto(`${baseURL}/staff/applications`)
      await page.getByRole('alert').filter({ hasText: 'Доступ запрещён' }).waitFor()
      check('real DB grant change/revocation affects focus, navigation and direct URL')
      fixture('review')
    }
    await context.close()
  }
  const context = await browser.newContext({ viewport: { width: 360, height: 900 } })
  const page = await context.newPage()
  await login(page, 'schedule-fixture-1', 'fictional-schedule-password')
  await heading(page, 'Расписание')
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('link', { name: 'Мой профиль' }).click()
  await heading(page, 'Мой профиль')
  const previousName = await page.locator('.profile-heading h2').innerText()
  await page.goto(`${baseURL}/admin/users`)
  await page.getByRole('alert').filter({ hasText: 'Доступ запрещён' }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Пользователи', exact: true }).count(), 0)
  await page.goto(`${baseURL}/profile`)
  await heading(page, 'Мой профиль')
  check('student direct admin URL is denied without rendering an admin module')
  let release
  let notify
  const held = new Promise((resolve) => {
    notify = resolve
  })
  await page.route('**/api/v1/auth/context', async (route) => {
    await page.unroute('**/api/v1/auth/context')
    const response = await route.fetch()
    notify()
    await new Promise((resolve) => {
      release = resolve
    })
    await route.fulfill({ response }).catch(() => {})
  })
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await held
  await logout(page)
  await login(page, 'role-e2e-teacher')
  await heading(page, 'Мои журналы')
  release()
  await page.waitForTimeout(300)
  assert.equal(await page.getByText(previousName, { exact: true }).count(), 0)
  assert.equal(new URL(page.url()).pathname, '/teacher/journals')
  check('student → logout → teacher isolates real profile and late authorization response')
  for (const [status, title] of [
    [403, 'Доступ запрещён'],
    [500, 'Сервис временно недоступен'],
    [0, 'Не удалось связаться с сервером'],
  ]) {
    await page.route('**/api/v1/auth/context', (route) =>
      status
        ? route.fulfill({
            status,
            json: {
              error: {
                code: status === 403 ? 'forbidden' : 'internal_error',
                message: 'private detail',
                details: [],
              },
            },
          })
        : route.abort('failed'),
    )
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
    await page.getByRole('alert').filter({ hasText: title }).waitFor()
    assert.equal(await page.getByText('Нет доступных разделов').count(), 0)
    if (status === 403)
      assert.equal(await page.getByRole('button', { name: 'Повторить' }).count(), 0)
    await page.unroute('**/api/v1/auth/context')
    await page.reload()
    await heading(page, 'Мои журналы')
    check(`context ${status || 'network'} is distinct from absent permissions`)
  }
  await page.route('**/api/v1/auth/context', (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'session_invalid', message: '', details: [] } },
    }),
  )
  await activate(page)
  await heading(page, 'Вход в систему')
  check('context 401 clears session and returns to login')
  await context.close()
} finally {
  fixture('review')
  await browser.close()
}
