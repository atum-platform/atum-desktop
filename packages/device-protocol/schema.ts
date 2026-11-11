/**
 * The contract-pack schema language, interpreted at run time — the same semantics as the
 * platform's reference checker (`atum-platform` `spec/_tools/contract_pack.mjs`): `check` for
 * shapes, `forbidden` for a direction's forbidden field names anywhere in the value, `invariants`
 * for the pack's cross-field rules, and `machineViolations` for state machine sequences.
 *
 * The device protocol validates every frame against the vendored, pinned `contract.json`
 * (`./contract-packs`) through this module, so the runtime validators and the conformance
 * fixtures can never drift apart: a re-vendored pack changes both at once, and
 * `canonical.test.ts` proves the vendored copy is byte-identical to the platform pack.
 */

export type ViolationCategory =
  | "type" | "missing" | "unknown_field" | "enum" | "const" | "bound" | "pattern"
  | "unique" | "variant" | "forbidden_field" | "invariant" | "transition";

export interface Violation {
  category: ViolationCategory;
  /** `$.body.args` style for shapes; the invariant's ID for invariants. */
  path: string;
}

export interface SchemaNode {
  ref?: string;
  anyOf?: SchemaNode[];
  const?: unknown;
  enum?: string[];
  type?: "string" | "integer" | "boolean" | "null" | "object" | "array";
  min?: number;
  max?: number;
  pattern?: string;
  notValues?: unknown[];
  normalization?: 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
  required?: Record<string, SchemaNode>;
  optional?: Record<string, SchemaNode>;
  additional?: boolean | SchemaNode;
  additionalKeys?: SchemaNode;
  minProperties?: number;
  maxProperties?: number;
  maxEncodedBytes?: number;
  items?: SchemaNode;
  /** Per-index schemas for the leading elements, as the platform's reference checker applies them. */
  prefixItems?: SchemaNode[];
  unique?: boolean;
}

export interface InvariantRule {
  id: string;
  message: string;
  op: string;
  left?: string;
  right?: string | string[];
  required?: boolean;
  offset?: number;
  when?: { path: string; equals: unknown };
  element?: string;
  priority?: string[];
  ignored?: string;
  empty?: string;
  admitted?: string;
  cursors?: string;
  bindings?: string;
  source?: string;
  binding?: string;
  admittedDigest?: string;
  settlementDigest?: string;
  outcomes?: string;
  deltas?: string;
  outcomeSource?: string;
  outcomeBinding?: string;
  outcomeStatus?: string;
  legacy?: string;
  mapping?: Record<string, string>;
}

export interface StateMachine {
  states: string[];
  initial: string[];
  terminal: string[];
  transitions: [string, string, string][];
}

/** The parts of a contract pack the runtime uses. */
export interface ContractPack {
  contract_id: string;
  version: number;
  types: Record<string, SchemaNode>;
  messages: Record<string, { direction: string; schema: SchemaNode }>;
  directions: Record<string, { forbidden_fields?: string[] }>;
  invariants?: InvariantRule[];
  state_machines?: Record<string, StateMachine>;
  parameters?: Record<string, number>;
}

const MISSING = Symbol("missing");
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** Sorted-key JSON for equality, as the reference checker compares values. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export const sameJson = (left: unknown, right: unknown) => canonical(left) === canonical(right);

const patterns = new Map<string, RegExp>();
function anchored(pattern: string): RegExp {
  let compiled = patterns.get(pattern);
  if (!compiled) {
    compiled = new RegExp(`^(?:${pattern})$`, "u");
    patterns.set(pattern, compiled);
  }
  return compiled;
}
const codePoints = (text: string) => {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
};

/** Shape violations of `value` against `schema`, appended to `out`. */
export function check(schema: SchemaNode, value: unknown, path: string, types: Record<string, SchemaNode>, out: Violation[]): void {
  if (schema.ref !== undefined) {
    const target = types[schema.ref];
    if (!target) throw new Error(`schema_unknown_type:${schema.ref}`);
    check(target, value, path, types, out);
    return;
  }
  if (schema.anyOf !== undefined) {
    for (const option of schema.anyOf) {
      const trial: Violation[] = [];
      check(option, value, path, types, trial);
      if (trial.length === 0) return;
    }
    out.push({ category: "variant", path });
    return;
  }
  if (has(schema, "const")) {
    if (!sameJson(value, schema.const)) out.push({ category: "const", path });
    return;
  }
  if (schema.enum !== undefined) {
    if (typeof value !== "string" || !schema.enum.includes(value)) out.push({ category: "enum", path });
    return;
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        out.push({ category: "type", path });
        return;
      }
      const size = codePoints(value);
      if (size < (schema.min ?? 0) || (schema.max !== undefined && size > schema.max)) out.push({ category: "bound", path });
      if (schema.notValues?.some(item => sameJson(item, value))) out.push({ category: "enum", path });
      if (schema.pattern !== undefined && !anchored(schema.pattern).test(value)) out.push({ category: "pattern", path });
      if (schema.normalization !== undefined && value.normalize(schema.normalization) !== value) {
        out.push({ category: "pattern", path });
      }
      return;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        out.push({ category: "type", path });
        return;
      }
      if ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)) out.push({ category: "bound", path });
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") out.push({ category: "type", path });
      return;
    case "null":
      if (value !== null) out.push({ category: "type", path });
      return;
    case "object": {
      if (!isObject(value)) {
        out.push({ category: "type", path });
        return;
      }
      const propertyCount = Object.keys(value).length;
      if ((schema.minProperties !== undefined && propertyCount < schema.minProperties) ||
          (schema.maxProperties !== undefined && propertyCount > schema.maxProperties) ||
          (schema.maxEncodedBytes !== undefined && Buffer.byteLength(canonical(value), "utf8") > schema.maxEncodedBytes)) {
        out.push({ category: "bound", path });
      }
      const required = schema.required ?? {};
      const optional = schema.optional ?? {};
      for (const [key, child] of Object.entries(required)) {
        if (!has(value, key)) out.push({ category: "missing", path: `${path}.${key}` });
        else check(child, value[key], `${path}.${key}`, types, out);
      }
      for (const [key, child] of Object.entries(optional)) {
        if (has(value, key)) check(child, value[key], `${path}.${key}`, types, out);
      }
      if (!schema.additional) {
        for (const key of Object.keys(value)) {
          if (!has(required, key) && !has(optional, key)) out.push({ category: "unknown_field", path: `${path}.${key}` });
        }
      } else if (isObject(schema.additional)) {
        for (const key of Object.keys(value)) {
          if (has(required, key) || has(optional, key)) continue;
          if (schema.additionalKeys) check(schema.additionalKeys, key, `${path}.${key}#key`, types, out);
          check(schema.additional, value[key], `${path}.${key}`, types, out);
        }
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        out.push({ category: "type", path });
        return;
      }
      if (value.length < (schema.min ?? 0) || (schema.max !== undefined && value.length > schema.max)) out.push({ category: "bound", path });
      if (schema.maxEncodedBytes !== undefined && Buffer.byteLength(canonical(value), "utf8") > schema.maxEncodedBytes) {
        out.push({ category: "bound", path });
      }
      if (schema.unique && new Set(value.map(canonical)).size !== value.length) out.push({ category: "unique", path });
      if (schema.prefixItems) value.forEach((item, index) => {
        if (index >= schema.prefixItems!.length) out.push({ category: "bound", path: `${path}[${index}]` });
        else check(schema.prefixItems![index]!, item, `${path}[${index}]`, types, out);
      });
      else if (schema.items) value.forEach((item, index) => check(schema.items!, item, `${path}[${index}]`, types, out));
      return;
    }
    default:
      throw new Error(`schema_unknown_kind:${String(schema.type)}`);
  }
}

/** A direction's forbidden field names, anywhere in `value`. */
export function forbidden(value: unknown, names: ReadonlySet<string>, path: string, out: Violation[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => forbidden(child, names, `${path}[${index}]`, out));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) || [...names].some(name => name.includes('*') &&
      new RegExp(`^${name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'isu').test(key))) {
      out.push({ category: "forbidden_field", path: `${path}.${key}` });
    }
    forbidden(child, names, `${path}.${key}`, out);
  }
}

function lookup(value: unknown, dotted: string | readonly string[]): unknown {
  let current: unknown = value;
  // Array paths preserve literal Matrix keys such as io.atum.files.
  for (const key of typeof dotted === "string" ? dotted.split(".") : dotted) {
    if (!isObject(current) || !has(current, key)) return MISSING;
    current = current[key];
  }
  return current;
}

/** The pack's invariants for `message`, evaluated over `body`. */
export function invariants(rules: readonly InvariantRule[], message: string, body: unknown, out: Violation[]): void {
  for (const rule of rules) {
    if (rule.message !== message) continue;
    if (rule.when) {
      const found = lookup(body, rule.when.path);
      if (found === MISSING || !sameJson(found, rule.when.equals)) continue;
    }
    if (rule.op === "le" || rule.op === "eq") {
      const left = lookup(body, rule.left!);
      const rights = (rule.right as string[]).map((item) => lookup(body, item));
      const values = [left, ...rights];
      if (values.some((item) => item === MISSING)) {
        if (rule.required) out.push({ category: "invariant", path: rule.id });
        continue;
      }
      if (values.some((item) => typeof item !== "number" || !Number.isSafeInteger(item))) {
        out.push({ category: "invariant", path: rule.id });
        continue;
      }
      const total = (rights as number[]).reduce((sum, item) => sum + item, 0) + (rule.offset ?? 0);
      if ((rule.op === "le" && (left as number) > total) || (rule.op === "eq" && left !== total)) out.push({ category: "invariant", path: rule.id });
    } else if (rule.op === "same") {
      const left = lookup(body, rule.left!);
      const right = lookup(body, rule.right as string);
      if (left === MISSING || right === MISSING) {
        if (rule.required) out.push({ category: "invariant", path: rule.id });
        continue;
      }
      if (!sameJson(left, right)) out.push({ category: "invariant", path: rule.id });
    } else if (rule.op === "count_priority") {
      const state = lookup(body, rule.left!);
      const counts = lookup(body, rule.right as string);
      if (state === MISSING || counts === MISSING) {
        if (rule.required) out.push({ category: "invariant", path: rule.id });
        continue;
      }
      const names = [...(rule.priority ?? []), rule.ignored ?? ""];
      if (!isObject(counts) || Object.keys(counts).length !== names.length ||
          names.some((name) => !has(counts, name) || !Number.isSafeInteger(counts[name]) || (counts[name] as number) < 0)) {
        out.push({ category: "invariant", path: rule.id });
        continue;
      }
      const expected = (rule.priority ?? []).find((name) => (counts[name] as number) > 0) ??
        ((counts[rule.ignored ?? ""] as number) > 0 ? rule.ignored : rule.empty);
      if (!sameJson(state, expected)) out.push({ category: "invariant", path: rule.id });
    } else if (rule.op === "all_same") {
      const items = lookup(body, rule.left!);
      const right = lookup(body, rule.right as string);
      if (items === MISSING || right === MISSING) continue;
      if (!Array.isArray(items)) {
        out.push({ category: "invariant", path: rule.id });
        continue;
      }
      if (items.some((item) => {
        const found = lookup(item, rule.element ?? "");
        return found === MISSING || !sameJson(found, right);
      })) out.push({ category: "invariant", path: rule.id });
    } else if (rule.op === "sorted_unique") {
      const items = lookup(body, rule.left!);
      if (items === MISSING) {
        if (rule.required) out.push({ category: "invariant", path: rule.id });
        continue;
      }
      if (!Array.isArray(items)) {
        out.push({ category: "invariant", path: rule.id });
        continue;
      }
      const values = rule.element !== undefined ? items.map(item => lookup(item, rule.element!)) : items;
      if (values.some(value => typeof value !== "string") || new Set(values).size !== values.length ||
          values.some((value, index) => index > 0 && Buffer.compare(
            Buffer.from(values[index - 1] as string, "utf8"), Buffer.from(value as string, "utf8")) >= 0)) {
        out.push({ category: "invariant", path: rule.id });
      }
    } else if (rule.op === "agent_sweep_v2_claim_bindings") {
      if (lookup(body, "decision") !== "claimed") continue;
      const admitted = lookup(body, rule.admitted!);
      const cursors = lookup(body, rule.cursors!);
      const bindings = lookup(body, rule.bindings!);
      let valid = Array.isArray(admitted) && isObject(cursors) && isObject(bindings);
      if (valid) {
        const cursorKeys = Object.keys(cursors as Record<string, unknown>);
        const bindingKeys = Object.keys(bindings as Record<string, unknown>);
        const byId = new Map((admitted as unknown[]).map(item =>
          [lookup(item, rule.source!), lookup(item, rule.binding!)]));
        valid = cursorKeys.length === bindingKeys.length && cursorKeys.every(id =>
          has(bindings as object, id) && byId.has(id) &&
          sameJson((bindings as Record<string, unknown>)[id], byId.get(id)));
      }
      if (!valid) out.push({ category: "invariant", path: rule.id });
    } else if (rule.op === "agent_sweep_v2_settlement_admission") {
      const admitted = lookup(body, rule.admitted!);
      const admittedDigest = lookup(body, rule.admittedDigest!);
      const settlementDigest = lookup(body, rule.settlementDigest!);
      const outcomes = lookup(body, rule.outcomes!);
      const deltas = lookup(body, rule.deltas!);
      let valid = Array.isArray(admitted) && Array.isArray(outcomes) && isObject(deltas) &&
        sameJson(admittedDigest, settlementDigest);
      if (valid) {
        const byId = new Map((admitted as unknown[]).map(item =>
          [lookup(item, rule.source!), lookup(item, rule.binding!)]));
        const outcomeById = new Map((outcomes as unknown[]).map(item =>
          [lookup(item, rule.outcomeSource!), item]));
        valid = (outcomes as unknown[]).every(item => {
          const id = lookup(item, rule.outcomeSource!);
          return typeof id === "string" && byId.has(id) &&
            sameJson(lookup(item, rule.outcomeBinding!), byId.get(id));
        }) && Object.keys(deltas as Record<string, unknown>).every(id => {
          const outcome = outcomeById.get(id);
          const status = outcome === undefined ? MISSING : lookup(outcome, rule.outcomeStatus!);
          return byId.has(id) && (status === "ok" || status === "partial");
        });
      }
      if (!valid) out.push({ category: "invariant", path: rule.id });
    } else if (rule.op === "legacy_five_key_projection") {
      const cursors = lookup(body, rule.cursors!);
      const legacy = lookup(body, rule.legacy!);
      const mapping = rule.mapping ?? {};
      let valid = isObject(cursors) && isObject(legacy) &&
        Object.keys(legacy as Record<string, unknown>).length === Object.keys(mapping).length;
      if (valid) {
        valid = Object.entries(mapping).every(([legacyKey, sourceKey]) =>
          has(legacy as object, legacyKey) && sameJson((legacy as Record<string, unknown>)[legacyKey],
            has(cursors as object, sourceKey) ? (cursors as Record<string, unknown>)[sourceKey] : null));
      }
      if (!valid) out.push({ category: "invariant", path: rule.id });
    } else {
      throw new Error(`schema_unknown_invariant:${String((rule as InvariantRule).op)}`);
    }
  }
}

export interface MachineStep {
  from: string;
  to: string;
  event: string;
}

/** Transition violations of a sequence of steps through `machine`. */
export function machineViolations(machine: StateMachine, steps: unknown): Violation[] {
  if (!Array.isArray(steps) || steps.length === 0) return [{ category: "transition", path: "steps" }];
  const allowed = new Set(machine.transitions.map((edge) => JSON.stringify(edge)));
  const out: Violation[] = [];
  let previous: string | undefined;
  steps.forEach((step: unknown, index) => {
    const keys = isObject(step) ? Object.keys(step).sort().join(",") : "";
    if (keys !== "event,from,to") {
      out.push({ category: "transition", path: `steps[${index}]` });
      return;
    }
    const { from, to, event } = step as unknown as MachineStep;
    if (index === 0 && !machine.initial.includes(from)) out.push({ category: "transition", path: `steps[${index}].from` });
    if (previous !== undefined && from !== previous) out.push({ category: "transition", path: `steps[${index}].from` });
    if (!allowed.has(JSON.stringify([from, to, event]))) out.push({ category: "transition", path: `steps[${index}]` });
    previous = to;
  });
  return out;
}

/** Every violation of `value` as the pack's message `name`: shape, forbidden fields, invariants. */
export function messageViolations(pack: ContractPack, name: string, value: unknown): Violation[] {
  const message = pack.messages[name];
  if (!message) throw new Error(`schema_unknown_message:${name}`);
  const out: Violation[] = [];
  check(message.schema, value, "$", pack.types, out);
  forbidden(value, new Set(pack.directions[message.direction]?.forbidden_fields ?? []), "$", out);
  invariants(pack.invariants ?? [], name, value, out);
  return out;
}

/** Shape violations of `value` against the pack's named type (no direction, no invariants). */
export function typeViolations(pack: ContractPack, type: string, value: unknown): Violation[] {
  const out: Violation[] = [];
  check({ ref: type }, value, "$", pack.types, out);
  return out;
}
