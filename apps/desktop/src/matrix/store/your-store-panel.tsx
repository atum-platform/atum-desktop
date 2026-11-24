import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { X } from '@/lib/icons'

import type { MatrixStoreSnapshot } from '../../../shared/matrix-store'

import { localizedStoreText, StoreArt } from './store-card'

/** Five locales, changed together. */
const copies: Record<
  Locale,
  { title: string; close: string; recent: string; nothingYet: string; open: string; all: string; featured: string; view: string }
> = {
  en: { title: 'Your Store', close: 'Close', recent: 'Recent', nothingYet: 'What you get shows here.', open: 'Open', all: 'All purchases', featured: 'Featured', view: 'View' },
  vi: { title: 'Store của bạn', close: 'Đóng', recent: 'Gần đây', nothingYet: 'Những gì bạn nhận sẽ hiện ở đây.', open: 'Mở', all: 'Tất cả đã mua', featured: 'Nổi bật', view: 'Xem' },
  ja: { title: 'あなたのストア', close: '閉じる', recent: '最近', nothingYet: '入手したものがここに表示されます。', open: '開く', all: '購入したものすべて', featured: 'おすすめ', view: '見る' },
  zh: { title: '你的商店', close: '关闭', recent: '最近', nothingYet: '你获得的项目会显示在这里。', open: '打开', all: '全部已购', featured: '精选', view: '查看' },
  'zh-hant': { title: '你的商店', close: '關閉', recent: '最近', nothingYet: '你取得的項目會顯示在這裡。', open: '打開', all: '全部已購', featured: '精選', view: '查看' }
}

/**
 * The Store's neutral right panel (layout r2 §2, owner 2026-11-24): what the person got lately, each
 * with Open (its listing, where it is used), All purchases, and one featured item. Never the balance:
 * it shows inside the top-up. Opening an item shows its details; closing them comes back here.
 */
export function MatrixYourStorePanel({
  onAllPurchases,
  onClose,
  onOpenItem,
  store
}: {
  onAllPurchases(): void
  onClose(): void
  onOpenItem(itemId: string): void
  store: MatrixStoreSnapshot
}) {
  const { locale } = useI18n()
  const copy = copies[locale]
  const items = new Map(store.items.map(item => [item.itemId, item]))

  const recent = [...store.entitlements]
    .filter(row => row.state === 'active' && items.has(row.itemId))
    .sort((left, right) => Date.parse(right.grantedAt) - Date.parse(left.grantedAt))
    .filter((row, index, rows) => rows.findIndex(other => other.itemId === row.itemId) === index)
    .slice(0, 4)

  const owned = new Set(recent.map(row => row.itemId))

  const featured = [...store.items]
    .filter(item => item.featured && !owned.has(item.itemId))
    .sort((left, right) => left.sortOrder - right.sortOrder)[0]

  return (
    <aside aria-label={copy.title} className="atum-neutral-panel" data-matrix-your-store>
      <header className="atum-neutral-panel-head">
        <h2 className="min-w-0 flex-1 truncate">{copy.title}</h2>
        <Tip label={copy.close}>
          <button aria-label={copy.close} className="ak-iconbtn ak-iconbtn--sm" onClick={onClose} type="button">
            <X aria-hidden className="ak-icon" />
          </button>
        </Tip>
      </header>
      <div className="atum-neutral-panel-body">
        <section>
          <h3 className="atum-neutral-panel-label">{copy.recent}</h3>
          {recent.length === 0 ? (
            <p className="px-1 text-(--atum-ink-muted)">{copy.nothingYet}</p>
          ) : (
            <ul className="atum-neutral-panel-card flex flex-col gap-2">
              {recent.map(row => {
                const item = items.get(row.itemId)!

                return (
                  <li className="flex items-center gap-3" data-your-store-item={row.itemId} key={row.id}>
                    <StoreArt face={item.kind === 'agent'} item={item} size="tile" />
                    <span className="min-w-0 flex-1 truncate font-medium text-(--atum-ink)">
                      {localizedStoreText(item.title, locale)}
                    </span>
                    <button className="ak-btn ak-btn--secondary ak-btn--sm" onClick={() => onOpenItem(item.itemId)} type="button">
                      {copy.open}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <button className="ak-btn ak-btn--plain ak-btn--sm mt-2" data-your-store-all onClick={onAllPurchases} type="button">
            {copy.all}
          </button>
        </section>
        {featured && (
          <section>
            <h3 className="atum-neutral-panel-label">{copy.featured}</h3>
            <div className="atum-neutral-panel-card flex items-center gap-3" data-your-store-featured={featured.itemId}>
              <StoreArt face={featured.kind === 'agent'} item={featured} size="tile" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium text-(--atum-ink)">{localizedStoreText(featured.title, locale)}</span>
                <span className="line-clamp-2 text-xs text-(--atum-ink-muted)">
                  {localizedStoreText(featured.summary, locale)}
                </span>
              </span>
              <button className="ak-btn ak-btn--secondary ak-btn--sm" onClick={() => onOpenItem(featured.itemId)} type="button">
                {copy.view}
              </button>
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
