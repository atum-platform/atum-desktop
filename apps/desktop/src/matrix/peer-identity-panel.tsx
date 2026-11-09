import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import { matrixDeviceIsolationCopy } from '../../shared/matrix-device-isolation-copy'
import { isMatrixVerificationPending } from '../../shared/matrix-security'

import { useSecurityCopy } from './security-copy'

/** Current joined-room SDK facts only. Native owns consent and the actual SAS flow. */
export function MatrixPeerIdentityPanel({ snapshot, onResolved }: { snapshot: MatrixSnapshot; onResolved?(): void }) {
  const resolved = useRef(onResolved)
  resolved.current = onResolved
  const { locale } = useI18n()
  const copy = matrixDeviceIsolationCopy[locale]
  const securityCopy = useSecurityCopy()
  const [facts, setFacts] = useState<Array<{ userId: string; status: 'changed' | 'verification_required' }>>([])
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const identity = snapshot.identity
  const roomId = snapshot.roomId
  const peers = JSON.stringify(
    snapshot.members
      ?.filter(member => member.membership === 'join' && member.userId !== identity?.userId)
      .map(member => member.userId) ?? []
  )
  const scope = JSON.stringify([identity, roomId, snapshot.petScope])
  const [factScope, setFactScope] = useState(scope)
  const room = snapshot.rooms.find(room => room.id === roomId)
  const ready =
    snapshot.state === 'ready' &&
    room?.membership === 'join' &&
    room.encrypted &&
    !(snapshot.security?.verification && isMatrixVerificationPending(snapshot.security.verification))

  useEffect(() => {
    let live = true
    setFacts([])
    setFactScope(scope)
    setFailed(false)
    if (!identity || !roomId || !ready) {
      return
    }
    void (async () => {
      const found: typeof facts = []
      for (const userId of JSON.parse(peers) as string[]) {
        if (!live) {
          return
        }
        const status = await window.atumMatrix.command({
          kind: 'peerIdentity',
          identity,
          roomId,
          userId,
          action: 'read'
        })
        if (status === 'changed' || status === 'verification_required') {
          found.push({ userId, status })
        }
      }
      if (live) {
        setFacts(found)
        if (found.length === 0) {
          resolved.current?.()
        }
      }
    })().catch(() => {
      if (live) {
        setFailed(true)
      }
    })
    return () => {
      live = false
    }
    // Serialized display scope is the identity/room/account generation boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, peers, ready, revision])

  const act = async (userId: string, action: 'review' | 'continue') => {
    if (pending || !identity || !roomId || factScope !== scope) {
      return
    }
    setPending(true)
    setFailed(false)
    try {
      await window.atumMatrix.command({ kind: 'peerIdentity', identity, roomId, userId, action })
      if (action === 'continue') {
        setRevision(value => value + 1)
      }
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-matrix-peer-identity>
      {factScope === scope &&
        facts.map(({ userId, status }) => {
          const name = snapshot.members?.find(member => member.userId === userId)?.name ?? ''
          return (
            <div className="atum-settings-item" key={userId}>
              <p className="atum-settings-help">
                {status === 'changed' ? copy.identityChanged(name) : copy.verificationRequired(name)}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={pending || !ready} onClick={() => void act(userId, 'review')}>
                  {copy.review}
                </Button>
                <Button disabled={pending || !ready} onClick={() => void act(userId, 'continue')} variant="secondary">
                  {copy.continueWithoutVerification}
                </Button>
              </div>
            </div>
          )
        })}
      {failed && <NoticeBand tone="failure">{securityCopy.error}</NoticeBand>}
    </div>
  )
}
