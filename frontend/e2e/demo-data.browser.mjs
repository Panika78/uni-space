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

function field(scope, label) {
  return scope
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]')
}
async function readApi(page, path) {
  return page.evaluate(async (path) => {
    const { apiFetch } = await import('/src/shared/api/client.ts')
    return apiFetch(`/api/v1/${path}`, { authenticated: true })
  }, path)
}
async function compareApplication(page, created) {
  await page.getByRole('heading', { name: `Заявление № ${created.id}`, exact: true }).waitFor()
  const saved = await readApi(page, `applications/${created.id}`)
  assert.deepEqual(saved, created)
  for (const key of ['created_at', 'updated_at']) assert.ok(Number.isFinite(Date.parse(saved[key])))
  const scope = page.locator('.application-detail')
  assert.equal(await scope.locator('h2').innerText(), created.service.title)
  assert.equal(
    await field(scope, 'Место предоставления').innerText(),
    created.form_data.place_of_submission,
  )
  assert.equal(await field(scope, 'Рассмотрение').innerText(), 'Подано')
  assert.equal(await field(scope, 'Документ').innerText(), 'Ожидает подготовки')
  assert.equal(
    await field(scope, 'Дата подачи').locator('time').getAttribute('datetime'),
    created.created_at,
  )
}
async function inspectMoves(page, account) {
  const data = await readApi(page, 'schedule?date_from=2026-11-19&date_to=2026-11-23')
  const dates =
    account === 'demo-pz101'
      ? ['2026-11-19', '2026-11-20', '2026-11-23']
      : ['2026-11-19', '2026-11-21']
  const time = (value) =>
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  async function inspectCard(item) {
    const card = page.locator(`.schedule-day.is-selected [data-lesson-id="${item.id}"]`)
    await card.waitFor()
    assert.ok((await card.innerText()).includes(item.course_offering.discipline.name))
    assert.ok((await card.innerText()).includes(time(item.starts_at)))
    if (item.status === 'moved') assert.match(await card.innerText(), /Перенесено на/)
    else if (item.status === 'cancelled') assert.match(await card.innerText(), /Отменено/)
    else {
      assert.ok((await card.innerText()).includes(time(item.ends_at)))
      for (const room of item.rooms)
        assert.ok((await card.innerText()).includes(`${room.building.name} · ${room.name}`))
      if (item.teacher) assert.ok((await card.innerText()).includes(item.teacher.name))
    }
    return card
  }
  for (const date of dates) {
    await page.getByLabel('Дата', { exact: true }).fill(date)
    const items = data.items.filter((item) => item.starts_at.slice(0, 10) === date)
    for (const item of items) await inspectCard(item)
    const moved = items.find((item) => item.status === 'moved')
    if (moved) {
      const card = await inspectCard(moved)
      await card.getByRole('button', { name: /Перенесено на/ }).click()
      await page.waitForFunction(
        (date) => document.querySelector('input[type=date]').value === date,
        dates.at(-1),
      )
      const final = data.items.find((item) => item.id === moved.latest_lesson.id)
      const finalCard = await inspectCard(final)
      await page.waitForFunction(
        (id) => document.activeElement?.getAttribute('data-lesson-id') === id,
        final.id,
      )
      assert.ok(await finalCard.isVisible())
    }
  }
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
  await compareApplication(page, created)
  await page.reload()
  await compareApplication(page, created)
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
  await compareApplication(page, created)
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

  await inspectMoves(page, account)
  await navigate(page, 'Мой профиль')
  await page.getByRole('heading', { name: 'Мой профиль', exact: true }).waitFor()
  const profile = await readApi(page, 'users/me')
  const isPz = account === 'demo-pz101'
  assert.equal(profile.full_name, name)
  assert.equal(profile.faculty.name, 'Факультет естественных наук')
  assert.equal(profile.program.name, program)
  assert.equal(profile.program.code, isPz ? 'ПЗ' : 'ПМ')
  assert.equal(profile.group.name, isPz ? 'ПЗ-101' : 'ПМ-201')
  assert.equal(profile.course_number, isPz ? 1 : 2)
  assert.deepEqual(
    profile.direction,
    isPz
      ? { code: '04.03.01', name: 'Химия' }
      : { code: '01.03.02', name: 'Прикладная математика и информатика' },
  )
  const scope = page.locator('.profile-page')
  for (const [label, value] of Object.entries({
    ФИО: profile.full_name,
    Факультет: profile.faculty.name,
    Программа: `${profile.program.code} · ${profile.program.name}`,
    Направление: `${profile.direction.code} · ${profile.direction.name}`,
    Курс: String(profile.course_number),
    Группа: profile.group.name,
  }))
    assert.equal(await field(scope, label).innerText(), value)
  assert.equal(
    await scope
      .getByText(isPz ? 'Амели Викторовна Волкова' : 'Иван Сергеевич Гончаров', { exact: true })
      .count(),
    0,
  )
  await noOverflow(page, width)

  await navigate(page, 'Успеваемость')
  await page.getByRole('heading', { name: 'Успеваемость', exact: true }).waitFor()
  const academics = await readApi(page, 'academics')
  assert.ok(academics.items.length > 0)
  assert.equal(await page.locator('.academics-term').innerText(), academics.term.name)
  await page.getByRole('heading', { name: 'Сессия', exact: true }).waitFor()
  assert.equal(await page.locator('.academics-page h2').count(), 2)
  assert.equal(await page.locator('.academics-session tbody tr').count(), academics.items.length)
  for (const item of academics.items) {
    const row = page
      .locator('.academics-page section')
      .filter({ has: page.getByRole('heading', { name: 'Текущие дисциплины', exact: true }) })
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: item.discipline.name, exact: true }) })
    assert.equal(await row.locator('strong').innerText(), `${item.total_score} / ${item.max_score}`)
    assert.ok(
      (await row.innerText()).includes(
        `${item.graded_assessment_count} из ${item.assessment_count}`,
      ),
    )
    assert.equal(
      await row.locator('small').count(),
      item.assessment_count === 0 || item.graded_assessment_count === 0 ? 1 : 0,
    )
    if (item.assessment_count > 0 && item.graded_assessment_count === 0)
      assert.equal(await row.locator('small').innerText(), 'Не выставлено')
    assert.deepEqual(item.final_result, {
      grade_value: null,
      passed: null,
      has_debt: false,
      retake_date: null,
      retake_location: null,
    })
    const sessionRow = page
      .locator('.academics-session')
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: item.discipline.name, exact: true }) })
    assert.equal(
      await sessionRow.locator('td').first().innerText(),
      { exam: 'Экзамен', pass_fail: 'Зачёт', graded_pass: 'Дифференцированный зачёт' }[
        item.attestation_type
      ],
    )
    assert.equal(await sessionRow.locator('.academics-label').innerText(), 'Не выставлено')
  }
  if (isPz) {
    assert.ok(
      academics.items.some((item) => item.total_score === 0 && item.graded_assessment_count > 0),
    )
    assert.ok(
      academics.items.some(
        (item) => item.graded_assessment_count === 0 && item.assessment_count > 0,
      ),
    )
  } else assert.ok(academics.items.some((item) => item.total_score > 0))
  assert.equal(await page.locator('.academics-debt, .academics-retake').count(), 0)
  await page.getByText(grade, { exact: true }).first().waitFor()
  await noOverflow(page, width)

  await navigate(page, 'Новости')
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await page.getByText('Об изменении расписания занятий 19 ноября', { exact: false }).waitFor()
  const news = await readApi(page, 'news')
  const announcement = news.items.find((item) => item.title.includes('19 ноября'))
  const detail = await readApi(page, `news/${announcement.id}`)
  await page.locator('.news-row__link').filter({ hasText: announcement.title }).click()
  await page.getByRole('heading', { name: detail.title, exact: true }).waitFor()
  assert.equal(await page.locator('.news-article__body').innerText(), detail.body)
  assert.match(detail.body, /23 ноября/)
  assert.match(detail.body, /21 ноября/)
  await noOverflow(page, width)
  await page.getByRole('link', { name: /Назад к новостям/ }).click()
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()

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
