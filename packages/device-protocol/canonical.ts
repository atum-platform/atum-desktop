/**
 * Canonical JSON for the Atum device protocol — a byte-for-byte port of the platform
 * `canonicalJson` (`atum-platform` `packages/protocol/src/host-fs.ts`): NFC-normalized strings and
 * keys, keys sorted by UTF-16 code unit, no whitespace, safe-integer numerics only, and lone
 * surrogates rejected. `canonical.test.ts` asserts this produces identical output to the vendored
 * platform fixtures, so the device's digests and signatures match the controller's exactly.
 *
 * Every device-protocol digest (`contentDigest`, `requestHash`, the device message hashes, `dg`)
 * routes through this one function. Do not "improve" it independently of the platform source —
 * any divergence silently breaks cross-repo signature verification.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function requireUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("JSON strings must contain Unicode scalar values");
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JSON strings must contain Unicode scalar values");
    }
  }
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") {
      requireUnicodeScalarString(value);
      return value.normalize("NFC");
    }
    return value as null | boolean;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical JSON permits safe integers only");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value !== "object") throw new TypeError("value is not JSON");
  const result: Record<string, JsonValue> = {};
  for (const [rawKey, entry] of Object.entries(value as Record<string, unknown>)) {
    requireUnicodeScalarString(rawKey);
    const key = rawKey.normalize("NFC");
    if (Object.hasOwn(result, key)) throw new TypeError("keys collide after NFC normalization");
    result[key] = normalizeJson(entry);
  }
  return result;
}

function encodeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key]!)}`).join(",")}}`;
}

/** The one wire representation: NFC, sorted keys, no whitespace, safe-integer numerics. */
export function canonicalJson(value: unknown): string {
  return encodeCanonical(normalizeJson(value));
}
