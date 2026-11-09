/** Electron invoke preserves main-process errors inside this wrapper. */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return raw.match(/Error invoking remote method '[^']+': Error: (.+)$/)?.[1] ?? raw
}
