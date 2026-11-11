/** Passive agent-turns/1.7 port. Validate with the existing pinned-pack interpreter,
 * schema.ts messageViolations (no parallel schema engine). No access capability. */
import { AGENT_TURNS_1_7_PACK } from './contract-packs';
import { messageViolations } from './schema';
export type FileAudience = { kind: 'channel'; channelId: string } |
  { kind: 'private'; memberPrincipal: string; membershipIncarnation: string };
export type FileIdentity = {
  agentPrincipal: string; roomId: string; threadRootEventId: string; taskId: string; invocationId: string;
} & ({ scope: 'owner_private'; ownerPrincipal: string } | { scope: 'company'; companyId: string; audience: FileAudience });
export interface FileChip {
  fileKey: string; name: string; place: string; revision: number;
  state: 'saving' | 'saved' | 'saved_as_copy' | 'not_confirmed' | 'expired';
  outcome: 'recovering' | 'committed' | 'committed_with_siblings' | 'terminal_unknown' | 'refused' | 'draft_evicted';
  draftAvailable?: boolean; reason?: 'authorization' | 'size' | 'quota' | 'excluded_name' | 'other';
}
export interface FileAnswer {
  msgtype: 'm.text'; body: string;
  'io.atum.files': { profile: 'atum.agent-turns/1.7'; identity: FileIdentity; files: FileChip[] };
  'm.relates_to': { rel_type: 'm.thread'; event_id: string; is_falling_back: false; 'm.in_reply_to': { event_id: string } };
}
export interface FileUpdate {
  'io.atum.files': { profile: 'atum.agent-turns/1.7'; identity: FileIdentity; answerEventId: string; file: FileChip };
  'm.relates_to': { rel_type: 'm.reference'; event_id: string };
}
const pack = AGENT_TURNS_1_7_PACK;

export function parseFileAnswer(value: unknown): FileAnswer | undefined {
  if (messageViolations(pack, 'files.answer', value).length) {return undefined;}
  const answer = value as FileAnswer;
  const keys = answer['io.atum.files'].files.map(file => file.fileKey);

  return new Set(keys).size === keys.length ? structuredClone(answer) : undefined;
}

export function parseFileUpdate(value: unknown): FileUpdate | undefined {
  return messageViolations(pack, 'files.update', value).length ? undefined : structuredClone(value as FileUpdate);
}
