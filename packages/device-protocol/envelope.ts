/**
 * Signing and verifying device-service envelopes (`atum.device-service/1`):
 *
 * - the controller signs with **Ed25519** (pure, 64 bytes, unpadded base64url);
 * - a device signs **ES256** (P-256, SHA-256) as IEEE P1363 `r||s` through its Secure Enclave
 *   keys; the verifier here never needs the private half;
 * - the signed bytes are `utf8("atum.device-service.v1\0" + type + "\0") || utf8(canonicalJson(body))`
 *   (`deviceSignedBytes`), and a key ID is the unpadded base64url SHA-256 of the SPKI DER.
 *
 * Verification never throws: a malformed key or signature simply does not verify.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

import { deviceSignedBytes, keyId, originSignedBytes } from "./hashes";
import type { B64u, DeviceMessageType, Envelope, KeyId, MessageBodies } from "./messages";

const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A P-256 public key from its unpadded base64url SPKI DER (91 bytes, uncompressed point). */
export function p256PublicKey(spki: B64u): KeyObject {
  const der = Buffer.from(spki, "base64url");
  if (der.length !== 91 || !der.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX) || der[P256_SPKI_PREFIX.length] !== 0x04) {
    throw new Error("device_key_invalid");
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("device_key_invalid");
  return key;
}

/** An Ed25519 public key from its unpadded base64url SPKI DER (44 bytes). */
export function ed25519PublicKey(spki: B64u): KeyObject {
  const der = Buffer.from(spki, "base64url");
  if (der.length !== 44 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) throw new Error("controller_key_invalid");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("controller_key_invalid");
  return key;
}

/** `{kid, publicKey}` of a public (or private) key: the SPKI DER as unpadded base64url. */
export function publicKeyMaterial(key: KeyObject): { kid: KeyId; publicKey: B64u } {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ format: "der", type: "spki" });
  return { kid: keyId(der), publicKey: der.toString("base64url") };
}

/** The controller's signer: an Ed25519 private key and its key ID. */
export interface ControllerSigner {
  readonly kid: KeyId;
  readonly publicKey: B64u;
  sign(bytes: Buffer): Buffer;
}

/** An Ed25519 controller signer over a private key (PKCS#8 PEM/DER, or a KeyObject). */
export function controllerSigner(privateKey: KeyObject | string | Buffer): ControllerSigner {
  const key = typeof privateKey === "string" || Buffer.isBuffer(privateKey)
    ? createPrivateKey(Buffer.isBuffer(privateKey) && privateKey[0] === 0x30 ? { key: privateKey, format: "der", type: "pkcs8" } : privateKey)
    : privateKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("controller_key_invalid");
  const material = publicKeyMaterial(key);
  return { kid: material.kid, publicKey: material.publicKey, sign: (bytes: Buffer) => sign(null, bytes, key) };
}

/** A controller-signed envelope of `type` over `body`. */
export function signControllerEnvelope<T extends DeviceMessageType>(signer: ControllerSigner, type: T, body: MessageBodies[T]): Envelope<T, MessageBodies[T]> {
  return { v: 1, type, body, kid: signer.kid, sig: signer.sign(deviceSignedBytes(type, body)).toString("base64url") };
}

/**
 * A device-signed envelope whose signature comes from `signRaw` (the Secure Enclave helper, or a
 * software P-256 key in tests). `signRaw` returns the 64-byte IEEE P1363 `r||s` over the bytes.
 */
export async function signDeviceEnvelope<T extends DeviceMessageType>(
  kid: KeyId, type: T, body: MessageBodies[T], signRaw: (bytes: Buffer) => Promise<Uint8Array> | Uint8Array
): Promise<Envelope<T, MessageBodies[T]>> {
  const raw = Buffer.from(await signRaw(deviceSignedBytes(type, body)));
  if (raw.length !== 64) throw new Error("device_signature_invalid");
  return { v: 1, type, body, kid, sig: raw.toString("base64url") };
}

/** A software P-256 signer (`r||s`), for tests and tools; the shipped device uses the Secure Enclave. */
export function softwareP256Signer(privateKey: KeyObject): (bytes: Buffer) => Buffer {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("device_key_invalid");
  return (bytes: Buffer) => sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
}

function rawSignature(sig: unknown, length: number): Buffer | null {
  if (typeof sig !== "string" || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const raw = Buffer.from(sig, "base64url");
  return raw.length === length && raw.toString("base64url") === sig ? raw : null;
}

/** ES256 (IEEE P1363) over `bytes` by the P-256 key `spki`. */
export function verifyEs256(spki: B64u | KeyObject, bytes: Buffer, sig: string): boolean {
  try {
    const raw = rawSignature(sig, 64);
    if (!raw) return false;
    const key = typeof spki === "string" ? p256PublicKey(spki) : spki;
    return verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, raw);
  } catch {
    return false;
  }
}

/** Ed25519 over `bytes` by the controller key `spki`. */
export function verifyEd25519(spki: B64u | KeyObject, bytes: Buffer, sig: string): boolean {
  try {
    const raw = rawSignature(sig, 64);
    if (!raw) return false;
    const key = typeof spki === "string" ? ed25519PublicKey(spki) : spki;
    return verify(null, bytes, key, raw);
  } catch {
    return false;
  }
}

/** A device envelope's signature by the P-256 key `spki` (the caller has matched `kid` to it). */
export function verifyDeviceEnvelope(envelope: Pick<Envelope, "type" | "body" | "sig">, spki: B64u | KeyObject): boolean {
  try {
    return verifyEs256(spki, deviceSignedBytes(envelope.type, envelope.body), envelope.sig);
  } catch {
    return false; // canonicalJson refuses a body (unsafe number, lone surrogate): nothing verifies.
  }
}

/** A controller envelope's signature by the Ed25519 key `spki` (the caller has matched `kid`). */
export function verifyControllerEnvelope(envelope: Pick<Envelope, "type" | "body" | "sig">, spki: B64u | KeyObject): boolean {
  try {
    return verifyEd25519(spki, deviceSignedBytes(envelope.type, envelope.body), envelope.sig);
  } catch {
    return false;
  }
}

/** An origin assertion's ES256 signature (`atum.origin.v1\0` domain) by the identity key `spki`. */
export function verifyOriginSignature(assertion: Record<string, unknown>, spki: B64u | KeyObject): boolean {
  try {
    const { sig, ...rest } = assertion;
    return typeof sig === "string" && verifyEs256(spki, originSignedBytes(rest), sig);
  } catch {
    return false;
  }
}
