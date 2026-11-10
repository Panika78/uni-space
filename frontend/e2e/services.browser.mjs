/* global process, console, URL, document, window */
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const login = process.env.SERVICES_TEST_LOGIN
const password = process.env.SERVICES_TEST_PASSWORD
assert.ok(login && password, 'Provide a fictional SERVICES_TEST_LOGIN and SERVICES_TEST_PASSWORD')

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
})
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const postResponses = []
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/applications'
    )
      postResponses.push(response)
  })
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(login)
  await page.getByLabel('Пароль').fill(password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.waitForURL(`${baseURL}/schedule`)

  await page.goto(`${baseURL}/services`)
  await page.getByRole('heading', { name: 'Услуги и документы' }).waitFor()
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  await page.getByRole('heading', { name: 'Справка об обучении' }).waitFor()
  const field = page.getByLabel(/Место предоставления/)
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  assert.equal(await field.evaluate((node) => node === document.activeElement), true)

  await field.fill('  Канцелярия\nкорпус № 2 — 東京  ')
  assert.ok((await field.inputValue()).length > 0)
  await page.getByRole('link', { name: 'К каталогу услуг' }).click()
  await page.getByRole('dialog', { name: 'Выйти без сохранения?' }).waitFor()
  await page.getByRole('button', { name: 'Продолжить заполнение' }).click()
  assert.match(page.url(), /\/services\/study_certificate$/)

  const responseWaiter = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/applications',
  )
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  const response = await responseWaiter
  assert.equal(response.status(), 201)
  assert.match(response.headers().location, /^\/api\/v1\/applications\/[1-9][0-9]*$/)
  const saved = await response.json()
  await page.getByText(`№ ${saved.id}`).waitFor()
  assert.equal(saved.form_data.place_of_submission, 'Канцелярия\nкорпус № 2 — 東京')
  assert.equal(postResponses.length, 1, 'The form dispatches a single POST')
  console.log('PASS: desktop catalog, form validation, navigation warning and real PostgreSQL save')

  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto(`${baseURL}/services`)
  await page.getByRole('heading', { name: 'Услуги и документы' }).waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  await page.getByRole('heading', { name: 'Справка об обучении' }).waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await context.close()
  console.log('PASS: 360px catalog and application form without horizontal overflow')
} finally {
  await browser.close()
}
