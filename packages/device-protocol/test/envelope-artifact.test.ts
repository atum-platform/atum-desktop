import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ArtifactAssembler, artifactChunks, decodeArtifactChunk, encodeArtifactChunk, maxChunkBytes, ARTIFACT_MAX_BYTES } from "../artifact";
import {
  controllerSigner, ed25519PublicKey, p256PublicKey, publicKeyMaterial, signControllerEnvelope, signDeviceEnvelope, softwareP256Signer,
  verifyControllerEnvelope, verifyDeviceEnvelope
} from "../envelope";
import { keyId } from "../hashes";
import { isTerminal, sequenceViolations, transition } from "../machines";
import { DEVICE_HUB_MAX_PAYLOAD_BYTES, type Hello, type Renew } from "../messages";
import { parseStrictJson } from "../strict-json";
import { readFixture } from "./fixtures";

describe("envelope signatures", () => {
  it("verify the contract's signature vectors exactly", () => {
    const vectors = readFixture("device-service", "fixtures/signatures.vectors.json").vectors as any[];
    expect(vectors.length).toBeGreaterThan(0);
    for (const vector of vectors) {
      const verdict = vector.signer === "controller" ? verifyControllerEnvelope(vector.frame, vector.publicKey) : verifyDeviceEnvelope(vector.frame, vector.publicKey);
      expect(verdict, vector.name).toBe(vector.valid);
    }
  });

  it("name every published test key by the SHA-256 of its SPKI", () => {
    for (const key of readFixture("device-service", "fixtures/public-keys.json").keys as any[]) {
      expect(keyId(Buffer.from(key.publicKey, "base64url"))).toBe(key.kid);
      const parsed = key.alg === "ES256" ? p256PublicKey(key.publicKey) : ed25519PublicKey(key.publicKey);
      expect(publicKeyMaterial(parsed)).toEqual({ kid: key.kid, publicKey: key.publicKey });
    }
  });

  it("round-trips a controller frame and a device frame, and any change breaks them", async () => {
    const controller = controllerSigner(generateKeyPairSync("ed25519").privateKey);
    const renew: Renew = { grantId: "00000000-0000-4000-8000-f6222a1106ee", until: 1_791_200_015_000 };
    const signed = signControllerEnvelope(controller, "Renew", renew);
    expect(signed.kid).toBe(controller.kid);
    expect(verifyControllerEnvelope(signed, controller.publicKey)).toBe(true);
    expect(verifyControllerEnvelope({ ...signed, body: { ...renew, until: renew.until + 1 } }, controller.publicKey)).toBe(false);
    expect(verifyControllerEnvelope({ ...signed, type: "Cancel" }, controller.publicKey)).toBe(false); // domain-separated by type

    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const identity = publicKeyMaterial(publicKey);
    const hello = readFixture("device-service", "fixtures/hello.frame.json").body as Hello;
    const device = await signDeviceEnvelope(identity.kid, "Hello", hello, softwareP256Signer(privateKey));
    expect(verifyDeviceEnvelope(device, identity.publicKey)).toBe(true);
    expect(verifyDeviceEnvelope({ ...device, body: { ...hello, accountEpoch: hello.accountEpoch + 1 } }, identity.publicKey)).toBe(false);
    // A device signature never verifies as the controller's, nor the reverse.
    expect(verifyControllerEnvelope(device, controller.publicKey)).toBe(false);
    expect(verifyDeviceEnvelope(signed, identity.publicKey)).toBe(false);
  });

  it("never throws on malformed keys or signatures, and refuses non-canonical signature text", () => {
    const controller = controllerSigner(generateKeyPairSync("ed25519").privateKey);
    const signed = signControllerEnvelope(controller, "Renew", { grantId: "00000000-0000-4000-8000-f6222a1106ee", until: 1 });
    expect(verifyControllerEnvelope(signed, "not-a-key")).toBe(false);
    expect(verifyControllerEnvelope({ ...signed, sig: `${signed.sig}A` }, controller.publicKey)).toBe(false);
    expect(verifyControllerEnvelope({ ...signed, sig: signed.sig.replace(/.$/, (last) => (last === "A" ? "B" : "A")) }, controller.publicKey)).toBe(false);
    expect(verifyControllerEnvelope({ ...signed, body: { until: 1.5 } }, controller.publicKey)).toBe(false);
    expect(() => p256PublicKey(controller.publicKey)).toThrow("device_key_invalid");
    expect(() => controllerSigner(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)).toThrow("controller_key_invalid");
  });
});

describe("artifact chunks", () => {
  const commandId = "00000000-0000-4000-8000-7b7ee1efda84";
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64url");

  it("accept the contract's header and round-trip a chunk", () => {
    const header = readFixture("device-service", "fixtures/artifact-chunk.header.json");
    const bytes = Buffer.from("hello world");
    expect(header.size).toBe(bytes.length);
    expect(decodeArtifactChunk(encodeArtifactChunk(header, bytes))).toEqual({ header, bytes });
  });

  it("split a file the chat limit allows into frames that fit the payload, and reassemble only the signed bytes", () => {
    const file = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    file.write("atum", 0);
    const frames = artifactChunks(commandId, "report.pdf", file);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.length <= DEVICE_HUB_MAX_PAYLOAD_BYTES)).toBe(true);
    const assembler = new ArtifactAssembler(commandId);
    for (const frame of frames) {
      const { header, bytes } = decodeArtifactChunk(frame);
      assembler.add(header, bytes);
    }
    expect(assembler.take({ name: "report.pdf", size: file.length, sha256: sha(file) })?.equals(file)).toBe(true);
    expect(assembler.take({ name: "report.pdf", size: file.length, sha256: sha(Buffer.from("other")) })).toBeNull();
    expect(assembler.take({ name: "report.pdf", size: file.length + 1, sha256: sha(file) })).toBeNull();
    expect(assembler.take({ name: "missing.txt", size: 1, sha256: sha(Buffer.from("x")) })).toBeNull();
  });

  it("restart an artifact at offset 0 and refuse gaps, foreign commands and anything past 8 MiB", () => {
    const assembler = new ArtifactAssembler(commandId);
    assembler.add({ commandId, name: "a.txt", offset: 0, size: 3 }, Buffer.from("abc"));
    expect(() => assembler.add({ commandId, name: "a.txt", offset: 4, size: 1 }, Buffer.from("d"))).toThrow("artifact_chunk_out_of_order");
    assembler.add({ commandId, name: "a.txt", offset: 0, size: 2 }, Buffer.from("xy"));
    expect(assembler.take({ name: "a.txt", size: 2, sha256: sha(Buffer.from("xy")) })?.toString()).toBe("xy");
    expect(() => assembler.add({ commandId: "00000000-0000-4000-8000-db8055e0e030", name: "a.txt", offset: 0, size: 1 }, Buffer.from("z")))
      .toThrow("artifact_chunk_foreign");
    const big = new ArtifactAssembler(commandId);
    const size = maxChunkBytes(commandId, "big.bin");
    let offset = 0;
    expect(() => {
      while (offset <= ARTIFACT_MAX_BYTES) {
        big.add({ commandId, name: "big.bin", offset, size }, Buffer.alloc(size));
        offset += size;
      }
    }).toThrow("artifact_too_large");
    expect(big.bufferedBytes).toBeLessThanOrEqual(ARTIFACT_MAX_BYTES);
  });

  it("refuse a frame whose header is not canonical or whose bytes do not match its size", () => {
    const frame = encodeArtifactChunk({ commandId, name: "a.txt", offset: 0, size: 3 }, Buffer.from("abc"));
    expect(() => decodeArtifactChunk(Buffer.concat([frame, Buffer.from("!")]))).toThrow("artifact_chunk_invalid");
    const loose = Buffer.from(JSON.stringify({ size: 3, offset: 0, name: "a.txt", commandId }));
    const reordered = Buffer.concat([Buffer.from([0, loose.length]), loose, Buffer.from("abc")]);
    expect(() => decodeArtifactChunk(reordered)).toThrow("artifact_chunk_invalid");
    expect(() => encodeArtifactChunk({ commandId, name: "", offset: 0, size: 1 }, Buffer.from("x"))).toThrow("artifact_chunk_invalid");
    expect(() => encodeArtifactChunk({ commandId, name: "a.txt", offset: 0, size: 2 }, Buffer.from("x"))).toThrow("artifact_chunk_invalid");
    expect(() => encodeArtifactChunk({ commandId, name: "a.txt", offset: ARTIFACT_MAX_BYTES, size: 1 }, Buffer.from("x"))).toThrow("artifact_chunk_invalid");
  });
});

describe("state machines", () => {
  it("accept the contract's sequences and refuse a rerun after a terminal ledger state", () => {
    for (const file of ["ledger-completed", "ledger-refused", "ledger-crash-mid-effect", "ledger-crash-before-spawn"]) {
      expect(sequenceViolations("ledger", readFixture("device-service", `fixtures/${file}.sequence.json`).steps)).toEqual([]);
    }
    expect(sequenceViolations("ledger", readFixture("device-service", "fixtures/ledger-unknown-retried.sequence.json").steps).length).toBeGreaterThan(0);
    expect(transition("ledger", "started", "restart_or_stop_mid_effect")).toBe("unknown");
    expect(transition("ledger", "unknown", "admitted_before_spawn")).toBeNull();
    expect(isTerminal("ledger", "unknown")).toBe(true);
    expect(transition("connection", "hello_sent", "status")).toBeNull();
    expect(transition("connection", "ready", "status")).toBe("status_exchanged");
  });
});

describe("strict JSON", () => {
  it("parses ordinary JSON like JSON.parse", () => {
    const text = '{"a":[1,-2,"x\\u00e9\\n",true,false,null],"b":{"c":{}}}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it("refuses duplicate keys, non-integers, unsafe integers, control characters, trailing content and deep nesting", () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow("json_duplicate_key");
    expect(() => parseStrictJson("1.0")).toThrow("json_not_integer");
    expect(() => parseStrictJson("1e3")).toThrow("json_not_integer");
    expect(() => parseStrictJson("9007199254740993")).toThrow("json_unsafe_integer");
    expect(() => parseStrictJson('"a\u0001"')).toThrow("json_control_character");
    expect(() => parseStrictJson("{} x")).toThrow("json_trailing_content");
    expect(() => parseStrictJson("﻿{}")).toThrow("json_byte_order_mark");
    expect(() => parseStrictJson(`${"[".repeat(100)}${"]".repeat(100)}`)).toThrow("json_too_deep");
  });

  it("keeps a __proto__ key as plain data", () => {
    const value = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});
