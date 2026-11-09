import { MAIN_STRINGS, type MainLocale } from './main-i18n'

export type AtumOAuthCompletionKind =
  | 'native-sign-in'
  | 'connection-approved'
  | 'connection-denied'
  | 'invalid-response'

/**
 * A self-contained browser landing page for Atum-owned loopback OAuth flows.
 * It intentionally has no external assets or dynamic copy: the local listener
 * can render it offline, and provider values can never enter the document.
 */
export function atumOAuthCompletionHtml(kind: AtumOAuthCompletionKind, locale: MainLocale = 'en'): string {
  const copy = MAIN_STRINGS[locale].desktopOAuth[kind]
  const autoClose = kind === 'native-sign-in'
  const closeScript = autoClose ? '<script>setTimeout(function(){window.close()},800)</script>' : ''
  const scriptPolicy = autoClose ? "; script-src 'unsafe-inline'" : ''

  return `<!doctype html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${scriptPolicy}">
  <title>${copy.title} · Atum</title>
  <style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;color:#1b1d22;background:radial-gradient(1200px 760px at 18% -10%,#fbfbfc 0%,#f4f5f7 50%,#eef0f3 100%)}
    main{width:min(390px,100%);padding:28px;border:1px solid rgba(23,25,31,.12);border-radius:20px;background:rgba(255,255,255,.82);box-shadow:0 40px 90px -30px rgba(23,25,31,.45)}
    .brand{display:flex;align-items:center;gap:12px;font-size:19px;font-weight:650;letter-spacing:-.025em}
    .mark{display:grid;width:44px;height:44px;place-items:center;overflow:hidden;border-radius:13px;background:#1b1d22;box-shadow:0 1px 3px rgba(23,25,31,.28)}
    .mark svg{width:32px;height:32px}
    .eyebrow{margin:40px 0 0;color:#5f646d;font-size:11px;font-weight:650;letter-spacing:.12em;text-transform:uppercase}
    h1{margin:8px 0 0;font-size:26px;line-height:1.15;letter-spacing:-.035em}
    p:last-of-type{margin:12px 0 0;color:#5f646d;font-size:14px;line-height:1.7}
    @media(prefers-color-scheme:dark){body{color:#ecedf0;background:radial-gradient(1200px 760px at 18% -10%,#1e2025 0%,#17181c 50%,#121316 100%)}main{border-color:rgba(255,255,255,.14);background:rgba(30,32,37,.94);box-shadow:0 40px 90px -30px rgba(0,0,0,.7)}.eyebrow,p:last-of-type{color:#9da2ab}}
  </style>
</head>
<body>
  <main aria-labelledby="atum-oauth-title">
    <div class="brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false"><defs><radialGradient id="atum-halo"><stop offset="58%" stop-color="#efeeea" stop-opacity="0"/><stop offset="78%" stop-color="#efeeea" stop-opacity=".28"/><stop offset="100%" stop-color="#efeeea" stop-opacity="0"/></radialGradient></defs><circle cx="32" cy="32" r="32" fill="url(#atum-halo)"/><circle cx="32" cy="32" r="28.5" fill="#efeeea"/><circle cx="29.5" cy="34.5" r="25.5" fill="#141311"/><circle cx="49.5" cy="14.5" r="4.8" fill="#efeeea"/></svg></span><span>Atum</span></div>
    <p class="eyebrow">${MAIN_STRINGS[locale].desktopOAuth.eyebrow}</p>
    <h1 id="atum-oauth-title">${copy.title}</h1>
    <p>${copy.body}</p>
  </main>
  ${closeScript}
</body>
</html>`
}
