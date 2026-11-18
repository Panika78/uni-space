/* global process, console, document, URL, window, Event */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const { chromium, request } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const origin = new URL(base).origin
const root = '/api/v1/staff/applications'
const queue = '/staff/applications'
const env = process.env
const issuedRoot = join(env.ATTACHMENT_STORAGE_PATH, 'issued_documents')
const legacy = env.STAFF_APPLICATIONS_LEGACY_ID
const automatic = env.STAFF_APPLICATIONS_AUTOMATIC_ID
const reason = 'Уточните период академического отпуска'
const rejectReason = 'Вымышленное основание для отказа'
const pdf = await readFile(new URL('../../backend/tests/fixtures/minimal.pdf', import.meta.url))
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(env.CHROMIUM_PATH ? { executablePath: env.CHROMIUM_PATH } : { channel: 'chromium' }),
})
const student = await request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: origin } })

async function loginApi(login, password) {
  for (;;) {
    const result = await student.post('/api/v1/auth/login', { data: { login, password } })
    if (result.status() === 429) {
      await waitForLoginLimit(result)
      continue
    }
    assert.equal(result.status(), 200, await result.text())
    return { Authorization: `Bearer ${(await result.json()).access_token}` }
  }
}

async function waitForLoginLimit(response) {
  const seconds = Number(response.headers()['retry-after'])
  assert.ok(seconds > 0 && seconds <= 60)
  await setTimeout(seconds * 1000)
}

async function openStaff(letter, width) {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width, height: 800 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  return { context, page, headers: await loginStaff(page, letter) }
}

async function loginStaff(page, letter) {
  await page.goto(`${base}/login`)
  for (;;) {
    await page.getByLabel('Логин').fill(env[`STAFF_APPLICATIONS_LOGIN_${letter}`])
    await page.getByLabel('Пароль').fill(env.STAFF_APPLICATIONS_PASSWORD)
    const pending = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/login',
    )
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const result = await pending
    if (result.status() === 429) {
      await waitForLoginLimit(result)
      continue
    }
    assert.equal(result.status(), 200, await result.text())
    await page.waitForURL((url) => url.pathname !== '/login')
    return { Authorization: `Bearer ${(await result.json()).access_token}` }
  }
}

async function logout(page) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.waitForURL('**/login')
}

async function api(client, path, headers, options = {}) {
  const response = await client.fetch(path, { headers, ...options })
  assert.equal(response.status(), options.expected ?? 200, await response.text())
  return response
}

async function openDetail(page, id) {
  await page.goto(`${base}${queue}/${id}`)
  await page.getByRole('heading', { name: `Заявление № ${id}`, exact: true }).waitFor()
}

async function search(page, text) {
  await page.getByLabel('Номер или заявитель').fill(text)
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === root && url.searchParams.get('q') === text
  })
  await page.getByRole('button', { name: 'Применить' }).click()
  assert.equal((await response).status(), 200)
}

async function expectNoOverflow(page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    true,
  )
}

async function activate(page, name) {
  const button = page.getByRole('button', { name, exact: true })
  await button.click({ trial: true })
  await button.focus()
  await page.keyboard.press('Enter')
}

async function confirm(page, name, comment) {
  await activate(page, name)
  const modal = page.getByRole('dialog', { name, exact: true })
  await modal.waitFor()
  assert.equal(await modal.evaluate((element) => element.contains(document.activeElement)), true)
  if (comment) await modal.getByLabel('Причина').fill(comment)
  await modal.getByRole('button', { name, exact: true }).click()
}

async function temporarilyBlockDocuments(run) {
  await mkdir(issuedRoot, { recursive: true, mode: 0o700 })
  const backup = `${issuedRoot}.staff-e2e-backup`
  await rename(issuedRoot, backup)
  try {
    await writeFile(issuedRoot, 'Изолированный сбой в тестовой среде', { flag: 'wx', mode: 0o600 })
    await run()
  } finally {
    await rm(issuedRoot, { force: true })
    await rename(backup, issuedRoot)
  }
}

try {
  const studentHeaders = await loginApi(env.SERVICES_TEST_LOGIN, env.SERVICES_TEST_PASSWORD)
  const a = await openStaff('A', 360)
  const b = await openStaff('B', 1440)
  const c = await openStaff('C', 1440)
  const denied = await openStaff('D', 360)
  await api(student, root, {}, { expected: 401 })
  const data = { basis: 'family', starts_on: '2026-12-01', ends_on: '2027-01-01' }
  async function submitLeave() {
    const response = await api(student, '/api/v1/applications', studentHeaders, {
      method: 'POST',
      expected: 201,
      multipart: {
        form_data: JSON.stringify(data),
        files: { name: 'fictional.pdf', mimeType: 'application/pdf', buffer: pdf },
      },
    })
    return response.json()
  }
  const leave = await submitLeave()
  const attachmentId = leave.attachments[0].id
  const attachmentPath = `${root}/attachments/${attachmentId}/download`
  const accounting = await (
    await api(student, '/api/v1/applications', studentHeaders, {
      method: 'POST',
      expected: 201,
      data: {
        service_code: 'accounting_certificate',
        form_data: { purpose: 'Браузерная проверка' },
      },
    })
  ).json()

  await a.page.goto(`${base}${queue}`)
  await a.page.getByRole('link', { name: `№ ${leave.id}`, exact: true }).waitFor()
  await a.page.getByLabel('Услуга').selectOption('academic_leave')
  await a.page.getByLabel('Дата создания с').fill('2026-10-01')
  await a.page.getByLabel('Дата создания по').fill('2026-10-01')
  await search(a.page, 'e2e student a')
  await a.page.getByRole('button', { name: 'Показать ещё' }).click()
  const oldLink = a.page.getByRole('link', { name: `№ ${legacy}`, exact: true })
  await oldLink.waitFor()
  assert.equal(await a.page.locator('tbody tr').count(), 24)
  await oldLink.scrollIntoViewIfNeeded()
  await oldLink.focus()
  const savedScroll = await a.page.evaluate(() => document.scrollingElement.scrollTop)
  assert.ok(savedScroll > 0)
  await a.page.keyboard.press('Enter')
  await a.page.getByText('История пока пуста').waitFor()
  await a.page.goBack()
  await oldLink.waitFor()
  await a.page.waitForFunction((id) => document.activeElement?.dataset.applicationId === id, legacy)
  assert.equal(await a.page.getByLabel('Номер или заявитель').inputValue(), 'e2e student a')
  assert.ok(
    Math.abs((await a.page.evaluate(() => document.scrollingElement.scrollTop)) - savedScroll) < 5,
  )
  assert.equal(new URL(a.page.url()).searchParams.has('q'), false)
  await expectNoOverflow(a.page)
  await a.page.goForward()
  await a.page.getByRole('heading', { name: `Заявление № ${legacy}`, exact: true }).waitFor()
  await a.page.goto(`${base}${queue}`)
  await a.page.getByLabel('Дата создания с').fill('2026-10-02')
  await a.page.getByLabel('Дата создания по').fill('2026-10-01')
  const invalidDates = a.page.waitForResponse((response) =>
    response.url().includes('created_from=2026-10-02'),
  )
  await a.page.getByRole('button', { name: 'Применить' }).click()
  assert.equal((await invalidDates).status(), 422)
  await a.page.getByText('Проверьте параметры запроса и заполненные поля.').waitFor()
  await a.page.getByRole('link', { name: 'Сбросить фильтры' }).click()
  await a.page.getByRole('link', { name: `№ ${leave.id}`, exact: true }).waitFor()
  await search(a.page, `№ ${legacy}`)
  await oldLink.waitFor()
  assert.equal(await a.page.locator('tbody tr').count(), 1)

  await openDetail(a.page, automatic)
  assert.equal(
    await a.page.getByRole('button', { name: 'Принять в работу', exact: true }).count(),
    0,
  )
  assert.equal(
    (
      await (
        await api(a.context.request, `${root}/${automatic}/review`, a.headers, {
          method: 'POST',
          expected: 409,
          data: { action: 'start_review', expected_version: 1 },
        })
      ).json()
    ).error.code,
    'invalid_transition',
  )

  await openDetail(a.page, leave.id)
  await expectNoOverflow(a.page)
  await openDetail(b.page, leave.id)
  await expectNoOverflow(b.page)
  await denied.page.goto(`${base}${queue}/${leave.id}`)
  await denied.page.getByText('Доступ запрещён', { exact: true }).waitFor()
  await c.page.goto(`${base}${queue}/${leave.id}`)
  await c.page.getByText('Заявление или файл недоступны.', { exact: true }).waitFor()
  for (const path of [`${root}/${leave.id}`, `${root}/${leave.id}/history`, attachmentPath]) {
    await api(c.context.request, path, c.headers, { expected: 404 })
    await api(denied.context.request, path, denied.headers, {
      expected: path === attachmentPath ? 404 : 403,
    })
  }
  assert.deepEqual(await (await api(a.context.request, attachmentPath, a.headers)).body(), pdf)
  const attachmentDownload = a.page.waitForEvent('download')
  await activate(a.page, 'Скачать fictional.pdf')
  assert.equal((await attachmentDownload).suggestedFilename(), 'fictional.pdf')

  const race = await Promise.all(
    [a, b].map(async ({ page }) => {
      const response = page.waitForResponse((r) => r.url().endsWith(`/${leave.id}/review`))
      await activate(page, 'Принять в работу')
      return (await response).status()
    }),
  )
  assert.deepEqual([...race].sort(), [200, 409])
  const winner = race[0] === 200 ? a : b
  const loser = winner === a ? b : a
  await loser.page.getByRole('alert').filter({ hasText: 'Заявление изменилось' }).waitFor()
  const historyUrl = `${root}/${leave.id}/history`
  const getEvents = async () =>
    (await (await api(a.context.request, historyUrl, a.headers)).json()).items
  assert.deepEqual(
    (await getEvents()).map((event) => event.to_status),
    ['submitted', 'in_review'],
  )
  await loser.page.getByRole('button', { name: 'Обновить данные' }).click()
  // A returns the application even when B acquired it first.
  await a.page.getByRole('link', { name: 'К заявлениям' }).click()
  await search(a.page, leave.id)
  await a.page.getByText('Заявлений нет', { exact: true }).waitFor()
  await a.page.getByRole('link', { name: 'В работе', exact: true }).click()
  await a.page.getByRole('link', { name: `№ ${leave.id}`, exact: true }).click()
  const returnName = 'Вернуть на доработку'
  await activate(a.page, returnName)
  const modal = a.page.getByRole('dialog', { name: returnName })
  await modal.getByRole('button', { name: returnName, exact: true }).click()
  await modal.getByText('Укажите причину.').waitFor()
  assert.equal(
    await modal.getByLabel('Причина').evaluate((element) => element === document.activeElement),
    true,
  )
  await a.page.keyboard.press('Escape')
  await modal.waitFor({ state: 'hidden' })
  assert.equal(
    await a.page
      .getByRole('button', { name: returnName, exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await confirm(a.page, returnName, reason)
  await a.page.getByText('На доработке', { exact: true }).waitFor()
  await a.page.getByRole('link', { name: 'К заявлениям' }).click()
  await a.page.getByText('Заявлений нет', { exact: true }).waitFor()
  await a.page.getByRole('link', { name: 'Все', exact: true }).click()
  await a.page.getByRole('link', { name: `№ ${leave.id}`, exact: true }).waitFor()
  const returned = await (
    await api(student, `/api/v1/applications/${leave.id}`, studentHeaders)
  ).json()
  const resent = await (
    await api(student, `/api/v1/applications/${leave.id}/resubmit`, studentHeaders, {
      method: 'POST',
      multipart: {
        expected_version: String(returned.version),
        form_data: JSON.stringify({ ...data, ends_on: '2027-01-07' }),
        keep_attachment_ids: JSON.stringify([attachmentId]),
      },
    })
  ).json()
  assert.equal(resent.id, leave.id)
  assert.equal(resent.review_status, 'resubmitted')
  await openDetail(b.page, leave.id)
  await activate(b.page, 'Принять в работу')
  await confirm(b.page, 'Завершить')
  await b.page.getByText('Одобрено', { exact: true }).waitFor()
  assert.equal(await b.page.getByRole('button', { name: /PDF/ }).count(), 0)
  assert.deepEqual(
    (await getEvents()).map((event) => event.to_status),
    ['submitted', 'in_review', 'needs_correction', 'resubmitted', 'in_review', 'approved'],
  )
  await logout(b.page)
  b.headers = await loginStaff(b.page, 'B')
  await openDetail(b.page, leave.id)
  await b.page.getByText(reason, { exact: true }).waitFor()
  assert.equal(await b.page.locator('.staff-applications__history li').count(), 6)

  const rejection = await submitLeave()
  await openDetail(a.page, rejection.id)
  let committed = 0
  await a.page.route(
    `**${root}/${rejection.id}/review`,
    async (route) => {
      const response = await route.fetch()
      assert.equal(response.status(), 200, await response.text())
      committed += 1
      await route.abort('failed')
    },
    { times: 1 },
  )
  await activate(a.page, 'Принять в работу')
  await a.page.getByText('Ответ на действие не получен.', { exact: false }).waitFor()
  assert.equal(committed, 1)
  await activate(a.page, 'Отклонить')
  const rejectionDialog = a.page.getByRole('dialog', { name: 'Отклонить' })
  await rejectionDialog.getByRole('button', { name: 'Отклонить', exact: true }).click()
  await rejectionDialog.getByText('Укажите причину.').waitFor()
  await rejectionDialog.getByLabel('Причина').fill(rejectReason)
  await rejectionDialog.getByRole('button', { name: 'Отклонить', exact: true }).click()
  await a.page.getByText('Отклонено', { exact: true }).waitFor()
  await a.page.reload()
  await a.page.getByText('Причина отказа', { exact: true }).waitFor()
  await a.page
    .locator('.staff-applications__history')
    .getByText(rejectReason, { exact: true })
    .waitFor()

  await openDetail(c.page, accounting.id)
  await activate(c.page, 'Принять в работу')
  await c.page.getByText('PDF формируется после одобрения заявления.').waitFor()
  await temporarilyBlockDocuments(async () => {
    await confirm(c.page, 'Завершить')
    await c.page.getByText('Ошибка выдачи PDF', { exact: true }).waitFor()
    await c.page.getByRole('link', { name: 'К заявлениям' }).click()
    await c.page.getByRole('link', { name: 'Завершённые', exact: true }).click()
    await c.page.getByText('Ошибка выдачи PDF', { exact: true }).waitFor()
    await expectNoOverflow(c.page)
    await c.page.getByRole('link', { name: `№ ${accounting.id}`, exact: true }).click()
    await c.page.getByRole('button', { name: 'Повторить выдачу PDF' }).waitFor()
  })
  const retry = c.page.waitForRequest((r) => r.url().endsWith('/document/retry'))
  await activate(c.page, 'Повторить выдачу PDF')
  assert.equal((await retry).postData(), null)
  await c.page.getByText('Выданный PDF', { exact: true }).waitFor()
  const path = `${root}/${accounting.id}`
  const original = await (await api(c.context.request, `${path}/document`, c.headers)).body()
  assert.equal(original.subarray(0, 5).toString(), '%PDF-')
  const ready = await (await api(c.context.request, path, c.headers)).json()
  const retried = await (
    await api(c.context.request, `${path}/document/retry`, c.headers, { method: 'POST' })
  ).json()
  assert.deepEqual(retried.document, ready.document)
  assert.equal(retried.version, ready.version)
  assert.deepEqual(
    await (await api(c.context.request, `${path}/document`, c.headers)).body(),
    original,
  )
  assert.equal(await c.page.getByRole('button', { name: 'Повторить выдачу PDF' }).count(), 0)
  await api(a.context.request, `${path}/document`, a.headers, { expected: 404 })
  await api(denied.context.request, `${path}/document`, denied.headers, { expected: 403 })
  const download = c.page.waitForEvent('download')
  await activate(c.page, 'Скачать PDF')
  assert.equal((await download).suggestedFilename(), ready.document.filename)
  const detailUrl = c.page.url()
  const popup = c.context.waitForEvent('page')
  const getPdf = c.page.waitForResponse((response) => response.url().endsWith(`${path}/document`))
  await activate(c.page, 'Открыть PDF в новой вкладке')
  const preview = await popup
  assert.equal((await getPdf).status(), 200)
  await preview.waitForURL((url) => url.protocol === 'blob:')
  assert.equal(c.page.url(), detailUrl)
  await preview.close()
  await temporarilyBlockDocuments(async () => {
    const response = c.page.waitForResponse((r) => r.url().endsWith(`${path}/document`))
    await activate(c.page, 'Скачать PDF')
    assert.equal((await response).status(), 503)
    await c.page
      .getByText('Сервис временно недоступен. Попробуйте ещё раз.', { exact: true })
      .waitFor()
  })

  await openDetail(a.page, leave.id)
  execFileSync(env.STAFF_APPLICATIONS_PYTHON || 'backend/.venv/bin/python', [
    'backend/scripts/seed_staff_applications_browser.py',
    'revoke',
  ])
  for (const path of [root, `${root}/${leave.id}`, historyUrl, attachmentPath]) {
    await api(a.context.request, path, a.headers, {
      expected: path === attachmentPath ? 404 : 403,
    })
  }
  await a.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await a.page.getByText('Доступ запрещён', { exact: true }).waitFor()
  assert.equal(await a.page.getByText(reason, { exact: true }).count(), 0)
  await logout(c.page)
  await c.page.goBack({ waitUntil: 'domcontentloaded' })
  assert.equal(await c.page.getByText('Выданный PDF', { exact: true }).count(), 0)
  await c.page.goto(detailUrl)
  await c.page.waitForURL((url) => url.pathname === '/login')

  await loginStaff(c.page, 'D')
  await c.page.goto(detailUrl)
  await c.page.getByText('Доступ запрещён', { exact: true }).waitFor()
  assert.equal(await c.page.getByText('Выданный PDF', { exact: true }).count(), 0)
  console.log('Staff applications Chromium E2E passed at 360 and 1440 px against PostgreSQL.')
} finally {
  await student.dispose()
  await browser.close()
}
