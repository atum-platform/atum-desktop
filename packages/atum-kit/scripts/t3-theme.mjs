// Atum's palette as one T3 theme file (owner 2026-11-24, option B). The roles are T3's (the vendored
// t3/upstream/apps/web/src/themePalette.ts); each role's value is one Kit token per appearance, so the
// Kit's approved colours stay the only colour decision. Two readers share the result:
//   - dist/atum-t3-theme.json, the T3 theme file: Work installs it as its environment theme
//     (apps/desktop/scripts/build-work-theme.mjs) and it is what `t3 theme set` accepts;
//   - dist/atum-kit.css, which declares T3's --app-theme-* variables and T3's control radius and glass
//     values from the same object, so desktop surfaces built on T3 recipes read T3's own names.
import { readUpstream } from './sync-t3-design.mjs'

const without$ = object => Object.fromEntries(Object.entries(object).filter(([key]) => !key.startsWith('$')))

function parse(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)

  if (hex) {
    const value = Number.parseInt(hex[1], 16)

    return { r: value >> 16, g: (value >> 8) & 255, b: value & 255, a: 1 }
  }

  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/i.exec(color)

  if (!rgba) {
    throw new Error(`t3-theme: unsupported Kit color ${color}`)
  }

  return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) }
}

const hex = ({ r, g, b }) => `#${[r, g, b].map(part => Math.round(part).toString(16).padStart(2, '0')).join('')}`

/** An opaque colour: `color` laid over `base` (T3 palettes are opaque; some Kit tokens are not). */
export function over(color, base) {
  const top = parse(color)
  const under = parse(base)

  return hex({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a)
  })
}

/** Every T3 colour role for one appearance, from the Kit's tokens. */
export function t3ThemeColors(tokens, appearance) {
  const theme = without$(tokens.theme)

  const t = name => {
    const value = theme[name]?.[appearance]

    if (!value) {
      throw new Error(`t3-theme: Kit token ${name} has no ${appearance} value`)
    }

    return value
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

/** Atum's palette in T3's theme-file format (`t3 theme set` / Work's environment theme). Colours only. */
export function t3Theme(tokens) {
  return {
    version: 1,
    name: 'Atum',
    appearance: 'light',
    colors: t3ThemeColors(tokens, 'light'),
    variants: { dark: t3ThemeColors(tokens, 'dark') }
  }
}

/** T3's role → CSS variable table (APP_THEME_VARIABLES), read from the vendored themePalette.ts. */
export async function t3RoleVariables() {
  const source = await readUpstream('apps/web/src/themePalette.ts')
  const start = source.indexOf('const APP_THEME_VARIABLES')
  const body = source.slice(source.indexOf('{', source.indexOf('=', start)) + 1, source.indexOf('};', start))
  const table = Object.fromEntries(
    [...body.matchAll(/^\s*(\w+):\s*"(--[\w-]+)",?$/gm)].map(([, role, name]) => [role, name])
  )

  if (Object.keys(table).length < 40) {
    throw new Error('t3-theme: could not read APP_THEME_VARIABLES from the vendored themePalette.ts')
  }

  return table
}

/** T3's geometry and glass variables the Kit adopts, with T3's values (index.css :root, and its dark variant). */
export const T3_GEOMETRY = ['control-radius', 'glass-blur', 'glass-opacity', 'glass-saturation']

export async function t3Geometry() {
  const css = await readUpstream('apps/web/src/index.css')
  const start = css.indexOf('\n:root {')
  const end = css.indexOf('\n}\n', start)
  const root = css.slice(start, end)
  const darkAt = root.indexOf('@variant dark {')
  const base = darkAt < 0 ? root : root.slice(0, darkAt)
  const dark = darkAt < 0 ? '' : root.slice(darkAt, root.indexOf('}', darkAt))
  const read = text =>
    Object.fromEntries(
      [...text.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()])
    )
  const pick = values =>
    Object.fromEntries(T3_GEOMETRY.filter(name => name in values).map(name => [name, values[name]]))
  const light = pick(read(base))

  for (const name of T3_GEOMETRY) {
    if (!(name in light)) {
      throw new Error(`t3-theme: --${name} is missing from the vendored index.css :root`)
    }
  }

  return { light, dark: pick(read(dark)) }
}

/** The T3 layer of dist/atum-kit.css: T3's colour roles (Atum's palette) and T3's geometry. */
export async function t3Css(tokens, { light: lightSelector, dark: darkSelector }) {
  const [roles, geometry] = await Promise.all([t3RoleVariables(), t3Geometry()])
  const theme = t3Theme(tokens)
  const block = (selector, colors, extra) => {
    const lines = [
      ...Object.entries(colors).map(([role, value]) => {
        if (!roles[role]) {
          throw new Error(`t3-theme: T3 has no variable for role ${role}`)
        }

        return `  ${roles[role]}: ${value};`
      }),
      ...Object.entries(extra).map(([name, value]) => `  --${name}: ${value};`)
    ]

    return `${selector} {\n${lines.join('\n')}\n}\n`
  }

  return [
    `/* ---------- T3 base (pingdotgg/t3code, MIT; vendored in t3/, see t3/THIRD-PARTY.md) ----------\n * T3's colour roles as T3's own --app-theme-* variables, set to Atum's palette (dist/atum-t3-theme.json),\n * and T3's control radius and glass. Generated; recipes adopted from T3 read these names. */\n`,
    block(lightSelector, theme.colors, geometry.light),
    block(darkSelector, theme.variants.dark, geometry.dark)
  ].join('')
}
