/* global process, console, document, window, Element, performance, MutationObserver, setTimeout, clearTimeout */
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
const startFocusDiagnostics = async () =>
  page.evaluate(() => {
    const entries = []
    const describe = (event, target = document.activeElement) => {
      const element = target instanceof Element ? target : null
      entries.push({
        at: Number(performance.now().toFixed(1)),
        event,
        activeElement: element
          ? {
              tag: element.tagName,
              ariaLabel: element.getAttribute('aria-label'),
            }
          : null,
        drawerOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
        rootInert: document.querySelector('#root')?.inert ?? null,
      })
      if (entries.length > 40) entries.shift()
    }
    const handleFocusIn = (event) => {
      const isBell = event.target.matches?.('[aria-label="Уведомления"]')
      describe(isBell ? 'bell-focused' : 'focus-changed', event.target)
    }
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) => mutation.type === 'attributes' && mutation.target.id === 'root',
        )
      )
        describe('root-inert-changed')
      if (
        mutations.some(
          (mutation) =>
            mutation.type === 'childList' &&
            Array.from(mutation.removedNodes).some(
              (node) =>
                node instanceof Element &&
                (node.matches('[role="dialog"][aria-modal="true"]') ||
                  node.querySelector('[role="dialog"][aria-modal="true"]')),
            ),
        )
      )
        describe('dialog-removed')
    })
    document.addEventListener('focusin', handleFocusIn)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['inert'],
      childList: true,
      subtree: true,
    })
    describe('close-requested')
    window.__task026FocusTrace = {
      entries,
      stop: () => {
        observer.disconnect()
        document.removeEventListener('focusin', handleFocusIn)
      },
    }
  })
const getFocusTrace = () => page.evaluate(() => window.__task026FocusTrace?.entries ?? [])
const stopFocusDiagnostics = () =>
  page.evaluate(() => {
    window.__task026FocusTrace?.stop()
    delete window.__task026FocusTrace
  })
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
const expectFocus = async (dialog, expectedElement, message) => {
  assert.equal(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    true,
    message,
  )
  if (expectedElement)
    assert.equal(
      await expectedElement.evaluate((element) => element === document.activeElement),
      true,
      message,
    )
}
const closeDrawerAndAssert = async (label, closeAction) => {
  await startFocusDiagnostics()
  try {
    await closeAction()
    await assertDrawerRestored(label)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}; focusTrace=${JSON.stringify(await getFocusTrace())}`, {
      cause: error,
    })
  } finally {
    await stopFocusDiagnostics()
  }
}
let releaseLastPageGate = () => {}
try {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(login)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()

  let requestIndex = 0
  let lastPageRequestPending = false
  let lastPageResponseReleased = false
  let resolveLastPageRequestEntered
  const lastPageRequestEntered = new Promise((resolve) => {
    resolveLastPageRequestEntered = resolve
  })
  const waitForLastPageRequestEntered = async () => {
    let timeoutHandle
    try {
      await Promise.race([
        lastPageRequestEntered,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Timed out waiting for the third notifications request')),
            5000,
          )
        }),
      ])
    } finally {
      clearTimeout(timeoutHandle)
    }
  }
  let resolveLastPageGate
  const lastPageGate = new Promise((resolve) => {
    resolveLastPageGate = resolve
  })
  const releaseLastPage = () => {
    if (lastPageResponseReleased) return
    lastPageResponseReleased = true
    resolveLastPageGate()
  }
  releaseLastPageGate = releaseLastPage
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
      lastPageRequestPending = true
      resolveLastPageRequestEntered()
      await lastPageGate
      lastPageRequestPending = false
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
  const mobileBackdropGeometry = await page.evaluate(() => {
    const backdrop = document.querySelector('.notification-backdrop')
    const drawer = document.querySelector('.notification-drawer')
    return {
      backdropWidth: backdrop?.getBoundingClientRect().width,
      drawerWidth: drawer?.getBoundingClientRect().width,
    }
  })
  assert.deepEqual(mobileBackdropGeometry, { backdropWidth: 360, drawerWidth: 360 })
  assert.equal(await page.locator('#root').evaluate((element) => element.inert), true)
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click()
  const loadingMore = page.getByRole('button', { name: 'Загружаем…', exact: true })
  await loadingMore.waitFor()
  assert.equal(await loadingMore.isDisabled(), true)
  await waitForLastPageRequestEntered()
  assert.equal(lastPageRequestPending, true, 'last-page response must still be gated')
  assert.equal(lastPageResponseReleased, false, 'last-page response must not be released yet')
  const closeButton = dialog.getByRole('button', { name: 'Закрыть уведомления', exact: true })
  await expectFocus(dialog, closeButton, 'disabled retry button must restore focus to close button')
  await page.keyboard.press('Tab')
  await expectFocus(dialog, null, 'Tab during gated loading must stay in dialog')
  await page.keyboard.press('Shift+Tab')
  await expectFocus(dialog, null, 'Shift+Tab during gated loading must stay in dialog')
  assert.equal(
    lastPageResponseReleased,
    false,
    'keyboard checks must run before releasing the gate',
  )
  releaseLastPage()
  await page.getByText('Последняя фиктивная запись', { exact: true }).waitFor()
  assert.equal(lastPageRequestPending, false)
  assert.equal(lastPageResponseReleased, true)
  assert.equal(await page.getByRole('button', { name: 'Показать ещё', exact: true }).count(), 0)
  await expectFocus(
    dialog,
    closeButton,
    'last-page update must leave focus restored without another Tab',
  )
  await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true)
  await closeDrawerAndAssert('mobile Escape after page error, retry, and last-page removal', () =>
    page.keyboard.press('Escape'),
  )
  check('mobile drawer keeps Tab focus through error, retry, and last page; Escape restores focus')

  await bell.click()
  const mobileDialog = page.getByRole('dialog', { name: 'Уведомления' })
  await mobileDialog.waitFor()
  await closeDrawerAndAssert('mobile close button', () =>
    mobileDialog.getByRole('button', { name: 'Закрыть уведомления', exact: true }).click(),
  )
  await bell.click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await closeDrawerAndAssert('mobile Escape', () => page.keyboard.press('Escape'))
  check('mobile full-width drawer closes by button and Escape; backdrop has no pointer area')

  await page.setViewportSize({ width: 1280, height: 900 })
  await bell.click()
  const desktopDialog = page.getByRole('dialog', { name: 'Уведомления' })
  await desktopDialog.waitFor()
  assert.equal(
    await desktopDialog.evaluate((element) => element.getBoundingClientRect().width),
    520,
  )
  await closeDrawerAndAssert('desktop close button', () =>
    desktopDialog.getByRole('button', { name: 'Закрыть уведомления', exact: true }).click(),
  )
  await bell.click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await closeDrawerAndAssert('desktop Escape', () => page.keyboard.press('Escape'))
  await bell.click()
  await page.getByRole('dialog', { name: 'Уведомления' }).waitFor()
  await closeDrawerAndAssert('desktop backdrop pointer click', () => page.mouse.click(20, 450))
  await context.unroute('**/api/v1/notifications?*')
  check('desktop drawer restores focus after close button, Escape, and backdrop')
} finally {
  releaseLastPageGate()
  await context.close()
  await browser.close()
}
