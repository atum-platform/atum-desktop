// Run in the installed browser after opening the fixture and performing the indicated action.
// Throws on the clipping/blank-space regression that DOM-only tests cannot detect.
export function checkPickerLayout(mode) {
  const list = document.querySelector('[data-matrix-model-list]')
  const takeover = document.querySelector('[data-matrix-chatgpt-training]')
  const card = document.querySelector('[data-proof-card], [data-slot="popover-content"]')
  const scroller = takeover || list
  const metrics = {
    cardHeight: card.clientHeight,
    cardWidth: card.clientWidth,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  assert(card.scrollHeight <= card.clientHeight + 1, 'Card clips overflowing children')
  assert(card.clientHeight <= Math.min(innerHeight * 0.8, 360), 'Card exceeds viewport cap')
  if (mode === 'short') {
    assert(scroller.scrollHeight === scroller.clientHeight, 'Short list unnecessarily scrolls')
    assert(
      card.clientHeight === document.querySelector('[data-matrix-model-panel]').clientHeight,
      'Blank strip below panel'
    )
    assert(card.clientHeight < 256, 'Short card retains the old minimum height')
  } else {
    assert(scroller.scrollHeight > scroller.clientHeight, 'Long content has no scroll range')
    if (mode.endsWith('-scrolled')) {
      assert(scroller.scrollTop > 0, 'Wheel failed to scroll')
      const last = takeover
        ? document.querySelector('[data-matrix-chatgpt-training-keep]')
        : [...list.querySelectorAll('[data-matrix-model-route]')].at(-1)
      const row = last.getBoundingClientRect(),
        bounds = scroller.getBoundingClientRect()
      assert(row.top >= bounds.top && row.bottom <= bounds.bottom, 'Last action is unreachable')
    }
  }
  return metrics
}
