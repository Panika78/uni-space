/* global process, console, window, document, Buffer */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const login = process.env.SERVICES_TEST_LOGIN
const password = process.env.SERVICES_TEST_PASSWORD
assert.ok(login && password, 'Provide a fictional browser test student')

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ['--no-sandbox'],
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  let accessToken = ''
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname === '/api/v1/auth/login' && response.ok()) {
      accessToken = (await response.json()).access_token
    }
  })
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(login)
  await page.getByLabel('Пароль').fill(password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.waitForURL(`${baseURL}/schedule`)

  await page.goto(`${baseURL}/services`)
  for (const title of [
    'Справка об обучении',
    'Выписка об успеваемости',
    'Академический отпуск',
    'Бухгалтерская справка',
  ]) {
    await page.getByRole('heading', { name: title }).waitFor()
  }
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(150)
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `Catalog fits ${width}px`,
    )
  }
  for (const title of [
    'Справка об обучении',
    'Выписка об успеваемости',
    'Академический отпуск',
    'Бухгалтерская справка',
  ]) {
    const requirements = page.getByRole('article', { name: title }).locator('details')
    await requirements.locator('summary').click()
    assert.ok((await requirements.locator('li').count()) > 0, `${title} requirements are visible`)
  }

  await page.getByRole('article', { name: 'Выписка об успеваемости' }).getByRole('link').click()
  await page.getByText(/период будет выбран сервером автоматически/i).waitFor()
  await page.setViewportSize({ width: 360, height: 900 })
  await page.waitForTimeout(150)
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'Transcript form fits 360px',
  )
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByRole('heading', { name: 'Заявление создано' }).waitFor()
  await page.getByText('Сервер подтвердил сохранение заявления.').waitFor()

  await page.goto(`${baseURL}/services`)
  await page.getByRole('article', { name: 'Бухгалтерская справка' }).getByRole('link').click()
  await page.getByLabel('Цель получения (необязательно)').fill('Для обучения')
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByRole('heading', { name: 'Заявление создано' }).waitFor()

  await page.goto(`${baseURL}/services`)
  await page
    .getByRole('article', { name: 'Академический отпуск' })
    .getByRole('link', { name: /Подать заявление/ })
    .click()
  await page.getByLabel('Основание').waitFor()
  await page.getByText(/медицинская справка/i).waitFor()
  await page.getByLabel('Основание').selectOption('other')
  await page.getByText(/указанное обстоятельство/i).waitFor()
  await page.getByLabel('Пояснение').fill('Тестовое обстоятельство')
  const starts = page.getByLabel('Дата начала')
  const ends = page.getByLabel('Дата окончания')
  await starts.fill('31.02.2028')
  await starts.press('Tab')
  await page.locator('#leave-start-error').waitFor()
  await page.locator('#leave-start-calendar').fill('2028-02-29')
  assert.equal(await starts.inputValue(), '29.02.2028')
  await ends.fill('28.02.2028')
  await ends.press('Tab')
  await page
    .locator('#leave-end-error')
    .getByText(/окончание должно быть не раньше начала/i)
    .waitFor()
  await ends.fill('01.03.2028')
  const reloadDialogPromise = page.waitForEvent('dialog').then(async (dialog) => {
    assert.equal(dialog.type(), 'beforeunload')
    await dialog.accept()
  })
  await Promise.all([page.reload({ waitUntil: 'domcontentloaded' }), reloadDialogPromise])
  await page.getByLabel('Основание').waitFor()
  assert.equal(await page.getByLabel('Основание').inputValue(), 'medical')
  assert.equal(await page.getByRole('button', { name: 'Отправить заявление' }).isDisabled(), false)
  assert.equal(await page.getByLabel('Дата начала').isDisabled(), false)

  await page.getByLabel('Дата начала').fill('01.12.2028')
  await page.getByLabel('Дата окончания').fill('31.12.2028')
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByText('Прикрепите минимум один подтверждающий файл.').waitFor()

  await page.locator('#leave-files').setInputFiles({
    name: 'bad.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('not a PDF'),
  })
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByText(/Файл пустой, повреждён или не относится к PDF/i).waitFor()
  await page.getByRole('button', { name: 'Удалить bad.pdf' }).click()

  await page.locator('#leave-files').setInputFiles({
    name: 'oversized.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(10 * 1024 * 1024 + 1)]),
  })
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByText(/Допустимо до 5 файлов/i).waitFor()
  await page.getByRole('button', { name: 'Удалить oversized.pdf' }).click()

  await page.locator('#leave-files').setInputFiles({
    name: 'fictional-proof.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nfictional e2e supporting document\n%%EOF'),
  })
  await page.getByText(/fictional-proof\.pdf/).waitFor()
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByRole('heading', { name: 'Заявление создано' }).waitFor()
  const detailHref = await page
    .getByRole('link', { name: 'Открыть заявление' })
    .getAttribute('href')
  await page.goto(`${baseURL}${detailHref}`)
  await page.getByRole('heading', { name: 'Текущие подтверждающие файлы' }).waitFor()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать' }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'fictional-proof.pdf')
  assert.deepEqual(
    await readFile(await download.path()),
    Buffer.from('%PDF-1.4\nfictional e2e supporting document\n%%EOF'),
  )
  assert.ok(accessToken)
  assert.ok(detailHref)
  const applicationId = detailHref.split('/').at(-1)
  const history = await page
    .context()
    .request.get(`${baseURL}/api/v1/applications/${applicationId}/history`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  assert.equal(history.status(), 200)
  assert.equal((await history.json()).items[0].to_status, 'submitted')
  console.log(
    'PASS: real academic leave multipart submission, validation, confirmation, private download, existing MVP2 forms, 360/1440 px',
  )
} finally {
  await browser.close()
}
