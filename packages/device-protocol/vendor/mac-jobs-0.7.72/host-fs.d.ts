import { z } from "zod";
export declare const HOST_FS_PROFILE: "atum.host-fs/1";
export declare const APP_IFRAME_PROFILE: "atum.app-iframe/1";
export declare const AppWorkspaceToolIdSchema: z.ZodEnum<{
    viewer: "viewer";
    files: "files";
}>;
export declare const HostWorkspaceToolIdSchema: z.ZodLiteral<"local_files">;
export declare const WorkspaceToolIdSchema: z.ZodUnion<readonly [z.ZodEnum<{
    viewer: "viewer";
    files: "files";
}>, z.ZodLiteral<"local_files">]>;
export declare const HostPairingSnapshotSchema: z.ZodObject<{
    pairing: z.ZodEnum<{
        unpaired: "unpaired";
        paired: "paired";
        revoked: "revoked";
    }>;
    availability: z.ZodEnum<{
        online: "online";
        offline: "offline";
    }>;
}, z.core.$strict>;
export type AppWorkspaceToolId = z.infer<typeof AppWorkspaceToolIdSchema>;
export type HostWorkspaceToolId = z.infer<typeof HostWorkspaceToolIdSchema>;
export type WorkspaceToolId = z.infer<typeof WorkspaceToolIdSchema>;
export type HostPairingSnapshot = z.infer<typeof HostPairingSnapshotSchema>;
/**
 * The app and host inputs are intentionally separate trust domains. Unknown app
 * claims are discarded, and the app cannot add or remove `local_files`.
 */
export declare function workspaceToolsForContext(appToolClaims: readonly string[], hostSnapshotInput: HostPairingSnapshot): readonly WorkspaceToolId[];
export declare const HostFsEntrySchema: z.ZodObject<{
    handle: z.ZodString;
    parent_handle: z.ZodNullable<z.ZodString>;
    name: z.ZodString;
    kind: z.ZodEnum<{
        file: "file";
        directory: "directory";
        symlink: "symlink";
    }>;
    size_bytes: z.ZodNullable<z.ZodNumber>;
    modified_at: z.ZodString;
    readable: z.ZodBoolean;
}, z.core.$strict>;
export declare const HostFsMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    direction: z.ZodLiteral<"web_to_native">;
    type: z.ZodLiteral<"host.fs.enumerate">;
    payload: z.ZodObject<{
        parent_handle: z.ZodNullable<z.ZodString>;
        cursor: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.enumerated">;
    payload: z.ZodObject<{
        request_id: z.ZodString;
        parent_handle: z.ZodNullable<z.ZodString>;
        revision: z.ZodString;
        entries: z.ZodArray<z.ZodObject<{
            handle: z.ZodString;
            parent_handle: z.ZodNullable<z.ZodString>;
            name: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                directory: "directory";
                symlink: "symlink";
            }>;
            size_bytes: z.ZodNullable<z.ZodNumber>;
            modified_at: z.ZodString;
            readable: z.ZodBoolean;
        }, z.core.$strict>>;
        next_cursor: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"web_to_native">;
    type: z.ZodLiteral<"host.fs.read">;
    payload: z.ZodObject<{
        file_handle: z.ZodString;
        offset_bytes: z.ZodNumber;
        length_bytes: z.ZodNumber;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.content">;
    payload: z.ZodObject<{
        request_id: z.ZodString;
        file_handle: z.ZodString;
        offset_bytes: z.ZodNumber;
        content_base64: z.ZodString;
        eof: z.ZodBoolean;
        revision: z.ZodString;
        mime_type: z.ZodString;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"web_to_native">;
    type: z.ZodLiteral<"host.fs.watch">;
    payload: z.ZodObject<{
        root_handle: z.ZodNullable<z.ZodString>;
        since_revision: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.watching">;
    payload: z.ZodObject<{
        request_id: z.ZodString;
        subscription_id: z.ZodString;
        revision: z.ZodString;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.changed">;
    payload: z.ZodObject<{
        subscription_id: z.ZodString;
        revision: z.ZodString;
        change: z.ZodEnum<{
            created: "created";
            updated: "updated";
            removed: "removed";
            resync_required: "resync_required";
        }>;
        entry: z.ZodNullable<z.ZodObject<{
            handle: z.ZodString;
            parent_handle: z.ZodNullable<z.ZodString>;
            name: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                directory: "directory";
                symlink: "symlink";
            }>;
            size_bytes: z.ZodNullable<z.ZodNumber>;
            modified_at: z.ZodString;
            readable: z.ZodBoolean;
        }, z.core.$strict>>;
        removed_handle: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"web_to_native">;
    type: z.ZodLiteral<"host.fs.unwatch">;
    payload: z.ZodObject<{
        subscription_id: z.ZodString;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.unwatched">;
    payload: z.ZodObject<{
        request_id: z.ZodString;
        subscription_id: z.ZodString;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"web_to_native">;
    type: z.ZodLiteral<"host.fs.select">;
    payload: z.ZodObject<{
        handles: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.selected">;
    payload: z.ZodObject<{
        request_id: z.ZodString;
        selection_ref: z.ZodString;
        entries: z.ZodArray<z.ZodObject<{
            handle: z.ZodString;
            parent_handle: z.ZodNullable<z.ZodString>;
            name: z.ZodString;
            kind: z.ZodEnum<{
                file: "file";
                directory: "directory";
                symlink: "symlink";
            }>;
            size_bytes: z.ZodNullable<z.ZodNumber>;
            modified_at: z.ZodString;
            readable: z.ZodBoolean;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"native_to_web">;
    type: z.ZodLiteral<"host.fs.error">;
    payload: z.ZodObject<{
        request_id: z.ZodString;
        code: z.ZodEnum<{
            invalid_handle: "invalid_handle";
            not_found: "not_found";
            not_readable: "not_readable";
            not_directory: "not_directory";
            not_file: "not_file";
            tcc_denied: "tcc_denied";
            device_offline: "device_offline";
            stale_revision: "stale_revision";
            payload_too_large: "payload_too_large";
            internal_error: "internal_error";
        }>;
        retryable: z.ZodBoolean;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.host-fs/1">;
    message_id: z.ZodString;
}, z.core.$strict>], "type">;
export type HostFsEntry = z.infer<typeof HostFsEntrySchema>;
export type HostFsMessage = z.infer<typeof HostFsMessageSchema>;
/** The one wire representation: NFC, sorted keys, no whitespace, safe integer numerics. */
export declare function canonicalJson(value: unknown): string;
/**
 * Parse one strict JSON frame without rewriting its string bytes.
 *
 * This is intentionally narrower than `parseCanonicalFrame`: callers that
 * authenticate opaque UTF-8 first can reject duplicate keys, invalid UTF-8,
 * non-integer numerics, BOMs, and trailing data without NFC-normalizing or
 * reserializing the signed representation.
 */
export declare function parsePreservedJsonFrame(bytes: string | Uint8Array): unknown;
/** Strictly parse the canonical JSON frame shared by every cross-language protocol pack. */
export declare function parseCanonicalFrame(bytes: string | Uint8Array): unknown;
export declare function serializeHostFsMessage(message: z.input<typeof HostFsMessageSchema>): string;
export declare function parseHostFsMessage(bytes: string | Uint8Array): HostFsMessage;
export declare const AppIframeBridgeMessageSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    direction: z.ZodLiteral<"app_to_host">;
    type: z.ZodLiteral<"app.ready">;
    payload: z.ZodObject<{
        height: z.ZodNumber;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.app-iframe/1">;
    message_id: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    direction: z.ZodLiteral<"host_to_app">;
    type: z.ZodLiteral<"host.appearance">;
    payload: z.ZodObject<{
        theme: z.ZodEnum<{
            light: "light";
            dark: "dark";
        }>;
        locale: z.ZodEnum<{
            vi: "vi";
            en: "en";
        }>;
    }, z.core.$strict>;
    profile: z.ZodLiteral<"atum.app-iframe/1">;
    message_id: z.ZodString;
}, z.core.$strict>], "type">;
export type AppIframeBridgeMessage = z.infer<typeof AppIframeBridgeMessageSchema>;
export declare function serializeAppIframeBridgeMessage(message: z.input<typeof AppIframeBridgeMessageSchema>): string;
export declare function parseAppIframeBridgeMessage(bytes: string | Uint8Array): AppIframeBridgeMessage;
//# sourceMappingURL=host-fs.d.ts.map