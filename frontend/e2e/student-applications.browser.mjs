/* global process, console, URL, Buffer, document, window, requestAnimationFrame */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const { chromium, request } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const login = process.env.SERVICES_TEST_LOGIN
const otherLogin = process.env.SERVICES_TEST_LOGIN_B
const password = process.env.SERVICES_TEST_PASSWORD
assert.ok(login && otherLogin && password && process.env.ATTACHMENT_STORAGE_PATH)
const pdf = await readFile(new URL('../../backend/tests/fixtures/minimal.pdf', import.meta.url))
const root = fileURLToPath(new URL('../..', import.meta.url))
function fixture(...args) {
  return execFileSync(
    process.env.APPLICATIONS_TEST_PYTHON || 'uv',
    [
      ...(process.env.APPLICATIONS_TEST_PYTHON
        ? []
        : ['run', '--locked', '--python', '3.12.16', '--project', 'backend', 'python']),
      'backend/scripts/seed_student_applications_browser.py',
      login,
      password,
      ...args,
    ],
    { cwd: root, encoding: 'utf-8' },
  ).trim()
}
const [deanLogin, accountingLogin, legacyId] = fixture().split(' ')
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: 'chromium' }),
  args: ['--no-sandbox'],
})
const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
const context = await browser.newContext({ baseURL, viewport: { width: 360, height: 850 } })
const page = await context.newPage()
const base = '/api/v1/applications'
let student
let dean
let accountant
const leave = {
  basis: 'other',
  starts_on: '2027-01-15',
  ends_on: '2027-02-16',
  explanation: 'Вымышленное семейное обстоятельство',
}
const file = (name) => ({ name, mimeType: 'application/pdf', buffer: pdf })
const reason = 'Уточните даты и пояснение'
const edit = page.getByRole('button', { name: 'Исправить заявление' })
const send = page.getByRole('button', { name: 'Отправить повторно' })
const explanation = page.getByLabel('Пояснение', { exact: false })
const purpose = page.getByLabel('Цель получения (необязательно)')
const history = page.getByRole('region', { name: 'История рассмотрения' })

async function apiLogin(username) {
  const isolated = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await isolated.post('/api/v1/auth/login', {
        data: { login: username, password },
      })
      if (response.ok()) return (await response.json()).access_token
      assert.equal(response.status(), 429)
      const seconds = Number(response.headers()['retry-after'])
      assert.ok(seconds > 0 && seconds <= 60)
      await delay(seconds * 1000 + 100)
    }
    throw new Error('Staff login did not complete')
  } finally {
    await isolated.dispose()
  }
}

async function browserLogin(username) {
  await page.goto('/login')
  await page.getByLabel('Логин').fill(username)
  await page.getByLabel('Пароль').fill(password)
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login'))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const response = await saved
    if (response.ok()) {
      await page.waitForURL('**/schedule')
      return (await response.json()).access_token
    }
    assert.equal(response.status(), 429)
    await page.waitForTimeout(Number(response.headers()['retry-after']) * 1000 + 100)
  }
  throw new Error('Student login did not complete')
}

async function logout() {
  const direct = page.getByRole('button', { name: 'Выйти', exact: true })
  if (!(await direct.isVisible())) {
    const drawer = page.getByRole('button', { name: 'Открыть меню', exact: true })
    await page
      .getByRole('button', {
        name: (await drawer.isVisible()) ? 'Открыть меню' : 'Меню пользователя',
        exact: true,
      })
      .click()
  }
  await direct.click()
  await page
    .getByRole('dialog', { name: 'Выйти из аккаунта?' })
    .getByRole('button', { name: 'Выйти', exact: true })
    .click()
  await page.waitForURL('**/login')
}

async function get(path, token = student, status = 200) {
  const response = await api.get(path, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(response.status(), status, path)
  return response
}

async function post(path, token, payload, status = 200) {
  const response = await api.post(path, {
    headers: { Authorization: `Bearer ${token}` },
    ...payload,
  })
  assert.equal(response.status(), status, `${path} ${(await response.text()).slice(0, 400)}`)
  return response.json()
}

const createAccounting = (value) =>
  post(
    base,
    student,
    {
      data: { service_code: 'accounting_certificate', form_data: { purpose: value } },
    },
    201,
  )
const review = (item, action, comment) =>
  post(
    `/api/v1/staff/applications/${item.id}/review`,
    item.service.code === 'academic_leave' ? dean : accountant,
    {
      data: { expected_version: item.version, action, comment },
    },
  )
const returnApplication = async (item, comment = reason) =>
  review(await review(item, 'start_review'), 'return_for_correction', comment)
const getItem = async (id) => (await get(`${base}/${id}`)).json()

async function open(id) {
  await page.goto(`/applications/${id}`)
  await page.getByRole('heading', { name: `Заявление № ${id}`, exact: true }).waitFor()
}

async function waitForCorrection(id, version) {
  await page.getByText(`Заявление № ${id} подано повторно. Версия ${version}.`).waitFor()
}

async function recoverMultipart(
  returned,
  explanationValue,
  filenames,
  { startReview = false, concurrentFile } = {},
) {
  const path = `${base}/${returned.id}/resubmit`
  const routePath = `**${path}`
  const historyPath = `${base}/${returned.id}/history`
  const previousHistory = (await (await get(historyPath)).json()).items
  let posts = 0
  await page.route(routePath, async (route) => {
    posts++
    assert.equal(posts, 1, 'Recovery must not send a second POST')
    assert.match(route.request().headers()['content-type'], /^multipart\/form-data;/)
    let saved
    if (concurrentFile) {
      saved = await post(path, student, {
        multipart: {
          expected_version: String(returned.version),
          form_data: JSON.stringify({ ...leave, explanation: explanationValue }),
          keep_attachment_ids: JSON.stringify(returned.attachments.map(({ id }) => id)),
          files: concurrentFile,
        },
      })
    } else {
      const response = await route.fetch({ maxRetries: 0 })
      assert.equal(response.status(), 200)
      saved = await response.json()
    }
    assert.equal(saved.id, returned.id)
    assert.equal(saved.version, returned.version + 1)
    assert.equal(saved.review_status, 'resubmitted')
    if (startReview) await review(saved, 'start_review')
    await route.abort('failed')
  })
  try {
    await send.click()
    const notice = page
      .getByRole('status')
      .filter({ hasText: /История подтверждает повторную подачу/ })
    await notice.waitFor()
    assert.match(await notice.innerText(), /содержимое файлов из прерванной отправки не проверено/)
    assert.match(
      await notice.innerText(),
      new RegExp(`Версия подачи ${returned.version + 1}(?:[.]|$)`),
    )
    assert.equal(await page.getByText(/Исход отправки пока не подтверждён/).count(), 0)
    assert.equal(
      await page
        .getByText(`Заявление № ${returned.id} подано повторно. Версия ${returned.version + 1}.`, {
          exact: true,
        })
        .count(),
      0,
    )
    assert.equal(await send.count(), 0)
    assert.equal(await edit.count(), 0)
    const saved = await getItem(returned.id)
    const expectedStatus = startReview ? 'in_review' : 'resubmitted'
    assert.equal(saved.id, returned.id)
    assert.equal(saved.version, returned.version + (startReview ? 2 : 1))
    assert.equal(saved.review_status, expectedStatus)
    assert.deepEqual(saved.form_data, { ...leave, explanation: explanationValue })
    assert.deepEqual(
      saved.attachments.map(({ original_filename }) => original_filename).sort(),
      [...filenames].sort(),
    )
    const section = page.getByRole('region', { name: 'Текущие подтверждающие файлы' })
    assert.equal(await section.getByRole('listitem').count(), filenames.length)
    for (const name of filenames) await section.getByText(name, { exact: false }).waitFor()
    const details = page.locator('.application-detail article')
    assert.equal(await details.getByText(String(saved.version), { exact: true }).count(), 1)
    assert.equal(await details.getByText(explanationValue, { exact: true }).count(), 1)
    await history
      .getByText(
        startReview ? 'Подано повторно → На рассмотрении' : 'Требуется доработка → Подано повторно',
        { exact: true },
      )
      .last()
      .waitFor()
    await history
      .getByText(
        startReview ? 'Текущий этап — На рассмотрении' : 'Текущий этап — Подано повторно',
        { exact: true },
      )
      .waitFor()
    const events = (await (await get(historyPath)).json()).items
    assert.deepEqual(events.slice(0, previousHistory.length), previousHistory)
    assert.deepEqual(
      events
        .slice(previousHistory.length)
        .map(({ from_status, to_status }) => [from_status, to_status]),
      startReview
        ? [
            ['needs_correction', 'resubmitted'],
            ['resubmitted', 'in_review'],
          ]
        : [['needs_correction', 'resubmitted']],
    )
    assert.equal(posts, 1)
    return saved
  } finally {
    await page.unroute(routePath)
  }
}

async function fit(width) {
  await page.setViewportSize({ width, height: 850 })
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  const dimensions = await page.evaluate(async () => {
    // Resizing immediately after navigation can start a shell transition.
    // Measure the final layout and report the overflowing elements on failure.
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    )
    const viewport = window.innerWidth
    const content = document.documentElement.scrollWidth
    const overflowing =
      content > viewport
        ? Array.from(document.querySelectorAll('body *'))
            .filter((element) => element.getBoundingClientRect().right > viewport + 1)
            .slice(0, 8)
            .map((element) => ({ tag: element.tagName, class: element.getAttribute('class') }))
        : []
    return { viewport, content, overflowing }
  })
  assert.ok(
    dimensions.content <= dimensions.viewport,
    `Content width ${dimensions.content}px at ${width}px: ${JSON.stringify(dimensions.overflowing)}`,
  )
}

try {
  // The page and API use the same origin and independent student/staff sessions.
  context.setDefaultTimeout(30_000)
  student = await browserLogin(login)
  dean = await apiLogin(deanLogin)
  accountant = await apiLogin(accountingLogin)
  const created = await post(
    base,
    student,
    {
      multipart: { form_data: JSON.stringify(leave), files: file('original.pdf') },
    },
    201,
  )
  let returned = await returnApplication(created)
  await open(created.id)
  await history.getByText(reason).waitFor()
  await edit.focus()
  await page.keyboard.press('Enter')
  assert.equal(
    await page.getByLabel('Дата начала', { exact: false }).first().inputValue(),
    '15.01.2027',
  )
  assert.equal(await explanation.inputValue(), leave.explanation)
  await fit(360)
  await fit(1440)
  await explanation.fill('Исправленное пояснение')
  await send.click()
  await waitForCorrection(created.id, returned.version + 1)
  let corrected = await getItem(created.id)
  assert.equal(corrected.review_status, 'resubmitted')
  assert.deepEqual(corrected.attachments, created.attachments)
  assert.equal(corrected.form_data.explanation, 'Исправленное пояснение')

  // Add a second attachment, then replace the first one. A bad upload is
  // rejected by the real server, leaving form, attachments and history intact.
  returned = await returnApplication(corrected, 'Приложите дополнительный файл')
  await open(created.id)
  await edit.click()
  const input = page.locator('#leave-files')
  await input.setInputFiles(file('keep.pdf'))
  await explanation.fill('Пояснение с новым файлом')
  corrected = await recoverMultipart(returned, 'Пояснение с новым файлом', [
    'keep.pdf',
    'original.pdf',
  ])
  assert.deepEqual(
    corrected.attachments.find(({ id }) => id === created.attachments[0].id),
    created.attachments[0],
  )
  returned = await returnApplication(corrected, 'Замените первый файл')
  await open(created.id)
  await edit.click()
  await page.getByRole('button', { name: 'Убрать из нового набора original.pdf' }).click()
  await page.getByRole('button', { name: 'Убрать из нового набора keep.pdf' }).click()
  await send.click()
  await page.getByText('Прикрепите минимум один подтверждающий файл.').waitFor()
  await page.getByRole('button', { name: 'Оставить keep.pdf' }).click()
  await input.setInputFiles(Array.from({ length: 5 }, (_, i) => file(`extra-${i}.pdf`)))
  await send.click()
  await page.getByText(/Допустимо до 5 файлов/).waitFor()
  for (let i = 0; i < 5; i++) {
    await page.getByRole('button', { name: `Удалить extra-${i}.pdf` }).click()
  }
  const beforeInvalid = await getItem(created.id)
  await input.setInputFiles({ ...file('broken.pdf'), buffer: Buffer.from('broken') })
  await send.click()
  await page.getByText(/Файл пустой, повреждён/).waitFor()
  assert.deepEqual(await getItem(created.id), beforeInvalid)
  await page.getByRole('button', { name: 'Удалить broken.pdf' }).click()

  await input.setInputFiles(file('replacement.pdf'))
  await explanation.fill('Я'.repeat(3001))
  await send.click()
  await page.getByText('Проверьте пояснение.', { exact: true }).waitFor()
  assert.equal(await explanation.evaluate((field) => field === document.activeElement), true)
  assert.deepEqual(await getItem(created.id), beforeInvalid)
  await explanation.fill('Исправлено после проверки')
  await page.route(`**${base}/${created.id}/resubmit`, (route) => route.abort('failed'), {
    times: 1,
  })
  await send.click()
  await page.getByRole('button', { name: 'Продолжить редактирование' }).click()
  assert.equal(await explanation.inputValue(), 'Исправлено после проверки')
  assert.equal(await page.getByRole('button', { name: 'Удалить replacement.pdf' }).count(), 1)
  assert.equal(await page.getByRole('button', { name: 'Оставить original.pdf' }).count(), 1)
  assert.deepEqual(await getItem(created.id), beforeInvalid)
  corrected = await recoverMultipart(returned, 'Исправлено после проверки', [
    'keep.pdf',
    'replacement.pdf',
  ])
  assert.equal(
    corrected.attachments.find((attachment) => attachment.original_filename === 'keep.pdf').id,
    returned.attachments.find((attachment) => attachment.original_filename === 'keep.pdf').id,
  )
  assert.deepEqual(corrected.attachments.map((item) => item.original_filename).sort(), [
    'keep.pdf',
    'replacement.pdf',
  ])
  await get(`/api/v1/applications/attachments/${created.attachments[0].id}/download`, student, 404)
  returned = await returnApplication(corrected, 'Следующее уточнение')
  await open(created.id)
  await edit.click()
  await explanation.fill('Пояснение уже на рассмотрении')
  await input.setInputFiles(file('review.pdf'))
  corrected = await recoverMultipart(
    returned,
    'Пояснение уже на рассмотрении',
    ['keep.pdf', 'replacement.pdf', 'review.pdf'],
    { startReview: true },
  )
  const approvedLeave = await review(corrected, 'approve')
  await open(approvedLeave.id)
  assert.equal(await edit.count(), 0)
  assert.equal(await page.getByRole('button', { name: /PDF/ }).count(), 0)

  // Another request can commit the same attachment metadata with other bytes.
  // The UI can confirm the transition but cannot attribute the content.
  const ambiguous = await returnApplication(
    await post(
      base,
      student,
      {
        multipart: { form_data: JSON.stringify(leave), files: file('original.pdf') },
      },
      201,
    ),
  )
  await open(ambiguous.id)
  await edit.click()
  await explanation.fill('Одинаковые метаданные')
  const attemptedFile = { ...file('same.pdf'), buffer: Buffer.concat([pdf, Buffer.from('A')]) }
  const competingFile = { ...file('same.pdf'), buffer: Buffer.concat([pdf, Buffer.from('B')]) }
  await input.setInputFiles(attemptedFile)
  const ambiguousSaved = await recoverMultipart(
    ambiguous,
    'Одинаковые метаданные',
    ['original.pdf', 'same.pdf'],
    { concurrentFile: competingFile },
  )
  const same = ambiguousSaved.attachments.find(
    ({ original_filename }) => original_filename === 'same.pdf',
  )
  assert.equal(same.size_bytes, attemptedFile.buffer.length)
  const savedBytes = await (
    await get(`/api/v1/applications/attachments/${same.id}/download`)
  ).body()
  assert.deepEqual(savedBytes, competingFile.buffer)
  assert.notDeepEqual(savedBytes, attemptedFile.buffer)
  console.log('PASS: lost multipart responses, replacement, subsequent review and ambiguous bytes')

  // Intercept only the delivery of a successful HTTP response. The POST itself
  // runs on the real API, and must be followed by GET detail/history, never POST.
  let accounting = await returnApplication(await createAccounting('Первоначальная цель'))
  await open(accounting.id)
  await edit.click()
  await purpose.fill('Новая цель')
  let posts = 0
  const resubmit = `**${base}/${accounting.id}/resubmit`
  await page.route(resubmit, async (route) => {
    posts++
    assert.match(route.request().headers()['content-type'], /^application\/json/)
    assert.deepEqual(route.request().postDataJSON(), {
      expected_version: accounting.version,
      form_data: { purpose: 'Новая цель' },
    })
    const response = await route.fetch({ maxRetries: 0 })
    assert.equal(response.status(), 200)
    const reviewing = await review(await response.json(), 'start_review')
    assert.equal(reviewing.review_status, 'in_review')
    await route.abort('failed')
  })
  await send.click()
  await waitForCorrection(accounting.id, accounting.version + 1)
  assert.equal(posts, 1)
  await page.unroute(resubmit)
  accounting = await getItem(accounting.id)
  assert.equal(accounting.form_data.purpose, 'Новая цель')
  assert.equal(accounting.review_status, 'in_review')
  await history.getByText('Подано повторно → На рассмотрении', { exact: true }).waitFor()

  for (const outcome of ['ready', 'failed', 'different']) {
    const returnedAccounting = await returnApplication(await createAccounting('Исходная цель'))
    await open(returnedAccounting.id)
    await edit.click()
    await purpose.fill('Цель после доработки')
    const path = `${base}/${returnedAccounting.id}`
    const originalHistory = (await (await get(`${path}/history`)).json()).items
    let postCount = 0
    const routePath = `**${path}/resubmit`
    await page.route(routePath, async (route) => {
      postCount++
      assert.equal(postCount, 1)
      const response = await route.fetch({
        maxRetries: 0,
        ...(outcome === 'different'
          ? {
              postData: {
                expected_version: returnedAccounting.version,
                form_data: { purpose: 'Конкурентная цель' },
              },
            }
          : {}),
      })
      assert.equal(response.status(), 200)
      const submitted = await response.json()
      assert.equal(submitted.id, returnedAccounting.id)
      assert.equal(submitted.version, returnedAccounting.version + 1)
      const reviewing = await review(submitted, 'start_review')
      const root = join(process.env.ATTACHMENT_STORAGE_PATH, 'issued_documents')
      if (outcome === 'failed') await rename(root, `${root}.r3-backup`)
      try {
        if (outcome === 'failed') await writeFile(root, '')
        const approved = await review(reviewing, 'approve')
        assert.equal(approved.document_status, outcome === 'failed' ? 'failed' : 'ready')
        assert.equal(approved.version, returnedAccounting.version + 4)
      } finally {
        if (outcome === 'failed') {
          await unlink(root)
          await rename(`${root}.r3-backup`, root)
        }
      }
      await route.abort('failed')
    })
    try {
      await send.click()
      if (outcome === 'different') {
        await page.getByText(/Сохранённые поля или состав вложений отличаются/).waitFor()
        assert.equal(
          await page
            .getByText(`Заявление № ${returnedAccounting.id} подано повторно.`, { exact: false })
            .count(),
          0,
        )
      } else {
        await waitForCorrection(returnedAccounting.id, returnedAccounting.version + 1)
      }
      const saved = await getItem(returnedAccounting.id)
      assert.equal(saved.id, returnedAccounting.id)
      assert.equal(saved.version, returnedAccounting.version + 4)
      assert.equal(saved.review_status, 'approved')
      assert.equal(saved.document_status, outcome === 'failed' ? 'failed' : 'ready')
      const expectedPurpose = outcome === 'different' ? 'Конкурентная цель' : 'Цель после доработки'
      assert.equal(saved.form_data.purpose, expectedPurpose)
      await page
        .locator('.application-detail article')
        .getByText(expectedPurpose, { exact: true })
        .waitFor()
      await history.getByText('Текущий этап — Одобрено', { exact: true }).waitFor()
      const events = (await (await get(`${path}/history`)).json()).items
      assert.deepEqual(events.slice(0, originalHistory.length), originalHistory)
      assert.deepEqual(
        events
          .slice(originalHistory.length)
          .map(({ from_status, to_status }) => [from_status, to_status]),
        [
          ['needs_correction', 'resubmitted'],
          ['resubmitted', 'in_review'],
          ['in_review', 'approved'],
        ],
      )
      assert.equal(await send.count(), 0)
      assert.equal(postCount, 1)
      if (outcome === 'different') page.once('dialog', (dialog) => void dialog.accept())
    } finally {
      await page.unroute(routePath)
    }
  }
  console.log(
    'PASS: lost correction response followed by document issuance, failure and competing data',
  )

  // Keep the status needs_correction while making the open editor's version stale.
  accounting = await review(accounting, 'return_for_correction', 'Ещё нужны исправления')
  await open(accounting.id)
  await edit.click()
  await purpose.fill('Локальное исправление')
  const sendAccounting = (item, value) =>
    post(`${base}/${item.id}/resubmit`, student, {
      data: { expected_version: item.version, form_data: { purpose: value } },
    })
  const latest = await returnApplication(await sendAccounting(accounting, 'Другая вкладка'))
  await send.click()
  await page.getByText(/Заявление изменилось. Сверьте/).waitFor()
  assert.equal(await purpose.inputValue(), 'Локальное исправление')
  assert.equal(await send.isDisabled(), true)
  assert.equal((await getItem(accounting.id)).version, latest.version)
  await page.getByRole('button', { name: /Использовать версию/ }).click()
  await send.click()
  await waitForCorrection(accounting.id, latest.version + 1)

  accounting = await returnApplication(await getItem(accounting.id))
  await open(accounting.id)
  await edit.click()
  await purpose.fill('Ещё одно исправление')
  const rejected = await review(
    await review(await sendAccounting(accounting, 'Другой ответ'), 'start_review'),
    'reject',
    'Закрыто по решению',
  )
  // Supplying the current version isolates the transition check from the
  // optimistic version check exercised immediately above.
  await page.route(resubmit, async (route) => {
    const response = await route.fetch({
      postData: { ...route.request().postDataJSON(), expected_version: rejected.version },
      maxRetries: 0,
    })
    assert.equal(response.status(), 409)
    assert.equal((await response.json()).error.code, 'invalid_transition')
    await route.fulfill({ response })
  })
  await send.click()
  await page
    .getByText('Повторная отправка больше недоступна. Статус заявления изменился.')
    .waitFor()
  assert.equal(await send.count(), 0)
  await page.unroute(resubmit)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()
  await history.getByText('Закрыто по решению').waitFor()
  assert.equal(await edit.count(), 0)
  assert.equal(await page.getByRole('button', { name: /формирование|PDF/ }).count(), 0)
  assert.equal((await getItem(rejected.id)).review_status, 'rejected')

  const interrupted = await returnApplication(await createAccounting('Прежняя цель'))
  await open(interrupted.id)
  await edit.click()
  await purpose.fill('Сохранённый черновик')
  const interruptedPath = `**${base}/${interrupted.id}/resubmit`
  const historyPath = `${base}/${interrupted.id}/history`
  const initialHistory = await (await get(historyPath)).json()
  let attempts = 0
  await page.route(interruptedPath, async (route) => {
    attempts++
    if (attempts === 1) {
      await route.abort('failed')
      return
    }
    assert.deepEqual(route.request().postDataJSON(), {
      expected_version: interrupted.version,
      form_data: { purpose: 'Сохранённый черновик' },
    })
    // Deliver the original payload just after the fresh GET and before the
    // manually initiated second POST reaches the real server.
    await sendAccounting(interrupted, 'Сохранённый черновик')
    const response = await route.fetch({ maxRetries: 0 })
    assert.equal(response.status(), 409)
    assert.equal((await response.json()).error.code, 'version_conflict')
    await route.fulfill({ response })
  })
  await send.click()
  const resume = page.getByRole('button', { name: 'Продолжить редактирование' })
  await resume.waitFor()
  assert.equal(await purpose.isDisabled(), true)
  assert.equal(await purpose.inputValue(), 'Сохранённый черновик')
  const [unchanged, unchangedHistory] = await Promise.all([
    getItem(interrupted.id),
    (await get(historyPath)).json(),
  ])
  assert.equal(unchanged.version, interrupted.version)
  assert.equal(unchanged.review_status, 'needs_correction')
  assert.deepEqual(unchanged.form_data, interrupted.form_data)
  assert.deepEqual(unchangedHistory, initialHistory)
  const refresh = page.waitForResponse((response) => response.url().includes(`${historyPath}?`))
  await page.getByRole('button', { name: 'Проверить состояние заявления' }).click()
  assert.equal((await refresh).status(), 200)
  await resume.click()
  assert.equal(await purpose.isDisabled(), false)
  assert.equal(await purpose.inputValue(), 'Сохранённый черновик')
  assert.equal(attempts, 1)
  await send.click()
  await page
    .getByText('Повторная отправка больше недоступна. Статус заявления изменился.')
    .waitFor()
  assert.equal(attempts, 2)
  assert.equal((await getItem(interrupted.id)).version, interrupted.version + 1)
  const resultingHistory = await (await get(historyPath)).json()
  assert.equal(resultingHistory.items.length, initialHistory.items.length + 1)
  await page.unroute(interruptedPath)
  page.once('dialog', (dialog) => void dialog.accept())

  const keyboardDraft = await returnApplication(await createAccounting('Для проверки клавиатуры'))
  await open(keyboardDraft.id)
  const moveFocus = async (target, key) => {
    for (let i = 0; i < 30; i++) {
      if (await target.evaluate((node) => node === document.activeElement)) return
      await page.keyboard.press(key)
    }
    assert.ok(await target.evaluate((node) => node === document.activeElement))
  }
  await moveFocus(edit, 'Tab')
  await page.keyboard.press('Enter')
  await purpose.waitFor()
  assert.ok(await purpose.evaluate((node) => node === document.activeElement))
  await page.keyboard.type(' / keyboard draft')
  const draftValue = await purpose.inputValue()
  assert.match(draftValue, /keyboard draft/)
  const back = page.getByRole('link', { name: /К моим заявлениям/ })
  await moveFocus(back, 'Shift+Tab')
  const dialog = page.getByRole('alertdialog')
  const keepEditing = dialog.getByRole('button', { name: 'Продолжить заполнение' })
  const exitDialog = dialog.getByRole('button', { name: 'Выйти', exact: true })
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  assert.ok(await keepEditing.evaluate((node) => node === document.activeElement))
  await page.keyboard.press('Shift+Tab')
  assert.ok(await exitDialog.evaluate((node) => node === document.activeElement))
  await page.keyboard.press('Tab')
  assert.ok(await keepEditing.evaluate((node) => node === document.activeElement))
  await page.keyboard.press('Tab')
  assert.ok(await exitDialog.evaluate((node) => node === document.activeElement))
  await page.keyboard.press('Tab')
  assert.ok(await keepEditing.evaluate((node) => node === document.activeElement))
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.ok(await back.evaluate((node) => node === document.activeElement))
  assert.equal(await purpose.inputValue(), draftValue)
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.waitForURL('**/services?tab=applications')
  assert.equal((await getItem(keyboardDraft.id)).version, keyboardDraft.version)

  console.log('PASS: correction, attachment replacement, 422, conflicts and lost response')

  // Grow history past the real server page limit.
  let longHistory = await createAccounting('Длительное рассмотрение')
  for (let i = 1; i <= 7; i++) {
    longHistory = await returnApplication(longHistory, `Уточнение ${i} из 7`)
    longHistory = await sendAccounting(longHistory, `Ответ ${i}`)
  }
  await open(longHistory.id)
  await history.getByRole('button', { name: 'Показать ещё события' }).click()
  await history.getByText('Уточнение 7 из 7').waitFor()
  assert.equal(await history.getByRole('listitem').count(), 22)

  // Legacy has no invented initial event and only its process action mutates it.
  await open(legacyId)
  await history.getByText('Событий пока нет.').waitFor()
  assert.equal((await getItem(legacyId)).review_status, 'submitted')
  const processing = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/${legacyId}/document/process`) &&
      response.request().method() === 'POST',
    { timeout: 90_000 },
  )
  await page.getByRole('button', { name: 'Сформировать документ', exact: true }).click()
  assert.equal((await processing).status(), 200)
  const downloadButton = page.getByRole('button', { name: 'Скачать PDF' })
  await downloadButton.waitFor()
  await history.getByText('Подано → Одобрено', { exact: true }).waitFor()
  assert.equal(await history.getByRole('listitem').count(), 1)
  const issued = await getItem(legacyId)
  assert.equal((await api.get(`${base}/${legacyId}/history`)).status(), 401)
  await get(`${base}/${legacyId}/history`, dean, 403)
  const originalBytes = await (await get(`${base}/${legacyId}/document`)).body()
  assert.equal(originalBytes.subarray(0, 5).toString(), '%PDF-')
  assert.equal(await edit.count(), 0)

  const automatic = await post(
    base,
    student,
    {
      data: {
        service_code: 'study_certificate',
        form_data: { place_of_submission: 'Для проверки' },
      },
    },
    201,
  )
  assert.equal(automatic.review_status, 'approved')
  assert.equal(automatic.document_status, 'ready')
  await open(automatic.id)
  await downloadButton.waitFor()
  assert.equal(await edit.count(), 0)

  const manual = await review(await createAccounting('Для архива'), 'start_review')
  fixture('pending', manual.id)
  await open(manual.id)
  const retryButton = page.getByRole('button', { name: 'Повторить формирование' })
  assert.equal((await getItem(manual.id)).document_status, 'pending')
  const issuedRoot = join(process.env.ATTACHMENT_STORAGE_PATH, 'issued_documents')
  await rename(issuedRoot, `${issuedRoot}.available`)
  try {
    await writeFile(issuedRoot, '')
    await retryButton.click()
    await page.getByText('Ошибка подготовки', { exact: true }).waitFor()
    assert.equal((await getItem(manual.id)).document_status, 'failed')
  } finally {
    await unlink(issuedRoot)
    await rename(`${issuedRoot}.available`, issuedRoot)
  }
  const retry = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/${manual.id}/document/retry`) &&
      response.request().method() === 'POST',
    { timeout: 90_000 },
  )
  await retryButton.click()
  assert.equal((await retry).status(), 200)
  await downloadButton.waitFor()
  assert.equal((await getItem(manual.id)).document_status, 'ready')

  const key = fixture('document-key', automatic.id)
  const path = join(issuedRoot, key)
  await open(automatic.id)
  await rename(path, `${path}.unavailable`)
  try {
    await downloadButton.click()
    await page.getByText(/Выданный PDF временно недоступен \(503\)/).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Повторить формирование' }).count(), 0)
  } finally {
    await rename(`${path}.unavailable`, path)
  }

  console.log('PASS: history pagination, explicit document process/retry and missing PDF')

  for (let i = 0; i < 21; i++) await createAccounting(`Архивная запись ${i + 1}`)
  await logout()
  const other = await browserLogin(otherLogin)
  await page.goto(`/applications/${legacyId}`)
  await page.getByText('Заявление не найдено').waitFor()
  assert.equal(await downloadButton.count(), 0)
  for (const path of [
    `${base}/${legacyId}`,
    `${base}/${legacyId}/history`,
    `${base}/${legacyId}/document`,
    `${base}/attachments/${corrected.attachments[0].id}/download`,
  ])
    await get(path, other, 404)
  await logout()
  student = await browserLogin(login)
  await page.goto('/services?tab=applications')
  const link = page.getByRole('link', { name: new RegExp(`№ ${legacyId}$`) })
  const rows = page.locator('.applications-table tbody tr')
  await rows.first().waitFor()
  while (!(await link.isVisible())) {
    const count = await rows.count()
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
    await rows.nth(count).waitFor()
  }
  await link.locator('xpath=ancestor::tr').getByText('PDF выдан').waitFor()
  await link.focus()
  await page.keyboard.press('Enter')
  await downloadButton.waitFor()
  await fit(360)
  const documentDownload = page.waitForEvent('download')
  await downloadButton.click()
  const download = await documentDownload
  assert.equal(download.suggestedFilename(), issued.document.filename)
  assert.deepEqual(await readFile(await download.path()), originalBytes)

  const preview = page.getByRole('button', { name: 'Открыть PDF в новой вкладке' })
  const opened = context.waitForEvent('page')
  await preview.click()
  const popup = await opened
  await popup.waitForURL((url) => url.protocol === 'blob:', { waitUntil: 'commit' })
  assert.equal(await popup.evaluate(() => window.opener === null), true)
  await popup.close()
  await page.evaluate(() => {
    window.open = () => null
  })
  await preview.click()
  await page.getByText(/Браузер заблокировал новую вкладку/).waitFor()
  await page.goBack()
  await link.waitFor()
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute('data-application-id') === id,
    legacyId,
  )
  await page.goForward()
  await downloadButton.waitFor()
  await open(created.id)
  await history.getByText(reason).waitFor()
  console.log('Student correction, history and document archive passed against PostgreSQL.')
} finally {
  await context.close()
  await api.dispose()
  await browser.close()
}
