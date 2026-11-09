// Runtime checks for the `atum.awareness/1` messages the local brain receives and sends.
// The rules are the contract pack's own (spec/_tools/contract_pack.mjs in atum-platform
// PR #404): the same schema language, the direction's forbidden fields, and the
// invariants. The contract itself is the vendored copy in contract/awareness-v1/.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'awareness-v1', 'contract.json');

export const CONTRACT = JSON.parse(readFileSync(contractPath, 'utf8'));
export const CONTRACT_ID = `${CONTRACT.contract_id}/${CONTRACT.version}`;
export const LIMITS = Object.freeze({ ...CONTRACT.limits });

const MISSING = Symbol('missing');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const same = (left, right) => canonical(left) === canonical(right);
const codePoints = (text) => [...text].length;
const patternCache = new Map();
function pattern(source) {
  let compiled = patternCache.get(source);
  if (!compiled) {
    compiled = new RegExp(`^(?:${source})$`, 'u');
    patternCache.set(source, compiled);
  }
  return compiled;
}

function check(schema, value, path, types, out) {
  if (has(schema, 'ref')) {
    check(types[schema.ref], value, path, types, out);
    return;
  }
  if (has(schema, 'anyOf')) {
    for (const option of schema.anyOf) {
      const trial = [];
      check(option, value, path, types, trial);
      if (trial.length === 0) return;
    }
    out.push(['variant', path]);
    return;
  }
  if (has(schema, 'const')) {
    if (!same(value, schema.const)) out.push(['const', path]);
    return;
  }
  if (has(schema, 'enum')) {
    if (typeof value !== 'string' || !schema.enum.includes(value)) out.push(['enum', path]);
    return;
  }
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        out.push(['type', path]);
        return;
      }
      const size = codePoints(value);
      if (size < (schema.min ?? 0) || (has(schema, 'max') && size > schema.max)) out.push(['bound', path]);
      if (has(schema, 'pattern') && !pattern(schema.pattern).test(value)) out.push(['pattern', path]);
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        out.push(['type', path]);
        return;
      }
      if ((has(schema, 'min') && value < schema.min) || (has(schema, 'max') && value > schema.max)) out.push(['bound', path]);
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') out.push(['type', path]);
      return;
    case 'null':
      if (value !== null) out.push(['type', path]);
      return;
    case 'object': {
      if (!isObject(value)) {
        out.push(['type', path]);
        return;
      }
      const required = schema.required ?? {};
      const optional = schema.optional ?? {};
      for (const [key, child] of Object.entries(required)) {
        if (!has(value, key)) out.push(['missing', `${path}.${key}`]);
        else check(child, value[key], `${path}.${key}`, types, out);
      }
      for (const [key, child] of Object.entries(optional)) {
        if (has(value, key)) check(child, value[key], `${path}.${key}`, types, out);
      }
      if (!schema.additional) {
        for (const key of Object.keys(value)) {
          if (!has(required, key) && !has(optional, key)) out.push(['unknown_field', `${path}.${key}`]);
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        out.push(['type', path]);
        return;
      }
      if (value.length < (schema.min ?? 0) || (has(schema, 'max') && value.length > schema.max)) out.push(['bound', path]);
      if (schema.unique && new Set(value.map(canonical)).size !== value.length) out.push(['unique', path]);
      value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, types, out));
      return;
    }
    default:
      throw new Error(`unknown schema type ${schema.type}`);
  }
}

function forbidden(value, names, path, out) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => forbidden(child, names, `${path}[${index}]`, out));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key)) out.push(['forbidden_field', `${path}.${key}`]);
    forbidden(child, names, `${path}.${key}`, out);
  }
}

function lookup(value, dotted) {
  let current = value;
  for (const key of dotted.split('.')) {
    if (!isObject(current) || !has(current, key)) return MISSING;
    current = current[key];
  }
  return current;
}

function invariants(rules, message, body, out) {
  for (const rule of rules) {
    if (rule.message !== message) continue;
    if (rule.when) {
      const found = lookup(body, rule.when.path);
      if (found === MISSING || !same(found, rule.when.equals)) continue;
    }
    if (rule.op === 'le' || rule.op === 'eq') {
      const left = lookup(body, rule.left);
      const rights = rule.right.map((item) => lookup(body, item));
      const values = [left, ...rights];
      if (values.some((item) => item === MISSING)) {
        if (rule.required) out.push(['invariant', rule.id]);
        continue;
      }
      if (values.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item))) {
        out.push(['invariant', rule.id]);
        continue;
      }
      const total = rights.reduce((sum, item) => sum + item, 0) + (rule.offset ?? 0);
      if ((rule.op === 'le' && left > total) || (rule.op === 'eq' && left !== total)) out.push(['invariant', rule.id]);
    } else if (rule.op === 'same') {
      const left = lookup(body, rule.left);
      const right = lookup(body, rule.right);
      if (left === MISSING || right === MISSING) {
        if (rule.required) out.push(['invariant', rule.id]);
        continue;
      }
      if (!same(left, right)) out.push(['invariant', rule.id]);
    } else if (rule.op === 'all_same') {
      const items = lookup(body, rule.left);
      const right = lookup(body, rule.right);
      if (items === MISSING || right === MISSING) continue;
      if (!Array.isArray(items)) {
        out.push(['invariant', rule.id]);
        continue;
      }
      if (items.some((item) => {
        const found = lookup(item, rule.element);
        return found === MISSING || !same(found, right);
      })) {
        out.push(['invariant', rule.id]);
      }
    } else if (rule.op === 'count_priority') {
      const state = lookup(body, rule.left);
      const counts = lookup(body, rule.right);
      if (state === MISSING || !isObject(counts)) {
        if (rule.required) out.push(['invariant', rule.id]);
        continue;
      }
      let expected = rule.empty;
      let prioritized = false;
      const ignoredCount = counts[rule.ignored] ?? 0;
      if (!Number.isSafeInteger(ignoredCount) || ignoredCount < 0) {
        out.push(['invariant', rule.id]);
        continue;
      }
      for (const candidate of rule.priority) {
        const count = counts[candidate];
        if (!Number.isSafeInteger(count) || count < 0) {
          out.push(['invariant', rule.id]);
          expected = null;
          break;
        }
        if (count > 0) {
          expected = candidate;
          prioritized = true;
          break;
        }
      }
      if (!prioritized && ignoredCount > 0) expected = rule.ignored;
      if (expected !== null && state !== expected) out.push(['invariant', rule.id]);
    } else {
      throw new Error(`unknown invariant op ${rule.op}`);
    }
  }
}

/**
 * Check one message body against its schema, its direction's forbidden fields and the
 * contract's invariants. Returns the violations as [category, path] pairs; an empty
 * list means the body conforms.
 */
export function violations(messageName, body, contract = CONTRACT) {
  const message = contract.messages[messageName];
  if (!message) throw new Error(`unknown message ${messageName}`);
  const found = [];
  check(message.schema, body, '$', contract.types, found);
  forbidden(body, new Set(contract.directions[message.direction].forbidden_fields ?? []), '$', found);
  invariants(contract.invariants ?? [], messageName, body, found);
  return found;
}

export function conforms(messageName, body, contract = CONTRACT) {
  return violations(messageName, body, contract).length === 0;
}

/** Check a sequence fixture ({steps: [{from, to, event}]}) against a state machine. */
export function machineViolations(machineName, steps, contract = CONTRACT) {
  const machine = contract.state_machines[machineName];
  if (!machine) throw new Error(`unknown machine ${machineName}`);
  if (!Array.isArray(steps) || steps.length === 0) return [['transition', 'steps']];
  const allowed = new Set(machine.transitions.map((edge) => JSON.stringify(edge)));
  const out = [];
  let previous;
  steps.forEach((step, index) => {
    const keys = isObject(step) ? Object.keys(step).sort().join(',') : '';
    if (keys !== 'event,from,to') {
      out.push(['transition', `steps[${index}]`]);
      return;
    }
    if (index === 0 && !machine.initial.includes(step.from)) out.push(['transition', `steps[${index}].from`]);
    if (previous !== undefined && step.from !== previous) out.push(['transition', `steps[${index}].from`]);
    if (!allowed.has(JSON.stringify([step.from, step.to, step.event]))) out.push(['transition', `steps[${index}]`]);
    previous = step.to;
  });
  return out;
}

export { canonical };
