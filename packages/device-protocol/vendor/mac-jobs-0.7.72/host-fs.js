import { z } from "zod";
export const HOST_FS_PROFILE = "atum.host-fs/1";
export const APP_IFRAME_PROFILE = "atum.app-iframe/1";
const uuidSchema = z.string().regex(/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const dateTimeSchema = z.string().regex(rfc3339Pattern).refine((value) => {
    const match = rfc3339Pattern.exec(value);
    if (!match)
        return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return month >= 1 && month <= 12 && day >= 1
        && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
        && !Number.isNaN(Date.parse(value));
}, "timestamp must be a valid RFC 3339 calendar instant");
const opaqueTokenSchema = z.string().min(8).max(256).regex(/^[A-Za-z0-9_-]+$/);
const hostFsHandleSchema = z.string().min(10).max(256).regex(/^h_[A-Za-z0-9_-]{8,254}$/);
const safeIntegerSchema = z.number().int().safe();
const nonnegativeIntegerSchema = safeIntegerSchema.nonnegative();
const unicodeScalarLength = (value) => [...value].length;
const scalarBoundedString = (minimum, maximum) => z.string()
    .refine((value) => unicodeScalarLength(value) >= minimum && unicodeScalarLength(value) <= maximum, `must contain ${minimum}..${maximum} Unicode scalar values`);
const entryNameSchema = scalarBoundedString(1, 255)
    .refine((value) => value !== "." && value !== "..", "entry names cannot be dot segments")
    .refine((value) => !/[\x00-\x1f\x7f/\\]/u.test(value), "entry names cannot contain separators or controls");
export const AppWorkspaceToolIdSchema = z.enum(["viewer", "files"]);
export const HostWorkspaceToolIdSchema = z.literal("local_files");
export const WorkspaceToolIdSchema = z.union([AppWorkspaceToolIdSchema, HostWorkspaceToolIdSchema]);
export const HostPairingSnapshotSchema = z.object({
    pairing: z.enum(["unpaired", "paired", "revoked"]),
    availability: z.enum(["online", "offline"]),
}).strict().superRefine((value, context) => {
    if (value.pairing !== "paired" && value.availability !== "offline") {
        context.addIssue({
            code: "custom",
            path: ["availability"],
            message: "only a paired device can be online",
        });
    }
});
/**
 * The app and host inputs are intentionally separate trust domains. Unknown app
 * claims are discarded, and the app cannot add or remove `local_files`.
 */
export function workspaceToolsForContext(appToolClaims, hostSnapshotInput) {
    const hostSnapshot = HostPairingSnapshotSchema.parse(hostSnapshotInput);
    const appTools = new Set();
    for (const claim of appToolClaims) {
        const parsed = AppWorkspaceToolIdSchema.safeParse(claim);
        if (parsed.success)
            appTools.add(parsed.data);
    }
    const tools = [...appTools];
    if (hostSnapshot.pairing === "paired")
        tools.push("local_files");
    return tools;
}
export const HostFsEntrySchema = z.object({
    handle: hostFsHandleSchema,
    parent_handle: hostFsHandleSchema.nullable(),
    name: entryNameSchema,
    kind: z.enum(["directory", "file", "symlink"]),
    size_bytes: nonnegativeIntegerSchema.nullable(),
    modified_at: dateTimeSchema,
    readable: z.boolean(),
}).strict();
const hostFsBase = {
    profile: z.literal(HOST_FS_PROFILE),
    message_id: uuidSchema,
};
const enumerateMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("web_to_native"),
    type: z.literal("host.fs.enumerate"),
    payload: z.object({
        parent_handle: hostFsHandleSchema.nullable(),
        cursor: opaqueTokenSchema.nullable(),
    }).strict(),
}).strict();
const enumeratedMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.enumerated"),
    payload: z.object({
        request_id: uuidSchema,
        parent_handle: hostFsHandleSchema.nullable(),
        revision: opaqueTokenSchema,
        entries: z.array(HostFsEntrySchema).max(1_000),
        next_cursor: opaqueTokenSchema.nullable(),
    }).strict(),
}).strict();
const readMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("web_to_native"),
    type: z.literal("host.fs.read"),
    payload: z.object({
        file_handle: hostFsHandleSchema,
        offset_bytes: nonnegativeIntegerSchema,
        length_bytes: safeIntegerSchema.positive().max(1_048_576),
    }).strict(),
}).strict();
const contentMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.content"),
    payload: z.object({
        request_id: uuidSchema,
        file_handle: hostFsHandleSchema,
        offset_bytes: nonnegativeIntegerSchema,
        content_base64: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        eof: z.boolean(),
        revision: opaqueTokenSchema,
        mime_type: scalarBoundedString(1, 255),
    }).strict(),
}).strict();
const watchMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("web_to_native"),
    type: z.literal("host.fs.watch"),
    payload: z.object({
        root_handle: hostFsHandleSchema.nullable(),
        since_revision: opaqueTokenSchema.nullable(),
    }).strict(),
}).strict();
const watchingMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.watching"),
    payload: z.object({
        request_id: uuidSchema,
        subscription_id: opaqueTokenSchema,
        revision: opaqueTokenSchema,
    }).strict(),
}).strict();
const changedMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.changed"),
    payload: z.object({
        subscription_id: opaqueTokenSchema,
        revision: opaqueTokenSchema,
        change: z.enum(["created", "updated", "removed", "resync_required"]),
        entry: HostFsEntrySchema.nullable(),
        removed_handle: hostFsHandleSchema.nullable(),
    }).strict().superRefine((value, context) => {
        if (value.change === "removed" && value.removed_handle === null) {
            context.addIssue({ code: "custom", path: ["removed_handle"], message: "removed changes require a handle" });
        }
        if (value.change === "removed" && value.entry !== null) {
            context.addIssue({ code: "custom", path: ["entry"], message: "removed changes cannot carry an entry" });
        }
        if ((value.change === "created" || value.change === "updated") && value.entry === null) {
            context.addIssue({ code: "custom", path: ["entry"], message: `${value.change} changes require an entry` });
        }
        if ((value.change === "created" || value.change === "updated") && value.removed_handle !== null) {
            context.addIssue({ code: "custom", path: ["removed_handle"], message: `${value.change} changes cannot remove a handle` });
        }
        if (value.change === "resync_required" && (value.entry !== null || value.removed_handle !== null)) {
            context.addIssue({ code: "custom", message: "resync_required cannot carry entry authority" });
        }
    }),
}).strict();
const unwatchMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("web_to_native"),
    type: z.literal("host.fs.unwatch"),
    payload: z.object({ subscription_id: opaqueTokenSchema }).strict(),
}).strict();
const unwatchedMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.unwatched"),
    payload: z.object({ request_id: uuidSchema, subscription_id: opaqueTokenSchema }).strict(),
}).strict();
const selectMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("web_to_native"),
    type: z.literal("host.fs.select"),
    payload: z.object({ handles: z.array(hostFsHandleSchema).max(256) }).strict()
        .superRefine((value, context) => {
        if (new Set(value.handles).size !== value.handles.length) {
            context.addIssue({ code: "custom", path: ["handles"], message: "selection handles must be unique" });
        }
    }),
}).strict();
const selectedMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.selected"),
    payload: z.object({
        request_id: uuidSchema,
        selection_ref: opaqueTokenSchema,
        entries: z.array(HostFsEntrySchema).max(256),
    }).strict(),
}).strict();
const errorMessageSchema = z.object({
    ...hostFsBase,
    direction: z.literal("native_to_web"),
    type: z.literal("host.fs.error"),
    payload: z.object({
        request_id: uuidSchema,
        code: z.enum([
            "invalid_handle",
            "not_found",
            "not_readable",
            "not_directory",
            "not_file",
            "tcc_denied",
            "device_offline",
            "stale_revision",
            "payload_too_large",
            "internal_error",
        ]),
        retryable: z.boolean(),
    }).strict(),
}).strict();
export const HostFsMessageSchema = z.discriminatedUnion("type", [
    enumerateMessageSchema,
    enumeratedMessageSchema,
    readMessageSchema,
    contentMessageSchema,
    watchMessageSchema,
    watchingMessageSchema,
    changedMessageSchema,
    unwatchMessageSchema,
    unwatchedMessageSchema,
    selectMessageSchema,
    selectedMessageSchema,
    errorMessageSchema,
]);
function requireUnicodeScalarString(value) {
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                throw new TypeError("JSON strings must contain Unicode scalar values");
            index += 1;
        }
        else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            throw new TypeError("JSON strings must contain Unicode scalar values");
        }
    }
}
function normalizeJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        if (typeof value === "string") {
            requireUnicodeScalarString(value);
            return value.normalize("NFC");
        }
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new TypeError("canonical JSON permits safe integers only");
        return value;
    }
    if (Array.isArray(value))
        return value.map(normalizeJson);
    if (typeof value !== "object")
        throw new TypeError("value is not JSON");
    const result = {};
    for (const [rawKey, entry] of Object.entries(value)) {
        requireUnicodeScalarString(rawKey);
        const key = rawKey.normalize("NFC");
        if (Object.hasOwn(result, key))
            throw new TypeError("keys collide after NFC normalization");
        result[key] = normalizeJson(entry);
    }
    return result;
}
function encodeCanonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(encodeCanonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`).join(",")}}`;
}
/** The one wire representation: NFC, sorted keys, no whitespace, safe integer numerics. */
export function canonicalJson(value) {
    return encodeCanonical(normalizeJson(value));
}
class JsonFrameScanner {
    offset = 0;
    text;
    constructor(text) { this.text = text; }
    scan() {
        if (this.text.startsWith("\uFEFF"))
            throw new SyntaxError("UTF-8 BOM is forbidden");
        this.value();
        this.whitespace();
        if (this.offset !== this.text.length)
            throw new SyntaxError("trailing JSON data");
    }
    whitespace() {
        while (/[\t\n\r ]/u.test(this.text[this.offset] ?? ""))
            this.offset += 1;
    }
    value() {
        this.whitespace();
        const next = this.text[this.offset];
        if (next === "{")
            return this.object();
        if (next === "[")
            return this.array();
        if (next === '"') {
            this.string();
            return;
        }
        const literal = /^(?:true|false|null)/u.exec(this.text.slice(this.offset));
        if (literal) {
            this.offset += literal[0].length;
            return;
        }
        const number = /^-?(?:0|[1-9]\d*)/u.exec(this.text.slice(this.offset));
        if (number) {
            this.offset += number[0].length;
            const following = this.text[this.offset];
            if (following === "." || following === "e" || following === "E" || /\d/u.test(following ?? "")) {
                throw new SyntaxError("numbers must be canonical decimal integers");
            }
            if (!Number.isSafeInteger(Number(number[0])))
                throw new SyntaxError("integer exceeds interoperable range");
            return;
        }
        throw new SyntaxError(`invalid JSON value at byte ${this.offset}`);
    }
    object() {
        this.offset += 1;
        this.whitespace();
        const keys = new Set();
        if (this.text[this.offset] === "}") {
            this.offset += 1;
            return;
        }
        while (true) {
            this.whitespace();
            const key = this.string();
            if (keys.has(key))
                throw new SyntaxError(`duplicate JSON key: ${key}`);
            keys.add(key);
            this.whitespace();
            if (this.text[this.offset] !== ":")
                throw new SyntaxError("object key missing colon");
            this.offset += 1;
            this.value();
            this.whitespace();
            if (this.text[this.offset] === "}") {
                this.offset += 1;
                return;
            }
            if (this.text[this.offset] !== ",")
                throw new SyntaxError("object member missing comma");
            this.offset += 1;
        }
    }
    array() {
        this.offset += 1;
        this.whitespace();
        if (this.text[this.offset] === "]") {
            this.offset += 1;
            return;
        }
        while (true) {
            this.value();
            this.whitespace();
            if (this.text[this.offset] === "]") {
                this.offset += 1;
                return;
            }
            if (this.text[this.offset] !== ",")
                throw new SyntaxError("array value missing comma");
            this.offset += 1;
        }
    }
    string() {
        const start = this.offset;
        if (this.text[this.offset] !== '"')
            throw new SyntaxError("object key must be a string");
        this.offset += 1;
        while (this.offset < this.text.length) {
            const character = this.text[this.offset];
            if (character === '"') {
                this.offset += 1;
                return JSON.parse(this.text.slice(start, this.offset));
            }
            if (character === "\\") {
                this.offset += 1;
                if (this.text[this.offset] === "u")
                    this.offset += 4;
            }
            this.offset += 1;
        }
        throw new SyntaxError("unterminated JSON string");
    }
}
/**
 * Parse one strict JSON frame without rewriting its string bytes.
 *
 * This is intentionally narrower than `parseCanonicalFrame`: callers that
 * authenticate opaque UTF-8 first can reject duplicate keys, invalid UTF-8,
 * non-integer numerics, BOMs, and trailing data without NFC-normalizing or
 * reserializing the signed representation.
 */
export function parsePreservedJsonFrame(bytes) {
    if (bytes instanceof Uint8Array && bytes.length >= 3
        && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        throw new SyntaxError("UTF-8 BOM is forbidden");
    }
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    new JsonFrameScanner(text).scan();
    return JSON.parse(text);
}
/** Strictly parse the canonical JSON frame shared by every cross-language protocol pack. */
export function parseCanonicalFrame(bytes) {
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = parsePreservedJsonFrame(bytes);
    if (canonicalJson(parsed) !== text)
        throw new SyntaxError("frame is not canonical JSON");
    return parsed;
}
export function serializeHostFsMessage(message) {
    return canonicalJson(HostFsMessageSchema.parse(message));
}
export function parseHostFsMessage(bytes) {
    return HostFsMessageSchema.parse(parseCanonicalFrame(bytes));
}
const appIframeBase = { profile: z.literal(APP_IFRAME_PROFILE), message_id: uuidSchema };
const appReadyMessageSchema = z.object({
    ...appIframeBase,
    direction: z.literal("app_to_host"),
    type: z.literal("app.ready"),
    payload: z.object({ height: nonnegativeIntegerSchema.max(10_000) }).strict(),
}).strict();
const hostAppearanceMessageSchema = z.object({
    ...appIframeBase,
    direction: z.literal("host_to_app"),
    type: z.literal("host.appearance"),
    payload: z.object({ theme: z.enum(["light", "dark"]), locale: z.enum(["vi", "en"]) }).strict(),
}).strict();
export const AppIframeBridgeMessageSchema = z.discriminatedUnion("type", [
    appReadyMessageSchema,
    hostAppearanceMessageSchema,
]);
export function serializeAppIframeBridgeMessage(message) {
    return canonicalJson(AppIframeBridgeMessageSchema.parse(message));
}
export function parseAppIframeBridgeMessage(bytes) {
    return AppIframeBridgeMessageSchema.parse(parseCanonicalFrame(bytes));
}
