/* global process, console, document, window, AbortSignal, getComputedStyle */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { chromium, request } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SCHEDULE_TEST_URL || 'http://localhost:5173'
const fixture = JSON.parse(readFileSync('work/student-course-fixture.json', 'utf8'))
const password = 'Fictional-Course-E2E-2026'
const courseUrl = `/academics/courses/${fixture.course}`
const apiPath = `/api/v1${courseUrl}`
const scheduleUrl = `/schedule?date=${fixture.day}&mode=week`
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 550 },
  timezoneId: 'America/Los_Angeles',
})
const page = await context.newPage()
const teacherApi = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } })
const tab = (name) => page.getByRole('tab', { name, exact: true })
const panel = () => page.getByRole('tabpanel')
const card = (name) => page.locator(`[data-lesson-id="${fixture[name]}"]:visible`)
const heading = () => page.getByRole('heading', { name: fixture.discipline, exact: true, level: 1 })
const check = (message) => console.log(`PASS ${message}`)

async function login(name) {
  await page.goto(baseURL + '/login')
  await page.getByLabel('Логин', { exact: true }).fill(name)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
}
async function logout() {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
}
async function openTab(name) {
  await tab(name).click()
  await page.getByRole('tab', { name, exact: true, selected: true }).waitFor()
  await panel().waitFor()
}
async function writeTeacherData() {
  const loginResult = await teacherApi.post('/api/v1/auth/login', {
    data: { login: 'course-first-teacher', password },
  })
  assert.equal(loginResult.status(), 200)
  const { access_token: token } = await loginResult.json()
  const headers = { Authorization: 'Bearer ' + token }
  const score = await teacherApi.put(
    `/api/v1/teaching/courses/${fixture.course}/groups/${fixture.first_group}/assessments/${fixture.single_work}/results/${fixture.student}`,
    { headers, data: { score: 7 } },
  )
  assert.equal(score.status(), 200, await score.text())
  const mark = await teacherApi.put(
    `/api/v1/attendance/lessons/${fixture.single}/students/${fixture.student}`,
    { headers, data: { status: 'absent' } },
  )
  assert.equal(mark.status(), 200, await mark.text())
  const oldMark = await teacherApi.put(
    `/api/v1/attendance/lessons/${fixture.latest}/students/${fixture.student}`,
    { headers, data: { status: 'attended' } },
  )
  assert.equal(oldMark.status(), 200, await oldMark.text())
  const result = await teacherApi.patch(
    `/api/v1/final-results/courses/${fixture.course}/students/${fixture.student}`,
    { headers, data: { grade_value: 2, retake_location: 'Тестовая аудитория 37' } },
  )
  assert.equal(result.status(), 200, await result.text())
}

async function loadAll(count, itemSelector = 'li') {
  const more = panel().getByRole('button', { name: 'Показать ещё', exact: true })
  await more.waitFor()
  await more.click()
  await panel()
    .locator(itemSelector)
    .nth(count - 1)
    .waitFor({ state: 'attached' })
  await more.waitFor({ state: 'hidden' })
  assert.equal(await panel().locator(itemSelector).count(), count)
}

try {
  await login('course-alpha')
  await page.goto(baseURL + scheduleUrl)
  await card('single').getByText('Семинар', { exact: true }).waitFor()
  await card('multiple').getByText('2 работы', { exact: true }).waitFor()
  assert.equal(
    await card('unlinked').locator('.lesson-card__academic').innerText(),
    '— Не отмечено',
  )
  assert.equal(await card('invisible').count(), 0)
  assert.match(await card('single').locator('.lesson-card__time').innerText(), /08:00.*09:00/s)
  await card('single').getByText('Семинар').click()
  assert.match(page.url(), /\/schedule\?/)
  const original = card('single').getByRole('link', { name: fixture.discipline, exact: true })
  assert.equal(await card('single').getByRole('link').count(), 1)
  await original.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => window.scrollY)
  assert.ok(scroll > 0)
  await original.click()
  await heading().waitFor()
  await page.getByText('Анна Тестовая, Борис Тестовый', { exact: true }).waitFor()
  await tab('Работы и баллы').focus()
  await page.keyboard.press('ArrowRight')
  await page.getByRole('tab', { name: 'Посещаемость', exact: true, selected: true }).waitFor()
  assert.ok(await tab('Посещаемость').evaluate((element) => element === document.activeElement))
  await panel().locator('li').first().waitFor()
  const firstPage = await panel().locator('li').count()
  assert.equal(firstPage, 20)
  const firstTime = await panel().locator('time').first().getAttribute('datetime')
  await loadAll(34)
  const lastTime = await panel().locator('time').last().getAttribute('datetime')
  assert.ok(new Date(lastTime) - new Date(firstTime) > 31 * 86400000)
  assert.equal(
    await panel()
      .getByText(/Перенесено на/)
      .count(),
    2,
  )
  await panel().getByText('Отменено', { exact: true }).waitFor()
  await page.goBack()
  await original.waitFor()
  await page.waitForFunction((target) => Math.abs(window.scrollY - target) <= 3, scroll)
  assert.equal(await page.getByLabel('Дата').inputValue(), fixture.day)
  assert.equal(
    await page.getByRole('button', { name: 'Неделя', exact: true }).getAttribute('aria-pressed'),
    'true',
  )
  const originalSelector = `[data-lesson-id="${fixture.single}"] .lesson-course-link--title`
  await page.waitForFunction(
    (selector) => document.querySelector(selector) === document.activeElement,
    originalSelector,
    { timeout: 5000 },
  )
  await page.goForward()
  await panel().getByText('Показать ещё', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'К расписанию' }).click()
  await original.waitFor()
  await card('multiple').getByRole('link').click()
  await page.getByRole('tab', { name: 'Работы и баллы', exact: true, selected: true }).waitFor()
  await panel().getByText('0 / 10', { exact: true }).waitFor()
  await panel().getByText('Максимум 0', { exact: true }).waitFor()
  assert.equal(
    await panel()
      .locator('.student-course__assessment-note')
      .filter({ hasText: 'Дата требует подтверждения' })
      .count(),
    2,
  )
  await loadAll(26, 'tbody tr')
  await panel().getByText('Задание без даты 20', { exact: true }).waitFor()
  check('desktop links, Moscow time, real assessment table, pagination, Back/Forward and scroll')

  await writeTeacherData()
  await page.getByRole('button', { name: 'Обновить', exact: true }).click()
  await panel().getByText('7 / 10', { exact: true }).waitFor()
  await openTab('Посещаемость')
  await loadAll(34)
  await panel().getByText('Отсутствие', { exact: true }).waitFor()
  await panel().getByText('Присутствие', { exact: true }).waitFor()
  await openTab('Объявления')
  await panel().getByText('Объявление для первой группы', { exact: true }).waitFor()
  await panel()
    .getByText('Безопасный текст <strong>как есть</strong>.', { exact: true })
    .last()
    .waitFor()
  await panel().getByText('Важное', { exact: true }).waitFor()
  assert.equal(await panel().getByText('Объявление для второй группы', { exact: true }).count(), 0)
  assert.deepEqual(
    [
      ...new Set(
        await panel()
          .locator('.announcement-byline')
          .allTextContents()
          .then((items) => items.map((item) => item.split(' · ').at(-1))),
      ),
    ].sort(),
    ['Анна Тестовая', 'Борис Тестовый'],
  )
  await loadAll(22, '.announcement-feed li')
  check(
    'real teacher score, attendance and final writes, student refresh, existing multi-author announcements',
  )

  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto(baseURL + scheduleUrl)
  const arrow = card('single').getByRole('link', { name: /Открыть дисциплину/ })
  await arrow.waitFor()
  const arrowSelector = `[data-lesson-id="${fixture.single}"] .lesson-course-link--arrow`
  await page.waitForFunction((selector) => {
    const link = document.querySelector(selector)
    const bounds = link?.getBoundingClientRect()
    return bounds && bounds.width >= 44 && bounds.height >= 44
  }, arrowSelector)
  const bounds = await arrow.boundingBox()
  const arrowSize = await arrow.evaluate((element) => {
    const style = getComputedStyle(element)
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) }
  })
  assert.ok(arrowSize.width >= 44 && arrowSize.height >= 44)
  const nameBounds = await card('single').locator('h3').boundingBox()
  const badgeBounds = await card('single').locator('.lesson-card__academic').boundingBox()
  assert.ok(nameBounds.x + nameBounds.width <= bounds.x)
  assert.ok(badgeBounds.y >= bounds.y + bounds.height)
  await card('single').getByText('7 / 10', { exact: true }).waitFor()
  await card('single').getByText('Не был', { exact: false }).waitFor()
  await page.waitForFunction(() => document.documentElement.scrollWidth <= 360)
  assert.equal(await card('single').getByRole('link').count(), 1)
  await arrow.click()
  await heading().waitFor()
  await page.waitForFunction(() => document.documentElement.scrollWidth <= 360)
  await tab('Работы и баллы').focus()
  await page.keyboard.press('End')
  assert.ok(await tab('Объявления').evaluate((element) => element === document.activeElement))
  await openTab('Работы и баллы')
  await panel().getByText('7 / 10', { exact: true }).waitFor()
  await page.waitForFunction(() => document.documentElement.scrollWidth <= 360)
  await page.goto(`${baseURL}/academics/courses/${fixture.parallel}?tab=unknown`)
  await heading().waitFor()
  await page.getByRole('tab', { name: 'Работы и баллы', exact: true, selected: true }).waitFor()
  await openTab('Работы и баллы')
  await panel().getByText('Работа второго проведения', { exact: true }).waitFor()
  assert.equal(await panel().getByText('Личный результат первой группы').count(), 0)
  await page.getByRole('link', { name: 'К успеваемости', exact: true }).click()
  await page.getByRole('heading', { name: 'Успеваемость', exact: true }).waitFor()
  await page.locator(`.academics-page a.academics-mobile-course-link[href="${courseUrl}"]`).click()
  await heading().waitFor()
  check(
    '360px course tabs, assessment table, 44px schedule arrow, direct URL and distinct same-name offering',
  )

  // Interrupt only transport; retries read the original live endpoints.
  const isPassport = (url) => url.pathname === apiPath
  const disconnect = (route) => route.abort('failed')
  await page.route(isPassport, disconnect)
  await page.reload()
  await page.getByRole('alert').getByText('Не удалось загрузить данные дисциплины').waitFor()
  await page.unroute(isPassport, disconnect)
  await page.getByRole('button', { name: 'Повторить', exact: true }).click()
  await heading().waitFor()
  await page.goto(baseURL + courseUrl + '?tab=assessments')
  await panel().getByText('Личный результат первой группы', { exact: true }).waitFor()
  let release
  const resume = new Promise((resolve) => {
    release = resolve
  })
  let notify
  const received = new Promise((resolve) => {
    notify = resolve
  })
  await page.route(
    '**' + apiPath + '/assessments',
    async (route) => {
      const response = await route.fetch()
      notify(response.status())
      await resume
      await route.fulfill({ response }).catch(() => {})
    },
    { times: 1 },
  )
  try {
    await page.getByRole('button', { name: 'Обновить', exact: true }).click()
    const responseTimeout = AbortSignal.timeout(15_000)
    const responseStatus = await Promise.race([
      received,
      new Promise((_, reject) => {
        responseTimeout.addEventListener('abort', () => reject(responseTimeout.reason), {
          once: true,
        })
      }),
    ])
    assert.equal(responseStatus, 200)
    execFileSync(
      'backend/.venv/bin/python',
      [
        'frontend/e2e/student-course-fixtures.py',
        'transfer',
        fixture.student,
        fixture.second_group,
      ],
      { env: { ...process.env, PYTHONPATH: 'backend' } },
    )
    await context.setOffline(true)
    await context.setOffline(false)
    await page.getByText('ТЕСТ-2', { exact: false }).waitFor()
    release()
    await panel().getByText('Личный результат второй группы', { exact: true }).waitFor()
    assert.equal(await panel().getByText('Личный результат первой группы').count(), 0)
  } finally {
    release()
  }
  await page.goto(`${baseURL}/academics/courses/${fixture.parallel}`)
  await page.getByRole('alert').getByText('Дисциплина недоступна').waitFor()
  await page.goto(baseURL + '/academics/courses/invalid')
  await page.getByRole('alert').getByText('Некорректный адрес или страница').waitFor()
  await logout()
  await login('course-beta')
  await page.goto(baseURL + courseUrl + '?tab=assessments')
  await panel().getByText('13 / 17', { exact: true }).waitFor()
  assert.equal(await panel().getByText('7 / 10', { exact: true }).count(), 0)
  await openTab('Объявления')
  await panel().getByText('Объявление для второй группы', { exact: true }).waitFor()
  assert.equal(await panel().getByText('Объявление для первой группы', { exact: true }).count(), 0)
  check(
    'network retry, transfer with late response, revoked course access and second account isolation',
  )
} finally {
  await teacherApi.dispose()
  await browser.close()
}
