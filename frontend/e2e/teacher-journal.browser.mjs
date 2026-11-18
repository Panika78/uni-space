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
  const loginResponse = await response
  assert.equal(loginResponse.status(), 200)
  await page.waitForURL('**/teacher/journals')
  await page.getByRole('heading', { name: 'Мои журналы' }).waitFor()
  return (await loginResponse.json()).access_token
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
  const teacherToken = await login(page, env.TEACHER_JOURNAL_LOGIN_A)
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
    { grade_value: 4 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('4'),
  )
  const gradeControl = page.getByLabel('Итог: Анна Иванова')
  const dateControl = page.getByLabel('Дата пересдачи: Анна Иванова')
  const locationControl = page.getByLabel('Место пересдачи: Анна Иванова')
  assert.equal(await gradeControl.inputValue(), '4')
  let rejectDebtOnce = true
  const finalEndpoint = `**/api/v1/final-results/courses/${env.TEACHER_JOURNAL_COURSE_A}/students/${env.TEACHER_JOURNAL_STUDENT_A}`
  await page.route(finalEndpoint, async (route) => {
    const payload = JSON.parse(route.request().postData() || '{}')
    if (route.request().method() === 'PATCH' && payload.grade_value === 2 && rejectDebtOnce) {
      rejectDebtOnce = false
      await new Promise((resolve) => globalThis.setTimeout(resolve, 400))
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    } else {
      await route.continue()
    }
  })
  const failedDebtResponse = page.waitForResponse(
    (response) => response.status() === 503 && response.url().includes('/final-results/courses/'),
  )
  const debtRequest = page.waitForRequest(
    (request) =>
      request.method() === 'PATCH' && JSON.parse(request.postData() || '{}').grade_value === 2,
  )
  await gradeControl.selectOption('2')
  await debtRequest
  assert.equal(await dateControl.isDisabled(), true)
  assert.equal(await locationControl.isDisabled(), true)
  await failedDebtResponse
  const finalRow = page.locator('.journal-student--final').filter({ hasText: 'Анна Иванова' })
  await finalRow.getByRole('button', { name: 'Повторить' }).waitFor()
  assert.equal(await gradeControl.inputValue(), '2')
  assert.equal(await dateControl.isDisabled(), true)
  assert.equal(await locationControl.isDisabled(), true)
  await finalRow.getByText('Сервер не подтвердил это изменение').waitFor()
  const successfulDebtResponse = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      response.request().method() === 'PATCH' &&
      JSON.parse(response.request().postData() || '{}').grade_value === 2,
  )
  await finalRow.getByRole('button', { name: 'Повторить' }).click()
  const successfulDebt = await successfulDebtResponse
  assert.equal((await successfulDebt.json()).grade_value, 2)
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Дата пересдачи: Анна Иванова"]')?.disabled,
  )
  await page.unroute(finalEndpoint)
  await page.getByText('Есть долг').waitFor()
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
  const concurrentPage = await context.newPage()
  await concurrentPage.goto(`${baseURL}/teacher/journals`)
  await concurrentPage.getByRole('heading', { name: 'Мои журналы' }).waitFor()
  await selectJournal(concurrentPage, env.TEACHER_JOURNAL_COURSE_A, env.TEACHER_JOURNAL_GROUP_A)
  await concurrentPage.getByRole('tab', { name: 'Работы и баллы' }).click()
  await concurrentPage.getByLabel('Итог: Анна Иванова').waitFor()
  await page.route(finalEndpoint, async (route) => {
    const patch = JSON.parse(route.request().postData() || '{}')
    if (route.request().method() === 'PATCH' && patch.retake_date === '2027-01-12') {
      const concurrentUpdate = await saveFinal(
        concurrentPage,
        env.TEACHER_JOURNAL_COURSE_A,
        env.TEACHER_JOURNAL_STUDENT_A,
        { grade_value: 4 },
        () => concurrentPage.getByLabel('Итог: Анна Иванова').selectOption('4'),
      )
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(concurrentUpdate),
      })
    } else {
      await route.continue()
    }
  })
  await retakeDate.fill('2027-01-12')
  await retakeDate.blur()
  await page.getByText(/Сервер сохранил другое значение/).waitFor()
  assert.equal(await retakeDate.inputValue(), '2027-01-12')
  assert.equal(await page.getByLabel('Итог: Анна Иванова').inputValue(), '4')
  assert.equal(await retakeDate.isDisabled(), true)
  assert.match(
    await page.locator('.journal-retake-fields [role="status"]').first().innerText(),
    /Сервер сохранил другое значение/,
  )
  await page.unroute(finalEndpoint)
  await concurrentPage.close()
  await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 2 },
    () => page.getByLabel('Итог: Анна Иванова').selectOption('2'),
  )
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Дата пересдачи: Анна Иванова"]')?.disabled,
  )
  await retakeDate.fill('2027-01-10')
  await retakeDate.blur()
  await page.getByText('Сохранено').last().waitFor()
  await retakeLocation.fill('A-101')
  await retakeLocation.blur()
  await page.getByText('Сохранено').last().waitFor()
  fixture('verify-retake')
  await page.reload()
  await page.getByRole('tab', { name: 'Работы и баллы' }).click()
  assert.equal(await page.getByLabel('Итог: Анна Иванова').inputValue(), '2')
  assert.equal(await page.getByLabel('Дата пересдачи: Анна Иванова').inputValue(), '2027-01-10')
  assert.equal(await page.getByLabel('Место пересдачи: Анна Иванова').inputValue(), 'A-101')
  const reloadedFinalGrade = page.getByLabel('Итог: Анна Иванова')
  const clearedFinal = await saveFinal(
    page,
    env.TEACHER_JOURNAL_COURSE_A,
    env.TEACHER_JOURNAL_STUDENT_A,
    { grade_value: 4 },
    () => reloadedFinalGrade.selectOption('4'),
  )
  assert.equal(clearedFinal.retake_date, null)
  assert.equal(clearedFinal.retake_location, null)
  assert.equal(await retakeDate.inputValue(), '')
  assert.equal(await retakeLocation.inputValue(), '')
  assert.ok(await page.getByText(/сумма баллов не преобразуется/).isVisible())
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
  check(
    'score bounds, F05 retake clearing, F12 retry and F16 confirmed debt and retake persistence',
  )

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

  const announcementPanel = page.locator('.journal-announcements')
  const announcementSummary = announcementPanel.locator(':scope > summary')
  const publishButton = announcementPanel.getByRole('button', { name: 'Опубликовать' })
  const titleField = announcementPanel.getByLabel('Заголовок')
  const bodyField = announcementPanel.getByLabel('Текст объявления')
  await announcementSummary.focus()
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
  await announcementSummary.click()
  await announcementEntry.waitFor()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))

  const lostResponseTitle = 'Ответ потерян после сохранения'
  await titleField.fill(lostResponseTitle)
  await bodyField.fill('Введённый текст сохраняется при сбое')
  let announcementPosts = 0
  const announcementPost = '**/teaching/courses/*/announcements'
  await page.route(announcementPost, async (route) => {
    announcementPosts += 1
    const response = await route.fetch()
    assert.equal(response.status(), 201)
    await route.abort('failed')
  })
  await publishButton.click()
  await announcementPanel.getByText('Результат публикации неизвестен. Проверьте ленту.').waitFor()
  assert.equal(await titleField.inputValue(), lostResponseTitle)
  assert.equal(await bodyField.inputValue(), 'Введённый текст сохраняется при сбое')
  assert.equal(await publishButton.isDisabled(), true)
  await announcementPanel.getByRole('button', { name: 'Проверить публикацию' }).click()
  await announcementPanel.getByText('Объявление опубликовано.').waitFor()
  await announcementPanel
    .locator('.announcement-feed summary')
    .filter({ hasText: lostResponseTitle })
    .waitFor()
  assert.equal(announcementPosts, 1)
  await page.unroute(announcementPost)
  check(
    'announcement publication, plain text, keyboard expansion, reload at 360/1440 px and lost response recovery',
  )

  await page.route('**/groups/*/announcements', (route) => route.abort('failed'))
  await page.reload()
  await announcementSummary.click()
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
  for (let index = 0; index < 19; index += 1) {
    const response = await page.request.post(courseAnnouncementUrl, {
      headers: teacherHeaders,
      data: {
        group_id: env.TEACHER_JOURNAL_GROUP_A,
        title: `Объявление ${index + 1}`,
        body: 'ДлинныйТекст'.repeat(40),
      },
    })
    assert.equal(response.status(), 201)
  }
  await page.reload()
  await announcementSummary.click()
  await announcementPanel.getByRole('button', { name: 'Показать ещё' }).click()
  await announcementEntry.waitFor()
  assert.equal(await announcementPanel.locator('.announcement-feed li').count(), 21)
  assert.equal(await announcementPanel.getByRole('button', { name: 'Показать ещё' }).count(), 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  check('announcement list loads a second real page without duplicates')

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
  await selectJournal(secondPage, env.TEACHER_JOURNAL_COURSE_B, env.TEACHER_JOURNAL_GROUP_B)
  await secondPage.getByRole('tab', { name: 'Работы и баллы' }).click()
  await secondPage.getByLabel('Работа').selectOption(env.TEACHER_JOURNAL_ASSESSMENT_B)
  const studentBFinal = secondPage.getByLabel(/Итог: Вымышленная студентка группы Б/)
  const studentBId = env.TEACHER_JOURNAL_FOREIGN_STUDENT
  const studentBRetakeDate = secondPage.getByLabel(/Дата пересдачи: Вымышленная студентка группы Б/)
  assert.equal(await studentBRetakeDate.isDisabled(), true)
  await saveFinal(secondPage, env.TEACHER_JOURNAL_COURSE_B, studentBId, { passed: false }, () =>
    studentBFinal.selectOption('false'),
  )
  await secondPage.waitForFunction(
    () =>
      !document.querySelector('[aria-label^="Дата пересдачи: Вымышленная студентка"]')?.disabled,
  )
  await studentBRetakeDate.fill('2027-02-02')
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
