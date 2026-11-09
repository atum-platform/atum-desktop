import { AppCatalogAvatar } from '@/app/atum/app-catalog-presentation'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ArrowUpRight, CheckCircle2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type AppDescriptor, appLocalizedCopy } from '../../../shared/app-catalog'

import { useAssistantCardCopy } from './copy'

/**
 * An official Atum app's card (Moon, Andy): the same card, read only. Its face, its name with
 * the verified mark, what it is, and the way to open it. Nothing on it can be edited, so
 * nothing on it pretends to be (no pencil, no hover band, no rows).
 */
export function AppCard({
  app,
  compact,
  onClose,
  onOpen
}: {
  app: AppDescriptor
  compact: boolean
  onClose(): void
  onOpen(): void
}) {
  const copy = useAssistantCardCopy()
  const { locale } = useI18n()
  const name = appLocalizedCopy(app.name, locale, app.app)
  const about = appLocalizedCopy(app.description, locale) || appLocalizedCopy(app.subtitle, locale)

  return (
    <>
      <div className="atum-card-top">
        <Button data-assistant-card-done onClick={onClose} variant="text">
          {copy.done}
        </Button>
      </div>
      <div className="atum-card-body" data-compact={compact || undefined}>
        <header className="atum-card-header">
          <AppCatalogAvatar
            app={app}
            className={cn('atum-card-avatar', compact && 'atum-card-avatar-compact')}
            locale={locale}
            tile
          />
          <h2 className="atum-card-name flex max-w-[22rem] items-center justify-center gap-1.5 px-2.5 text-center">
            <span className="truncate">{name}</span>
            {app.verified && (
              <CheckCircle2 aria-label={copy.verified} className="size-[1.125rem] shrink-0 text-(--atum-accent)" role="img" />
            )}
          </h2>
          <p className="atum-card-privacy" id="assistant-card-privacy">
            {copy.appCaption}
          </p>
          {app.availability === 'available' && (
            <div className="atum-card-pills">
              <button className="atum-card-pill" data-assistant-card-open-app onClick={onOpen} type="button">
                <ArrowUpRight aria-hidden className="size-3.5" />
                {copy.openApp(name)}
              </button>
            </div>
          )}
        </header>
        {about && (
          <section className="atum-card-section">
            <div className="atum-settings-group">
              <p className="atum-settings-row text-(--atum-ink-soft)">{about}</p>
            </div>
          </section>
        )}
      </div>
    </>
  )
}
