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
    const title = 'Справка об обучении для предоставления в вымышленное учреждение — '.repeat(4)
    const makeItem = (id) => ({
      id: String(id),
      service: { id: '1', code: 'study_certificate', title },
      form_data: { place_of_submission: 'Вымышленная канцелярия' },
      review_status: 'submitted',
      document_status: 'pending',
      feedback: 'Вымышленный комментарий',
      created_at: '2026-11-01T12:00:00Z',
      updated_at: '2026-11-01T12:00:00Z',
    })
    let items = Array.from({ length: 43 }, (_, index) => makeItem(100 - index))
    let detailFailure = null
    const listRequests = []
    const routedRequests = []
    // Pair completion with the same request. StrictMode can cancel a fetch
    // before routing; a separate global failure count cannot measure completed requests.
    async function countCompletedRequests(start) {
      const completed = await Promise.all(
        routedRequests.slice(start).map(async (request) => {
          const response = await request.response()
          return response !== null && (await response.finished()) === null
        }),
      )
      return completed.filter(Boolean).length
    }
    await page.route('**/api/v1/applications**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/v1/applications') {
        const cursor = url.searchParams.get('cursor')
        listRequests.push(cursor)
        routedRequests.push(route.request())
        const remaining = cursor ? items.filter((item) => Number(item.id) < Number(cursor)) : items
        const selected = remaining.slice(0, 20)
        return route.fulfill({
          json: { items: selected, next_cursor: remaining.length > 20 ? selected.at(-1).id : null },
        })
      }
      if (detailFailure === 'network') return route.abort('failed')
      if (detailFailure === 404)
        return route.fulfill({
          status: 404,
          json: { error: { code: 'not_found', message: 'Не найдено', details: [] } },
        })
      const id = url.pathname.split('/').at(-1)
      return route.fulfill({ json: items.find((item) => item.id === id) ?? makeItem(Number(id)) })
    })
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
    await page.getByRole('button', { name: 'Показать ещё' }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.applications-table tbody tr').length === 40,
    )
    async function tabTo(target) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await target.evaluate((element) => element === document.activeElement)) return
        await page.keyboard.press('Tab')
      }
      throw new Error('Keyboard target was not reachable with Tab')
    }
    const target = page.getByRole('link', { name: /№ 65$/ })
    await tabTo(target)
    const scroll = await page.evaluate(() => window.scrollY)
    await page.keyboard.press('Enter')
    const heading = page.getByRole('heading', { name: 'Заявление № 65' })
    await heading.waitFor()
    assert.equal(await heading.evaluate((element) => element === document.activeElement), true)
    items = items.map((item) => (item.id === '65' ? { ...item, review_status: 'approved' } : item))
    const requestsBeforeReturn = listRequests.length
    await tabTo(page.getByRole('link', { name: /К моим заявлениям/ }))
    await page.keyboard.press('Enter')
    await target.waitFor()
    const restored = await target.evaluate((element) => element === document.activeElement)
    assert.equal(restored, true, 'Return restores keyboard focus to the source record')
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 5, scroll)
    await page.getByText('Одобрено', { exact: true }).waitFor()

    assert.equal(
      await countCompletedRequests(requestsBeforeReturn),
      2,
      'Refresh completes both cached pages exactly once',
    )
    assert.equal(listRequests.at(-1), items[19].id)
    assert.equal(await page.locator('.applications-table tbody tr').count(), 40)
    await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 5, scroll)
    // Reopening the tab refreshes both pages from the new first-page boundary.
    const requestsBeforeTab = listRequests.length
    const oldBoundary = listRequests.at(-1)
    items = [makeItem(101), ...items]
    await page.getByRole('link', { name: 'Каталог услуг', exact: true }).click()
    await page.getByRole('link', { name: 'Мои заявления', exact: true }).click()
    await page.getByRole('link', { name: /№ 101$/ }).waitFor()
    await page.getByText('Обновляем заявления…', { exact: true }).waitFor({ state: 'hidden' })
    assert.equal(await countCompletedRequests(requestsBeforeTab), 2)
    assert.equal(listRequests.at(-1), items[19].id)
    assert.notEqual(oldBoundary, listRequests.at(-1))
    assert.equal(await page.locator('.applications-table tbody tr').count(), 40)
    await page.getByRole('button', { name: 'Показать ещё' }).click()
    await page.waitForFunction(
      () => document.querySelectorAll('.applications-table tbody tr').length === 44,
    )
    const ids = await page.locator('.applications-table tbody a').allTextContents()
    assert.deepEqual(
      ids.map((text) => Number(text.match(/№ (\d+)$/)[1])),
      items.map((item) => Number(item.id)),
    )
    const row = page.locator('.applications-table tbody tr').filter({ has: target })
    assert.equal(await row.locator('.application-field-label').count(), 2)
    for (const label of await row.locator('.application-field-label').all())
      assert.equal(await label.getAttribute('aria-hidden'), 'true')
    if (width === 360) {
      assert.equal(await row.getByText('Дата подачи', { exact: true }).isVisible(), true)
      assert.equal(await row.getByText('Рассмотрение', { exact: true }).isVisible(), true)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      )
    } else {
      assert.equal(await page.getByRole('columnheader', { name: 'Дата подачи' }).isVisible(), true)
      assert.ok((await row.locator('td').nth(2).boundingBox()).width >= 150)
    }
    await page.screenshot({
      path: new URL(`../../work/applications-review-${width}.png`, import.meta.url).pathname,
    })
    await target.click()
    await heading.waitFor()
    await page.getByRole('link', { name: /К моим заявлениям/ }).click()
    detailFailure = 404
    await target.click()
    await page.getByText('Заявление не найдено', { exact: true }).waitFor()
    assert.equal(await page.locator('.application-detail article').count(), 0)
    assert.equal(await page.getByText('Вымышленный комментарий', { exact: true }).count(), 0)
    detailFailure = null
    await page.getByRole('button', { name: 'Повторить' }).click()
    await heading.waitFor()
    await page.getByRole('link', { name: /К моим заявлениям/ }).click()
    detailFailure = 'network'
    await target.click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('.application-detail article').count(), 0)
    detailFailure = null
    await page.getByRole('button', { name: 'Повторить' }).click()
    await heading.waitFor()
    items = items.filter((item) => item.id !== '65')
    await tabTo(page.getByRole('link', { name: /К моим заявлениям/ }))
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.querySelectorAll('.applications-table tbody tr').length === 43,
    )
    await page.waitForFunction(
      () =>
        document.activeElement?.tagName === 'H2' &&
        document.activeElement.textContent === 'Мои заявления',
    )
    assert.equal(await target.count(), 0)
    assert.equal(await page.getByRole('columnheader').count(), 3)
    const dateCell = page.locator('.applications-table tbody td[headers$="-date"]').first()
    const headerId = await dateCell.getAttribute('headers')
    assert.equal(await page.locator(`[id="${headerId}"]`).textContent(), 'Дата подачи')
    console.log(
      `PASS ${width}px: fresh pages/order/scroll, mobile labels, cached 404/network/retry, keyboard return focus`,
    )
    await context.close()
  }
} finally {
  await browser.close()
}
