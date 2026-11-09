import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';
import type { TurnGrant } from './messages';
import type { WorkspaceBinding, WorkspaceFinalize, WorkspaceResult } from './workspace-messages';

const BINDING_KEYS = ['requestId', 'grantId', 'invocationId', 'connectionId', 'connectionEpoch',
  'deviceServiceId', 'enrollmentEpoch', 'accountEpoch', 'writerEpoch'] as const;
export function workspaceBinding(value: WorkspaceBinding): WorkspaceBinding {
  return Object.fromEntries(BINDING_KEYS.map(key => [key, value[key]])) as unknown as WorkspaceBinding;
}
export function sameWorkspaceBinding(a: WorkspaceBinding, b: WorkspaceBinding): boolean {
  return canonicalJson(workspaceBinding(a)) === canonicalJson(workspaceBinding(b));
}
export function workspaceResultHash(result: Omit<WorkspaceResult, 'resultHash'> | WorkspaceResult): string {
  const { resultHash: _hash, ...body } = result as WorkspaceResult;
  return createHash('sha256').update(canonicalJson(body)).digest('base64url');
}
export function workspaceFinalizeRefusal(request: WorkspaceFinalize, grant: TurnGrant | null,
  session: { connectionId: string; connectionEpoch: number; deviceServiceId: string; enrollmentEpoch: number; accountEpoch: number },
  now: number): 'unavailable' | 'binding_mismatch' | 'expired' | null {
  if (!grant || !(grant.invocationId ?? grant.occurrenceId)) return 'unavailable';
  if (request.connectionId !== session.connectionId || request.connectionEpoch !== session.connectionEpoch
    || request.deviceServiceId !== session.deviceServiceId || request.enrollmentEpoch !== session.enrollmentEpoch
    || request.accountEpoch !== session.accountEpoch || request.grantId !== grant.grantId
    || request.invocationId !== (grant.invocationId ?? grant.occurrenceId) || request.connectionId !== grant.connectionId
    || request.deviceServiceId !== grant.targetDeviceServiceId || request.enrollmentEpoch !== grant.enrollmentEpoch
    || request.accountEpoch !== grant.accountEpoch || canonicalJson(request.writerEpoch) !== canonicalJson(grant.writerEpoch)) return 'binding_mismatch';
  if (request.expiresAt <= now || request.issuedAt > now + 30_000 || request.expiresAt > grant.expiresAt
    || request.expiresAt < request.issuedAt || request.expiresAt - request.issuedAt > 120_000) return 'expired';
  return null;
}
