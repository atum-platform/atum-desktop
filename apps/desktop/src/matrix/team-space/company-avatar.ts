import { useEffect, useRef, useState } from 'react'

import type { MatrixRoom } from '../../../shared/matrix'
import type { MatrixCompanyBridge } from '../../../shared/matrix-company'

interface CompanyAvatarSource {
  companyId: string
  roomId: string
  avatarMxc: string
}

/** One joined channel per company is enough: manager plan 1.3 reconciles the same identity to every company channel. */
function avatarSources(rooms: readonly MatrixRoom[]): CompanyAvatarSource[] {
  const found = new Map<string, CompanyAvatarSource>()

  for (const room of rooms) {
    if (room.membership !== 'join' || !room.companyChannel || !room.roomAvatarMxc || found.has(room.companyChannel.companyId)) {
      continue
    }

    found.set(room.companyChannel.companyId, {
      companyId: room.companyChannel.companyId,
      roomId: room.id,
      avatarMxc: room.roomAvatarMxc
    })
  }

  return [...found.values()].sort((left, right) => left.companyId.localeCompare(right.companyId))
}

/** Authenticated room-avatar media, fenced to the current bridge and exact MXC state. */
export function useCompanyAvatarUrls(bridge: MatrixCompanyBridge, rooms: readonly MatrixRoom[]): Readonly<Record<string, string>> {
  const sources = avatarSources(rooms)
  const key = sources.map(source => `${source.companyId}:${source.roomId}:${source.avatarMxc}`).join('\n')
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    let current = true
    const stable = sourcesRef.current

    if (!bridge.avatar || stable.length === 0) {
      setUrls(previous => Object.keys(previous).length === 0 ? previous : {})

      return () => { current = false }
    }

    void Promise.all(stable.map(async source => {
      const media = await bridge.avatar!(source.roomId).catch(() => null)

      return media?.avatarMxc === source.avatarMxc && media.avatarUrl
        ? [source.companyId, media.avatarUrl] as const
        : null
    })).then(values => {
      if (current) {
        setUrls(Object.fromEntries(values.filter((value): value is readonly [string, string] => value !== null)))
      }
    })

    return () => { current = false }
  }, [bridge, key])

  return urls
}
