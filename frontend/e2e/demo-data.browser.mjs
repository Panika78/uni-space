/* global process, console, document, window, URL */
// Exercise the real TASK-017 demo data through the API and responsive student UI.
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.DEMO_TEST_URL || 'http://localhost:5173'
const passwordA = process.env.DEMO_STUDENT_A_PASSWORD
const passwordB = process.env.DEMO_STUDENT_B_PASSWORD
assert.ok(passwordA && passwordB, 'Provide disposable demonstration test passwords')

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const students = new Map()
console.log(`Chromium ${browser.version()}; viewports 1440 and 360; real FastAPI/PostgreSQL`)
const check = (message) => console.log(`PASS ${message}`)

async function login(page, account, password) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(account)
  await page.getByLabel('Пароль').fill(password)
  const pending = page.waitForResponse((r) => r.url().endsWith('/auth/login'))
  await page.getByRole('button', { name: 'Войти' }).click()
  const response = await pending
  if (response.status() === 429) {
    const seconds = Number(response.headers()['retry-after'])
    assert.ok(seconds > 0 && seconds <= 60)
    await page.waitForTimeout(seconds * 1000) // Server-directed rate-limit window.
    await page.getByRole('button', { name: 'Войти' }).click()
  } else assert.equal(response.status(), 200)
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
}

async function navigate(page, label) {
  if (label === 'Мой профиль') {
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
  } else if (page.viewportSize().width === 360) {
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
  }
  await page.getByRole('link', { name: label, exact: true }).filter({ visible: true }).click()
}

async function logout(page) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  const pending = page.waitForResponse((r) => r.url().endsWith('/auth/logout'))
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
  assert.deepEqual(await (await pending).json(), { session_revoked: true })
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
}

async function submitAndRestore(page, account, password) {
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  const place = `Acceptance ${account} ${page.viewportSize().width}`
  await page.getByLabel(/Место предоставления/).fill(place)
  const pending = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/applications',
  )
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  const response = await pending
  assert.equal(response.status(), 201)
  const created = await response.json()
  assert.equal(created.review_status, 'submitted')
  assert.equal(created.document_status, 'pending')
  const authorization = response.request().headers().authorization
  const headers = { authorization }
  const snapshots = {}
  for (const path of [
    'users/me',
    'schedule?date_from=2026-11-19&date_to=2026-11-23',
    'academics',
    'applications',
    'notifications',
  ]) {
    const url = `${baseURL}/api/v1/${path}`
    const result = await page.request.get(url, { headers })
    assert.equal(result.status(), 200)
    assert.equal(result.headers()['cache-control'], 'no-store')
    snapshots[path] = await result.json()
    assert.equal((await page.request.get(url)).status(), 401)
    const separator = path.includes('?') ? '&' : '?'
    assert.equal(
      (
        await page.request.get(`${url}${separator}student_id=999&group_id=999`, { headers })
      ).status(),
      422,
    )
  }
  assert.ok(snapshots.academics.items.length > 0, 'Run final seed within its documented term')
  assert.ok(snapshots.academics.items.every((item) => !item.final_result.has_debt))
  const lessons = snapshots['schedule?date_from=2026-11-19&date_to=2026-11-23'].items
  const moved = lessons.filter((item) => item.status === 'moved')
  const finalDate = account === 'demo-pz101' ? '2026-11-23' : '2026-11-21'
  assert.equal(moved.length, account === 'demo-pz101' ? 2 : 1)
  for (const item of moved) {
    assert.equal(item.latest_lesson.starts_at.slice(0, 10), finalDate)
    const successor = lessons.find((lesson) => lesson.previous_lesson?.id === item.id)
    assert.ok(successor, 'Each move has its immediate successor in the demo interval')
  }
  if (account === 'demo-pz101') assert.ok(lessons.some((item) => item.status === 'cancelled'))
  const news = await (await page.request.get(`${baseURL}/api/v1/news`, { headers })).json()
  const announcement = news.items.find((item) => item.title.includes('19 ноября'))
  assert.ok(announcement)
  const detail = await (
    await page.request.get(`${baseURL}/api/v1/news/${announcement.id}`, { headers })
  ).json()
  assert.match(detail.body, /23 ноября/)
  assert.match(detail.body, /21 ноября/)
  const previous = students.get(account === 'demo-pz101' ? 'demo-pm201' : 'demo-pz101')
  if (previous) {
    for (const path of Object.keys(snapshots))
      assert.notDeepEqual(snapshots[path], previous.snapshots[path])
    const foreign = await page.request.get(`${baseURL}/api/v1/applications/${previous.id}`, {
      headers,
    })
    const missing = await page.request.get(`${baseURL}/api/v1/applications/9223372036854775807`, {
      headers,
    })
    assert.equal(foreign.status(), 404)
    assert.equal(missing.status(), 404)
    assert.deepEqual(await foreign.json(), await missing.json())
  }
  students.set(account, { id: created.id, snapshots })
  await page.getByRole('link', { name: 'Открыть заявление' }).click()
  await page.getByRole('heading', { name: `Заявление № ${created.id}` }).waitFor()
  await page.reload()
  await page.getByText(place, { exact: true }).waitFor()
  await noOverflow(page, page.viewportSize().width)
  await logout(page)
  const revoked = await page.request.get(`${baseURL}/api/v1/users/me`, {
    headers: { authorization },
  })
  assert.equal(revoked.status(), 401)
  await login(page, account, password)
  await navigate(page, 'Услуги и документы')
  await page.getByRole('link', { name: 'Мои заявления', exact: true }).click()
  await page.getByRole('link', { name: new RegExp(`№ ${created.id}$`) }).click()
  await page.getByText(place, { exact: true }).waitFor()
  check(
    `${account}: POST submitted/pending, reload, revoked access, login, same application ${created.id}`,
  )
}

async function noOverflow(page, width) {
  if (width <= 720) {
    await page.waitForFunction(
      () => document.querySelector('.student-main-column')?.getBoundingClientRect().left === 0,
    )
  }
  const overflow = await page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth) return ''
    return Array.from(document.querySelectorAll('*'))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === 'string' ? element.className : '',
        text: element.textContent?.trim().slice(0, 80) ?? '',
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
      }))
      .filter((element) => element.right > window.innerWidth + 1 || element.left < -1)
      .slice(0, 8)
      .map(
        (element) =>
          `${element.tag}.${element.className} ${element.left}:${element.right} ${element.text}`,
      )
      .join('; ')
  })
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${width}px screen has no horizontal overflow on ${page.url()}: ${overflow}`,
  )
}

async function assertTextFitsCard(page, text, scope = 'body') {
  const item = page.locator(scope).getByText(text, { exact: false }).first()
  await item.waitFor()
  const card = item.locator('xpath=ancestor::article')
  const itemBox = await item.boundingBox()
  const cardBox = await card.boundingBox()
  assert.ok(itemBox && cardBox)
  const itemRight = itemBox.x + itemBox.width
  const cardRight = cardBox.x + cardBox.width
  assert.ok(
    itemBox.x >= cardBox.x && itemRight <= cardRight + 1,
    `${text} fits its card (${itemBox.x}-${itemRight} vs ${cardBox.x}-${cardRight})`,
  )
}

async function inspectStudent(
  page,
  account,
  password,
  name,
  program,
  course,
  venue,
  grade,
  weekday,
  width,
) {
  await login(page, account, password)
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.locator('.schedule-list').waitFor()
  if (width > 720) await page.getByRole('button', { name: 'Неделя', exact: true }).click()
  const date = account === 'demo-pz101' ? '2026-11-26' : '2026-11-17'
  await page.getByLabel('Дата', { exact: true }).fill(date)
  await page
    .locator('.schedule-day.is-selected')
    .getByText(course, { exact: false })
    .first()
    .waitFor()
  await assertTextFitsCard(page, course, '.schedule-day.is-selected')
  await assertTextFitsCard(page, venue, '.schedule-day.is-selected')
  if (width === 360)
    await page.locator('.schedule-days button').filter({ hasText: weekday }).click()
  await noOverflow(page, width)
  await assertTextFitsCard(page, course, '.schedule-day.is-selected')
  await assertTextFitsCard(page, venue, '.schedule-day.is-selected')
  await noOverflow(page, width)

  await navigate(page, 'Мой профиль')
  await page.getByRole('heading', { name: 'Мой профиль', exact: true }).waitFor()
  const profile = await page.locator('.profile-page').innerText()
  assert.ok(profile.includes(name))
  assert.ok(profile.includes(program))
  await noOverflow(page, width)

  await navigate(page, 'Успеваемость')
  await page.getByRole('heading', { name: 'Успеваемость', exact: true }).waitFor()
  await page.getByText(grade, { exact: true }).first().waitFor()
  await noOverflow(page, width)

  await navigate(page, 'Новости')
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await page.getByText('Об изменении расписания занятий 19 ноября', { exact: false }).waitFor()
  await noOverflow(page, width)

  await page.getByRole('button', { name: 'Уведомления' }).click()
  const notifications = page.getByRole('dialog', { name: 'Уведомления' })
  await notifications.waitFor()
  await notifications
    .getByText(
      name === 'Иван Сергеевич Гончаров'
        ? 'План на первую сессию'
        : 'Результаты текущих работ обновлены',
    )
    .waitFor()
  await noOverflow(page, width)
  await notifications.getByRole('button', { name: 'Закрыть уведомления' }).click()

  await navigate(page, 'Услуги и документы')
  await page.getByRole('heading', { name: 'Услуги и документы', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Подать заявление' }).waitFor()
  await noOverflow(page, width)
  await submitAndRestore(page, account, password)
  await page.screenshot({ path: `work/acceptance-${account}-${width}.png`, fullPage: true })
  check(
    `${account}: real schedule, profile, grades, news, notifications and service screen at ${width}px`,
  )
}

try {
  for (const width of [1440, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } })
    context.setDefaultTimeout(15000)
    const page = await context.newPage()
    await inspectStudent(
      page,
      'demo-pz101',
      passwordA,
      'Иван Сергеевич Гончаров',
      'Прикладное зельеварение',
      'Введение в зельеварение',
      'Учебно-лабораторный корпус (УЛК) · Лаборатория № 3',
      '0 / 20',
      'Чт',
      width,
    )
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
    await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
    await inspectStudent(
      page,
      'demo-pm201',
      passwordB,
      'Амели Викторовна Волкова',
      'Прикладная мантика и прогностика',
      'Теория вероятностей и математическая статистика',
      'Главный учебный корпус (ГУК) · 201',
      '19 / 20',
      'Вт',
      width,
    )
    await context.close()
  }
} finally {
  await browser.close()
}
