import { DEVICE_SERVICE_PARAMETERS } from "./contract-packs";
import { DEVICE_HUB_MAX_PAYLOAD_BYTES, type Receipt, type Status } from "./messages";

/**
 * Keeping device frames inside the hub's 1 MiB payload limit (S1 build plan §3.3).
 *
 * A Receipt may carry up to 65,536 code points of output plus a tool result (`data`), so a
 * reconnect's Status naming a few large ones would overflow the frame: the hub closes the
 * connection (1009), the Mac reconnects and sends the same Status, and never comes online. A Mac
 * must also never trim by **dropping** a receipt: a command the Status omits counts as never
 * received, so the controller would retry it and an effect could repeat.
 *
 * So the device's Status names every queried command its ledger holds; when the frame would be too
 * big, the largest results lose their `output` and `data` (state, hash, sequence, exit code and
 * artifacts stay) until it fits, and each stripped receipt is sent whole afterwards as its own
 * Receipt. The controller treats a Status receipt without output as done with the output
 * unavailable.
 */

/** Room left for the envelope around a body (`v`, `type`, `kid`, `sig`, JSON punctuation). */
export const ENVELOPE_HEADROOM_BYTES = 4096;
/** The largest body (as UTF-8 JSON) a device frame may carry. */
export const FRAME_BODY_MAX_BYTES = DEVICE_HUB_MAX_PAYLOAD_BYTES - ENVELOPE_HEADROOM_BYTES;

/** A body's size as it travels: UTF-8 bytes of its JSON. */
export function frameBodyBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

/** The receipt without its result's `output` and `data` (unchanged when it has neither). */
export function withoutOutput(receipt: Receipt): Receipt {
  if (!receipt.result || (receipt.result.output === undefined && receipt.result.data === undefined)) return receipt;
  const { output: _output, data: _data, ...rest } = receipt.result;
  return { ...receipt, result: rest };
}

/** One Receipt that fits a frame: as it is, or without its output and data. */
export function fitReceipt(receipt: Receipt, maxBodyBytes = FRAME_BODY_MAX_BYTES): Receipt {
  return frameBodyBytes(receipt) <= maxBodyBytes ? receipt : withoutOutput(receipt);
}

export interface StatusPlan {
  /** The Status to send first: every queried command the ledger holds, in query order. */
  status: Status;
  /** Whole receipts to send next, one Receipt frame each, for the ones the Status trimmed. */
  followUps: Receipt[];
}

/**
 * The device's answer to a `StatusQuery`: every queried command its ledger holds (never fewer),
 * trimmed largest-first until the frame fits, with the trimmed ones' whole receipts to follow.
 */
export function statusReceipts(
  queried: readonly string[],
  ledger: { get(commandId: string): Receipt | undefined },
  maxBodyBytes = FRAME_BODY_MAX_BYTES,
): StatusPlan {
  const ids = [...new Set(queried)].slice(0, DEVICE_SERVICE_PARAMETERS.status_max_commands);
  const whole = ids.map((id) => ledger.get(id)).filter((receipt): receipt is Receipt => !!receipt)
    .map((receipt) => fitReceipt(receipt, maxBodyBytes));
  const receipts = [...whole];
  const sizes = receipts.map((receipt) => frameBodyBytes(receipt));
  // JSON of an array is its elements' JSON joined by commas, so each change is exact.
  let size = frameBodyBytes({ receipts });
  const followUps: Receipt[] = [];
  const largestFirst = receipts.map((_, index) => index).sort((a, b) => sizes[b]! - sizes[a]!);
  for (const index of largestFirst) {
    if (size <= maxBodyBytes) break;
    const lean = withoutOutput(whole[index]!);
    if (lean === whole[index]) continue;
    size -= sizes[index]! - frameBodyBytes(lean);
    receipts[index] = lean;
    followUps.push(whole[index]!);
  }
  return { status: { receipts }, followUps };
}
