import path from 'node:path'

import { load } from 'js-yaml'

/** The owner-imported optional MCP entry used to persist a versioned bundled interpreter.
 * Only a missing absolute Python command is migrated; SSH, wrappers and custom live interpreters stay intact.
 */
export function restoredAuxPython(config: string, python: string, exists: (file: string) => boolean): string | null {
  try {
    const value = load(config) as { mcp_servers?: { 'atum-aux'?: { command?: unknown } } } | undefined
    const command = value?.mcp_servers?.['atum-aux']?.command
    return typeof command === 'string' && path.isAbsolute(command) &&
      /^python(?:3(?:\.\d+)?)?$/u.test(path.basename(command)) && !exists(command) ? python : null
  } catch { return null }
}
