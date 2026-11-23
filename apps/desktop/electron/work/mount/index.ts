export { createWorkGateService, type WorkGateFactoryInput, type WorkMountAccount, workSocketPath } from './gate-factory'
export { type MountSurfaceState, type RetireResult, WorkMount, type WorkMountDeps, type WorkMountPhase, type WorkMountState } from './mount'
export {
  classifyOwnerEventReadError,
  createOwnerEventVerifier,
  createSdkOwnerEventSource,
  type OwnerEventSource,
  type OwnerSdkHost
} from './owner-event'
export { createKeychainSecretStore, workSecretsPath } from './secret-store'
