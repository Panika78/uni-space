/* global process, console, document, URL */
// Run against real API/PostgreSQL with fictional schedule + academics fixtures.
import assert from 'node:assert/strict'
import { assertAcademicsGeometry, scaleVisibleText } from './academicsGeometry.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SCHEDULE_TEST_URL || 'http://localhost:5173'
const password = process.env.SCHEDULE_TEST_PASSWORD
assert.ok(password)
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const endpoint = '**/api/v1/academics'
const check = (message) => console.log(`PASS ${message}`)
async function login(account) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(account)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.goto(`${baseURL}/academics`)
  await page.getByRole('heading', { name: 'Текущие дисциплины', exact: true }).waitFor()
}
async function logout() {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
}
try {
  await login('schedule-fixture-1')
  await page.getByText('6 / 30', { exact: true }).waitFor()
  await page.getByText('Неудовлетворительно', { exact: true }).waitFor()
  await page.getByText('Не зачтено', { exact: true }).waitFor()
  await page.getByText('Хорошо', { exact: true }).waitFor()
  assert.ok(await page.getByText('Не выставлено', { exact: true }).count())
  assert.ok(await page.getByText('0 / 0', { exact: true }).count())
  const row = page.getByText('Неудовлетворительно', { exact: true }).locator('xpath=ancestor::tr')
  assert.match(await row.innerText(), /Задолженность/)
  assert.match(await row.innerText(), /Пересдача.*Тестовая аудитория 101/s)
  const sections = await page.locator('.academics-page h2').allTextContents()
  assert.deepEqual(sections, ['Текущие дисциплины', 'Сессия'])
  assert.equal(await page.getByRole('progressbar').count(), 0)
  assert.ok(!(await page.locator('.academics-page').innerText()).includes('%'))
  assert.equal(await page.locator('.academics-page a').count(), 0)
  await page.screenshot({ path: 'work/academics-desktop.png', fullPage: true })
  check('real API totals, zero/missing, semantic results and retake in its row; desktop')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const width of [360, 390, 600, 640, 641, 721, 768, 900, 1050, 1440, 2560]) {
    await page.setViewportSize({ width, height: width === 2560 ? 1440 : 1000 })
    for (const collapsed of width >= 721 ? [false, true] : [false]) {
      if (collapsed) await page.getByRole('button', { name: 'Свернуть меню', exact: true }).click()
      await assertAcademicsGeometry(page, width, `${width}/${collapsed ? 'collapsed' : 'expanded'}`)
      await page.screenshot({
        path: `work/academics-${width}-${collapsed ? 'collapsed' : 'expanded'}.png`,
        fullPage: true,
      })
      if (collapsed)
        await page.getByRole('button', { name: 'Развернуть меню', exact: true }).click()
    }
  }
  check(
    'container-responsive academics/session at 11 widths; expanded and collapsed sidebar; accessible table roles and real fixture results',
  )
  // Separate read-only typography stress fixture. The real totals/results scenario above is not replaced.
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/academics')
  await page.reload()
  const real = await read
  assert.equal(real.status(), 200)
  const longCopy = await real.json()
  longCopy.items[0].discipline.name =
    'Современные методы математического моделирования и междисциплинарного анализа сложных систем с дополнительными практическими занятиями'
  longCopy.items[0].final_result.retake_location =
    'Учебно-лабораторный корпус, аудитория для индивидуальных консультаций и повторной аттестации студентов'
  await page.route(endpoint, (request) => request.fulfill({ json: longCopy }))
  for (const width of [360, 721, 768, 900, 1050, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const factor of [1, 1.5, 2]) {
      await page.reload()
      await page.getByText(longCopy.items[0].discipline.name, { exact: true }).first().waitFor()
      await scaleVisibleText(page, factor)
      await page.screenshot({
        path: `work/academics-long-copy-${width}-${factor}.png`,
        fullPage: true,
      })
      await assertAcademicsGeometry(page, width, `long-copy/${width}/${factor}`)
    }
  }
  await page.unroute(endpoint)
  await page.reload()
  await page.getByRole('heading', { name: 'Текущие дисциплины', exact: true }).waitFor()
  check(
    'explicit long-copy fixture at 100/150/200% text; retake, attestation and results remain readable',
  )

  await page.setViewportSize({ width: 360, height: 800 })
  await page.waitForFunction(
    () => Math.abs(document.querySelector('.student-main-column').getBoundingClientRect().left) < 1,
  )
  await page.waitForFunction(() => document.documentElement.scrollWidth <= 360)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360))
  assert.ok((await page.locator('.academics-table tbody th').first().boundingBox()).width >= 300)
  await page.screenshot({ path: 'work/academics-mobile.png', fullPage: true })
  check('360px without horizontal overflow')

  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'internal_error', message: 'Ошибка', details: [] } },
    }),
  )
  await page.reload()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.locator('.academics-page table').count(), 0)
  // Begin from a fresh document so keyboard traversal starts in natural tab order.
  const retry = page.getByRole('button', { name: 'Повторить', exact: true })
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press('Tab')
    if (await retry.evaluate((el) => document.activeElement === el)) break
  }
  assert.ok(
    await page
      .getByRole('button', { name: 'Повторить', exact: true })
      .evaluate((el) => document.activeElement === el),
  )
  await page.unroute(endpoint)
  await page.keyboard.press('Enter')
  await page.getByText('6 / 30', { exact: true }).waitFor()
  check('API error hides grades; natural Tab navigation and Enter retry load real results')
  for (const data of [
    { term: null, items: [] },
    {
      term: { id: '1', name: 'Тестовый семестр', starts_on: '2026-09-01', ends_on: '2027-01-31' },
      items: [],
    },
  ]) {
    await page.route(endpoint, (route) => route.fulfill({ json: data }))
    await page.reload()
    await page
      .getByText(data.term ? 'Нет дисциплин текущего семестра' : 'Нет текущего учебного периода', {
        exact: true,
      })
      .waitFor()
    await page.unroute(endpoint)
  }
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: 'forbidden', message: 'Нет доступа', details: [] } },
    }),
  )
  await page.reload()
  await page.getByText('Успеваемость недоступна', { exact: true }).waitFor()
  await page.unroute(endpoint)
  check('absent term, empty curriculum and 403 are distinct')

  let releaseOld
  let markPending
  const pending = new Promise((resolve) => {
    markPending = resolve
  })
  const gate = new Promise((resolve) => {
    releaseOld = resolve
  })
  await page.route(endpoint, async (route) => {
    const response = await route.fetch()
    markPending()
    await gate
    await route.fulfill({ response }).catch(() => {})
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await pending
  await page.getByText('Загружаем успеваемость…', { exact: true }).waitFor()
  await logout()
  await page.unroute(endpoint, undefined, { behavior: 'ignoreErrors' })
  await login('schedule-fixture-2')
  releaseOld()
  await page.getByText('18 / 30', { exact: true }).waitFor()
  await page.getByText('Отлично', { exact: true }).waitFor()
  await page.getByText('Зачтено', { exact: true }).waitFor()
  assert.equal(await page.getByText('6 / 30', { exact: true }).count(), 0)
  assert.equal(await page.getByText(/Тестовая аудитория 101/).count(), 0)
  check('loading, logout/account switch and delayed old response preserve isolation')
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'session_invalid', message: 'Сессия завершена', details: [] } },
    }),
  )
  await page.reload()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
  assert.equal(await page.locator('.academics-page').count(), 0)
  check('401 ends session and removes personal screen')
} finally {
  await browser.close()
}
