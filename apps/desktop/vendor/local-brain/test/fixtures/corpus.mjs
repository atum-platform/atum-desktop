// A small corpus for S3's proofs, built on spec/awareness/v1's fixtures: the launch
// group's message, its edit and redaction, the Drive file and the Google-derived local
// message are the contract's own; the rest are written the same way. Every envelope is
// a valid `envelope.local` with a real digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendored = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contract', 'awareness-v1', 'fixtures');
export const contractFixture = (name) => JSON.parse(readFileSync(join(vendored, `${name}.json`), 'utf8'));

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const ROOMS = {
  launch: '!synthetic-room-0001:example.invalid',
  an: '!AnDirectRmHt5Vb8Nc:example.invalid',
  finance: '!FinanceRmQq3Lk8Tt:example.invalid',
  agentA: '!AssistantRmGm8Vd2Kf:example.invalid',
  agentB: '!synthetic-room-0003:example.invalid',
  appThread: '!MoonThreadRmPw2Kc9:example.invalid',
};

export const AGENTS = {
  a: '00000000-0000-4000-8000-159badba71cd',
  b: '00000000-0000-4000-8000-631d769a2c2b',
};

export const APP = '00000000-0000-4000-8000-13e5af246c90';

export const PEOPLE = {
  owner: '@synthetic-user-0004:example.invalid',
  linh: '@synthetic-user-0005:example.invalid',
  an: '@synthetic-user-0006:example.invalid',
  cfo: '@synthetic-user-0007:example.invalid',
};

// The canaries: private facts that must never reach another room's audience.
export const CANARY_FINANCE = 'CANARY-SALARY-7731';
export const CANARY_AGENT_B = 'CANARY-RESEARCH-4419';

let counter = 0x100;
const opId = () => {
  counter += 1;
  return `0f1e2d3c-4b5a-4968-8776-${counter.toString(16).padStart(12, '0')}`;
};

export function envelope({ kind, id, agentPrincipal, object, author, eventTime, text, epoch = 1, googleDerived = false, accountFence = false, visibility = 'joined', attachments = [] }) {
  const source = { kind, id, ...(agentPrincipal ? { agentPrincipal } : {}) };
  return {
    contract: 'atum.awareness/1',
    operationId: opId(),
    source,
    object,
    author,
    eventTime,
    observedTime: eventTime + 700,
    policy: { epoch, visibility, googleDerived, accountFence },
    content: { text, attachments },
    digest: sha256(text),
  };
}

const T = 1_790_578_800_000; // 2026-09-28T07:00:00Z, the contract fixtures' clock

/** The whole corpus, in arrival order. */
export function corpus() {
  return {
    launchMessage: contractFixture('envelope-human-group-message.managed'),
    launchEdit: contractFixture('envelope-edit.managed'),
    anDecision: envelope({
      kind: 'human_dm', id: ROOMS.an,
      object: { kind: 'message', id: '$AnConfirmsEvt3cD4eF5gH6iJ7kL8mN9oP0qR1sT', revision: 1 },
      author: { kind: 'human', id: PEOPLE.an }, eventTime: T + 21_600_000,
      text: 'Chốt ngày 15/10 nhé, nhà đầu tư đồng ý rồi.',
    }),
    anOlder: envelope({
      kind: 'human_dm', id: ROOMS.an,
      object: { kind: 'message', id: '$AnOlderEvt9zY8xW7vU6tS5rQ4pO3nM2lK1jI0h', revision: 1 },
      author: { kind: 'human', id: PEOPLE.an }, eventTime: T - 86_400_000,
      text: 'Hôm qua mình bàn về ngân sách quý 4.',
    }),
    financeCanary: envelope({
      kind: 'human_group', id: ROOMS.finance,
      object: { kind: 'message', id: '$FinSalaryEvt1qW2eR3tY4uI5oP6aS7dF8gH9jK', revision: 1 },
      author: { kind: 'human', id: PEOPLE.cfo }, eventTime: T + 3_600_000,
      text: `${CANARY_FINANCE}: the launch lead's salary is 90 million VND a month.`,
    }),
    agentANote: envelope({
      kind: 'assistant_chat', id: ROOMS.agentA, agentPrincipal: AGENTS.a,
      object: { kind: 'message', id: '$AgentANoteEvt2wE3rT4yU5iO6pA7sD8fG9hJ0k', revision: 1 },
      author: { kind: 'owner', id: PEOPLE.owner }, eventTime: T + 7_200_000,
      text: 'Remind me to prepare the investor launch deck before Friday.',
    }),
    agentBCanary: envelope({
      kind: 'assistant_chat', id: ROOMS.agentB, agentPrincipal: AGENTS.b,
      object: { kind: 'message', id: '$AgentBNoteEvt3eR4tY5uI6oP7aS8dF9gH0jK1l', revision: 1 },
      author: { kind: 'owner', id: PEOPLE.owner }, eventTime: T + 7_300_000,
      text: `${CANARY_AGENT_B}: research the competitor launch pricing quietly.`,
    }),
    agentAMemory: envelope({
      kind: 'native_memory', id: 'memory-agent-a', agentPrincipal: AGENTS.a,
      object: { kind: 'memory_revision', id: 'memory-agent-a-user', revision: 3 },
      author: { kind: 'agent', id: '@synthetic-user-0010:example.invalid' }, eventTime: T + 9_000_000,
      text: 'Minh prefers launch updates in Vietnamese, short and early in the morning.', visibility: 'not_applicable',
    }),
    appExchange: envelope({
      kind: 'app_exchange', id: ROOMS.appThread,
      object: { kind: 'message', id: '$MoonReadingEvt4rT5yU6iO7pA8sD9fG0hJ1kL2', revision: 1 },
      author: { kind: 'app', id: '@moon:example.invalid' }, eventTime: T + 10_000_000,
      text: 'Your launch week reading: steady progress, avoid signing on the 13th.',
    }),
    driveFile: contractFixture('envelope-drive-file.managed'),
    // The contract's fixture reuses the group message's operation ID; a real reader
    // never reuses one, so this copy gets its own.
    googleDerived: { ...contractFixture('envelope-local-google-derived.local'), operationId: opId() },
  };
}

export function retrievalRequest(audience, query, { maxItems = 10, maxContentBytes = 16_384, filters, agentPrincipal = AGENTS.a } = {}) {
  counter += 1;
  return {
    requestId: `d4e5f6a7-b8c9-4d0e-9f1a-${counter.toString(16).padStart(12, '0')}`,
    audience,
    agentPrincipal,
    query,
    limits: { maxItems, maxContentBytes },
    ...(filters ? { filters } : {}),
  };
}

export const withdrawal = (scope, reason = 'forget', requestedAt = Date.now(), policyEpoch = 1) => ({
  operationId: opId(),
  withdrawalId: opId().replace('0f1e2d3c', '0a9b8c7d'),
  scope,
  reason,
  requestedAt,
  ...(['exclude', 'left_room', 'revoked'].includes(reason) ? { policyEpoch } : {}),
});

export { sha256 };
