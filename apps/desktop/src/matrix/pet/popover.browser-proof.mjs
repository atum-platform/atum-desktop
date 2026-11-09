/* global window */
import assert from 'node:assert/strict'
import path from 'node:path'

/** Exercise the actual picker in the built renderer, using the existing synthetic bridge. */
export async function provePetPopover(page, output) {
  await page.locator('[data-pet-hit-box]').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Change companion', exact: true }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await panel.waitFor({ state: 'visible' })
  const states = { Gigi: 'Owned', Cookie: 'Visiting', 'Adopt Bailey': 'Available', Mochi: 'Owned' }
  for (const [name, state] of Object.entries(states)) {
    const choice = panel.getByRole('button', { name, exact: true })
    assert.ok((await choice.innerText()).includes(state))
    await choice.locator('img').waitFor({ state: 'visible' })
    assert.equal(await choice.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), true, name)
  }
  assert.equal(await panel.locator('input[type="range"]').count(), 0)
  assert.equal(await panel.getByRole('textbox', { name: 'Describe your pet' }).getAttribute('data-slot'), 'input')
  const slider = panel.getByRole('slider', { name: 'Size' })
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await slider.getAttribute('aria-valuetext'), '101%')
  assert.deepEqual(await page.evaluate(() => window.petStageProof.writes), [])
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.petStageProof.writes), [{ target: { scope: 'pet-proof', agent: 'agent-a' }, revision: 1, pet: { ref: { kind: 'bundled', slug: 'gigi' }, enabled: true, scale: 1.01 } }])
  const light = path.join(output, 'picker-light.png')
  await page.screenshot({ path: light, animations: 'disabled' })
  await page.evaluate(async () => {
    const snapshot = await window.atumMatrix.snapshot()
    window.petStageProof.emit({ displayPreferences: { ...snapshot.displayPreferences, appearance: { value: 'dark', writable: true } } })
  })
  const dark = path.join(output, 'picker-dark.png')
  await page.screenshot({ path: dark, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  assert.equal(
    await page.locator('[data-slot="composer-rich-input"]').evaluate(input => input === window.document.activeElement),
    true
  )
  return { states, keyboardSize: 1.01, explicitSave: true, escapeReturnsFocus: true, screenshots: [light, dark] }
}
