/* global process, console, window, document, Event, URL */
// Real FastAPI/PostgreSQL logins and permission changes. Fault injection is limited
// to supplementary error/late-response cases after a real login.
import assert from 'node:assert/strict'
import { scaleVisibleText } from './academicsGeometry.mjs'
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
  if (await page.getByRole('button', { name: 'Меню пользователя' }).count())
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

async function failAccessRead(page, path, status) {
  await page.route(`**${path}`, (route) =>
    status
      ? route.fulfill({
          status,
          json: {
            error: {
              code: status >= 500 ? 'internal_error' : 'forbidden',
              message: '',
              details: [],
            },
          },
        })
      : route.abort('failed'),
  )
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await page.getByRole('region', { name: 'Восстановление доступа' }).waitFor()
  assert.equal(await page.getByRole('textbox').count(), 0)
  assert.equal(await page.locator('.student-shell').isVisible(), false)
  assert.equal(
    await page.evaluate(() => Boolean(document.activeElement.closest('[hidden], [inert]'))),
    false,
  )
}
async function recoverAccessRead(page, path) {
  await page.unroute(`**${path}`)
  await page.getByRole('button', { name: 'Повторить', exact: true }).click()
  await page.getByRole('region', { name: 'Восстановление доступа' }).waitFor({ state: 'hidden' })
}
async function openNextForm(page) {
  await page.getByRole('link', { name: /К каталогу услуг/ }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('dialog[open]') ||
      document.querySelector('h1')?.textContent === 'Услуги и документы',
  )
  const dialog = page.getByRole('dialog')
  if (await dialog.count())
    await dialog.getByRole('button', { name: /^(Выйти|Покинуть форму)$/ }).click()
  await heading(page, 'Услуги и документы')
  await page.getByRole('link', { name: 'Подать заявление', exact: true }).click()
  await heading(page, 'Справка об обучении')
}
async function assertApplicationRecovery(page) {
  let posts = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/applications' && request.method() === 'POST')
      posts++
  })
  const trigger = page.getByRole('button', { name: 'Открыть меню' })
  if (await trigger.isVisible()) {
    await trigger.click()
    await page
      .getByRole('dialog', { name: 'Мобильная навигация' })
      .getByRole('link', { name: 'Услуги и документы' })
      .click()
  } else await page.getByRole('link', { name: 'Услуги и документы' }).click()
  await heading(page, 'Услуги и документы')
  await page.getByRole('link', { name: 'Подать заявление', exact: true }).click()
  await heading(page, 'Справка об обучении')
  for (const [path, status] of [
    ['/api/v1/auth/context', 0],
    ['/api/v1/users/me', 503],
  ]) {
    const field = page.getByRole('textbox')
    await field.fill('Вымышленный черновик, который нельзя потерять')
    await field.evaluate((node) => {
      window.retainedRoleField = node
    })
    await failAccessRead(page, path, status)
    await recoverAccessRead(page, path)
    assert.equal(await field.inputValue(), 'Вымышленный черновик, который нельзя потерять')
    assert.equal(
      await field.evaluate(
        (node) => node === window.retainedRoleField && node === document.activeElement,
      ),
      true,
    )
    assert.equal(posts, 0)
    // The router blocker survives while hidden; no modal can escape into the error page.
    await failAccessRead(page, path, 500)
    await page.goBack()
    await page.waitForURL(`${baseURL}/services/study_certificate`)
    assert.equal(new URL(page.url()).pathname, '/services/study_certificate')
    assert.equal(await page.getByRole('dialog').count(), 0)
    await recoverAccessRead(page, path)
    await page.getByRole('dialog', { name: 'Выйти без сохранения?' }).waitFor()
    await page.getByRole('button', { name: 'Продолжить заполнение' }).click()
    assert.equal(await field.inputValue(), 'Вымышленный черновик, который нельзя потерять')
    await openNextForm(page)
    check(
      `${path}: hidden/inert draft, same DOM instance, focus and Back blocker survive network/5xx`,
    )
  }
  for (const path of ['/api/v1/auth/context', '/api/v1/users/me']) {
    for (const outcome of ['confirmed', 'uncertain']) {
      const before = posts
      const field = page.getByRole('textbox')
      await field.fill(`Вымышленное единственное заявление ${outcome}`)
      await field.evaluate((node) => {
        window.retainedRoleField = node
      })
      let release
      let forwarded
      let created
      const held = new Promise((resolve) => {
        release = resolve
      })
      const saved = new Promise((resolve) => {
        forwarded = resolve
      })
      const intercept = async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        const response = await route.fetch()
        assert.equal(response.status(), 201)
        created = (await response.json()).id
        forwarded()
        await held
        if (outcome === 'confirmed') await route.fulfill({ response })
        else await route.abort('failed')
      }
      await page.route('**/api/v1/applications', intercept)
      await page.getByRole('button', { name: 'Отправить заявление', exact: true }).click()
      await saved
      await failAccessRead(page, path, 503)
      await recoverAccessRead(page, path)
      assert.equal(await field.evaluate((node) => node === window.retainedRoleField), true)
      assert.equal(await page.getByRole('button', { name: 'Отправляем…' }).isDisabled(), true)
      await field.evaluate((node) => node.closest('form').requestSubmit())
      assert.equal(posts, before + 1)
      // Deliver success/unknown outcome while the access layer is blocked again.
      await failAccessRead(page, path, 0)
      release()
      if (outcome === 'confirmed')
        await page.locator('.application-success').waitFor({ state: 'attached' })
      else
        await page
          .locator('a')
          .filter({ hasText: 'Проверить результат в моих заявлениях' })
          .waitFor({ state: 'attached' })
      assert.equal(
        await page
          .getByRole('region', { name: 'Восстановление доступа' })
          .evaluate((node) => node.contains(document.activeElement)),
        true,
      )
      await recoverAccessRead(page, path)
      if (outcome === 'confirmed') {
        await heading(page, 'Заявление создано')
        assert.ok((await page.locator('.application-success').innerText()).includes(`№ ${created}`))
      } else {
        assert.equal(await field.inputValue(), `Вымышленное единственное заявление ${outcome}`)
        assert.equal(
          await page.getByRole('button', { name: 'Отправить заявление', exact: true }).isDisabled(),
          true,
        )
        assert.equal(
          await page
            .getByRole('link', { name: 'Проверить результат в моих заявлениях' })
            .evaluate((node) => node === document.activeElement),
          true,
        )
        await field.evaluate((node) => node.closest('form').requestSubmit())
      }
      assert.equal(posts, before + 1)
      await page.unroute('**/api/v1/applications', intercept)
      await openNextForm(page)
      check(
        `${path}: real saved POST ${created}, pending/${outcome} survives recovery, exactly one POST`,
      )
    }
  }
  // A body-level portal and its locks must also be hidden during a failed recheck.
  await page.getByRole('button', { name: 'Уведомления', exact: true }).click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await failAccessRead(page, '/api/v1/auth/context', 503)
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.evaluate(() => document.getElementById('root').inert), false)
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden')
  await recoverAccessRead(page, '/api/v1/auth/context')
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  check('portalled notifications, focus trap and body locks suspend and recover safely')
  await page.goto(`${baseURL}/schedule`)
  await heading(page, 'Расписание')
}
async function assertAllGrantsNavigation() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 500 } })
  const page = await context.newPage()
  const grants = page.waitForResponse(
    (response) => response.url().endsWith('/auth/context') && response.status() === 200,
    { timeout: 180000 },
  )
  await login(page, 'role-e2e-all')
  assert.equal((await (await grants).json()).permissions.length, 9)
  await heading(page, 'Заявления')
  const sidebar = page.locator('.desktop-sidebar')
  const navigation = sidebar.getByRole('navigation')
  assert.equal(await navigation.getByRole('link').count(), 9)
  for (const scale of [1, 2]) {
    if (scale === 2) await scaleVisibleText(page, 2, '.desktop-sidebar', false)
    for (const collapsed of [false, true]) {
      if (collapsed) await sidebar.getByRole('button', { name: 'Свернуть меню' }).click()
      await sidebar.evaluate(async (node) => {
        node.getBoundingClientRect()
        await Promise.all(
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        )
      })
      const links = navigation.getByRole('link')
      await links.first().focus()
      for (let index = 1; index < 9; index++) await page.keyboard.press('Tab')
      assert.equal(await links.last().evaluate((node) => node === document.activeElement), true)
      await page.waitForFunction(() => {
        const navigation = document.querySelector('.desktop-sidebar nav')
        const last = navigation?.querySelector('a:last-child')
        if (!navigation || !last) return false
        const nav = navigation.getBoundingClientRect()
        const link = last.getBoundingClientRect()
        return link.top >= nav.top && link.bottom <= nav.bottom
      })
      const geometry = await navigation.evaluate((node) => {
        const nav = node.getBoundingClientRect()
        const last = node.querySelector('a:last-child').getBoundingClientRect()
        const brand = document.querySelector('.sidebar-brand-link').getBoundingClientRect()
        const collapse = document.querySelector('.sidebar-collapse').getBoundingClientRect()
        return {
          scroll: node.scrollTop,
          horizontal: node.scrollWidth - node.clientWidth,
          lastVisible: last.top >= nav.top && last.bottom <= nav.bottom,
          pinned: brand.top >= 0 && collapse.bottom <= window.innerHeight,
        }
      })
      assert.equal(geometry.lastVisible, true)
      assert.equal(geometry.pinned, true)
      assert.ok(geometry.horizontal <= 1)
      assert.ok(geometry.scroll > 0)
      await page.keyboard.press('Enter')
      await heading(page, 'Публикация новостей')
      assert.equal(
        await navigation
          .getByRole('link', { name: 'Публикация новостей' })
          .getAttribute('aria-current'),
        'page',
      )
      await page.keyboard.press('Tab')
      assert.equal(
        await sidebar.getByRole('button').evaluate((node) => node === document.activeElement),
        true,
      )
      if (collapsed) await page.keyboard.press('Enter')
      check(
        `all 9 real grants at 1440x500, ${scale * 100}% text, ${collapsed ? 'collapsed' : 'expanded'} sidebar: last link, focus, pinned controls, no horizontal scroll`,
      )
    }
  }
  await page.screenshot({ path: 'work/role-all-grants-1440-500.png' })
  await context.close()
}
try {
  for (const [name, path, title] of [
    ['teacher', '/teacher/journals', 'Мои журналы'],
    ['admin', '/admin/users', 'Пользователи'],
    ['reviewer', '/staff/applications', 'Заявления'],
    ['editor', '/staff', 'Кабинет сотрудника'],
    ['empty', '/staff', 'Нет доступных разделов'],
  ].filter(() => !process.env.ROLE_TEST_REVIEW_ONLY)) {
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
      await failAccessRead(page, '/api/v1/auth/context', 503)
      fixture('edit')
      await page.unroute('**/api/v1/auth/context')
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
  await assertAllGrantsNavigation()
  const context = await browser.newContext({ viewport: { width: 360, height: 900 } })
  const page = await context.newPage()
  await login(page, 'schedule-fixture-1', 'fictional-schedule-password')
  await heading(page, 'Расписание')
  await assertApplicationRecovery(page)
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
  await failAccessRead(page, '/api/v1/auth/context', 503)
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
  assert.equal(await page.locator('.profile-page').count(), 0)
  check(
    'suspended student → logout → teacher destroys retained profile and ignores late authorization response',
  )
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
