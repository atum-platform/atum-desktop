import { createHash } from 'node:crypto'

/**
 * The participant-set digest of `atum.company-workspace/1.5` (README, "Identity and audience"): the
 * identity of a company conversation, normative for SQL, TypeScript and Swift. Participants sort by
 * the ascending UTF-8 bytes of `memberRef`; the preimage is UTF-8 with LF line endings, no BOM and a
 * final LF; the hash is SHA-256, lowercase hexadecimal. The platform's vectors
 * (`participant-digest-*.vector.json`) are run through this in `company-team-space.test.ts`.
 */
export const COMPANY_CONVERSATION_DIGEST_PREFIX = 'atum.company-conversation-participant-set/1'

export interface DigestParticipant {
  memberRef: string
  admissionEpoch: number
}

export function companyConversationDigest(
  companyId: string,
  kind: 'dm' | 'group_dm',
  participants: readonly DigestParticipant[]
): string {
  const sorted = [...participants].sort((left, right) => Buffer.compare(Buffer.from(left.memberRef, 'utf8'), Buffer.from(right.memberRef, 'utf8')))

  const preimage = [
    COMPANY_CONVERSATION_DIGEST_PREFIX,
    `companyId=${companyId}`,
    `kind=${kind}`,
    ...sorted.map(participant => `member=${participant.memberRef}:${participant.admissionEpoch}`)
  ].join('\n') + '\n'

  return createHash('sha256').update(preimage, 'utf8').digest('hex')
}
