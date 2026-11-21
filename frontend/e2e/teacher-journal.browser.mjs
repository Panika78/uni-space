/* global process, console, window, document, getComputedStyle */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.TEACHER_JOURNAL_TEST_URL || 'http://localhost:5173'
const env = process.env
const check = (message) => console.log(`PASS ${message}`)
const fixture = (mode) =>
  execFileSync(
    'uv',
    [
      'run',
      '--locked',
      '--python',
      env.PYTHON_TEST_VERSION || '3.12.16',
      '--project',
      'backend',
      'python',
      'frontend/e2e/teacher-journal-fixtures.py',
      mode,
    ],
    { env: { ...env, PYTHONPATH: 'backend' }, stdio: 'ignore' },
  )
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})

async function login(page, username) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(username)
  await page.getByLabel('Пароль').fill(env.TEACHER_JOURNAL_PASSWORD)
  const response = page.waitForResponse((item) => item.url().endsWith('/auth/login'))
  await page.getByRole('button', { name: 'Войти' }).click()
  const loginResponse = await response
  assert.equal(loginResponse.status(), 200)
  await page.waitForURL('**/teacher/journals')
  await page.getByRole('heading', { name: 'Мои журналы' }).waitFor()
  return (await loginResponse.json()).access_token
}

const journalButton = (page, discipline) =>
  page.getByRole('button', { name: new RegExp(`^${discipline} ${env.TEACHER_JOURNAL_SUFFIX} ·`) })
const journalTab = (page, name) =>
  page.getByRole('tablist', { name: 'Разделы журнала', exact: true }).getByRole('tab', { name })
const scoreInput = (page, student, work = 'Контрольная работа') =>
  page.getByRole('spinbutton', { name: `Баллы: ${student} · ${work}`, exact: true })
const scoreCell = (input) => input.locator('..')
const retakeButton = (page, student) =>
  page.getByRole('button', { name: new RegExp(`пересдачу: ${student}`) })
const retakeDialog = (page) => page.getByRole('dialog', { name: /^Пересдача ·/ })

async function saveScore(page, input, assessmentId, studentId, score) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    if (
      !response.url().includes(`/assessments/${assessmentId}/results/${studentId}`) ||
      request.method() !== 'PUT'
    )
      return false
    return JSON.parse(request.postData() || '{}').score === score
  })
  await input.fill(score === null ? '' : String(score))
  await input.blur()
  const response = await responsePromise
  assert.equal(response.status(), 200)
  assert.equal((await response.json()).score, score)
}

async function saveFinal(page, courseId, studentId, patch, action) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    return (
      response.url().endsWith(`/final-results/courses/${courseId}/students/${studentId}`) &&
      request.method() === 'PATCH' &&
      JSON.stringify(JSON.parse(request.postData() || '{}')) === JSON.stringify(patch)
    )
  })
  await action()
  const response = await responsePromise
  assert.equal(response.status(), 200)
  return response.json()
}

async function saveAssessmentDate(page, courseId, assessmentId, groupId, date, lessonId, action) {
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request()
    if (
      !response.url().endsWith(`/teaching/courses/${courseId}/assessments/${assessmentId}/dates`) ||
      request.method() !== 'PATCH'
    )
      return false
    return JSON.parse(request.postData() || '{}').items?.[0]?.assessment_group_id === groupId
  })
  await action()
  const response = await responsePromise
  assert.equal(response.status(), 200)
  const body = await response.json()
  const item = body.items.find((entry) => entry.assessment_group_id === groupId)
  assert.equal(item.planned_date, date)
  assert.equal(item.lesson_id, lessonId)
  assert.equal(item.date_needs_confirmation, false)
  return item
}

async function waitForAttendance(page, status, name) {
  await page.waitForFunction(
    ([label, student]) =>
      document
        .querySelector(`[aria-label="${label}: ${student}"]`)
        ?.getAttribute('aria-pressed') === 'true',
    [status, name],
  )
}

try {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const page = await context.newPage()
  const teacherToken = await login(page, env.TEACHER_JOURNAL_LOGIN_A)
  const algebraJournal = journalButton(page, 'Алгебра')
  await algebraJournal.waitFor()
  const navigationSize = await algebraJournal.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return { height: rect.height, width: rect.width, whiteSpace: style.whiteSpace }
  })
  assert.ok(navigationSize.height > 44 && navigationSize.width <= 360)
  assert.equal(navigationSize.whiteSpace, 'normal')
  await page
    .getByRole('search', { name: 'Поиск дисциплины, группы или семестра' })
    .getByRole('button', { name: 'Найти' })
    .focus()
  await page.keyboard.press('Tab')
  assert.equal(await algebraJournal.evaluate((element) => element.matches(':focus-visible')), true)
  assert.notEqual(
    await algebraJournal.evaluate((element) => getComputedStyle(element).outlineStyle),
    'none',
  )
  await page.keyboard.press('Enter')
  await page.waitForURL((url) => url.searchParams.get('course') === env.TEACHER_JOURNAL_COURSE_A)
  await algebraJournal.and(page.getByRole('button', { pressed: true })).waitFor()

  const calendar = page.getByRole('region', { name: 'Календарь занятий' })
  const lessonDate = new Date(`${env.TEACHER_JOURNAL_DATE}T12:00:00Z`)
  const dateLabel = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(lessonDate)
  const calendarDay = calendar.getByRole('button', {
    name: `${lessonDate.getUTCDate()} ${dateLabel}, занятий: 2`,
  })
  await calendar
    .getByRole('button', { name: /занятий: / })
    .first()
    .waitFor()
  if ((await calendarDay.count()) === 0) {
    await calendar.getByRole('button', { name: 'Предыдущий месяц' }).click()
  }
  await calendarDay.click()
  const lessons = page.getByRole('group', { name: 'Выбор занятия' }).getByRole('button')
  await lessons.nth(1).click()
  await page.getByRole('button', { name: 'Присутствовал: Анна Иванова' }).waitFor()
  await lessons.nth(0).click()
  await page.getByRole('button', { name: 'Присутствовал: Ёлкин Борис' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Присутствовал: Анна Иванова' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Присутствовал: Мария Петрова' }).count(), 0)
  await lessons.nth(1).click()
  assert.equal(
    await page
      .getByRole('button', { name: 'Присутствовал: Анна Иванова' })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Отсутствовал: Ёлкин Борис' })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Нет отметки: Мария Петрова' })
      .getAttribute('aria-pressed'),
    'true',
  )
  await page.getByRole('button', { name: 'Присутствовал: Мария Петрова' }).click()
  await waitForAttendance(page, 'Присутствовал', 'Мария Петрова')
  await waitForAttendance(page, 'Присутствовал', 'Мария Петрова')
  await page.getByRole('button', { name: 'Нет отметки: Мария Петрова' }).click()
  await waitForAttendance(page, 'Нет отметки', 'Мария Петрова')
  assert.equal(
    await page
      .getByRole('button', { name: 'Нет отметки: Мария Петрова' })
      .getAttribute('aria-pressed'),
    'true',
  )
  await page.getByRole('button', { name: 'Присутствовал: Мария Петрова' }).click()
  await waitForAttendance(page, 'Присутствовал', 'Мария Петрова')
  await page.reload()
  assert.equal(
    await page
      .getByRole('button', { name: 'Присутствовал: Мария Петрова' })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.setViewportSize({ width: 1440, height: 900 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  check('teacher A attendance read after reload, all statuses, individual write, 360/1440 layout')

  await journalTab(page, 'Работы и баллы').click()
  const zero = scoreInput(page, 'Ёлкин Борис')
  await zero.waitFor()
  assert.equal(await zero.inputValue(), '0')
  const annaScore = scoreInput(page, 'Анна Иванова')
  assert.equal(await annaScore.inputValue(), '')
  await saveScore(
    page,
    annaScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    10,
  )
  await saveScore(
    page,
    annaScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    null,
  )
  await saveScore(
    page,
    annaScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    0,
  )
  await page.reload()
  assert.equal(await scoreInput(page, 'Анна Иванова').inputValue(), '0')
  const annaScoreAfterZero = scoreInput(page, 'Анна Иванова')
  await annaScore.fill('11')
  await annaScoreAfterZero.blur()
  await scoreCell(annaScore).getByRole('status').filter({ hasText: 'Ошибка, повторить' }).waitFor()
  assert.equal(await annaScore.inputValue(), '11')
  await saveScore(
    page,
    annaScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    10,
  )
  await page.reload()
  await journalTab(page, 'Работы и баллы').click()
  await scoreInput(page, 'Анна Иванова').waitFor()
  assert.equal(await scoreInput(page, 'Анна Иванова').inputValue(), '10')
  await page.getByText('Планирование и связь работ с занятиями', { exact: true }).click()
  await page.getByLabel('Работа', { exact: true }).selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  await page.getByLabel('Дата', { exact: true }).fill(env.TEACHER_JOURNAL_DATE)
  await saveAssessmentDate(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_DATE,
    null,
    () => page.getByRole('button', { name: 'Сохранить дату и связь' }).click(),
  )
  await page.getByLabel('Связать с занятием').selectOption(env.TEACHER_JOURNAL_LESSON_A)
  await saveAssessmentDate(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_DATE,
    env.TEACHER_JOURNAL_LESSON_A,
    () => page.getByRole('button', { name: 'Сохранить дату и связь' }).click(),
  )
  await journalTab(page, 'Итоги аттестации').click()
  const anna = 'Анна Иванова'
  const course = env.TEACHER_JOURNAL_COURSE_A
  const student = env.TEACHER_JOURNAL_STUDENT_A
  const grade = page.getByLabel(`Итог: ${anna}`)
  const retake = retakeButton(page, anna)
  const finalRow = page.getByRole('row').filter({ has: grade })
  const finalEndpoint = `**/api/v1/final-results/courses/${course}/students/${student}`
  await saveFinal(page, course, student, { grade_value: 4 }, () => grade.selectOption('4'))
  assert.equal(await retake.count(), 0)

  await page.route(
    finalEndpoint,
    (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    { times: 1 },
  )
  await grade.selectOption('2')
  const retryGrade = finalRow.getByRole('button', { name: 'Повторить' })
  await retryGrade.waitFor()
  assert.equal(await retake.count(), 0)
  assert.equal(await grade.inputValue(), '2')
  await journalTab(page, 'Посещаемость').click()
  await journalTab(page, 'Итоги аттестации').click()
  assert.equal(await grade.inputValue(), '2')
  await saveFinal(page, course, student, { grade_value: 2 }, () => retryGrade.click())

  await retake.click()
  const dialog = retakeDialog(page)
  const retakeDate = dialog.getByLabel('Дата пересдачи')
  const retakeLocation = dialog.getByLabel('Место пересдачи')
  const saveRetake = () => dialog.getByRole('button', { name: 'Сохранить', exact: true }).click()
  const closeRetake = () => dialog.getByRole('button', { name: 'Отмена', exact: true }).click()
  await retakeDate.fill('2027-01-10')
  await retakeLocation.fill('A-101')
  await saveFinal(
    page,
    course,
    student,
    { retake_date: '2027-01-10', retake_location: 'A-101' },
    saveRetake,
  )
  fixture('verify-retake')
  await page.reload()
  await retake.click()
  assert.equal(await retakeDate.inputValue(), '2027-01-10')
  assert.equal(await retakeLocation.inputValue(), 'A-101')

  const concurrentPage = await context.newPage()
  await concurrentPage.goto(
    `${baseURL}/teacher/journals?course=${course}&group=${env.TEACHER_JOURNAL_GROUP_A}&tab=finals`,
  )
  await page.route(finalEndpoint, async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH' || request.postDataJSON().retake_date !== '2027-01-12') {
      return route.continue()
    }
    const concurrentUpdate = await saveFinal(
      concurrentPage,
      course,
      student,
      { grade_value: 4 },
      () => concurrentPage.getByLabel(`Итог: ${anna}`).selectOption('4'),
    )
    await route.fulfill({ status: 200, json: concurrentUpdate })
  })
  await retakeDate.fill('2027-01-12')
  await saveRetake()
  await page.getByText(/Сервер сохранил другое значение/).waitFor()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await grade.inputValue(), '4')
  assert.equal(await retake.count(), 0)
  await page.unroute(finalEndpoint)
  await concurrentPage.close()
  await page.reload()
  await grade.waitFor()
  assert.equal(await grade.inputValue(), '4')
  assert.equal(await retake.count(), 0)
  await saveFinal(page, course, student, { grade_value: 2 }, () => grade.selectOption('2'))
  await retake.click()
  assert.equal(await retakeDate.inputValue(), '')
  assert.equal(await retakeLocation.inputValue(), '')
  await closeRetake()
  assert.ok(await page.getByText(/не вычисляется автоматически из баллов/).isVisible())
  check('final result retry, confirmed debt, persisted retake and concurrent debt clearing')

  await journalTab(page, 'Работы и баллы').click()
  let rejectScoreOnce = true
  await page.route(
    `**/api/v1/teaching/courses/${env.TEACHER_JOURNAL_COURSE_A}/groups/${env.TEACHER_JOURNAL_GROUP_A}/assessments/${env.TEACHER_JOURNAL_ASSESSMENT_A2}/results/${env.TEACHER_JOURNAL_STUDENT_A}`,
    async (route) => {
      if (route.request().method() === 'PUT' && rejectScoreOnce) {
        rejectScoreOnce = false
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      } else {
        await route.continue()
      }
    },
  )
  const retryScore = scoreInput(page, 'Анна Иванова', 'Повторная контрольная')
  await retryScore.fill('6')
  await retryScore.blur()
  const annaScoreCell = scoreCell(retryScore)
  await annaScoreCell.getByRole('button', { name: 'Повторить' }).waitFor()
  await journalTab(page, 'Посещаемость').click()
  await journalTab(page, 'Работы и баллы').click()
  assert.equal(await retryScore.inputValue(), '6')
  const scoreRetryResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes(
          `/assessments/${env.TEACHER_JOURNAL_ASSESSMENT_A2}/results/${env.TEACHER_JOURNAL_STUDENT_A}`,
        ) &&
      response.request().method() === 'PUT' &&
      JSON.parse(response.request().postData() || '{}').score === 6,
  )
  await annaScoreCell.getByRole('button', { name: 'Повторить' }).click()
  assert.equal((await scoreRetryResponse).status(), 200)
  await page.unrouteAll()
  await page.reload()
  assert.equal(await retryScore.inputValue(), '6')
  check('score draft survives tab navigation and can be retried')

  const primaryScore = scoreInput(page, 'Анна Иванова')
  await saveScore(
    page,
    primaryScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    5,
  )
  const primaryScoreRow = scoreCell(primaryScore)
  await primaryScoreRow.getByRole('status').filter({ hasText: 'Сохранено' }).waitFor()
  let unchangedBlurWrites = 0
  await page.route(
    `**/api/v1/teaching/courses/${env.TEACHER_JOURNAL_COURSE_A}/groups/${env.TEACHER_JOURNAL_GROUP_A}/assessments/${env.TEACHER_JOURNAL_ASSESSMENT_A}/results/${env.TEACHER_JOURNAL_STUDENT_A}`,
    async (route) => {
      if (route.request().method() === 'PUT') unchangedBlurWrites++
      await route.continue()
    },
  )
  await primaryScore.focus()
  await primaryScore.blur()
  assert.equal(unchangedBlurWrites, 0)
  await primaryScoreRow.getByRole('status').filter({ hasText: 'Сохранено' }).waitFor()

  const peerPage = await context.newPage()
  await peerPage.goto(
    `${baseURL}/teacher/journals?course=${env.TEACHER_JOURNAL_COURSE_A}&group=${env.TEACHER_JOURNAL_GROUP_A}&tab=work&assessment=${env.TEACHER_JOURNAL_ASSESSMENT_A}`,
  )
  const peerScore = scoreInput(peerPage, 'Анна Иванова')
  await peerScore.waitFor()
  assert.equal(await peerScore.inputValue(), '5')
  await saveScore(
    peerPage,
    peerScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    7,
  )

  await page.reload()
  await primaryScore.waitFor()
  assert.equal(await primaryScore.inputValue(), '7')
  await primaryScore.focus()
  await primaryScore.blur()
  assert.equal(unchangedBlurWrites, 0)
  await page.reload()
  await scoreInput(page, 'Анна Иванова').waitFor()
  assert.equal(await scoreInput(page, 'Анна Иванова').inputValue(), '7')
  await peerPage.close()
  await page.unrouteAll()
  check('two tabs preserve the latest server score; unchanged focus/blur emits no PUT')

  // A lost HTTP response must reconcile with server state instead of replaying the write.
  let writes = 0
  await page.route(
    `**/api/v1/attendance/lessons/${env.TEACHER_JOURNAL_LESSON_A}/students/${env.TEACHER_JOURNAL_STUDENT_C}`,
    async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      writes++
      await route.fetch()
      await route.abort('failed')
    },
  )
  await page.goto(
    `${baseURL}/teacher/journals?course=${env.TEACHER_JOURNAL_COURSE_A}&group=${env.TEACHER_JOURNAL_GROUP_A}&tab=attendance&lesson=${env.TEACHER_JOURNAL_LESSON_A}`,
  )
  await page.getByRole('button', { name: 'Присутствовал: Мария Петрова' }).waitFor()
  await page.getByRole('button', { name: 'Отсутствовал: Мария Петрова' }).click()
  await waitForAttendance(page, 'Отсутствовал', 'Мария Петрова')
  assert.equal(
    await page
      .getByRole('button', { name: 'Отсутствовал: Мария Петрова' })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(writes, 1)
  await page.unrouteAll()
  check('lost write response reconciled by authoritative GET without duplicate mutation')

  const announcementPanel = page.locator('.journal-announcements')
  const announcementsTab = journalTab(page, 'Объявления')
  const publishButton = announcementPanel.getByRole('button', { name: 'Опубликовать' })
  const titleField = announcementPanel.getByLabel('Заголовок')
  const bodyField = announcementPanel.getByLabel('Текст объявления')
  await announcementsTab.focus()
  await page.keyboard.press('Enter')
  await announcementPanel.getByText('Объявлений пока нет').waitFor()
  assert.equal(
    await announcementPanel.getByRole('option', { name: 'Все группы проведения' }).isEnabled(),
    true,
  )
  const title = 'Практическая работа 🦉'
  const body = 'Первая строка\n<img src=x onerror=alert(1)> **текст**'
  await announcementPanel.getByLabel('Аудитория').selectOption('all')
  await titleField.fill(title)
  await bodyField.fill(body)
  await announcementPanel.getByLabel('Важное').check()
  const announcementResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/announcements') && response.request().method() === 'POST',
  )
  await publishButton.click()
  const savedAnnouncement = await announcementResponse
  assert.equal(savedAnnouncement.status(), 201)
  assert.equal((await savedAnnouncement.json()).group_id, null)
  await announcementPanel.getByText('Объявление опубликовано.').waitFor()
  const announcementEntry = announcementPanel
    .locator('.announcement-feed summary')
    .filter({ hasText: title })
  await announcementEntry.focus()
  await page.keyboard.press('Enter')
  await announcementPanel.locator('.announcement-body').waitFor()
  assert.equal(await announcementPanel.locator('.announcement-body').textContent(), body)
  assert.equal(await announcementPanel.locator('.announcement-feed img').count(), 0)
  assert.equal(await announcementEntry.getByText('Важное').count(), 1)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  await announcementEntry.waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))

  const lostResponseTitle = 'Ответ потерян после сохранения'
  await titleField.fill(lostResponseTitle)
  await bodyField.fill('Введённый текст сохраняется при сбое')
  const announcementPost = '**/teaching/courses/*/announcements'
  const retryPublication = announcementPanel.getByRole('button', { name: 'Повторить публикацию' })
  const unknownResult = announcementPanel.getByText(
    'Результат публикации неизвестен. Повторите публикацию.',
  )
  const keys = []
  await page.route(
    announcementPost,
    async (route) => {
      keys.push(route.request().headers()['idempotency-key'])
      const response = await route.fetch()
      assert.equal(response.status(), 201)
      await route.abort('failed')
    },
    { times: 1 },
  )
  await publishButton.click()
  await unknownResult.waitFor()
  assert.equal(await titleField.inputValue(), lostResponseTitle)
  assert.equal(await bodyField.inputValue(), 'Введённый текст сохраняется при сбое')
  assert.equal(await publishButton.isDisabled(), true)
  const replayRequest = page.waitForRequest(
    (request) => request.url().endsWith('/announcements') && request.method() === 'POST',
  )
  await retryPublication.click()
  assert.equal((await replayRequest).headers()['idempotency-key'], keys[0])
  await announcementPanel.getByText('Объявление опубликовано.').waitFor()
  const lostEntries = announcementPanel
    .locator('.announcement-feed summary')
    .filter({ hasText: lostResponseTitle })
  await lostEntries.waitFor()
  assert.equal(await lostEntries.count(), 1)

  const unreachableTitle = 'Первая отправка не дошла'
  await titleField.fill(unreachableTitle)
  await bodyField.fill('Не теряем черновик')
  let blockedRoute
  let blockedKey
  await page.route(
    announcementPost,
    (route) => {
      blockedRoute = route
      blockedKey = route.request().headers()['idempotency-key']
      // Leave the POST pending until its own request deadline releases the form.
    },
    { times: 1 },
  )
  await publishButton.click()
  await unknownResult.waitFor({ timeout: 20_000 })
  assert.ok(blockedKey)
  await blockedRoute.abort().catch(() => {})
  assert.equal(await titleField.inputValue(), unreachableTitle)
  assert.equal(await bodyField.inputValue(), 'Не теряем черновик')
  assert.equal(
    await announcementPanel
      .locator('.announcement-feed summary')
      .filter({ hasText: unreachableTitle })
      .count(),
    0,
  )

  const otherTab = await page.context().newPage()
  const identical = await otherTab.request.post(
    `${baseURL}/api/v1/teaching/courses/${env.TEACHER_JOURNAL_COURSE_A}/announcements`,
    {
      headers: { Authorization: `Bearer ${teacherToken}` },
      data: {
        group_id: env.TEACHER_JOURNAL_GROUP_A,
        title: unreachableTitle,
        body: 'Не теряем черновик',
      },
    },
  )
  assert.equal(identical.status(), 201)
  await otherTab.close()
  await page.route(announcementPost, (route) => route.abort('failed'), { times: 1 })
  await retryPublication.click()
  await unknownResult.waitFor()
  const recovered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/announcements') && response.request().method() === 'POST',
  )
  await retryPublication.click()
  const recovery = await recovered
  assert.equal(recovery.request().headers()['idempotency-key'], blockedKey)
  assert.equal(recovery.status(), 201)
  assert.notEqual((await recovery.json()).id, (await identical.json()).id)
  await announcementPanel.getByText('Объявление опубликовано.').waitFor()
  check(
    'announcement retries recover committed, undelivered and timed-out requests by operation key',
  )

  await page.route('**/groups/*/announcements', (route) => route.abort('failed'))
  await page.reload()
  await announcementPanel.getByText('Не удалось загрузить объявления').waitFor()
  await page.unroute('**/groups/*/announcements')
  await announcementPanel.getByRole('button', { name: 'Повторить' }).click()
  await announcementEntry.waitFor()
  await page.setViewportSize({ width: 360, height: 800 })
  check('announcement list retries after a transport failure')

  const courseAnnouncementUrl = `${baseURL}/api/v1/teaching/courses/${env.TEACHER_JOURNAL_COURSE_A}/announcements`
  const groupAnnouncementUrl = courseAnnouncementUrl.replace(
    /\/announcements$/,
    `/groups/${env.TEACHER_JOURNAL_GROUP_A}/announcements`,
  )
  const teacherHeaders = { Authorization: `Bearer ${teacherToken}` }
  for (let index = 0; index < 17; index += 1) {
    const response = await page.request.post(courseAnnouncementUrl, {
      headers: teacherHeaders,
      data: {
        group_id: env.TEACHER_JOURNAL_GROUP_A,
        title: `Объявление ${index + 1}`,
        body: 'ДлинныйТекст'.repeat(40),
        is_important: index === 0,
      },
    })
    assert.equal(response.status(), 201)
  }
  await page.reload()
  await announcementPanel.getByRole('button', { name: 'Показать ещё' }).click()
  await announcementEntry.waitFor()
  assert.equal(await announcementPanel.locator('.announcement-feed li').count(), 21)
  assert.equal(await announcementPanel.getByRole('button', { name: 'Показать ещё' }).count(), 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  check('announcement list loads a second real page without duplicates')

  fixture('prepare-announcement-transfer')
  const studentContext = await browser.newContext()
  const studentPage = await studentContext.newPage()
  await studentPage.goto(`${baseURL}/login`)
  await studentPage.getByLabel('Логин').fill(env.TEACHER_JOURNAL_STUDENT_LOGIN)
  await studentPage.getByLabel('Пароль').fill(env.TEACHER_JOURNAL_PASSWORD)
  const loginResponsePromise = studentPage.waitForResponse((response) =>
    response.url().endsWith('/auth/login'),
  )
  await studentPage.getByRole('button', { name: 'Войти' }).click()
  const loginResponse = await loginResponsePromise
  assert.equal(loginResponse.status(), 200)
  const studentToken = (await loginResponse.json()).access_token
  await studentPage.waitForURL('**/schedule')
  await studentPage.getByRole('button', { name: 'Уведомления', exact: true }).waitFor()
  const openNotifications = async () => {
    await studentPage.getByRole('button', { name: 'Уведомления', exact: true }).click()
    const drawer = studentPage.getByRole('dialog', { name: 'Уведомления', exact: true })
    await drawer.waitFor()
    await drawer.evaluate(async (panel) => {
      await Promise.all(panel.getAnimations().map((animation) => animation.finished))
    })
    return drawer
  }
  let drawer = await openNotifications()
  const resultNotification = drawer
    .locator('article.notification-item')
    .filter({ hasText: 'Изменился результат контрольной или экзамена' })
    .first()
  await resultNotification.waitFor()
  await resultNotification.getByRole('button', { name: 'Открыть объект' }).click()
  await studentPage.waitForURL(`**/academics/courses/${env.TEACHER_JOURNAL_COURSE_A}`)
  await studentPage.goto(`${baseURL}/schedule`)
  drawer = await openNotifications()
  const importantNotification = drawer
    .locator('article.notification-item')
    .filter({ hasText: 'Новое важное объявление по дисциплине' })
    .first()
  await importantNotification.waitFor()
  await importantNotification.getByRole('button', { name: 'Открыть объект' }).click()
  await studentPage.waitForURL(`**/academics/courses/${env.TEACHER_JOURNAL_COURSE_A}`)
  await studentPage.addInitScript((token) => {
    if (window.location.pathname === '/e2e/announcement-feed.html') {
      window.sessionStorage.setItem('announcement-fixture-bearer', token)
    }
  }, studentToken)
  await studentPage.goto(
    `${baseURL}/e2e/announcement-feed.html?course=${env.TEACHER_JOURNAL_COURSE_A}`,
  )
  await studentPage.getByText(lostResponseTitle, { exact: true }).waitFor()
  await studentPage.getByRole('button', { name: 'Показать ещё' }).click()
  await studentPage.getByText(title, { exact: true }).waitFor()
  fixture('transfer-announcement-student')
  await studentPage.goto(`${baseURL}/schedule`)
  drawer = await openNotifications()
  assert.equal(
    await drawer.getByText('Новое важное объявление по дисциплине', { exact: true }).count(),
    0,
  )
  assert.ok(await drawer.getByText('Обновление', { exact: true }).count())
  assert.equal(await drawer.getByRole('button', { name: 'Открыть объект' }).count(), 0)
  await studentPage.keyboard.press('Escape')
  await studentPage.goto(
    `${baseURL}/e2e/announcement-feed.html?course=${env.TEACHER_JOURNAL_COURSE_A}`,
  )
  await studentPage.getByText(lostResponseTitle, { exact: true }).waitFor({ state: 'hidden' })
  await studentPage.getByRole('button', { name: 'Обновить ленту' }).click()
  await studentPage.getByText(lostResponseTitle, { exact: true }).waitFor({ state: 'hidden' })
  await studentPage.getByText(title, { exact: true }).waitFor()
  assert.equal(await studentPage.locator('.announcement-feed li').count(), 1)
  await studentContext.close()
  check('student feed discards addresses from the old group after a real PostgreSQL transfer')

  // A teacher cannot use a copied URL to load another teacher's group.
  await page.goto(
    `${baseURL}/teacher/journals?course=${env.TEACHER_JOURNAL_COURSE_B}&group=${env.TEACHER_JOURNAL_GROUP_B}&tab=attendance&lesson=${env.TEACHER_JOURNAL_LESSON_B}`,
  )
  await page.getByText('Назначение отозвано или ссылка устарела.').waitFor()
  assert.equal(
    await page
      .getByText(new RegExp(`Вымышленная студентка группы Б ${env.TEACHER_JOURNAL_SUFFIX}`))
      .count(),
    0,
  )
  check('teacher A cannot use direct URL to read teacher B group')

  fixture('revoke')
  assert.equal(
    (await page.request.get(groupAnnouncementUrl, { headers: teacherHeaders })).status(),
    404,
  )
  await page.goto(
    `${baseURL}/teacher/journals?course=${env.TEACHER_JOURNAL_COURSE_A}&group=${env.TEACHER_JOURNAL_GROUP_A}&tab=attendance&lesson=${env.TEACHER_JOURNAL_LESSON_A}`,
  )
  await page.getByText('Назначение отозвано или ссылка устарела.').waitFor()
  assert.equal(await page.getByText('Анна Иванова').count(), 0)
  assert.equal(await page.locator('.journal-announcements').count(), 0)
  check('assignment revocation removes access after reload')

  const secondContext = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const secondPage = await secondContext.newPage()
  await login(secondPage, env.TEACHER_JOURNAL_LOGIN_B)
  await journalButton(secondPage, 'История').click()
  await journalTab(secondPage, 'Итоги аттестации').click()
  const studentBName = 'Вымышленная студентка группы Б'
  const studentBFinal = secondPage.getByLabel(new RegExp(`Итог: ${studentBName}`))
  const studentBId = env.TEACHER_JOURNAL_FOREIGN_STUDENT
  const studentBRetake = retakeButton(secondPage, studentBName)
  await studentBFinal.waitFor()
  assert.equal(await studentBRetake.count(), 0)
  await saveFinal(secondPage, env.TEACHER_JOURNAL_COURSE_B, studentBId, { passed: false }, () =>
    studentBFinal.selectOption('false'),
  )
  await studentBRetake.click()
  const studentBDialog = retakeDialog(secondPage)
  const studentBDate = studentBDialog.getByLabel('Дата пересдачи')
  await studentBDate.fill('2027-02-02')
  await saveFinal(
    secondPage,
    env.TEACHER_JOURNAL_COURSE_B,
    studentBId,
    { retake_date: '2027-02-02', retake_location: null },
    () => studentBDialog.getByRole('button', { name: 'Сохранить', exact: true }).click(),
  )
  await secondPage.getByRole('button', { name: 'Отмена', exact: true }).click()
  const passed = await saveFinal(
    secondPage,
    env.TEACHER_JOURNAL_COURSE_B,
    studentBId,
    { passed: true },
    () => studentBFinal.selectOption('true'),
  )
  assert.equal(passed.retake_date, null)
  await saveFinal(secondPage, env.TEACHER_JOURNAL_COURSE_B, studentBId, { passed: false }, () =>
    studentBFinal.selectOption('false'),
  )
  await secondPage.reload()
  await studentBRetake.click()
  assert.equal(await studentBDate.inputValue(), '')
  check('teacher B sees own assignment and manually records pass/fail result')

  await context.close()
  await secondContext.close()
} finally {
  await browser.close()
}
