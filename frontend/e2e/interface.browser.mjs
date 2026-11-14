/* global process, console, document, window, getComputedStyle, URL */
// Real demo seed and API. No substituted authentication or application data.
import assert from 'node:assert/strict'
import { scaleVisibleText } from './academicsGeometry.mjs'
import { assertReadableText, assertScheduleControlGeometry } from './typographyGeometry.mjs'
import { openApplicationsHappyPath } from './interfaceAssertions.mjs'
import { mkdir } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.DEMO_TEST_URL || 'http://localhost:5173'
assert.ok(process.env.DEMO_STUDENT_A_PASSWORD, 'Provide disposable demo password')
const artifacts = process.env.INTERFACE_ARTIFACTS || 'work/interface'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
async function settle() {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  )
}
async function assertUnstruckTime(time) {
  assert.ok(await time.isVisible(), 'lesson time stays visible')
  assert.equal(
    await time.evaluate((node) => {
      const card = node.closest('.lesson-card')
      for (let e = node; e && card.contains(e); e = e.parentElement) {
        if (getComputedStyle(e).textDecorationLine.includes('line-through')) return true
      }
      return false
    }),
    false,
    'neither time nor its containing blocks are struck through',
  )
}
async function inspect(name, width) {
  await settle()
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${name}: overflow at ${width}`,
  )
  await page.screenshot({ path: `${artifacts}/${width}-${name}.png`, fullPage: true })
}
try {
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин', { exact: true }).fill('demo-pz101')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_STUDENT_A_PASSWORD)
  // The preceding real seed scenario consumes login attempts; honor the server's window.
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = page.waitForResponse((response) => response.url().endsWith('/auth/login'))
    await page.getByRole('button', { name: 'Войти', exact: true }).click()
    const response = await pending
    if (response.status() !== 429) {
      assert.equal(response.status(), 200)
      break
    }
    const seconds = Number(response.headers()['retry-after'])
    assert.ok(seconds > 0 && seconds <= 60)
    await page.waitForTimeout(seconds * 1000)
  }
  await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
  for (const width of [360, 390, 561, 600, 721, 768, 900, 1440, 2560]) {
    await page.setViewportSize({ width, height: width >= 1920 ? 1440 : 1000 })
    await page.goto(`${baseURL}/schedule`)
    const scheduleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/schedule' &&
        new URL(response.url()).searchParams.get('date_from') === '2026-11-16',
    )
    await page.getByLabel('Дата', { exact: true }).fill('2026-11-19')
    assert.equal((await scheduleResponse).status(), 200, `Schedule happy-path HTTP at ${width}`)
    await page.locator('.schedule-list').waitFor()
    for (const card of await page.locator('.schedule-day.is-selected .lesson-card').all()) {
      const changed = await card.evaluate((e) =>
        e.matches('.lesson-card--cancelled, .lesson-card--moved'),
      )
      assert.equal(
        await card
          .locator('h3')
          .evaluate((e) => getComputedStyle(e).textDecorationLine.includes('line-through')),
        changed,
      )
      assert.equal(await card.locator('time').count(), 2, 'both time endpoints are rendered')
      for (const time of await card.locator('time').all()) await assertUnstruckTime(time)
    }
    assert.ok(
      (await page.locator('.schedule-day.is-selected .lesson-card--cancelled').count()) > 0,
      'cancelled seed lesson loaded in day mode',
    )
    await inspect('schedule-day', width)
    await page.getByRole('button', { name: 'Неделя', exact: true }).click()
    assert.equal(await page.getByRole('group', { name: 'Дни недели' }).count(), 0)
    assert.equal(await page.locator('.schedule-day:visible').count(), 7)
    const groups = await page.locator('.schedule-day__lessons').evaluateAll((lists) =>
      lists.map((list) =>
        [...list.children].map((card) => {
          const b = card.getBoundingClientRect()
          return { left: b.left, top: b.top, bottom: b.bottom }
        }),
      ),
    )
    for (const group of groups)
      for (let i = 1; i < group.length; i++) {
        assert.equal(group[i].left, group[i - 1].left)
        assert.ok(group[i].top >= group[i - 1].bottom, 'one column without overlaps')
      }
    assert.ok(
      (await page.locator('.lesson-card--moved:visible').count()) > 0,
      'seed contains moved lessons',
    )
    assert.ok(
      (await page.locator('.lesson-card--cancelled:visible').count()) > 0,
      'seed contains cancelled lessons',
    )
    for (const card of await page
      .locator('.lesson-card--moved:visible, .lesson-card--cancelled:visible')
      .all()) {
      assert.match(await card.innerText(), /Перенесено|Отменено/)
      assert.ok(await card.isVisible(), 'changed lesson is visible')
      for (const selector of ['h3'])
        assert.match(
          await card
            .locator(selector)
            .first()
            .evaluate((e) => getComputedStyle(e).textDecorationLine),
          /line-through/,
        )
    }
    assert.ok(
      (await page.locator('.lesson-card--scheduled:visible').count()) > 0,
      'ordinary scheduled seed lessons are loaded',
    )
    for (const title of await page.locator('.lesson-card--scheduled:visible h3').all()) {
      assert.doesNotMatch(
        await title.evaluate((e) => getComputedStyle(e).textDecorationLine),
        /line-through/,
        'ordinary titles are not struck through',
      )
    }
    for (const time of await page.locator('.lesson-card:visible time').all())
      await assertUnstruckTime(time)
    await inspect('schedule-week', width)
    await page.locator('.schedule-open-day').nth(3).click()
    assert.equal(
      await page.getByRole('button', { name: 'День', exact: true }).getAttribute('aria-pressed'),
      'true',
    )
    assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-19')
    await page.getByRole('button', { name: 'Неделя', exact: true }).click()
    await page.getByRole('button', { name: 'Следующая неделя' }).click()
    await page.getByRole('button', { name: 'День', exact: true }).click()
    assert.equal(await page.getByLabel('Дата', { exact: true }).inputValue(), '2026-11-26')
    await page.getByRole('button', { name: 'Неделя', exact: true }).click()
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
      await page.waitForFunction(() => {
        const box = document.querySelector('.schedule-day.is-selected')?.getBoundingClientRect()
        return box && box.top >= 64 && box.top < window.innerHeight - 50
      })
    }
    for (const [route, title, name] of [
      ['/academics', 'Успеваемость', 'academics'],
      ['/services', 'Услуги и документы', 'catalog'],
      ['/services?tab=applications', 'Услуги и документы', 'applications'],
      ['/services/study_certificate', 'Справка об обучении', 'form'],
      ['/news', 'Новости', 'news'],
      ['/profile', 'Мой профиль', 'profile'],
      ['/settings', 'Настройки', 'settings'],
    ]) {
      const requiredReads = {
        '/academics': ['/api/v1/academics', '.academics-table tbody tr'],
        '/services': ['/api/v1/services', '.service-card'],
        '/news': ['/api/v1/news', '.news-row__link'],
      }
      if (route === '/services?tab=applications') await openApplicationsHappyPath(page, baseURL)
      else if (requiredReads[route]) {
        const [endpoint, selector] = requiredReads[route]
        const pending = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' && new URL(response.url()).pathname === endpoint,
        )
        await page.goto(`${baseURL}${route}`)
        const response = await pending
        assert.equal(
          response.status(),
          200,
          `${name} happy-path GET at ${width}: HTTP ${response.status()}`,
        )
        const data = await response.json()
        assert.ok(data.items?.length > 0, `${name} requires non-empty real demo data at ${width}`)
        await page.locator(selector).first().waitFor()
        assert.equal(
          await page
            .locator(
              '.service-page [role="alert"],.academics-page [role="alert"],.news-page [role="alert"]',
            )
            .count(),
          0,
          `${name} must not screenshot an error as success`,
        )
        if (route === '/academics') {
          assert.equal(
            await page.getByRole('table').count(),
            2,
            'both discipline and session tables are ready',
          )
          for (const table of await page.getByRole('table').all())
            assert.equal(await table.locator('tbody tr').count(), data.items.length)
        }
      } else await page.goto(`${baseURL}${route}`)
      await page.getByRole('heading', { name: title, exact: true, level: 1 }).waitFor()
      await page.waitForLoadState('networkidle')
      await inspect(name, width)
      if (route === '/academics') {
        assert.equal(await page.getByRole('progressbar').count(), 0)
        assert.ok(
          (await page.locator('.academics-table tbody tr').count()) > 0,
          'real academic disciplines loaded',
        )
      }
      if (route === '/profile') {
        await page.locator('.profile-building').evaluate((image) => image.decode())
        if (width >= 1440) {
          const bottoms = await page
            .locator('.profile-education,.profile-contacts')
            .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom))
          assert.ok(Math.abs(bottoms[0] - bottoms[1]) < 1)
        }
      }
      if (route === '/services') {
        const icon = await page.locator('.service-card__icon-box').boundingBox()
        const text = await page.locator('.service-card__content').boundingBox()
        if (icon.y < text.y + text.height && text.y < icon.y + icon.height)
          assert.ok(icon.x + icon.width <= text.x, 'service icon does not overlap text')

        const tabs = page.getByRole('navigation', { name: 'Разделы услуг' })
        const top = (await tabs.boundingBox()).y
        await tabs.getByRole('link', { name: 'Мои заявления' }).click()
        await settle()
        assert.ok(Math.abs((await tabs.boundingBox()).y - top) < 1)
        await page.goBack()
        await page.getByRole('link', { name: 'Подать заявление' }).waitFor()
        await page.goForward()
        await tabs.getByRole('link', { name: 'Мои заявления' }).waitFor()
      }
      if (route === '/news') {
        await page.locator('.news-row__link').first().click()
        await page.locator('.news-article').waitFor()
        await inspect('news-detail', width)
      }
      if (route === '/services?tab=applications') {
        for (const row of await page.locator('.applications-table tbody tr').all()) {
          const cells = await row.locator('td').evaluateAll((els) =>
            els.map((e) => {
              const b = e.getBoundingClientRect()
              return {
                x: b.x,
                y: b.y,
                right: b.right,
                bottom: b.bottom,
                width: b.width,
                scroll: e.scrollWidth,
                client: e.clientWidth,
              }
            }),
          )
          for (const cell of cells) {
            assert.ok(cell.width >= 140, `readable application cell at ${width}`)
            assert.ok(cell.scroll <= cell.client, `no clipped application content at ${width}`)
          }
          for (let i = 1; i < cells.length; i++) {
            const a = cells[i - 1],
              b = cells[i]
            assert.ok(b.x >= a.right - 1 || b.y >= a.bottom - 1, 'application cells do not overlap')
          }
        }
        await page.locator('.applications-table a').first().click()
        await page.locator('.application-detail dl').waitFor()
        await inspect('application-detail', width)
        assert.equal(await page.locator('.application-detail > a').count(), 1)
      }
    }
    await page.goto(`${baseURL}/unknown-interface-route`)
    await page.getByRole('heading', { name: 'Страница не найдена', exact: true }).waitFor()
    assert.equal(await page.getByRole('navigation', { name: 'Разделы кабинета' }).count(), 0)
    await inspect('not-found-authenticated', width)
    await page.getByRole('link', { name: 'Вернуться к расписанию', exact: true }).click()
    await page.getByRole('heading', { name: 'Расписание', exact: true }).waitFor()
    await page.locator('.schedule-list').waitFor()
    const notificationsResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/notifications',
    )
    await page.getByRole('button', { name: 'Уведомления', exact: true }).click()
    const notifications = await notificationsResponse
    assert.equal(notifications.status(), 200, 'notification happy-path GET must succeed')
    const notificationData = await notifications.json()
    assert.ok(notificationData.items?.length > 0, 'real seeded notifications must exist')
    await page.locator('.notification-item').first().waitFor()
    await page.getByRole('dialog', { name: 'Уведомления', exact: true }).waitFor()
    await page.waitForLoadState('networkidle')
    await inspect('notifications', width)
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === 'Уведомления',
    )
    assert.equal(await page.getByRole('dialog', { name: 'Уведомления', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
    await page.getByRole('link', { name: 'Мой профиль', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(
      await page
        .getByRole('button', { name: 'Меню пользователя' })
        .evaluate((e) => e === document.activeElement),
      true,
    )
    if (width < 721) {
      await page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
      await page.getByRole('dialog', { name: 'Мобильная навигация' }).waitFor()
      await inspect('mobile-menu', width)
      assert.equal(await page.locator('.student-main-column').evaluate((e) => e.inert), true)
      assert.equal(await page.locator('.desktop-sidebar').evaluate((e) => e.inert), true)
      const drawer = page.getByRole('dialog', { name: 'Мобильная навигация' })
      for (let tab = 0; tab < 10; tab++) {
        await page.keyboard.press('Tab')
        assert.equal(await drawer.evaluate((e) => e.contains(document.activeElement)), true)
      }
      await page.keyboard.press('Escape')
      assert.equal(
        await page
          .getByRole('button', { name: 'Открыть меню', exact: true })
          .evaluate((e) => e === document.activeElement),
        true,
      )
    }
    console.log(`PASS real API screens, schedule, history, overlays at ${width}`)
  }
  for (const width of [360, 390, 600, 721, 768, 900, 1440, 2560]) {
    await page.setViewportSize({ width, height: width === 2560 ? 1440 : 1000 })
    for (const factor of [1, 1.5, 2]) {
      await page.goto(`${baseURL}/schedule`)
      const read = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/v1/schedule' &&
          new URL(r.url()).searchParams.get('date_from') === '2026-11-16',
      )
      await page.getByLabel('Дата', { exact: true }).fill('2026-11-19')
      assert.equal((await read).status(), 200)
      await page.locator('.schedule-list').waitFor()
      await scaleVisibleText(page, factor)
      await settle()
      await assertReadableText(
        page,
        [
          '.topbar-prototype-note',
          '.schedule-timezone',
          '.schedule-modes button',
          '.schedule-days button',
        ],
        `${width}/${factor}/day`,
        12 * factor,
      )
      await assertScheduleControlGeometry(page, `${width}/${factor}/day`)
      await inspect(`typography-day-${factor}`, width)
      await page.getByRole('button', { name: 'Неделя', exact: true }).click()
      await settle()
      await assertReadableText(
        page,
        ['.lesson-card__tag', '.lesson-card__time time'],
        `${width}/${factor}/week`,
        12 * factor,
      )
      await inspect(`typography-week-${factor}`, width)
      if (width <= 720) {
        await page.getByRole('button', { name: 'Открыть меню', exact: true }).click()
        await page.getByRole('dialog', { name: 'Мобильная навигация' }).waitFor()
        await scaleVisibleText(page, factor, '.mobile-drawer', false)
        await assertReadableText(
          page,
          ['.mobile-drawer .university-brand__copy small', '.mobile-drawer .navigation-label'],
          `${width}/${factor}/drawer`,
          12 * factor,
        )
        await inspect(`typography-menu-${factor}`, width)
        await page.keyboard.press('Escape')
      }
    }
  }
  console.log(
    'PASS actual computed typography and unclipped controls at 100/150/200% text across eight widths',
  )
  // Negative control uses the exact same happy-path assertion, not an alternative check.
  await page.route('**/api/v1/applications?*', (request) =>
    request.fulfill({
      status: 500,
      json: { error: { code: 'internal_error', message: 'Negative control' } },
    }),
  )
  await assert.rejects(
    () => openApplicationsHappyPath(page, baseURL),
    /Applications happy-path GET: HTTP 500/,
  )
  await page.getByRole('alert').waitFor()
  await inspect('applications-happy-path-negative-control', 2560)
  await page.unroute('**/api/v1/applications?*')
  console.log('PASS negative control: HTTP 500 rejects the mandatory applications happy-path')
  // Explicit read-only fault fixtures exercise loading, error, and real retry recovery.
  // Neither authentication nor POST responses are substituted.
  for (const width of [360, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const [route, api, name, recovered] of [
      ['/schedule', '**/api/v1/schedule?*', 'schedule', '.schedule-list'],
      ['/academics', '**/api/v1/academics', 'academics', '.academics-table'],
      ['/services', '**/api/v1/services', 'catalog', '.service-card'],
      [
        '/services?tab=applications',
        '**/api/v1/applications?*',
        'applications',
        '.applications-table',
      ],
      ['/news', '**/api/v1/news?*', 'news', '.news-feed'],
    ]) {
      let release
      let entered
      const gate = new Promise((resolve) => {
        release = resolve
      })
      const requested = new Promise((resolve) => {
        entered = resolve
      })
      await page.route(api, async (request) => {
        entered()
        await gate
        await request.fulfill({
          status: 500,
          json: { error: { code: 'internal_error', message: 'Explicit read-only E2E fault' } },
        })
      })
      await page.goto(`${baseURL}${route}`)
      await requested
      await page
        .getByRole('status')
        .filter({ hasText: /Загружаем/ })
        .first()
        .waitFor()
      await inspect(`${name}-loading-fixture`, width)
      release()
      await page.getByRole('alert').first().waitFor()
      await inspect(`${name}-error-fixture`, width)
      await page.unroute(api)
      const documentOrigin = await page.evaluate(() => window.performance.timeOrigin)
      await page
        .getByRole('button', { name: /Повторить/ })
        .first()
        .click()
      await page.locator(recovered).first().waitFor()
      assert.equal(
        await page.evaluate(() => window.performance.timeOrigin),
        documentOrigin,
        `${name} retry must not reload the document`,
      )
    }
  }
  console.log(
    'PASS explicit read-only loading/error fixtures and real retry recovery at 360/1440/2560',
  )
  // Deliberately inject a read-only empty fixture; no POST/auth responses are replaced.
  await page.route('**/api/v1/applications?*', (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  )
  for (const width of [360, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`${baseURL}/services?tab=applications`)
    await page.getByText('Вы ещё не подавали заявлений', { exact: true }).waitFor()
    await inspect('empty-applications-fixture', width)
    await page.getByRole('link', { name: 'Перейти в каталог услуг' }).click()
    await page.getByRole('link', { name: 'Подать заявление' }).waitFor()
  }
  await page.unroute('**/api/v1/applications?*')
  console.log('PASS read-only empty application fixture and catalog transition')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${baseURL}/schedule`)
  await page.getByRole('button', { name: 'Неделя', exact: true }).click()
  await page.getByRole('button', { name: 'Следующая неделя' }).click()
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.getByRole('button', { name: 'Сегодня', exact: true }).click()
    await page.waitForFunction(() => {
      const box = document.querySelector('.schedule-day.is-selected')?.getBoundingClientRect()
      return box && box.top >= 64 && box.top < window.innerHeight - 50
    })
  }
  await page.getByRole('button', { name: 'Уведомления', exact: true }).click()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog', { name: 'Уведомления', exact: true }).count(), 0)
  assert.ok(
    await page.evaluate(() =>
      document.getAnimations().every((a) => a.effect.getTiming().duration <= 1),
    ),
  )
  assert.deepEqual(errors, [])
  console.log('PASS reduced motion and no JavaScript errors')
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('heading', { name: 'Вход в систему' }).waitFor()
  for (const width of [360, 390, 561, 600, 721, 768, 900, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const [route, name, title] of [
      ['/login', 'login', 'Вход в систему'],
      ['/about', 'about', 'Uni Space'],
      ['/unknown-interface-route', 'not-found', 'Страница не найдена'],
    ]) {
      await page.goto(`${baseURL}${route}`)
      await page.getByRole('heading', { name: title, exact: true }).waitFor()
      await inspect(name, width)
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS real logout and public/error screens at all nine widths')
} finally {
  await browser.close()
}
