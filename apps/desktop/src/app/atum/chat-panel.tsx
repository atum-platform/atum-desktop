
import { WiredPane } from '@/app/contrib/context'

import { AtumChatActions, AtumChatIdentity } from './chat-header'
import { AtumMainHeader } from './main-header'
import { NativeAppBar } from './native-app-bar'
import { WordCompanionBar } from './word-companion-bar'

/**
 * The chat column: its top row (the conversation's identity, at the shell's
 * one row height), then the transcript. It sits on the window ground the main
 * column paints — no plate of its own.
 *
 * The BODY is `WiredPane part="chatRoutes"` — the same assistant-ui transcript,
 * tool cards, approvals, and DM view the Hermes shell renders. There is exactly
 * one transcript renderer in this app and this is not a second one.
 */
export function AtumChatPanel({ covered = false }: { covered?: boolean }) {
  return (
    <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden [-webkit-app-region:no-drag]" data-atum-chat inert={covered ? true : undefined}>
      <AtumMainHeader actions={<AtumChatActions />}>
        <AtumChatIdentity />
      </AtumMainHeader>
      <WordCompanionBar />
      <NativeAppBar />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <WiredPane part="chatRoutes" />
      </div>
    </section>
  )
}
