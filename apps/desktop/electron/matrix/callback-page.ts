/**
 * The pages the browser tab ends on when a sign-in comes back to this Mac (authorization.ts):
 * Atum's own, in the colours of the page the sign-in server shows Atum's apps on the way back
 * (atum-platform `deploy/chat/templates.py`, `atum/continue.html`) and with Atum's mark as the
 * sign-in window draws it (`public/atum-mark.svg` on its dark tile, the same in both themes), so
 * the last thing in the tab is Atum, never a server's plain text. By then the app is already in
 * front (`onCallback`), so these are what the person finds when they look at the browser again.
 *
 * Static and self-contained: no script, no remote asset, nothing from the request in the page
 * (the loopback listener can serve it offline). It speaks the browser's language when Atum does
 * (the request's `Accept-Language` only picks one of five fixed tables); otherwise Vietnamese,
 * then English, as on the sign-in server's page.
 */
import { type DesktopLocale, desktopLocaleFor } from '../../shared/desktop-locale'

export type MatrixCallbackPage = 'signed_in' | 'failed' | 'missing'

const COPY: Record<DesktopLocale, Record<MatrixCallbackPage, { title: string; body: string }>> = {
  vi: {
    signed_in: { title: 'Đã đăng nhập Atum', body: 'Atum đã mở lại — bạn có thể đóng thẻ này.' },
    failed: { title: 'Chưa đăng nhập được', body: 'Quay lại Atum để thử lại.' },
    missing: { title: 'Atum', body: 'Không có gì ở đây. Bạn có thể đóng thẻ này.' }
  },
  en: {
    signed_in: { title: 'Signed in to Atum', body: 'Atum is back in front. You can close this tab.' },
    failed: { title: 'Sign-in didn’t finish', body: 'Go back to Atum to try again.' },
    missing: { title: 'Atum', body: 'Nothing here. You can close this tab.' }
  },
  ja: {
    signed_in: { title: 'Atum にサインインしました', body: 'Atum に戻りました。このタブは閉じてかまいません。' },
    failed: { title: 'サインインが完了しませんでした', body: 'Atum に戻って、もう一度お試しください。' },
    missing: { title: 'Atum', body: 'ここには何もありません。このタブは閉じてかまいません。' }
  },
  zh: {
    signed_in: { title: '已登录 Atum', body: 'Atum 已回到前台，你可以关闭此标签页。' },
    failed: { title: '登录未完成', body: '请回到 Atum 重试。' },
    missing: { title: 'Atum', body: '这里没有内容，你可以关闭此标签页。' }
  },
  'zh-hant': {
    signed_in: { title: '已登入 Atum', body: 'Atum 已回到前景，你可以關閉此分頁。' },
    failed: { title: '登入未完成', body: '請回到 Atum 再試一次。' },
    missing: { title: 'Atum', body: '這裡沒有內容，你可以關閉此分頁。' }
  }
}

/** The page's `lang` attribute (BCP 47) for each table. */
const HTML_LANG: Record<DesktopLocale, string> = { vi: 'vi', en: 'en', ja: 'ja', zh: 'zh-Hans', 'zh-hant': 'zh-Hant' }

/** The browser's first language Atum speaks, from an `Accept-Language` value; nothing otherwise. */
export function matrixCallbackLocale(acceptLanguage: string | undefined): DesktopLocale | undefined {
  const tags = (acceptLanguage ?? '')
    .split(',')
    .slice(0, 16)
    .map(entry => entry.split(';')[0]!.trim())
    .filter(tag => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/u.test(tag))

  return desktopLocaleFor(tags)
}

/** Atum's mark (`public/atum-mark.svg`): the eclipse on its dark tile, as the sign-in window has it. */
const MARK =
  '<svg class="atum-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs>' +
  '<radialGradient id="atum-halo"><stop offset="58%" stop-color="#efeeea" stop-opacity="0"/>' +
  '<stop offset="78%" stop-color="#efeeea" stop-opacity=".28"/><stop offset="100%" stop-color="#efeeea" stop-opacity="0"/>' +
  '</radialGradient></defs><circle cx="32" cy="32" r="32" fill="url(#atum-halo)"/>' +
  '<circle cx="32" cy="32" r="28.5" fill="#efeeea"/><circle cx="29.5" cy="34.5" r="25.5" fill="#141311"/>' +
  '<circle cx="49.5" cy="14.5" r="4.8" fill="#efeeea"/></svg>'

const STYLE =
  ':root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1c1b19;--muted:#5f5c55;--line:rgba(28,27,25,.14)}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#161514;--fg:#ecebe8;--muted:#a8a59e;--line:rgba(236,235,232,.18)}}' +
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);' +
  'font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif}' +
  'main{text-align:center;padding:24px;max-width:360px}' +
  '.atum-mark{display:block;width:56px;height:56px;margin:0 auto 20px;border-radius:14px;background:#141311;' +
  'box-shadow:0 0 0 1px var(--line)}' +
  'h1{font-size:20px;font-weight:600;margin:0 0 4px}p{margin:0;color:var(--muted)}p+p{margin-top:12px;font-size:14px}'

/** The page's HTML. Serve it with `MATRIX_CALLBACK_PAGE_HEADERS`. */
export function matrixCallbackPage(kind: MatrixCallbackPage, acceptLanguage?: string): string {
  const locale = matrixCallbackLocale(acceptLanguage)
  const copy = COPY[locale ?? 'vi'][kind]
  // A browser in a language Atum does not speak gets Vietnamese with English under it.
  const english = locale ? '' : `<p lang="en">${COPY.en[kind].title === 'Atum' ? '' : `${COPY.en[kind].title}. `}${COPY.en[kind].body}</p>`

  return (
    `<!doctype html><html lang="${HTML_LANG[locale ?? 'vi']}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">' +
    `<title>Atum</title><style>${STYLE}</style></head>` +
    `<body data-atum-callback="${kind}"><main>${MARK}<h1>${copy.title}</h1><p>${copy.body}</p>` +
    `${english}</main></body></html>`
  )
}

/** Nothing on these pages may load or run anything. */
export const MATRIX_CALLBACK_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff'
} as const
