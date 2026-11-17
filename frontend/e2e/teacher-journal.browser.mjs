/* global process, console, window, document */
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
  assert.equal((await response).status(), 200)
  await page.waitForURL('**/teacher/journals')
  await page.getByRole('heading', { name: 'Мои журналы' }).waitFor()
}

async function selectJournal(page, course, group) {
  await page.locator(`details[data-course-id="${course}"] > summary`).click()
  const groupButton = page.locator(`button[data-course-id="${course}"][data-group-id="${group}"]`)
  await groupButton.waitFor()
  await groupButton.click()
}

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
  await login(page, env.TEACHER_JOURNAL_LOGIN_A)
  await selectJournal(page, env.TEACHER_JOURNAL_COURSE_A, env.TEACHER_JOURNAL_GROUP_A)
  const courseSummary = page.locator(
    `details[data-course-id="${env.TEACHER_JOURNAL_COURSE_A}"] > summary`,
  )
  const selectedGroupButton = page.locator(
    `button[data-course-id="${env.TEACHER_JOURNAL_COURSE_A}"][data-group-id="${env.TEACHER_JOURNAL_GROUP_A}"]`,
  )
  const navigationSizes = await Promise.all(
    [courseSummary, selectedGroupButton].map((locator) =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
          height: rect.height,
          width: rect.width,
          whiteSpace: window.getComputedStyle(element).whiteSpace,
          overflowWrap: window.getComputedStyle(element).overflowWrap,
        }
      }),
    ),
  )
  assert.ok(navigationSizes.every((item) => item.height >= 44 && item.width <= 360))
  assert.equal(navigationSizes[1].whiteSpace, 'normal')
  assert.equal(navigationSizes[1].overflowWrap, 'anywhere')
  assert.ok(navigationSizes[1].height > 44)
  await courseSummary.focus()
  await page.keyboard.press('Tab')
  assert.equal(
    await selectedGroupButton.evaluate((element) => element.matches(':focus-visible')),
    true,
  )
  assert.notEqual(
    await selectedGroupButton.evaluate((element) => window.getComputedStyle(element).outlineStyle),
    'none',
  )
  await page.getByLabel('Занятие').selectOption(env.TEACHER_JOURNAL_LESSON_A)
  await page.getByRole('button', { name: 'Присутствовал: Анна Иванова' }).waitFor()
  await page.getByLabel('Занятие').selectOption(env.TEACHER_JOURNAL_SUBGROUP_LESSON)
  await page.getByRole('button', { name: 'Присутствовал: Ёлкин Борис' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Присутствовал: Анна Иванова' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Присутствовал: Мария Петрова' }).count(), 0)
  await page.getByLabel('Занятие').selectOption(env.TEACHER_JOURNAL_LESSON_A)
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

  await page.getByRole('tab', { name: 'Работы и баллы' }).click()
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  const zero = page.getByRole('spinbutton', { name: 'Баллы: Ёлкин Борис' })
  await zero.waitFor()
  assert.equal(await zero.inputValue(), '0')
  const annaScore = page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' })
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
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).inputValue(),
    '0',
  )
  const annaScoreAfterZero = page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' })
  await annaScore.fill('11')
  await annaScoreAfterZero.blur()
  await page
    .locator('.journal-student')
    .filter({ hasText: 'Анна Иванова' })
    .getByRole('status')
    .filter({ hasText: 'Ошибка, повторить' })
    .waitFor()
  assert.equal(await annaScore.inputValue(), '11')
  await saveScore(
    page,
    annaScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    10,
  )
  await page.reload()
  await page.getByRole('tab', { name: 'Работы и баллы' }).click()
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).waitFor()
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).inputValue(),
    '10',
  )
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
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 2 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('2'),
  )
  await page.getByText('Есть долг').waitFor()
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 4 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('4'),
  )
  await page.getByText('Долга нет').waitFor()
  assert.ok(await page.getByText(/сумма баллов не преобразуется/).isVisible())
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 2 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('2'),
  )
  const retakeDate = page.getByLabel('Дата пересдачи: Анна Иванова')
  await retakeDate.fill('2027-01-10')
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { retake_date: '2027-01-10' },
    () => retakeDate.blur(),
  )
  const retakeLocation = page.getByLabel('Место пересдачи: Анна Иванова')
  await retakeLocation.fill('A-101')
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { retake_location: 'A-101' },
    () => retakeLocation.blur(),
  )
  const clearedFinal = await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 4 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('4'),
  )
  assert.equal(clearedFinal.retake_date, null)
  assert.equal(clearedFinal.retake_location, null)
  assert.equal(await retakeDate.inputValue(), '')
  assert.equal(await retakeLocation.inputValue(), '')
  await page.reload()
  await page.getByRole('tab', { name: 'Работы и баллы' }).click()
  await page.getByLabel('Итог: Анна Иванова').waitFor()
  assert.equal(await page.getByLabel('Дата пересдачи: Анна Иванова').inputValue(), '')
  assert.equal(await page.getByLabel('Место пересдачи: Анна Иванова').inputValue(), '')
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 2 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('2'),
  )
  assert.equal(await page.getByLabel('Дата пересдачи: Анна Иванова').inputValue(), '')
  assert.equal(await page.getByLabel('Место пересдачи: Анна Иванова').inputValue(), '')

  let rejectFinalOnce = true
  await page.route(
    `**/api/v1/final-results/courses/${env.TEACHER_JOURNAL_COURSE_A}/students/${env.TEACHER_JOURNAL_STUDENT_A}`,
    async (route) => {
      if (route.request().method() === 'PATCH' && rejectFinalOnce) {
        rejectFinalOnce = false
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      } else {
        await route.continue()
      }
    },
  )
  const failedFinalWrite = page.waitForRequest(
    (request) =>
      request
        .url()
        .endsWith(
          `/final-results/courses/${env.TEACHER_JOURNAL_COURSE_A}/students/${env.TEACHER_JOURNAL_STUDENT_A}`,
        ) && request.method() === 'PATCH',
  )
  await page.getByLabel('Итог: Анна Иванова').selectOption('4')
  await failedFinalWrite
  const annaFinalRow = page.locator('.journal-student--final').filter({ hasText: 'Анна Иванова' })
  await annaFinalRow.getByRole('button', { name: 'Повторить' }).waitFor()
  assert.equal(await page.getByLabel('Итог: Анна Иванова').inputValue(), '4')
  await page.getByRole('tab', { name: 'Посещаемость' }).click()
  await page.getByRole('tab', { name: 'Работы и баллы' }).click()
  assert.equal(await page.getByLabel('Итог: Анна Иванова').inputValue(), '4')
  const retryFinalResponse = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(
          `/final-results/courses/${env.TEACHER_JOURNAL_COURSE_A}/students/${env.TEACHER_JOURNAL_STUDENT_A}`,
        ) &&
      response.request().method() === 'PATCH' &&
      JSON.parse(response.request().postData() || '{}').grade_value === 4,
  )
  await page
    .locator('.journal-student--final')
    .filter({ hasText: 'Анна Иванова' })
    .getByRole('button', { name: 'Повторить' })
    .click()
  const retryResponse = await retryFinalResponse
  assert.equal(retryResponse.status(), 200)
  assert.equal((await retryResponse.json()).grade_value, 4)
  await page.unrouteAll()
  await page.reload()
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  assert.equal(await page.getByLabel('Итог: Анна Иванова').inputValue(), '4')
  assert.equal(await page.getByLabel('Дата пересдачи: Анна Иванова').inputValue(), '')
  assert.equal(await page.getByLabel('Место пересдачи: Анна Иванова').inputValue(), '')
  check('score bounds, Moscow dates, F05 retake clearing and F12 retained final retry')

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
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A2)
  const retryScore = page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' })
  await retryScore.fill('6')
  await retryScore.blur()
  const annaScoreRow = page.locator('.journal-student').filter({ hasText: 'Анна Иванова' })
  await annaScoreRow.getByRole('button', { name: 'Повторить' }).waitFor()
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A2)
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).inputValue(),
    '6',
  )
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
  await page
    .locator('.journal-student')
    .filter({ hasText: 'Анна Иванова' })
    .getByRole('button', { name: 'Повторить' })
    .click()
  assert.equal((await scoreRetryResponse).status(), 200)
  await page.unrouteAll()
  await page.reload()
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A2)
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).inputValue(),
    '6',
  )
  check('work A/B/A preserves score draft and retry across assessment navigation')

  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  const primaryScore = page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' })
  await saveScore(
    page,
    primaryScore,
    env.TEACHER_JOURNAL_ASSESSMENT_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    5,
  )
  const primaryScoreRow = page.locator('.journal-student').filter({ hasText: 'Анна Иванова' })
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
  const peerScore = peerPage.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' })
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
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  await primaryScore.waitFor()
  assert.equal(await primaryScore.inputValue(), '7')
  await primaryScore.focus()
  await primaryScore.blur()
  assert.equal(unchangedBlurWrites, 0)
  await page.reload()
  await page.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_A)
  await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).waitFor()
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Баллы: Анна Иванова' }).inputValue(),
    '7',
  )
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
  await page.goto(
    `${baseURL}/teacher/journals?course=${env.TEACHER_JOURNAL_COURSE_A}&group=${env.TEACHER_JOURNAL_GROUP_A}&tab=attendance&lesson=${env.TEACHER_JOURNAL_LESSON_A}`,
  )
  await page.getByText('Назначение отозвано или ссылка устарела.').waitFor()
  assert.equal(await page.getByText('Анна Иванова').count(), 0)
  check('assignment revocation removes access after reload')

  const secondContext = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const secondPage = await secondContext.newPage()
  await login(secondPage, env.TEACHER_JOURNAL_LOGIN_B)
  await selectJournal(secondPage, env.TEACHER_JOURNAL_COURSE_B, env.TEACHER_JOURNAL_GROUP_B)
  await secondPage.getByRole('tab', { name: 'Работы и баллы' }).click()
  await secondPage.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_B)
  const studentBFinal = secondPage.getByLabel(/Итог: Вымышленная студентка группы Б/)
  const studentBId = env.TEACHER_JOURNAL_FOREIGN_STUDENT
  await saveFinal(secondPage, env.TEACHER_JOURNAL_COURSE_B, studentBId, { passed: false }, () =>
    studentBFinal.selectOption('false'),
  )
  await secondPage.getByLabel(/Дата пересдачи: Вымышленная студентка группы Б/).fill('2027-02-02')
  const studentBRetakeDate = secondPage.getByLabel(/Дата пересдачи: Вымышленная студентка группы Б/)
  await saveFinal(
    secondPage,
    env.TEACHER_JOURNAL_COURSE_B,
    studentBId,
    { retake_date: '2027-02-02' },
    () => studentBRetakeDate.blur(),
  )
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
  assert.equal(await studentBRetakeDate.inputValue(), '')
  await secondPage.reload()
  await secondPage.getByLabel(/Итог: Вымышленная студентка группы Б/).waitFor()
  assert.equal(
    await secondPage.getByLabel(/Дата пересдачи: Вымышленная студентка группы Б/).inputValue(),
    '',
  )
  assert.ok(await secondPage.getByText('Итоги аттестации · Зачёт').isVisible())
  check('teacher B sees own assignment and manually records pass/fail result')

  await context.close()
  await secondContext.close()
} finally {
  await browser.close()
}
