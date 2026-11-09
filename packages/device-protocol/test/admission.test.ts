import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { admitExecute, admitGrant, applyRenew, applyRevoke, controllerFrameFacts, verifyApproval, type DeviceAdmissionState, type DeviceGrantState } from "../admission";
import { controllerSigner, signControllerEnvelope } from "../envelope";
import { argsHash, deviceMessageHash } from "../hashes";
import { deviceServiceViolations, type Execute, type TurnGrant } from "../messages";
import { cases } from "./fixtures";

// The device's own decisions, run on every admission vector the contract carries: an accepted
// vector's expectation is what the function decides, and its recorded facts (signature, pin,
// hashes) are what real crypto computes; a rejected vector (an expectation that breaks an
// invariant) is never what the function decides.

const PACK = "device-service";

describe("TurnGrant admission (case.grant)", () => {
  for (const { entry, name, value } of cases(PACK, "case.grant")) {
    it(`${entry.expect}: ${name}`, () => {
      const decision = admitGrant(value.device, value.originLog, value.grant);
      const facts = controllerFrameFacts(value.device, value.grant);
      expect(facts).toEqual({ kidPinned: value.facts.kidPinned, signatureValid: value.facts.signatureValid });
      if (entry.expect === "accept") expect(decision).toEqual(value.expect);
      else expect(decision).not.toEqual(value.expect);
    });
  }
});

describe("Execute admission (case.execute)", () => {
  for (const { entry, name, value } of cases(PACK, "case.execute")) {
    it(`${entry.expect}: ${name}`, () => {
      const decision = admitExecute({ device: value.device, grant: value.grant, seen: value.seen, originLog: value.originLog,
        standingGrants: value.standingGrants, execute: value.execute });
      expect(decision.commandHash).toBe(value.facts.commandHash);
      expect(argsHash(value.execute.body.args)).toBe(value.facts.argsHash);
      const facts = controllerFrameFacts(value.device, value.execute);
      expect(facts).toEqual({ kidPinned: value.facts.kidPinned, signatureValid: value.facts.signatureValid });
      const { commandHash: _hash, ...outcome } = decision as typeof decision & { capabilities?: unknown };
      if (decision.outcome === "admitted") delete (outcome as { capabilities?: unknown }).capabilities;
      if (entry.expect === "accept") expect(outcome).toEqual(value.expect);
      else expect(outcome).not.toEqual(value.expect);
    });
  }
});

describe("Renew (case.renew)", () => {
  for (const { entry, name, value } of cases(PACK, "case.renew")) {
    it(`${entry.expect}: ${name}`, () => {
      const decision = applyRenew(value.device, value.grant, value.renew);
      if (entry.expect === "accept") expect(decision).toEqual(value.expect);
      else expect(decision).not.toEqual(value.expect);
    });
  }
});

describe("Revoke (case.revoke)", () => {
  for (const { entry, name, value } of cases(PACK, "case.revoke")) {
    it(`${entry.expect}: ${name}`, () => {
      const decision = applyRevoke(value.device, value.lastRevokeSeq, value.revoke);
      if (entry.expect === "accept") expect(decision).toEqual(value.expect);
      else expect(decision).not.toEqual(value.expect);
    });
  }
});

describe("Approve (case.approval)", () => {
  for (const { entry, name, value } of cases(PACK, "case.approval")) {
    it(`${entry.expect}: ${name}`, () => {
      const decision = verifyApproval({ device: value.device, commandHash: value.commandHash, capability: value.capability, approve: value.approve });
      if (decision.outcome === "valid") expect(decision.approvalHash).toBe(value.facts.approvalHash);
      if (entry.expect === "accept") expect(decision).toEqual(value.expect);
      else expect(decision).not.toEqual(value.expect);
    });
  }

  it("refuses an approval presented for a different command than the one it names", () => {
    const valid = cases(PACK, "case.approval").find((item) => item.name === "approval-valid.case.json")!.value;
    const other = cases(PACK, "case.approval").find((item) => item.name === "approval-other-command.case.json")!.value;
    expect(other.commandHash).not.toBe(valid.commandHash);
    expect(verifyApproval({ device: valid.device, commandHash: other.commandHash, capability: valid.capability, approve: valid.approve }))
      .toEqual({ outcome: "invalid", reason: "wrong_command" });
  });
});

// A device that runs one grant through several commands, with frames signed here by a fresh
// controller key: what the vectors cannot show one at a time.
describe("a grant across a sequence of commands", () => {
  const controller = controllerSigner(generateKeyPairSync("ed25519").privateKey);
  const now = 1_791_200_000_000;
  const device: DeviceAdmissionState = {
    ownerUserId: "@owner:atum.test", deviceServiceId: "00000000-0000-4000-8000-bd7662a5eeb4", enrollmentEpoch: 2, accountEpoch: 5,
    connectionId: "00000000-0000-4000-8000-b454f82c5857", connectionEpoch: 9, signedIn: true, paused: false,
    localScopes: ["terminal", "files", "computer", "send_file"], cloudAgents: ["@agent:atum.test"],
    pinnedControllerKeys: [controller.kid], controllerKeys: [{ kid: controller.kid, publicKey: controller.publicKey }], receivedAt: now
  };
  const grantBody: TurnGrant = {
    grantId: "00000000-0000-4000-8000-f6222a1106ee", ownerUserId: device.ownerUserId, agentPrincipal: "00000000-0000-4000-8000-f1d11edf5c5c",
    agentUserId: "@agent:atum.test", invocationId: "00000000-0000-4000-8000-fbfe405ca65f", originKind: "other", originAssertionHash: null,
    writerEpoch: { leaseGeneration: 3, leaseTokenHash: "a".repeat(43) }, targetDeviceServiceId: device.deviceServiceId,
    enrollmentEpoch: 2, accountEpoch: 5, scopes: ["terminal", "files"], connectionId: device.connectionId, issuedAt: now, expiresAt: now + 600_000
  };
  const command = (seq: number, args: Record<string, unknown>, commandId: string): Execute => ({
    commandId, grantId: grantBody.grantId, seq, connectionId: device.connectionId, connectionEpoch: 9, deviceServiceId: device.deviceServiceId,
    enrollmentEpoch: 2, accountEpoch: 5, tool: "terminal", toolVersion: 1, args, argsHash: argsHash(args), inputManifestHash: null, needs: [],
    proposedEffect: "ordinary", admitBy: now + 15_000, timeoutMs: 60_000, issuedAt: now
  });

  it("admits each next seq once, returns the stored outcome for a duplicate, and refuses a gap or a replay", () => {
    const grantFrame = signControllerEnvelope(controller, "TurnGrant", grantBody);
    expect(deviceServiceViolations("frame.TurnGrant", grantFrame)).toEqual([]);
    const granted = admitGrant(device, [], grantFrame);
    expect(granted).toEqual({ outcome: "accepted", effectiveScopes: ["terminal", "files"] });
    const grant: DeviceGrantState = { body: grantBody, status: "live", lastSeq: 0, effectiveScopes: ["terminal", "files"], authorityUntil: now + 15_000 };
    const seen: { commandId: string; commandHash: string }[] = []
    const run = (body: Execute) => admitExecute({ device, grant, seen, originLog: [], standingGrants: [], execute: signControllerEnvelope(controller, "Execute", body) });

    const first = command(1, { command: "echo one" }, "00000000-0000-4000-8000-0753ce97d28b");
    const admitted = run(first);
    expect(admitted.outcome).toBe("admitted");
    seen.push({ commandId: first.commandId, commandHash: admitted.commandHash });
    grant.lastSeq = 1;

    expect(run(first)).toEqual({ outcome: "duplicate", commandHash: admitted.commandHash });
    expect(run({ ...first, args: { command: "rm -rf ~" }, argsHash: argsHash({ command: "rm -rf ~" }) }).outcome).toBe("refused");
    expect(run(command(3, { command: "echo three" }, "00000000-0000-4000-8000-fab350c49090"))).toMatchObject({ refusal: "seq_gap" });
    expect(run(command(1, { command: "echo again" }, "00000000-0000-4000-8000-8bfc3e846e1c"))).toMatchObject({ refusal: "replayed" });
    expect(run(command(2, { command: "echo two" }, "00000000-0000-4000-8000-d64bccccc593")).outcome).toBe("admitted");
  });

  it("refuses a tool outside the grant's effective scopes, and a computer action while an approval is open", () => {
    const grant: DeviceGrantState = { body: grantBody, status: "live", lastSeq: 0, effectiveScopes: ["terminal", "files"], authorityUntil: now + 15_000 };
    const gui = { ...command(1, { action: "click" }, "00000000-0000-4000-8000-8806c8391484"), tool: "computer_use" as const };
    expect(admitExecute({ device, grant, seen: [], originLog: [], standingGrants: [], execute: signControllerEnvelope(controller, "Execute", gui) }))
      .toMatchObject({ refusal: "scope" });
    const wide = { ...grant, effectiveScopes: ["terminal", "files", "computer"] as const };
    expect(admitExecute({ device: { ...device, paused: true }, grant: { ...wide, effectiveScopes: [...wide.effectiveScopes] }, seen: [], originLog: [],
      standingGrants: [], execute: signControllerEnvelope(controller, "Execute", gui) })).toMatchObject({ refusal: "paused" });
  });

  it("asks for approval for a protected effect the device itself classifies, and admits it once approved", () => {
    const grant: DeviceGrantState = { body: grantBody, status: "live", lastSeq: 0, effectiveScopes: ["terminal", "files"], authorityUntil: now + 15_000 };
    const ssh = command(1, { command: "ssh -T git@github.com" }, "00000000-0000-4000-8000-f5ecc79dcbfc");
    const frame = signControllerEnvelope(controller, "Execute", ssh);
    const classify = (body: Execute) => (String(body.args.command).startsWith("ssh ") ? ["ssh_agent" as const] : []);
    const asked = admitExecute({ device, grant, seen: [], originLog: [], standingGrants: [], execute: frame, classify });
    expect(asked).toEqual({ outcome: "needs_approval", commandHash: deviceMessageHash("Execute", ssh), capabilities: ["ssh_agent"] });
    expect(admitExecute({ device, grant, seen: [], originLog: [], standingGrants: [], execute: frame, classify, approved: ["ssh_agent"] }).outcome)
      .toBe("admitted");
    expect(admitExecute({ device, grant, seen: [], originLog: [], standingGrants: [{ capability: "ssh_agent", target: "github.com:22" }], execute: frame,
      classify, targetOf: () => "github.com:22" }).outcome).toBe("admitted");
  });

  it("refuses arguments that cannot be canonicalized instead of throwing", () => {
    const grant: DeviceGrantState = { body: grantBody, status: "live", lastSeq: 0, effectiveScopes: ["terminal", "files"], authorityUntil: now + 15_000 };
    const body = { ...command(1, { command: "x" }, "00000000-0000-4000-8000-4a203356a261"), args: { timeout: 1.5 } as Record<string, unknown> };
    const frame = { v: 1 as const, type: "Execute" as const, body, kid: controller.kid, sig: "A".repeat(86) };
    expect(() => admitExecute({ device, grant, seen: [], originLog: [], standingGrants: [], execute: frame })).not.toThrow();
  });
});
