import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decideEnrollment, enrollmentVerdicts } from "../enrollment";
import { assertionOf, assertionHashOf, contentDigestOf, verifyOrigin, type OriginAssertionV1, type OriginMessage } from "../origin";
import { originSignedBytes, keyId, requestDigestV2 } from "../hashes";
import { softwareP256Signer, publicKeyMaterial } from "../envelope";
import { cases } from "./fixtures";

describe("enrollment and rotation (case.enroll)", () => {
  for (const { entry, name, value } of cases("device-service", "case.enroll")) {
    it(`${entry.expect}: ${name}`, () => {
      const verdicts = enrollmentVerdicts(value.request, value.stored?.approvalKey ?? null);
      expect(verdicts).toEqual({
        identityValid: value.facts.identityValid, approvalValid: value.facts.approvalValid, previousApprovalValid: value.facts.previousApprovalValid
      });
      const decision = decideEnrollment(value);
      if (entry.expect === "accept") expect(decision).toEqual(value.expect);
      else expect(decision).not.toEqual(value.expect);
    });
  }
});

/** A conformance case's message as the controller would read it (the raw content's digest). */
function originMessage(value: any): OriginMessage {
  return {
    roomId: value.message.roomId, eventId: value.message.eventId, sender: value.message.sender, senderDevice: value.message.senderDevice,
    senderVerified: value.message.senderVerified, senderFingerprint: value.message.senderFingerprint, originServerTs: value.message.originServerTs,
    assertion: assertionOf(value.message.content), contentDigest: contentDigestOf(value.message.content)
  };
}

describe("origin assertions (origin.case)", () => {
  for (const { entry, name, value } of cases("cloud-answering", "origin.case")) {
    it(`${entry.expect}: ${name}`, () => {
      expect(contentDigestOf(value.message.content)).toBe(value.facts.contentDigest);
      const seen = value.seenNonces as { deviceServiceId: string; n: string }[];
      const decision = verifyOrigin({ message: originMessage(value), assignment: value.assignment, registry: value.registry,
        nonceSeen: (dsid, n) => seen.some((item) => item.deviceServiceId === dsid && item.n === n) });
      const { assertion: _assertion, ...comparable } = decision as typeof decision & { assertion?: unknown };
      if (entry.expect === "accept") expect(comparable).toEqual(value.expect);
      else expect(comparable).not.toEqual(value.expect);
    });
  }
});

describe("origin nonce binding", () => {
  // A fresh identity key and an assertion signed with it, so the binding is tested on real crypto.
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const material = publicKeyMaterial(publicKey);
  const sign = softwareP256Signer(privateKey);
  const owner = "@owner:atum.test", agent = "@agent:atum.test", room = "!room:atum.test";
  const content = { msgtype: "m.text", body: "Make hello.txt" };
  const unsigned: Omit<OriginAssertionV1, "sig"> = {
    v: 1, dsid: "00000000-0000-4000-8000-bd7662a5eeb4", kid: material.kid, ee: 1, ae: 1, boot: "00000000-0000-4000-8000-354570CD5E97",
    n: "AAAAAAAAAAAAAAAAAAAAAA", t: 1_791_200_000_000, owner, agent, room, dev: "MACBOOK", fpr: "f".repeat(43), dg: requestDigestV2(content)
  };
  const assertion: OriginAssertionV1 = { ...unsigned, sig: sign(originSignedBytes(unsigned)).toString("base64url") };
  const registry = [{ deviceServiceId: unsigned.dsid, identityKey: material.publicKey, identityKeyId: keyId(publicKey.export({ format: "der", type: "spki" })),
    enrollmentEpoch: 1, matrixDeviceId: "MACBOOK", matrixFingerprint: "f".repeat(43), state: "active" as const }];
  const message = (eventId: string): OriginMessage => ({ roomId: room, eventId, sender: owner, senderDevice: "MACBOOK", senderVerified: true,
    senderFingerprint: "f".repeat(43), originServerTs: unsigned.t + 1_000, assertion, contentDigest: requestDigestV2({ ...content, "io.atum.origin": assertion }) });

  it("accepts the same event again (recovery, the queued turn) but refuses the assertion on any other event", () => {
    const store = new Map<string, { roomId: string; eventId: string; assertionHash: string }>();
    const nonceSeen = (dsid: string, n: string, binding: { roomId: string; eventId: string; assertionHash: string }) => {
      const prior = store.get(`${dsid}:${n}`);
      if (!prior) {
        store.set(`${dsid}:${n}`, binding);
        return false;
      }
      return prior.roomId !== binding.roomId || prior.eventId !== binding.eventId || prior.assertionHash !== binding.assertionHash;
    };
    const first = verifyOrigin({ message: message("$event-one"), assignment: { ownerUserId: owner, agentUserId: agent }, registry, nonceSeen });
    expect(first).toMatchObject({ kind: "device", deviceServiceId: unsigned.dsid, assertionHash: assertionHashOf(assertion) });
    expect(verifyOrigin({ message: message("$event-one"), assignment: { ownerUserId: owner, agentUserId: agent }, registry, nonceSeen }).kind).toBe("device");
    expect(verifyOrigin({ message: message("$event-two"), assignment: { ownerUserId: owner, agentUserId: agent }, registry, nonceSeen }))
      .toEqual({ kind: "invalid", reason: "replayed" });
  });

  describe("a plain message from a room without encryption", () => {
    // As the controller's SDK reads it: verified by the homeserver, the stand-in device, no fingerprint.
    const plain = (eventId: string): OriginMessage => ({ ...message(eventId), senderDevice: "unencrypted", senderFingerprint: undefined, plain: true,
      wireType: "m.room.message" });
    const assignment = { ownerUserId: owner, agentUserId: agent };

    it("verifies by the registry binding, signature, digest, window and nonce, skipping only the device and fingerprint comparisons", () => {
      expect(verifyOrigin({ message: plain("$plain-one"), assignment, registry, nonceSeen: () => false }))
        .toMatchObject({ kind: "device", deviceServiceId: unsigned.dsid, assertionHash: assertionHashOf(assertion) });
    });

    it("still refuses a registry entry bound to another Matrix device or fingerprint", () => {
      expect(verifyOrigin({ message: plain("$plain-two"), assignment, registry: [{ ...registry[0]!, matrixFingerprint: "g".repeat(43) }], nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "binding_mismatch" });
    });

    it("still refuses a bad signature, a changed message and a replayed nonce", () => {
      const forged = { ...assertion, sig: sign(originSignedBytes({ ...unsigned, t: unsigned.t + 1 })).toString("base64url") };
      expect(verifyOrigin({ message: { ...plain("$plain-three"), assertion: forged }, assignment, registry, nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "bad_signature" });
      expect(verifyOrigin({ message: { ...plain("$plain-four"), contentDigest: requestDigestV2({ msgtype: "m.text", body: "other" }) }, assignment, registry, nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "digest_mismatch" });
      expect(verifyOrigin({ message: plain("$plain-five"), assignment, registry, nonceSeen: () => true })).toEqual({ kind: "invalid", reason: "replayed" });
    });

    it("refuses a plain read whose wire type disagrees, and plaintext in a room that is not plain", () => {
      // Plain by the room, but the event did not arrive as sent (or the reader said nothing).
      expect(verifyOrigin({ message: { ...plain("$mixed-one"), wireType: "m.room.encrypted" }, assignment, registry, nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "sender_unverified" });
      expect(verifyOrigin({ message: { ...plain("$mixed-two"), wireType: undefined }, assignment, registry, nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "sender_unverified" });
      // Plaintext read in a room that is not plain (its encryption not synced yet): never plain.
      expect(verifyOrigin({ message: { ...plain("$mixed-three"), plain: false }, assignment, registry, nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "sender_unverified" });
      // An encrypted read in an encrypted room keeps the full comparisons.
      expect(verifyOrigin({ message: { ...message("$enc-zero"), wireType: "m.room.encrypted" }, assignment, registry, nonceSeen: () => false }).kind)
        .toBe("device");
    });

    it("never skips the comparisons for a message that is not plain", () => {
      expect(verifyOrigin({ message: { ...plain("$enc-one"), plain: false, wireType: "m.room.encrypted", senderVerified: false }, assignment, registry,
        nonceSeen: () => false })).toEqual({ kind: "invalid", reason: "sender_unverified" });
      expect(verifyOrigin({ message: { ...plain("$enc-two"), plain: false, wireType: "m.room.encrypted" }, assignment, registry, nonceSeen: () => false }))
        .toEqual({ kind: "invalid", reason: "device_mismatch" });
      expect(verifyOrigin({ message: { ...plain("$enc-three"), plain: undefined, wireType: "m.room.encrypted", senderDevice: "MACBOOK" }, assignment,
        registry, nonceSeen: () => false })).toEqual({ kind: "invalid", reason: "fingerprint_mismatch" });
    });
  });

  it("refuses a message without the SDK's content digest", () => {
    const decision = verifyOrigin({ message: { ...message("$event-three"), contentDigest: undefined }, assignment: { ownerUserId: owner, agentUserId: agent },
      registry, nonceSeen: () => false });
    expect(decision).toEqual({ kind: "invalid", reason: "digest_mismatch" });
  });
});
