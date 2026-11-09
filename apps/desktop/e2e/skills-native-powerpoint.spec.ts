import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { UTILITY_IPC } from '../shared/atum-utilities'

import { type MockBackendFixture, setupMockBackend, waitForAppReady } from './fixtures'
import { expect, test } from './test'

// Native opt-in. Inference is scripted; renderer, gateway, skill and tools run.
test.skip(
  process.platform !== 'darwin' || process.env.ATUM_NATIVE_SKILLS_SMOKE !== '1',
  'requires an unlocked Mac with PowerPoint'
)
let fixture: MockBackendFixture
let directory: string
let deck: string
let lastMessages: Array<Record<string, unknown>> = []
const python = path.resolve('../../.venv/bin/python')
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
test.beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.homedir(), 'atum-skills-proof-'))
  deck = path.join(directory, 'Atum-skills-proof.pptx')
  execFileSync(python, [
    '-c',
    'from pptx import Presentation; import sys; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text="ATUM SAVED ONE"; p.save(sys.argv[1])',
    deck
  ])
  fs.writeFileSync(
    path.join(directory, 'edit_copy.py'),
    `import sys,zipfile\nfrom pathlib import Path\nsource=Path(sys.argv[1])\nassert source.name.startswith("context-")\nwith zipfile.ZipFile(source) as src, zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as dst:\n for item in src.infolist():\n  data=src.read(item.filename)\n  if item.filename == "ppt/slides/slide1.xml":\n   assert b"ATUM SAVED TWO" in data\n   data=data.replace(b"ATUM SAVED TWO",b"ATUM REVIEWED COPY")\n  dst.writestr(item,data)\nprint("Created Reviewed-copy.pptx")\n`
  )
  let step = 0
  fixture = await setupMockBackend({
    accountId: 'e2e-skills-account',
    extraConfig: `terminal:\n  backend: local\n  cwd: ${JSON.stringify(directory)}\n`,
    mockServer: {
      completionScript: messages => {
        if (!JSON.stringify(messages).includes('E2E_SKILLS_EDIT') ||
            String(messages[0]?.content).startsWith('Generate a short, descriptive title')) {
          return null
        }

        lastMessages = messages

        if (step++ === 0) {
          return {
            text: 'Loading the presentation skill.',
            toolCalls: [{ name: 'skill_view', args: { name: 'powerpoint' } }]
          }
        }

        if (step === 2) {
          const context = messages
            .filter(row => row.role === 'user')
            .map(row => String(row.content))
            .join('\n')

          const resource = context.match(
            /"resource_path"\s*:\s*"(\.hermes\/desktop-attachments\/context-[a-f0-9-]+\.pptx)"/u
          )?.[1]

          if (!resource) {
            return { text: 'Missing staged file context.' }
          }

          return {
            text: 'Editing the captured copy.',
            toolCalls: [
              {
                name: 'terminal',
                args: { command: `python3 '${directory}/edit_copy.py' '${resource}' '${directory}/Reviewed-copy.pptx'` }
              }
            ]
          }
        }

        return { text: 'E2E_SKILLS_COMPLETE: Created Reviewed-copy.pptx.' }
      }
    }
  })
  await fixture.app.evaluate(({ ipcMain }, channels) => {
    ipcMain.removeHandler(channels.status)
    ipcMain.handle(channels.status, () => ({
      status: {
        accountId: 'e2e-skills-account',
        generation: 1,
        sources: [],
        available: { google: false, 'apple-calendar': false }
      }
    }))
  }, UTILITY_IPC)
  await fixture.page.reload({ waitUntil: 'domcontentloaded' })
  await waitForAppReady(fixture, 120_000, { preserveWorkspace: true })
  // Only the OS picker is replaced; actual native launch and file grants run.
  await fixture.app.evaluate(({ ipcMain }, file) => {
    ipcMain.removeHandler('atum:native-apps:choose-file')
    ipcMain.handle('atum:native-apps:choose-file', () => file)
  }, deck)
})
// Playwright requires an object-pattern fixture argument.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await testInfo.attach("Scripted inference transcript", { body: JSON.stringify(lastMessages), contentType: "application/json" })
})
test.afterAll(async () => {
  if (deck) {
    try {
      execFileSync(
        'osascript',
        [
          '-e',
          `tell application "Microsoft PowerPoint"\nrepeat with i from (count presentations) to 1 by -1\ntry\nset p to presentation i\nif full name of p is ${JSON.stringify(deck)} or full name of p is ${JSON.stringify(path.join(directory, "Reviewed-copy.pptx"))} or full name of p is ${JSON.stringify(path.join(directory, "Other-window.pptx"))} then close p saving no\nend try\nend repeat\nend tell`
        ],
        { timeout: 8000 }
      )
    } catch {
      /* only this disposable document */
    }
  }

  // End only this isolated test app even if a native pairing intercepts Close.
  await fixture?.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await fixture?.cleanup()

  if (directory) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
// eslint-disable-next-line no-empty-pattern
test('the launcher sends fresh saved bytes and the gateway edits a separate copy', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const page = fixture.page
  await page.evaluate(async () => {
    const bridge = (
      window as unknown as { hermesDesktop: { api: (request: Record<string, unknown>) => Promise<unknown> } }
    ).hermesDesktop

    await bridge.api({ path: '/api/skills/bundled/add', method: 'POST', body: { name: 'powerpoint' } })
  })
  await page.locator('[data-atum-workspace-add]').click()
  await page.getByRole('button', { name: /^(Skills|Kỹ năng)$/u }).click()
  await page.locator('[data-atum-skills-launcher] input').fill('PowerPoint')
  const tile = page.locator('[data-launcher-tile^="app:"]').filter({ hasText: 'PowerPoint' })
  await expect(tile).toHaveCount(1, { timeout: 30_000 })
  await expect(tile).not.toHaveAttribute('data-launcher-status', 'checking', { timeout: 30_000 })
  await tile.focus()
  await tile.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'App capability', exact: true }).click()
  const capability = page.locator('[data-atum-app-capability-dialog]')
  await expect(capability).toBeVisible()
  await expect(capability).toContainText('Available operations')
  await expect(capability).not.toContainText('missing-tool:')
  await testInfo.attach('PowerPoint capability card', { body: await page.screenshot(), contentType: 'image/png' })
  await capability.getByRole('button', { name: 'Close', exact: true }).first().click()
  await tile.focus()
  await tile.press('Shift+F10')
  // Prove the chooser continuation with another real disposable window open.
  const otherDeck = path.join(directory, 'Other-window.pptx')
  fs.copyFileSync(deck, otherDeck)
  execFileSync('open', ['-a', 'Microsoft PowerPoint', otherDeck])
  await expect.poll(() => execFileSync('osascript', ['-e', 'tell application "Microsoft PowerPoint" to get name of every presentation'], { encoding: 'utf8', timeout: 8000 }), { timeout: 15000 }).toContain('Other-window.pptx')
  // The existing helper requires distinct native frames to prove window IDs.
  execFileSync('osascript', ['-e', 'tell application "System Events" to tell process "Microsoft PowerPoint"\nrepeat with w in windows\nif name of w contains "Other-window" then\nset position of w to {110, 140}\nset size of w to {740, 560}\nend if\nend repeat\nend tell'], { timeout: 8000 })
  await page.getByRole('menuitem', { name: /Open file|Mở tệp/u }).click()
  const chooser = page.getByRole('group', { name: 'Choose a window to place beside chat' })
  await expect(chooser).toBeVisible({ timeout: 30000 })
  await chooser.getByRole('button').filter({ hasText: 'Atum-skills-proof' }).click()
  await expect(page.locator('[aria-label]').filter({ hasText: 'Atum-skills-proof.pptx' }).first()).toBeVisible({
    timeout: 30_000
  })
  execFileSync(
    'osascript',
    [
      '-e',
      `tell application "Microsoft PowerPoint"\nset content of text range of text frame of shape 1 of slide 1 of presentation ${JSON.stringify(path.basename(deck))} to "ATUM SAVED TWO"\nsave presentation ${JSON.stringify(path.basename(deck))}\nend tell`
    ],
    { timeout: 15000 }
  )
  const savedHash = hash(deck)
  const input = page.locator('[data-slot="composer-rich-input"][contenteditable="true"]').first()
  await input.fill('E2E_SKILLS_EDIT: edit the attached presentation and return a separate copy.')
  await input.press('Enter')
  await expect.poll(() => fs.existsSync(path.join(directory, 'Reviewed-copy.pptx')), { timeout: 90000 }).toBe(true)
  expect(hash(deck)).toBe(savedHash)

  const output = execFileSync(
    python,
    [
      '-c',
      'import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read("ppt/slides/slide1.xml").decode())',
      path.join(directory, 'Reviewed-copy.pptx')
    ],
    { encoding: 'utf8' }
  )

  expect(output).toContain('ATUM REVIEWED COPY')
  expect(fixture.mock.receivedPrompts.some(prompt => prompt.includes('"provenance": "saved-file"'))).toBe(true)
  expect(fixture.mock.receivedPrompts.every(prompt => !prompt.includes(deck))).toBe(true)
  const copy = path.join(directory, 'Reviewed-copy.pptx')
  const officeScripts = path.resolve('../../skills/productivity/powerpoint/scripts/office')
  execFileSync(python, [path.join(officeScripts, 'validate.py'), copy, '--original', deck], { timeout: 30_000 })
  const qa = testInfo.outputPath('office-qa')
  fs.mkdirSync(qa, { recursive: true })
  execFileSync(python, [path.join(officeScripts, 'soffice.py'), '--headless', '--convert-to', 'pdf', '--outdir', qa, copy], { timeout: 40_000 })
  execFileSync('pdftoppm', ['-png', '-singlefile', '-scale-to', '1200', path.join(qa, 'Reviewed-copy.pdf'), path.join(qa, 'slide')], { timeout: 15_000 })
  await testInfo.attach('PowerPoint edited slide', { path: path.join(qa, 'slide.png'), contentType: 'image/png' })
  // Open the result in the actual app as well as validating its OOXML/render.
  execFileSync('open', ['-a', 'Microsoft PowerPoint', copy])
  await expect.poll(() => execFileSync('osascript', ['-e', 'tell application "Microsoft PowerPoint" to get content of text range of text frame of shape 1 of slide 1 of presentation "Reviewed-copy.pptx"'], { encoding: 'utf8', timeout: 8000 }).trim(), { timeout: 15000 }).toBe('ATUM REVIEWED COPY')
  expect(hash(deck)).toBe(savedHash)
  await testInfo.attach('Skills launcher', { body: await page.screenshot(), contentType: 'image/png' })
})
