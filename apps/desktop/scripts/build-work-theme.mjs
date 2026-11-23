#!/usr/bin/env node
// Builds Work's T3 environment theme (`electron/work/sidecar/atum.json`) from the Atum Kit, so Work
// follows the Kit instead of a hand-copied palette (design spec 2026-11-23 §1.3, §9.4).
//
//   node scripts/build-work-theme.mjs          write the theme
//   node scripts/build-work-theme.mjs --check  fail when the committed theme is stale
//
// Colors: T3's theme roles, each from one Kit token per appearance (translucent tokens are laid over
// the surface they sit on, since T3 palettes are opaque). CSS: the Kit's generated stylesheet (tokens
// and `.ak-*` components, light on :root, dark on T3's `.dark` root) plus `work-theme/atum-work.css`,
// which maps T3's stable `data-` hooks onto Atum's panels.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktop = new URL('../', import.meta.url)
const kit = new URL('../../packages/atum-kit/', desktop)
const output = fileURLToPath(new URL('electron/work/sidecar/atum.json', desktop))
const tokens = JSON.parse(readFileSync(new URL('tokens.json', kit), 'utf8')).theme
const kitCss = readFileSync(new URL('dist/atum-kit.css', kit), 'utf8')
const workCss = readFileSync(new URL('scripts/work-theme/atum-work.css', desktop), 'utf8')

// T3 caps a theme's CSS (THEME_CSS_MAX_LENGTH in its contracts).
const CSS_LIMIT = 100_000

function parse(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)

  if (hex) {
    const value = Number.parseInt(hex[1], 16)

    return { r: value >> 16, g: (value >> 8) & 255, b: value & 255, a: 1 }
  }

  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/i.exec(color)

  if (!rgba) {
    throw new Error(`build-work-theme: unsupported Kit color ${color}`)
  }

  return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) }
}

function hex({ r, g, b }) {
  return `#${[r, g, b].map(part => Math.round(part).toString(16).padStart(2, '0')).join('')}`
}

/** An opaque color: `color` laid over `base`. */
function over(color, base) {
  const top = parse(color)
  const under = parse(base)

  return hex({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a)
  })
}

export function workThemeColors(appearance) {
  const t = name => {
    const token = tokens[name]

    if (!token?.[appearance]) {
      throw new Error(`build-work-theme: Kit token ${name} has no ${appearance} value`)
    }

    return token[appearance]
  }

  const surface = t('surface')
  const frame = t('chrome')
  // The roster panel: the Kit's translucent panel over the frame, as the desktop's roster.
  const roster = over(t('panel'), frame)
  const on = (name, base = surface) => over(t(name), base)

  return {
    canvas: surface,
    chrome: frame,
    toolbar: surface,
    toolbarForeground: t('ink'),
    toolbarBorder: on('line'),
    toolbarControl: surface,
    toolbarControlForeground: t('ink-2'),
    toolbarControlHover: on('fill-hover'),
    surface,
    surfaceRaised: t('raised'),
    surfaceOverlay: t('raised'),
    text: t('ink'),
    textMuted: t('ink-3'),
    border: on('line'),
    input: on('line-2'),
    focus: on('focus'),
    // Ink carries everything: the accent is ink, never a brand blue.
    accent: t('ink'),
    accentForeground: t('on-ink'),
    secondary: on('fill-quiet'),
    secondaryForeground: t('ink'),
    muted: on('fill-quiet'),
    mutedForeground: t('ink-3'),
    placeholder: t('ink-3'),
    secondaryLabel: t('ink-3'),
    iconMuted: t('ink-4'),
    error: t('danger'),
    errorForeground: t('danger'),
    errorSurface: on('danger-fill'),
    warning: t('warn'),
    warningForeground: t('warn'),
    warningSurface: on('warn-fill'),
    update: t('ink'),
    updateForeground: t('ink'),
    updateSurface: on('fill-quiet'),
    accentSurface: on('fill-selected'),
    accentSurfaceForeground: t('ink'),
    messageSurface: on('fill-quiet'),
    messageForeground: t('ink'),
    messageAction: t('ink'),
    messageActionForeground: t('on-ink'),
    messageActionHover: t('ink-hover'),
    codeBackground: t('sunk'),
    codeForeground: t('ink'),
    searchMatchBackground: on('warn-fill'),
    searchMatchForeground: t('ink'),
    searchMatchActiveBackground: t('warn'),
    searchMatchActiveForeground: t('on-ink'),
    sidebar: roster,
    sidebarForeground: t('ink'),
    sidebarMutedForeground: t('ink-3'),
    sidebarControlSurface: on('fill-quiet', roster),
    sidebarRowHover: on('fill-hover', roster),
    sidebarRowActive: on('fill-selected', roster),
    sidebarRowSelected: on('fill-selected', roster),
    sidebarBorder: on('line', roster),
    terminalBackground: surface,
    terminalForeground: t('ink'),
    terminalCursor: t('ink'),
    terminalSelection: on('fill-press'),
    terminalScrollbar: on('line-2'),
    terminalScrollbarHover: t('ink-4')
  }
}

export function buildWorkTheme() {
  // T3 drops `@import` and any `url()` but a data: address or an #id from theme CSS.
  const css = `${kitCss.trim()}\n\n${workCss.trim()}\n`

  if (css.length > CSS_LIMIT) {
    throw new Error(`build-work-theme: theme CSS is ${css.length} characters; T3 accepts ${CSS_LIMIT}`)
  }

  if (/@import|url\(\s*(?!["']?(?:data:|#))/i.test(css)) {
    throw new Error('build-work-theme: theme CSS must not load files')
  }

  return {
    version: 1,
    name: 'Atum',
    appearance: 'light',
    colors: workThemeColors('light'),
    variants: { dark: workThemeColors('dark') },
    css
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = `${JSON.stringify(buildWorkTheme(), null, 2)}\n`

  if (process.argv.includes('--check')) {
    if (readFileSync(output, 'utf8') !== next) {
      console.error('electron/work/sidecar/atum.json is stale: run node scripts/build-work-theme.mjs')
      process.exit(1)
    }
  } else {
    writeFileSync(output, next)
  }
}
