/* global process, console, window, document */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
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
    'frontend/e2e/admin-fixtures.py',
  ],
  { env: { ...process.env, PYTHONPATH: 'backend' }, stdio: 'pipe' },
)
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
const base = process.env.ADMIN_TEST_URL || 'http://localhost:5173'
const suffix = Date.now().toString()
const userDetailsLink = (page, loginName) =>
  page
    .locator('.admin-users__table tbody tr')
    .filter({ hasText: loginName })
    .getByRole('link', { name: /Подробнее/ })
async function chooseLookup(page, label, search) {
  const input = page.getByRole('combobox', { name: label, exact: true })
  await input.fill(search)
  const option = page.getByRole('option').filter({ hasText: search }).first()
  await option.waitFor({ state: 'visible' })
  const id = await option.getAttribute('data-value')
  assert.ok(id)
  assert.match(await option.textContent(), new RegExp(`ID ${id}`))
  await option.click()
  return id
}
async function login(page, name, password) {
  await page.goto(base + '/login')
  await page.getByLabel('Логин', { exact: true }).fill(name)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = page.waitForResponse((response) => response.url().endsWith('/auth/login'))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const response = await pending
    if (response.status() !== 429) {
      assert.equal(response.status(), 200)
      return
    }
    await page.waitForTimeout((Number(response.headers()['retry-after']) + 1) * 1000)
  }
  throw new Error('Login remained rate limited')
}
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('dialog', (dialog) => dialog.accept())
  let authorization
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/'))
      authorization = request.headers().authorization || authorization
  })
  await login(page, 'admin-browser-operator', 'Fictional-Admin-Browser-2026')
  await page.getByRole('heading', { name: 'Пользователи', exact: true }).waitFor()
  const checkWidth = async () =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    )
  let staffId, staffPassword
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await checkWidth()
    for (const role of ['student', 'teacher', 'staff', 'admin']) {
      let selectedTeacherId
      await page.getByRole('link', { name: 'Создать пользователя' }).click()
      await page.getByLabel('Логин', { exact: true }).fill(`browser-${role}-${width}-${suffix}`)
      const fullName =
        role === 'staff'
          ? `Вымышленный сотрудник ${'Длинное имя '.repeat(18)}`
          : 'Вымышленный пользователь'
      await page.getByLabel('ФИО', { exact: true }).fill(fullName)
      await page.getByLabel('Роль', { exact: true }).selectOption(role)
      if (role !== 'admin') {
        const name =
          role === 'student'
            ? 'Admin Browser Group'
            : role === 'teacher'
              ? 'Admin Browser Free Teacher'
              : 'Admin Browser Dean'
        const pickerLabel =
          role === 'student'
            ? 'Учебная группа'
            : role === 'teacher'
              ? 'Свободный преподаватель'
              : 'Подразделение'
        const value = await chooseLookup(page, pickerLabel, name)
        if (role === 'teacher') selectedTeacherId = value
      }
      await page.getByRole('button', { name: 'Создать', exact: true }).click()
      await page.getByRole('heading', { name: 'Пользователь создан', exact: true }).waitFor()
      const secret = await page.locator('.admin-secret').textContent()
      assert.ok(secret.length >= 32)
      assert.equal(
        await page
          .getByRole('heading', { name: 'Пользователь создан' })
          .evaluate((el) => el === document.activeElement),
        true,
      )
      await checkWidth()
      const href = await page
        .getByRole('link', { name: 'Открыть учётную запись' })
        .getAttribute('href')
      await page.getByRole('link', { name: 'Открыть учётную запись' }).click()
      await page.getByRole('button', { name: 'Заблокировать', exact: true }).waitFor()
      assert.equal(await page.getByText(secret, { exact: true }).count(), 0)
      if (role === 'teacher') {
        const teacherProfile = page
          .locator('.admin-user-detail__facts > div')
          .filter({ has: page.getByText('Профиль преподавателя', { exact: true }) })
        await teacherProfile.waitFor()
        assert.equal(await teacherProfile.locator('dd').textContent(), `ID ${selectedTeacherId}`)
      }
      await checkWidth()
      if (role === 'staff') {
        staffId = href.split('/').at(-1)
        staffPassword = secret
        await page.getByLabel('Разрешение', { exact: true }).selectOption('grades.edit')
        await page.getByRole('button', { name: 'Выдать разрешение' }).click()
        await page.getByRole('button', { name: 'Отозвать grades.edit' }).waitFor()
        await page.getByRole('button', { name: 'Отозвать grades.edit' }).click()
        await page.getByText('Разрешений нет.', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Выдать разрешение' }).click()
        await page.getByRole('button', { name: 'Отозвать grades.edit' }).waitFor()
        await chooseLookup(page, 'Подразделение', 'Admin Browser Accounting')
        await page.getByRole('button', { name: 'Сменить подразделение и отозвать права' }).click()
        await page.getByText('Разрешений нет.', { exact: true }).waitFor()
        assert.equal(await page.getByRole('option', { name: /grades.edit/ }).count(), 0)
        assert.deepEqual(
          await page
            .getByLabel('Разрешение', { exact: true })
            .locator('option')
            .evaluateAll((options) => options.map((o) => o.value)),
          ['applications.review', 'news.publish'],
        )
        // Return to the dean office: academic options must reappear, without old grants.
        await chooseLookup(page, 'Подразделение', 'Admin Browser Dean')
        await page.getByRole('button', { name: 'Сменить подразделение и отозвать права' }).click()
        await page.getByRole('option', { name: /grades.edit/ }).waitFor({ state: 'attached' })
        assert.equal(await page.getByRole('button', { name: 'Отозвать grades.edit' }).count(), 0)
        for (const permission of ['schedule.edit', 'grades.edit', 'attendance.edit']) {
          await page.getByLabel('Разрешение', { exact: true }).selectOption(permission)
          await page.getByRole('button', { name: 'Выдать разрешение' }).click()
          await page.getByRole('button', { name: `Отозвать ${permission}` }).waitFor()
        }
        assert.equal(await page.locator('.admin-user-detail__grants > li').count(), 3)
        for (const permission of ['schedule.edit', 'grades.edit', 'attendance.edit']) {
          await page.getByRole('button', { name: `Отозвать ${permission}` }).click()
        }
        await page.getByText('Разрешений нет.', { exact: true }).waitFor()
        await checkWidth()
      }
      await page.getByRole('button', { name: 'Заблокировать', exact: true }).click()
      await page.getByRole('button', { name: 'Разблокировать', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Разблокировать', exact: true }).click()
      await page.getByRole('button', { name: 'Заблокировать', exact: true }).waitFor()
      await page.getByRole('link', { name: 'К списку пользователей' }).click()
    }
  }
  // Commit through the real API, then deliberately lose only the HTTP response.
  let creates = 0
  await page.route('**/api/v1/admin/users', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    creates++
    await route.fetch()
    await route.abort('failed')
  })
  await page.getByRole('link', { name: 'Создать пользователя' }).click()
  await page.getByLabel('Логин', { exact: true }).fill(`lost-${suffix}`)
  await page.getByLabel('ФИО', { exact: true }).fill('Вымышленный')
  await page.getByLabel('Роль', { exact: true }).selectOption('admin')
  await page.getByRole('button', { name: 'Создать', exact: true }).click()
  await page.getByRole('link', { name: 'Проверить список по логину' }).click()
  await userDetailsLink(page, `lost-${suffix}`).waitFor()
  assert.equal(creates, 1)
  await page.unroute('**/api/v1/admin/users')
  // Independent browser session loses permissions and tokens immediately.
  const staffContext = await browser.newContext()
  const staffPage = await staffContext.newPage()
  await login(staffPage, `browser-staff-360-${suffix}`, staffPassword)
  await staffPage.getByRole('heading', { name: 'Нет доступных разделов', exact: true }).waitFor()
  await page.goto(base + `/admin/users/${staffId}`)
  await page.getByLabel('Разрешение', { exact: true }).selectOption('applications.review')
  await page.getByRole('button', { name: 'Выдать разрешение' }).click()
  await page.getByRole('button', { name: 'Отозвать applications.review' }).waitFor()
  await staffPage.reload()
  await staffPage.getByRole('link', { name: 'Заявления', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Отозвать applications.review' }).click()
  await page.getByText('Разрешений нет.', { exact: true }).waitFor()
  await staffPage.reload()
  await staffPage.getByRole('heading', { name: 'Нет доступных разделов', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).click()
  await page.getByRole('button', { name: 'Разблокировать', exact: true }).waitFor()
  await staffPage.reload()
  await staffPage.getByRole('heading', { name: 'Вход в систему', exact: true }).waitFor()
  await page.goto(base + '/admin/users')
  await page.getByLabel('Логин или ФИО').fill('browser-')
  await page.getByRole('button', { name: 'Найти', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page
    .locator('.admin-users__table tbody tr')
    .filter({ hasText: 'browser-' })
    .first()
    .waitFor()
  await checkWidth()
  // Real keyset pagination, using only fictional accounts in the isolated fixture DB.
  for (let i = 0; i < 21; i++) {
    const response = await context.request.post(base + '/api/v1/admin/users', {
      headers: { Authorization: authorization },
      data: { login: `pagination-${suffix}-${i}`, full_name: 'Вымышленный', role: 'admin' },
    })
    assert.equal(response.status(), 201)
  }
  await page.getByLabel('Логин или ФИО').fill(`pagination-${suffix}`)
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  await page.getByRole('button', { name: 'Следующая страница', exact: true }).click()
  await userDetailsLink(page, `pagination-${suffix}-20`).waitFor()
  await page.getByRole('button', { name: 'Начало списка', exact: true }).click()
  await page.getByRole('button', { name: 'Следующая страница', exact: true }).waitFor()
  await userDetailsLink(page, `pagination-${suffix}-0`).click()
  await page.getByRole('button', { name: 'Заблокировать', exact: true }).waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: 'Пользователи', exact: true }).waitFor()
  await page.getByLabel('Логин или ФИО').fill(`absent-${suffix}`)
  await page.getByRole('button', { name: 'Найти', exact: true }).click()
  await page.getByText('Пользователи не найдены.', { exact: true }).waitFor()
  // Supplementary read failure; creation and all writes above use the real backend.
  await page.route('**/api/v1/admin/users?**', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden', details: [] } }),
    }),
  )
  await page.reload()
  await page.getByRole('alert').filter({ hasText: 'Доступ запрещён' }).waitFor()
  await checkWidth()
  await page.unroute('**/api/v1/admin/users?**')
  console.log(
    'PASS admin: all roles, one-time password, lost committed response, activity, grants, department, independent session, keyboard and 360/1440px',
  )
} finally {
  await browser.close()
}
