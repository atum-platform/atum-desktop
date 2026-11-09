/** Passive, local selected-agent driver status. No source paths, commands,
 * raw diagnostic text, credentials, or permission-grant capability.
 * Missing/null probe values stay unknown; malformed present booleans fail.
 * On macOS ready means AX and screen-recording grants: any known false is
 * not ready, both true is ready, otherwise unknown. Capture availability is
 * separate. Non-Mac ready is driver health and has no TCC permission claims.
 * Missing installation, unsupported OS or a probe error clears those claims. */
export interface MatrixComputerUseSnapshot {
  platform: 'darwin' | 'win32' | 'linux' | 'unsupported'
  installed: boolean
  ready: boolean | null
  accessibility: boolean | null
  screenRecording: boolean | null
  screenRecordingCapturable: boolean | null
}

export interface MatrixComputerUseClient {
  status(): Promise<MatrixComputerUseSnapshot>
}
