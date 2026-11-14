/* global document, window, getComputedStyle */
import assert from 'node:assert/strict'

export async function assertStatusChipGeometry(page) {
  const chips = page.locator('.application-status')
  assert.ok((await chips.count()) > 0, 'status geometry requires visible loaded chips')
  for (const chip of await chips.all()) {
    const metrics = await chip.evaluate((e) => {
      const style = getComputedStyle(e),
        dot = getComputedStyle(e, '::before')
      const range = document.createRange()
      range.selectNodeContents(e)
      const text = range.getBoundingClientRect(),
        box = e.getBoundingClientRect()
      return {
        align: style.alignItems,
        gap: style.columnGap,
        width: dot.width,
        height: dot.height,
        shrink: dot.flexShrink,
        margin: dot.margin,
        textCenter: text.top + text.height / 2,
        chipCenter: box.top + box.height / 2,
        scroll: e.scrollWidth,
        client: e.clientWidth,
      }
    })
    assert.equal(metrics.align, 'center')
    assert.equal(metrics.gap, '6px')
    assert.equal(metrics.width, '7px')
    assert.equal(metrics.height, '7px')
    assert.equal(metrics.shrink, '0')
    assert.equal(metrics.margin, '0px')
    assert.ok(
      Math.abs(metrics.textCenter - metrics.chipCenter) <= 2,
      'status text line and fixed dot share a visual center',
    )
    assert.ok(metrics.scroll <= metrics.client + 1, 'status is not clipped')
  }
}

export async function assertApplicationInteractions(page, context, id, width) {
  const link = page.locator(`.applications-table a[data-application-id="${id}"]`)
  const row = link.locator('xpath=ancestor::tr')
  async function pointAt(part) {
    await row.scrollIntoViewIfNeeded()
    const target =
      part === 'date'
        ? row.locator('time')
        : part === 'status'
          ? row.locator('.application-status')
          : part === 'title'
            ? link
            : row
    const b = await target.boundingBox()
    const point =
      part === 'space'
        ? { x: b.x + b.width - 8, y: b.y + 6 }
        : { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    assert.equal(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.dataset.applicationId,
        point,
      ),
      id,
      `${width}: ${part} must hit the single native link`,
    )
    return point
  }
  async function returnToList() {
    await page.getByRole('heading', { name: `Заявление № ${id}`, exact: true }).waitFor()
    await page.getByRole('link', { name: /К моим заявлениям/ }).click()
    await page.waitForFunction((id) => document.activeElement?.dataset.applicationId === id, id)
    assert.equal(await row.getByRole('link').count(), 1, 'one tab stop per row/card')
  }
  for (const part of ['title', 'date', 'status', 'space']) {
    const point = await pointAt(part)
    await page.mouse.move(point.x, point.y)
    if (part === 'title') {
      assert.match(
        await link.evaluate((e) => getComputedStyle(e, '::after').backgroundColor),
        /0\.04/,
        'whole-row hover feedback',
      )
      await page.mouse.down()
      assert.match(
        await link.evaluate((e) => getComputedStyle(e, '::after').backgroundColor),
        /0\.08/,
        'whole-row active feedback',
      )
      await page.mouse.up()
    } else await page.mouse.click(point.x, point.y)
    await returnToList()
  }
  await link.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  assert.equal(await link.evaluate((e) => e === document.activeElement), true)
  assert.equal(
    await link.evaluate((e) => getComputedStyle(e, '::after').outlineWidth),
    '3px',
    'visible whole-row keyboard focus ring',
  )
  await page.keyboard.press('Enter')
  await returnToList()
  const point = await pointAt('date')
  const opened = context.waitForEvent('page')
  await page.keyboard.down('Control')
  await page.mouse.click(point.x, point.y)
  await page.keyboard.up('Control')
  const popup = await opened
  await popup.getByRole('heading', { name: `Заявление № ${id}`, exact: true }).waitFor()
  assert.match(
    page.url(),
    /\/services\?tab=applications$/,
    'Ctrl+click keeps the list in the original tab',
  )
  await popup.close()
  await page.evaluate(() =>
    document.addEventListener(
      'contextmenu',
      (e) => {
        window.__applicationContext = {
          href: e.target.closest('a')?.getAttribute('href'),
          prevented: e.defaultPrevented,
        }
      },
      { once: true },
    ),
  )
  const contextPoint = await pointAt('status')
  await page.mouse.click(contextPoint.x, contextPoint.y, { button: 'right' })
  assert.deepEqual(
    await page.evaluate(() => window.__applicationContext),
    { href: `/applications/${id}`, prevented: false },
    'native link context menu semantics',
  )
}
