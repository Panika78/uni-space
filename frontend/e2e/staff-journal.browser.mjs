/* global process, document, console, window, Event, URL, URLSearchParams */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const env = process.env
const { chromium } = await import(env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = env.TEACHER_JOURNAL_TEST_URL || 'http://localhost:5173'
const browser = await chromium.launch({
  executablePath: env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const course = env.TEACHER_JOURNAL_COURSE_A
const group = env.TEACHER_JOURNAL_GROUP_A
const assessment = env.TEACHER_JOURNAL_ASSESSMENT_A
const student = env.TEACHER_JOURNAL_STUDENT_C
const lesson = env.TEACHER_JOURNAL_LESSON_A
const studentName = 'Мария Петрова'
const scope = `/api/v1/staff/journals/courses/${course}/groups/${group}`
const writeScore = `/api/v1/teaching/courses/${course}/groups/${group}/assessments/${assessment}/results/${student}`
const writeFinal = `/api/v1/final-results/courses/${course}/students/${student}`
const writeAttendance = `/api/v1/attendance/lessons/${lesson}/students/${student}`

function updateFixture(mode) {
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
}

function journalUrl(tab = '', resource = '', selectedCourse = course, selectedGroup = group) {
  return `${baseURL}/staff/journals?${new URLSearchParams({
    course: selectedCourse,
    group: selectedGroup,
    tab,
    resource,
  })}`
}

async function login(page, username, target) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(username)
  await page.getByLabel('Пароль').fill(env.TEACHER_JOURNAL_PASSWORD)
  async function submit() {
    const finished = page.waitForResponse((response) => response.url().endsWith('/auth/login'))
    await page.getByRole('button', { name: 'Войти' }).click()
    return finished
  }
  let response = await submit()
  if (response.status() === 429) {
    const wait = Number(await response.headerValue('retry-after'))
    assert(wait >= 1 && wait <= 60)
    await delay((wait + 1) * 1000)
    response = await submit()
  }
  assert.equal(response.status(), 200)
  await page.waitForURL((url) => url.pathname !== '/login')
  await page.goto(target)
}

async function saved(page, path, method, action) {
  const response = page.waitForResponse(
    (item) => item.url().endsWith(path) && item.request().method() === method,
  )
  await action()
  const result = await response
  assert.equal(result.status(), 200, await result.text())
}

const row = (page) => page.locator('article.journal-student').filter({ hasText: studentName })
const score = (page) => page.getByLabel(`Балл · ${studentName}`)
const sectionButton = (page, name) =>
  page.getByRole('navigation', { name: 'Разделы журнала' }).getByRole('button', { name })

try {
  const mobile = await browser.newContext({ viewport: { width: 360, height: 800 } })
  const gradePage = await mobile.newPage()
  await login(gradePage, env.JOURNAL_GRADES_LOGIN, journalUrl('work', assessment))
  await score(gradePage).waitFor()
  assert.equal(await sectionButton(gradePage, 'Посещаемость').count(), 0)
  assert(await gradePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await saved(gradePage, writeScore, 'PUT', async () => {
    await score(gradePage).fill('0')
    await score(gradePage).press('Enter')
  })
  await row(gradePage).getByText('Сохранено').waitFor()

  // Hold a real, committed response until the score row has unmounted.
  for (const [value, lost] of [
    ['1', false],
    ['3', true],
  ]) {
    const committed = Promise.withResolvers()
    const release = Promise.withResolvers()
    const delivered = Promise.withResolvers()
    let attempts = 0
    await gradePage.route(`**${writeScore}`, async (route) => {
      attempts += 1
      const response = await route.fetch()
      committed.resolve(response.status())
      await release.promise
      if (lost) await route.abort()
      else await route.fulfill({ response })
      delivered.resolve()
    })
    await score(gradePage).fill(value)
    await sectionButton(gradePage, 'Итоги аттестации').click()
    assert.equal(await committed.promise, 200)
    await gradePage.goBack()
    await row(gradePage).getByText('Сохраняется').waitFor()
    assert.equal(await score(gradePage).inputValue(), value)
    const verification =
      lost &&
      gradePage.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          url.pathname.endsWith(`/assessments/${assessment}/results`) &&
          url.searchParams.get('student_id') === student
        )
      })
    release.resolve()
    await delivered.promise
    if (verification) {
      const result = await verification
      assert.equal(result.status(), 200)
      assert.equal((await result.json()).items[0].score, Number(value))
    }
    await row(gradePage).getByText('Сохранено').waitFor()
    assert.equal(attempts, 1)
    await gradePage.unrouteAll()
    assert.equal(await score(gradePage).inputValue(), value)
  }

  let rejected = 0
  await gradePage.route(`**${writeScore}`, async (route) => {
    rejected += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  })
  await score(gradePage).fill('6')
  await score(gradePage).press('Enter')
  const retry = row(gradePage).getByRole('button', { name: 'Повторить' })
  await retry.waitFor()
  assert.equal(rejected, 1)
  assert.equal(await score(gradePage).inputValue(), '6')
  assert.equal(await row(gradePage).getByText('Сохранено').count(), 0)
  await gradePage.unrouteAll()
  // Edit back to the confirmed server value before continuing to the final result.
  await score(gradePage).fill('3')
  await score(gradePage).blur()

  await sectionButton(gradePage, 'Итоги аттестации').click()
  const currentFinal = gradePage
    .locator('article.journal-student--final')
    .filter({ hasText: studentName })
  await currentFinal.getByLabel('Итог').selectOption('2')
  await currentFinal.getByLabel('Дата пересдачи').fill('2027-01-12')
  await currentFinal.getByLabel('Место пересдачи').fill('Б-201')
  let finalAttempts = 0
  await gradePage.route(`**${writeFinal}`, async (route) => {
    if (route.request().method() === 'GET') return route.continue()
    finalAttempts += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
  })
  const finalRetry = currentFinal.getByRole('button', { name: 'Повторить', exact: true })
  await currentFinal.getByRole('button', { name: 'Сохранить итог' }).click()
  await finalRetry.waitFor()
  await sectionButton(gradePage, 'Работы и баллы').click()
  await gradePage.goBack()
  await finalRetry.waitFor()
  await gradePage.goForward()
  await gradePage.goBack()
  await gradePage.reload()
  await finalRetry.waitFor()
  assert.equal(await currentFinal.getByLabel('Итог').inputValue(), '2')
  assert.equal(await currentFinal.getByLabel('Дата пересдачи').inputValue(), '2027-01-12')
  assert.equal(await currentFinal.getByLabel('Место пересдачи').inputValue(), 'Б-201')
  assert.equal(finalAttempts, 1)
  await gradePage.unrouteAll()
  await saved(gradePage, writeFinal, 'PATCH', () => finalRetry.click())
  await currentFinal.getByText('Сохранено').waitFor()

  const peerContext = await browser.newContext()
  const peer = await peerContext.newPage()
  const peerCatalog = peer.waitForResponse((response) =>
    response.url().includes('/staff/journals/catalog'),
  )
  await login(peer, env.JOURNAL_BOTH_LOGIN, journalUrl('finals'))
  const peerAuth = await (await peerCatalog).request().headerValue('authorization')
  assert(peerAuth)
  const historicalRow = (page) =>
    row(page).filter({ has: page.getByRole('button', { name: 'Открыть итог' }) })
  async function deleteFromPeer(expectedStatus) {
    await historicalRow(gradePage).waitFor()
    const removed = await peer.request.delete(`${baseURL}${writeFinal}`, {
      headers: { authorization: peerAuth },
    })
    assert.equal(removed.status(), 200)
    const read = gradePage.waitForResponse(
      (response) => response.url().endsWith(writeFinal) && response.request().method() === 'GET',
    )
    await historicalRow(gradePage).getByRole('button', { name: 'Открыть итог' }).click()
    const response = await read
    assert.equal(response.status(), expectedStatus)
    if (expectedStatus === 200) assert.equal((await response.json()).result_id, null)
    const deleted = row(gradePage).filter({ hasText: 'Итог удалён' })
    await deleted.getByRole('button', { name: 'История изменений' }).click()
    const history = gradePage.getByRole('dialog', { name: 'История изменений' })
    await history
      .getByText(/Удаление/)
      .first()
      .waitFor()
    assert.equal(await row(gradePage).getByText('Загружаем итог…').count(), 0)
    await gradePage.keyboard.press('Escape')
    await history.waitFor({ state: 'hidden' })
  }

  await deleteFromPeer(200)
  await currentFinal
    .getByLabel('Итог')
    .locator('option[value=""]:checked')
    .waitFor({ state: 'attached' })
  await currentFinal.getByLabel('Итог').selectOption('2')
  await currentFinal.getByLabel('Дата пересдачи').fill('2027-01-12')
  await currentFinal.getByLabel('Место пересдачи').fill('Б-201')
  await saved(gradePage, writeFinal, 'PATCH', () =>
    currentFinal.getByRole('button', { name: 'Сохранить итог' }).click(),
  )
  await currentFinal.getByText('Сохранено').waitFor()

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const attendancePage = await desktop.newPage()
  const gradesDenied = attendancePage.waitForResponse((response) =>
    response.url().includes('/staff/journals/catalog'),
  )
  await login(attendancePage, env.JOURNAL_ATTENDANCE_LOGIN, journalUrl('attendance', lesson))
  const catalog = await gradesDenied
  assert.equal(catalog.status(), 200)
  const auth = await catalog.request().headerValue('authorization')
  assert(auth)
  const crossGrant = await attendancePage.request.get(
    `${baseURL}${scope}/assessments/${assessment}/results/${student}/history`,
    {
      headers: { authorization: auth },
    },
  )
  assert.equal(crossGrant.status(), 403)
  await row(attendancePage).getByRole('button', { name: 'Присутствовал' }).waitFor()
  assert.equal(await sectionButton(attendancePage, 'Работы и баллы').count(), 0)
  assert.equal(await sectionButton(attendancePage, 'Итоги аттестации').count(), 0)
  assert(
    await attendancePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  )
  if (
    (await row(attendancePage)
      .getByRole('button', { name: 'Присутствовал' })
      .getAttribute('aria-pressed')) !== 'true'
  ) {
    await saved(attendancePage, writeAttendance, 'PUT', () =>
      row(attendancePage).getByRole('button', { name: 'Присутствовал' }).click(),
    )
  }
  updateFixture('staff-transfer')
  await attendancePage.reload()
  await row(attendancePage).getByText('Историческая отметка').waitFor()
  await saved(attendancePage, writeAttendance, 'PUT', () =>
    row(attendancePage).getByRole('button', { name: 'Отсутствовал' }).click(),
  )
  await row(attendancePage).getByRole('button', { name: 'Отсутствовал', pressed: true }).waitFor()
  await saved(attendancePage, writeAttendance, 'DELETE', () =>
    row(attendancePage).getByRole('button', { name: 'Нет отметки' }).click(),
  )
  await row(attendancePage).waitFor({ state: 'hidden' })

  await gradePage.goto(journalUrl('work', assessment))
  await row(gradePage).getByText('Историческая оценка').waitFor()
  await saved(gradePage, writeScore, 'PUT', async () => {
    await score(gradePage).fill('')
    await score(gradePage).blur()
  })
  await row(gradePage).getByText('Оценка удалена').waitFor()
  const historyButton = row(gradePage).getByRole('button', { name: 'История изменений' })
  await historyButton.focus()
  await gradePage.keyboard.press('Enter')
  const dialog = gradePage.getByRole('dialog', { name: 'История изменений' })
  await dialog.getByText(/Удаление/).waitFor()
  await dialog.getByText(/Создание/).waitFor()
  assert.equal(await dialog.getByText('0', { exact: true }).count(), 2)
  await gradePage.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert(await historyButton.evaluate((element) => element === document.activeElement))
  assert(await score(gradePage).isDisabled())

  await sectionButton(gradePage, 'Итоги аттестации').click()
  await deleteFromPeer(404)
  await peerContext.close()
  await gradePage.getByRole('searchbox', { name: 'Поиск по истории итогов' }).fill(studentName)
  await gradePage.getByRole('searchbox', { name: 'Поиск по истории итогов' }).press('Enter')
  await row(gradePage).getByText('Итог удалён').waitFor()
  await row(gradePage).getByRole('button', { name: 'История изменений' }).click()
  await dialog
    .getByText(/Удаление/)
    .first()
    .waitFor()
  await dialog.getByText(/Б-201/).first().waitFor()
  await gradePage.keyboard.press('Escape')

  const other = env.TEACHER_JOURNAL_STUDENT_A
  const otherName = 'Анна Иванова'
  async function revokeDuringSave(page, write, action, mode) {
    const committed = Promise.withResolvers()
    const release = Promise.withResolvers()
    const finished = Promise.withResolvers()
    await page.route(`**${write}`, async (route) => {
      const response = await route.fetch()
      committed.resolve(response.status())
      await release.promise
      try {
        await route.fulfill({ response })
      } catch {
        // Revoking access may close the browser's side of this committed request.
      } finally {
        finished.resolve()
      }
    })
    await action()
    assert.equal(await committed.promise, 200)
    updateFixture(mode)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.getByRole('alert').getByText('Доступ запрещён', { exact: true }).waitFor()
    release.resolve()
    await finished.promise
    assert.equal(await page.locator('article.journal-student').count(), 0)
    assert.equal(
      await page.evaluate(() => window.sessionStorage.getItem('uni-space.staff-journal')),
      null,
    )
    await page.unrouteAll()
  }

  await gradePage.goto(journalUrl('work', assessment))
  const otherScore = gradePage.getByLabel(`Балл · ${otherName}`)
  await revokeDuringSave(
    gradePage,
    writeScore.replace(`/results/${student}`, `/results/${other}`),
    async () => {
      await otherScore.fill((await otherScore.inputValue()) === '7' ? '8' : '7')
      await otherScore.press('Enter')
    },
    'staff-revoke',
  )
  const otherAttendance = attendancePage.getByRole('group', { name: `Посещаемость · ${otherName}` })
  const attended = otherAttendance.getByRole('button', { name: 'Присутствовал' })
  const changeMark =
    (await attended.getAttribute('aria-pressed')) === 'true'
      ? otherAttendance.getByRole('button', { name: 'Отсутствовал' })
      : attended
  await revokeDuringSave(
    attendancePage,
    writeAttendance.replace(`/students/${student}`, `/students/${other}`),
    () => changeMark.click(),
    'staff-revoke-attendance',
  )

  async function logout(page, openMenu = false) {
    if (openMenu) await page.getByRole('button', { name: 'Меню пользователя' }).click()
    await page.getByRole('button', { name: 'Выйти', exact: true }).last().click()
    await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
    await page.waitForURL('**/login')
  }
  await logout(gradePage)
  await login(gradePage, env.JOURNAL_BOTH_LOGIN, journalUrl('finals'))
  await sectionButton(gradePage, 'Посещаемость').waitFor()
  assert.equal(await row(gradePage).filter({ hasText: 'Загружаем итог…' }).count(), 0)
  const bothFinal = gradePage
    .locator('article.journal-student--final')
    .filter({ hasText: otherName })
  await bothFinal.getByLabel('Место пересдачи').fill('Черновик другого аккаунта')
  await logout(gradePage, true)
  await login(gradePage, env.JOURNAL_STUDENTS_READ_LOGIN, journalUrl('finals'))
  await gradePage.getByRole('alert').getByText('Доступ запрещён', { exact: true }).waitFor()
  assert.equal(await gradePage.getByText('Черновик другого аккаунта').count(), 0)
  assert.equal(
    await gradePage.evaluate(() => window.sessionStorage.getItem('uni-space.staff-journal')),
    null,
  )

  for (const account of [
    env.JOURNAL_ADMIN_LOGIN,
    env.TEACHER_JOURNAL_LOGIN_B,
    env.JOURNAL_STUDENT_LOGIN,
  ]) {
    const isolated = await browser.newContext()
    const page = await isolated.newPage()
    await login(page, account, journalUrl('work', assessment))
    await page.getByRole('alert').getByText('Доступ запрещён', { exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: 'Журнал деканата' }).count(), 0)
    await isolated.close()
  }
  console.log(
    'PASS staff grants, historical score and final DELETE, transferred attendance, lost response, focus, reload, history, revoke and account switch',
  )
} finally {
  await browser.close()
}
