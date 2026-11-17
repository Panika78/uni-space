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
  const groupButton = page.locator(`button[data-course-id="${course}"][data-group-id="${group}"]`)
  await groupButton.waitFor()
  await groupButton.click()
}

async function waitForSavedStudent(page, name) {
  await page
    .locator('.journal-student')
    .filter({ hasText: name })
    .getByRole('status')
    .filter({ hasText: 'Сохранено' })
    .waitFor()
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
  await waitForSavedStudent(page, 'Мария Петрова')
  await waitForAttendance(page, 'Присутствовал', 'Мария Петрова')
  await page.getByRole('button', { name: 'Нет отметки: Мария Петрова' }).click()
  await waitForSavedStudent(page, 'Мария Петрова')
  await waitForAttendance(page, 'Нет отметки', 'Мария Петрова')
  assert.equal(
    await page
      .getByRole('button', { name: 'Нет отметки: Мария Петрова' })
      .getAttribute('aria-pressed'),
    'true',
  )
  await page.getByRole('button', { name: 'Присутствовал: Мария Петрова' }).click()
  await waitForSavedStudent(page, 'Мария Петрова')
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
  await annaScore.fill('10')
  await annaScore.blur()
  await page.getByText('Сохранено').first().waitFor()
  await annaScore.fill('')
  await annaScore.blur()
  await page.getByText('Сохранено').first().waitFor()
  await annaScore.fill('11')
  await annaScore.blur()
  await page.getByText('Ошибка, повторить').waitFor()
  await annaScore.fill('10')
  await annaScore.blur()
  await page.getByText('Сохранено').first().waitFor()
  await page.getByLabel('Дата', { exact: true }).fill(env.TEACHER_JOURNAL_DATE)
  await page.getByRole('button', { name: 'Сохранить дату и связь' }).click()
  await page.getByText('Сохранено').last().waitFor()
  await page.getByLabel('Связать с занятием').selectOption(env.TEACHER_JOURNAL_LESSON_A)
  await page.getByRole('button', { name: 'Сохранить дату и связь' }).click()
  await page.getByText('Сохранено').last().waitFor()
  await page.getByLabel('Итог: Анна Иванова').selectOption('2')
  await page.getByText('Есть долг').waitFor()
  await page.getByLabel('Итог: Анна Иванова').selectOption('4')
  await page.getByText('Долга нет').waitFor()
  assert.ok(await page.getByText(/сумма баллов не преобразуется/).isVisible())
  check(
    'integer score 0/null/max, rejected over-max value, changed date/link and manual exam result/debt',
  )

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
  await waitForSavedStudent(page, 'Мария Петрова')
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
  await secondPage.getByLabel(/Итог: Вымышленная студентка группы Б/).selectOption('true')
  await secondPage.getByText('Сохранено').waitFor()
  assert.ok(await secondPage.getByText('Итоги аттестации · Зачёт').isVisible())
  check('teacher B sees own assignment and manually records pass/fail result')

  await context.close()
  await secondContext.close()
} finally {
  await browser.close()
}
