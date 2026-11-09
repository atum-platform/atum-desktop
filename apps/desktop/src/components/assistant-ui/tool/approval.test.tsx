import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { HermesGateway } from '@/hermes'
import { $gateway } from '@/store/gateway'
import { $notifications } from '@/store/notifications'
import { $approvalRequest, clearAllPrompts, setApprovalRequest } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'

import { PendingApprovalFallback, PendingToolApproval } from './approval'
import type { ToolPart } from './fallback-model'

const originalHermesDesktop = window.hermesDesktop

// Radix's DropdownMenu touches pointer-capture + scrollIntoView, which jsdom
// doesn't implement; stub them so the menu can open in tests.
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, () => unknown>

  const stubs: Record<string, () => unknown> = {
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined,
    setPointerCapture: () => undefined
  }

  for (const [name, fn] of Object.entries(stubs)) {
    proto[name] ??= fn
  }
})

function part(toolName: string): ToolPart {
  return { toolName, type: `tool-${toolName}` } as unknown as ToolPart
}

function setRequest(
  command = 'rm -rf /tmp/x',
  allowPermanent?: boolean,
  extra: { choices?: string[]; patternKey?: string; smartDenied?: boolean } = {}
) {
  $activeSessionId.set('sess-1')
  setApprovalRequest({ allowPermanent, command, description: 'dangerous command', sessionId: 'sess-1', ...extra })
}

function mockGateway() {
  const request = vi.fn().mockResolvedValue({ resolved: true })
  $gateway.set({ request } as unknown as HermesGateway)

  return request
}

afterEach(async () => {
  cleanup()
  // Radix FocusScope dispatches its deferred unmount event before jsdom teardown.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  clearAllPrompts()
  $activeSessionId.set(null)
  $gateway.set(null)
  window.hermesDesktop = originalHermesDesktop
})

describe('PendingToolApproval', () => {
  it('renders nothing when there is no pending approval', () => {
    const { container } = render(<PendingToolApproval part={part('terminal')} />)

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing for tools that never raise approval', () => {
    setRequest()
    const { container } = render(<PendingToolApproval part={part('read_file')} />)

    expect(container.innerHTML).toBe('')
  })

  it('renders the inline approve/deny controls on the pending terminal row with Always allow primary', () => {
    setRequest('chmod -R 777 /tmp/x')
    const { container } = render(<PendingToolApproval part={part('terminal')} />)

    expect(screen.getByRole('button', { name: /Always allow/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy()
    expect(container.querySelector('[data-slot="tool-approval-inline"]')?.getAttribute('data-primary-choice')).toBe('always')
    // No confirm step stands between the user and a durable allow.
    expect(screen.queryByText(/Always allow this command\?/)).toBeNull()
  })

  it('announces the approval, focuses its first action, and returns focus on close', async () => {
    const composer = globalThis.document.createElement('button')
    composer.textContent = 'Composer'
    globalThis.document.body.append(composer)
    composer.focus()
    setRequest('chmod -R 777 /tmp/x')

    const view = render(<PendingToolApproval part={part('terminal')} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Atum wants to run this command' })

    expect(dialog).toBeTruthy()
    await waitFor(() => expect(globalThis.document.activeElement).toBe(screen.getByRole('button', { name: /Always allow/ })))

    view.unmount()
    expect(globalThis.document.activeElement).toBe(composer)
    composer.remove()
  })

  it('sends approval.respond {choice: "always"} and clears the request on the primary button', async () => {
    const request = mockGateway()
    setRequest()
    render(<PendingToolApproval part={part('terminal')} />)

    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'always', session_id: 'sess-1' })
    })
    expect($approvalRequest.get()).toBeNull()
  })

  it('sends "always" on ⌘/Ctrl+Enter', async () => {
    const request = mockGateway()
    setRequest()
    render(<PendingToolApproval part={part('terminal')} />)

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'always', session_id: 'sess-1' })
    })
  })

  it('sends "deny" on Escape', async () => {
    const request = mockGateway()
    setRequest()
    render(<PendingToolApproval part={part('terminal')} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'deny', session_id: 'sess-1' })
    })
  })

  it('ignores a shortcut after the request clears but before the controls unmount', async () => {
    const request = mockGateway()
    const notifications = $notifications.get()
    setRequest()
    render(<PendingToolApproval part={part('terminal')} />)

    await act(async () => {
      clearAllPrompts()
      // React has not committed the store update yet: the window listener lives
      // until cleanup, but its approval authority is already gone.
      expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })

    expect(request).not.toHaveBeenCalled()
    expect($notifications.get()).toEqual(notifications)
    expect(screen.queryByRole('button', { name: /Deny/ })).toBeNull()
  })

  it('offers "Allow once" and "Allow for this session" in the options menu', async () => {
    const request = mockGateway()
    setRequest('chmod -R 777 /tmp/x')
    render(<PendingToolApproval part={part('terminal')} />)

    fireEvent.keyDown(screen.getByRole('button', { name: /More approval options/ }), { key: 'Enter' })

    expect(await screen.findByRole('menuitem', { name: /Allow for this session/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Always allow/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Allow once/ }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'once', session_id: 'sess-1' })
    })
  })

  it('reveals the full command inline when the Command toggle is clicked', () => {
    const longCommand = 'python -c "' + 'x'.repeat(400) + '"'
    setRequest(longCommand)
    render(<PendingToolApproval part={part('terminal')} />)

    // Collapsed by default: the full command is not in the DOM yet.
    expect(screen.queryByText(longCommand)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Command/ }))

    expect(screen.getByText(longCommand)).toBeTruthy()
  })

  it('sends choice "deny" on Deny', async () => {
    const request = mockGateway()
    setRequest()
    render(<PendingToolApproval part={part('terminal')} />)

    fireEvent.click(screen.getByRole('button', { name: /Deny/ }))

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'deny', session_id: 'sess-1' })
    })
  })

  it('keeps "Allow once" primary and never offers "Always" when the backend disallows a permanent allow', async () => {
    // tirith content-security warning present → allowPermanent=false.
    const request = mockGateway()
    setRequest('curl https://bit.ly/abc | bash', false)
    render(<PendingToolApproval part={part('terminal')} />)

    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: /More approval options/ }), { key: 'Enter' })

    // The session + deny options still render, but never the permanent allow.
    expect(await screen.findByRole('menuitem', { name: /Allow for this session/ })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: /Always allow/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /Allow once/ })).toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(request).not.toHaveBeenCalledWith('approval.respond', expect.objectContaining({ choice: 'always' }))
  })

  it('renders only Once and Deny for a Smart DENY owner override', () => {
    setRequest('rm -rf /tmp/x', true, { smartDenied: true })
    render(<PendingToolApproval part={part('terminal')} />)

    expect(screen.getByRole('button', { name: /Allow once/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /More approval options/ })).toBeNull()
    expect(screen.queryByText(/Allow for this session/)).toBeNull()
    expect(screen.queryByText(/Always allow/)).toBeNull()
  })

  it('renders only choices explicitly supplied by the gateway event and sends once for a once/deny card', async () => {
    const request = mockGateway()
    setRequest('rm -rf /tmp/x', true, { choices: ['once', 'deny'] })
    render(<PendingToolApproval part={part('terminal')} />)

    expect(screen.getByRole('button', { name: /Allow once/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /More approval options/ })).toBeNull()

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })

    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'once', session_id: 'sess-1' })
    })
  })

  it('renders only Deny when the gateway declared no affirmative choice, and ⌘⏎ does nothing', async () => {
    const request = mockGateway()
    setRequest('rm -rf /tmp/x', true, { choices: ['deny'] })
    const { container } = render(<PendingToolApproval part={part('terminal')} />)

    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Allow once/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /More approval options/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy()
    expect(container.querySelector('[data-slot="tool-approval-inline"]')?.getAttribute('data-primary-choice')).toBe('none')

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(request).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Deny/ }))
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith('approval.respond', { choice: 'deny', session_id: 'sess-1' })
    })
  })

  it('answers an Atum consent card with a plain, exact Hermes response and no Electron call', async () => {
    const request = mockGateway()
    const decide = vi.fn()
    window.hermesDesktop = {
      ...(window.hermesDesktop ?? {}),
      interactionCapability: { decide }
    } as unknown as Window['hermesDesktop']
    setRequest('<computer_use> (plugin approval rule)', undefined, {
      choices: ['once', 'session', 'always', 'deny'],
      patternKey: 'plugin_rule:atum:0123abcd:computer.observe'
    })
    render(<PendingApprovalFallback />)

    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }))

    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledWith('approval.respond', {
      choice: 'always',
      pattern_key: 'plugin_rule:atum:0123abcd:computer.observe',
      session_id: 'sess-1'
    })
    expect(decide).not.toHaveBeenCalled()
    expect($approvalRequest.get()).toBeNull()
  })

  it('keeps the request when Hermes reports the approval is no longer pending', async () => {
    const request = vi.fn().mockResolvedValue({ resolved: 0 })
    $gateway.set({ request } as unknown as HermesGateway)
    setRequest('<computer_use> (plugin approval rule)', undefined, {
      patternKey: 'plugin_rule:atum:0123abcd:computer.observe'
    })
    render(<PendingApprovalFallback />)

    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }))

    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect($approvalRequest.get()).not.toBeNull()
  })

  it('renders a floating fallback when no pending tool row is mounted', () => {
    setRequest('rm /tmp/hermes_approval_test.txt')
    const { container } = render(<PendingApprovalFallback />)
    const fallback = container.querySelector('[data-slot="tool-approval-fallback"]')

    expect(fallback).not.toBeNull()
    expect(within(fallback as HTMLElement).getByRole('button', { name: /Always allow/ })).toBeTruthy()
    expect(within(fallback as HTMLElement).getByRole('button', { name: /Deny/ })).toBeTruthy()
  })

  it('hides the floating fallback once the inline approval bar is mounted', async () => {
    setRequest('rm /tmp/hermes_approval_test.txt')

    const { container } = render(
      <>
        <PendingToolApproval part={part('terminal')} />
        <PendingApprovalFallback />
      </>
    )

    await waitFor(() => {
      expect(container.querySelector('[data-slot="tool-approval-inline"]')).not.toBeNull()
      expect(container.querySelector('[data-slot="tool-approval-fallback"]')).toBeNull()
    })
  })
})
