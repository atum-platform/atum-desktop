import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical";
import { contractPackFor } from "./contract-packs";
import { argsHash, deviceMessageHash, keyId, leaseTokenHash, originAssertionHash, requestDigestV2, requestHashV2 } from "./hashes";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const sha256Hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The pack pin (spec/_tools/README.md): SHA-256 over each declared file in order — the path's
 * UTF-8 length as 4 BE bytes, the path, the body length as 8 BE bytes, then the body. Recomputing
 * it over the vendored files and matching PINNED-SHA256 proves the copy is byte-identical to the
 * platform pack, so our canonical/digest output must agree with the platform's. */
function recomputePackDigest(packDir: string): string {
  const contract = readJson(join(packDir, "contract.json"));
  const digest = createHash("sha256");
  for (const file of contract.pack_files as string[]) {
    const encoded = Buffer.from(file, "utf8");
    const body = readFileSync(join(packDir, ...file.split("/")));
    const pathLength = Buffer.alloc(4); pathLength.writeUInt32BE(encoded.length);
    const bodyLength = Buffer.alloc(8); bodyLength.writeBigUInt64BE(BigInt(body.length));
    digest.update(pathLength).update(encoded).update(bodyLength).update(body);
  }
  return digest.digest("hex");
}

describe("vendored platform packs are intact", () => {
  const manifest = readJson(join(fixturesDir, "vendored.json"));
  for (const pack of Object.keys(manifest.packs)) {
    it(`${pack}: recomputed pin equals PINNED-SHA256 and vendored.json`, () => {
      const packDir = join(fixturesDir, pack);
      const pinned = readFileSync(join(packDir, "PINNED-SHA256"), "utf8").trim();
      const recomputed = recomputePackDigest(packDir);
      expect(recomputed).toBe(pinned);
      expect(manifest.packs[pack].pinned_sha256).toBe(pinned);
    });
  }
});

describe("the daily-cap packs are additive and addressed by profile string", () => {
  const pack = (name: string) => readJson(join(fixturesDir, name, "contract.json"));
  const carriedFixtures = (next: string, base: string) => {
    const baseContract = pack(base);
    for (const file of (baseContract.pack_files as string[]).filter((file) => file.startsWith("fixtures/"))) {
      const bytes = readFileSync(join(fixturesDir, next, ...file.split("/")));
      expect(bytes, file).toEqual(readFileSync(join(fixturesDir, base, ...file.split("/"))));
    }
  };

  it("cloud-execution 1.11 is 1.10 plus the refusal, and every 1.10 fixture is carried", () => {
    const next = pack("cloud-execution-v1.11");
    expect(next.base.contract).toBe("atum.cloud-execution/1.10");
    expect(next.base.sha256).toBe(readJson(join(fixturesDir, "vendored.json")).packs["cloud-execution"].pinned_sha256);
    carriedFixtures("cloud-execution-v1.11", "cloud-execution");
    expect(next.types.model_daily_cap).toBeDefined();
    expect(next.types.model_daily_spend).toBeDefined();
    expect(Object.keys(next.messages)).toContain("managed.admission.refusal");
  });

  it("agent-home 1.7 is the 1.5 line, widened with the daily-cap codes only", () => {
    const next = pack("agent-home-v1.7");
    const base = pack("agent-home");
    expect(next.base.contract).toBe("atum.agent-home/1.5");
    expect(next.base.sha256).toMatch(/^[a-f0-9]{64}$/);
    carriedFixtures("agent-home-v1.7", "agent-home");
    expect(next.types.status_code.enum).toEqual([...base.types.status_code.enum, "daily_cap", "daily_cap_warning"]);
    // 1.6 is the independent 1.3-line requeue overlay; 1.7 must never absorb it.
    expect(next.types.requeue_effect).toBeUndefined();
  }, 20_000);

  it("agent-home 1.8 is 1.7 plus occurrence-only silent delivery, with every 1.7 fixture carried", () => {
    const next = pack("agent-home-v1.8");
    expect(next.base.contract).toBe("atum.agent-home/1.7");
    expect(next.base.sha256).toBe(readJson(join(fixturesDir, "vendored.json")).packs["agent-home-v1.7"].pinned_sha256);
    carriedFixtures("agent-home-v1.8", "agent-home-v1.7");
    expect(next.messages["agent.commit.request"].schema.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: expect.objectContaining({ occurrenceId: expect.anything(), outcome: { const: "answered" }, delivery: { const: "silent" } }) })
    ]));
  }, 20_000);

  it("agent-sweep 1.1 is the frozen /1 wire plus the warm-up cadence", () => {
    const next = pack("agent-sweep-v1.1");
    expect(next.base.contract).toBe("atum.agent-sweep/1");
    expect(next.base.sha256).toBe(readJson(join(fixturesDir, "vendored.json")).packs["agent-sweep"].pinned_sha256);
    expect(next.parameters.warmup_offsets_ms).toEqual([300000, 900000, 2100000, 3600000]);
    expect(next.parameters.warmup_active_compute_seconds).toBe(1800);
    expect(next.parameters.warmup_release_limit).toBe(2);
    expect(next.parameters.warmup_release_backoff_ms).toBe(120000);
    expect(next.types.claimed_normal.required.occurrenceKind).toEqual({ const: "followup_sweep" });
    expect(next.types.claimed_warmup.required.occurrenceKind).toEqual({ const: "warmup_nudge" });
    expect(next.types.settlement_warmup_offer.required.warmupNudgeIndex).toBeDefined();
    expect(next.types.release.required.operation).toEqual({ const: "release" });
    expect(next.types.release_retired.required.disposition).toEqual({ const: "none" });
    expect(next.messages["release.response"].schema.anyOf).toHaveLength(2);
  });


  it("model-choice 1.4 is 1.3 plus the account-wide subscription source, with every 1.3 fixture carried", () => {
    const next = pack("model-choice-v1.4");
    expect(next.base.contract).toBe("atum.model-choice/1.3");
    expect(next.base.sha256).toBe(readJson(join(fixturesDir, "vendored.json")).packs["model-choice"].pinned_sha256);
    carriedFixtures("model-choice-v1.4", "model-choice");
    expect(next.types.destination_choice.anyOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ required: expect.objectContaining({
        destination: { const: "cloud" }, source: { ref: "subscription_source" }
      }) })
    ]));
    expect(next.types.subscription_source.const).toBe("opencode_go");
    expect(next.types.byoProvider.enum).toContain("opencode_go");
  }, 20_000);

  it("cloud-execution 1.13 is 1.12 plus the zero-Proton subscription dispatch", () => {
    const next = pack("cloud-execution-v1.13");
    expect(next.base.contract).toBe("atum.cloud-execution/1.12");
    expect(next.base.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(next.messages)).toContain("subscription.dispatch.response");
    expect(next.types.subscription_model_grant).toBeDefined();
    expect(next.types.subscription_model_grant.required.maxTurnMicroProtons).toEqual({ const: 0 });
    // Every 1.11 fixture is carried through 1.12 into 1.13 byte for byte.
    carriedFixtures("cloud-execution-v1.13", "cloud-execution-v1.11");
    const sandbox = readJson(join(fixturesDir, "cloud-execution-v1.13", "fixtures", "subscription-sandbox.vectors.json"));
    expect(sandbox.vectors[0]).toMatchObject({ envBase: "platform_subscription_edge", envKey: "opaque_turn_grant",
      envAlias: "selected_model", atumBilling: false, fallback: "none", durableProviderKey: false });
  }, 20_000);

  it("R2 preserves R1 dispatches and deliberately enables the ChatGPT relay source", () => {
    const choice = pack("model-choice-v1.5");
    const execution = pack("cloud-execution-v1.14");
    const relay = pack("chatgpt-relay");
    carriedFixtures("cloud-execution-v1.14", "cloud-execution-v1.13");
    expect(choice.types.chatgpt_relay_source).toEqual({ const: "chatgpt_plan" });
    expect(execution.messages["chatgpt-relay.dispatch.response"]).toBeDefined();
    expect(execution.types.chatgpt_relay_model_grant.required.maxTurnMicroProtons).toEqual({ const: 0 });
    expect(relay.parameters).toMatchObject({ capability_max_ms: 60_000, capability_uses: 1,
      request_max_bytes: 800_000, response_max_bytes: 800_000 });
  }, 20_000);

  it("provider-connections v1 keeps the key out of every response and serves one provider", () => {
    const next = pack("provider-connections");
    expect(next.version).toBe(1);
    expect(Object.keys(next.messages)).toEqual(expect.arrayContaining([
      "connection.status.response", "connection.connect.request", "connection.disconnect.request"
    ]));
    expect(JSON.stringify(next.types)).toContain("opencode_go");
    expect(JSON.stringify(next.messages["connection.status.response"])).not.toMatch(/api_key|secret/i);
  });

  it("selects each line by its exact profile string, never by numeric max version", () => {
    expect((contractPackFor("atum.agent-sweep/1")?.version)).toBe(1);
    expect((contractPackFor("atum.agent-sweep/1.1")?.version)).toBe("1.1");
    expect((contractPackFor("atum.agent-source-gates/1")?.version)).toBe(1);
    expect((contractPackFor("atum.agent-sources/1")?.version)).toBe(1);
    expect((contractPackFor("atum.agent-sweep/2")?.version)).toBe(2);
    expect((contractPackFor("atum.agent-home/1.7")?.version)).toBe("1.7");
    expect((contractPackFor("atum.agent-home/1.8")?.version)).toBe("1.8");
    expect((contractPackFor("atum.agent-home/1.5")?.version)).toBe("1.5");
    expect((contractPackFor("atum.cloud-execution/1.11")?.version)).toBe("1.11");
    expect((contractPackFor("atum.cloud-execution/1.10")?.version)).toBe("1.10");
    expect((contractPackFor("atum.cloud-execution/1.13")?.version)).toBe("1.13");
    expect((contractPackFor("atum.cloud-execution/1.14")?.version)).toBe("1.14");
    expect((contractPackFor("atum.model-choice/1.4")?.version)).toBe("1.4");
    expect((contractPackFor("atum.model-choice/1.5")?.version)).toBe("1.5");
    expect((contractPackFor("atum.provider-connections/1")?.version)).toBe(1);
    expect((contractPackFor("atum.chatgpt-relay/1")?.version)).toBe(1);
    expect(contractPackFor("atum.agent-home/1.6")).toBeUndefined();
    expect(contractPackFor("atum.cloud-execution/1.12")).toBeUndefined();
  });
});

describe("canonicalJson matches the platform canonical vectors", () => {
  const vectors = readJson(join(fixturesDir, "device-service", "fixtures", "canonical.vectors.json")).vectors as Array<Record<string, unknown>>;
  it("has vectors to check", () => expect(vectors.length).toBeGreaterThan(0));
  for (const vector of vectors) {
    it(`${vector.name as string}`, () => {
      if (vector.result === "ok") {
        const parsed = JSON.parse(vector.inputJson as string);
        const canonical = canonicalJson(parsed);
        expect(canonical).toBe(vector.canonical);
        expect(sha256Hex(Buffer.from(canonical, "utf8"))).toBe(vector.sha256);
      } else {
        expect(() => canonicalJson(JSON.parse(vector.inputJson as string))).toThrow();
      }
    });
  }
});

describe("device-service hashes match the vendored vectors", () => {
  const vectors = readJson(join(fixturesDir, "device-service", "fixtures", "hashes.vectors.json")).vectors as Array<Record<string, any>>;
  for (const vector of vectors) {
    it(`${vector.name}`, () => {
      if (vector.kind === "message") {
        expect(deviceMessageHash(vector.type, vector.body)).toBe(vector.hash);
      } else if (vector.kind === "kid") {
        expect(keyId(Buffer.from(vector.publicKey, "base64url"))).toBe(vector.kid);
      } else if (vector.kind === "lease_token") {
        expect(leaseTokenHash(vector.leaseToken)).toBe(vector.leaseTokenHash);
      } else if (vector.kind === "args") {
        expect(argsHash(vector.args)).toBe(vector.argsHash);
      }
    });
  }
});

describe("origin assertion hash and request digest v2 match cloud-answering fixtures", () => {
  it("origin.assertion hash equals the origin-verified case's expect", () => {
    const assertion = readJson(join(fixturesDir, "cloud-answering", "fixtures", "origin.assertion.json")) as Record<string, unknown>;
    const { sig: _sig, ...rest } = assertion;
    const verified = readJson(join(fixturesDir, "cloud-answering", "fixtures", "origin-verified.case.json"));
    expect(originAssertionHash(rest)).toBe(verified.expect.assertionHash);
  });

  const digestVectors = readJson(join(fixturesDir, "cloud-answering", "fixtures", "digest.vectors.json")).vectors as Array<Record<string, any>>;
  for (const vector of digestVectors.filter((v) => v.version === 2)) {
    it(`digest v2: ${vector.name}`, () => {
      expect(requestDigestV2(vector.content)).toBe(vector.dg);
      expect(requestHashV2(vector.content)).toBe(vector.requestHash);
    });
  }
});
