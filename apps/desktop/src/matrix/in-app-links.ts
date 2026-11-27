/**
 * Links clicked inside Atum open in Atum's own browser (owner 2026-11-27: "shouldn't we always default to the in-app browser for
 * any and all links clicked inside the app?"). The in-app browser is the workbench's consumer-browser tab (workbench.tsx,
 * electron/consumer-browser/controller.ts); the signed-in window registers it as the host. Before sign-in, or with no host,
 * a link goes to the system browser through main's audited `openLink`, as before.
 *
 * Stays in the system browser:
 * - `mailto:` and any non-web scheme (main hands them to the mail app);
 * - sign-in pages of identity providers (`isProviderSignInUrl`): Google refuses OAuth in embedded browsers
 *   (`disallowed_useragent`), and the ChatGPT / Claude CLI sign-ins finish on a loopback callback (127.0.0.1) that the in-app
 *   browser deliberately refuses (shared/browser/policy.ts blocks local and private addresses). Passkeys and saved
 *   passwords also live in the person's own browser.
 */

export type InAppBrowserHost = (url: string) => void

let host: InAppBrowserHost | null = null

/** The signed-in window's in-app browser. Returns the unregister. */
export function registerInAppBrowser(next: InAppBrowserHost): () => void {
  host = next

  return () => {
    if (host === next) {
      host = null
    }
  }
}

const SIGN_IN_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'auth.openai.com',
  'auth0.openai.com'
])

const SIGN_IN_PATHS: readonly { host: RegExp; path: RegExp }[] = [
  { host: /^(www\.)?claude\.(ai|com)$/u, path: /^\/(oauth|login|cai\/oauth)/u },
  { host: /^(console|platform)\.(anthropic|claude)\.com$/u, path: /^\/(oauth|login)/u },
  { host: /^(www\.)?chatgpt\.com$/u, path: /^\/(auth|login)/u },
  { host: /^github\.com$/u, path: /^\/login/u },
  { host: /^antigravity\.google$/u, path: /^\/(auth|login|oauth)/u }
]

/** An identity provider's sign-in page: always the system browser (see the module note). */
export function isProviderSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    return SIGN_IN_HOSTS.has(hostname) || SIGN_IN_PATHS.some(rule => rule.host.test(hostname) && rule.path.test(parsed.pathname))
  } catch {
    return false
  }
}

/** Where a clicked link goes: `in_app` for an ordinary web page while a host is registered, else `system`. */
export function inAppLinkTarget(url: string, hasHost = host !== null): 'in_app' | 'system' {
  try {
    const parsed = new URL(url)

    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || isProviderSignInUrl(url)) {
      return 'system'
    }
  } catch {
    return 'system'
  }

  return hasHost ? 'in_app' : 'system'
}

/** Open a clicked link: Atum's browser for web pages, the system for the rest. */
export async function openClickedLink(
  url: string,
  openSystem: (url: string) => Promise<unknown> = value => window.atumMatrix.openLink(value)
): Promise<void> {
  if (inAppLinkTarget(url) === 'in_app' && host) {
    host(url)

    return
  }

  await openSystem(url)
}
