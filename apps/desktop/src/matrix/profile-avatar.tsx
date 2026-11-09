import { useEffect, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'

import type { AtumAssistantMark } from '../../shared/atum-agent-portability'
import type { MatrixProfileMetadata, MatrixProfileTarget } from '../../shared/matrix-profile'

/** A cosmetic authenticated projection. The target never becomes an SDK selector. */
export function MatrixProfileAvatar({
  avatarUrl,
  brand,
  className,
  id,
  inset,
  mark,
  name,
  profile,
  rosterAvatar,
  scopeKey,
  target
}: {
  /** Agent photos come from the canonical assistant roster. Humans leave this undefined. */
  avatarUrl?: string | null
  brand?: boolean
  className: string
  id: string
  /** The brand mark drawn inside its tile, as the chat list's rows show it. */
  inset?: boolean
  mark?: AtumAssistantMark
  name: string
  profile?: MatrixProfileMetadata
  rosterAvatar?: boolean
  scopeKey: string
  target: MatrixProfileTarget
}) {
  const targetKey = target.kind === 'human' ? 'human' : target.principal
  const agentAvatar = target.kind === 'agent' ? avatarUrl ?? null : undefined
  const key = `${scopeKey}/${targetKey}/${agentAvatar === undefined ? profile?.avatarMxc ?? '' : agentAvatar ?? ''}`
  const [photo, setPhoto] = useState<{ key: string; url: string | null }>()

  useEffect(() => {
    if (agentAvatar !== undefined || !profile?.avatarMxc || !window.atumMatrix.profiles) {
      return
    }

    let current = true
    void window.atumMatrix.profiles
      .read(target)
      .then(value => {
        if (current && value.userId === profile.userId && value.avatarMxc === profile.avatarMxc) {
          setPhoto({ key, url: value.avatarUrl })
        }
      })
      .catch(() => {})

    return () => {
      current = false
    }
    // A target is reconstructed by callers; only its identity and media revision matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentAvatar, key, profile?.userId, profile?.avatarMxc])

  return (
    <AtumAssistantAvatar
      avatarUrl={agentAvatar === undefined ? (photo?.key === key ? photo.url : null) : agentAvatar}
      brand={brand}
      className={className}
      id={id}
      inset={inset}
      mark={mark}
      name={name}
      rosterAvatar={rosterAvatar}
    />
  )
}
