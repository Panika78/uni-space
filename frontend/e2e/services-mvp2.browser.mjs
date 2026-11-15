/* global process, console, window, document */
import assert from 'node:assert/strict'

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
  assert.equal(await page.getByRole('button', { name: 'Пока недоступно' }).isDisabled(), true)

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

  await page.goto(`${baseURL}/services/academic_leave`)
  await page.getByLabel('Основание').waitFor()
  await page.getByLabel('Основание').selectOption('other')
  await page.getByLabel('Пояснение').fill('Тестовое обстоятельство')
  await page.getByText(/подтверждение обязательно/i).waitFor()
  assert.equal(
    await page.getByRole('button', { name: 'Подача пока недоступна' }).isDisabled(),
    true,
  )
  assert.equal(await page.getByLabel('Дата начала').isDisabled(), false)
  console.log(
    'PASS: MVP2 service catalog, transcript/accounting forms, leave submission gate, 360/1440 px',
  )
} finally {
  await browser.close()
}
