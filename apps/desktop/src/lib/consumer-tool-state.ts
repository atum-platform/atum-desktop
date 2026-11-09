export const CONSUMER_BROWSER_TOOL_NAMES = [
  'browser_back',
  'browser_cdp',
  'browser_click',
  'browser_console',
  'browser_dialog',
  'browser_get_images',
  'browser_navigate',
  'browser_press',
  'browser_scroll',
  'browser_snapshot',
  'browser_type',
  'browser_vision'
] as const

const CONSUMER_WEB_TOOL_NAMES = new Set<string>([...CONSUMER_BROWSER_TOOL_NAMES, 'web_extract', 'web_search'])
const CONSUMER_INTERACTION_TOOL_NAMES = new Set<string>([...CONSUMER_WEB_TOOL_NAMES, 'computer_use'])

export const CONSUMER_WEB_TOOL_CANCELLED_CODE = 'USER_CANCELLED'

export type ConsumerToolAuthorityCode = 'CAPABILITY_DENIED' | 'CAPABILITY_REVOKED'

export function isConsumerWebTool(toolName: string): boolean {
  return CONSUMER_WEB_TOOL_NAMES.has(toolName)
}

/** Tools whose running and cancellation states need a user-facing interaction outcome. */
export function isConsumerInteractionTool(toolName: string): boolean {
  return CONSUMER_INTERACTION_TOOL_NAMES.has(toolName)
}

export function isConsumerComputerTool(toolName: string): boolean {
  return toolName === 'computer_use'
}

export function isCancelledToolResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false
  }

  const record = result as Record<string, unknown>

  return (
    typeof record.status === 'string' &&
    record.status.toLowerCase() === 'cancelled' &&
    typeof record.code === 'string' &&
    record.code.toUpperCase() === CONSUMER_WEB_TOOL_CANCELLED_CODE
  )
}

export function consumerToolAuthorityCode(result: unknown): ConsumerToolAuthorityCode | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null
  }

  const error = (result as Record<string, unknown>).error

  if (typeof error !== 'string') {
    return null
  }

  if (error === 'CAPABILITY_REVOKED' || error.startsWith('CAPABILITY_REVOKED:')) {
    return 'CAPABILITY_REVOKED'
  }

  return error === 'CAPABILITY_DENIED' || error.startsWith('CAPABILITY_DENIED:') ? 'CAPABILITY_DENIED' : null
}
