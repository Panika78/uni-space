/* global process, console, URL, document, window */
import assert from 'node:assert/strict'
import {
  assertApplicationInteractions,
  assertStatusChipGeometry,
} from './applicationInteractions.mjs'
import { scaleVisibleText } from './academicsGeometry.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
try {
  for (const width of [1440, 768, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } })
    const page = await context.newPage()
    let currentAuthorization
    page.on('request', (request) => {
      if (request.headers().authorization) currentAuthorization = request.headers().authorization
    })
    async function login(account = process.env.SERVICES_TEST_LOGIN) {
      await page.goto(`${base}/login`)
      await page.getByLabel('Логин').fill(account)
      await page.getByLabel('Пароль').fill(process.env.SERVICES_TEST_PASSWORD)
      for (let attempt = 0; attempt < 3; attempt++) {
        const pending = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/v1/auth/login',
        )
        await page.getByRole('button', { name: 'Войти', exact: true }).click()
        const response = await pending
        if (response.status() === 200) break
        assert.equal(response.status(), 429)
        // Both viewports use the real five-attempt login limiter. Respect its
        // window rather than weakening auth settings for the browser suite.
        const seconds = Number(response.headers()['retry-after'])
        assert.ok(seconds > 0 && seconds <= 60)
        await page.waitForTimeout(seconds * 1000)
      }
      await page.waitForURL(`${base}/schedule`)
    }
    async function logout() {
      await page.getByRole('button', { name: 'Меню пользователя' }).click()
      await page.getByRole('button', { name: 'Выйти', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
      await page.waitForURL(`${base}/login`)
    }
    await login()
    await page.goto(`${base}/services`)
    await page.getByRole('link', { name: 'Мои заявления', exact: true }).click()
    await page.getByRole('heading', { name: 'Мои заявления' }).waitFor()
    await page.getByRole('link', { name: 'Каталог услуг', exact: true }).click()
    await page.getByRole('link', { name: 'Подать заявление' }).click()
    const place = `Task014 ${width} — Канцелярия`
    await page.getByLabel(/Место предоставления/).fill(place)
    const responsePromise = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/applications',
    )
    await page.getByRole('button', { name: 'Отправить заявление' }).click()
    const response = await responsePromise
    assert.equal(response.status(), 201)
    const created = await response.json()
    const authorization = response.request().headers().authorization
    await page.getByRole('link', { name: 'Открыть заявление' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: `Заявление № ${created.id}` }).waitFor()
    await page.getByText(place, { exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole('heading', { name: `Заявление № ${created.id}` })
        .evaluate((el) => document.activeElement === el),
      true,
    )
    assert.equal(await page.getByText(/История обработки|Скачать PDF/).count(), 0)
    await page.getByRole('link', { name: /К моим заявлениям/ }).click()
    await page.getByRole('link', { name: new RegExp(`№ ${created.id}$`) }).waitFor()
    await assertApplicationInteractions(page, context, String(created.id), width)
    console.log(
      `PASS ${width}px: real title/date/status/padding hit-testing; keyboard/focus, Ctrl+new tab and native context link`,
    )

    const statuses = [
      'submitted',
      'in_review',
      'needs_correction',
      'resubmitted',
      'approved',
      'rejected',
    ]
    await page.route('**/api/v1/applications?*', (r) =>
      r.fulfill({
        json: {
          items: statuses.map((status, i) => ({
            ...created,
            id: String(90000 + i),
            review_status: status,
          })),
          next_cursor: null,
        },
      }),
    )
    await page.route('**/api/v1/applications/90000', (r) =>
      r.fulfill({ json: { ...created, id: '90000', review_status: 'submitted' } }),
    )
    for (const factor of [1, 1.5, 2]) {
      await page.goto(`${base}/services?tab=applications`)
      await page.locator('.application-status--rejected').waitFor()
      await scaleVisibleText(page, factor)
      await assertStatusChipGeometry(page)
      await page.screenshot({
        path: `work/application-status-list-${width}-${factor}-fixture.png`,
        fullPage: true,
      })
      await page.goto(`${base}/applications/90000`)
      await page.locator('.application-detail .application-status').waitFor()
      await scaleVisibleText(page, factor)
      await assertStatusChipGeometry(page)
      await page.screenshot({
        path: `work/application-status-detail-${width}-${factor}-fixture.png`,
        fullPage: true,
      })
    }
    await page.unroute('**/api/v1/applications?*')
    await page.unroute('**/api/v1/applications/90000')
    console.log(
      `PASS ${width}px: explicit status-chip fixture at 100/150/200%, list and detail, all review statuses`,
    )
    await logout()
    await login()
    await page.goto(`${base}/services?tab=applications`)
    await page.getByRole('link', { name: new RegExp(`№ ${created.id}$`) }).click()
    await page.getByText(place, { exact: true }).waitFor()
    // Populate enough real rows to exercise the next page and scroll restoration.
    await page.getByRole('link', { name: /К моим заявлениям/ }).click()
    const freshAuthorization = currentAuthorization
    for (let i = 0; i < 22; i++) {
      const result = await context.request.post(`${base}/api/v1/applications`, {
        headers: { Authorization: freshAuthorization },
        data: {
          service_code: 'study_certificate',
          form_data: { place_of_submission: `Page ${width} ${i}` },
        },
      })
      assert.equal(result.status(), 201)
    }
    await page.reload()
    await page.getByRole('button', { name: 'Показать ещё' }).focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelectorAll('.applications-table tbody tr').length > 20,
    )
    const count = await page.locator('.applications-table tbody tr').count()
    const last = page.locator('.applications-table a').last()
    await last.scrollIntoViewIfNeeded()
    const scroll = await page.evaluate(() => window.scrollY)
    await last.click()
    await page.getByRole('heading', { name: /Заявление №/ }).waitFor()
    await page.getByRole('link', { name: /К моим заявлениям/ }).click()
    assert.equal(await page.locator('.applications-table tbody tr').count(), count)
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 5, scroll)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    )
    // A committed POST with a lost response never triggers an automatic retry.
    await page.goto(`${base}/services/study_certificate`)
    for (let i = 0; i < 2; i++) {
      const identical = await context.request.post(`${base}/api/v1/applications`, {
        headers: { Authorization: currentAuthorization },
        data: {
          service_code: 'study_certificate',
          form_data: { place_of_submission: 'Identical uncertain application' },
        },
      })
      assert.equal(identical.status(), 201)
    }
    let posts = 0
    let lostId
    await page.route('**/api/v1/applications', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      posts++
      const upstream = await route.fetch()
      assert.equal(upstream.status(), 201)
      lostId = (await upstream.json()).id
      await route.abort('failed')
    })
    await page.getByLabel(/Место предоставления/).fill('Identical uncertain application')
    await page.getByRole('button', { name: 'Отправить заявление' }).click()
    await page.getByText(/Заявление могло сохраниться/).waitFor()
    assert.equal(posts, 1)
    await page.getByRole('link', { name: 'Проверить результат в моих заявлениях' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Покинуть форму' }).click()
    await page.getByRole('link', { name: new RegExp(`№ ${lostId}$`) }).click()
    await page.getByText('Identical uncertain application', { exact: true }).waitFor()
    assert.equal(posts, 1)
    await page.unroute('**/api/v1/applications')
    let releaseOld
    let notifyOld
    const oldGate = new Promise((resolve) => {
      releaseOld = resolve
    })
    const oldStarted = new Promise((resolve) => {
      notifyOld = resolve
    })
    await page.route(`**/api/v1/applications/${created.id}`, async (route) => {
      const upstream = await route.fetch()
      notifyOld()
      await oldGate
      await route.fulfill({ response: upstream }).catch(() => undefined)
    })
    await page.goto(`${base}/applications/${created.id}`)
    await oldStarted
    await logout()
    await login(process.env.SERVICES_TEST_LOGIN_B)
    releaseOld()
    await page.unroute(`**/api/v1/applications/${created.id}`)

    await page.goto(`${base}/applications/${created.id}`)
    await page.getByText('Заявление не найдено', { exact: true }).waitFor()
    assert.equal(await page.getByText(place, { exact: true }).count(), 0)
    await page.goto(`${base}/services?tab=applications`)
    assert.equal(await page.getByRole('link', { name: new RegExp(`№ ${created.id}$`) }).count(), 0)
    // Invalidated old access cannot read either endpoint after logout.
    const revoked = await context.request.get(`${base}/api/v1/applications`, {
      headers: { Authorization: authorization },
    })
    assert.equal(revoked.status(), 401)
    console.log(
      `PASS: ${width}px create → details → list → re-login, pagination/scroll, lost POST, isolation`,
    )
    await context.close()
  }
} finally {
  await browser.close()
}
