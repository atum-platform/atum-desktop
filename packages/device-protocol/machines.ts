/**
 * The device-service state machines (`ledger`, `connection`, `enrollment`) from the pinned pack.
 * The ledger is the device's durable operation record: intent (`not_started`) is persisted before
 * a spawn and a terminal state before the receipt; a terminal state never moves again, so an
 * uncertain effect is never silently rerun. The connection exchanges statuses before any command.
 */
import { DEVICE_SERVICE_PACK } from "./contract-packs";
import type { LedgerState } from "./messages";
import { machineViolations, type MachineStep, type StateMachine, type Violation } from "./schema";

export type MachineName = "ledger" | "connection" | "enrollment";

export function stateMachine(name: MachineName): StateMachine {
  const machine = DEVICE_SERVICE_PACK.state_machines?.[name];
  if (!machine) throw new Error(`device_machine_unknown:${name}`);
  return machine;
}

/** The state an event moves `from` to, or null when the machine has no such edge. */
export function transition(name: MachineName, from: string, event: string): string | null {
  const edge = stateMachine(name).transitions.find(([source, , label]) => source === from && label === event);
  return edge ? edge[1] : null;
}

export function isTerminal(name: MachineName, state: string): boolean {
  return stateMachine(name).terminal.includes(state);
}

/** Violations of a whole sequence of steps (the pack's `*.sequence.json` fixtures). */
export function sequenceViolations(name: MachineName, steps: readonly MachineStep[]): Violation[] {
  return machineViolations(stateMachine(name), steps);
}

/** A terminal ledger state: the operation's outcome is final and is what every receipt reports. */
export const TERMINAL_LEDGER_STATES = stateMachine("ledger").terminal as readonly LedgerState[];
