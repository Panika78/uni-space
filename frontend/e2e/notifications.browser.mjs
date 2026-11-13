/* global process, console, document */
// Run against local Vite + the real backend with two prepared fictional accounts.
// Playwright is supplied by the existing browser tooling used for auth.browser.mjs.
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.AUTH_TEST_URL || 'http://localhost:5173'
const login = process.env.AUTH_TEST_LOGIN_A
const password = process.env.AUTH_TEST_PASSWORD
assert.ok(login && password, 'Provide fictional AUTH_TEST_LOGIN_A and AUTH_TEST_PASSWORD')

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
const page = await context.newPage()
const apiError = (code) => ({ error: { code, message: 'internal server detail', details: [] } })
const check = (name) => console.log(`PASS ${name}`)
const getDrawerState = () =>
  page.evaluate(() => ({
    drawerOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
    activeElement: document.activeElement
      ? {
          tag: document.activeElement.tagName,
          id: document.activeElement.id,
          className: document.activeElement.className,
          ariaLabel: document.activeElement.getAttribute('aria-label'),
        }
      : null,
    rootInert: document.querySelector('#root')?.inert ?? null,
    bodyOverflow: document.body.style.overflow,
  }))
const assertDrawerRestored = async (label) => {
  try {
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"][aria-modal="true"]'),
      null,
      { timeout: 5000 },
    )
  } catch {
    throw new Error(
      `${label}: drawer did not close; state=${JSON.stringify(await getDrawerState())}`,
    )
  }
  try {
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Уведомления"]') === document.activeElement,
      null,
      { timeout: 1500 },
    )
  } catch {
    throw new Error(
      `${label}: focus did not return to notification bell; state=${JSON.stringify(await getDrawerState())}`,
    )
  }
  assert.equal(
    await page.locator('#root').evaluate((element) => element.inert),
    false,
    `${label}: #root.inert`,
  )
  assert.notEqual(
    await page.locator('body').evaluate((element) => element.style.overflow),
    'hidden',
    `${label}: body scroll lock`,
  )
}
try {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(login)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()

  let requestIndex = 0
  let releaseLastPage
  const lastPageGate = new Promise((resolve) => {
    releaseLastPage = resolve
  })
  await context.route('**/api/v1/notifications?*', async (route) => {
    requestIndex++
    if (requestIndex === 1) {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'notification-first',
              type: 'unknown_browser_fixture',
              title: 'Первая фиктивная запись',
              body: 'Проверка полнотекстового отображения',
              created_at: '2026-11-10T10:00:00Z',
            },
          ],
          next_cursor: 'fictional-cursor',
        },
      })
    } else if (requestIndex === 2) {
      await route.fulfill({ status: 503, json: apiError('internal_error') })
    } else if (requestIndex === 3) {
      await lastPageGate
      await route.fulfill({
        json: {
          items: [
            {
              id: 'notification-last',
              type: 'unknown_browser_fixture',
              title: 'Последняя фиктивная запись',
              body: 'Последняя страница',
              created_at: '2026-11-09T10:00:00Z',
            },
          ],
          next_cursor: null,
        },
      })
    } else {
      await route.fulfill({ json: { items: [], next_cursor: null } })
    }
  })

  const bell = page.getByRole('button', { name: 'Уведомления', exact: true })
  await bell.click()
  const dialog = page.getByRole('dialog', { name: 'Уведомления' })
  await page.getByText('Первая фиктивная запись', { exact: true }).waitFor()
  assert.equal(await dialog.evaluate((element) => element.getBoundingClientRect().width), 360)
  assert.equal(await page.locator('#root').evaluate((element) => element.inert), true)
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
  const loadingMore = page.getByRole('button', { name: 'Загружаем…', exact: true })
  await loadingMore.waitFor()
  assert.equal(await loadingMore.isDisabled(), true)
  releaseLastPage()
  await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.getByText('Последняя фиктивная запись', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Показать ещё', exact: true }).count(), 0)
  await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.keyboard.press('Escape')
  await assertDrawerRestored('mobile Escape after page error, retry, and last-page removal')
  check('mobile drawer keeps Tab focus through error, retry, and last page; Escape restores focus')

  await bell.click()
  const mobileDialog = page.getByRole('dialog', { name: 'Уведомления' })
  await mobileDialog.waitFor()
  await mobileDialog.getByRole('button', { name: 'Закрыть уведомления', exact: true }).click()
  await assertDrawerRestored('mobile close button')
  await bell.click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await page.locator('.notification-backdrop').dispatchEvent('click')
  await assertDrawerRestored('mobile backdrop click handler')
  check('mobile drawer restores focus after close button; backdrop handler closes')

  await page.setViewportSize({ width: 1280, height: 900 })
  await bell.click()
  const desktopDialog = page.getByRole('dialog', { name: 'Уведомления' })
  await desktopDialog.waitFor()
  assert.equal(
    await desktopDialog.evaluate((element) => element.getBoundingClientRect().width),
    480,
  )
  await desktopDialog.getByRole('button', { name: 'Закрыть уведомления', exact: true }).click()
  await assertDrawerRestored('desktop close button')
  await bell.click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await page.keyboard.press('Escape')
  await assertDrawerRestored('desktop Escape')
  await bell.click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await page.mouse.click(20, 450)
  await assertDrawerRestored('desktop backdrop')
  await context.unroute('**/api/v1/notifications?*')
  check('desktop drawer restores focus after close button, Escape, and backdrop')
} finally {
  await context.close()
  await browser.close()
}
