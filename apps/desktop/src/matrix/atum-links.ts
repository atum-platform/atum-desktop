/**
 * Atum's public pages, opened in the browser through the fixed `openLink` bridge (http(s)
 * only, main checks it again). Public pages only: never add account, token or device
 * material to these addresses.
 */
export const ATUM_LINKS = {
  terms: 'https://atumplatform.com/terms',
  privacy: 'https://atumplatform.com/privacy',
  /** The download page (PH8): the latest notarized DMG from the update feed. Until the website
   * publishes it (G3-06·WB), this address serves the home page, as the link did before. */
  download: 'https://atumplatform.com/download',
  /** The complete corresponding source of the bundled Atum Drive engine (GPL-2.0-or-later):
   * the public source revision this release ships (drive-engine/manifest.json `sourceCommit`).
   * The tag includes the compiled implementation plus its documented assembly recipe. */
  driveEngineSource:
    'https://github.com/atum-platform/atum-drive-companion/tree/drive-engine-0.20.19'
} as const
