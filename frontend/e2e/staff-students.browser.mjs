/* global process, console, window, document, URL */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.STAFF_STUDENTS_TEST_URL || 'http://localhost:5173'
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
const studentId = fixture('student-id').toString().trim()
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const heading = (page, name) => page.getByRole('heading', { name, exact: true }).waitFor()
async function login(page, name) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(`role-e2e-${name}`)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.waitForURL(
    (url) => new URL(url).pathname === '/schedule' || new URL(url).pathname.startsWith('/staff'),
  )
}

try {
  for (const width of [1440, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    const page = await context.newPage()
    await login(page, 'all')
    await page.goto(`${baseURL}/staff/students`)
    await heading(page, 'Поиск студентов')
    await page.getByLabel('ФИО или группа').fill('Ёжова')
    await page.getByLabel('Факультет').selectOption({ label: 'Факультет Role E2E' })
    await page.getByLabel('Программа').selectOption({ label: 'Программа Role E2E' })
    await page.getByLabel('Курс').selectOption('2')
    await page.getByRole('button', { name: 'Найти' }).click()
    await page.getByRole('heading', { name: 'Ёжова Елена E2E' }).waitFor()
    await page.getByRole('button', { name: 'Изменить статус' }).click()
    const dialog = page.getByRole('dialog', { name: 'Изменение статуса' })
    const submit = dialog.getByRole('button', { name: 'Подтвердить изменение' })
    assert.equal(await submit.isDisabled(), true)
    await dialog.getByLabel('Новый статус').selectOption('academic_leave')
    await dialog.getByLabel('Подтверждаю, что внешнее основание оформлено').check()
    const response = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === `/api/v1/staff/students/${studentId}/academic-status`,
    )
    await submit.click()
    assert.equal((await response).status(), 200)
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    )
    await context.close()
    console.log(`PASS staff search, filters, status confirmation and ${width}px layout`)
  }

  const statusContext = await browser.newContext({ viewport: { width: 360, height: 900 } })
  const statusPage = await statusContext.newPage()
  await login(statusPage, 'status-only')
  await statusPage.goto(`${baseURL}/staff/students/status`)
  await heading(statusPage, 'Изменение академического статуса')
  await statusPage.getByLabel('ID студента').fill(studentId)
  await statusPage.getByText(`Студент ID ${studentId}`).waitFor()
  assert.equal(await statusPage.getByText('Ёжова Елена E2E').count(), 0)
  await statusPage.getByLabel('Новый статус').selectOption('graduated')
  await statusPage.getByLabel('Подтверждаю, что внешнее основание оформлено').check()
  const statusResponse = statusPage.waitForResponse((result) =>
    new URL(result.url()).pathname.endsWith('/academic-status'),
  )
  await statusPage.getByRole('button', { name: 'Подтвердить изменение' }).click()
  assert.equal((await statusResponse).status(), 200)
  assert.equal(
    await statusPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  )
  await statusContext.close()
  console.log('PASS status-only access by known ID omits student personal data')

  const revokedContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const revokedPage = await revokedContext.newPage()
  await login(revokedPage, 'student-reader')
  await revokedPage.goto(`${baseURL}/staff/students`)
  await revokedPage.getByRole('heading', { name: 'Ёжова Елена E2E' }).waitFor()
  assert.equal(await revokedPage.getByRole('button', { name: 'Изменить статус' }).count(), 0)
  await revokedPage.route('**/api/v1/staff/students?*', (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'forbidden', message: '', details: [] } },
    }),
  )
  await revokedPage.reload()
  await revokedPage.getByRole('alert').getByText('Доступ запрещён').waitFor()
  await revokedPage.unroute('**/api/v1/staff/students?*')
  await revokedPage.route('**/api/v1/staff/students?*', (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'internal_error', message: '', details: [] } },
    }),
  )
  await revokedPage.reload()
  await revokedPage.getByRole('alert').getByText('Не удалось загрузить студентов').waitFor()
  await revokedPage.unroute('**/api/v1/staff/students?*')
  fixture('revoke-students-read')
  await revokedPage.goto(`${baseURL}/staff/students`)
  await revokedPage.getByRole('alert').getByText('Доступ запрещён').waitFor()
  assert.equal(await revokedPage.getByText('Ёжова Елена E2E').count(), 0)
  await revokedContext.close()
  console.log('PASS permission revocation blocks the staff search route')
} finally {
  await browser.close()
}
