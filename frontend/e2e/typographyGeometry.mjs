/* global document, window, getComputedStyle, Node */
import assert from 'node:assert/strict'

export async function assertReadableText(page, selectors, label, minimum) {
  for (const selector of selectors) {
    const metrics = await page.locator(selector).evaluateAll((els) =>
      els
        .filter((e) => e.getClientRects().length)
        .map((e) => {
          const box = e.getBoundingClientRect(),
            style = getComputedStyle(e)
          const ranges = []
          const walker = document.createTreeWalker(e, Node.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode
            if (
              !node.textContent.trim() ||
              node.parentElement.closest('[aria-hidden="true"],.sr-only')
            )
              continue
            const range = document.createRange()
            range.selectNodeContents(node)
            for (const r of range.getClientRects())
              if (r.width && r.height)
                ranges.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })
          }
          return {
            text: e.textContent.slice(0, 100),
            font: parseFloat(style.fontSize),
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            ranges,
          }
        }),
    )
    assert.ok(metrics.length > 0, `${label}: expected visible ${selector}`)
    for (const m of metrics) {
      assert.ok(m.font >= minimum - 0.1, `${label}: ${selector} computed font ${m.font}`)
      for (const r of m.ranges)
        assert.ok(
          r.left >= m.left - 1 &&
            r.right <= m.right + 1 &&
            r.top >= m.top - 1 &&
            r.bottom <= m.bottom + 1,
          `${label}: text fits ${selector}: ${m.text} ${JSON.stringify({ m, r })}`,
        )
    }
  }
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${label}: no horizontal text overflow`,
  )
}

export async function assertScheduleControlGeometry(page, label) {
  const boxes = await page
    .locator('.schedule-heading > div,.schedule-toolbar > *')
    .evaluateAll((els) =>
      els
        .filter((e) => e.getClientRects().length)
        .map((e) => {
          const b = e.getBoundingClientRect()
          return {
            text: e.textContent.slice(0, 60),
            left: b.left,
            right: b.right,
            top: b.top,
            bottom: b.bottom,
          }
        }),
    )
  assert.equal(boxes.length, 5, `${label}: heading and all four control groups exist`)
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j]
      assert.ok(
        a.right <= b.left + 1 ||
          b.right <= a.left + 1 ||
          a.bottom <= b.top + 1 ||
          b.bottom <= a.top + 1,
        `${label}: non-overlapping schedule controls ${JSON.stringify({ a, b })}`,
      )
    }
  const topbar = await page.locator('.student-topbar').boundingBox()
  const note = await page.locator('.topbar-prototype-note').boundingBox()
  assert.ok(
    note.y >= topbar.y - 1 && note.y + note.height <= topbar.y + topbar.height + 1,
    `${label}: prototype note fits the growing topbar`,
  )
}
