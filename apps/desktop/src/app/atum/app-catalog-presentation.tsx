import { useEffect, useState } from 'react'

import { VerifiedMark } from '@/components/verified-mark'
import { Spinner } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type AppDescriptor, appLocalizedCopy } from '../../../shared/app-catalog'
import { appChatCopy } from '../../../shared/matrix-app-chat-copy'
import { appVerificationTier } from '../../../shared/verification'

type AppCatalogContext = 'roster' | 'detail'

const affiliationCopy: Record<string, Record<'first_party' | 'partner', string>> = {
  en: { first_party: 'Atum', partner: 'Partner' },
  vi: { first_party: 'Atum', partner: 'Đối tác' },
  ja: { first_party: 'Atum', partner: 'パートナー' },
  zh: { first_party: 'Atum', partner: '合作伙伴' },
  'zh-hant': { first_party: 'Atum', partner: '合作夥伴' }
}

function localizedAffiliation(affiliation: string | null, locale: string): string {
  if (affiliation !== 'first_party' && affiliation !== 'partner') {
    return ''
  }

  return affiliationCopy[locale]?.[affiliation] ?? affiliationCopy.en[affiliation]
}

function avatarInitial(name: string, locale: string): string {
  return (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase(locale)
}

export function AppCatalogAvatar({
  app,
  className = 'size-9',
  locale,
  tile = false
}: {
  app: AppDescriptor
  className?: string
  locale: string
  /** Without an icon, a filled tile in the app's accent, as app icons are drawn. */
  tile?: boolean
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // An official chat identity is deliberately distinct from the browser app
  // tile.  The catalog signs both and the conversation list must show the
  // identity that will actually receive encrypted messages.
  const name = app.bot?.display_name ?? appLocalizedCopy(app.name, locale, app.app)
  const imageUrl = app.bot?.avatar.url || app.icon?.url || null

  useEffect(() => setFailedUrl(null), [imageUrl])

  if (imageUrl && imageUrl !== failedUrl) {
    return (
      <img
        alt=""
        className={cn('atum-avatar', className, 'shrink-0 object-cover')}
        data-app-catalog-avatar
        data-face="app"
        onError={() => setFailedUrl(imageUrl)}
        src={imageUrl}
      />
    )
  }

  if (tile) {
    return (
      <span
        aria-hidden
        className={cn('atum-avatar', className, 'grid shrink-0 place-items-center font-semibold')}
        data-app-catalog-avatar
        data-app-catalog-tile
        data-face="app"
        // The catalog admits only #rrggbb accents, so this is a plain colour.
        style={
          app.accent
            ? { background: `linear-gradient(180deg, color-mix(in srgb, ${app.accent} 72%, white), ${app.accent})` }
            : undefined
        }
      >
        {avatarInitial(name, locale)}
      </span>
    )
  }

  return (
    <span
      aria-hidden
      className={cn('atum-avatar', className, 'grid shrink-0 place-items-center bg-(--atum-hover) font-semibold text-(--atum-ink)')}
        data-app-catalog-avatar
      data-face="app"
      style={app.accent ? { borderColor: app.accent } : undefined}
    >
      {avatarInitial(name, locale)}
    </span>
  )
}

/** A presentational identity only: no stores, routes, IPC, or launch authority. */
export function AppCatalogIdentity({
  app,
  context,
  locale
}: {
  app: AppDescriptor
  context: AppCatalogContext
  locale: string
}) {
  const name = app.bot?.display_name ?? appLocalizedCopy(app.name, locale, app.app)
  const subtitle = appLocalizedCopy(app.subtitle, locale)
  const description = appLocalizedCopy(app.description, locale)
  const affiliation = localizedAffiliation(app.affiliation, locale)

  // An official bot occupies the people roster as its Matrix identity. Do not
  // relabel a healthy Moon/Andy row as a generic "App"; only surface an
  // localized exceptional lifecycle state when it needs attention.
  const botCopy = appChatCopy(locale)

  const rosterSecondary = app.bot
    ? app.bot.state === 'active' ? '' : botCopy.botRowState[app.bot.state]
    : [description, affiliation].filter(Boolean).join(' · ')

  return (
    <div className="flex min-w-0 items-start gap-2.5" data-app-catalog-identity={context}>
      <AppCatalogAvatar app={app} locale={locale} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate font-medium" data-app-catalog-name>
            {name}
          </span>
          {/* Its tier, from the catalog only: Atum's own apps a filled check, verified apps a
              hollow one (the legacy `verified` flag draws nothing). */}
          <VerifiedMark
            data-app-catalog-verified={appVerificationTier(app) ?? undefined}
            subject="app"
            tier={appVerificationTier(app)}
          />
        </div>
        {context === 'detail' && subtitle && (
          <p className="truncate text-sm text-(--atum-ink-muted)" data-app-catalog-subtitle>
            {subtitle}
          </p>
        )}
        {context === 'detail' && description && (
          <p className="mt-1 text-sm text-(--atum-ink-muted)" data-app-catalog-description>
            {description}
          </p>
        )}
        {context === 'detail' && affiliation && (
          <p className="mt-1 text-sm text-(--atum-ink-muted)" data-app-catalog-affiliation>
            {affiliation}
          </p>
        )}
        {context === 'roster' && rosterSecondary && (
          <p className="truncate text-sm text-(--atum-ink-muted)" data-app-catalog-description>
            {rosterSecondary}
          </p>
        )}
      </div>
    </div>
  )
}

export function AppCatalogRow({
  app,
  disabled = false,
  locale,
  onSelect,
  pending,
  selected = false
}: {
  app: AppDescriptor
  disabled?: boolean
  locale: string
  onSelect?: (app: AppDescriptor) => void
  pending?: string
  selected?: boolean
}) {
  const identity = <AppCatalogIdentity app={app} context="roster" locale={locale} />

  const className = cn(
    'w-full rounded-xl px-2 py-2 text-left',
    onSelect && 'transition-colors hover:bg-(--atum-hover)',
    selected && 'bg-(--atum-pressed)'
  )

  if (!onSelect) {
    return (
      <div className={className} data-app-catalog-row={app.app}>
        {identity}
      </div>
    )
  }

  return (
    <button
      aria-busy={Boolean(pending)}
      aria-current={selected ? 'true' : undefined}
      className={className}
      data-app-catalog-row={app.app}
      disabled={disabled || Boolean(pending)}
      onClick={() => onSelect(app)}
      type="button"
    >
      {identity}
      {pending && <span className="mt-1 flex items-center gap-1.5 ps-11 text-xs" role="status"><Spinner aria-hidden className="size-3 animate-spin" />{pending}</span>}
    </button>
  )
}

/** Reusable rows with caller-injected interaction; availability remains caller policy. */
export function AppCatalogList({
  apps,
  locale,
  onSelect,
  selectedAppId
}: {
  apps: readonly AppDescriptor[]
  locale: string
  onSelect?: (app: AppDescriptor) => void
  selectedAppId?: string | null
}) {
  return (
    <div className="space-y-1" data-app-catalog-list>
      {apps.map(app => (
        <AppCatalogRow
          app={app}
          key={app.app_id}
          locale={locale}
          onSelect={onSelect}
          selected={app.app_id === selectedAppId}
        />
      ))}
    </div>
  )
}
