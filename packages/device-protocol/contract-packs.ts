/** Sanitised public client contract projection. Pins bind the published fixture bytes; source references are provenance and do not attest a deployment or historical provider acceptance. */
import agentTurns17Pack from "./fixtures/agent-turns-v1.7/contract.json";
import agentHome1_7Pack from "./fixtures/agent-home-v1.7/contract.json";
import agentHome1_8Pack from "./fixtures/agent-home-v1.8/contract.json";
import agentHomePack from "./fixtures/agent-home/contract.json";
import agentSourceGatesPack from "./fixtures/agent-source-gates/contract.json";
import agentSourcesPack from "./fixtures/agent-sources/contract.json";
import agentSweepV11Pack from "./fixtures/agent-sweep-v1.1/contract.json";
import agentSweepV2Pack from "./fixtures/agent-sweep-v2/contract.json";
import agentSweepPack from "./fixtures/agent-sweep/contract.json";
import chatGptRelayPack from "./fixtures/chatgpt-relay/contract.json";
import cloudAnsweringPack from "./fixtures/cloud-answering/contract.json";
import cloudExecution1_11Pack from "./fixtures/cloud-execution-v1.11/contract.json";
import cloudExecution1_13Pack from "./fixtures/cloud-execution-v1.13/contract.json";
import cloudExecution1_14Pack from "./fixtures/cloud-execution-v1.14/contract.json";
import cloudExecutionPack from "./fixtures/cloud-execution/contract.json";
import deviceFleetPack from "./fixtures/device-fleet/contract.json";
import deviceService12Pack from "./fixtures/device-service-v1.2/contract.json";
import deviceServicePack from "./fixtures/device-service/contract.json";
import deviceWorkspacePack from "./fixtures/device-workspace/contract.json";
import modelChoice14Pack from "./fixtures/model-choice-v1.4/contract.json";
import modelChoice15Pack from "./fixtures/model-choice-v1.5/contract.json";
import providerConnectionsPack from "./fixtures/provider-connections/contract.json";
import type { ContractPack } from "./schema";

export const AGENT_TURNS_1_7_PACK = agentTurns17Pack as unknown as ContractPack;

export const DEVICE_FLEET_PACK = deviceFleetPack as unknown as ContractPack;
export const DEVICE_WORKSPACE_PACK = deviceWorkspacePack as unknown as ContractPack;
export const DEVICE_SERVICE_1_2_PACK = deviceService12Pack as unknown as ContractPack;
export const DEVICE_SERVICE_PACK = deviceServicePack as unknown as ContractPack;
export const CLOUD_ANSWERING_PACK = cloudAnsweringPack as unknown as ContractPack;
/** `atum.cloud-execution/1.10`: the managed dispatch grants (1.7 and the line-up grant) the cloud controller consumes. */
export const CLOUD_EXECUTION_PACK = cloudExecutionPack as unknown as ContractPack;
/** `atum.cloud-execution/1.11`: additive over 1.10; adds the daily-cap admission refusal. */
export const CLOUD_EXECUTION_1_11_PACK = cloudExecution1_11Pack as unknown as ContractPack;
/** `atum.cloud-execution/1.13`: additive over 1.12; adds the zero-Proton subscription dispatch. */
export const CLOUD_EXECUTION_1_13_PACK = cloudExecution1_13Pack as unknown as ContractPack;
/** `atum.cloud-execution/1.14`: additive R2 ChatGPT-plan device relay dispatch. */
export const CLOUD_EXECUTION_1_14_PACK = cloudExecution1_14Pack as unknown as ContractPack;
/** `atum.model-choice/1.4`: additive over 1.3; adds the cloud `source: opencode_go` choice and its grant. */
export const MODEL_CHOICE_1_4_PACK = modelChoice14Pack as unknown as ContractPack;
/** `atum.model-choice/1.5`: cloud `source: chatgpt_plan` bound to one relay Mac. */
export const MODEL_CHOICE_1_5_PACK = modelChoice15Pack as unknown as ContractPack;
/** `atum.provider-connections/1`: the account-wide OpenCode Go custody and subscription edge. */
export const PROVIDER_CONNECTIONS_PACK = providerConnectionsPack as unknown as ContractPack;
/** `atum.chatgpt-relay/1`: bounded controller-signed relay frames and owner selection. */
export const CHATGPT_RELAY_PACK = chatGptRelayPack as unknown as ContractPack;
/** `atum.agent-home/1.5`: the status line the cloud brain speaks (`status_code` of 1.4). */
export const AGENT_HOME_PACK = agentHomePack as unknown as ContractPack;
/** `atum.agent-home/1.7`: additive over 1.5; adds the daily-cap warning and refusal codes. */
export const AGENT_HOME_1_7_PACK = agentHome1_7Pack as unknown as ContractPack;
/** `atum.agent-home/1.8`: additive over 1.7; adds occurrence-only silent delivery. */
export const AGENT_HOME_1_8_PACK = agentHome1_8Pack as unknown as ContractPack;
/** `atum.agent-sweep/1`: the system-owned background follow-up occurrence contract. */
export const AGENT_SWEEP_PACK = agentSweepPack as unknown as ContractPack;
/** `atum.agent-sweep/1.1`: additive first-48h warm-up cadence and nudge release over the frozen `/1` wire. */
export const AGENT_SWEEP_V11_PACK = agentSweepV11Pack as unknown as ContractPack;
/** `atum.agent-source-gates/1`: revisioned owner projection of the six existing source opt-outs. */
export const AGENT_SOURCE_GATES_PACK = agentSourceGatesPack as unknown as ContractPack;
/** `atum.agent-sources/1`: open source descriptors, live access snapshots, cursors and tagged evidence. */
export const AGENT_SOURCES_PACK = agentSourcesPack as unknown as ContractPack;
/** `atum.agent-sweep/2`: negotiated open-source cursors over the frozen legacy profiles. */
export const AGENT_SWEEP_V2_PACK = agentSweepV2Pack as unknown as ContractPack;

/**
 * Packs addressed by their exact profile string, never by numeric max version. agent-home 1.6 (the
 * 1.3-line requeue overlay) and 1.7 (the 1.5-line status overlay) are independent: a consumer that
 * needs both vendors both pins and names the line it speaks. `atum.agent-home/1.6` is deliberately
 * not here until its bytes are vendored; the controller continues to carry agent.requeue itself.
 */
export const CONTRACT_PACKS_BY_PROFILE: Readonly<Record<string, ContractPack>> = Object.freeze({
  "atum.agent-turns/1.7": AGENT_TURNS_1_7_PACK,
  "atum.device-fleet/1": DEVICE_FLEET_PACK,
  "atum.device-service/1.2": DEVICE_SERVICE_1_2_PACK,
  "atum.cloud-execution/1.10": CLOUD_EXECUTION_PACK,
  "atum.cloud-execution/1.11": CLOUD_EXECUTION_1_11_PACK,
  "atum.cloud-execution/1.13": CLOUD_EXECUTION_1_13_PACK,
  "atum.cloud-execution/1.14": CLOUD_EXECUTION_1_14_PACK,
  "atum.model-choice/1.4": MODEL_CHOICE_1_4_PACK,
  "atum.model-choice/1.5": MODEL_CHOICE_1_5_PACK,
  "atum.provider-connections/1": PROVIDER_CONNECTIONS_PACK,
  "atum.chatgpt-relay/1": CHATGPT_RELAY_PACK,
  "atum.agent-home/1.5": AGENT_HOME_PACK,
  "atum.agent-home/1.7": AGENT_HOME_1_7_PACK,
  "atum.agent-home/1.8": AGENT_HOME_1_8_PACK,
  "atum.agent-sweep/1": AGENT_SWEEP_PACK,
  "atum.agent-sweep/1.1": AGENT_SWEEP_V11_PACK,
  "atum.agent-source-gates/1": AGENT_SOURCE_GATES_PACK,
  "atum.agent-sources/1": AGENT_SOURCES_PACK,
  "atum.agent-sweep/2": AGENT_SWEEP_V2_PACK
});

export function contractPackFor(profile: string): ContractPack | undefined {
  return CONTRACT_PACKS_BY_PROFILE[profile];
}

/** The frozen device-service parameters (admission 15 s, approval 60 s, heartbeat 5 s, …). */
export const DEVICE_SERVICE_PARAMETERS = DEVICE_SERVICE_PACK.parameters as Readonly<{
  admission_ms: number;
  approval_ms: number;
  heartbeat_ms: number;
  authority_window_ms: number;
  skew_ms: number;
  dedupe_days: number;
  grant_max_ms: number;
  preauth_ms: number;
  connections_per_ip_per_minute: number;
  max_payload_bytes: number;
  execute_per_second: number;
  execute_per_turn: number;
  protected_prompts_per_minute: number;
  denials_before_auto_refuse: number;
  status_max_commands: number;
  output_max_code_points: number;
  artifact_max_bytes: number;
  artifacts_max: number;
  reconnect_backoff_min_ms: number;
  reconnect_backoff_max_ms: number;
}>;

/** The origin-assertion parameters (skew 300 s, nonce window 7 days). */
export const CLOUD_ANSWERING_PARAMETERS = CLOUD_ANSWERING_PACK.parameters as Readonly<{
  origin_skew_ms: number;
  nonce_window_days: number;
  request_hash_hex_length: number;
}>;
