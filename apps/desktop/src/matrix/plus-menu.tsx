import { atom } from 'nanostores'
import { Fragment, type ReactNode, useEffect, useRef } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { type Locale, useI18n } from '@/i18n'
import { Plus } from '@/lib/icons'

export interface MatrixPlusMenuItem {
  id: string
  label: string
  icon: ReactNode
  shortcut?: string
  /** A rule above it: the menu's second group (Add people, Upload…). */
  separated?: boolean
  onSelect(): void
}

/**
 * ⌘N on the screen that is open runs its plus menu's first item (layout r2 §4). The screen's menu
 * registers it while it is on screen; Chat's own New message answers when nothing else has.
 */
export const $matrixScreenNew = atom<(() => void) | null>(null)

/**
 * New, as a plus beside a screen's search (layout r2 §4, owner 2026-11-24): T3's MenuPopup recipe
 * over Radix, the same as Chat's (`start-chat.tsx`). Only what the person can make here is listed.
 */
export function MatrixPlusMenu({
  disabled,
  items,
  label,
  primary,
  screen
}: {
  disabled?: boolean
  /** The item ⌘N runs, when it isn't the first (Team Space lists New channel first, ⌘N is New message). */
  primary?: string
  items: readonly MatrixPlusMenuItem[]
  label: string
  /** The screen's name for its markers (`data-atum-create-menu=<screen>`). */
  screen: string
}) {
  // ⌘N runs the named item, else the first; a menu without its named item (Team Space with no
  // conversations) leaves ⌘N to Chat's New message rather than run something else.
  const runs = primary ? items.find(item => item.id === primary)?.onSelect : items[0]?.onSelect
  const first = useRef<(() => void) | undefined>(runs)
  first.current = runs
  const registered = Boolean(runs)

  useEffect(() => {
    if (!registered) {
      return
    }

    const run = () => first.current?.()
    $matrixScreenNew.set(run)

    return () => {
      if ($matrixScreenNew.get() === run) {
        $matrixScreenNew.set(null)
      }
    }
  }, [registered])

  if (!items.length) {
    return null
  }

  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            aria-label={label}
            className="ak-iconbtn shrink-0 disabled:opacity-45"
            data-atum-create-menu={screen}
            data-icon-only
            type="button"
          >
            <Plus aria-hidden className="ak-icon" />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-52" data-atum-create-menu-content={screen}>
        {items.map(item => (
          <Fragment key={item.id}>
            {item.separated && <DropdownMenuSeparator />}
            <DropdownMenuItem data-atum-create-item={item.id} onSelect={item.onSelect}>
              {item.icon}
              {item.label}
              {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The plus menus' and feet's words (Team Space, Drive, Store). Five locales, changed together. */
const copies = {
  en: {
    newMenu: 'New…',
    newChannel: 'New channel',
    newMessage: 'New message',
    newTask: 'New task',
    addPeople: 'Add people',
    newFolder: 'New folder',
    newDocument: 'New document',
    uploadFiles: 'Upload files…',
    uploadFolder: 'Upload a folder…',
    topUp: 'Top up',
    settings: 'Settings',
    switchCompany: 'Switch company',
    storage: (used: string, total?: string) => (total ? `${used} of ${total} used` : `${used} used`)
  },
  vi: {
    newMenu: 'Tạo mới…',
    newChannel: 'Kênh mới',
    newMessage: 'Tin nhắn mới',
    newTask: 'Việc mới',
    addPeople: 'Thêm người',
    newFolder: 'Thư mục mới',
    newDocument: 'Tài liệu mới',
    uploadFiles: 'Tải tệp lên…',
    uploadFolder: 'Tải thư mục lên…',
    topUp: 'Nạp thêm',
    settings: 'Cài đặt',
    switchCompany: 'Đổi công ty',
    storage: (used: string, total?: string) => (total ? `Đã dùng ${used} / ${total}` : `Đã dùng ${used}`)
  },
  ja: {
    newMenu: '新規…',
    newChannel: '新しいチャンネル',
    newMessage: '新しいメッセージ',
    newTask: '新しいタスク',
    addPeople: 'メンバーを追加',
    newFolder: '新しいフォルダ',
    newDocument: '新しい書類',
    uploadFiles: 'ファイルをアップロード…',
    uploadFolder: 'フォルダをアップロード…',
    topUp: 'チャージ',
    settings: '設定',
    switchCompany: '会社を切り替える',
    storage: (used: string, total?: string) => (total ? `${total} 中 ${used} 使用` : `${used} 使用`)
  },
  zh: {
    newMenu: '新建…',
    newChannel: '新建频道',
    newMessage: '新消息',
    newTask: '新任务',
    addPeople: '添加成员',
    newFolder: '新建文件夹',
    newDocument: '新建文稿',
    uploadFiles: '上传文件…',
    uploadFolder: '上传文件夹…',
    topUp: '充值',
    settings: '设置',
    switchCompany: '切换公司',
    storage: (used: string, total?: string) => (total ? `已用 ${used}，共 ${total}` : `已用 ${used}`)
  },
  'zh-hant': {
    newMenu: '新增…',
    newChannel: '新增頻道',
    newMessage: '新訊息',
    newTask: '新任務',
    addPeople: '新增成員',
    newFolder: '新增檔案夾',
    newDocument: '新增文件',
    uploadFiles: '上傳檔案…',
    uploadFolder: '上傳檔案夾…',
    topUp: '儲值',
    settings: '設定',
    switchCompany: '切換公司',
    storage: (used: string, total?: string) => (total ? `已使用 ${used}，共 ${total}` : `已使用 ${used}`)
  }
} satisfies Record<Locale, unknown>

export function plusMenuCopy(locale: Locale) {
  return copies[locale]
}

export function usePlusMenuCopy() {
  return copies[useI18n().locale]
}
