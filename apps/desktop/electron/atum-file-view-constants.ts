/**
 * The PDF viewer's session partition.
 *
 * Keep the established `persist:` partition across the Electron 44 upgrade so
 * PDF rendering changes no storage boundary in the security patch. On-disk
 * storage survives a relaunch, so main clears this session's storage and cache
 * at defined boundaries — start and account revocation — and the viewer
 * refuses to place anything until that has finished. It denies permissions
 * and downloads and serves one local file at a time.
 */
export const ATUM_FILE_VIEW_PARTITION = 'persist:atum-file-viewer'
