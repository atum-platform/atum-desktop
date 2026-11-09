/** RPC dependencies of desktop startup setup and model readiness.
 * Call sites use these names directly so the live gateway catalog test covers them. */
export const REQUIRED_SETUP_METHODS = {
  status: 'setup.status',
  runtimeCheck: 'setup.runtime_check',
  configGet: 'config.get'
} as const

export const REQUIRED_SETUP_RPC_METHODS = Object.values(REQUIRED_SETUP_METHODS)
