/* global process, document, console, location, URL */
// Real FastAPI/PostgreSQL staff editor flow; fixture accounts are fictional and isolated.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.STAFF_SCHEDULE_TEST_URL || 'http://localhost:5173'
const password = process.env.STAFF_SCHEDULE_PASSWORD
const firstLogin = process.env.STAFF_SCHEDULE_LOGIN
const secondLogin = process.env.STAFF_SCHEDULE_SECOND_LOGIN
const deniedLogin = process.env.STAFF_SCHEDULE_NO_PERMISSION_LOGIN
const studentLogin = process.env.STAFF_SCHEDULE_STUDENT_LOGIN
const groupName = process.env.STAFF_SCHEDULE_GROUP
const secondGroupName = process.env.STAFF_SCHEDULE_SECOND_GROUP
const secondRoomName = process.env.STAFF_SCHEDULE_SECOND_ROOM
const roomName = process.env.STAFF_SCHEDULE_ROOM
const secondRoomLabel = process.env.STAFF_SCHEDULE_SECOND_ROOM_LABEL
const scheduleDate = process.env.STAFF_SCHEDULE_DATE
const subjectName = `Вымышленная дисциплина ${process.env.STAFF_SCHEDULE_SUFFIX}`
assert.ok(
  password &&
    firstLogin &&
    secondLogin &&
    deniedLogin &&
    studentLogin &&
    groupName &&
    secondGroupName &&
    roomName &&
    secondRoomLabel &&
    secondRoomName &&
    scheduleDate,
)

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
const firstContext = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: 'Pacific/Honolulu',
})
const firstPage = await firstContext.newPage()
const pass = (message) => console.log(`PASS ${message}`)

async function login(page, login, destination = '**/staff') {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(login)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.waitForURL(destination)
}

async function openSchedule(page, selectedGroup = groupName, date = scheduleDate) {
  await page.goto(`${baseURL}/staff/schedule?date=${encodeURIComponent(date)}`)
  await page.getByRole('heading', { name: 'Редактор расписания' }).waitFor()
  const search = page.getByRole('combobox', { name: 'Группа' })
  await search.click()
  await search.fill(selectedGroup)
  await page
    .locator('.staff-schedule__options')
    .getByRole('option', { name: new RegExp(selectedGroup) })
    .first()
    .click()
  await page.getByText(subjectName, { exact: true }).first().waitFor()
}

function shiftDate(value, days) {
  const result = new Date(`${value}T12:00:00Z`)
  result.setUTCDate(result.getUTCDate() + days)
  return result.toISOString().slice(0, 10)
}

async function chooseOption(page, label, optionName, searchOverride) {
  const input = page.getByRole('combobox', { name: label, exact: true })
  await input.click()
  const searchValue =
    searchOverride ?? (optionName instanceof RegExp ? optionName.source : optionName)
  await input.fill(searchValue)
  const pattern =
    optionName instanceof RegExp
      ? optionName
      : new RegExp(optionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  await page
    .locator('.staff-schedule__options')
    .getByRole('option', { name: pattern })
    .first()
    .click()
}

async function createLesson(page, start, end, kind = 'seminar') {
  await page.getByRole('button', { name: 'Добавить занятие' }).click()
  const dialog = page.getByRole('dialog', { name: 'Добавить занятие' })
  await chooseOption(page, 'Дисциплина и проведение', subjectName)
  await chooseOption(page, 'Группы', groupName)
  await dialog.getByLabel('Вся группа').uncheck()
  await dialog.getByLabel('А', { exact: true }).check()
  await dialog.getByLabel('Б', { exact: true }).check()
  await chooseOption(page, 'Преподаватель', new RegExp('Вымышленный преподаватель'))
  await chooseOption(page, 'Аудитории', roomName, '205')
  await chooseOption(page, 'Аудитории', secondRoomLabel, '206')
  await dialog.getByLabel('Дата начала').fill(scheduleDate)
  await dialog.getByLabel('Дата окончания').fill(scheduleDate)
  await dialog.getByLabel('Время начала · Москва').fill(start)
  await dialog.getByLabel('Время окончания · Москва').fill(end)
  await dialog.getByLabel('Тип занятия').selectOption(kind)
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/staff/schedule/lessons' &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Сохранить' }).click()
  const response = await responsePromise
  assert.equal(response.status(), 201)
  const saved = await response.json()
  assert.deepEqual(
    saved.display.participants.map(({ group_name, subgroup_name }) => [group_name, subgroup_name]),
    [
      [groupName, 'А'],
      [groupName, 'Б'],
    ],
  )
  assert.equal(saved.participants.length, 2)
  assert.equal(saved.room_ids.length, 2)
  await dialog.waitFor({ state: 'hidden' })
}

try {
  await login(firstPage, firstLogin)
  await openSchedule(firstPage)
  await createLesson(firstPage, '17:00', '17:30')
  await firstPage.getByText('17:00–17:30').waitFor()
  const initialCard = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: '18:00–19:30' })
  await initialCard.getByRole('button', { name: 'Изменить' }).click()
  const editDialog = firstPage.getByRole('dialog', { name: 'Изменить занятие' })
  await editDialog.getByLabel('Время начала · Москва').fill('18:15')
  await editDialog.getByLabel('Время окончания · Москва').fill('19:45')
  await editDialog.getByRole('button', { name: 'Сохранить' }).click()
  await editDialog.waitFor({ state: 'hidden' })
  pass('real API PATCH updates the full lesson and displays catalog labels')

  // The same save-time response carries all three real conflict types. Resolve them
  // one field at a time, then verify the accepted server response.
  await firstPage.getByRole('button', { name: 'Добавить занятие' }).click()
  const conflictDialog = firstPage.getByRole('dialog', { name: 'Добавить занятие' })
  await chooseOption(firstPage, 'Дисциплина и проведение', subjectName)
  await chooseOption(firstPage, 'Группы', groupName)
  await chooseOption(firstPage, 'Преподаватель', new RegExp('Вымышленный преподаватель'))
  await chooseOption(firstPage, 'Аудитории', roomName, '205')
  await conflictDialog.getByLabel('Дата начала').fill(scheduleDate)
  await conflictDialog.getByLabel('Дата окончания').fill(scheduleDate)
  await conflictDialog.getByLabel('Время начала · Москва').fill('18:15')
  await conflictDialog.getByLabel('Время окончания · Москва').fill('19:00')
  const submitConflict = () => conflictDialog.getByRole('button', { name: 'Сохранить' }).click()
  let conflictResponsePromise = firstPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/staff/schedule/lessons' &&
      response.request().method() === 'POST',
  )
  await submitConflict()
  let conflictResponse = await conflictResponsePromise
  assert.equal(conflictResponse.status(), 409)
  let conflictBody = await conflictResponse.json()
  assert.deepEqual(conflictBody.error.details.map(({ code }) => code).sort(), [
    'participants_conflict',
    'room_conflict',
    'teacher_conflict',
  ])
  await conflictDialog.getByText('teacher conflict', { exact: true }).waitFor()
  await conflictDialog.getByText('room conflict', { exact: true }).waitFor()
  await conflictDialog.getByText('participants conflict', { exact: true }).waitFor()
  await conflictDialog.getByRole('button', { name: 'Убрать преподавателя' }).click()
  await conflictDialog.getByRole('button', { name: /205 ×/ }).click()
  await conflictDialog.getByRole('button', { name: `${groupName} ×` }).click()
  await chooseOption(firstPage, 'Группы', secondGroupName)
  conflictResponsePromise = firstPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/staff/schedule/lessons' &&
      response.request().method() === 'POST',
  )
  await submitConflict()
  conflictResponse = await conflictResponsePromise
  assert.equal(conflictResponse.status(), 201)
  const conflictResolved = await conflictResponse.json()
  assert.equal(conflictResolved.teacher_id, null)
  assert.deepEqual(conflictResolved.room_ids, [])
  assert.equal(conflictResolved.display.participants[0].group_name, secondGroupName)
  await conflictDialog.waitFor({ state: 'hidden' })
  pass('real teacher, room, and participant conflicts are shown and resolved through form fields')

  const updatedCard = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: '18:15–19:45' })
  await updatedCard.getByRole('button', { name: 'Перенести' }).click()
  let moveDialog = firstPage.getByRole('dialog', { name: 'Перенести занятие' })
  const firstMoveDate = shiftDate(scheduleDate, 7)
  await moveDialog.getByLabel('Время начала · Москва').fill('20:00')
  await moveDialog.getByLabel('Время окончания · Москва').fill('21:30')
  await moveDialog.getByLabel('Дата начала').fill(firstMoveDate)
  await moveDialog.getByLabel('Дата окончания').fill(firstMoveDate)
  await moveDialog.getByRole('button', { name: `${groupName} ×` }).click()
  await chooseOption(firstPage, 'Группы', secondGroupName)
  await moveDialog
    .getByRole('button', {
      name: new RegExp(`${roomName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ×`),
    })
    .click()
  await chooseOption(firstPage, 'Аудитории', secondRoomLabel, '206')
  await moveDialog.getByRole('button', { name: 'Сохранить' }).click()
  await moveDialog.waitFor({ state: 'hidden' })
  await firstPage.getByRole('tab', { name: 'Аудитории' }).click()
  const roomSelect = firstPage.getByRole('combobox', { name: 'Аудитория' })
  await roomSelect.click()
  await roomSelect.fill('205')
  await firstPage
    .locator('.staff-schedule__options')
    .getByRole('option', { name: new RegExp(roomName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .first()
    .click()
  const room205Id = new URL(firstPage.url()).searchParams.get('resource_id')
  assert.ok(room205Id)
  const movedOriginal = firstPage
    .locator('.staff-schedule__lesson.is-moved')
    .filter({ hasText: subjectName })
    .first()
  await movedOriginal.getByRole('button', { name: 'Следующее занятие' }).click()
  await firstPage.getByText('20:00–21:30').waitFor()
  assert.equal(await firstPage.getByLabel('Выбрать дату').inputValue(), firstMoveDate)
  const reloadedRoomPicker = firstPage.getByRole('combobox', { name: 'Аудитория' })
  await firstPage.waitForFunction(
    ({ label }) =>
      document.querySelector('input[aria-label="Аудитория"]')?.value.includes(label) ?? false,
    { label: secondRoomName },
  )
  assert.ok((await reloadedRoomPicker.inputValue()).includes(secondRoomName))
  const selectedTargetRoomId = new URL(firstPage.url()).searchParams.get('resource_id')
  assert.ok(selectedTargetRoomId)
  await firstPage.reload()
  await firstPage.getByRole('heading', { name: 'Редактор расписания' }).waitFor()
  await firstPage.waitForFunction(
    ({ id }) => new URL(location.href).searchParams.get('resource_id') === id,
    { id: selectedTargetRoomId },
    { timeout: 5000 },
  )
  await firstPage.waitForFunction(
    ({ label }) =>
      document.querySelector('input[aria-label="Аудитория"]')?.value.includes(label) ?? false,
    { label: secondRoomName },
  )
  assert.ok(
    (await firstPage.getByRole('combobox', { name: 'Аудитория' }).inputValue()).includes(
      secondRoomName,
    ),
  )
  await firstPage.goBack()
  await firstPage.waitForFunction(
    ({ id }) => new URL(location.href).searchParams.get('resource_id') === id,
    { id: room205Id },
    { timeout: 5000 },
  )
  await firstPage.goForward()
  await firstPage.waitForFunction(
    ({ id }) => new URL(location.href).searchParams.get('resource_id') === id,
    { id: selectedTargetRoomId },
    { timeout: 5000 },
  )
  const firstMoved = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '20:00–21:30' })
  await firstMoved.getByRole('button', { name: 'Перенести' }).click()
  moveDialog = firstPage.getByRole('dialog', { name: 'Перенести занятие' })
  const secondMoveDate = shiftDate(firstMoveDate, 7)
  await moveDialog.getByLabel('Время начала · Москва').fill('22:00')
  await moveDialog.getByLabel('Время окончания · Москва').fill('23:00')
  await moveDialog.getByLabel('Дата начала').fill(secondMoveDate)
  await moveDialog.getByLabel('Дата окончания').fill(secondMoveDate)
  await moveDialog
    .getByRole('button', {
      name: new RegExp(`${secondRoomLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ×`),
    })
    .click()
  await chooseOption(firstPage, 'Аудитории', roomName, '205')
  await moveDialog.getByRole('button', { name: 'Сохранить' }).click()
  await moveDialog.waitFor({ state: 'hidden' })
  const secondMovedOriginal = firstPage
    .locator('.staff-schedule__lesson.is-moved')
    .filter({ hasText: subjectName })
    .filter({ hasText: '20:00–21:30' })
  await secondMovedOriginal.getByRole('button', { name: 'Следующее занятие' }).click()
  await firstPage.getByText('22:00–23:00').waitFor()
  assert.equal(await firstPage.getByLabel('Выбрать дату').inputValue(), secondMoveDate)
  assert.ok(
    (await firstPage.getByRole('combobox', { name: 'Аудитория' }).inputValue()).includes('205'),
  )
  await openSchedule(firstPage, secondGroupName, secondMoveDate)
  pass('real API move chain preserves old positions and follows 19→20→23 history')

  const latestCard = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '22:00–23:00' })
  await latestCard.getByRole('button', { name: 'Отменить' }).click()
  const cancelDialog = firstPage.getByRole('dialog', { name: 'Отменить занятие?' })
  await cancelDialog.getByRole('button', { name: 'Подтвердить отмену' }).click()
  await firstPage.getByText('Отменено').last().waitFor()
  const cancelledCard = firstPage
    .locator('.staff-schedule__lesson.is-cancelled')
    .filter({ hasText: subjectName })
  await cancelledCard.getByRole('button', { name: 'Восстановить' }).click()
  await firstPage.getByRole('button', { name: 'Отменить' }).last().waitFor()
  pass('cancel confirmation and restore use the versioned API without DELETE or reason')

  // Two real staff sessions race on one row. The local browser draft must survive.
  const concurrentCard = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: '22:00–23:00' })
  await concurrentCard.getByRole('button', { name: 'Изменить' }).click()
  const firstDraft = firstPage.getByRole('dialog', { name: 'Изменить занятие' })
  await firstDraft.getByLabel('Время начала · Москва').fill('22:15')
  const secondContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const secondPage = await secondContext.newPage()
  await login(secondPage, secondLogin)
  await openSchedule(secondPage)
  await openSchedule(secondPage, secondGroupName, secondMoveDate)
  const secondCard = secondPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: '22:00–23:00' })
  await secondCard.getByRole('button', { name: 'Изменить' }).click()
  const secondDraft = secondPage.getByRole('dialog', { name: 'Изменить занятие' })
  await secondDraft.getByLabel('Время начала · Москва').fill('22:30')
  await secondDraft.getByLabel('Время окончания · Москва').fill('23:30')
  await secondDraft.getByRole('button', { name: 'Сохранить' }).click()
  await secondDraft.waitFor({ state: 'hidden' })
  await firstDraft.getByRole('button', { name: 'Сохранить' }).click()
  await firstDraft.getByText(/уже изменил другой сотрудник/).waitFor()
  assert.equal(await firstDraft.getByLabel('Время начала · Москва').inputValue(), '22:15')
  await firstDraft
    .getByRole('button', { name: 'Загрузить актуальную запись для сравнения' })
    .click()
  await firstDraft.getByText(/На сервере версия/).waitFor()
  await firstDraft
    .getByRole('button', { name: 'Я сравнил поля — показать подтверждение перезаписи' })
    .click()
  await firstDraft.getByRole('button', { name: 'Подтвердить перезапись моим черновиком' }).click()
  await firstDraft.getByRole('button', { name: 'Сохранить' }).click()
  await firstDraft.waitFor({ state: 'hidden' })
  pass(
    'two real staff sessions receive version_conflict; local draft stays until explicit version adoption',
  )

  let lostResponseMutationCount = 0
  await firstPage.route(/\/api\/v1\/staff\/schedule\/lessons\/\d+$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    lostResponseMutationCount += 1
    await route.fulfill({ response, body: '' })
  })
  const savedBeforeResponseLoss = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '22:15–23:00' })
  await savedBeforeResponseLoss.getByRole('button', { name: 'Изменить' }).click()
  const uncertainDialog = firstPage.getByRole('dialog', { name: 'Изменить занятие' })
  await uncertainDialog.getByLabel('Время начала · Москва').fill('22:20')
  await uncertainDialog.getByLabel('Время окончания · Москва').fill('23:05')
  await uncertainDialog.getByRole('button', { name: 'Сохранить' }).click()
  await uncertainDialog.getByText(/неизвестном формате/).waitFor()
  assert.equal(lostResponseMutationCount, 1)
  await uncertainDialog.getByRole('button', { name: 'Перечитать данные' }).click()
  await firstPage.getByText('22:20–23:05').waitFor()
  assert.equal(lostResponseMutationCount, 1)
  pass('committed mutation with lost response is read back without an automatic retry')
  await uncertainDialog.getByRole('button', { name: 'Отмена' }).click()
  await firstPage
    .getByRole('alertdialog', { name: 'Закрыть черновик?' })
    .getByRole('button', { name: 'Закрыть без сохранения' })
    .click()
  await uncertainDialog.waitFor({ state: 'hidden' })

  const cancelTarget = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '22:20–23:05' })
  await cancelTarget.getByRole('button', { name: 'Отменить' }).click()
  const uncertainCancel = firstPage.getByRole('dialog', { name: 'Отменить занятие?' })
  let cancelPostCount = 0
  await firstPage.route(/\/api\/v1\/staff\/schedule\/lessons\/\d+\/cancel$/, async (route) => {
    cancelPostCount += 1
    await route.abort('failed')
  })
  await secondPage.goto(`${baseURL}/staff/schedule?date=${encodeURIComponent(secondMoveDate)}`)
  await secondPage.getByRole('heading', { name: 'Редактор расписания' }).waitFor()
  const secondGroup = secondPage.getByRole('combobox', { name: 'Группа' })
  await secondGroup.click()
  await secondGroup.fill(secondGroupName)
  await secondPage
    .locator('.staff-schedule__options')
    .getByRole('option', { name: new RegExp(secondGroupName) })
    .first()
    .click()
  const concurrentMoveCard = secondPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '22:20–23:05' })
  await concurrentMoveCard.getByRole('button', { name: 'Перенести' }).click()
  const concurrentMove = secondPage.getByRole('dialog', { name: 'Перенести занятие' })
  await concurrentMove.getByLabel('Время начала · Москва').fill('22:30')
  await concurrentMove.getByLabel('Время окончания · Москва').fill('23:30')
  await concurrentMove.getByRole('button', { name: 'Сохранить' }).click()
  await concurrentMove.waitFor({ state: 'hidden' })
  await uncertainCancel.getByRole('button', { name: 'Подтвердить отмену' }).click()
  await uncertainCancel.getByText(/Отмена могла сохраниться/).waitFor()
  await uncertainCancel.getByRole('button', { name: 'Перечитать состояние занятия' }).click()
  await firstPage
    .getByRole('alert')
    .getByText(/Запись перенесена\. Это не подтверждает отмену/)
    .waitFor()
  assert.equal(cancelPostCount, 1)
  await uncertainCancel.waitFor({ state: 'hidden' })
  await firstPage.unroute(/\/api\/v1\/staff\/schedule\/lessons\/\d+\/cancel$/)
  pass('a concurrent move is not misreported as a confirmed cancellation; no retry is sent')

  const studentContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Pacific/Honolulu',
  })
  const studentPage = await studentContext.newPage()
  await login(studentPage, studentLogin, '**/schedule')
  let studentSchedule
  await studentPage.route('**/api/v1/schedule?**', async (route) => {
    const response = await route.fetch()
    if (response.status() === 200) studentSchedule = await response.json()
    await route.fulfill({ response })
  })
  await studentPage.getByLabel('Дата').fill(secondMoveDate)
  await studentPage.getByText('22:30', { exact: true }).waitFor()
  assert.ok(studentSchedule, 'the authenticated student schedule response was captured')
  assert.ok(
    studentSchedule.items.some(
      (item) =>
        item.course_offering.discipline.name === subjectName &&
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Moscow',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(item.starts_at)) === '22:30',
    ),
  )
  pass('student schedule shows the latest server position after two cross-week transfers')
  await studentContext.close()

  await secondContext.close()
  await firstPage.setViewportSize({ width: 360, height: 800 })
  await firstPage.waitForFunction(() => document.documentElement.scrollWidth <= 360)
  assert.ok(await firstPage.evaluate(() => document.documentElement.scrollWidth <= 360))
  await firstPage.getByRole('button', { name: 'Добавить занятие' }).click()
  const mobileDialog = firstPage.getByRole('dialog', { name: 'Добавить занятие' })
  const addTrigger = firstPage.getByRole('button', { name: 'Добавить занятие' })
  await mobileDialog.getByLabel('Время начала · Москва').fill('09:15')
  await firstPage.keyboard.press('Escape')
  const closeWarning = firstPage.getByRole('alertdialog', { name: 'Закрыть черновик?' })
  await closeWarning.getByRole('button', { name: 'Продолжить редактирование' }).click()
  const mobileStart = mobileDialog.getByLabel('Время начала · Москва')
  assert.ok(await mobileDialog.evaluate((dialog) => dialog.open))
  await firstPage.waitForFunction(
    (element) => document.activeElement === element,
    await mobileStart.elementHandle(),
    { timeout: 3000 },
  )
  await firstPage.goBack()
  const navigationWarning = firstPage.getByRole('dialog', { name: 'Выйти без сохранения?' })
  await navigationWarning.getByRole('button', { name: 'Продолжить редактирование' }).click()
  assert.equal(await mobileDialog.getByLabel('Время начала · Москва').inputValue(), '09:15')
  await firstPage.waitForFunction(
    (element) => document.activeElement === element,
    await mobileStart.elementHandle(),
    { timeout: 3000 },
  )
  await mobileDialog.getByRole('button', { name: 'Отмена' }).click()
  await firstPage
    .getByRole('alertdialog', { name: 'Закрыть черновик?' })
    .getByRole('button', { name: 'Закрыть без сохранения' })
    .click()
  await mobileDialog.waitFor({ state: 'hidden' })
  await firstPage.waitForFunction(
    (element) => document.activeElement === element,
    await addTrigger.elementHandle(),
    { timeout: 3000 },
  )
  await firstPage.setViewportSize({ width: 1440, height: 1000 })
  await firstPage.getByRole('button', { name: 'Добавить занятие' }).click()
  const desktopDialog = firstPage.getByRole('dialog', { name: 'Добавить занятие' })
  await desktopDialog.getByRole('button', { name: 'Отмена' }).click()
  await desktopDialog.waitFor({ state: 'hidden' })
  await firstPage.waitForFunction(
    (element) => document.activeElement === element,
    await addTrigger.elementHandle(),
    { timeout: 3000 },
  )
  pass('360/1440px layout, Escape, Back, Cancel, and bounded focus restoration')

  await openSchedule(firstPage, secondGroupName, secondMoveDate)
  const revocationCard = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '22:30–23:30' })
  await revocationCard.getByRole('button', { name: 'Отменить' }).click()
  const revocationDialog = firstPage.getByRole('dialog', { name: 'Отменить занятие?' })
  execFileSync(
    'uv',
    [
      'run',
      '--locked',
      '--python',
      '3.12.16',
      '--project',
      'backend',
      'python',
      'backend/scripts/revoke_staff_schedule_browser_permission.py',
      firstLogin,
    ],
    { stdio: 'inherit' },
  )
  await revocationDialog.getByRole('button', { name: 'Подтвердить отмену' }).click()
  await firstPage.getByText('Доступ запрещён').waitFor()
  assert.equal(await firstPage.locator('.staff-schedule').count(), 0)
  assert.equal(await firstPage.getByRole('dialog').count(), 0)
  pass('revoked schedule.edit closes an open dialog and hides cached schedule data')

  // Independent failure account verifies route permission at the real server boundary.
  const deniedContext = await browser.newContext()
  const deniedPage = await deniedContext.newPage()
  await login(deniedPage, deniedLogin)
  await deniedPage.goto(`${baseURL}/staff/schedule`)
  await deniedPage.getByText('Доступ запрещён').waitFor()
  assert.equal(await deniedPage.locator('.staff-schedule').count(), 0)
  await deniedContext.close()
  pass('staff account without schedule.edit receives denied UI and no schedule data')
} finally {
  await firstContext.close()
  await browser.close()
}
