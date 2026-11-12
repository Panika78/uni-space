/* global process, console, URL, document, window */
import assert from 'node:assert/strict'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
})
try {
  for (const width of [1440, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } })
    const page = await context.newPage()
    const makeItems = (count) =>
      Array.from({ length: count }, (_, index) => ({
        id: String(count - index),
        service: { id: '1', code: 'study_certificate', title: 'Справка об обучении' },
        form_data: { place_of_submission: 'Вымышленная канцелярия A' },
        review_status: 'submitted',
        document_status: 'pending',
        feedback: null,
        created_at: '2026-11-01T12:00:00Z',
        updated_at: '2026-11-01T12:00:00Z',
      }))
    let rows = makeItems(25)
    let failedCursor
    const requests = []
    await page.route('**/api/v1/applications**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname !== '/api/v1/applications')
        return route.fulfill({
          json: rows.find((row) => row.id === url.pathname.split('/').at(-1)),
        })
      const cursor = url.searchParams.get('cursor')
      requests.push(cursor)
      if (cursor === failedCursor) return route.abort('failed')
      const remaining = cursor
        ? rows.filter((row) => Number(row.id) < Number(cursor.slice(7)))
        : rows
      const items = remaining.slice(0, 20)
      return route.fulfill({
        json: { items, next_cursor: remaining.length > 20 ? `cursor-${items.at(-1).id}` : null },
      })
    })
    async function expectIds(expected) {
      await page.waitForFunction(
        (count) => document.querySelectorAll('.applications-table tbody tr').length === count,
        expected.length,
      )
      const actual = await page.locator('.applications-table tbody a').allTextContents()
      assert.deepEqual(
        actual.map((text) => text.match(/№ (\d+)$/)[1]),
        expected.map((row) => row.id),
      )
    }
    async function reopenCatalog() {
      await page.getByRole('link', { name: 'Каталог услуг', exact: true }).click()
      await page.getByRole('link', { name: 'Мои заявления', exact: true }).click()
    }
    async function tabTo(target) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await target.evaluate((element) => element === document.activeElement)) return
        await page.keyboard.press('Tab')
      }
      throw new Error('Keyboard target not reachable')
    }
    await page.goto(`${base}/login`)
    await page.getByLabel('Логин').fill(process.env.SERVICES_TEST_LOGIN)
    await page.getByLabel('Пароль').fill(process.env.SERVICES_TEST_PASSWORD)
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/auth/login',
      )
      await page.getByRole('button', { name: 'Войти', exact: true }).click()
      const response = await pending
      if (response.status() === 200) break
      assert.equal(response.status(), 429)
      const seconds = Number(response.headers()['retry-after'])
      assert.ok(seconds > 0 && seconds <= 60)
      await page.waitForTimeout(seconds * 1000)
    }
    await page.waitForURL(`${base}/schedule`)
    await page.goto(`${base}/services?tab=applications`)
    // A: refresh failure must not allow the obsolete cursor-6 to be consumed.
    await expectIds(rows.slice(0, 20))
    rows = [{ ...rows[0], id: '26', created_at: '2026-11-02T12:00:00Z' }, ...rows]
    failedCursor = null
    await reopenCatalog()
    await page.getByRole('alert').waitFor()
    await expectIds(makeItems(25).slice(0, 20))
    await page.getByText(/Их данные могут быть неактуальны/).waitFor()
    const more = page.getByRole('button', { name: 'Показать ещё' })
    assert.equal(await more.isDisabled(), true)
    await more.dispatchEvent('click')
    failedCursor = undefined
    await page.getByRole('button', { name: 'Повторить' }).click()
    await page.getByRole('link', { name: /№ 26$/ }).waitFor()
    assert.equal(await more.isEnabled(), true)
    await more.click()
    await expectIds(rows)
    assert.equal(requests.includes('cursor-6'), false)
    assert.equal(requests.at(-1), 'cursor-7')
    // B: a second-page refresh failure retains the entire previous snapshot.
    rows = makeItems(45)
    requests.length = 0
    await page.reload()
    await more.click()
    await expectIds(rows.slice(0, 40))
    rows = [{ ...rows[0], id: '46', created_at: '2026-11-02T12:00:00Z' }, ...rows]
    failedCursor = 'cursor-27'
    await reopenCatalog()
    await page.getByRole('alert').waitFor()
    await expectIds(makeItems(45).slice(0, 40))
    assert.equal(await more.isDisabled(), true)
    await more.dispatchEvent('click')
    failedCursor = undefined
    const retryStart = requests.length
    await page.getByRole('button', { name: 'Повторить' }).click()
    await page.getByRole('link', { name: /№ 46$/ }).waitFor()
    await page.getByText('Обновляем заявления…', { exact: true }).waitFor({ state: 'hidden' })
    await expectIds(rows.slice(0, 40))
    assert.deepEqual(requests.slice(retryStart), [null, 'cursor-27'])
    await more.click()
    await expectIds(rows)
    assert.equal(requests.includes('cursor-6'), false)
    assert.equal(requests.at(-1), 'cursor-7')
    // D: retained pagination still supports keyboard focus and scroll restoration.
    const target = page.getByRole('link', { name: /№ 10$/ })
    await tabTo(target)
    const scroll = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Enter')
    const heading = page.getByRole('heading', { name: 'Заявление № 10' })
    await heading.waitFor()
    assert.equal(await heading.evaluate((element) => element === document.activeElement), true)
    await tabTo(page.getByRole('link', { name: /К моим заявлениям/ }))
    await page.keyboard.press('Enter')
    await target.waitFor()
    assert.equal(await target.evaluate((element) => element === document.activeElement), true)
    await page.getByText('Обновляем заявления…', { exact: true }).waitFor({ state: 'hidden' })
    await expectIds(rows)
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 5, scroll)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    )
    // C: a failed append can be retried without refetching or losing page one.
    rows = makeItems(25)
    failedCursor = 'cursor-6'
    requests.length = 0
    await page.reload()
    await more.click()
    await page.getByText('Не удалось загрузить следующую страницу', { exact: true }).waitFor()
    await expectIds(rows.slice(0, 20))
    assert.equal(await more.isEnabled(), true)
    assert.equal(await page.getByText(/Их данные могут быть неактуальны/).count(), 0)
    failedCursor = undefined
    const appendRetryStart = requests.length
    await page.getByRole('button', { name: 'Повторить' }).click()
    await expectIds(rows)
    assert.deepEqual(requests.slice(appendRetryStart), ['cursor-6'])
    console.log(
      `PASS ${width}px F-05 A/B/C/D: blocked obsolete cursors; complete refresh; safe append retry; focus/scroll`,
    )
    await context.close()
  }
} finally {
  await browser.close()
}
