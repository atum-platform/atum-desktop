// The effect classification lives in shared/ so the cloud controller can bundle it without pulling in
// Electron code (its build refuses any input under electron/). Desktop callers keep this path.
export * from '../../shared/matrix-turn-effects'
