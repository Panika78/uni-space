/* global process, console, document, window */
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
const check = (message) => console.log(`PASS ${message}`)

async function login(page, account, password) {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(account)
  await page.getByLabel('Пароль').fill(password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
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
) {
  await login(page, account, password)
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.locator('.schedule-list').waitFor()
  await page.getByRole('button', { name: 'Неделя', exact: true }).click()
  const date = account === 'demo-pz101' ? '2026-11-26' : '2026-11-17'
  await page.getByLabel('Дата', { exact: true }).fill(date)
  await page.getByText(course, { exact: false }).first().waitFor()
  await assertTextFitsCard(page, course, '.schedule-day.is-selected')
  await assertTextFitsCard(page, venue, '.schedule-day.is-selected')
  await page.setViewportSize({ width: 360, height: 800 })
  await page.locator('.schedule-days button').filter({ hasText: weekday }).click()
  await noOverflow(page, 360)
  await assertTextFitsCard(page, course, '.schedule-day.is-selected')
  await assertTextFitsCard(page, venue, '.schedule-day.is-selected')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow(page, 1440)

  await page.goto(`${baseURL}/profile`)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('heading', { name: 'Мой профиль', exact: true }).waitFor()
  const profile = await page.locator('.profile-page').innerText()
  assert.ok(profile.includes(name))
  assert.ok(profile.includes(program))
  await noOverflow(page, 360)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow(page, 1440)
  await page.setViewportSize({ width: 360, height: 800 })

  await page.goto(`${baseURL}/academics`)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('heading', { name: 'Успеваемость', exact: true }).waitFor()
  await page.getByText(grade, { exact: true }).first().waitFor()
  await noOverflow(page, 360)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow(page, 1440)
  await page.setViewportSize({ width: 360, height: 800 })

  await page.goto(`${baseURL}/news`)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('heading', { name: 'Новости', exact: true }).waitFor()
  await page.getByText('Об изменении расписания занятий 19 ноября', { exact: false }).waitFor()
  await noOverflow(page, 360)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow(page, 1440)
  await page.setViewportSize({ width: 360, height: 800 })

  await page.getByRole('button', { name: 'Уведомления' }).click()
  await page.setViewportSize({ width: 360, height: 800 })
  const notifications = page.getByRole('dialog', { name: 'Уведомления' })
  await notifications.waitFor()
  await notifications
    .getByText(
      name === 'Иван Сергеевич Гончаров'
        ? 'План на первую сессию'
        : 'Результаты текущих работ обновлены',
    )
    .waitFor()
  await noOverflow(page, 360)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow(page, 1440)
  await page.setViewportSize({ width: 360, height: 800 })
  await notifications.getByRole('button', { name: 'Закрыть уведомления' }).click()

  await page.goto(`${baseURL}/services`)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.getByRole('heading', { name: 'Услуги и документы', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Подать заявление' }).waitFor()
  await noOverflow(page, 360)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await noOverflow(page, 1440)
  check(
    `${account}: real schedule, profile, grades, news, notifications and service screen at 360px`,
  )
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
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
  )
} finally {
  await browser.close()
}
