import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useEffect, useRef } from 'react'

/**
 * The Founder's shared presentation state. The profile sheet opens from the chat's header and
 * the roster's menu, and lives once, beside the Founder row; Contact us asks the window
 * (app.tsx) to bring the chat to the front from wherever it is (Workplace, Drive, the drawer).
 */
export const $founderProfileOpen = atom(false)

/**
 * The Founder draft, Element's local direct chat: a roster row and an empty chat that exist
 * only in this window until the person's first message makes the room. Opening it creates
 * nothing and invites no one.
 */
export const $founderDraftOpen = atom(false)

/** One count per request, so each request is acted on once. */
export const $founderChatRequests = atom(0)

export function openFounderProfile(): void {
  $founderProfileOpen.set(true)
}

export function closeFounderProfile(): void {
  $founderProfileOpen.set(false)
}

export function openFounderDraft(): void {
  $founderDraftOpen.set(true)
}

export function closeFounderDraft(): void {
  $founderDraftOpen.set(false)
}

/** Contact us opened the Founder chat: the person asked for it, so it comes to the front. */
export function requestFounderChat(): void {
  $founderChatRequests.set($founderChatRequests.get() + 1)
}

/** Runs `show` once for each request made after the caller mounted. */
export function useFounderChatRequests(show: () => void): void {
  const requests = useStore($founderChatRequests)
  const seen = useRef(requests)
  const latest = useRef(show)

  useEffect(() => {
    latest.current = show
  })

  useEffect(() => {
    if (requests !== seen.current) {
      seen.current = requests
      latest.current()
    }
  }, [requests])
}
