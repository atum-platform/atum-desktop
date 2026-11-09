import type { CompanyAICitation } from './company-desktop-adapter'

export interface CompanyCitationContext {
  /** The company channel directory's display name for a channel id. */
  channelName?(channelId: string): string | undefined
  /** A best-effort display name of the person who sent the cited message. */
  senderName?(citation: CompanyAICitation): string | undefined
}

export interface CompanyCitationSource {
  /** A human label; never a raw event or source id. */
  label: string
  at: string | null
}

function messageTime(at: string, locale: string): string | null {
  const value = new Date(at)

  return Number.isNaN(value.getTime())
    ? null
    : new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(value)
}

/**
 * One citation as a person reads it: the document's title, or the channel, who
 * sent it and when. D1 owns opening it and rechecks authority; this is a label.
 */
export function companyCitationSource(
  citation: CompanyAICitation,
  locale: string,
  context: CompanyCitationContext = {},
  messageFallback = 'Message'
): CompanyCitationSource {
  if (citation.kind === 'company_file') {
    return { label: citation.file.name, at: null }
  }

  const channel = context.channelName?.(citation.channelId)
  const sender = context.senderName?.(citation)
  const time = citation.at ? messageTime(citation.at, locale) : null
  const head = channel ? `#${channel}` : messageFallback
  const who = sender ? `${head} · ${sender}` : head
  const label = time ? (sender ? `${who}, ${time}` : `${who} · ${time}`) : who

  return { label, at: citation.at }
}

/** The place a card change came from: a channel or a document, never an id. */
export function companyCitationPlace(
  citation: CompanyAICitation,
  context: CompanyCitationContext = {},
  messageFallback = 'Message'
): string | undefined {
  if (citation.kind === 'company_file') {
    return citation.file.name
  }

  const channel = context.channelName?.(citation.channelId)

  return channel ? `#${channel}` : messageFallback
}

/** The full timestamp for a source's tooltip. */
export function companyCitationTimestamp(
  citation: CompanyAICitation,
  locale: string
): string | null {
  if (citation.kind !== 'channel' || !citation.at) {
    return null
  }

  const value = new Date(citation.at)

  return Number.isNaN(value.getTime())
    ? null
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}
