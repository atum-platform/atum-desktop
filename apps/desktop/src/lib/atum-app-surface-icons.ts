import { phosphorIcon } from '@/lib/phosphor-icon'

import names from '../../../../packages/atum-kit/icons.json'

/** Legacy manifest aliases. Curated Phosphor names always pass through unchanged. */
export const APP_SURFACE_ALIASES: Record<string, string> = {
  app: 'app-window',
  book: 'book',
  calendar: 'calendar-blank',
  camera: 'image',
  chat: 'chat-circle',
  checklist: 'list-checks',
  file: 'file-text',
  folder: 'folder-simple',
  home: 'house',
  library: 'folder-simple',
  profile: 'user',
  search: 'magnifying-glass',
  settings: 'gear',
  shop: 'package',
  sparkles: 'sparkle',
  starmap: 'graph',
  tool: 'wrench',
  wallet: 'credit-card',
  message: 'chat-circle',
  'book-2': 'book-open-text',
  hearts: 'heart',
  'clock-search': 'clock',
  coin: 'coins',
  report: 'chart-line-up'
}
const curated = new Set(names.names)

export function appSurfaceGlyph(value: string): string {
  const name = value.toLowerCase()

  return curated.has(name) ? name : (APP_SURFACE_ALIASES[name] ?? 'app-window')
}

/** Data-declared app glyphs use the same Kit paths as every named desktop icon. */
const glyphs = new Map(
  names.names.map(name => [name, phosphorIcon(name as Parameters<typeof phosphorIcon>[0])])
)

export function appSurfaceIcon(value: string) {
  return glyphs.get(appSurfaceGlyph(value))!
}
