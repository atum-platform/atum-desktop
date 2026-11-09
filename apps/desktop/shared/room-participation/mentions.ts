export interface GroupMentionRecipient {
  userId: string
  name: string
}

/** Literal Unicode names; ambiguity yields no authority and longer names consume first. */
export function groupTypedMentions(body: string, recipients: readonly GroupMentionRecipient[]): string[] {
  const names = new Map<string, string[]>()

  for (const agent of recipients) {
    const name = agent.name.trim().normalize('NFC')

    if (!name) {
      continue
    }

    const key = name.toLocaleLowerCase('en')
    names.set(key, [...(names.get(key) ?? []), agent.userId])
  }

  if (!names.size) {
    return []
  }

  const alternatives = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

  const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])@(${alternatives})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu')

  return [
    ...new Set(
      [...body.normalize('NFC').matchAll(pattern)].flatMap(match => {
        const ids = [...new Set(names.get(match[1]!.toLocaleLowerCase('en'))!)]

        return ids.length === 1 ? ids : []
      })
    )
  ]
}
