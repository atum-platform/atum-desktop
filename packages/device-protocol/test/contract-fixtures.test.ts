import { describe, expect, it } from "vitest";

import { CLOUD_ANSWERING_PACK, DEVICE_FLEET_PACK, DEVICE_SERVICE_1_2_PACK, DEVICE_SERVICE_PACK } from "../contract-packs";
import { DeviceProtocolError, parseFrame } from "../messages";
import { machineViolations, messageViolations, type ContractPack } from "../schema";
import { fixtureEntries, readFixture, readFixtureText } from "./fixtures";

// Conformance: every fixture of the two packs the device hub speaks is accepted or refused by the
// runtime validators exactly as the contract declares, refusals with the declared violation
// category — the same verdicts as the platform's reference checker.

const packs: [string, ContractPack][] = [["device-fleet", DEVICE_FLEET_PACK], ["device-service", DEVICE_SERVICE_PACK], ["device-service-v1.2", DEVICE_SERVICE_1_2_PACK], ["cloud-answering", CLOUD_ANSWERING_PACK]];

for (const [name, pack] of packs) {
  describe(`${name} fixtures`, () => {
    const entries = fixtureEntries(name);
    it("declares fixtures", () => expect(entries.length).toBeGreaterThan(0));

    for (const entry of entries) {
      it(`${entry.expect}: ${entry.file}`, () => {
        const value = readFixture(name, entry.file);
        const violations = entry.message !== undefined
          ? messageViolations(pack, entry.message, value)
          : machineViolations(pack.state_machines![entry.machine!]!, value.steps);
        if (entry.expect === "accept") expect(violations).toEqual([]);
        else expect(violations.map((violation) => violation.category)).toContain(entry.violation);
      });
    }
  });
}

describe("wire frames parse exactly as the contract declares", () => {
  const frames = fixtureEntries("device-service").filter((entry) => entry.message?.startsWith("frame.") && entry.message !== "frame.Approve");
  it("has wire frame fixtures", () => expect(frames.length).toBeGreaterThan(10));

  for (const entry of frames) {
    it(`${entry.expect}: ${entry.file}`, () => {
      const text = readFixtureText("device-service", entry.file);
      if (entry.expect === "accept") {
        expect(parseFrame(text).type).toBe(entry.message!.slice("frame.".length));
        return;
      }
      try {
        parseFrame(text);
        expect.unreachable("a reject fixture parsed");
      } catch (error) {
        expect(error).toBeInstanceOf(DeviceProtocolError);
        expect((error as DeviceProtocolError).violations.map((violation) => violation.category)).toContain(entry.violation);
      }
    });
  }

  it("never accepts the device-local Approve frame on the wire", () => {
    expect(() => parseFrame(readFixtureText("device-service", "fixtures/approve.frame.json"))).toThrow(DeviceProtocolError);
  });

  it("refuses a frame travelling the wrong way", () => {
    const execute = readFixtureText("device-service", "fixtures/execute.frame.json");
    expect(parseFrame(execute, "controller_to_device").type).toBe("Execute");
    expect(() => parseFrame(execute, "device_to_controller")).toThrow("device_envelope_direction");
    const hello = readFixtureText("device-service", "fixtures/hello.frame.json");
    expect(() => parseFrame(hello, "controller_to_device")).toThrow("device_envelope_direction");
  });

  it("refuses duplicate keys, floats and frames over the payload limit before any schema check", () => {
    const hello = readFixture("device-service", "fixtures/hello.frame.json");
    const text = JSON.stringify(hello);
    expect(() => parseFrame(text.replace('"v":1', '"v":1,"v":1'))).toThrow("json_duplicate_key");
    expect(() => parseFrame(text.replace('"policyVersion":1', '"policyVersion":1.5'))).toThrow("json_not_integer");
    expect(() => parseFrame(`${text}${" ".repeat(1_048_577)}`)).toThrow("device_frame_too_large");
    expect(() => parseFrame("{}")).toThrow(DeviceProtocolError);
  });
});
