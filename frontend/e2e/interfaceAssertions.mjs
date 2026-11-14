/* global URL, document */
import assert from 'node:assert/strict'

// Shared with the negative control: a failed GET must never qualify as a filled-list screenshot.
export async function openApplicationsHappyPath(page, baseURL) {
  // This is a direct-route scenario. Finish the preceding document first so
  // an in-flight GET from its tab/history check cannot satisfy this assertion.
  await page.goto('about:blank')
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === '/api/v1/applications',
  )
  await page.goto(`${baseURL}/services?tab=applications`)
  const response = await pending
  assert.equal(response.status(), 200, `Applications happy-path GET: HTTP ${response.status()}`)
  const data = await response.json()
  assert.ok(
    Array.isArray(data.items) && data.items.length > 0,
    'Applications happy-path requires non-empty real demo seed data',
  )
  const table = page.getByRole('table', { name: 'Ранее отправленные заявления' })
  await table.waitFor()
  await page.waitForFunction(
    (count) => document.querySelectorAll('.applications-table tbody tr').length === count,
    data.items.length,
  )
  assert.equal(
    await page.locator('.service-page [role="alert"]').count(),
    0,
    'Applications happy-path must not contain a network/HTTP error',
  )
  const ids = await table
    .locator('a[data-application-id]')
    .evaluateAll((links) => links.map((link) => link.dataset.applicationId))
  assert.deepEqual(
    ids,
    data.items.map((item) => item.id),
    'Rendered applications must match the successful real GET before geometry checks',
  )
  return data
}
