import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { MockBackendFixture } from './fixtures'
import { setupMockBackend } from './fixtures'
import { allowErrorBanners, expect, test } from './test'

let fixture: MockBackendFixture | null = null

// The viewer confines to the app's reported home. Own a unique directory there;
// never overwrite or recursively remove a pre-existing user/test folder.
let checkDir: string | null = null
/** The fixture page colour, as Chromium will rasterise 0.85/0.15/0.55. */
const DOCUMENT_RGB = [217, 38, 140] as const

/** Raw bitmaps are BGRA or RGBA by platform; accept the colour in either order. */
const documentPixelCounter = `(bitmap) => {
  const near = (a, b) => Math.abs(a - b) <= 24
  let matched = 0
  for (let index = 0; index < bitmap.length; index += 4) {
    const a = bitmap[index], b = bitmap[index + 1], c = bitmap[index + 2]
    if ((near(a, 217) && near(b, 38) && near(c, 140)) || (near(a, 140) && near(b, 38) && near(c, 217))) matched += 1
  }
  return matched
}`

function minimalPdf(): Buffer {
  // The page is one flat, distinctive colour: the oracle looks for it on
  // screen, so viewer chrome, a dark overlay or another window cannot pass.
  const content = Buffer.from('0.85 0.15 0.55 rg 0 0 612 792 re f BT /F1 36 Tf 60 700 Td (ATUM PDF VIEWER TEST) Tj ET')

  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')])
  ]

  let out = Buffer.from('%PDF-1.4\n')
  const offsets: number[] = []

  for (const [index, object] of objects.entries()) {
    offsets.push(out.length)
    out = Buffer.concat([out, Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
  }

  const xref = out.length
  out = Buffer.concat([out, Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)])

  for (const offset of offsets) {
    out = Buffer.concat([out, Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`)])
  }

  return Buffer.concat([
    out,
    Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  ])
}

test.beforeAll(async () => {
  // Production process flags on macOS: the viewer painted nothing in the
  // shipped app while every harness run under `--disable-gpu --no-sandbox`
  // passed. CI Linux needs both flags and keeps the view-only measurement.
  fixture = await setupMockBackend({ productionFlags: process.platform === 'darwin' })
  await fixture.page.waitForSelector('[data-atum-roster]', { state: 'attached', timeout: 120_000 })

  const home = await fixture.page.evaluate(async () => {
    const bridge = (window as unknown as { hermesDesktop: { consumerFiles: { roots: () => Promise<{ home: string }> } } }).hermesDesktop

    return (await bridge.consumerFiles.roots()).home
  })

  checkDir = fs.mkdtempSync(path.join(home, 'atum-pdf-viewer-check-'))
  fs.writeFileSync(path.join(checkDir, 'viewer-check.pdf'), minimalPdf())
})

// eslint-disable-next-line no-empty-pattern -- Playwright reads its fixture list from the destructuring form
test.afterAll(async ({}, testInfo) => {
  try {
    try {
      const bootLog = fixture && path.join(fixture.sandbox.hermesHome, 'logs', 'desktop.log')

      if (testInfo.status !== testInfo.expectedStatus && bootLog && fs.existsSync(bootLog)) {
        await testInfo.attach('isolated-backend-boot.log', { path: bootLog, contentType: 'text/plain' })
      }
    } finally {
      await fixture?.cleanup()
    }
  } finally {
    fixture = null

    if (checkDir) {
      fs.rmSync(checkDir, { force: true, recursive: true })
      checkDir = null
    }
  }
})

test('a PDF opened from the Files panel is actually painted, not just mounted', async () => {
  allowErrorBanners()
  const page = fixture!.page
  // The split layout needs 1600 CSS px; a smaller display gets an oversize
  // window shifted left so the workspace pane, on the right, is on screen.
  await fixture!.app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const display = screen.getPrimaryDisplay().workArea
    win?.setSize(1700, 1000)
    win?.setPosition(Math.min(0, display.x + display.width - 1700), display.y)
  })
  await page.waitForFunction(() => window.innerWidth >= 1600)

  // With no chat open the composer floats over the workspace and holds the
  // app-view overlay, which rightly keeps a native view off screen. Open a
  // chat first so the composer docks, as it is whenever a person reads a PDF.
  const newChat = page.getByRole('button', { name: /Bắt đầu trò chuyện mới|Start a new chat|New chat/u }).first()

  if (await newChat.count()) {
    await newChat.dispatchEvent('click')
    await page.waitForTimeout(1500)
  }

  // Atum Shell v2: a fresh profile at this width starts with the workspace
  // open, and the chat header offers the open control only while it is
  // closed. Open it when needed; either way, wait for the panel.
  // The fixture's locale differs between hosts (Vietnamese-first locally,
  // English in CI), so match the real control under either name.
  if ((await page.locator('[data-atum-workspace]').count()) === 0) {
    await page.getByRole('button', { name: /^(Open workspace|Mở bảng làm việc)$/u }).dispatchEvent('click')
  }

  await page.locator('[data-atum-workspace]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByRole('button', { name: /^(Files|Tệp)$/u }).first().dispatchEvent('click')
  await page.getByRole('group', { name: /^(Places|Vị trí)$/u })
    .getByRole('button', { name: /^(Home|Thư mục cá nhân)$/u }).dispatchEvent('click')

  const folder = page.getByRole('option', { name: path.basename(checkDir!) })
  await folder.waitFor({ state: 'attached', timeout: 30_000 })
  await folder.dispatchEvent('dblclick')

  const row = page.getByRole('option', { name: 'viewer-check.pdf' })
  await row.waitFor({ state: 'attached', timeout: 30_000 })
  await row.dispatchEvent('dblclick')

  await expect(page.getByTestId('atum-pdf-pane')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('atum-pdf-pane-error')).toBeHidden()

  // A guest cannot render a PDF, so the pane must not be hosting one.
  expect(await page.locator('webview').count()).toBe(0)

  // The viewer is a main-owned view: inspect the view the controller attached
  // to this window, rather than Electron's global WebContents registry. A PDF
  // MIME handler creates nested guests there while it starts; they are not the
  // controller-owned surface and can replace the file URL with an extension
  // URL. Look for the document's own colour — viewer chrome is not a document.
  // A mounted-but-blank viewer is the bug this covers.
  const painted = await fixture!.app.evaluate(async ({ BrowserWindow }, input) => {
    const deadline = Date.now() + 30_000

    const count = new Function(`return (${input.counter})`)() as (bitmap: Buffer) => number
    let last: { ink: number; pixels: number } | null = null
    let lastUrl = ''
    let children: string[] = []

    while (Date.now() < deadline) {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find((child: unknown) => {
        const contents = (child as { webContents?: { getURL: () => string } }).webContents

        if (!contents) {
          return false
        }

        try {
          return new URL(contents.getURL()).pathname.endsWith('/viewer-check.pdf')
        } catch {
          return false
        }
      })

      children = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).map((child: unknown) => {
        const contents = (child as { webContents?: { getURL: () => string } }).webContents

        return contents?.getURL().slice(0, 160) ?? 'non-web-contents child'
      })

      const contents = view && (view as { webContents?: { capturePage: () => Promise<{ toBitmap: () => Buffer }>; getURL: () => string; isLoading: () => boolean } }).webContents

      if (contents && !contents.isLoading()) {
        const bitmap = (await contents.capturePage()).toBitmap()
        last = { ink: count(bitmap), pixels: bitmap.length / 4 }
        lastUrl = contents.getURL()

        if (last.ink > last.pixels * 0.15) {
          return { ...last, viewerUrl: lastUrl, children }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 250))
    }

    return {
      ink: last?.ink ?? 0,
      pixels: last?.pixels ?? 0,
      timedOut: true,
      viewerUrl: lastUrl,
      children
    }
  }, { counter: documentPixelCounter })

  // These are Chromium PDF Open Parameters, interpreted by Electron 44's
  // bundled Chromium viewer: Fit is fit-to-page and navpanes=0 opens its
  // thumbnail sidebar collapsed. The viewer itself owns the hamburger that
  // can open that sidebar after the initial state.
  const paneState = await page.evaluate(() => ({
    error: document.querySelector('[data-testid="atum-pdf-pane-error"]')?.textContent ?? null,
    paneMounted: Boolean(document.querySelector('[data-testid="atum-pdf-pane"]')),
    state: document.querySelector('[data-atum-pdf-state]')?.getAttribute('data-atum-pdf-state') ?? null,
    overlayCount: document.querySelector('[data-atum-pdf-overlay-count]')?.getAttribute('data-atum-pdf-overlay-count') ?? null,
    surfaces: {
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      presentations: Array.from(document.querySelectorAll('[role="presentation"]')).map(el => (el.getAttribute('data-testid') || el.getAttribute('aria-label') || el.className.toString().slice(0, 40))).slice(0, 5),
      openPortals: Array.from(document.querySelectorAll('[data-state="open"]')).map(el => el.getAttribute('role') || el.tagName).slice(0, 6),
      poppedOutComposers: document.querySelectorAll('[data-popped-out]').length,
      bootFailure: (document.querySelector('[data-testid="boot-failure-overlay"]') as HTMLElement | null)?.innerText?.replace(/\s+/gu, ' ').slice(0, 400) ?? null,
      testIds: Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid')).filter(id => /overlay|banner|notification|connect|boot|install|onboard|pet/iu.test(id || '')).slice(0, 8),
      composers: document.querySelectorAll('[data-slot="composer-rich-input"], [data-composer]').length
    },
    drawer: document.querySelector('[data-atum-workspace]')?.getAttribute('data-atum-drawer') ?? null,
    motion: document.querySelector('[data-atum-workspace]')?.getAttribute('data-atum-motion') ?? null
  }))

  // What the window shows, not what the view holds: a native view can paint
  // into its own surface and still never composite into the window (an
  // in-memory partition did exactly that). Only an OS capture sees the
  // composite, so on macOS the assertion is on the screen at the pane's box.
  // What the window shows, not what the view holds: a native view can paint
  // into its own surface and still never composite into the window (an
  // in-memory partition did exactly that). Only an OS capture sees the
  // composite, so on macOS the oracle is the document's own colour on the
  // screen at the pane's box.
  const composed =
    process.platform === 'darwin'
      ? await (async () => {
          const rect = await page.locator('[data-testid="atum-pdf-pane"]').evaluate(el => el.getBoundingClientRect().toJSON())
          const shot = path.join(os.tmpdir(), `atum-pdf-composed-${process.pid}.png`)
          await fixture!.app.evaluate(({ BrowserWindow, app }) => {
            app.focus({ steal: true })
            BrowserWindow.getAllWindows()[0]?.focus()
          })
          let last: { children: unknown; document: number; pixels: number; crop: number[] } | null = null

          try {
            for (let attempt = 0; attempt < 12; attempt += 1) {
              await page.waitForTimeout(800)
              execFileSync('screencapture', ['-x', shot])
              last = await fixture!.app.evaluate(
                ({ BrowserWindow, nativeImage, screen }, input) => {
                  const win = BrowserWindow.getAllWindows()[0]!
                  const image = nativeImage.createFromPath(input.shot)
                  const size = image.getSize()
                  const scale = size.width / screen.getPrimaryDisplay().bounds.width
                  const content = win.getContentBounds()
                  // The window may be wider than the display: intersect the
                  // pane's box with the screen on every side.
                  const left = Math.max(0, Math.round((content.x + input.rect.x) * scale))
                  const top = Math.max(0, Math.round((content.y + input.rect.y) * scale))
                  const right = Math.min(size.width, Math.round((content.x + input.rect.x + input.rect.width) * scale))
                  const bottom = Math.min(size.height, Math.round((content.y + input.rect.y + input.rect.height) * scale))
                  const crop = [left, top, Math.max(0, right - left), Math.max(0, bottom - top)]

                  if (crop[2]! < 200 || crop[3]! < 200) {
                    return { children: win.contentView.children.map((child: { getBounds: () => unknown }) => child.getBounds()), crop, document: 0, pixels: 0 }
                  }

                  const bitmap = image.crop({ height: crop[3]!, width: crop[2]!, x: crop[0]!, y: crop[1]! }).toBitmap()

                  const count = new Function(`return (${input.counter})`)() as (bitmap: Buffer) => number

                  return { children: win.contentView.children.map((child: { getBounds: () => unknown }) => child.getBounds()), crop, document: count(bitmap), pixels: bitmap.length / 4 }
                },
                { counter: documentPixelCounter, rect, shot }
              )

              if (last.pixels > 0 && last.document > Math.max(20_000, last.pixels * 0.1)) {
                break
              }
            }
          } finally {
            // For a failing run: ATUM_PDF_KEEP_SHOT=/path keeps the last capture.
            if (process.env.ATUM_PDF_KEEP_SHOT && fs.existsSync(shot)) {
              fs.copyFileSync(shot, process.env.ATUM_PDF_KEEP_SHOT)
            }

            fs.rmSync(shot, { force: true })
          }

          return { ...last!, rect }
        })()
      : null

  const diagnostics = `pane=${JSON.stringify(paneState)} painted=${JSON.stringify(painted)}`

  // Chromium's viewer paints a dark chrome around the page, so a working
  // viewer is mostly non-white; a blank one is exactly zero.
  expect(painted.ink, `viewer shows no document pixels (${JSON.stringify(DOCUMENT_RGB)}): ${diagnostics}`).toBeGreaterThan(painted.pixels * 0.15)

  // Check the URL of the same controller-owned view that painted the
  // document, after reporting any paint failure with its child-view state.
  expect(painted.viewerUrl, `viewer URL did not retain its open parameters: ${diagnostics}`).toContain('#view=Fit&navpanes=0')

  if (composed) {
    expect(composed.pixels, `pane is not on screen enough to measure: ${JSON.stringify(composed)}`).toBeGreaterThan(0)
    expect(composed.document, `window shows no document at the pane: ${JSON.stringify(composed)} ${diagnostics}`).toBeGreaterThan(Math.max(20_000, composed.pixels * 0.1))
  }

  // Native PDF views sit above DOM z-index. A compact roster must detach the
  // view for its entire drawer lifetime, then restore the same live document.
  await fixture!.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 700)
    BrowserWindow.getAllWindows()[0]?.setPosition(0, 25)
  })
  await page.waitForFunction(() => window.innerWidth < 1024)

  const pdfAttached = () => fixture!.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.contentView.children.some((child: unknown) => {
      const url = (child as { webContents?: { getURL: () => string } }).webContents?.getURL()

      try {
        return Boolean(url && new URL(url).pathname.endsWith('/viewer-check.pdf'))
      } catch {
        return false
      }
    }))

  await expect.poll(pdfAttached).toBe(true)

  const pdfViewId = () => fixture!.app.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows()[0]!.contentView.children.find((child: unknown) => {
      const contents = (child as { webContents?: { getURL: () => string } }).webContents

      try { return Boolean(contents && new URL(contents.getURL()).pathname.endsWith('/viewer-check.pdf')) } catch { return false }
    }) as { webContents?: { id: number } } | undefined

    return child?.webContents?.id
  })

  const originalViewId = await pdfViewId()

  if (originalViewId === undefined) {
    throw new Error('the attached PDF did not expose a WebContents ID')
  }

  expect(originalViewId).toBeGreaterThan(0)

  const retainedPdfView = (id: number) => fixture!.app.evaluate(({ webContents }, input) => {
    const view = webContents.fromId(input)

    return view
      ? { destroyed: view.isDestroyed(), id: view.id, url: view.getURL() }
      : null
  }, id)

  const originalView = await retainedPdfView(originalViewId)

  if (!originalView) {
    throw new Error(`the attached PDF view ${originalViewId} was not live`)
  }

  expect(originalView.destroyed).toBe(false)
  expect(originalView.url).toContain('#view=Fit&navpanes=0')

  // Closing the action panel retains its PDF tab and document, while detaching
  // the native view so it cannot obscure the conversation beneath it.
  await page.getByTestId('atum-workspace-close').click()
  await expect(page.locator('[data-atum-workspace]')).toBeHidden()
  await expect.poll(pdfAttached).toBe(false)
  expect(await retainedPdfView(originalViewId)).toEqual(originalView)
  await page.locator('[data-atum-main-header] [data-atum-open-workspace]').click()
  await expect(page.getByTestId('atum-pdf-pane')).toBeVisible()
  await expect.poll(pdfAttached).toBe(true)
  expect(await pdfViewId()).toBe(originalViewId)

  // The closed roster stays mounted, hidden and inert, with its own controls;
  // the live toggle is the one outside any inert subtree.
  await page.locator('[data-atum-window-controls]:not([inert] *) [data-atum-sidebar-toggle]').click()
  await expect.poll(pdfAttached).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-atum-roster]')).toBeHidden()
  await expect.poll(pdfAttached).toBe(true)
  expect(await pdfViewId()).toBe(originalViewId)
})
