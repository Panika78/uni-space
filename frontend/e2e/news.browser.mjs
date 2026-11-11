/* global process, console, URL, window, document */
// Run against Vite, the real backend and a fictional student with at least 61
// published news rows, one unbroken long title, and long bodies for detail scroll.
import assert from 'node:assert/strict'

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { chromium } = playwright.default ?? playwright
const baseURL = process.env.NEWS_TEST_URL || 'http://localhost:5173'
const loginName = process.env.NEWS_TEST_LOGIN
const password = process.env.NEWS_TEST_PASSWORD
assert.ok(loginName && password, 'Provide fictional NEWS_TEST_LOGIN and NEWS_TEST_PASSWORD')

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
const apiRequests = []
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.pathname === '/api/v1/news') apiRequests.push(url.search)
})

const check = (name) => console.log(`PASS ${name}`)
const waitForNewsRows = (count) =>
  page.waitForFunction(
    (expected) => document.querySelectorAll('.news-row').length === expected,
    count,
  )

try {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(loginName)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Новости', exact: true }).click()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await waitForNewsRows(20)
  assert.ok(
    (await page.locator('.news-row h2').allTextContents()).some((title) => title.length > 100),
  )

  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  const firstNewsLink = page.locator('.news-row__link').first()
  assert.equal(await firstNewsLink.locator('time').count(), 1)
  assert.equal(await firstNewsLink.locator('h2').count(), 1)
  assert.equal(await firstNewsLink.locator('p').count(), 1)
  assert.equal(await firstNewsLink.locator('.news-row__arrow[aria-hidden="true"]').count(), 1)
  await firstNewsLink.hover()
  await page.waitForFunction(
    () =>
      window.getComputedStyle(document.querySelector('.news-row__link:hover')).backgroundColor ===
      'rgb(252, 250, 248)',
  )
  assert.equal(
    await page.locator('.news-load-more').evaluate((button) => button.closest('.news-feed')),
    null,
  )
  assert.equal(await page.locator('.news-load-more__line').count(), 2)
  await firstNewsLink.focus()
  await page.keyboard.press('Tab')
  assert.equal(
    await page.evaluate(() => document.activeElement?.matches('.news-row__link:focus-visible')),
    true,
  )
  check('feed rows are full links with hover, keyboard focus and an external pagination control')

  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await waitForNewsRows(40)
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await waitForNewsRows(60)
  check('real backend loads three keyset pages')

  await page.evaluate(() => window.scrollTo(0, 700))
  const articleTitle = await page.locator('.news-row__link h2').evaluateAll((headings) => {
    const visible = headings.find((heading) => {
      const rect = heading.closest('.news-row__link').getBoundingClientRect()
      return rect.top >= 120 && rect.bottom <= window.innerHeight - 80
    })
    return visible?.textContent
  })
  assert.ok(articleTitle, 'A news link should be visible at the saved feed position')
  const feedPosition = await page.evaluate(() => window.scrollY)
  const articleLink = page.locator('.news-row__link').filter({ hasText: articleTitle })
  await articleLink.click()
  await page.getByRole('heading', { name: articleTitle, exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.scrollY), 0)
  assert.ok((await page.locator('.news-article__body').evaluate((body) => body.scrollHeight)) > 900)

  await page.evaluate(() => window.scrollTo(0, 500))
  const detailPosition = await page.evaluate(() => window.scrollY)
  await page.getByRole('link', { name: 'Расписание', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: articleTitle, exact: true }).waitFor()
  await page.waitForFunction((position) => Math.abs(window.scrollY - position) <= 2, detailPosition)
  await page.goForward()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: articleTitle, exact: true }).waitFor()
  await page.waitForFunction((position) => Math.abs(window.scrollY - position) <= 2, detailPosition)
  check('detail scroll restores across Back and Forward between news and another section')

  await page.clock.install({ time: new Date() })
  await page.clock.fastForward(31 * 60 * 1000)
  let releaseRefresh
  let signalRefreshStarted
  const refreshStarted = new Promise((resolve) => {
    signalRefreshStarted = resolve
  })
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve
  })
  let held = false
  const firstNewsPage = (url) => url.pathname === '/api/v1/news' && !url.searchParams.has('cursor')
  const firstNewsPageRoute = (url) => firstNewsPage(new URL(url))
  await context.route(firstNewsPageRoute, async (route) => {
    const response = await route.fetch()
    if (!held && response.status() === 200) {
      held = true
      signalRefreshStarted()
      await refreshGate
    }
    await route.fulfill({ response })
  })

  await page.getByRole('link', { name: '← Назад к новостям' }).click()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await refreshStarted
  const updatingButton = page.getByRole('button', { name: 'Обновляем…', exact: true })
  await updatingButton.waitFor()
  assert.equal(await updatingButton.isDisabled(), true)
  assert.equal(await page.locator('.news-row').count(), 60)
  const requestsBeforeIgnoredClick = apiRequests.length
  await updatingButton.evaluate((button) => button.click())
  assert.equal(apiRequests.length, requestsBeforeIgnoredClick)
  assert.equal(await page.evaluate(() => window.scrollY), feedPosition)
  releaseRefresh()
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).waitFor()
  await waitForNewsRows(60)
  await context.unroute(firstNewsPageRoute)
  assert.equal(
    new Set(
      await page
        .locator('.news-row__link')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
    ).size,
    60,
  )
  check('31-minute article read retains three pages, refreshes in order and disables load-more')

  await page.evaluate(() => window.scrollTo(0, 600))
  const beforeSchedule = await page.evaluate(() => window.scrollY)
  await page.getByRole('link', { name: 'Расписание', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await page.waitForFunction((position) => Math.abs(window.scrollY - position) <= 2, beforeSchedule)
  await page.goForward()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.goBack()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await page.waitForFunction((position) => Math.abs(window.scrollY - position) <= 2, beforeSchedule)
  check('feed scroll restores across Back and Forward between news and schedule')

  await page.evaluate(() => window.scrollTo(0, 0))
  const directHref = await page.locator('.news-row__link').first().getAttribute('href')
  const directPage = await context.newPage()
  await directPage.goto(`${baseURL}${directHref}`)
  await directPage.getByRole('heading', { level: 1 }).last().waitFor()
  assert.equal(await directPage.evaluate(() => window.scrollY), 0)
  await directPage.getByRole('link', { name: '← Назад к новостям' }).click()
  await directPage.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await directPage.locator('.news-row__link h2').first().waitFor()
  check('direct article URL opens at the top and its fallback link returns to the feed')

  await articleLink.click()
  await page.getByRole('heading', { name: articleTitle, exact: true }).waitFor()
  const originalArticleURL = page.url()
  const [newTab] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: '← Назад к новостям' }).click({ modifiers: ['Control'] }),
  ])
  await newTab.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await newTab.locator('.news-row__link').first().waitFor()
  assert.equal(page.url(), originalArticleURL)
  await newTab.close()
  check('Ctrl+Click on return link opens a new feed tab without changing the article')

  await page.setViewportSize({ width: 360, height: 800 })
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  await page.setViewportSize({ width: 768, height: 900 })
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth)
  check('news browser flow fits 360px, 768px and 1440px viewports')

  await page.getByRole('link', { name: '← Назад к новостям' }).click()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await waitForNewsRows(70)
  assert.equal(await page.locator('.news-load-more').count(), 0)
  check('pagination control disappears after the final page')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${baseURL}/news/70`)
  await page.getByRole('heading', { level: 1 }).last().waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: '/tmp/uni-space-news-detail.png' })
} finally {
  await context.close()
  await browser.close()
}
