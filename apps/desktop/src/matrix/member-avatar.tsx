import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'

import type { MatrixAgentView } from '../../shared/matrix'

import { $matrixMemberAvatars, loadMatrixMemberAvatar } from './member-avatars'
import { type MatrixTeammateIdentity, useMatrixTeammatePresence } from './presence-store'
import { MatrixPresenceFace } from './presence-view'

/** A person's real Matrix profile photo, or their initial until it arrives. */
export function MatrixMemberAvatar({
  avatarMxc,
  className,
  id,
  name,
  presence
}: {
  avatarMxc?: string | null
  className: string
  id: string
  name: string
  /** False where a presence dot is noise (message rows, stacks, chat rows). */
  presence?: boolean
}) {
  const known = useStore($matrixMemberAvatars)[id]
  const mxc = avatarMxc ?? null

  useEffect(() => {
    if (mxc) {
      loadMatrixMemberAvatar(id, mxc)
    }
  }, [id, mxc])

  return (
    <MatrixPresenceFace className={className} presence={presence} userId={id}>
      <AtumAssistantAvatar
        avatarUrl={mxc && known?.mxc === mxc ? known.avatarUrl : null}
        className="size-full text-[inherit] leading-[inherit]"
        id={id}
        name={name}
      />
    </MatrixPresenceFace>
  )
}

/** One of the owner's agents wears its roster photo or mark; a person their Matrix photo. */
export function MatrixPersonAvatar({
  agent,
  avatarMxc,
  className,
  id,
  name,
  presence
}: {
  agent?: MatrixAgentView
  avatarMxc?: string | null
  className: string
  id: string
  name: string
  presence?: boolean
}) {
  if (agent) {
    return (
      <AtumAssistantAvatar
        avatarUrl={agent.avatarUrl}
        brand={agent.isDefault}
        className={className}
        id={agent.principal}
        mark={agent.mark}
        name={name}
      />
    )
  }

  return <MatrixMemberAvatar avatarMxc={avatarMxc} className={className} id={id} name={name} presence={presence} />
}

/** Platform member refs carry access identity, not Matrix IDs. A cosmetic avatar gains presence
 * only when its verified handle or unique display name resolves to observed Matrix evidence. */
export function MatrixTeammateAvatar({ className, name, person, presence: showPresence }: {
  className: string
  name: string
  person: MatrixTeammateIdentity
  presence?: boolean
}) {
  const presence = useMatrixTeammatePresence(person)

  return presence ? (
    <MatrixMemberAvatar
      avatarMxc={presence.avatarMxc}
      className={className}
      id={presence.userId}
      name={name}
      presence={showPresence}
    />
  ) : (
    <AtumAssistantAvatar className={className} id={person.memberRef} name={name} />
  )
}
