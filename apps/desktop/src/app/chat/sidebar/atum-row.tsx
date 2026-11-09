import { Codicon } from '@/components/ui/codicon'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import type { AtumMessagingConversation } from '@/lib/atum-messaging-client'

interface AtumConversationRowProps {
  active: boolean
  conversation: AtumMessagingConversation
  onOpen: () => void
  unreadLabel: (count: number) => string
}

function previewOf(conversation: AtumMessagingConversation): string {
  const preview = conversation.payload.lastMessagePreview ?? conversation.payload.preview

  return typeof preview === 'string' ? preview : ''
}

export function AtumConversationRow({ active, conversation, onOpen, unreadLabel }: AtumConversationRowProps) {
  const title = conversation.title?.trim() || conversation.participantIds.join(', ') || 'Atum'
  const preview = previewOf(conversation)

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-current={active ? 'page' : undefined}
        aria-label={conversation.unreadCount > 0 ? `${title}, ${unreadLabel(conversation.unreadCount)}` : title}
        className="h-auto min-h-11 gap-2 rounded-lg px-2 py-1.5"
        isActive={active}
        onClick={onOpen}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">
          <Codicon name="person" size="0.875rem" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground">{title}</span>
            {conversation.unreadCount > 0 && (
              <span className="grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-4 text-primary-foreground">
                {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
              </span>
            )}
          </span>
          {preview && <span className="block truncate text-[0.6875rem] text-(--ui-text-tertiary)">{preview}</span>}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
