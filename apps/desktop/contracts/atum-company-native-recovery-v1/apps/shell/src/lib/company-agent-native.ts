import { NATIVE_REASONS, nativeReason } from "./company-agent-native-error.ts";
import {
  companyAIBody,
  companyAIControllerCredentials,
  CompanyAIHandlerError,
  companyAIReply,
  type CompanyAIRpc,
} from "./company-ai-identity.ts";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
type ObjectValue = Record<string, unknown>;

const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exact = (value: ObjectValue, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function failure(error: unknown): Response {
  const status = error instanceof CompanyAIHandlerError ? error.status
    : object(error) && error.code === "22023" ? 400
      : object(error) && error.code === "PT409" ? 409
      : object(error) && error.code === "42501" ? 403
        : object(error) && [400, 403, 409].includes(Number(error.status)) ? Number(error.status) : 503;

  const code = error instanceof CompanyAIHandlerError ? error.code
    : status === 400 ? "invalid" : status === 409 ? "conflict" : status === 403 ? "denied" : "unavailable";

  const reason = object(error) && NATIVE_REASONS.includes(error.reason as never) ? error.reason
    : object(error) ? nativeReason(error.message) ?? code : code;

  return companyAIReply({ schemaVersion: 1, error: { code, reason } }, status);
}

/**
 * Thin controller transport for the frozen company-agent/1 authority. Identity,
 * audience, payer and home coordinates are re-derived in SQL; the controller
 * supplies only its executor, already-issued task and its host holder id.
 */
export function companyAgentNativeController(rpc: CompanyAIRpc, enabled: () => boolean) {
  return async (request: Request, path: readonly string[]): Promise<Response> => {
    try {
      if (!enabled()) {throw new CompanyAIHandlerError(503, "unavailable");}
      const { controller, digest } = companyAIControllerCredentials(request);
      const url = new URL(request.url);

      if (request.method !== "POST" || url.search || path.length !== 3
        || path[0] !== "executors" || !UUID.test(path[1] ?? "")
        || !["native", "home", "recovery"].includes(path[2] ?? "")) {
        throw new CompanyAIHandlerError(400, "invalid");
      }

      const executor = path[1]!;
      const input = await companyAIBody(request, 4096);

      if (!object(input)) {throw new CompanyAIHandlerError(400, "invalid");}

      if (path[2] === "native") {
        if (!exact(input, ["schemaVersion", "taskId", "holderId"])
          || input.schemaVersion !== 2 || !UUID.test(String(input.taskId ?? ""))
          || !UUID.test(String(input.holderId ?? ""))) {
          throw new CompanyAIHandlerError(400, "invalid");
        }

        const result = await rpc("company_agent_native_dispatch", {
          p_controller: controller,
          p_credential_digest: digest,
          p_executor: executor,
          p_task: input.taskId,
          p_holder: input.holderId,
        });

        return companyAIReply(result);
      }

      if (path[2] === "recovery") {
        if (!exact(input, ["schemaVersion", "operation", "requestId", "taskId", "invocationId",
          "homeId", "leaseToken", "leaseGeneration", "disclosureEpoch", "expectedGeneration", "effect", "tools", "operationId"])
          || input.schemaVersion !== 1 || !["effects", "close", "requeue", "check"].includes(String(input.operation))
          || ![input.requestId, input.taskId, input.invocationId, input.homeId].every(v => typeof v === "string" && UUID.test(v))
          || !TOKEN.test(String(input.leaseToken ?? ""))
          || ![input.leaseGeneration, input.disclosureEpoch].every(v => Number.isSafeInteger(v) && Number(v) >= 1)
          || !Number.isSafeInteger(input.expectedGeneration) || Number(input.expectedGeneration) < 0
          || !["none", "read_only", "side_effect_possible", "unknown"].includes(String(input.effect))
          || !(input.operationId === null || typeof input.operationId === "string" && UUID.test(input.operationId))
          || !Array.isArray(input.tools) || input.tools.length > 12
          || !input.tools.every(v => typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,64}$/u.test(v))) {
          throw new CompanyAIHandlerError(400, "invalid");
        }

        return companyAIReply(await rpc("company_agent_native_recovery", {
          p_controller: controller, p_credential_digest: digest, p_executor: executor, p_input: input,
        }));
      }

      const operation = input.operation;

      if (!UUID.test(String(input.taskId ?? "")) || !["read", "renew", "commit"].includes(String(operation))) {
        throw new CompanyAIHandlerError(400, "invalid");
      }

      if (operation === "read") {
        if (!exact(input, ["schemaVersion", "operation", "taskId", "leaseToken"])
          || input.schemaVersion !== 1 || !TOKEN.test(String(input.leaseToken ?? ""))) {
          throw new CompanyAIHandlerError(400, "invalid");
        }
      } else if (operation === "renew") {
        if (!exact(input, ["schemaVersion", "operation", "requestId", "taskId", "leaseToken", "leaseGeneration"])
          || input.schemaVersion !== 1 || !UUID.test(String(input.requestId ?? ""))
          || !TOKEN.test(String(input.leaseToken ?? ""))
          || !Number.isSafeInteger(input.leaseGeneration) || Number(input.leaseGeneration) < 1) {
          throw new CompanyAIHandlerError(400, "invalid");
        }
      } else if (!exact(input, ["schemaVersion", "operation", "requestId", "taskId", "leaseToken",
        "leaseGeneration", "expectedGeneration", "generation", "manifestKey", "manifestSha256", "sizeBytes",
        "imageDigest", "configDigest", "nativeSessionId", "profileDigest",
        "quiesced", "intent"])
        || input.schemaVersion !== 1 || !UUID.test(String(input.requestId ?? ""))
        || !TOKEN.test(String(input.leaseToken ?? ""))
        || !Number.isSafeInteger(input.leaseGeneration) || Number(input.leaseGeneration) < 1
        || !Number.isSafeInteger(input.expectedGeneration) || Number(input.expectedGeneration) < 0
        || !Number.isSafeInteger(input.generation) || Number(input.generation) !== Number(input.expectedGeneration) + 1
        || typeof input.manifestKey !== "string" || input.manifestKey.length < 1 || input.manifestKey.length > 512
        || !DIGEST.test(String(input.manifestSha256 ?? "")) || typeof input.quiesced !== "boolean"
        || !Number.isSafeInteger(input.sizeBytes) || Number(input.sizeBytes) < 0 || Number(input.sizeBytes) > 2_147_483_648
        || !/^sha256:[a-f0-9]{64}$/u.test(String(input.imageDigest ?? ""))
        || !/^sha256:[a-f0-9]{64}$/u.test(String(input.configDigest ?? ""))
        || !UUID.test(String(input.nativeSessionId ?? "")) || !DIGEST.test(String(input.profileDigest ?? ""))
        || !["update", "checkpoint", "release"].includes(String(input.intent))) {
        throw new CompanyAIHandlerError(400, "invalid");
      }

      return companyAIReply(await rpc("company_agent_home", {
        p_controller: controller,
        p_credential_digest: digest,
        p_executor: executor,
        p_input: input,
      }));
    } catch (error) {
      return failure(error);
    }
  };
}
