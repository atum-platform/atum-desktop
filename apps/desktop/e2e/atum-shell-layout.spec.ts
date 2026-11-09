import type { MockBackendFixture } from './fixtures'
import { setupMockBackend, waitForAppReady } from './fixtures'
import { MOCK_REPLY } from './mock-server'
import { allowErrorBanners, expect, test } from './test'

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupMockBackend()
  await waitForAppReady(fixture, 120_000, { preserveWorkspace: true })
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test('Atum shell: a same-level glass sidebar, no title bar, the 50/50 workspace, and the sunk user bubble', async ({
  browserName: _browserName
}, testInfo) => {
  allowErrorBanners()
  const page = fixture!.page
  await fixture!.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1600, 960)
  })
  await page.waitForFunction(() => window.innerWidth >= 1500)

  const roster = page.locator('[data-atum-roster]')
  const chat = page.locator('[data-atum-chat]')
  const workspace = page.locator('[data-atum-workspace]')
  const rail = page.locator('[data-atum-shell] > [data-atum-destination-rail]')

  // No rim, no floating rail, no bar, no product title in the shell. The one
  // rail is the destination rail at the window's left edge. The sidebar's own
  // top row carries the collapse control; search owns create; the footer owns
  // the account menu; the chat column's row carries the identity; and Discover
  // lives in the destination rail, not beside the search field.
  await expect(page.locator('[data-atum-rim]')).toHaveCount(0)
  // The shell itself carries data-atum-rail as a styling hook when the destination rail is
  // present (shell-frame.tsx); what must not exist is a separate floating rail element.
  await expect(page.locator('[data-atum-rail]:not([data-atum-shell])')).toHaveCount(0)
  await expect(page.locator('[data-atum-top-bar]')).toHaveCount(0)
  await expect(page.getByText('Atum - Siêu ứng dụng AI cho người Việt.', { exact: true })).toHaveCount(0)
  await expect(roster.locator('[data-atum-roster-header] [data-atum-sidebar-toggle]')).toBeVisible()
  await expect(roster.locator('[data-atum-roster-footer] [data-atum-account-trigger]')).toBeVisible()
  await expect(roster.locator('[data-atum-search-actions] [data-atum-nav-discover]')).toHaveCount(0)
  await expect(roster.locator('[data-atum-search-actions] [data-atum-create-menu]')).toBeVisible()
  await expect(page.locator('[data-atum-chat] [data-atum-main-header] [data-atum-chat-header]')).toBeVisible()
  // The destination switch is ONE element in the persistent destination rail
  // at the window's left edge (the shell's foot until 2026-09-28) — not on the
  // top row and not inside either column, so it never moves when a column
  // opens or closes beside it.
  await expect(roster.locator('[data-atum-nav-switch]')).toHaveCount(0)
  await expect(page.locator('[data-atum-nav-switch]')).toHaveCount(1)
  const navSwitch = rail.locator('[data-atum-nav-switch]')
  await expect(navSwitch.locator('[data-atum-nav-home]')).toHaveAttribute('aria-current', 'page')
  await expect(navSwitch.locator('[data-atum-nav-discover]')).toBeVisible()
  await expect(navSwitch.locator('[data-atum-nav-workplace]')).toHaveAttribute('aria-disabled', 'true')
  // Every column starts where the rail ends: it is flush with the window's
  // left edge, and nothing is drawn under it.
  const railBox = await rail.boundingBox()
  expect(railBox).not.toBeNull()
  expect(Math.round(railBox!.x)).toBe(0)
  const railRight = Math.round(railBox!.x + railBox!.width)

  // Discover collapses the roster, and the switch stays EXACTLY where it is.
  // It used to jump into the main column and stretch across the window while
  // the roster stayed open beside the storefront with two "Show sidebar"
  // toggles. The box is compared before and after, in a real browser. The
  // roster stays mounted so pending roster work survives: collapsed, it is
  // hidden and inert, so only the live toggle counts.
  const homeSwitchBox = await navSwitch.boundingBox()
  await navSwitch.locator('[data-atum-nav-discover]').click()
  await expect(navSwitch.locator('[data-atum-nav-discover]')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[data-atum-roster-slot]')).toBeHidden()
  await expect(page.locator('[data-atum-sidebar-toggle]:not([inert] *)')).toHaveCount(1)
  await expect.poll(() => navSwitch.boundingBox()).toEqual(homeSwitchBox)
  await navSwitch.locator('[data-atum-nav-home]').click()
  // Wait for the roster to come to rest, not merely appear. The motion phase
  // reads 'open' as the entrance begins; the width transition runs after it,
  // with the panel sliding in right-aligned inside its growing slot (so its x
  // is left of the rail's edge until it lands). The geometry assertions below
  // measure it.
  await expect(page.locator('[data-atum-roster-slot]')).toHaveAttribute('data-atum-motion', 'open')
  await expect
    .poll(async () => Math.round((await roster.boundingBox())?.x ?? -1), { timeout: 5_000 })
    .toBe(railRight)
  await expect.poll(() => navSwitch.boundingBox()).toEqual(homeSwitchBox)

  // The app booted at 1220 (>= the 1024 breakpoint), so the workspace starts
  // open. Chat and workspace split the main region 50/50 (SPEC §2).
  await expect(workspace).toBeVisible()
  await expect
    .poll(
      async () => {
        const [chatBox, workspaceBox] = await Promise.all([chat.boundingBox(), workspace.boundingBox()])

        return chatBox && workspaceBox ? Math.abs(chatBox.width / (chatBox.width + workspaceBox.width) - 0.5) : Number.POSITIVE_INFINITY
      },
      { timeout: 15_000 }
    )
    .toBeLessThanOrEqual(0.02)

  // Same-level: the column is flush against the destination rail and runs the
  // window's full height, and its top row is the shell's one row height — the
  // `--atum-l-header` token every column's top row shares.
  const rowHeight = await page.locator('[data-atum-shell]').evaluate(element => {
    // Measured through a probe, so the answer is pixels however the build spelled it.
    const probe = document.createElement('div')
    probe.style.cssText = 'position: absolute; visibility: hidden; height: var(--atum-l-header)'
    element.append(probe)
    const height = probe.getBoundingClientRect().height
    probe.remove()

    return Math.round(height)
  })

  expect(rowHeight).toBeGreaterThan(0)
  const [rosterBox, shellBoxAtRest, rosterHeaderBox] = await Promise.all([
    roster.boundingBox(),
    page.locator('[data-atum-shell]').boundingBox(),
    roster.locator('[data-atum-roster-header]').boundingBox()
  ])
  expect(rosterBox).not.toBeNull()
  expect(Math.round(rosterBox!.width)).toBe(268)
  expect(Math.round(rosterBox!.x)).toBe(railRight)
  expect(Math.round(rosterBox!.y)).toBe(0)
  expect(Math.round(rosterBox!.height)).toBe(Math.round(shellBoxAtRest!.height))
  expect(Math.round(rosterHeaderBox!.height)).toBe(rowHeight)
  // The chat's row and the workspace's tab bar sit on the same line.
  const [chatHeaderBox, tabbarBox] = await Promise.all([
    page.locator('[data-atum-chat] [data-atum-main-header]').boundingBox(),
    page.locator('[data-atum-workspace-tabbar]').boundingBox()
  ])
  expect(Math.round(chatHeaderBox!.y)).toBe(0)
  expect(Math.round(chatHeaderBox!.height)).toBe(rowHeight)
  expect(Math.round(tabbarBox!.y)).toBe(0)
  expect(Math.round(tabbarBox!.height)).toBe(rowHeight)

  // Resolve each token through a probe so the browser answers in rgb()/rgba()
  // regardless of how the build's minifier spelled the declaration. Glass has
  // two legitimate answers: the translucent SPEC value, or its opaque
  // projection when the host asks for reduced transparency.
  const tokenValues = async () =>
    page.locator('.atum-shell').first().evaluate(element => {
      const probe = document.createElement('span')
      element.append(probe)

      const resolve = (token: string) => {
        probe.style.color = `var(${token})`

        return getComputedStyle(probe).color
      }

      const values = { bg: resolve('--atum-bg'), glass: resolve('--atum-glass'), ink: resolve('--atum-ink') }
      probe.remove()

      return values
    })

  const light = await tokenValues()
  expect(light.bg).toBe('rgb(244, 245, 247)')
  expect(light.ink).toBe('rgb(27, 29, 34)')
  expect(['rgba(255, 255, 255, 0.62)', 'rgb(251, 251, 252)']).toContain(light.glass)

  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('atum-shell-v2-light.png')
  })

  // Dark mode lives in Settings › General now (mock 2b).
  await roster.locator('[data-atum-account-trigger]').click()
  await page.locator('[data-atum-account-menu] [data-atum-nav-settings]').click()
  await page.getByRole('radio', { name: /^(Dark|Tối)$/u }).click()
  await expect.poll(() => page.locator('html').getAttribute('class')).toContain('dark')
  await page.locator('[data-atum-settings-back]').click()
  await expect(roster).toBeVisible()
  const dark = await tokenValues()
  expect(dark.bg).toBe('rgb(23, 24, 28)')
  expect(dark.ink).toBe('rgb(236, 237, 240)')
  expect(['rgba(255, 255, 255, 0.055)', 'rgb(30, 32, 37)']).toContain(dark.glass)

  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('atum-shell-v2-dark.png')
  })

  await roster.locator('[data-atum-account-trigger]').click()
  await page.locator('[data-atum-account-menu] [data-atum-nav-settings]').click()
  await page.getByRole('radio', { name: /^(System|Light|Tự động|Sáng)$/u }).first().click()
  await page.locator('[data-atum-settings-back]').click()
  await expect.poll(() => page.locator('html').getAttribute('class')).not.toContain('dark')

  // A turn: the user bubble hugs its content on the right (max 78%), the reply is bare text.
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.fill('How does the browser work with this chat?')
  await composer.press('Enter')

  const response = page.locator('[data-slot="aui_assistant-message-root"]').last()
  await expect(response).toContainText(MOCK_REPLY, { timeout: 60_000 })
  await expect(response).not.toHaveAttribute('data-streaming', 'true', { timeout: 60_000 })

  const userBubble = page.locator('[data-slot="aui_user-bubble-actions"]:visible').last()
  await expect(userBubble).toBeVisible()
  const [bubbleBox, currentChatBox] = await Promise.all([userBubble.boundingBox(), chat.boundingBox()])
  expect(bubbleBox).not.toBeNull()
  expect(currentChatBox).not.toBeNull()
  expect(bubbleBox!.width).toBeLessThan(currentChatBox!.width * 0.85)
  expect(bubbleBox!.x + bubbleBox!.width).toBeGreaterThan(currentChatBox!.x + currentChatBox!.width * 0.7)

  // Collapse the sidebar: the column leaves and the window controls move to
  // the chat's row, which is the same height and starts at the same inset —
  // so the toggle keeps its exact place on screen. Exactly one row hosts the
  // live controls at any moment: a collapsed roster stays mounted, hidden and
  // inert, and nothing inside an inert subtree can be reached.
  const controls = page.locator('[data-atum-window-controls]:not([inert] *)')
  const toggle = controls.locator('[data-atum-sidebar-toggle]')
  const toggleBox = await toggle.boundingBox()
  // Every later comparison polls: the row that takes the toggle over slides
  // in (the sidebar over 260ms, the workspace with an 8px rise), and a box
  // read mid-transition is a box read from the wrong place.
  // The light reservation is macOS-only — false wherever the OS draws no
  // left-hand controls, so this run has none. Assert its count does not
  // change rather than that it exists, which holds on every platform.
  const lightSlots = await controls.locator('[data-atum-traffic-lights]').count()

  await toggle.click()
  await expect(roster).toBeHidden()
  await expect(controls).toHaveCount(1)
  await expect(page.locator('[data-atum-chat] [data-atum-main-header] [data-atum-window-controls]')).toBeVisible()
  await expect.poll(() => toggle.boundingBox(), { timeout: 5_000 }).toEqual(toggleBox)
  expect(await controls.locator('[data-atum-traffic-lights]').count()).toBe(lightSlots)

  await toggle.click()
  await expect(roster).toBeVisible()
  await expect(controls).toHaveCount(1)
  await expect(roster.locator('[data-atum-window-controls]')).toBeVisible()
  await expect.poll(() => toggle.boundingBox(), { timeout: 5_000 }).toEqual(toggleBox)

  // The workspace closes from its own tab bar and reopens from the chat's row.
  await page.getByTestId('atum-workspace-close').click()
  await expect(workspace).toBeHidden()
  await page.locator('[data-atum-main-header] [data-atum-open-workspace]').click()
  await expect(workspace).toBeVisible()

  // Expand (SPEC §1a "phóng to"): the panel leaves the split and takes the
  // frame — the sidebar slides away and the same control is the way back. The
  // panel is the leftmost column now, so its tab bar hosts the window
  // controls: same row height, same inset, same place on screen.
  await page.locator('[data-atum-workspace-expand]').click()
  await expect(workspace).toHaveAttribute('data-atum-full-frame', 'true')
  // The hidden transcript survives, but neither native focus nor tabbing may
  // reach its composer (including the separate DM/group composer).
  await expect(chat).toHaveAttribute('inert', '')
  expect(await chat.evaluate(element => {
    element.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus()

    return element.contains(document.activeElement)
  })).toBe(false)
  await expect(roster).toBeHidden()
  await expect(controls).toHaveCount(1)
  await expect(page.locator('[data-atum-workspace-tabbar] [data-atum-window-controls] [data-atum-sidebar-toggle]')).toBeVisible()
  await expect.poll(() => toggle.boundingBox(), { timeout: 5_000 }).toEqual(toggleBox)

  const [fullFrameBox, shellBox] = await Promise.all([
    workspace.boundingBox(),
    page.locator('[data-atum-shell]').boundingBox()
  ])

  // "Phóng to" is the whole window beside the destination rail: there is no
  // bar for the panel to sit under, because the top row is the panel's own tab
  // bar — the same height as every other column's row, with the window
  // controls leading it.
  expect(Math.round(fullFrameBox!.x)).toBe(railRight)
  expect(Math.round(fullFrameBox!.width)).toBe(Math.round(shellBox!.x + shellBox!.width) - railRight)
  // The panel sheet stops --atum-panel-inset above the window's bottom edge, so its
  // bottom corners round like its top ones (the launch-night glass work).
  const panelInset = await page.locator('[data-atum-shell]').evaluate(element =>
    Number.parseFloat(getComputedStyle(element).getPropertyValue('--atum-panel-inset')) || 0)
  expect(Math.round(fullFrameBox!.height)).toBe(Math.round(shellBox!.height - panelInset))
  expect(Math.round(fullFrameBox!.y)).toBe(Math.round(shellBox!.y))

  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('atum-shell-v2-workspace-full-frame.png')
  })

  await page.locator('[data-atum-workspace-expand]').click()
  await expect(workspace).toHaveAttribute('data-atum-full-frame', 'false')
  await expect(chat).not.toHaveAttribute('inert', '')
  await expect(roster).toBeVisible()
  await expect
    .poll(async () => {
      const [chatBox, workspaceBox] = await Promise.all([chat.boundingBox(), workspace.boundingBox()])

      return chatBox && workspaceBox ? Math.abs(chatBox.width / (chatBox.width + workspaceBox.width) - 0.5) : Number.POSITIVE_INFINITY
    }, { timeout: 15_000 })
    .toBeLessThanOrEqual(0.02)

  await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('atum-shell-v2-chat.png')
  })
})

test('workspace readiness closes a late full-frame panel before it can intercept the composer', async () => {
  allowErrorBanners()
  const page = fixture!.page
  await fixture!.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 700)
  })
  await page.waitForFunction(() => window.innerWidth < 1024)

  // Under 1024 the workspace is full-frame over the chat; its close control
  // returns to the chat, and the chat header offers the way back.
  const workspace = page.locator('[data-atum-workspace]')

  if (await workspace.isVisible()) {
    await page.getByTestId('atum-workspace-close').click()
  }

  await expect(workspace).toBeHidden()
  await expect(page.locator('[data-atum-main-header] [data-atum-open-workspace]')).toBeVisible()
  await page.locator('[data-atum-main-header] [data-atum-open-workspace]').click()
  await expect(workspace).toBeVisible()
  // The compact sidebar must paint above the full-frame workspace, not open
  // invisibly behind it. Check actual browser hit-testing, not DOM presence.
  // The full-frame panel is the leftmost column, so its tab bar has the toggle.
  await page.locator('[data-atum-workspace-tabbar] [data-atum-sidebar-toggle]').click()
  const roster = page.locator('[data-atum-roster]')
  await expect.poll(() => roster.evaluate(element => {
    const box = element.getBoundingClientRect()

    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })).toBe(true)
  await page.keyboard.press('Escape')
  // The closed drawer keeps the roster mounted, hidden and inert.
  await expect(roster).toBeHidden()
  await expect(workspace).toBeVisible()
  await page.getByTestId('atum-workspace-close').click()
  await expect(workspace).toBeHidden()
})
