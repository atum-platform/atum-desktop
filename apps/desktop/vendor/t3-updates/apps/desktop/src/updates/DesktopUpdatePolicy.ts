/**
 * DesktopUpdatePolicy - what the administrator's managed policy allows the desktop updater to do.
 * The desktop reads the policy file itself, before any backend runs, and fails closed: a policy it
 * cannot read turns updates off.
 *
 * @module DesktopUpdatePolicy
 */
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";


export interface UpdatePolicy {
  readonly mode: "auto" | "off" | "manual";
  readonly feedUrl: string | undefined;
  readonly allowNightly: boolean;
  /** Why the updater is restricted, shown in place of update actions; `null` when unmanaged. */
  readonly message: string | null;
}

export class DesktopUpdatePolicy extends Context.Service<DesktopUpdatePolicy, UpdatePolicy>()(
  "@t3tools/desktop/updates/DesktopUpdatePolicy",
) {}

export const unmanagedUpdatePolicy: UpdatePolicy = {
  mode: "auto",
  feedUrl: undefined,
  allowNightly: true,
  message: null,
};

export const layerTest = (policy: UpdatePolicy = unmanagedUpdatePolicy) =>
  Layer.succeed(DesktopUpdatePolicy, policy);
