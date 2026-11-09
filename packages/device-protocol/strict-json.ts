/**
 * Strict JSON for device-protocol frames — the same rules as the platform's contract checker
 * (`atum-platform` `spec/_tools/contract_pack.mjs` `parseStrict`): no duplicate keys, integers only
 * (safe range), no control characters inside strings, no trailing content, no byte order mark.
 *
 * Frames are parsed with this, never `JSON.parse`, so a duplicate key cannot make two readers
 * (the hub child that checked a frame and the parent that acts on it) see different values, and a
 * float or an unsafe integer is refused before `canonicalJson` would refuse it mid-signature.
 * Nesting is bounded so a hostile 1 MiB frame cannot exhaust the stack.
 */

export class StrictJsonError extends Error {}

export const STRICT_JSON_MAX_DEPTH = 64;

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Parse `text` strictly. Throws {@link StrictJsonError} with a closed code. */
export function parseStrictJson(text: string, maxDepth = STRICT_JSON_MAX_DEPTH): unknown {
  if (typeof text !== "string") throw new StrictJsonError("json_not_text");
  if (text.charCodeAt(0) === 0xfeff) throw new StrictJsonError("json_byte_order_mark");
  let index = 0;

  const fail = (code: string): never => {
    throw new StrictJsonError(code);
  };
  const whitespace = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
      index += 1;
    }
  };
  const literal = (word: string) => {
    if (text.startsWith(word, index)) {
      index += word.length;
      return;
    }
    fail("json_invalid");
  };
  const string = (): string => {
    if (text[index] !== '"') fail("json_invalid");
    index += 1;
    let out = "";
    let start = index;
    while (true) {
      if (index >= text.length) fail("json_unterminated_string");
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        out += text.slice(start, index);
        index += 1;
        return out;
      }
      if (code < 0x20) fail("json_control_character");
      if (code === 0x5c) {
        out += text.slice(start, index);
        const next = text[index + 1] ?? "";
        if (Object.hasOwn(SIMPLE_ESCAPES, next)) {
          out += SIMPLE_ESCAPES[next];
          index += 2;
        } else if (next === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("json_invalid_escape");
          out += String.fromCharCode(parseInt(hex, 16));
          index += 6;
        } else {
          fail("json_invalid_escape");
        }
        start = index;
        continue;
      }
      index += 1;
    }
  };
  const number = (): number => {
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(text);
    if (!match) return fail("json_invalid");
    const token = match[0];
    if (/[.eE]/.test(token)) fail("json_not_integer");
    const value = Number(token);
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("json_unsafe_integer");
    index += token.length;
    return value;
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) fail("json_too_deep");
    whitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      whitespace();
      if (text[index] === "}") {
        index += 1;
        return out;
      }
      while (true) {
        whitespace();
        const key = string();
        if (seen.has(key)) fail("json_duplicate_key");
        seen.add(key);
        whitespace();
        literal(":");
        // defineProperty: a "__proto__" key is an ordinary own property, never a prototype.
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        literal("}");
        return out;
      }
    }
    if (char === "[") {
      index += 1;
      const out: unknown[] = [];
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return out;
      }
      while (true) {
        out.push(value(depth + 1));
        whitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        literal("]");
        return out;
      }
    }
    if (char === '"') return string();
    if (char === "t") {
      literal("true");
      return true;
    }
    if (char === "f") {
      literal("false");
      return false;
    }
    if (char === "n") {
      literal("null");
      return null;
    }
    return number();
  };

  const result = value(1);
  whitespace();
  if (index !== text.length) fail("json_trailing_content");
  return result;
}
