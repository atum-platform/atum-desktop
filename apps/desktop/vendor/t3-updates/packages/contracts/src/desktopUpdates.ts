import * as Schema from "effect/Schema";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Alpha" | "Beta" | "Dev" | "Nightly";

export const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export type DesktopUpdateStatus = typeof DesktopUpdateStatusSchema.Type;
export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);

export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  omittedReleaseCount: number;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  notAppliedVersion?: string;
  /** Off only because a managed policy rules out this channel; switching channels turns it on. */
  channelBlockedByPolicy?: true;
  /** The check failed only because this build's track differs from the saved `channel`. */
  trackMismatch?: { readonly buildChannel: DesktopUpdateChannel };
}

export interface DesktopUpdateReleaseNote {
  version: string;
  items: ReadonlyArray<string>;
  totalItems: number;
  /** ISO time from the update feed for the offered version, else `YYYY-MM-DD` from a prerelease version. */
  releasedAt?: string;
  /** Paragraph-style summaries from older releases keep their fixes in `items`. */
  intro?: string;
  /** Generated summaries only, for example "275 changes from 22 contributors". */
  stats?: string;
  footer?: string;
}

export const DesktopUpdateReleaseNoteSchema = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.String),
  totalItems: Schema.Number,
  releasedAt: Schema.optionalKey(Schema.String),
  intro: Schema.optionalKey(Schema.String),
  stats: Schema.optionalKey(Schema.String),
  footer: Schema.optionalKey(Schema.String),
});

export const DesktopUpdateStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatusSchema,
  channel: DesktopUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  releaseNotes: Schema.Array(DesktopUpdateReleaseNoteSchema),
  omittedReleaseCount: Schema.Number,
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
  notAppliedVersion: Schema.optionalKey(Schema.String),
  channelBlockedByPolicy: Schema.optionalKey(Schema.Literal(true)),
  trackMismatch: Schema.optionalKey(Schema.Struct({ buildChannel: DesktopUpdateChannelSchema })),
});

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateActionResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateCheckResultSchema = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export type DesktopUpdateRemoteOutcome = "failed" | "up-to-date" | "ready-to-install" | "disabled" | "busy";
export interface DesktopTelemetryRequestDesktopUpdate { channel: DesktopUpdateChannel; targetVersion: string | null }
export { DESKTOP_UPDATE_RESTART_MARKER_FILE, DESKTOP_UPDATE_IN_PROGRESS_MARKER_FILE, DESKTOP_UPDATE_IN_PROGRESS_TTL_MS } from "./desktopBootstrap.ts";
