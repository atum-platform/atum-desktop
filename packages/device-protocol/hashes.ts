/**
 * The device-protocol digests and signing-input bytes, all over the one `canonicalJson`
 * (`./canonical`). These match the platform `@atum/protocol` helpers and the vendored fixtures
 * byte for byte (asserted in `canonical.test.ts`). Hashing uses `node:crypto`: the module is
 * bundled into the controller (Node) and loaded in Electron main (Node).
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical";

export const DEVICE_SERVICE_SIGNING_DOMAIN = "atum.device-service.v1\0" as const;
export const ORIGIN_SIGNING_DOMAIN = "atum.origin.v1\0" as const;
/** The Megolm-encrypted `m.room.message` content key the origin assertion travels under. */
export const ORIGIN_CONTENT_KEY = "io.atum.origin" as const;

const utf8 = (text: string) => Buffer.from(text, "utf8");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const b64u = (bytes: Buffer) => bytes.toString("base64url");
const hex = (bytes: Buffer) => bytes.toString("hex");

/** A device-service message's signed bytes: `utf8(domain + type + "\0") || utf8(canonicalJson(body))`. */
export function deviceSignedBytes(type: string, body: unknown): Buffer {
  return utf8(`${DEVICE_SERVICE_SIGNING_DOMAIN}${type}\0${canonicalJson(body)}`);
}
/** `helloHash`, `commandHash`, `approvalHash`: unpadded base64url SHA-256 of the signed bytes. */
export function deviceMessageHash(type: string, body: unknown): string {
  return b64u(sha256(deviceSignedBytes(type, body)));
}
/** A key ID: unpadded base64url SHA-256 of the SPKI DER. */
export function keyId(spkiDer: Buffer | Uint8Array): string {
  return b64u(sha256(Buffer.from(spkiDer)));
}
/** `argsHash`: unpadded base64url SHA-256 of the canonical args. */
export function argsHash(args: Record<string, unknown>): string {
  return b64u(sha256(utf8(canonicalJson(args))));
}
/** `leaseTokenHash`: unpadded base64url SHA-256 of the lease token. */
export function leaseTokenHash(leaseToken: string): string {
  return b64u(sha256(utf8(leaseToken)));
}

/** The origin assertion's signing input: the domain then the canonical assertion without `sig`. */
export function originSignedBytes(assertionWithoutSig: Record<string, unknown>): Buffer {
  return utf8(`${ORIGIN_SIGNING_DOMAIN}${canonicalJson(assertionWithoutSig)}`);
}
/** `assertionHash`: unpadded base64url SHA-256 of the origin signing input. */
export function originAssertionHash(assertionWithoutSig: Record<string, unknown>): string {
  return b64u(sha256(originSignedBytes(assertionWithoutSig)));
}

/** The request-digest-v2 input: the whole content without its top-level `io.atum.origin` key. */
export function requestDigestInput(content: Record<string, unknown>): string {
  const { [ORIGIN_CONTENT_KEY]: _origin, ...rest } = content;
  return canonicalJson(rest);
}
/** `contentDigest` / `dg`: unpadded base64url SHA-256 of the digest input (version 2). */
export function requestDigestV2(content: Record<string, unknown>): string {
  return b64u(sha256(utf8(requestDigestInput(content))));
}
/** DA's `requestHash`: the same canonical bytes as 64 lowercase hex characters. */
export function requestHashV2(content: Record<string, unknown>): string {
  return hex(sha256(utf8(requestDigestInput(content))));
}
