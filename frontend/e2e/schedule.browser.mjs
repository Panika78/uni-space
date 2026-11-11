/* global process, console, document, window, URL, Event */
// Real backend and fictional deploy/schedule_fixtures.py; faults are scoped to schedule reads.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SCHEDULE_TEST_URL || 'http://localhost:5173'
const password = process.env.SCHEDULE_TEST_PASSWORD
assert.ok(password, 'Provide fictional SCHEDULE_TEST_PASSWORD')
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const check = (message) => console.log(`PASS ${message}`)
async function login(page, account = 'schedule-fixture-1', navigate = true) {
  if (navigate) await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill(account)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  await page.locator('.schedule-list').waitFor()
}
async function logout(page) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
}
async function checkStudentProfile(page, number) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('link', { name: 'Мой профиль', exact: true }).click()
  await page.getByRole('heading', { name: 'Мой профиль', exact: true }).waitFor()
  const profile = await page.locator('.profile-page').innerText()
  assert.ok(profile.includes(`Вымышленный Студент ${number}`))
  assert.ok(profile.includes(`schedule-fixture-${number}`))
  assert.ok(profile.includes(`ТЕСТ-${number}`))
  assert.ok(!profile.includes(`Вымышленный Студент ${number === 1 ? 2 : 1}`))
  const menu = page.getByRole('button', { name: 'Открыть меню', exact: true })
  if (await menu.isVisible()) {
    await menu.click()
    await page
      .getByRole('dialog', { name: 'Мобильная навигация' })
      .getByRole('link', { name: 'Расписание', exact: true })
      .click()
  } else await page.getByRole('link', { name: 'Расписание', exact: true }).click()
  await page.locator('.schedule-list').waitFor()
}
async function startDelayedProfileRead(page, clientURL) {
  assert.ok(clientURL, 'Real shared HTTP client module was loaded by Vite')
  await page.evaluate(async (url) => {
    const { apiFetch } = await import(url)
    window.delayedProfileStatus = 'pending'
    void apiFetch('/api/v1/users/me', { authenticated: true }).then(
      () => {
        window.delayedProfileStatus = 'resolved'
      },
      (error) => {
        window.delayedProfileStatus = error.name
      },
    )
  }, clientURL)
}
// Headless Chromium keeps background pages visible. Exercise its real visibilitychange
// listener with controlled document visibility; requests still use the real API.
async function setScheduleVisibility(page, state) {
  await page.evaluate((visibility) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  }, state)
}
async function waitForScheduleRefresh(page, action) {
  // A cached week can already be refetching; let it finish before asserting a new request.
  await page.waitForLoadState('networkidle')
  const result = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/schedule',
  )
  await action()
  const response = await result
  assert.equal(response.status(), 200)
  const data = await response.json()
  await page.waitForLoadState('networkidle')
  return data
}
async function checkOvernightDates(page) {
  const overnight = page
    .locator('.schedule-day.is-selected .lesson-card')
    .filter({ hasText: 'Занятие через полночь' })
  assert.deepEqual(await overnight.locator('time').allTextContents(), [
    'вторник, 10 ноября, 23:30',
    'среда, 11 ноября, 00:30',
  ])
}

async function noOverflow(page) {
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'No horizontal page overflow',
  )
  assert.ok(
    await page.locator('.lesson-card:visible').evaluateAll((cards) =>
      cards.every((card) => {
        const bounds = card.getBoundingClientRect()
        return [...card.querySelectorAll('h3, p, time, li')].every((child) => {
          const rect = child.getBoundingClientRect()
          return rect.left >= bounds.left && rect.right <= bounds.right + 1
        })
      }),
    ),
    'Long names stay inside cards',
  )
}
try {
  for (const [timezoneId, width] of [
    ['America/Los_Angeles', 1440],
    ['Asia/Tokyo', 360],
    ['UTC', 360],
  ]) {
    const context = await browser.newContext({ timezoneId, viewport: { width, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    let clientURL
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/src/shared/api/client.ts') clientURL = request.url()
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-11-09T21:30:00Z') })
    await page.goto(`${baseURL}/schedule`)
    await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
    await login(page)
    await checkStudentProfile(page, 1)
    await page.goto(`${baseURL}/schedule/unknown-integration-path`)
    await page.getByRole('heading', { name: 'Страница не найдена' }).waitFor()
    await page.getByRole('link', { name: 'Вернуться к расписанию' }).click()
    await page.locator('.schedule-list').waitFor()
    assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-10')
    assert.ok(
      (await page.locator('.schedule-day.is-selected').innerText()).includes(
        'Только первая группа',
      ),
    )
    assert.equal(await page.getByText('Только вторая группа', { exact: true }).count(), 0)
    const shared = page
      .locator('.lesson-card:visible')
      .filter({ hasText: 'методы математического' })
    assert.equal(await shared.count(), 1)
    assert.ok((await shared.innerText()).includes('09:00'))
    assert.equal(await shared.locator('li').count(), 2)
    assert.equal((await shared.locator('.lesson-card__time').innerText()).trim(), '09:00 — 10:00')
    await checkOvernightDates(page)
    await page.getByLabel('Дата', { exact: true }).fill('2026-11-11')
    await checkOvernightDates(page)
    await noOverflow(page)
    await page.getByLabel('Дата', { exact: true }).fill('2026-11-10')
    await setScheduleVisibility(page, 'hidden')
    const focused = await waitForScheduleRefresh(page, () => setScheduleVisibility(page, 'visible'))
    assert.ok(
      focused.items.some((item) => item.course_offering.discipline.name === 'Только первая группа'),
    )
    await context.setOffline(true)
    const reconnected = await waitForScheduleRefresh(page, () => context.setOffline(false))
    assert.ok(
      reconnected.items.some(
        (item) => item.course_offering.discipline.name === 'Только первая группа',
      ),
    )
    check(
      `${timezoneId}: focus/reconnect fetch real schedule; both Moscow dates on both overnight days; ordinary times stay compact`,
    )
    await noOverflow(page)
    await page.screenshot({
      path: new URL(
        `../../work/schedule-${width}-${timezoneId.replaceAll('/', '-')}.png`,
        import.meta.url,
      ).pathname,
      fullPage: true,
    })
    const refreshResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/refresh',
    )
    await page.reload()
    assert.equal((await refreshResponse).status(), 200)
    await page.locator('.schedule-list').waitFor()
    await checkStudentProfile(page, 1)
    assert.ok(
      (await page.locator('.schedule-day.is-selected').innerText()).includes(
        'Только первая группа',
      ),
    )
    check(
      `${timezoneId}, ${width}px: Moscow today, real login/reload, rooms and private group isolation`,
    )
    if (width === 1440) {
      const week = page.getByRole('button', { name: 'Неделя', exact: true })
      await week.focus()
      await page.keyboard.press('Enter')
      assert.equal(await week.getAttribute('aria-pressed'), 'true')
      assert.equal(await page.locator('.schedule-day:visible').count(), 7)
      assert.equal(await page.getByText('Занятие через полночь', { exact: true }).count(), 2)
      assert.ok(await page.getByText('Воскресное занятие', { exact: true }).isVisible())
      await page.getByRole('button', { name: 'День', exact: true }).click()
      await page.getByRole('button', { name: 'Следующий день' }).click()
      assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-11')
      assert.ok(await page.getByText('Занятие через полночь', { exact: true }).last().isVisible())
      check('Desktop keyboard day/week; vertical seven days; midnight lesson appears on both days')
    }
    await page.getByLabel('Дата', { exact: true }).fill('2026-11-15')
    assert.ok(await page.getByText('Воскресное занятие', { exact: true }).isVisible())
    const sunday = page.getByRole('group', { name: 'Дни недели' }).getByRole('button').last()
    assert.equal(await sunday.getAttribute('aria-pressed'), 'true')
    await sunday.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Следующая неделя' }).click()
    await page.locator('.schedule-list').waitFor()
    assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-22')
    await page.getByRole('button', { name: 'Предыдущая неделя' }).click()
    await page.locator('.schedule-list').waitFor()
    await page.getByRole('button', { name: 'Сегодня', exact: true }).focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-10')
    await noOverflow(page)
    check('Date input, week switching, Sunday selector, keyboard today and 360px long names')
    if (timezoneId === 'America/Los_Angeles') {
      await page.getByLabel('Дата', { exact: true }).fill('2026-12-31')
      await page.locator('.schedule-list').waitFor()
      assert.equal(
        await page.locator('.schedule-day.is-selected .schedule-empty').innerText(),
        'Занятий нет',
      )
      await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
      await page.locator('.schedule-list').waitFor()
      await page.waitForLoadState('networkidle')
      let releaseOldResponse
      const oldResponseGate = new Promise((resolve) => {
        releaseOldResponse = resolve
      })
      let markOldResponseReady
      const oldResponseReady = new Promise((resolve) => {
        markOldResponseReady = resolve
      })
      let holdFirstResponse = true
      await page.route('**/api/v1/schedule?**', async (route) => {
        if (!holdFirstResponse) return route.continue()
        holdFirstResponse = false
        const response = await route.fetch()
        markOldResponseReady()
        await oldResponseGate
        try {
          await route.fulfill({ response })
        } catch {
          /* The old request was cancelled at logout. */
        }
      })
      // Start a new document so this delayed-response test cannot reuse an in-flight refetch.
      // Delayed focus/reconnect refreshes within one auth provider are covered by Vitest.
      await page.reload()
      await Promise.race([
        oldResponseReady,
        delay(30000, undefined, { ref: false }).then(() => {
          throw new Error('Timed out waiting for the buffered background schedule response')
        }),
      ])
      let markOldProfileReady
      const oldProfileReady = new Promise((resolve) => {
        markOldProfileReady = resolve
      })
      let holdFirstProfile = true
      await page.route('**/api/v1/users/me', async (route) => {
        if (!holdFirstProfile) return route.continue()
        holdFirstProfile = false
        const response = await route.fetch()
        markOldProfileReady()
        await oldResponseGate
        try {
          await route.fulfill({ response })
        } catch {
          /* Old auth generation was cancelled. */
        }
      })
      await startDelayedProfileRead(page, clientURL)
      await Promise.race([
        oldProfileReady,
        delay(30000, undefined, { ref: false }).then(() => {
          throw new Error('Timed out buffering old profile')
        }),
      ])
      await logout(page)
      await login(page, 'schedule-fixture-2', false)
      releaseOldResponse()
      await page.unroute('**/api/v1/users/me')
      await page.waitForFunction(() => window.delayedProfileStatus === 'AbortError')
      await checkStudentProfile(page, 2)
      await page.unroute('**/api/v1/schedule?**')
      await context.setOffline(true)
      await waitForScheduleRefresh(page, () => context.setOffline(false))
      assert.equal(await page.getByText('Только первая группа', { exact: true }).count(), 0)
      assert.ok(await page.getByText('Только вторая группа', { exact: true }).isVisible())
      await logout(page)
      await page.reload()
      await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
      await login(page)
      await checkStudentProfile(page, 1)
      assert.equal(await page.getByText('Только вторая группа', { exact: true }).count(), 0)
      check(
        'Empty day, account switching, delayed old profile/schedule responses, reconnect after account change, logout/reload; no old account data',
      )
      for (const fault of ['network', 500, 403]) {
        await page.route('**/api/v1/schedule?**', (route) =>
          fault === 'network'
            ? route.abort('failed')
            : route.fulfill({
                status: fault,
                contentType: 'application/json',
                body: JSON.stringify({
                  error: {
                    code: fault === 403 ? 'forbidden' : 'internal_error',
                    message: 'test',
                    details: [],
                  },
                }),
              }),
        )
        await page.getByRole('button', { name: 'Следующая неделя' }).click()
        const alert = page.getByRole('alert')
        await alert.waitFor()
        assert.ok(
          (await alert.innerText()).includes(
            fault === 403 ? 'Нет доступа' : 'Не удалось загрузить',
          ),
        )
        assert.equal(await page.locator('.schedule-empty:visible').count(), 0)
        await page.unroute('**/api/v1/schedule?**')
        if (fault !== 403) {
          await page.getByRole('button', { name: 'Повторить' }).click()
          await page.locator('.schedule-list').waitFor()
        } else {
          await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
          await page.locator('.schedule-list').waitFor()
        }
      }
      check('Network/500 retry and 403 distinguished from empty state')
    }
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally {
  await browser.close()
}
