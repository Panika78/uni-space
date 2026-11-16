/* global process, URL, document, window */
// Exercise password flows with the live API/PostgreSQL fixture through Chromium.
import assert from 'node:assert/strict'

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { chromium } = playwright.default ?? playwright
const baseURL = process.env.PASSWORD_E2E_URL || 'http://localhost:5173'
const initialPassword = process.env.PASSWORD_E2E_INITIAL_PASSWORD
assert.ok(initialPassword, 'Provide the fictional PASSWORD_E2E_INITIAL_PASSWORD fixture')

const roles = ['student', 'teacher', 'staff', 'admin']
const credentials = Object.fromEntries(
  roles.map((role) => [
    role,
    {
      login: process.env[`PASSWORD_E2E_${role.toUpperCase()}_LOGIN`],
      id: process.env[`PASSWORD_E2E_${role.toUpperCase()}_ID`],
    },
  ]),
)
for (const role of roles) {
  assert.ok(credentials[role].login, `Missing fictional ${role} login`)
  assert.ok(credentials[role].id, `Missing fictional ${role} ID`)
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  timeout: 15_000,
  args: ['--no-sandbox'],
})
const contexts = []
const roleContexts = {}
const check = (name) => console.log(`PASS ${name}`)
const assertNoHorizontalOverflow = async (page, width, scenario) => {
  const actual = await page.evaluate(() => document.documentElement.scrollWidth)
  assert.ok(actual <= width, `${scenario}: ${actual}px document overflow at ${width}px`)
}
const login = async (page, loginName, password) => {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(loginName)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Меню пользователя' }).waitFor()
}
const openSettingsFromMenu = async (page) => {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('heading', { name: 'Смена пароля' }).waitFor()
}
const fillAndChange = async (page, currentPassword, nextPassword) => {
  await page.getByLabel('Действующий пароль').fill(currentPassword)
  await page.getByLabel('Новый пароль').fill(nextPassword)
  await page.getByLabel('Повторите новый пароль').fill(nextPassword)
  await page.getByRole('button', { name: 'Сменить пароль' }).click()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
}

try {
  for (const [index, role] of roles.entries()) {
    const { login: loginName } = credentials[role]
    const context = await browser.newContext({ viewport: { width: 360, height: 850 } })
    roleContexts[role] = context
    contexts.push(context)
    const page = await context.newPage()
    await login(page, loginName, initialPassword)
    await assertNoHorizontalOverflow(page, 360, `${role} cabinet`)
    await openSettingsFromMenu(page)
    await assertNoHorizontalOverflow(page, 360, `${role} settings`)
    assert.equal(await page.getByLabel('Действующий пароль').getAttribute('type'), 'password')
    await page.getByLabel('Показать пароль').check()
    assert.equal(await page.getByLabel('Новый пароль').getAttribute('type'), 'text')
    await page.getByLabel('Показать пароль').uncheck()

    // A second page in this browser storage partition receives the terminal auth epoch.
    const sibling = await context.newPage()
    await sibling.goto(`${baseURL}/settings`)
    await sibling.getByRole('heading', { name: 'Смена пароля' }).waitFor()

    // A separate context models another device with an independent refresh cookie.
    const device = await browser.newContext({ viewport: { width: 360, height: 850 } })
    contexts.push(device)
    const devicePage = await device.newPage()
    await login(devicePage, loginName, initialPassword)

    const newPassword = `Fictional ${role} phrase ${index + 1} 2026`
    await fillAndChange(page, initialPassword, newPassword)
    await page.getByRole('status').filter({ hasText: 'Пароль изменён' }).waitFor()
    await sibling.getByRole('heading', { name: 'Вход в систему' }).waitFor()

    await devicePage.goto(`${baseURL}/settings`)
    await devicePage.getByRole('heading', { name: 'Вход в систему' }).waitFor()
    await login(page, loginName, newPassword)
    await page.setViewportSize({ width: 1440, height: 900 })
    await openSettingsFromMenu(page)
    await assertNoHorizontalOverflow(page, 1440, `${role} desktop settings`)
    assert.ok(await page.getByLabel('Новый пароль').isVisible())
    check(`${role} self-change, other tabs/devices, and 360/1440 px`)
  }

  const admin = roleContexts.admin
  const page = admin.pages()[0]
  const teacherId = credentials.teacher.id
  const teacherLogin = credentials.teacher.login
  await page.goto(`${baseURL}/admin/users`)
  await page.getByLabel('Логин или ФИО').fill(teacherLogin)
  await page.getByRole('button', { name: 'Найти' }).click()
  await page.getByRole('link', { name: new RegExp(teacherLogin) }).click()
  await page.getByRole('heading', { name: 'Fictional Password E2E teacher' }).waitFor()
  assert.equal(new URL(page.url()).pathname, `/admin/users/${teacherId}`)

  let lostResponseCount = 0
  await page.route(`**/api/v1/admin/users/${teacherId}/password-reset`, async (route) => {
    lostResponseCount += 1
    await route.fetch()
    await route.abort('failed')
  })
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  await page.getByRole('alert').filter({ hasText: 'Ответ на сброс не получен' }).waitFor()
  assert.equal(lostResponseCount, 1, 'A reset with a lost response must not be retried')
  await page.unroute(`**/api/v1/admin/users/${teacherId}/password-reset`)
  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  const secret = await page.locator('.admin-secret').textContent()
  assert.ok(secret && secret.length >= 32)
  await page.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }).click()
  assert.equal(await page.locator('.admin-secret').count(), 0)
  await page.reload()
  assert.equal(await page.getByText(secret, { exact: true }).count(), 0)
  const verificationContext = await browser.newContext({ viewport: { width: 360, height: 850 } })
  contexts.push(verificationContext)
  const verificationPage = await verificationContext.newPage()
  await verificationPage.goto(`${baseURL}/login`)
  await verificationPage.getByLabel('Логин', { exact: true }).fill(teacherLogin)
  await verificationPage
    .getByLabel('Пароль', { exact: true })
    .fill('Fictional teacher phrase 2 2026')
  await verificationPage.getByRole('button', { name: 'Войти', exact: true }).click()
  await verificationPage.getByRole('status').filter({ hasText: 'Неверный логин или пароль' }).waitFor()
  await verificationPage.getByLabel('Пароль', { exact: true }).fill(secret)
  await verificationPage.getByRole('button', { name: 'Войти', exact: true }).click()
  await verificationPage.getByRole('button', { name: 'Меню пользователя' }).waitFor()
  check('admin one-time reset, lost-response handling, and no re-display')
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
}
