export interface MatrixCompanyPrivateCosRoomPlan {
  schemaVersion: 1
  attemptId: string
  companyId: string
  membershipIncarnation: string
  executorId: string
  state: 'create' | 'bound' | 'ready'
  roomId: string | null
  roomName: 'Chief of Staff'
  manager: {executorId: string; userId: string; assignmentEpoch: number}
  participants: [{role: 'member'; userId: string}, {role: 'agent'; userId: string}]
  roomType: 'io.atum.assistant'
  roomVersion: '11'
  classification: 'company_private_cos'
  preset: 'private_chat'
  direct: true
  encrypted: false
  historyVisibility: 'joined'
  joinRule: 'invite'
  guestAccess: 'forbidden'
  managerPower: 100
  participantPower: 0
  invitePower: 100
  managerLeaves: true
  /** Round-6 exact Matrix power_levels content; passed through verbatim. */
  powerLevels: {
    users: Record<string, 0 | 100>; users_default: 0; events_default: 0; state_default: 100
    invite: 100; kick: 100; ban: 100; redact: 100; events: Record<string, 100>
  }
  marker: {type: 'io.atum.company_private_cos'; stateKey: ''; content: {v: 1;
    classification: 'company_private_cos'; companyId: string; membershipIncarnation: string; executorId: string;
    attemptId:string}}
}

export type MatrixCompanyPrivateCosRoomCommand =
  {kind: 'createCompanyPrivateCosRoom'; plan: MatrixCompanyPrivateCosRoomPlan}
  | {kind:'findCompanyPrivateCosRoom';plan:MatrixCompanyPrivateCosRoomPlan}
  | {kind:'finishCompanyPrivateCosRoom';plan:MatrixCompanyPrivateCosRoomPlan;roomId:string}
