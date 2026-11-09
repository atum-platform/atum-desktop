/**
 * The sites a browser import leaves behind by default: banking, wallets and password managers.
 *
 * One module, one policy. A site here is a Public Suffix List registrable domain (eTLD+1, what the contract's
 * `siteSelections` hold), so `secure.chase.com` and `chase.com` are the same entry. Nothing imported from a skipped
 * site ever reaches an agent: its cookies stay on this Mac and its row is `skipped_default` in the selection.
 *
 * This is a conservative default, not a complete census. Two layers, both over-inclusive on purpose, because a
 * wrongly skipped site costs the owner a manual sign-in in the agent's browser and a wrongly imported bank session
 * costs money:
 * 1. named domains per category (the larger services worldwide, plus the Vietnamese banks, securities firms and
 *    e-wallets Atum's owners use);
 * 2. a label heuristic: a domain whose first label names a bank (`…bank…`, `creditunion`) or a wallet is skipped
 *    even when it is not listed, so a regional bank nobody added is still left behind.
 * The owner can later add or remove entries from Settings (`owner_override` in the contract); slice 1 has no UI for
 * it. Extend the lists, not the callers.
 */
import type { BrowserImportSiteCategory } from './contract'

const BANKING = [
  // United States
  'ally.com',
  'americanexpress.com',
  'bankofamerica.com',
  'bofa.com',
  'capitalone.com',
  'chase.com',
  'chime.com',
  'citi.com',
  'citibank.com',
  'citizensbank.com',
  'discover.com',
  'etrade.com',
  'fidelity.com',
  'goldmansachs.com',
  'huntington.com',
  'interactivebrokers.com',
  'jpmorgan.com',
  'keybank.com',
  'marcus.com',
  'merrilledge.com',
  'morganstanley.com',
  'navyfederal.org',
  'pnc.com',
  'regions.com',
  'robinhood.com',
  'schwab.com',
  'sofi.com',
  'tdameritrade.com',
  'tdbank.com',
  'truist.com',
  'usaa.com',
  'usbank.com',
  'vanguard.com',
  'wellsfargo.com',
  // Canada, United Kingdom, Europe
  'barclays.co.uk',
  'bmo.com',
  'bnpparibas.com',
  'cibc.com',
  'commerzbank.de',
  'creditagricole.fr',
  'credit-agricole.fr',
  'deutsche-bank.de',
  'hsbc.co.uk',
  'hsbc.com',
  'ing.com',
  'ing.de',
  'ing.nl',
  'lloydsbank.com',
  'monzo.com',
  'n26.com',
  'natwest.com',
  'rbc.com',
  'rbcroyalbank.com',
  'revolut.com',
  'santander.co.uk',
  'santander.com',
  'scotiabank.com',
  'societegenerale.fr',
  'starlingbank.com',
  'td.com',
  'wise.com',
  // Asia-Pacific
  'anz.com',
  'anz.com.au',
  'commbank.com.au',
  'dbs.com',
  'dbs.com.sg',
  'maybank.com',
  'maybank2u.com.my',
  'mizuhobank.co.jp',
  'mufg.jp',
  'nab.com.au',
  'ocbc.com',
  'publicbank.com.my',
  'smbc.co.jp',
  'uob.com.sg',
  'westpac.com.au',
  // Vietnam: banks
  'abbank.vn',
  'acb.com.vn',
  'agribank.com.vn',
  'bacabank.com.vn',
  'bidv.com.vn',
  'bidv.vn',
  'bvbank.net.vn',
  'cake.vn',
  'cbbank.vn',
  'cimbbank.com.vn',
  'eximbank.com.vn',
  'gpbank.com.vn',
  'hdbank.com.vn',
  'hlbank.com.vn',
  'indovinabank.com.vn',
  'kienlongbank.com',
  'lienvietpostbank.com.vn',
  'liobank.vn',
  'lpbank.com.vn',
  'mbbank.com.vn',
  'msb.com.vn',
  'namabank.com.vn',
  'ncb-bank.vn',
  'oceanbank.vn',
  'ocb.com.vn',
  'pvcombank.com.vn',
  'sacombank.com',
  'sacombank.com.vn',
  'scb.com.vn',
  'seabank.com.vn',
  'shb.com.vn',
  'shinhan.com.vn',
  'standardchartered.com.vn',
  'techcombank.com',
  'techcombank.com.vn',
  'timo.vn',
  'tnex.com.vn',
  'tpb.vn',
  'tpbank.com.vn',
  'ubank.vn',
  'vib.com.vn',
  'vietabank.com.vn',
  'vietbank.com.vn',
  'vietcombank.com.vn',
  'vietinbank.vn',
  'vpbank.com.vn',
  'vrbank.com.vn',
  'wooribank.com.vn',
  // Vietnam: securities and consumer credit
  'fecredit.com.vn',
  'homecredit.vn',
  'hsc.com.vn',
  'mbs.com.vn',
  'ssi.com.vn',
  'tcbs.com.vn',
  'vcbs.com.vn',
  'vndirect.com.vn',
  'vps.com.vn'
] as const

const WALLET = [
  // Payment wallets
  'alipay.com',
  'cash.app',
  'neteller.com',
  'payoneer.com',
  'paypal.com',
  'skrill.com',
  'squareup.com',
  'stripe.com',
  'venmo.com',
  'zellepay.com',
  // Vietnam e-wallets and gateways
  '9pay.vn',
  'baokim.vn',
  'moca.vn',
  'momo.vn',
  'nganluong.vn',
  'onepay.vn',
  'payoo.vn',
  'shopeepay.vn',
  'viettelmoney.vn',
  'vimo.vn',
  'vnpay.vn',
  'vnptpay.vn',
  'zalopay.vn',
  // Crypto wallets and exchanges
  'binance.com',
  'binance.us',
  'bitfinex.com',
  'bitflyer.com',
  'bitget.com',
  'bithumb.com',
  'bitkub.com',
  'bitstamp.net',
  'blockchain.com',
  'bybit.com',
  'coincheck.com',
  'coinbase.com',
  'crypto.com',
  'exodus.com',
  'gate.io',
  'gemini.com',
  'htx.com',
  'huobi.com',
  'kraken.com',
  'kucoin.com',
  'ledger.com',
  'metamask.io',
  'mexc.com',
  'okx.com',
  'phantom.app',
  'rainbow.me',
  'trezor.io',
  'trustwallet.com',
  'upbit.com',
  'zerion.io'
] as const

const PASSWORD_MANAGER = [
  '1password.ca',
  '1password.com',
  '1password.eu',
  'authy.com',
  'bitwarden.com',
  'bitwarden.eu',
  'bitwarden.net',
  'dashlane.com',
  'enpass.io',
  'keepersecurity.com',
  'lastpass.com',
  'myki.com',
  'nordpass.com',
  'norton.com',
  'passbolt.com',
  'passwordboss.com',
  'proton.me',
  'protonmail.com',
  'psono.com',
  'roboform.com',
  'stickypassword.com'
] as const

/** Named domains per category. Exposed so a test can hold every entry to the registrable-domain rule. */
export const SKIP_LIST: Readonly<Record<BrowserImportSiteCategory, readonly string[]>> = {
  banking: BANKING,
  password_manager: PASSWORD_MANAGER,
  wallet: WALLET
}

const BY_SITE: ReadonlyMap<string, BrowserImportSiteCategory> = new Map(
  (Object.keys(SKIP_LIST) as BrowserImportSiteCategory[]).flatMap(category =>
    SKIP_LIST[category].map(site => [site, category] as const)
  )
)

/** The first label of a registrable domain: `vietcombank` for `vietcombank.com.vn`. */
const firstLabel = (site: string) => site.slice(0, site.indexOf('.'))

/**
 * The skip category of a registrable domain, or null when the site is imported by default. Only the first label
 * is read by the heuristic: `bank.example.com` is `example.com` and is judged by `example`, not by its subdomain.
 */
export function skipCategory(site: string): BrowserImportSiteCategory | null {
  const named = BY_SITE.get(site)

  if (named) {
    return named
  }

  const label = firstLabel(site)

  if (label.includes('bank') || label.includes('creditunion') || label.includes('credit-union')) {
    return 'banking'
  }

  return label.includes('wallet') ? 'wallet' : null
}
