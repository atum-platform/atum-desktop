const GOOGLE_OAUTH_ORIGIN = 'https://accounts.google.com'
const ICON_DATA = /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/=]+$/u

export type AppAuthNavigation = 'allow' | 'google_system_browser' | 'refuse'

function localHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  )
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value)

    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return null
    }

    if (url.protocol === 'https:') {
      return url.origin
    }

    if (localHttp(url)) {
      return url.origin
    }

    return null
  } catch {
    return null
  }
}

/** Exact main-frame origins: the authenticated connect start plus the app's
 * signed manifest origin(s). Paths and query data never widen this set. */
export function appAuthApprovedOrigins(authorizeUrl: string, origins: readonly string[]): ReadonlySet<string> {
  let authorize: URL

  try {
    authorize = new URL(authorizeUrl)
  } catch {
    throw new Error('app_auth_authorize_invalid')
  }

  const start = safeOrigin(authorize.origin)

  if (!start || authorize.username || authorize.password || (authorize.protocol !== 'https:' && !localHttp(authorize))) {
    throw new Error('app_auth_authorize_invalid')
  }

  const approved = new Set<string>([start])

  for (const candidate of origins) {
    const origin = safeOrigin(candidate)

    if (!origin) {
      throw new Error('app_auth_origin_invalid')
    }

    approved.add(origin)
  }

  return approved
}

export function appAuthNavigation(rawUrl: string, approved: ReadonlySet<string>): AppAuthNavigation {
  try {
    const url = new URL(rawUrl)

    if (url.username || url.password || (url.protocol !== 'https:' && !localHttp(url))) {
      return 'refuse'
    }

    if (url.origin === GOOGLE_OAUTH_ORIGIN) {
      return 'google_system_browser'
    }

    return approved.has(url.origin) ? 'allow' : 'refuse'
  } catch {
    return 'refuse'
  }
}

export function safeAppAuthIcon(value: string | null): string | null {
  return value && value.length <= 512_000 && ICON_DATA.test(value) ? value : null
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function appAuthSheetHtml(input: {
  appName: string
  closeLabel: string
  googleHint: string
  iconDataUrl: string | null
  title: string
}): string {
  const icon = safeAppAuthIcon(input.iconDataUrl)
  const fallback = Array.from(input.appName.trim())[0]?.toLocaleUpperCase() ?? 'A'

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>${escapeHtml(input.title)}</title>
    <style>
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; overflow: hidden; }
      body { background: Canvas; color: CanvasText; font: 13px system-ui, -apple-system, sans-serif; }
      header { -webkit-app-region: drag; align-items: center; display: flex; gap: 12px; height: 72px; padding: 14px 16px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
      .avatar { align-items: center; background: ButtonFace; border-radius: 12px; display: flex; flex: 0 0 44px; height: 44px; justify-content: center; overflow: hidden; font-size: 18px; font-weight: 650; }
      .avatar img { display: block; height: 100%; object-fit: cover; width: 100%; }
      .words { min-width: 0; }
      h1 { font-size: 15px; line-height: 1.3; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      p { color: GrayText; font-size: 11px; line-height: 1.35; margin: 3px 0 0; }
      a { -webkit-app-region: no-drag; align-items: center; border-radius: 9px; color: CanvasText; display: flex; font-size: 22px; height: 32px; justify-content: center; margin-left: auto; text-decoration: none; width: 32px; }
      a:hover, a:focus-visible { background: color-mix(in srgb, CanvasText 8%, transparent); outline: none; }
    </style>
  </head>
  <body>
    <header aria-label="${escapeHtml(input.title)}">
      <div class="avatar">${icon ? `<img alt="" src="${icon}">` : escapeHtml(fallback)}</div>
      <div class="words"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.googleHint)}</p></div>
      <a aria-label="${escapeHtml(input.closeLabel)}" href="atum-app-auth://close">×</a>
    </header>
  </body>
</html>`
}
