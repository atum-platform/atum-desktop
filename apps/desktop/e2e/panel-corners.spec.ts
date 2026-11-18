import { readFile } from 'node:fs/promises'

import { expect, test } from '@playwright/test'

test('clips every main-content foot to the Kit panel radius', async ({ page }) => {
  const stylesheet = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

  await page.setContent(`
    <main class="atum-shell" data-atum-rail data-atum-shell>
      <section data-case="single">
        <div data-atum-main>
          <div data-atum-main-split><section data-atum-chat></section></div>
        </div>
      </section>
      <section data-case="team-space">
        <div data-atum-main data-atum-team-roster>
          <div data-atum-main-split>
            <section data-atum-chat><div data-matrix-company-content></div></section>
          </div>
        </div>
      </section>
      <section data-case="split">
        <div data-atum-main>
          <div data-atum-main-split>
            <section data-atum-chat></section>
            <aside data-atum-drawer="false" data-atum-full-frame="false" data-atum-workspace></aside>
          </div>
        </div>
      </section>
      <section data-case="full-frame">
        <div data-atum-main data-atum-workspace-over-frame>
          <div data-atum-main-split>
            <section data-atum-chat></section>
            <aside data-atum-drawer="false" data-atum-full-frame="true" data-atum-workspace></aside>
          </div>
        </div>
      </section>
    </main>
  `)
  await page.addStyleTag({ content: stylesheet })

  for (const mode of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), mode)

    const cases = {
      main: '[data-case="single"] [data-atum-chat]',
      teamSpaceMain: '[data-case="team-space"] [data-matrix-company-content]',
      splitMain: '[data-case="split"] [data-atum-chat]',
      splitSidePanel: '[data-case="split"] [data-atum-workspace]',
      fullFrame: '[data-case="full-frame"] [data-atum-workspace]'
    }

    for (const [name, selector] of Object.entries(cases)) {
      const panel = page.locator(selector)
      await expect(panel, `${mode} ${name} bottom left`).toHaveCSS('border-bottom-left-radius', '14px')
      await expect(panel, `${mode} ${name} bottom right`).toHaveCSS('border-bottom-right-radius', '14px')
    }
  }
})
