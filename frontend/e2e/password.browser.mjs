/* global process, URL, document, console */
// Exercise password flows with the live API/PostgreSQL fixture through Chromium.
import assert from 'node:assert/strict'

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { chromium } = playwright.default ?? playwright
const baseURL = process.env.PASSWORD_E2E_URL || 'http://localhost:5173'
const initialPassword = process.env.PASSWORD_E2E_INITIAL_PASSWORD
assert.ok(initialPassword, 'Provide the fictional PASSWORD_E2E_INITIAL_PASSWORD fixture')

const roles = ['student', 'teacher', 'staff', 'admin']
const credentials = Object.fromEntries(
  roles.map((role) => [
    role,
    {
      login: process.env[`PASSWORD_E2E_${role.toUpperCase()}_LOGIN`],
      id: process.env[`PASSWORD_E2E_${role.toUpperCase()}_ID`],
    },
  ]),
)
for (const role of roles) {
  assert.ok(credentials[role].login, `Missing fictional ${role} login`)
  assert.ok(credentials[role].id, `Missing fictional ${role} ID`)
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  timeout: 15_000,
  args: ['--no-sandbox'],
})
const contexts = []
const roleContexts = {}
const check = (name) => console.log(`PASS ${name}`)
const assertNoHorizontalOverflow = async (page, width, scenario) => {
  const actual = await page.evaluate(() => document.documentElement.scrollWidth)
  assert.ok(actual <= width, `${scenario}: ${actual}px document overflow at ${width}px`)
}
const login = async (page, loginName, password) => {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(loginName)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  try {
    await page.getByRole('button', { name: 'Меню пользователя' }).waitFor()
  } catch (error) {
    console.error(`Login UI did not reach the cabinet: ${await page.locator('body').innerText()}`)
    throw error
  }
}
const openSettingsFromMenu = async (page) => {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('heading', { name: 'Смена пароля' }).waitFor()
}
const fillAndChange = async (page, currentPassword, nextPassword) => {
  await page.getByRole('textbox', { name: 'Действующий пароль', exact: true }).fill(currentPassword)
  await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).fill(nextPassword)
  await page
    .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
    .fill(nextPassword)
  await page.getByRole('button', { name: 'Сменить пароль' }).click()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
}

try {
  for (const [index, role] of roles.entries()) {
    const { login: loginName } = credentials[role]
    const context = await browser.newContext({ viewport: { width: 360, height: 850 } })
    roleContexts[role] = context
    contexts.push(context)
    const page = await context.newPage()
    let passwordPostCount = 0
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname === '/api/v1/auth/password' &&
        request.method() === 'POST'
      )
        passwordPostCount += 1
    })
    await login(page, loginName, initialPassword)
    await assertNoHorizontalOverflow(page, 360, `${role} cabinet`)
    await openSettingsFromMenu(page)
    await assertNoHorizontalOverflow(page, 360, `${role} settings`)
    if (role === 'student') {
      const currentField = page.getByRole('textbox', { name: 'Действующий пароль', exact: true })
      const newField = page.getByRole('textbox', { name: 'Новый пароль', exact: true })
      const confirmationField = page.getByRole('textbox', {
        name: 'Повторите новый пароль',
        exact: true,
      })
      await currentField.focus()
      await page.keyboard.press('Tab')
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Показать действующий пароль',
      )
      await page.keyboard.press('Enter')
      assert.equal(await currentField.getAttribute('type'), 'text')
      await page.keyboard.press('Tab')
      assert.equal(await newField.evaluate((input) => input === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Показать новый пароль',
      )
      await page.keyboard.press('Enter')
      assert.equal(await newField.getAttribute('type'), 'text')
      await page.keyboard.press('Tab')
      assert.equal(
        await confirmationField.evaluate((input) => input === document.activeElement),
        true,
      )
      await page.keyboard.press('Tab')
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        'Показать подтверждение пароля',
      )
      await page.keyboard.press('Enter')
      assert.equal(await confirmationField.getAttribute('type'), 'text')
      await page.keyboard.press('Tab')
      assert.equal(
        await page
          .getByRole('button', { name: 'Сменить пароль' })
          .evaluate((button) => button === document.activeElement),
        true,
      )
      await page.getByRole('button', { name: 'Скрыть действующий пароль' }).click()
      await page.getByRole('button', { name: 'Скрыть новый пароль' }).click()
      await page.getByRole('button', { name: 'Скрыть подтверждение пароля' }).click()
      await confirmationField.focus()
    }
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Действующий пароль', exact: true })
        .getAttribute('type'),
      'password',
    )
    await page
      .getByRole('textbox', { name: 'Действующий пароль', exact: true })
      .fill(initialPassword)
    await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).fill('too short')
    await page
      .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
      .fill('too short')
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
    await page.getByText('Новый пароль должен содержать от 12 до 128 Unicode-символов.').waitFor()
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Новый пароль', exact: true })
        .evaluate((input) => input === document.activeElement),
      true,
    )
    await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).fill('x'.repeat(129))
    await page
      .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
      .fill('x'.repeat(129))
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
    await page.getByText('Новый пароль должен содержать от 12 до 128 Unicode-символов.').waitFor()
    assert.equal(passwordPostCount, 0, 'A 129-code-point password must be rejected locally')
    await page
      .getByRole('textbox', { name: 'Новый пароль', exact: true })
      .fill('fictional new phrase')
    await page.getByRole('textbox', { name: 'Повторите новый пароль', exact: true }).fill('')
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
    await page.getByText('Повторите новый пароль.').waitFor()
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
        .evaluate((input) => input === document.activeElement),
      true,
    )
    await page
      .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
      .fill('mismatched confirmation')
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
    await page.getByText('Пароли не совпадают.').waitFor()
    await page
      .getByRole('textbox', { name: 'Новый пароль', exact: true })
      .fill('fictional new phrase')
    await page
      .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
      .fill('fictional new phrase')
    await page
      .getByRole('textbox', { name: 'Действующий пароль', exact: true })
      .fill('fictional-wrong-current')
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
    await page.getByText('Действующий пароль неверен.').waitFor()
    assert.equal(passwordPostCount, 1, 'Invalid current-password input makes one request')
    await page.getByRole('button', { name: 'Меню пользователя' }).waitFor()
    await page
      .getByRole('textbox', { name: 'Действующий пароль', exact: true })
      .fill(initialPassword)
    await page.getByRole('button', { name: 'Показать новый пароль' }).click()
    assert.equal(
      await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).getAttribute('type'),
      'text',
    )
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Действующий пароль', exact: true })
        .getAttribute('type'),
      'password',
    )
    await page.getByRole('button', { name: 'Скрыть новый пароль' }).click()

    // A second page in this browser storage partition receives the terminal auth epoch.
    const sibling = await context.newPage()
    await sibling.goto(`${baseURL}/settings`)
    await sibling.getByRole('heading', { name: 'Смена пароля' }).waitFor()

    // A separate context models another device with an independent refresh cookie.
    const device = await browser.newContext({ viewport: { width: 360, height: 850 } })
    contexts.push(device)
    const devicePage = await device.newPage()
    await login(devicePage, loginName, initialPassword)

    const newPassword = `Fictional ${role} phrase ${index + 1} 2026`
    if (role === 'student') {
      let releasePost
      let signalRequest
      const requestStarted = new Promise((resolve) => {
        signalRequest = resolve
      })
      const holdRequest = new Promise((resolve) => {
        releasePost = resolve
      })
      let delayedPostCount = 0
      await page.route('**/api/v1/auth/password', async (route) => {
        delayedPostCount += 1
        signalRequest()
        await holdRequest
        await route.continue()
      })
      await page
        .getByRole('textbox', { name: 'Действующий пароль', exact: true })
        .fill(initialPassword)
      await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).fill(newPassword)
      const confirmation = page.getByRole('textbox', {
        name: 'Повторите новый пароль',
        exact: true,
      })
      await confirmation.fill(newPassword)
      await confirmation.press('Enter')
      await requestStarted
      const pendingButton = page.getByRole('button', { name: 'Сохраняем…', exact: true })
      await pendingButton.waitFor()
      assert.equal(await pendingButton.isDisabled(), true)
      assert.equal(
        await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).isDisabled(),
        true,
      )
      await page.keyboard.press('Enter')
      assert.equal(delayedPostCount, 1, 'A delayed password change must not submit twice')
      releasePost()
      await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
      await page.unroute('**/api/v1/auth/password')
      assert.equal(delayedPostCount, 1, 'The successful delayed change must be submitted once')
    } else {
      await fillAndChange(page, initialPassword, newPassword)
    }
    await page.getByRole('status').filter({ hasText: 'Пароль изменён' }).waitFor()
    await sibling.getByRole('heading', { name: 'Вход в систему' }).waitFor()

    await devicePage.goto(`${baseURL}/settings`)
    await devicePage.getByRole('heading', { name: 'Вход в систему' }).waitFor()
    if (role === 'teacher') {
      await login(page, loginName, newPassword)
      await openSettingsFromMenu(page)
      let lostSelfChangeCount = 0
      const uncertainPassword = 'Fictional teacher uncertain result 2026'
      await page.route('**/api/v1/auth/password', async (route) => {
        lostSelfChangeCount += 1
        await route.fetch()
        await route.abort('failed')
      })
      await page.getByRole('textbox', { name: 'Действующий пароль', exact: true }).fill(newPassword)
      await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).fill(uncertainPassword)
      await page
        .getByRole('textbox', { name: 'Повторите новый пароль', exact: true })
        .fill(uncertainPassword)
      await page.getByRole('button', { name: 'Сменить пароль' }).click()
      await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
      await page
        .getByRole('status')
        .filter({ hasText: 'Результат смены пароля неизвестен' })
        .waitFor()
      assert.equal(lostSelfChangeCount, 1, 'A self-change with a lost response must not be retried')
      await page.unroute('**/api/v1/auth/password')
      await login(page, loginName, uncertainPassword)
    } else {
      await login(page, loginName, newPassword)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await openSettingsFromMenu(page)
    await assertNoHorizontalOverflow(page, 1440, `${role} desktop settings`)
    assert.ok(await page.getByRole('textbox', { name: 'Новый пароль', exact: true }).isVisible())
    check(`${role} invalid-password recovery, self-change, other tabs/devices, and 360/1440 px`)
  }

  const admin = roleContexts.admin
  const page = admin.pages()[0]
  const teacherId = credentials.teacher.id
  const teacherLogin = credentials.teacher.login
  await page.goto(`${baseURL}/admin/users`)
  await page.getByLabel('Логин или ФИО').fill(teacherLogin)
  await page.getByRole('button', { name: 'Найти' }).click()
  await page
    .getByRole('row')
    .filter({ hasText: teacherLogin })
    .getByRole('link', { name: /Подробнее/ })
    .click()
  await page.getByRole('heading', { name: 'Fictional Password E2E teacher' }).waitFor()
  assert.equal(new URL(page.url()).pathname, `/admin/users/${teacherId}`)

  let lostResponseCount = 0
  await page.route(`**/api/v1/admin/users/${teacherId}/password-reset`, async (route) => {
    lostResponseCount += 1
    await route.fetch()
    await route.abort('failed')
  })
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  await page.getByRole('alert').filter({ hasText: 'Пароль мог измениться' }).waitFor()
  assert.equal(lostResponseCount, 1, 'A reset with a lost response must not be retried')
  await page.unroute(`**/api/v1/admin/users/${teacherId}/password-reset`)
  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  const lostResponseRecoveredSecret = await page.locator('.admin-secret').textContent()
  assert.ok(lostResponseRecoveredSecret && lostResponseRecoveredSecret.length >= 32)

  // Commit a reset, then fail only the follow-up GET. The one-time secret must
  // remain visible until explicitly closed, without retrying the POST.
  let committedGetFailures = 0
  let committedPostCount = 0
  await page.route(`**/api/v1/admin/users/${teacherId}`, async (route) => {
    if (route.request().method() === 'GET') {
      committedGetFailures += 1
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    } else {
      await route.continue()
    }
  })
  await page.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }).click()
  await page.getByRole('heading', { name: 'Fictional Password E2E teacher' }).waitFor()
  const handleCommittedReset = async (route) => {
    committedPostCount += 1
    await route.continue()
  }
  await page.route(`**/api/v1/admin/users/${teacherId}/password-reset`, handleCommittedReset)
  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  const secretAfterGetFailure = await page.locator('.admin-secret').textContent()
  assert.ok(secretAfterGetFailure && secretAfterGetFailure.length >= 32)
  await page.getByRole('heading', { name: 'Пароль сброшен' }).waitFor()
  assert.equal(committedGetFailures, 1, 'The post-commit user GET must fail once')
  assert.equal(committedPostCount, 1, 'The successful reset must not be retried')
  await page.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.locator('.admin-secret').count(), 0)
  await page.unroute(`**/api/v1/admin/users/${teacherId}/password-reset`, handleCommittedReset)
  await page.unroute(`**/api/v1/admin/users/${teacherId}`)
  await page.getByRole('link', { name: 'К списку', exact: true }).click()
  await page.getByRole('heading', { name: 'Пользователи' }).waitFor()
  await page.getByRole('link', { name: new RegExp(teacherLogin) }).click()
  await page.getByRole('heading', { name: 'Fictional Password E2E teacher' }).waitFor()
  assert.equal(
    await page.locator('.admin-secret').count(),
    0,
    'Closing and remounting must discard the secret',
  )

  // The server commits but malformed success payloads cannot expose or recover
  // the secret, and neither fault injection path may trigger an automatic POST retry.
  for (const [label, responseBody] of [
    ['malformed JSON', '{'],
    ['empty JSON', '{}'],
  ]) {
    let faultPostCount = 0
    await page.route(`**/api/v1/admin/users/${teacherId}/password-reset`, async (route) => {
      faultPostCount += 1
      await route.fetch()
      await route.fulfill({ status: 200, contentType: 'application/json', body: responseBody })
    })
    await page.getByRole('button', { name: 'Сбросить пароль' }).click()
    await page.getByRole('alert').filter({ hasText: 'Пароль мог измениться' }).waitFor()
    assert.equal(faultPostCount, 1, `${label} must not cause an automatic retry`)
    assert.equal(await page.locator('.admin-secret').count(), 0)
    await page.unroute(`**/api/v1/admin/users/${teacherId}/password-reset`)
    await page.getByRole('link', { name: 'К списку пользователей' }).click()
    await page.getByRole('heading', { name: 'Пользователи' }).waitFor()
    await page.getByRole('link', { name: new RegExp(teacherLogin) }).click()
    await page.getByRole('heading', { name: 'Fictional Password E2E teacher' }).waitFor()
  }

  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  const secret = await page.locator('.admin-secret').textContent()
  assert.ok(secret && secret.length >= 32)
  await page.goBack()
  await page.getByRole('heading', { name: 'Пользователи' }).waitFor()
  await page.goForward()
  await page.getByRole('heading', { name: 'Fictional Password E2E teacher' }).waitFor()
  assert.equal(
    await page.locator('.admin-secret').count(),
    0,
    'Browser Back must discard the reset secret',
  )
  await page.getByRole('button', { name: 'Сбросить пароль' }).click()
  const latestSecret = await page.locator('.admin-secret').textContent()
  assert.ok(latestSecret && latestSecret.length >= 32)
  await page.getByRole('button', { name: 'Закрыть и удалить пароль с экрана' }).click()
  assert.equal(await page.locator('.admin-secret').count(), 0)
  await page.reload()
  assert.equal(await page.getByText(latestSecret, { exact: true }).count(), 0)
  const verificationContext = await browser.newContext({ viewport: { width: 360, height: 850 } })
  contexts.push(verificationContext)
  const verificationPage = await verificationContext.newPage()
  await verificationPage.goto(`${baseURL}/login`)
  await verificationPage.getByLabel('Логин', { exact: true }).fill(teacherLogin)
  await verificationPage
    .getByLabel('Пароль', { exact: true })
    .fill('Fictional teacher phrase 2 2026')
  await verificationPage.getByRole('button', { name: 'Войти', exact: true }).click()
  await verificationPage
    .getByRole('status')
    .filter({ hasText: 'Неверный логин или пароль' })
    .waitFor()
  await verificationPage.getByLabel('Пароль', { exact: true }).fill(latestSecret)
  await verificationPage.getByRole('button', { name: 'Войти', exact: true }).click()
  await verificationPage.getByRole('button', { name: 'Меню пользователя' }).waitFor()
  check('admin one-time reset, lost-response handling, and no re-display')
} finally {
  await Promise.all(contexts.map((context) => context.close()))
  await browser.close()
}
