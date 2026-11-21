/* global process, console, document, window, URL, Event, Element, AbortController */
// Real backend and fictional deploy/schedule_fixtures.py; faults are scoped to schedule reads.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SCHEDULE_TEST_URL || 'http://localhost:5173'
const password = process.env.SCHEDULE_TEST_PASSWORD
assert.ok(password, 'Provide fictional SCHEDULE_TEST_PASSWORD')
let responsiveLayoutWaitSequence = 0
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
  const submit = async () => {
    const result = page.waitForResponse((r) => r.url().endsWith('/auth/login'))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    return result
  }
  let result = await submit()
  if (result.status() === 429) {
    // Extra account-switching scenarios share the real server's IP rate limit.
    // Model a user explicitly retrying after Retry-After; the app never retries login.
    console.log('Waiting for the real login rate-limit window')
    await delay((Number(result.headers()['retry-after']) + 1) * 1000)
    result = await submit()
  }
  assert.equal(result.status(), 200)
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

async function assertModeHighlight(page) {
  await page.waitForFunction(
    () => {
      const modes = document.querySelector('.schedule-modes')
      const selected = modes?.querySelector('[aria-pressed="true"]')
      if (!modes || !selected) return false
      const selectedBounds = selected.getBoundingClientRect()
      const bounds = modes.getBoundingClientRect()
      const style = window.getComputedStyle(selected)
      const accentProbe = document.createElement('span')
      accentProbe.style.color = 'var(--accent)'
      document.body.append(accentProbe)
      const accent = window.getComputedStyle(accentProbe).color
      accentProbe.remove()
      return (
        style.backgroundColor === accent &&
        style.color === 'rgb(255, 255, 255)' &&
        selectedBounds.left >= bounds.left &&
        selectedBounds.right <= bounds.right &&
        selectedBounds.top >= bounds.top &&
        selectedBounds.bottom <= bounds.bottom &&
        window.getComputedStyle(modes, '::before').content === 'none'
      )
    },
    null,
    { timeout: 5000 },
  )
}

async function waitForPreference(page, show) {
  await page.waitForFunction((value) => {
    const input = document.querySelector('.schedule-cancelled-toggle input')
    return input && !input.disabled && !input.indeterminate && input.checked === value
  }, show)
}

async function checkUnknownPreference(page) {
  let readMode = 'error'
  let release
  let markHeld
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const held = new Promise((resolve) => {
    markHeld = resolve
  })
  let patches = 0
  const countPatch = (request) => {
    if (request.url().endsWith('/preferences') && request.method() === 'PATCH') patches++
  }
  page.on('request', countPatch)
  const handler = async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    if (readMode === 'error')
      return route.fulfill({
        status: 500,
        json: { error: { code: 'internal_error', message: 'test', details: [] } },
      })
    markHeld()
    await gate
    return route.continue()
  }
  await page.route('**/api/v1/users/me/preferences', handler)
  await page.reload()
  await page.locator('.schedule-list').waitFor()
  await page.getByRole('alert').filter({ hasText: 'Не удалось загрузить настройку' }).waitFor()
  async function assertUnknown() {
    assert.ok(await page.getByRole('checkbox').isDisabled())
    assert.ok(
      await page.getByRole('checkbox').evaluate((input) => input.indeterminate && !input.checked),
    )
    assert.equal(await page.locator('.lesson-card--cancelled').count(), 0)
    assert.ok((await page.locator('.lesson-card--scheduled:visible').count()) > 0)
    assert.equal(patches, 0)
  }
  await assertUnknown()
  readMode = 'delayed'
  await page.getByRole('button', { name: 'Повторить загрузку настройки' }).click()
  await held
  await assertUnknown()
  release()
  await waitForPreference(page, false)
  assert.equal(await page.locator('.lesson-card--cancelled').count(), 0)
  assert.equal(patches, 0)
  await page.unroute('**/api/v1/users/me/preferences', handler)
  page.off('request', countPatch)
  check(
    'F-03: saved false stays concealed during failed/delayed GET, normal schedule remains available, retry restores real value without PATCH',
  )
}

async function checkUncertainPreference(page) {
  for (const fault of ['never', 'lost', 'late']) {
    // A fresh document resets the test's previous fault state, never server data.
    await page.reload()
    await page.locator('.schedule-list').waitFor()
    const toggle = page.getByRole('checkbox', { name: 'Показывать отменённые' })
    await page.waitForFunction(
      () => !document.querySelector('.schedule-cancelled-toggle input').disabled,
    )
    if (await toggle.isChecked()) {
      await toggle.click()
      await waitForPreference(page, false)
    }
    let releaseSend
    let releaseResponse
    let markCommitted
    const sendGate = new Promise((resolve) => {
      releaseSend = resolve
    })
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve
    })
    const committed = new Promise((resolve) => {
      markCommitted = resolve
    })
    let patches = 0
    const handler = async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      patches++
      if (fault === 'late') await sendGate
      if (fault === 'never') {
        await responseGate
        try {
          await route.abort()
        } catch {
          /* Timed-out browser already aborted. */
        }
        return
      }
      // Forward the original request to the real API; only its response is withheld.
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      markCommitted()
      await responseGate
      try {
        await route.fulfill({ response })
      } catch {
        /* Timed-out browser already aborted. */
      }
    }
    await page.route('**/api/v1/users/me/preferences', handler)
    const started = Date.now()
    await toggle.click()
    const warning = page.getByRole('alert').filter({ hasText: 'Не удалось подтвердить сохранение' })
    await warning.waitFor({ timeout: 25_000 })
    assert.ok(Date.now() - started < 25_000, 'PATCH wait is bounded in real Chromium time')
    await waitForPreference(page, fault === 'lost')
    assert.ok((await warning.innerText()).includes('Предыдущий запрос ещё может завершиться'))
    assert.equal((await warning.innerText()).includes('Восстановлено'), false)
    assert.equal(patches, 1, 'No automatic PATCH replay')
    if (fault === 'late') {
      releaseSend()
      await committed
      await page.getByRole('button', { name: 'Проверить настройку', exact: true }).click()
      await waitForPreference(page, true)
      assert.ok(await warning.isVisible(), 'GET does not declare an old write impossible')
    }
    releaseSend()
    releaseResponse()
    await page.unroute('**/api/v1/users/me/preferences', handler)
    assert.equal(patches, 1)
    if (fault === 'never') {
      // Restored control permits a deliberate new choice; no hidden automatic write.
      await toggle.click()
      await waitForPreference(page, true)
      assert.ok(await warning.isVisible())
    }
    check(
      `F-04: ${fault} PATCH, deadline, real GET reconciliation, persistent uncertainty and usable control`,
    )
  }
  await page.reload()
  await page.locator('.schedule-list').waitFor()
  const toggle = page.getByRole('checkbox')
  await page.waitForFunction(
    () => !document.querySelector('.schedule-cancelled-toggle input').disabled,
  )
  if (await toggle.isChecked()) {
    await toggle.click()
    await waitForPreference(page, false)
  }
}

async function checkServerSaveFailures(page) {
  for (const status of [502, 500]) {
    await page.reload()
    await page.locator('.schedule-list').waitFor()
    const toggle = page.getByRole('checkbox', { name: 'Показывать отменённые' })
    await page.waitForFunction(
      () => !document.querySelector('.schedule-cancelled-toggle input').disabled,
    )
    if (await toggle.isChecked()) {
      await toggle.click()
      await waitForPreference(page, false)
    }
    let patches = 0
    let hasFailedPatch = false
    let releaseRead
    let markRead
    const readGate = new Promise((resolve) => {
      releaseRead = resolve
    })
    const reading = new Promise((resolve) => {
      markRead = resolve
    })
    const handler = async (route) => {
      if (route.request().method() === 'PATCH') {
        patches++
        if (status === 502) {
          const committed = await route.fetch()
          assert.equal(committed.status(), 200)
          assert.equal((await committed.json()).show_cancelled_lessons, true)
        }
        // 502 replaces a committed real backend response; 500 never forwards a write.
        hasFailedPatch = true
        return route.fulfill({
          status,
          json: { error: { code: 'internal_error', message: 'test', details: [] } },
        })
      }
      if (hasFailedPatch) {
        markRead()
        await readGate
      }
      return route.continue()
    }
    await page.route('**/api/v1/users/me/preferences', handler)
    await toggle.click()
    const warning = page.getByRole('alert').filter({ hasText: 'Не удалось подтвердить сохранение' })
    await warning.waitFor()
    await reading
    assert.equal(
      await toggle.isChecked(),
      false,
      'Last confirmed value remains during reconciliation',
    )
    assert.ok(await toggle.isDisabled())
    assert.equal(await page.locator('.lesson-card--cancelled').count(), 0)
    const readResponse = page.waitForResponse(
      (r) => r.url().endsWith('/preferences') && r.request().method() === 'GET',
    )
    releaseRead()
    assert.equal((await (await readResponse).json()).show_cancelled_lessons, status === 502)
    await waitForPreference(page, status === 502)
    assert.equal(
      await page.locator('.schedule-day.is-selected .lesson-card--cancelled').count(),
      status === 502 ? 1 : 0,
    )
    assert.equal(patches, 1, 'HTTP 5xx never automatically replays PATCH')
    assert.ok(await warning.isVisible(), 'One GET cannot rule out a later commit')
    await page.unroute('**/api/v1/users/me/preferences', handler)
    check(
      `R-01: HTTP ${status} ${status === 502 ? 'after PostgreSQL commit' : 'before commit'}, real GET sync and no PATCH replay`,
    )
  }
  await page.reload()
  await page.locator('.schedule-list').waitFor()
  await waitForPreference(page, false)
}

async function checkPreferences(page, width) {
  const toggle = page.getByRole('checkbox', { name: 'Показывать отменённые' })
  await toggle.waitFor()
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  // Explicitly reset fictional account state so each viewport run is independent.
  if (!(await toggle.isChecked())) {
    const reset = page.waitForResponse(
      (r) => r.url().endsWith('/preferences') && r.request().method() === 'PATCH',
    )
    const [response] = await Promise.all([reset, toggle.click()])
    assert.equal(response.status(), 200)
    await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  }
  const before = await page.locator('.schedule-gap').allTextContents()
  assert.deepEqual(before, ['Окно · 2 ч', 'Окно · 10 ч 30 мин'])
  const save = page.waitForResponse(
    (r) => r.url().endsWith('/preferences') && r.request().method() === 'PATCH',
  )
  const [response] = await Promise.all([save, toggle.click()])
  assert.equal(response.status(), 200)
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  assert.equal(await page.locator('.lesson-card--cancelled').count(), 0)
  assert.deepEqual(await page.locator('.schedule-gap').allTextContents(), before)
  await page.reload()
  await page.locator('.schedule-list').waitFor()
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  assert.equal(await toggle.isChecked(), false)
  await logout(page)
  await login(page, 'schedule-fixture-2', false)
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  assert.equal(await toggle.isChecked(), true)
  await logout(page)
  await login(page, 'schedule-fixture-1', false)
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  assert.equal(await toggle.isChecked(), false)
  if (width === 1440) {
    await checkUnknownPreference(page)
    await checkUncertainPreference(page)
    await checkServerSaveFailures(page)
  }
  await page.route('**/api/v1/users/me/preferences', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'validation_error', message: 'test', details: [] },
          }),
        })
      : route.continue(),
  )
  await toggle.click()
  await page.getByRole('alert').filter({ hasText: 'Не удалось сохранить настройку' }).waitFor()
  assert.equal(await toggle.isChecked(), false)
  await page.unroute('**/api/v1/users/me/preferences')
  for (const mode of ['День', 'Неделя']) {
    await page.getByRole('button', { name: mode, exact: true }).click()
    assert.equal(await toggle.isChecked(), false)
    await page.getByRole('button', { name: 'Следующая неделя' }).click()
    await page.locator('.schedule-list').waitFor()
    await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
    await page.locator('.schedule-list').waitFor()
    assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-10')
    if (mode === 'Неделя') {
      await page.waitForFunction(() => {
        const bounds = document.querySelector('.schedule-day.is-selected').getBoundingClientRect()
        return bounds.top >= 0 && bounds.top < window.innerHeight
      })
    }
    await noOverflow(page)
    for (const viewport of [360, 768, 1440, 2560]) {
      await page.setViewportSize({ width: viewport, height: 1000 })
      await page.waitForFunction((width) => {
        const margin = window.getComputedStyle(
          document.querySelector('.student-main-column'),
        ).marginLeft
        const expected =
          width <= 720
            ? '0px'
            : width <= 920
              ? '76px'
              : width <= 1050
                ? '230px'
                : width <= 1450
                  ? '252px'
                  : '272px'
        return margin === expected
      }, viewport)
      for (const direction of ['rtl', 'ltr']) {
        await page.evaluate((dir) => {
          document.documentElement.dir = dir
        }, direction)
        await assertModeHighlight(page)
        await noOverflow(page)
      }
    }
  }
  await page.setViewportSize({ width, height: 1000 })
  await page.getByRole('button', { name: 'День', exact: true }).click()
  check(
    'Real preference PATCH, reload/login, two-account isolation, failed-save rollback, shared day/week and RTL 360–2560px',
  )
}

async function checkResponsiveLayoutTimeout(page) {
  await assert.rejects(
    waitForResponsiveLayout(page, { timeoutMs: 250, stableFramesRequired: 10_000 }),
    (error) => {
      assert.match(error.message, /Responsive layout did not stabilize within 250 ms/)
      assert.match(error.message, /"viewportWidth":1440/)
      assert.match(error.message, /"activeAnimations"/)
      assert.match(error.message, /"elements"/)
      return true
    },
  )
  await waitForResponsiveLayout(page)
  check('Responsive layout wait is bounded and reports live diagnostics')
}

async function checkCardOverflowDetection(page) {
  const card = page.locator('.lesson-card:visible').first()
  await card.evaluate((element) => {
    element.dataset.e2eOriginalPosition = element.style.position
    element.style.position = 'relative'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'e2e-overflow-probe'
    button.textContent = 'Overflow probe'
    button.style.cssText = `position:absolute;left:${element.clientWidth - 8}px;top:0;width:32px;height:32px;`
    element.append(button)
  })
  try {
    await assert.rejects(noOverflow(page), /Visible lesson-card content escapes card bounds/)
  } finally {
    await card.evaluate((element) => {
      element.querySelector('.e2e-overflow-probe')?.remove()
      element.style.position = element.dataset.e2eOriginalPosition
      delete element.dataset.e2eOriginalPosition
    })
  }
  await noOverflow(page)
  check('No-overflow rejects an artificial visible button escaping its lesson card')
}

async function checkCancelledLesson(card, width) {
  assert.ok((await card.innerText()).includes('Отменено'))
  for (const selector of ['time', 'h3']) {
    assert.ok(
      await card
        .locator(selector)
        .evaluateAll(
          (nodes, selector) =>
            nodes.length > 0 &&
            nodes.every(
              (node) =>
                window.getComputedStyle(node).textDecorationLine.includes('line-through') ===
                (selector === 'h3'),
            ),
          selector,
        ),
      `Cancelled ${selector} decoration matches the owner decision`,
    )
  }
  assert.equal(await card.locator('.lesson-card__teacher, .lesson-card__kind, li').count(), 0)
  const timeStyle = await card.locator('.lesson-card__time').evaluate((node) => {
    const style = window.getComputedStyle(node)
    return { minHeight: style.minHeight, padding: style.paddingTop, border: style.borderTopWidth }
  })
  assert.deepEqual(timeStyle, { minHeight: '0px', padding: '0px', border: '0px' })
  if (width === 360) {
    const box = await card.boundingBox()
    assert.ok(box.width <= 360 && box.height <= 120, 'Cancelled row remains compact at 360px')
  }
}

async function checkScheduleChanges(page, width) {
  for (const mode of ['День', 'Неделя']) {
    await page.getByRole('button', { name: mode, exact: true }).click()
    for (const [sourceName, sourceDate, targetDate, targetStatus] of [
      ['Одиночный перенос', '2026-11-12', '2026-11-13', 'scheduled'],
      ['Первая позиция переноса', '2026-11-10', '2026-12-20', 'scheduled'],
      ['Перенос с отменённым результатом', '2026-11-12', '2027-01-03', 'cancelled'],
      ['Перенос с отменённым результатом', '2026-11-20', '2027-01-03', 'cancelled'],
    ]) {
      await page.getByLabel('Дата', { exact: true }).fill(sourceDate)
      const source = page
        .locator('.schedule-day.is-selected')
        .getByRole('article', { name: sourceName, exact: true })
      await source.waitFor()
      assert.equal(await source.locator('.lesson-card__teacher').count(), 0)
      assert.ok(
        await source
          .locator('time')
          .first()
          .evaluate(
            (node) => !window.getComputedStyle(node).textDecorationLine.includes('line-through'),
          ),
      )
      assert.ok(
        await source
          .locator('h3')
          .evaluate((node) =>
            window.getComputedStyle(node).textDecorationLine.includes('line-through'),
          ),
      )
      const disciplineName = await source.locator('h3').innerText()
      const text = await source.innerText()
      assert.ok(text.includes('Перенесено на'))
      assert.equal(text.includes('Отменено'), targetStatus === 'cancelled')
      if (targetStatus === 'cancelled') assert.ok(text.includes('00:30'))
      await noOverflow(page)
      const action = source.getByRole('button', { name: /Перенесено на/ })
      await action.focus()
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        (date) => document.querySelector('input[type=date]').value === date,
        targetDate,
      )
      const target = page.locator('.schedule-day.is-selected .lesson-card:focus')
      await target.waitFor()
      assert.ok((await target.getAttribute('class')).includes(`lesson-card--${targetStatus}`))
      assert.equal(await target.locator('h3').innerText(), disciplineName)
      assert.equal(await target.getByText(/Перенесено/).count(), 0)
      if (targetStatus === 'cancelled') await checkCancelledLesson(target, width)
      else assert.equal(await target.locator('.lesson-card__teacher').count(), 1)
      assert.equal(
        await page.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'),
        'true',
      )
      await noOverflow(page)
    }
  }
  const toggle = page.getByRole('checkbox', { name: 'Показывать отменённые' })
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/preferences') && r.request().method() === 'PATCH',
  )
  const [response] = await Promise.all([saved, toggle.click()])
  assert.equal(response.status(), 200)
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled)
  await page.getByLabel('Дата', { exact: true }).fill('2026-11-10')
  const cancelled = page.getByRole('article', { name: 'Отменённое занятие' })
  await cancelled.waitFor()
  await checkCancelledLesson(cancelled, width)
  await page.getByLabel('Дата', { exact: true }).fill('2026-11-12')
  const unavailable = page.getByRole('article', { name: 'Недоступный результат переноса' })
  await unavailable.waitFor()
  assert.equal(await unavailable.locator('.lesson-card__status').innerText(), 'Перенесено')
  assert.equal(await unavailable.getByRole('button').count(), 0)
  assert.equal(await page.locator('.schedule-day.is-selected .lesson-card').count(), 3)
  assert.equal(await page.getByText('Неактуально', { exact: true }).count(), 0)
  await noOverflow(page)
  await page.screenshot({ path: `work/schedule-changes-${width}.png`, fullPage: true })
  await page.getByRole('button', { name: 'День', exact: true }).click()
  await page.getByLabel('Дата', { exact: true }).fill('2026-11-10')
  await page.locator('.schedule-list').waitFor()
  check(
    `${width}px: single/repeated moves, cancelled terminal, unavailable group, keyboard focus and mode preservation`,
  )
}

async function noOverflow(page) {
  await waitForResponsiveLayout(page)
  await page.waitForFunction(() => {
    const main = document.querySelector('.student-main-column')
    const collapsed = document.body.classList.contains('sidebar-collapsed')
    const width = window.innerWidth
    const expected =
      width <= 720 ? 0 : width <= 1050 ? 230 : width <= 1450 ? 252 : collapsed ? 76 : 272
    return Math.abs(Number.parseFloat(window.getComputedStyle(main).marginLeft) - expected) < 0.5
  })
  const overflow = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    direction: document.documentElement.dir,
    mode: document.querySelector('.schedule-page')?.className,
    elements: Array.from(document.body.querySelectorAll('*'))
      .filter((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left < 0 || bounds.right > window.innerWidth + 1
      })
      .slice(0, 12)
      .map((element) => {
        const bounds = element.getBoundingClientRect()
        const styles = window.getComputedStyle(element)
        const ancestors = []
        for (
          let parent = element;
          parent && parent !== document.body;
          parent = parent.parentElement
        ) {
          const parentBounds = parent.getBoundingClientRect()
          const parentStyles = window.getComputedStyle(parent)
          ancestors.push({
            tag: parent.tagName.toLowerCase(),
            className: typeof parent.className === 'string' ? parent.className : '',
            id: parent.id,
            left: Number(parentBounds.left.toFixed(2)),
            right: Number(parentBounds.right.toFixed(2)),
            width: Number(parentBounds.width.toFixed(2)),
            display: parentStyles.display,
            position: parentStyles.position,
            minWidth: parentStyles.minWidth,
            marginLeft: parentStyles.marginLeft,
            leftStyle: parentStyles.left,
            rightStyle: parentStyles.right,
            overflowX: parentStyles.overflowX,
            direction: parentStyles.direction,
          })
        }
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          id: element.id,
          left: Number(bounds.left.toFixed(2)),
          right: Number(bounds.right.toFixed(2)),
          width: Number(bounds.width.toFixed(2)),
          display: styles.display,
          position: styles.position,
          minWidth: styles.minWidth,
          marginLeft: styles.marginLeft,
          leftStyle: styles.left,
          rightStyle: styles.right,
          overflowX: styles.overflowX,
          direction: styles.direction,
          transitionProperty: styles.transitionProperty,
          transitionDuration: styles.transitionDuration,
          transform: styles.transform,
          ancestors,
        }
      }),
    animations: document.getAnimations().map((animation) => {
      const target = animation.effect?.target
      const element = target instanceof Element ? target : target?.element
      return {
        type: 'transitionProperty' in animation ? 'transition' : 'animation',
        property: animation.transitionProperty,
        playState: animation.playState,
        currentTime: animation.currentTime,
        target: element
          ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className ? `.${element.className.trim().replaceAll(/\s+/g, '.')}` : ''}`
          : null,
        pseudoElement: target?.pseudoElement ?? null,
      }
    }),
  }))
  assert.ok(
    overflow.documentWidth <= overflow.viewportWidth,
    `No horizontal page overflow: ${JSON.stringify(overflow)}`,
  )
  await assertLessonCardContentsFit(page)
}

async function assertLessonCardContentsFit(page) {
  const escapingContent = await page.locator('.lesson-card:visible').evaluateAll((cards) =>
    cards.flatMap((card) => {
      const bounds = card.getBoundingClientRect()
      return [
        ...card.querySelectorAll(
          'h1, h2, h3, h4, p, time, span, strong, em, li, button, a, [role], [class*="tag"], [class*="status"]',
        ),
      ]
        .filter((element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          )
        })
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.left < bounds.left || rect.right > bounds.right + 1
        })
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === 'string' ? element.className : '',
            text: element.innerText?.trim().slice(0, 100),
            left: Number(rect.left.toFixed(2)),
            right: Number(rect.right.toFixed(2)),
            cardLeft: Number(bounds.left.toFixed(2)),
            cardRight: Number(bounds.right.toFixed(2)),
          }
        })
    }),
  )
  assert.equal(
    escapingContent.length,
    0,
    `Visible lesson-card content escapes card bounds: ${JSON.stringify(escapingContent)}`,
  )
}

async function getResponsiveLayoutDiagnostics(page) {
  return page.evaluate(() => {
    const selectors = [
      '.student-main-column',
      '.student-content',
      '.schedule-page',
      '.schedule-heading',
      '.schedule-toolbar',
      '.schedule-modes',
      '.lesson-card',
    ]
    const elements = selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((element) => {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return {
          selector,
          left: Number(rect.left.toFixed(2)),
          right: Number(rect.right.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          display: style.display,
          minWidth: style.minWidth,
          marginLeft: style.marginLeft,
          leftStyle: style.left,
          rightStyle: style.right,
          overflowX: style.overflowX,
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
          transform: style.transform,
        }
      }),
    )
    const activeAnimations = document.getAnimations().map((animation) => {
      const target = animation.effect?.target
      const element = target instanceof Element ? target : target?.element
      return {
        type: 'transitionProperty' in animation ? 'transition' : 'animation',
        property: animation.transitionProperty,
        name: animation.animationName,
        playState: animation.playState,
        currentTime: animation.currentTime,
        target: element
          ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${typeof element.className === 'string' && element.className ? `.${element.className.trim().replaceAll(/\s+/g, '.')}` : ''}`
          : null,
        pseudoElement: target?.pseudoElement ?? null,
      }
    })
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      direction: document.documentElement.dir,
      mode: document.querySelector('.schedule-page')?.className,
      elements,
      activeAnimations,
    }
  })
}

async function waitForResponsiveLayout(page, { timeoutMs = 5000, stableFramesRequired = 2 } = {}) {
  const waitId = ++responsiveLayoutWaitSequence
  const abortController = new AbortController()
  const layoutPromise = page.evaluate(
    async ({ waitId, stableFramesRequired }) => {
      window.__scheduleLayoutWaitCancellations ??= {}
      window.__scheduleLayoutWaitCancellations[waitId] = false
      const main = document.querySelector('.student-main-column')
      const ambient = document.querySelector('.ambient-canvas')
      const responsiveTransitions = () =>
        document.getAnimations().filter((animation) => {
          if (!('transitionProperty' in animation)) return false
          const target = animation.effect?.target
          const element = target instanceof Element ? target : target?.element
          return (
            (element === main && animation.transitionProperty === 'margin-left') ||
            (element === ambient && animation.transitionProperty === 'left')
          )
        })

      let previousGeometry = ''
      let stableFrames = 0
      try {
        while (stableFrames < stableFramesRequired) {
          if (window.__scheduleLayoutWaitCancellations[waitId]) {
            throw new Error(`Responsive layout wait ${waitId} was cancelled`)
          }
          const transitions = responsiveTransitions()
          if (transitions.length) {
            previousGeometry = ''
            stableFrames = 0
          }

          await new Promise((resolve) => window.requestAnimationFrame(resolve))
          const geometry = [
            document.documentElement.scrollWidth,
            ...[
              '.student-main-column',
              '.student-content',
              '.schedule-page',
              '.schedule-heading',
              '.schedule-toolbar',
              '.schedule-modes',
              '.lesson-card',
            ].flatMap((selector) =>
              Array.from(document.querySelectorAll(selector)).map((element) => {
                const bounds = element.getBoundingClientRect()
                return [bounds.left, bounds.right, bounds.width].map(
                  (value) => Math.round(value * 100) / 100,
                )
              }),
            ),
          ]
          const nextGeometry = JSON.stringify(geometry)
          if (!responsiveTransitions().length && nextGeometry === previousGeometry) {
            stableFrames += 1
          } else {
            stableFrames = 0
          }
          previousGeometry = nextGeometry
        }
      } finally {
        delete window.__scheduleLayoutWaitCancellations[waitId]
      }
    },
    { waitId, stableFramesRequired },
  )
  const timeoutPromise = delay(timeoutMs, undefined, { signal: abortController.signal }).then(
    async () => {
      const diagnostics = await getResponsiveLayoutDiagnostics(page).catch((error) => ({
        diagnosticError: error.message,
      }))
      await page
        .evaluate((id) => {
          if (window.__scheduleLayoutWaitCancellations) {
            window.__scheduleLayoutWaitCancellations[id] = true
          }
        }, waitId)
        .catch(() => {})
      throw new Error(
        `Responsive layout did not stabilize within ${timeoutMs} ms (required ${stableFramesRequired} stable frames); diagnostics=${JSON.stringify(diagnostics)}`,
      )
    },
  )
  try {
    await Promise.race([layoutPromise, timeoutPromise])
  } finally {
    abortController.abort()
  }
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
    if (timezoneId === 'America/Los_Angeles') await checkResponsiveLayoutTimeout(page)
    await checkStudentProfile(page, 1)
    await page.goto(`${baseURL}/schedule/unknown-integration-path`)
    await page.getByRole('heading', { name: 'Страница не найдена' }).waitFor()
    await page.getByRole('link', { name: 'Вернуться в кабинет' }).click()
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
    await checkPreferences(page, width)
    if (timezoneId === 'America/Los_Angeles') await checkCardOverflowDetection(page)
    await checkScheduleChanges(page, width)
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
      await page.setViewportSize({ width: 360, height: 1000 })
      assert.equal(await page.locator('.schedule-day:visible').count(), 7)
      assert.equal(await page.getByRole('group', { name: 'Дни недели' }).count(), 0)
      assert.ok(await page.locator('.schedule-day.is-selected').isVisible())
      await page.setViewportSize({ width: 1440, height: 1000 })
      assert.equal(await page.locator('.schedule-day:visible').count(), 7)
      assert.equal(await week.getAttribute('aria-pressed'), 'true')
      await page.getByRole('button', { name: 'День', exact: true }).click()
      await page.getByLabel('Дата', { exact: true }).fill('2026-11-11')
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
