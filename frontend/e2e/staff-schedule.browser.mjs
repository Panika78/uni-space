/* global process, document, console */
// Real FastAPI/PostgreSQL staff editor flow; fixture accounts are fictional and isolated.
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.STAFF_SCHEDULE_TEST_URL || 'http://localhost:5173'
const password = process.env.STAFF_SCHEDULE_PASSWORD
const firstLogin = process.env.STAFF_SCHEDULE_LOGIN
const secondLogin = process.env.STAFF_SCHEDULE_SECOND_LOGIN
const deniedLogin = process.env.STAFF_SCHEDULE_NO_PERMISSION_LOGIN
const groupName = process.env.STAFF_SCHEDULE_GROUP
const scheduleDate = process.env.STAFF_SCHEDULE_DATE
const subjectName = `Вымышленная дисциплина ${process.env.STAFF_SCHEDULE_SUFFIX}`
assert.ok(password && firstLogin && secondLogin && deniedLogin && groupName && scheduleDate)

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

async function login(page, login) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(login)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.waitForURL('**/staff')
}

async function openSchedule(page) {
  await page.goto(`${baseURL}/staff/schedule`)
  await page.getByRole('heading', { name: 'Редактор расписания' }).waitFor()
  const search = page.getByRole('combobox', { name: 'Поиск: группы' })
  await search.fill(groupName)
  await page.getByLabel('Выберите: группы').waitFor()
  await page.getByLabel('Выберите: группы').selectOption({ label: groupName })
  await page.getByText(subjectName, { exact: true }).first().waitFor()
}

async function chooseOption(page, label, optionName) {
  const input = page.getByRole('combobox', { name: label, exact: true })
  await input.click()
  const searchValue = optionName instanceof RegExp ? optionName.source : optionName
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
  await chooseOption(page, 'Преподаватель', new RegExp('Вымышленный преподаватель'))
  await chooseOption(page, 'Аудитории', '205')
  await dialog.getByLabel('Дата начала').fill(scheduleDate)
  await dialog.getByLabel('Дата окончания').fill(scheduleDate)
  await dialog.getByLabel('Время начала · Москва').fill(start)
  await dialog.getByLabel('Время окончания · Москва').fill(end)
  await dialog.getByLabel('Тип занятия').selectOption(kind)
  await dialog.getByRole('button', { name: 'Сохранить' }).click()
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

  const updatedCard = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: '18:15–19:45' })
  await updatedCard.getByRole('button', { name: 'Перенести' }).click()
  let moveDialog = firstPage.getByRole('dialog', { name: 'Перенести занятие' })
  await moveDialog.getByLabel('Время начала · Москва').fill('20:00')
  await moveDialog.getByLabel('Время окончания · Москва').fill('21:30')
  await moveDialog.getByRole('button', { name: 'Сохранить' }).click()
  await moveDialog.waitFor({ state: 'hidden' })
  const movedOriginal = firstPage
    .locator('.staff-schedule__lesson.is-moved')
    .filter({ hasText: subjectName })
    .first()
  await movedOriginal.getByRole('button', { name: 'Следующее занятие' }).click()
  await firstPage.getByText('20:00–21:30').waitFor()
  const firstMoved = firstPage
    .locator('.staff-schedule__lesson')
    .filter({ hasText: subjectName })
    .filter({ hasText: '20:00–21:30' })
  await firstMoved.getByRole('button', { name: 'Перенести' }).click()
  moveDialog = firstPage.getByRole('dialog', { name: 'Перенести занятие' })
  await moveDialog.getByLabel('Время начала · Москва').fill('22:00')
  await moveDialog.getByLabel('Время окончания · Москва').fill('23:00')
  await moveDialog.getByRole('button', { name: 'Сохранить' }).click()
  await moveDialog.waitFor({ state: 'hidden' })
  await firstPage.getByText('22:00–23:00').waitFor()
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
  await firstDraft.getByRole('button', { name: 'Загрузить актуальную версию отдельно' }).click()
  await firstDraft.getByRole('button', { name: /Использовать только номер версии/ }).click()
  await firstDraft.getByRole('button', { name: 'Сохранить' }).click()
  await firstDraft.waitFor({ state: 'hidden' })
  pass(
    'two real staff sessions receive version_conflict; local draft stays until explicit version adoption',
  )

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
  await firstPage.goBack()
  const navigationWarning = firstPage.getByRole('dialog', { name: 'Выйти без сохранения?' })
  await navigationWarning.getByRole('button', { name: 'Продолжить редактирование' }).click()
  assert.equal(await mobileDialog.getByLabel('Время начала · Москва').inputValue(), '09:15')
  await mobileDialog.getByRole('button', { name: 'Отмена' }).click()
  await firstPage
    .getByRole('alertdialog', { name: 'Закрыть черновик?' })
    .getByRole('button', { name: 'Закрыть без сохранения' })
    .click()
  await mobileDialog.waitFor({ state: 'hidden' })
  assert.ok(await addTrigger.evaluate((element) => document.activeElement === element))
  await firstPage.setViewportSize({ width: 1440, height: 1000 })
  pass('360/1440px layout, Escape, unsaved draft warning and restored trigger focus')

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
