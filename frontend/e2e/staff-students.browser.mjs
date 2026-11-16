/* global process, console, window, document, URL, Event */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.STAFF_STUDENTS_TEST_URL || 'http://localhost:5173'
const password = 'Fictional-Role-E2E-Password-2026'
const runFixture = (file, mode) =>
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
      `frontend/e2e/${file}`,
      mode,
    ],
    { env: { ...process.env, PYTHONPATH: 'backend' }, stdio: 'pipe' },
  )
const fixture = (mode) => runFixture('role-fixtures.py', mode)
const verify = (mode) => runFixture('staff-students-fixtures.py', mode)
fixture('seed')
verify('prepare')
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/login',
    )
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const response = await pending
    if (response.status() !== 429) {
      assert.equal(response.status(), 200)
      await page.waitForFunction(() => window.location.pathname !== '/login')
      return
    }
    await delay((Number(response.headers()['retry-after']) + 1) * 1000)
  }
  throw new Error('Login remained rate limited')
}
const checkWidth = async (page) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  )
async function submit(page, target) {
  await page.getByLabel('Новый статус', { exact: true }).selectOption(target)
  await page.getByLabel('Подтверждаю, что внешнее основание оформлено', { exact: true }).check()
  const owner = typeof page.waitForResponse === 'function' ? page : page.page()
  const response = owner.waitForResponse(
    (result) =>
      new URL(result.url()).pathname.endsWith('/academic-status') &&
      result.request().method() === 'PATCH',
  )
  await page.getByRole('button', { name: 'Подтвердить изменение' }).click()
  assert.equal((await response).status(), 200)
}
try {
  for (const [width, target, oldLabel] of [
    [1440, 'academic_leave', 'Отчислен'],
    [360, 'expelled', 'В академическом отпуске'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } })
    const page = await context.newPage()
    await login(page, 'all')
    await page.goto(`${baseURL}/staff/students?q=Ёжова`)
    await heading(page, 'Поиск студентов')
    await page.getByRole('heading', { name: 'Ёжова Елена E2E' }).waitFor()
    const trigger = page.getByRole('button', { name: 'Изменить статус' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    let dialog = page.getByRole('dialog', { name: 'Изменение статуса' })
    await dialog.waitFor()
    assert.equal(
      await dialog.getByLabel('Новый статус').evaluate((el) => el === document.activeElement),
      true,
    )
    await page.keyboard.press('Shift+Tab')
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Отмена' })
        .evaluate((el) => el === document.activeElement),
      true,
    )
    await page.keyboard.press('Tab')
    assert.equal(
      await dialog.getByLabel('Новый статус').evaluate((el) => el === document.activeElement),
      true,
    )
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
    await trigger.click()
    dialog = page.getByRole('dialog', { name: 'Изменение статуса' })
    await dialog.getByText('Ёжова Елена E2E · E2E-27', { exact: true }).waitFor()
    await dialog.getByText(`Предыдущий статус: ${oldLabel}`, { exact: true }).waitFor()
    await submit(dialog, target)
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate((el) => el === document.activeElement), true)
    verify(`check:${target}:${width === 1440 ? 1 : 2}`)
    await checkWidth(page)
    await context.close()
    console.log(`PASS actual PATCH + audit, identified confirmation and keyboard dialog ${width}px`)
  }

  const statusContext = await browser.newContext({ viewport: { width: 360, height: 900 } })
  const statusPage = await statusContext.newPage()
  let hiddenReads = 0
  statusPage.on('request', (request) => {
    if (
      /\/api\/v1\/staff\/students(?:\?|\/filters|\/[0-9]+$)/.test(
        new URL(request.url()).pathname + new URL(request.url()).search,
      ) &&
      request.method() === 'GET'
    )
      hiddenReads++
  })
  await login(statusPage, 'status-only')
  await statusPage.goto(`${baseURL}/staff/students/status`)
  await heading(statusPage, 'Изменение академического статуса')
  await statusPage.getByLabel('ID студента').fill(studentId)
  assert.equal(await statusPage.getByLabel('Новый статус').inputValue(), '')
  await statusPage.getByLabel('Подтверждаю, что внешнее основание оформлено').check()
  assert.equal(
    await statusPage.getByRole('button', { name: 'Подтвердить изменение' }).isDisabled(),
    true,
  )
  assert.equal(await statusPage.getByText('Ёжова Елена E2E').count(), 0)
  await statusPage.getByLabel('Основание изменения').selectOption('correction')
  await submit(statusPage, 'enrolled')
  await statusPage.getByText(/Статус сохранён: Обучается/).waitFor()
  verify('check:enrolled:3')
  await statusPage.getByLabel('Новый статус').selectOption('graduated')
  assert.equal(await statusPage.getByText(/Статус сохранён:/).count(), 0)

  // Real PostgreSQL COMMIT, then abort only delivery. No mock write response.
  let lostWrites = 0
  await statusPage.route('**/academic-status', async (route) => {
    lostWrites++
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    await route.abort('failed')
  })
  await statusPage.getByLabel('Подтверждаю, что внешнее основание оформлено').check()
  await statusPage.getByRole('button', { name: 'Подтвердить изменение' }).click()
  await statusPage.getByText(/Результат изменения неизвестен/).waitFor()
  verify('check:graduated:4')
  assert.equal(lostWrites, 1)
  await statusPage.getByRole('button', { name: 'Проверить квитанцию операции' }).click()
  await statusPage.getByText(/Квитанция подтверждена|Статус сохранён: Выпускник/).waitFor()
  assert.equal(lostWrites, 1)
  assert.equal(hiddenReads, 0)
  assert.equal(
    await statusPage.getByRole('button', { name: 'Сверить актуальное состояние' }).count(),
    0,
  )
  assert.equal(
    await statusPage.getByRole('button', { name: 'Подтвердить изменение' }).isDisabled(),
    true,
  )
  await checkWidth(statusPage)
  await statusContext.close()
  console.log(
    'PASS status-only expelled → enrolled requires explicit choice; committed/lost response stays uncertain, private and single-write',
  )

  const readerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await readerContext.newPage()
  await login(page, 'all')
  await page.goto(`${baseURL}/staff/students/${studentId}`)
  await heading(page, 'Ёжова Елена E2E')
  await page.reload()
  await heading(page, 'Ёжова Елена E2E')
  let release
  let hangingWrites = 0
  await page.route('**/academic-status', async (route) => {
    hangingWrites++
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    await new Promise((resolve) => {
      release = resolve
    })
    await route.fulfill({ response }).catch(() => {})
  })
  await page.getByRole('button', { name: 'Изменить статус' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Новый статус').selectOption('academic_leave')
  await dialog.getByLabel('Подтверждаю, что внешнее основание оформлено').check()
  await dialog.getByRole('button', { name: 'Подтвердить изменение' }).click()
  await dialog.getByText(/Результат изменения неизвестен/).waitFor({ timeout: 22000 })
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 1)
  verify('check:academic_leave:5')
  assert.equal(hangingWrites, 1)
  await dialog.getByRole('button', { name: 'Проверить квитанцию операции' }).click()
  await dialog.getByText(/Статус сохранён: В академическом отпуске/).waitFor()
  assert.equal(hangingWrites, 1)
  await dialog.getByText('Предыдущий статус: В академическом отпуске', { exact: true }).waitFor()
  assert.equal(hangingWrites, 1)
  release()
  await page.keyboard.press('Escape')
  await page.unroute('**/academic-status')
  console.log('PASS bounded hanging PATCH, real read reconciliation and no replay')

  // Exactly 45 real PostgreSQL rows and deterministic pages; URL is the history.
  await page.goto(`${baseURL}/staff/students?q=Ревью27`)
  await page.getByLabel('Факультет').selectOption({ label: 'Факультет Пагинация E2E' })
  await page.getByLabel('Программа').selectOption({ label: 'Программа Пагинация E2E' })
  await page.getByLabel('Курс').selectOption('2')
  const ids = () =>
    page
      .locator('[data-student-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.studentId))
  await page.getByText('Страница 1', { exact: true }).waitFor()
  await page.locator('[data-student-id]').nth(19).waitFor()
  const first = await ids()
  await page.getByRole('button', { name: 'Следующие 20' }).click()
  await page.getByText('Страница 2', { exact: true }).waitFor()
  await page.locator('[data-student-id]').nth(19).waitFor()
  const second = await ids()
  await page.getByRole('button', { name: 'Следующие 20' }).click()
  await page.getByText('Страница 3', { exact: true }).waitFor()
  await page.locator('[data-student-id]').nth(4).waitFor()
  const third = await ids()
  assert.deepEqual([first.length, second.length, third.length], [20, 20, 5])
  assert.equal(new Set([...first, ...second, ...third]).size, 45)
  assert.deepEqual(
    [...first, ...second, ...third],
    JSON.parse(verify('ids').toString()).map(String),
  )
  const savedUrl = page.url()
  for (const name of ['q', 'faculty_id', 'program_id', 'course_number', 'cursor'])
    assert.ok(
      new URL(savedUrl).searchParams.get(name),
      `Missing ${name} in saved page URL: ${savedUrl}`,
    )
  await page.goBack()
  await page.getByText('Страница 2', { exact: true }).waitFor()
  await page.locator('[data-student-id]').nth(19).waitFor()
  assert.deepEqual(await ids(), second)
  await page.goBack()
  await page.getByText('Страница 1', { exact: true }).waitFor()
  await page.locator('[data-student-id]').nth(19).waitFor()
  assert.deepEqual(await ids(), first)
  await page.goForward()
  await page.getByText('Страница 2', { exact: true }).waitFor()
  await page.locator('[data-student-id]').nth(19).waitFor()
  assert.deepEqual(await ids(), second)
  await page.getByRole('button', { name: 'Предыдущие 20' }).click()
  await page.getByText('Страница 1', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Ревью27 Студент 00', exact: true }).click()
  await heading(page, 'Ревью27 Студент 00')
  await page.reload()
  await heading(page, 'Ревью27 Студент 00')
  await page.getByRole('link', { name: 'К результатам поиска' }).click()
  await heading(page, 'Поиск студентов')
  assert.equal(new URL(page.url()).searchParams.get('q'), 'Ревью27')
  await page.getByLabel('Курс').selectOption('1')
  await page.getByText('Студенты не найдены. Измените запрос или фильтры.').waitFor()
  assert.equal(new URL(page.url()).searchParams.has('cursor'), false)
  assert.equal(new URL(page.url()).searchParams.has('back'), false)
  await page.goto(`${baseURL}/staff/students/9223372036854775807`)
  await page.getByRole('alert').getByText('Студент не найден').waitFor()
  await readerContext.close()
  console.log(
    'PASS 45 students, three pages, Back/Forward, URL filters and direct/reloaded detail + real 404',
  )

  const readonly = await browser.newContext({ viewport: { width: 360, height: 900 } })
  const readonlyPage = await readonly.newPage()
  let readonlyAuthorization
  readonlyPage.on('request', (request) => {
    readonlyAuthorization = request.headers().authorization || readonlyAuthorization
  })
  await login(readonlyPage, 'student-reader')
  await readonlyPage.goto(`${baseURL}/staff/students/${studentId}`)
  await heading(readonlyPage, 'Ёжова Елена E2E')
  assert.equal(await readonlyPage.getByRole('button', { name: 'Изменить статус' }).count(), 0)
  fixture('revoke-students-read')
  const deniedDetail = await readonlyPage.request.get(
    `${baseURL}/api/v1/staff/students/${studentId}`,
    { headers: { Authorization: readonlyAuthorization } },
  )
  assert.equal(deniedDetail.status(), 403)
  await readonlyPage.evaluate(() => window.dispatchEvent(new Event('focus')))
  await readonlyPage.getByRole('alert').getByText('Доступ запрещён').waitFor()
  assert.equal(await readonlyPage.getByText('Ёжова Елена E2E').count(), 0)
  await readonlyPage.reload()
  await readonlyPage.getByRole('alert').getByText('Доступ запрещён').waitFor()
  await readonly.close()
  console.log('PASS read-only detail, old JWT after read revocation and private open UI')
} finally {
  await browser.close()
}
