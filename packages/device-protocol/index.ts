/**
 * `@atum/device-protocol` — the shared canonical JSON, digests, message types, validators,
 * envelope signing and the device's admission decisions for the Atum device protocol
 * (`atum.device-service/1`) and origin assertions (`atum.cloud-answering/1`). The canonical
 * function is a byte-for-byte port of the platform `canonicalJson`; every digest and signature
 * routes through it. The controller's device hub (WS-3a), the desktop device service (WS-3b,
 * WS-4) and WS-2's request digests all import this one module, by relative path, so it is bundled
 * into each.
 */
export * from "./admission";
export * from "./agent-source-gates";
export * from "./agent-sources";
export * from "./agent-sweep";
export * from "./agent-sweep-v1.1";
export * from "./agent-sweep-v2";
export * from "./artifact";
export { canonicalJson } from "./canonical";
export { AGENT_SOURCE_GATES_PACK, AGENT_SOURCES_PACK, AGENT_SWEEP_PACK, AGENT_SWEEP_V2_PACK, AGENT_SWEEP_V11_PACK,
  CLOUD_ANSWERING_PARAMETERS, DEVICE_SERVICE_PARAMETERS } from "./contract-packs";
export * from "./enrollment";
export * from "./envelope";
export * from "./hashes";
export * from "./machines";
export * from "./messages";
export * from "./migration-messages";
export * from "./origin";
export { sameJson, type Violation, type ViolationCategory } from "./schema";
export * from "./status";
export { validStopEvent } from './stop-target';
export { parseStrictJson, StrictJsonError } from "./strict-json";
export * from './workspace';
export * from "./workspace-messages";
export * from "./mac-sources";
