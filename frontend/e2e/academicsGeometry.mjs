/* global document, window, getComputedStyle, HTMLElement, Node */
import assert from 'node:assert/strict'

export async function scaleVisibleText(page, factor, selector = 'body', scaleRoot = true) {
  await page.evaluate(
    ({ factor, selector, scaleRoot }) => {
      const container = document.querySelector(selector)
      const sizes = [container, ...container.querySelectorAll('*')]
        .filter(
          (e) =>
            e instanceof HTMLElement &&
            ([...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) ||
              e.matches('input,textarea')),
        )
        .map((e) => [e, parseFloat(getComputedStyle(e).fontSize)])
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize)
      if (scaleRoot) document.documentElement.style.fontSize = `${root * factor}px`
      for (const [e, size] of sizes) e.style.fontSize = `${size * factor}px`
    },
    { factor, selector, scaleRoot },
  )
}

export async function assertAcademicsGeometry(page, width, label) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  )
  const tables = page.getByRole('table')
  assert.equal(await tables.count(), 2, `${label}: both named tables must exist`)
  const container = await page.locator('.academics-page').boundingBox()
  const root = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  )
  const compact = container.width <= 48 * root
  for (const table of await tables.all()) {
    const snapshot = await table.ariaSnapshot()
    assert.match(snapshot, /columnheader.*Дисциплина/, `${label}: table headers remain accessible`)
    const rows = table.locator('tbody tr')
    assert.ok((await rows.count()) >= 4, `${label}: actual prepared fixture rows must be loaded`)
    for (const row of await rows.all()) {
      const title = row.getByRole('rowheader')
      const titleBox = await title.boundingBox()
      assert.ok(
        titleBox.width >= (compact ? container.width - 32 : 0.4 * container.width - 52),
        `${label}: readable discipline width ${titleBox.width} in container ${container.width}`,
      )
      const cells = await row.locator('th,td').evaluateAll((els) =>
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
            text: e.textContent.trim().slice(0, 100),
          }
        }),
      )
      assert.equal(cells.length, 3, `${label}: all three fields must exist`)
      for (const cell of cells)
        assert.ok(
          cell.scroll <= cell.client + 1,
          `${label}: cell content is not clipped ${JSON.stringify(cell)}`,
        )
      for (let i = 1; i < cells.length; i++) {
        const a = cells[i - 1],
          b = cells[i]
        assert.ok(
          b.x >= a.right - 1 || b.y >= a.bottom - 1,
          `${label}: academic fields do not overlap`,
        )
      }
      if (compact)
        assert.ok(cells[1].y >= cells[0].bottom - 1, `${label}: title spans the compact card`)
      else
        assert.ok(
          Math.abs(cells[1].y - cells[0].y) < 1,
          `${label}: wide container retains table layout`,
        )
    }
  }
  for (const text of await page.locator('.academics-session .academics-label').all()) {
    const metrics = await text.evaluate((e) => {
      const range = document.createRange()
      range.selectNodeContents(e)
      const rects = [...range.getClientRects()]
      return {
        text: e.textContent,
        lines: rects.length,
        width: e.getBoundingClientRect().width,
        scroll: e.scrollWidth,
        client: e.clientWidth,
      }
    })
    assert.ok(metrics.scroll <= metrics.client + 1, `${label}: visible result ${metrics.text}`)
    assert.equal(
      metrics.lines,
      1,
      `${label}: result phrase is not broken into narrow word fragments`,
    )
  }
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${label}: no page overflow at ${width}`,
  )
}
