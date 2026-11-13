/* global process, console, URL, window, document */
// Run against Vite, the real backend and exactly 70 isolated fictional news rows.
import assert from 'node:assert/strict'

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { chromium } = playwright.default ?? playwright
const baseURL = process.env.NEWS_TEST_URL || 'http://localhost:5173'
const loginName = process.env.NEWS_TEST_LOGIN
const password = process.env.NEWS_TEST_PASSWORD
const detailId = process.env.NEWS_TEST_DETAIL_ID
assert.ok(loginName && password, 'Provide fictional NEWS_TEST_LOGIN and NEWS_TEST_PASSWORD')
assert.ok(detailId, 'Provide NEWS_TEST_DETAIL_ID from the news browser fixture')

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  timeout: 15_000,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
context.setDefaultTimeout(15_000)
context.setDefaultNavigationTimeout(15_000)
const page = await context.newPage()
page.setDefaultTimeout(15_000)
page.setDefaultNavigationTimeout(15_000)
const apiRequests = []
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.pathname === '/api/v1/news') apiRequests.push(url.search)
})

const check = (name) => console.log(`PASS ${name}`)
let currentScenario = 'initialize browser'
let releaseRefresh
const waitForNewsRows = (count) =>
  page.waitForFunction(
    (expected) => document.querySelectorAll('.news-row').length === expected,
    count,
  )

try {
  currentScenario = 'login and load first news page'
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(loginName)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Новости', exact: true }).click()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await waitForNewsRows(20)
  const longTitle = (await page.locator('.news-row h2').allTextContents()).find(
    (title) => title.length > 100,
  )
  assert.ok(longTitle, 'The first page should include a title longer than 100 characters')
  assert.ok(!/\s/.test(longTitle), 'The long title should also exercise an unbroken word')

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

  currentScenario = 'load all 70 news rows and verify keyset sorting'
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await waitForNewsRows(40)
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click()
  await waitForNewsRows(60)
  const publishedDates = await page
    .locator('.news-row time')
    .evaluateAll((items) => items.map((item) => Date.parse(item.dateTime)))
  assert.ok(
    publishedDates.every((value, index) => index === 0 || publishedDates[index - 1] > value),
    'News pages should remain strictly sorted by publication time descending',
  )
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
  const articleLink = page
    .locator('.news-row__link')
    .filter({ has: page.getByRole('heading', { name: articleTitle, exact: true }) })
  await articleLink.click()
  await page.getByRole('heading', { name: articleTitle, exact: true }).waitFor()
  await page.waitForFunction(() => window.scrollY === 0)
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

  currentScenario = 'simulate 31-minute article reading and await feed refresh'
  await page.clock.install({ time: new Date() })
  await page.clock.fastForward(31 * 60 * 1000)
  const refreshStarted = page
    .waitForRequest(
      (request) => {
        const url = new URL(request.url())
        return url.pathname === '/api/v1/news' && !url.searchParams.has('cursor')
      },
      { timeout: 15_000 },
    )
    .then(
      () => null,
      (error) => error,
    )
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve
  })
  let held = false
  const firstNewsPage = (url) => url.pathname === '/api/v1/news' && !url.searchParams.has('cursor')
  const firstNewsPageRoute = (url) => firstNewsPage(new URL(url))
  await context.route(firstNewsPageRoute, async (route) => {
    const response = await route.fetch({ timeout: 15_000 })
    if (!held && response.status() === 200) {
      held = true
      await refreshGate
    }
    await route.fulfill({ response })
  })

  await page.getByRole('link', { name: '← Назад к новостям' }).click()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  const refreshError = await refreshStarted
  if (refreshError) throw refreshError
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
  await page.goto(`${baseURL}/news/${encodeURIComponent(detailId)}`)
  await page.getByRole('heading', { level: 1 }).last().waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: 'work/news-browser-detail.png', timeout: 15_000 })
  check('fixture-provided direct news ID opens without relying on sequence values')
} catch (error) {
  console.error(`FAIL ${currentScenario}: ${error?.message || String(error)}`)
  console.error(`Diagnostic URL: ${new URL(page.url()).origin}${new URL(page.url()).pathname}`)
  try {
    await page.screenshot({ path: 'work/news-browser-failure.png', timeout: 15_000 })
    console.error('Saved failure screenshot: work/news-browser-failure.png')
  } catch (screenshotError) {
    console.error(
      `Could not save failure screenshot: ${screenshotError?.message || screenshotError}`,
    )
  }
  process.exitCode = 1
  throw error
} finally {
  releaseRefresh?.()
  try {
    await context.close()
  } finally {
    await browser.close()
  }
}
