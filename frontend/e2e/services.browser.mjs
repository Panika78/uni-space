/* global process, console, URL, Request, Response, TextDecoder, MessageChannel, AbortSignal, document, window, setTimeout */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const baseURL = process.env.SERVICES_TEST_URL || 'http://localhost:5173'
const login = process.env.SERVICES_TEST_LOGIN
const password = process.env.SERVICES_TEST_PASSWORD
const loginB = process.env.SERVICES_TEST_LOGIN_B
const passwordB = process.env.SERVICES_TEST_PASSWORD_B || password
assert.ok(login && password, 'Provide a fictional SERVICES_TEST_LOGIN and SERVICES_TEST_PASSWORD')
assert.ok(
  loginB,
  'Provide a second fictional SERVICES_TEST_LOGIN_B for the required account-isolation scenario',
)

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: true,
  args: ['--no-sandbox'],
})
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window)
    const control = {
      armed: false,
      response: null,
      arm() {
        this.armed = true
        this.responseReady = new Promise((resolve) => {
          this.resolveResponseReady = resolve
        })
        this.deliveryGate = new Promise((resolve) => {
          this.releaseDelivery = resolve
        })
        this.clientProcessed = new Promise((resolve) => {
          this.resolveClientProcessed = resolve
        })
        this.responseAwaitingClient = false
        this.clientProcessedScheduled = false
      },
      scheduleClientProcessed() {
        if (this.clientProcessedScheduled) return
        this.clientProcessedScheduled = true
        const completionTask = new MessageChannel()
        // The message task runs after the current promise microtask chain, so
        // apiFetch and the submit handler have observed the response or abort.
        completionTask.port1.onmessage = () => {
          completionTask.port1.close()
          completionTask.port2.close()
          this.resolveClientProcessed()
        }
        completionTask.port2.postMessage(null)
      },
    }
    window.__latePostControl = control
    const nativeThrowIfAborted = AbortSignal.prototype.throwIfAborted
    AbortSignal.prototype.throwIfAborted = function () {
      try {
        return nativeThrowIfAborted.call(this)
      } catch (error) {
        if (control.responseAwaitingClient) {
          control.responseAwaitingClient = false
          control.scheduleClientProcessed()
        }
        throw error
      }
    }
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null
      const url = new URL(request?.url ?? String(input), window.location.href)
      const method = init?.method ?? request?.method ?? 'GET'
      const response = await nativeFetch(input, init)
      if (control.armed && method === 'POST' && url.pathname === '/api/v1/applications') {
        control.armed = false
        const responseBytes = await response.clone().arrayBuffer()
        control.response = {
          status: response.status,
          statusText: response.statusText,
          body: JSON.parse(new TextDecoder().decode(responseBytes)),
          headers: Object.fromEntries(response.headers.entries()),
        }
        control.resolveResponseReady()
        await control.deliveryGate
        const deliveredResponse = new Response(responseBytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
        const readJson = deliveredResponse.json.bind(deliveredResponse)
        deliveredResponse.json = (...args) =>
          new Promise((resolve, reject) => {
            readJson(...args).then((body) => {
              resolve(body)
              control.scheduleClientProcessed()
            }, reject)
          })
        control.responseAwaitingClient = true
        return deliveredResponse
      }
      return response
    }
  })
  const postResponses = []
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/applications' &&
      response.status() === 201
    )
      postResponses.push(response)
  })
  await page.goto(`${baseURL}/login`)
  await page.getByLabel('Логин').fill(login)
  await page.getByLabel('Пароль').fill(password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await page.waitForURL(`${baseURL}/schedule`)

  await page.goto(`${baseURL}/services`)
  await page.getByRole('heading', { name: 'Услуги и документы' }).waitFor()
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  await page.getByRole('heading', { name: 'Справка об обучении' }).waitFor()
  const field = page.getByLabel(/Место предоставления/)
  assert.equal(await field.getAttribute('required'), '')
  assert.equal(await field.getAttribute('aria-required'), 'true')
  await page.getByText('Знак * обозначает обязательное поле.').waitFor()
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  assert.equal(await field.evaluate((node) => node === document.activeElement), true)

  await field.fill('  Канцелярия\nкорпус № 2 — 東京  ')
  assert.ok((await field.inputValue()).length > 0)
  await page.getByRole('link', { name: 'К каталогу услуг' }).click()
  await page.getByRole('dialog', { name: 'Выйти без сохранения?' }).waitFor()
  await page.getByRole('button', { name: 'Продолжить заполнение' }).click()
  assert.match(page.url(), /\/services\/study_certificate$/)

  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  const logoutWarning = page.getByRole('dialog', { name: 'Потерять введённые данные и выйти?' })
  await logoutWarning.waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  await page.getByRole('button', { name: 'Отмена' }).click()
  assert.match(page.url(), /\/services\/study_certificate$/)
  assert.ok((await field.inputValue()).includes('Канцелярия'))

  await page.route('**/api/v1/applications', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'validation_error',
          message: 'Проверьте введённые данные',
          details: [{ field: 'form_data.place_of_submission', code: 'invalid_value' }],
        },
      }),
    }),
  )
  await field.fill('server validation')
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByText('Проверьте значение: от 1 до 300 символов.').waitFor()
  assert.equal(await field.getAttribute('aria-invalid'), 'true')
  assert.equal(await field.evaluate((node) => node === document.activeElement), true)
  await page.unroute('**/api/v1/applications')
  await field.fill('  Канцелярия\nкорпус № 2 — 東京  ')

  let allowInitialResponse
  const initialResponseGate = new Promise((resolve) => {
    allowInitialResponse = resolve
  })
  let notifyInitialCommit
  const initialCommit = new Promise((resolve) => {
    notifyInitialCommit = resolve
  })
  await page.route('**/api/v1/applications', async (route) => {
    const upstream = await route.fetch()
    notifyInitialCommit(upstream)
    await initialResponseGate
    await route.fulfill({ response: upstream })
  })
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  const committedResponse = await initialCommit
  assert.equal(committedResponse.status(), 201)
  await page
    .locator('.desktop-sidebar')
    .getByRole('link', { name: 'Расписание', exact: true })
    .click()
  const pendingNavigationWarning = page.getByRole('dialog', {
    name: 'Запрос уже отправлен. Покинуть форму?',
  })
  await pendingNavigationWarning.waitFor()
  assert.match(await pendingNavigationWarning.innerText(), /уход не отменит запрос/i)
  await page.getByRole('button', { name: 'Продолжить заполнение' }).click()
  await page.goBack()
  await pendingNavigationWarning.waitFor()
  await page.getByRole('button', { name: 'Продолжить заполнение' }).click()
  const responseWaiter = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname === '/api/v1/applications',
  )
  allowInitialResponse()
  const response = await responseWaiter
  assert.equal(response.status(), 201)
  assert.match(response.headers().location, /^\/api\/v1\/applications\/[1-9][0-9]*$/)
  const saved = await response.json()
  await page.getByText(`№ ${saved.id}`).waitFor()
  assert.equal(saved.form_data.place_of_submission, 'Канцелярия\nкорпус № 2 — 東京')
  await page.unroute('**/api/v1/applications')
  assert.equal(postResponses.length, 1, 'The form dispatches a single POST')
  await mkdir('work/services-review', { recursive: true })
  for (const width of [360, 390, 561, 600, 721, 768, 900, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.getByRole('heading', { name: 'Заявление создано', exact: true }).waitFor()
    await page.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity),
    )
    assert.ok((await page.locator('.application-success').boundingBox()).width >= 300)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    const buttons = await page.locator('.application-success .form-actions a').evaluateAll((els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect()
        return { x: b.x, y: b.y, right: b.right, bottom: b.bottom }
      }),
    )
    assert.equal(buttons.length, 2)
    assert.ok(
      buttons[1].x >= buttons[0].right || buttons[1].y >= buttons[0].bottom,
      'success actions do not overlap',
    )
    await page.screenshot({ path: `work/services-review/${width}-success.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('PASS: desktop catalog, form validation, navigation warning and real PostgreSQL save')

  {
    const savedId = String(saved.id)
    const firstStudentData = saved.form_data.place_of_submission
    // Hold the real server response after it has committed, then switch accounts.
    await page.goto(`${baseURL}/services/study_certificate`)
    const fieldA = page.getByLabel(/Место предоставления/)
    await fieldA.fill('Delayed response private A')
    let notifySaved
    const upstreamSaved = new Promise((resolve) => {
      notifySaved = resolve
    })
    let releaseResponse
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve
    })
    let fulfillResult
    const fulfillFinished = new Promise((resolve) => {
      fulfillResult = resolve
    })
    let canceledRequestFailure
    const requestFailure = new Promise((resolve) => {
      canceledRequestFailure = resolve
    })
    const onRequestFailed = (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/v1/applications'
      ) {
        canceledRequestFailure(request.failure())
        page.off('requestfailed', onRequestFailed)
      }
    }
    page.on('requestfailed', onRequestFailed)
    await page.route('**/api/v1/applications', async (route) => {
      const upstream = await route.fetch()
      notifySaved(upstream)
      await responseGate
      try {
        await route.fulfill({ response: upstream })
        fulfillResult({ fulfilled: true })
      } catch (error) {
        fulfillResult({ fulfilled: false, message: String(error) })
      }
    })
    await page.getByRole('button', { name: 'Отправить заявление' }).click()
    const delayed = await upstreamSaved
    assert.equal(delayed.status(), 201)
    const delayedBody = await delayed.json()
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    const pendingLogoutWarning = page.getByRole('dialog', {
      name: 'Выйти без подтверждения результата?',
    })
    await pendingLogoutWarning.waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1)
    const pendingLogoutText = await pendingLogoutWarning.innerText()
    assert.match(pendingLogoutText, /может сохранить заявление/)
    assert.match(pendingLogoutText, /потерять подтверждение и номер/)
    assert.doesNotMatch(pendingLogoutText, /не сохранен[ао]?/i)
    await page
      .getByRole('dialog', { name: 'Выйти без подтверждения результата?' })
      .getByRole('button', { name: 'Выйти без подтверждения' })
      .click()
    await page.waitForURL(`${baseURL}/login`)
    releaseResponse()
    const [fulfillment, failure] = await Promise.all([fulfillFinished, requestFailure])
    assert.match(failure?.errorText ?? '', /ERR_ABORTED|aborted/i)
    if (!fulfillment.fulfilled) assert.match(fulfillment.message, /abort|cancel/i)
    await page.getByLabel('Логин').fill(loginB)
    await page.getByLabel('Пароль').fill(passwordB)
    await page.getByRole('button', { name: 'Войти' }).click()
    await page.waitForURL(`${baseURL}/schedule`)
    await page.goto(`${baseURL}/services/study_certificate`)
    const latestField = page.getByLabel(/Место предоставления/)
    await latestField.waitFor()
    assert.equal(await latestField.inputValue(), '')
    assert.equal(await page.getByText(`№ ${savedId}`, { exact: false }).count(), 0)
    assert.equal(await page.getByText(firstStudentData, { exact: true }).count(), 0)
    assert.equal(await page.getByText(`№ ${delayedBody.id}`, { exact: false }).count(), 0)
    assert.equal(await page.getByText('Delayed response private A', { exact: true }).count(), 0)
    await page.unroute('**/api/v1/applications')
    await latestField.fill('Private B application cache sentinel')
    const bApplicationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/applications',
    )
    await page.getByRole('button', { name: 'Отправить заявление' }).click()
    assert.equal((await bApplicationResponse).status(), 201)
    await page.getByRole('heading', { name: 'Заявление создано', exact: true }).waitFor()

    // This request completes against the real API. Hold its genuine Response
    // after fetch resolves, change auth generation, then deliver it to apiFetch.
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Выйти из аккаунта?' })
      .getByRole('button', { name: 'Выйти', exact: true })
      .click()
    await page.waitForURL(`${baseURL}/login`)
    await page.getByLabel('Логин').fill(login)
    await page.getByLabel('Пароль').fill(password)
    await page.getByRole('button', { name: 'Войти' }).click()
    await page.waitForURL(`${baseURL}/schedule`)
    await page.goto(`${baseURL}/services/study_certificate`)
    await page.getByLabel(/Место предоставления/).fill('Late successful response private A')
    await page.evaluate(() => window.__latePostControl.arm())
    await page.getByRole('button', { name: 'Отправить заявление' }).click()
    const lateResponse = await page.evaluate(async () => {
      await window.__latePostControl.responseReady
      return window.__latePostControl.response
    })
    assert.equal(lateResponse.status, 201)
    assert.match(lateResponse.headers.location, /^\/api\/v1\/applications\/[1-9][0-9]*$/)
    assert.equal(
      lateResponse.body.form_data.place_of_submission,
      'Late successful response private A',
    )
    await page.getByRole('button', { name: 'Меню пользователя' }).click()
    await page.getByRole('button', { name: 'Выйти', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Выйти без подтверждения результата?' })
      .getByRole('button', { name: 'Выйти без подтверждения' })
      .click()
    await page.waitForURL(`${baseURL}/login`)
    await page.getByLabel('Логин').fill(loginB)
    await page.getByLabel('Пароль').fill(passwordB)
    await page.getByRole('button', { name: 'Войти' }).click()
    await page.waitForURL(`${baseURL}/schedule`)
    await page
      .locator('.desktop-sidebar')
      .getByRole('link', { name: 'Услуги и документы', exact: true })
      .click()
    await page.getByRole('link', { name: 'Мои заявления' }).click()
    await page.getByRole('heading', { name: 'Услуги и документы' }).waitFor()
    const bList = page.locator('.applications-table,.applications-empty')
    await bList.waitFor()
    const bListBeforeLateResponse = await bList.innerText()
    const bListResponses = []
    const onBListResponse = (response) => {
      if (
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/applications'
      )
        bListResponses.push(response)
    }
    page.on('response', onBListResponse)
    await page.evaluate(() => window.__latePostControl.releaseDelivery())
    await page.evaluate(() => window.__latePostControl.clientProcessed)
    assert.equal(
      await page.getByRole('heading', { name: 'Заявление создано', exact: true }).count(),
      0,
      'Account B must not receive A application confirmation',
    )
    assert.deepEqual(
      await bList.innerText(),
      bListBeforeLateResponse,
      'Late A response must not change account B application list/cache',
    )
    assert.equal(
      bListResponses.length,
      0,
      'Late A response must not invalidate B application cache',
    )
    assert.equal(await page.getByText(`№ ${lateResponse.body.id}`, { exact: false }).count(), 0)
    assert.equal(
      await page.getByText('Late successful response private A', { exact: true }).count(),
      0,
    )

    // Observe the cache across a remount while a real B refetch is held. A
    // destroyed cache shows the loading state; a retained cache keeps its data.
    await page.getByRole('link', { name: 'Каталог услуг', exact: true }).click()
    let notifyBRefresh
    const bRefreshStarted = new Promise((resolve) => {
      notifyBRefresh = resolve
    })
    let releaseBRefresh
    const bRefreshGate = new Promise((resolve) => {
      releaseBRefresh = resolve
    })
    let finishBRefresh
    const bRefreshFinished = new Promise((resolve) => {
      finishBRefresh = resolve
    })
    await page.route('**/api/v1/applications?*', async (route) => {
      const upstream = await route.fetch()
      notifyBRefresh()
      await bRefreshGate
      await route.fulfill({ response: upstream })
      finishBRefresh()
    })
    const bRefreshResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/v1/applications',
    )
    await page.getByRole('link', { name: 'Мои заявления' }).click()
    await bRefreshStarted
    const bCacheRetainedWhileRefreshing = await page.locator('.applications-table').isVisible()
    const bCacheContentWhileRefreshing = bCacheRetainedWhileRefreshing
      ? await page.locator('.applications-table').innerText()
      : ''
    releaseBRefresh()
    await Promise.all([bRefreshFinished, bRefreshResponse])
    await page.unroute('**/api/v1/applications?*')
    assert.equal(
      bCacheRetainedWhileRefreshing,
      true,
      'Account B cached application rows remain available during a background refresh',
    )
    assert.equal(bCacheContentWhileRefreshing, bListBeforeLateResponse)
    page.off('response', onBListResponse)
    postResponses.splice(1)
    console.log(
      'PASS: browser cancellation and a delivered late successful A response are distinct; B stays isolated',
    )
  }

  await page.getByRole('link', { name: 'Каталог услуг', exact: true }).click()
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  const maxField = page.getByLabel(/Место предоставления/)
  const maxValue = 'А'.repeat(299) + '😀'
  await maxField.fill(maxValue)
  const maxResponseWaiter = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/applications',
  )
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  const maxResponse = await maxResponseWaiter
  assert.equal(maxResponse.status(), 201)
  assert.equal(Array.from((await maxResponse.json()).form_data.place_of_submission).length, 300)
  await page.getByRole('link', { name: 'К каталогу услуг' }).click()
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  const overLimitField = page.getByLabel(/Место предоставления/)
  await overLimitField.fill('А'.repeat(300) + '😀')
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByText(/от 1 до 300 символов/).waitFor()
  assert.equal(await overLimitField.getAttribute('aria-invalid'), 'true')
  assert.equal(postResponses.length, 2, 'A 301-code-point value is rejected before POST')

  let uncertainRequests = 0
  const timeoutField = page.getByLabel(/Место предоставления/)
  await timeoutField.fill('Зависший запрос')
  await page.route('**/api/v1/applications', async (route) => {
    uncertainRequests += 1
    await new Promise((resolve) => setTimeout(resolve, 35_000))
    await route.abort()
  })
  await page.getByRole('button', { name: 'Отправить заявление' }).click()
  await page.getByRole('alert').filter({ hasText: 'Заявление могло сохраниться' }).waitFor({
    timeout: 34_000,
  })
  await page.getByRole('button', { name: 'Отправить заявление' }).waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('button', { name: 'Отправить заявление' }).isDisabled(), true)
  await page.waitForFunction(
    () => document.activeElement?.textContent === 'Проверить результат в моих заявлениях',
  )
  await page.locator('.application-form').evaluate((form) => {
    form.requestSubmit()
    form.requestSubmit()
  })
  assert.equal(uncertainRequests, 1, 'Unknown outcome cannot accidentally submit again')
  assert.equal(postResponses.length, 2, 'Timed out request was not retried')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  console.log(
    'PASS: Unicode boundaries, server field errors, logout warning and POST timeout recovery',
  )

  await page.getByRole('link', { name: 'К каталогу услуг' }).click()
  await page
    .getByRole('dialog', { name: 'Результат отправки неизвестен. Покинуть форму?' })
    .waitFor()
  await page.getByRole('button', { name: 'Покинуть форму' }).click()
  await page.getByRole('heading', { name: 'Услуги и документы' }).waitFor()

  await page.setViewportSize({ width: 360, height: 800 })
  await page.route('**/api/v1/services', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: '999',
            code: 'study_certificate',
            title: 'А'.repeat(280),
          },
        ],
      }),
    }),
  )
  await page.goto(`${baseURL}/services`)
  await page.getByRole('heading', { name: 'А'.repeat(280) }).waitFor()
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 })
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `No horizontal overflow at ${width}px with a long unbroken title`,
    )
  }
  await page.getByRole('link', { name: 'Подать заявление' }).click()
  await page.getByRole('heading', { name: 'Справка об обучении' }).waitFor()
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  }
  await page.getByLabel(/Место предоставления/).fill('Тестовые несохранённые данные')
  await page.getByRole('button', { name: 'Меню пользователя' }).click()
  await page.getByRole('button', { name: 'Выйти', exact: true }).click()
  await page.getByRole('dialog', { name: 'Потерять введённые данные и выйти?' }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  await page.getByRole('button', { name: 'Выйти без сохранения' }).click()
  await page.waitForURL(`${baseURL}/login`)
  assert.equal(await page.getByLabel(/Место предоставления/).count(), 0)
  console.log('PASS: confirmed logout warns once and clears the form')
  await context.close()
  console.log('PASS: 320px and 360px catalog/form without horizontal overflow')
} finally {
  await browser.close()
}
