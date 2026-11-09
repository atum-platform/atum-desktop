// Atum's durable records for one local brain, kept apart from GBrain's datastore so a
// restored or rebuilt index can never roll them back: ingestion receipts, withdrawals
// and their suppression IDs, corrections, source policy epochs and the sticky Google
// fence. It holds no message text: only identifiers, times, digests and policy.
//
// An append-only JSON-lines file. Every line carries its sequence number and the SHA-256
// of the line before it, and is fsynced before the caller is answered, so an
// acknowledged record survives a crash and a damaged middle line is detected. A torn
// last line (a crash mid-write, never acknowledged) is dropped on load.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';

export const LEDGER_FORMAT = 'atum.local-brain.ledger/1';

export class LedgerCorrupt extends Error {
  constructor(message) {
    super(message);
    this.code = 'ledger_corrupt';
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class Ledger {
  #path;
  #fd = null;
  #lastHash = 'genesis';
  #seq = 0;
  #apply;

  /** `apply(record)` folds each record, on load and on append, into the caller's state. */
  constructor(path, apply) {
    this.#path = path;
    this.#apply = apply;
  }

  get seq() {
    return this.#seq;
  }

  get path() {
    return this.#path;
  }

  open({ now = Date.now } = {}) {
    const fresh = !existsSync(this.#path);
    // O_APPEND: every write lands at the end, whatever the file offset.
    this.#fd = openSync(this.#path, fresh ? 'ax+' : 'a+', 0o600);
    if (fresh) {
      this.append({ type: 'genesis', format: LEDGER_FORMAT, contract: 'atum.awareness/1' }, { now });
      return { records: 1, dropped: 0 };
    }
    const raw = readFileSync(this.#path, 'utf8');
    const end = raw.lastIndexOf('\n') + 1;
    let dropped = 0;
    if (end !== raw.length) {
      dropped = 1; // torn tail: written but never acknowledged
      ftruncateSync(this.#fd, Buffer.byteLength(raw.slice(0, end)));
      fsyncSync(this.#fd);
    }
    const lines = raw.slice(0, end).split('\n').filter(Boolean);
    let prev = 'genesis';
    lines.forEach((line, index) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new LedgerCorrupt(`line ${index + 1} is not JSON`);
      }
      if (record.seq !== index + 1) throw new LedgerCorrupt(`line ${index + 1} has sequence ${record.seq}`);
      if (record.prev !== prev) throw new LedgerCorrupt(`line ${index + 1} does not follow line ${index}`);
      if (index === 0 && (record.type !== 'genesis' || record.format !== LEDGER_FORMAT)) {
        throw new LedgerCorrupt('the first line is not this format\'s genesis record');
      }
      this.#apply(record, { replay: true });
      prev = sha256(line);
    });
    this.#seq = lines.length;
    this.#lastHash = prev;
    if (this.#seq === 0) throw new LedgerCorrupt('the ledger is empty');
    return { records: lines.length, dropped };
  }

  /** Append, fsync, then fold into state. Returns the stored record. */
  append(record, { now = Date.now } = {}) {
    if (this.#fd === null) throw new Error('ledger is not open');
    const stored = { seq: this.#seq + 1, prev: this.#lastHash, at: now(), ...record };
    const line = JSON.stringify(stored);
    writeSync(this.#fd, `${line}\n`, null, 'utf8');
    fsyncSync(this.#fd);
    this.#seq = stored.seq;
    this.#lastHash = sha256(line);
    this.#apply(stored, { replay: false });
    return stored;
  }

  close() {
    if (this.#fd !== null) closeSync(this.#fd);
    this.#fd = null;
  }
}

/**
 * True when `candidate` (lines of another ledger) is a prefix of this file's lines: a
 * backup's ledger is always a prefix of the live one unless they diverged.
 */
export function isPrefixLedger(prefixText, fullText) {
  const a = prefixText.split('\n').filter(Boolean);
  const b = fullText.split('\n').filter(Boolean);
  if (a.length > b.length) return false;
  return a.every((line, index) => line === b[index]);
}
