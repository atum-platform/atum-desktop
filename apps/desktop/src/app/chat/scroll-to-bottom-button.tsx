import { useStore } from '@nanostores/react'

import { ThreadScrollToBottomButton } from '@/components/assistant-ui/thread/scroll-to-bottom'
import { $approvalRequest } from '@/store/prompts'

/** Legacy gateway adapter: the shared jump control also leads to its inline
 * approval when blocked. Matrix reuses the control without these stores. */
export function ScrollToBottomButton() {
  const request = useStore($approvalRequest)

  return <ThreadScrollToBottomButton approval={Boolean(request)} />
}
