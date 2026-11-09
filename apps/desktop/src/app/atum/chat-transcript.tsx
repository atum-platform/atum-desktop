import type { ComponentProps } from 'react'

import { ThreadMessageList } from '@/components/assistant-ui/thread/list'
import { ThreadScrollToBottomButton } from '@/components/assistant-ui/thread/scroll-to-bottom'

/** The Mac and browser share rendering budgets, history loading and one scroll owner. The composer
 * floats over its foot (see matrix/composer-dock.tsx), so it keeps the dock's height clear below. */
export function AtumChatTranscript(props: ComponentProps<typeof ThreadMessageList>) {
  return (
    <>
      <ThreadMessageList dockClearance {...props} />
      <ThreadScrollToBottomButton inViewport />
    </>
  )
}
