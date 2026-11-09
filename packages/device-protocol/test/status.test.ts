import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deviceServiceViolations, DEVICE_HUB_MAX_PAYLOAD_BYTES, type Receipt } from "../messages";
import { fitReceipt, frameBodyBytes, FRAME_BODY_MAX_BYTES, statusReceipts, withoutOutput } from "../status";

// A reconnect's Status must fit the hub's 1 MiB frame and must never leave a command out (an
// omitted command counts as never received, and would be retried).

const hash = () => randomBytes(32).toString("base64url");
/** Contract violations of a Status body, checked as the frame it travels in. */
const statusViolations = (body: unknown) => deviceServiceViolations("frame.Status",
  { v: 1, type: "Status", body, kid: hash(), sig: randomBytes(64).toString("base64url") });
/** A receipt whose output is the contract's maximum, in 4-byte code points (256 KiB of UTF-8). */
function big(state: Receipt["state"] = "completed"): Receipt {
  return { commandId: randomUUID(), commandHash: hash(), seq: 1, state, artifacts: [],
    result: { exitCode: 0, output: "\u{1F600}".repeat(65_536), data: { lines: ["x".repeat(50_000)] } } };
}
function small(state: Receipt["state"] = "completed"): Receipt {
  return { commandId: randomUUID(), commandHash: hash(), seq: 2, state, artifacts: [], result: { exitCode: 0, output: "ok" } };
}

describe("statusReceipts", () => {
  it("names every queried command the ledger holds, in query order, untouched when they fit", () => {
    const receipts = [small(), small("started"), small("not_started")];
    const ledger = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
    const unknown = randomUUID();
    const plan = statusReceipts([receipts[2]!.commandId, unknown, receipts[0]!.commandId, receipts[1]!.commandId, receipts[0]!.commandId], ledger);
    expect(plan.status.receipts).toEqual([receipts[2], receipts[0], receipts[1]]);
    expect(plan.followUps).toEqual([]);
  });

  it("trims the largest results until the frame fits, never dropping a command, and sends each whole afterwards", () => {
    const receipts = [small(), big(), big(), small("started"), big(), big()];
    expect(frameBodyBytes({ receipts })).toBeGreaterThan(DEVICE_HUB_MAX_PAYLOAD_BYTES);
    const ledger = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
    const plan = statusReceipts(receipts.map((receipt) => receipt.commandId), ledger);

    expect(frameBodyBytes(plan.status)).toBeLessThanOrEqual(FRAME_BODY_MAX_BYTES);
    expect(statusViolations(plan.status)).toEqual([]);
    expect(plan.status.receipts.map((receipt) => receipt.commandId)).toEqual(receipts.map((receipt) => receipt.commandId));
    // Only output and data are ever removed: state, hash, sequence and exit code stay as signed.
    plan.status.receipts.forEach((receipt, index) => {
      const original = receipts[index]!;
      expect(receipt).toMatchObject({ commandId: original.commandId, commandHash: original.commandHash, seq: original.seq, state: original.state,
        result: { exitCode: 0 } });
      if (receipt !== original) expect(receipt).toEqual(withoutOutput(original));
    });
    // The small ones keep their output; only as many large ones as needed are trimmed.
    expect(plan.status.receipts[0]).toEqual(receipts[0]);
    expect(plan.status.receipts[3]).toEqual(receipts[3]);
    expect(plan.followUps.length).toBeGreaterThan(0);
    expect(plan.followUps.length).toBeLessThan(4);
    for (const followUp of plan.followUps) {
      expect(receipts).toContain(followUp);
      expect(frameBodyBytes(followUp)).toBeLessThanOrEqual(FRAME_BODY_MAX_BYTES);
    }
  });

  it("keeps at most the contract's 256 commands", () => {
    const receipts = Array.from({ length: 300 }, () => small());
    const plan = statusReceipts(receipts.map((receipt) => receipt.commandId), new Map(receipts.map((receipt) => [receipt.commandId, receipt])));
    expect(plan.status.receipts).toHaveLength(256);
    expect(statusViolations(plan.status)).toEqual([]);
  });
});

describe("fitReceipt", () => {
  it("leaves a receipt that fits alone, and strips one whose data alone overflows a frame", () => {
    const ok = big();
    expect(fitReceipt(ok)).toBe(ok);
    const huge: Receipt = { ...small(), result: { exitCode: 1, output: "tail", data: "y".repeat(DEVICE_HUB_MAX_PAYLOAD_BYTES) } };
    expect(fitReceipt(huge)).toEqual({ ...huge, result: { exitCode: 1 } });
    const plain = small("refused");
    expect(withoutOutput(plain)).toEqual({ ...plain, result: { exitCode: 0 } });
  });
});
