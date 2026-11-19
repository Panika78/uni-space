/* global process, console, document, window, URL, Event */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.TEACHER_SCHEDULE_TEST_URL || 'http://localhost:5173'
const env = process.env
const fixture = (mode) =>
  execFileSync(
    'uv',
    [
      'run',
      '--locked',
      '--python',
      env.PYTHON_TEST_VERSION || '3.12.16',
      '--project',
      'backend',
      'python',
      'frontend/e2e/teacher-journal-fixtures.py',
      mode,
    ],
    { env: { ...env, PYTHONPATH: 'backend' }, stdio: 'ignore' },
  )
const loadSchedule = async (page, url) => {
  const response = page.waitForResponse((item) => item.url().includes('/api/v1/teaching/schedule'))
  await page.goto(url)
  return response
}
const refocusPage = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
}
const browser = await chromium.launch({
  executablePath: env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(env.TEACHER_JOURNAL_LOGIN_A)
  await page.getByLabel('Пароль').fill(env.TEACHER_JOURNAL_PASSWORD)
  const loginResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/auth/login'),
  )
  await page.getByRole('button', { name: 'Войти' }).click()
  const loginResponse = await loginResponsePromise
  assert.equal(loginResponse.status(), 200)
  await page.waitForURL('**/teacher/journals')

  const scheduleResponse = await loadSchedule(
    page,
    `${baseURL}/teacher/schedule?date=${env.TEACHER_JOURNAL_DATE}&mode=day`,
  )
  assert.equal(scheduleResponse.status(), 200)
  const body = await scheduleResponse.json()
  assert.ok(body.items.some((item) => item.id === env.TEACHER_JOURNAL_LESSON_A))
  assert.ok(!body.items.some((item) => item.id === env.TEACHER_JOURNAL_LESSON_B))
  await page.getByRole('heading', { name: 'Расписание' }).waitFor()
  const ownLesson = body.items.find((item) => item.id === env.TEACHER_JOURNAL_LESSON_A)
  await page.getByText(ownLesson.course_offering.discipline.name, { exact: true }).first().waitFor()

  let rejectNextSchedule = true
  await page.route('**/api/v1/teaching/schedule*', async (route) => {
    if (!rejectNextSchedule) return route.continue()
    rejectNextSchedule = false
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'forbidden', message: 'Доступ запрещён', details: [] },
      }),
    })
  })
  const forbiddenResponse = page.waitForResponse(
    (response) => response.url().includes('/api/v1/teaching/schedule') && response.status() === 403,
  )
  await refocusPage(page)
  assert.equal((await forbiddenResponse).status(), 403)
  await page.getByRole('alert').filter({ hasText: 'Доступ запрещён' }).waitFor()
  assert.equal(
    await page.getByText(ownLesson.course_offering.discipline.name, { exact: true }).count(),
    0,
  )
  await page.unroute('**/api/v1/teaching/schedule*')
  await page.getByRole('button', { name: 'Повторить' }).click()
  await page.getByText(ownLesson.course_offering.discipline.name, { exact: true }).first().waitFor()

  const nextDateObject = new Date(`${env.TEACHER_JOURNAL_DATE}T12:00:00Z`)
  nextDateObject.setUTCDate(nextDateObject.getUTCDate() + 1)
  const nextDate = nextDateObject.toISOString().slice(0, 10)
  const selectedDateResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      url.pathname.endsWith('/api/v1/teaching/schedule') &&
      url.searchParams.get('date_from') === nextDate
    )
  })
  await page.getByLabel('Выбрать дату').fill(nextDate)
  assert.equal((await selectedDateResponse).status(), 200)
  await page.getByText('Занятий нет').waitFor()
  await page.getByRole('button', { name: 'Сегодня' }).focus()
  await page.keyboard.press('Enter')
  await page.waitForURL(`**/teacher/schedule?date=${env.TEACHER_JOURNAL_TODAY}&mode=day`)
  await page.getByLabel('Выбрать дату').fill(env.TEACHER_JOURNAL_DATE)
  await page.getByText(ownLesson.course_offering.discipline.name, { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Неделя' }).focus()
  await page.keyboard.press('Enter')
  assert.equal(
    await page
      .getByRole('button', { name: 'Неделя' })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await page
    .getByRole('heading', {
      name: /понедельник|вторник|среда|четверг|пятница|суббота|воскресенье/i,
    })
    .first()
    .waitFor()
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  )
  await page.reload()
  await page.waitForURL(`**/teacher/schedule?date=${env.TEACHER_JOURNAL_DATE}&mode=week`)
  fixture('revoke')
  const revokedPromise = page.waitForResponse((response) =>
    response.url().includes('/api/v1/teaching/schedule'),
  )
  await refocusPage(page)
  const revokedScope = await revokedPromise
  assert.equal(revokedScope.status(), 200)
  await page.getByText('Занятий нет').waitFor()
  await page.goBack()
  await page.waitForURL('**/teacher/journals')

  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.locator('#user-menu-panel').getByRole('button', { name: 'Выйти' }).click()
  const logoutDialog = page.getByRole('dialog', { name: 'Выйти из аккаунта?' })
  await logoutDialog.getByRole('button', { name: 'Выйти' }).click()
  await page.waitForURL('**/login')
  await page.getByLabel('Логин').fill(env.TEACHER_JOURNAL_LOGIN_B)
  await page.getByLabel('Пароль').fill(env.TEACHER_JOURNAL_PASSWORD)
  const secondLogin = page.waitForResponse((response) => response.url().endsWith('/auth/login'))
  await page.getByRole('button', { name: 'Войти' }).click()
  assert.equal((await secondLogin).status(), 200)
  await page.waitForURL('**/teacher/journals')
  const secondSchedule = await loadSchedule(
    page,
    `${baseURL}/teacher/schedule?date=${env.TEACHER_JOURNAL_DATE}&mode=day`,
  )
  assert.equal(secondSchedule.status(), 200)
  const secondBody = await secondSchedule.json()
  assert.ok(secondBody.items.some((item) => item.id === env.TEACHER_JOURNAL_LESSON_B))
  assert.ok(!secondBody.items.some((item) => item.id === env.TEACHER_JOURNAL_LESSON_A))
  console.log(
    'PASS teacher schedule browser scope, revoked assignment, account isolation and responsive day/week',
  )
} finally {
  await browser.close()
}
