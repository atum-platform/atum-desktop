/** Exact controller-only check. No work/funding authority is consumed. */
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).sort().join(",") === keys.sort().join(",");

export function validPresentationCleanup(v: unknown): boolean {
  if (!object(v) || !exact(v, ["schemaVersion", "companyId", "agentPrincipal", "audience",
    "roomId", "threadRootEventId", "triggerEventId", "taskId", "invocationId",
    "disclosureEpoch", "leaseToken", "leaseGeneration"]) || v.schemaVersion !== 1) {return false;}

  if (![v.companyId, v.agentPrincipal, v.taskId, v.invocationId]
    .every(x => typeof x === "string" && UUID.test(x))) {return false;}

  if (![v.threadRootEventId, v.triggerEventId].every(x => typeof x === "string"
    && /^\$[!-~]+$/u.test(x) && x.length <= 512)
    || typeof v.roomId !== "string" || !/^![!-9;-~]{1,255}:[!-~]{1,255}$/u.test(v.roomId)
    || typeof v.leaseToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(v.leaseToken)
    || ![v.disclosureEpoch, v.leaseGeneration].every(x => Number.isSafeInteger(x) && Number(x) >= 1)) {return false;}

  const a = v.audience;

  if (!object(a)) {return false;}

  return a.kind === "channel"
    ? exact(a, ["kind", "channelId"]) && typeof a.channelId === "string" && UUID.test(a.channelId)
    : a.kind === "private" && exact(a, ["kind", "memberPrincipal", "membershipIncarnation"])
      && [a.memberPrincipal, a.membershipIncarnation].every(x => typeof x === "string" && UUID.test(x));
}
