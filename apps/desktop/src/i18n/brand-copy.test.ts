import { renderHook } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'

import { createBrandCopyScanner } from '../../shared/brand-copy-scan.test-support'
import { MATRIX_AGENT_STATUS_CODES } from '../../shared/matrix-agent-status-copy'
import { MATRIX_CLOUD_ACCESS_REASONS } from '../../shared/matrix-cloud-access'
import { MATRIX_LOCAL_ACTIONS } from '../../shared/matrix-command-center-ops'
import { MATRIX_DEBUG_DESTINATIONS } from '../../shared/matrix-debug-share'
import { MATRIX_VOICE_SETTING_RULES } from '../../shared/matrix-voice-settings'
import { matrixAttentionCopy } from '../matrix/attention-copy'
import { matrixStoreCopy } from '../matrix/store/store-copy'

import { I18nProvider } from './context'
import type { Locale } from './types'

/**
 * The reviewed technical-name boundary for the Atum shipping desktop (U13-BRAND). These remain
 * compatible outside human copy: `matrix_*`/`atum-matrix` wire, IPC, and storage identifiers;
 * `[Matrix]` diagnostics; Matrix-prefixed source types; Hermes runtime/CLI/environment/storage/
 * migration identifiers; the stable `Atum Matrix Candidate` custody identity; hidden
 * SDK/playground titles; and third-party product, protocol, model, and licence names.
 *
 * This test walks the rendered shapes of the copy itself instead of reading source text: every
 * exported copy value of the modules below, the desktop locale catalogs, and the values private
 * locale tables produce when their accessor (a `matrix*Copy(locale)` factory or a `use*Copy()`
 * hook) is called with each desktop locale. Any string a person can be shown must pass the check.
 * The native main-process copy modules are guarded by `electron/matrix/atum-brand-copy.test.ts`.
 */

/** Explicit list of the renderer/shared copy modules; extended here by hand when one ships. */
const COPY_MODULES: ReadonlyArray<readonly [string, () => Promise<Record<string, unknown>>]> = [
  ['shared/agent-conversation/copy', () => import('../../shared/agent-conversation/copy')],
  ['shared/matrix-action-copy', () => import('../../shared/matrix-action-copy')],
  ['shared/matrix-agent-access-band-copy', () => import('../../shared/matrix-agent-access-band-copy')],
  ['shared/matrix-agent-status-copy', () => import('../../shared/matrix-agent-status-copy')],
  ['shared/matrix-alias-copy', () => import('../../shared/matrix-alias-copy')],
  ['shared/matrix-app-chat-copy', () => import('../../shared/matrix-app-chat-copy')],
  ['shared/matrix-approval-copy', () => import('../../shared/matrix-approval-copy')],
  ['shared/matrix-auxiliary-copy', () => import('../../shared/matrix-auxiliary-copy')],
  ['shared/matrix-browser-import-copy', () => import('../../shared/matrix-browser-import-copy')],
  ['shared/matrix-command-center-copy', () => import('../../shared/matrix-command-center-copy')],
  ['shared/matrix-command-center-ops-copy', () => import('../../shared/matrix-command-center-ops-copy')],
  ['shared/matrix-company-copy', () => import('../../shared/matrix-company-copy')],
  ['shared/matrix-company-funding-copy', () => import('../../shared/matrix-company-funding-copy')],
  ['shared/matrix-computer-use-grant-copy', () => import('../../shared/matrix-computer-use-grant-copy')],
  ['shared/matrix-curator-copy', () => import('../../shared/matrix-curator-copy')],
  ['shared/matrix-debug-share-copy', () => import('../../shared/matrix-debug-share-copy')],
  ['shared/matrix-device-isolation-copy', () => import('../../shared/matrix-device-isolation-copy')],
  ['shared/matrix-drive-import-copy', () => import('../../shared/matrix-drive-import-copy')],
  ['shared/matrix-first-run-copy', () => import('../../shared/matrix-first-run-copy')],
  ['shared/matrix-management-copy', () => import('../../shared/matrix-management-copy')],
  ['shared/matrix-pages-copy', () => import('../../shared/matrix-pages-copy')],
  ['shared/matrix-runtime-copy', () => import('../../shared/matrix-runtime-copy')],
  ['shared/matrix-starmap-copy', () => import('../../shared/matrix-starmap-copy')],
  ['shared/matrix-status-line-copy', () => import('../../shared/matrix-status-line-copy')],
  ['shared/matrix-team-space-copy', () => import('../../shared/matrix-team-space-copy')],
  ['shared/matrix-tool-settings-copy', () => import('../../shared/matrix-tool-settings-copy')],
  ['shared/matrix-voice-settings-copy', () => import('../../shared/matrix-voice-settings-copy')],
  ['src/i18n/en', () => import('./en')],
  ['src/i18n/vi', () => import('./vi')],
  ['src/i18n/ja', () => import('./ja')],
  ['src/i18n/zh', () => import('./zh')],
  ['src/i18n/zh-hant', () => import('./zh-hant')],
  ['src/matrix/account-step-copy', () => import('../matrix/account-step-copy')],
  ['src/matrix/agent-content-copy', () => import('../matrix/agent-content-copy')],
  ['src/matrix/app-copy', () => import('../matrix/app-copy')],
  ['src/matrix/assistant-card/copy', () => import('../matrix/assistant-card/copy')],
  ['src/matrix/assistant-card/photo-crop-copy', () => import('../matrix/assistant-card/photo-crop-copy')],
  ['src/matrix/attention-copy', () => import('../matrix/attention-copy')],
  ['src/matrix/chat-copy', () => import('../matrix/chat-copy')],
  ['src/matrix/chat-search-copy', () => import('../matrix/chat-search-copy')],
  ['src/matrix/check-ins-copy', () => import('../matrix/check-ins-copy')],
  ['src/matrix/conversation-copy', () => import('../matrix/conversation-copy')],
  ['src/matrix/copy', () => import('../matrix/copy')],
  ['src/matrix/decryption-copy', () => import('../matrix/decryption-copy')],
  ['src/matrix/drive-copy', () => import('../matrix/drive-copy')],
  ['src/matrix/drive-import-copy', () => import('../matrix/drive-import-copy')],
  ['src/matrix/execution-machines-copy', () => import('../matrix/execution-machines-copy')],
  ['src/matrix/execution-policy-editor-copy', () => import('../matrix/execution-policy-editor-copy')],
  ['src/matrix/founder/founder-copy', () => import('../matrix/founder/founder-copy')],
  ['src/matrix/group-picker-copy', () => import('../matrix/group-picker-copy')],
  ['src/matrix/hermes-setup-copy', () => import('../matrix/hermes-setup-copy')],
  ['src/matrix/launch-copy', () => import('../matrix/launch-copy')],
  ['src/matrix/legal-copy', () => import('../matrix/legal-copy')],
  ['src/matrix/mobile-copy', () => import('../matrix/mobile-copy')],
  ['src/matrix/mobile-device-copy', () => import('../matrix/mobile-device-copy')],
  ['src/matrix/model-picker-copy', () => import('../matrix/model-picker-copy')],
  ['src/matrix/moderation-copy', () => import('../matrix/moderation-copy')],
  ['src/matrix/pet-copy', () => import('../matrix/pet-copy')],
  ['src/matrix/pet/overlay-copy', () => import('../matrix/pet/overlay-copy')],
  ['src/matrix/profile-copy', () => import('../matrix/profile-copy')],
  ['src/matrix/read-state-copy', () => import('../matrix/read-state-copy')],
  ['src/matrix/readiness-copy', () => import('../matrix/readiness-copy')],
  ['src/matrix/roster-copy', () => import('../matrix/roster-copy')],
  ['src/matrix/roster-create-copy', () => import('../matrix/roster-create-copy')],
  ['src/matrix/security-copy', () => import('../matrix/security-copy')],
  ['src/matrix/settings-copy', () => import('../matrix/settings-copy')],
  ['src/matrix/sign-in-copy', () => import('../matrix/sign-in-copy')],
  ['src/matrix/starter-copy', () => import('../matrix/starter-copy')],
  ['src/matrix/store/store-copy', () => import('../matrix/store/store-copy')],
  ['src/matrix/thread-copy', () => import('../matrix/thread-copy')],
  ['src/matrix/updates/copy', () => import('../matrix/updates/copy')],
  ['src/matrix/wallet-copy', () => import('../matrix/wallet-copy')],
  ['src/matrix/workbench-copy', () => import('../matrix/workbench-copy')],
  ['src/matrix/working-copy', () => import('../matrix/working-copy')],
  ['src/matrix/workplace-copy', () => import('../matrix/workplace-copy')]
]

const LOCALES: readonly Locale[] = ['en', 'vi', 'ja', 'zh', 'zh-hant']
const PRODUCT_NAME = /\b(?:Hermes|Matrix)\b/u

/**
 * The narrow, reviewed technical exceptions: whole values that legitimately name the third-party
 * Matrix protocol a settings field configures (it sits beside MATRIX_HOMESERVER and
 * MATRIX_ACCESS_TOKEN), not the internal candidate codename. Everything else must be Atum.
 */
const TECHNICAL_EXCEPTIONS = new Map<string, string>([
  ['Allowed Matrix user IDs', 'The third-party Matrix protocol the MATRIX_ALLOWED_USERS setting configures'],
  ['許可する Matrix ユーザー ID', 'The third-party Matrix protocol the MATRIX_ALLOWED_USERS setting configures'],
  ['允许的 Matrix 用户 ID', 'The third-party Matrix protocol the MATRIX_ALLOWED_USERS setting configures'],
  ['允許的 Matrix 使用者 ID', 'The third-party Matrix protocol the MATRIX_ALLOWED_USERS setting configures']
])

const eachLocale = (build: (locale: Locale) => unknown[][]): unknown[][] => LOCALES.flatMap(build)

const EXECUTION_VIEWS = [
  { kind: 'cloud' },
  { kind: 'mac', macOrdinal: 2, state: 'ready' },
  { kind: 'mac', state: 'degraded', reason: 'entitlement_required' },
  { kind: 'mac', state: 'unavailable', reason: 'data_incompatible' }
]

/**
 * Representative synthetic arguments for functions whose copy is not reachable through an
 * exported value alone (locale-selecting wrappers are covered by the per-locale default plan).
 * These mirror the shapes declared in each module's own types.
 */
const EXPLICIT_PLANS: Record<string, unknown[][]> = {
  'src/matrix/execution-machines-copy::executionMachineName': eachLocale(locale =>
    EXECUTION_VIEWS.map(view => [locale, view])
  ),
  'src/matrix/execution-machines-copy::executionMachineStateLabel': eachLocale(locale =>
    EXECUTION_VIEWS.map(view => [locale, view])
  ),
  'src/matrix/execution-machines-copy::executionMachineLabel': eachLocale(locale =>
    EXECUTION_VIEWS.map(view => [locale, view])
  ),
  'src/matrix/check-ins-copy::matrixCheckInClock': eachLocale(locale => [[new Date(2000, 0, 2, 8, 5), locale]]),
  'src/matrix/check-ins-copy::matrixCheckInTime': eachLocale(locale => [['08:05', locale]]),
  'src/matrix/check-ins-copy::matrixCheckInProtons': eachLocale(locale => [[12, locale]]),
  'src/matrix/execution-policy-editor-copy::executionPolicyStatusAge': eachLocale(locale => [
    [locale, Date.now() - 90_000, Date.now()]
  ]),
  'src/matrix/attention-copy::matrixComposerHint': eachLocale(locale => [
    [{ readiness: { phase: 'starting' } }, 'Moon', matrixAttentionCopy(locale)],
    [{}, 'Moon', matrixAttentionCopy(locale), Date.now()]
  ]),
  'src/matrix/readiness-copy::matrixReadinessCopy': eachLocale(locale => {
    const shell = {
      readinessSetupWaiting: 'Atum is waiting to set up your assistant',
      readinessSetupWaitingUntil: 'Atum will try again at {time}.',
      readinessSetupWaitingHelp: 'You can keep reading your chats.',
      startupHermes: 'Starting your assistant',
      readinessOffline: 'Atum is offline'
    }

    return [
      [{ phase: 'starting', step: 'hermes' }, undefined, shell, 'Opening', locale],
      [
        { phase: 'starting', step: 'assistant', code: 'rate_limited', retryAt: Date.now() + 60_000 },
        undefined,
        shell,
        'Opening',
        locale
      ],
      [{ phase: 'blocked', code: 'offline' }, undefined, shell, 'Opening', locale]
    ]
  }),
  'src/matrix/store/store-copy::storeRequirements': eachLocale(locale => [
    [['internet', 'runs-scripts', 'not-a-requirement'], matrixStoreCopy(locale)]
  ]),
  'shared/matrix-agent-access-band-copy::matrixAgentAccessBandText': eachLocale(locale =>
    MATRIX_CLOUD_ACCESS_REASONS.map(reason => [reason, locale])
  ),
  'shared/matrix-agent-status-copy::matrixAgentStatusText': eachLocale(locale =>
    MATRIX_AGENT_STATUS_CODES.map(code => [code, locale, { devices: ['Moon Mac'] }])
  ),
  'shared/matrix-curator-copy::matrixCuratorConfirmation': eachLocale(locale =>
    (['run', 'pause', 'resume'] as const).map(action => [locale, 'Moon', action])
  ),
  'shared/matrix-command-center-ops-copy::matrixMaintenanceConfirmationCopy': eachLocale(locale =>
    MATRIX_LOCAL_ACTIONS.map(action => [locale, 'Moon', action])
  ),
  'shared/matrix-debug-share-copy::matrixDebugConfirmationCopy': eachLocale(locale =>
    MATRIX_DEBUG_DESTINATIONS.map(destination => [
      locale,
      'Moon',
      { destination, files: [{ label: 'agent.log', bytes: 2048 }] }
    ])
  ),
  'shared/matrix-auxiliary-copy::matrixAuxiliaryConfirmationCopy': eachLocale(locale => [
    [locale, 'Moon', { kind: 'pin', task: 'vision', provider: 'openai', model: 'gpt' }],
    [locale, 'Moon', { kind: 'expensive-model', task: 'vision', provider: 'auto', model: 'gpt' }]
  ]),
  'shared/matrix-runtime-copy::matrixRuntimeConfirmationCopy': eachLocale(locale => [
    [locale, 'Moon', { kind: 'expensive-model', provider: 'openai', model: 'gpt', message: 'Atum asks first.' }],
    [locale, 'Moon', { kind: 'memory', provider: 'builtin' }]
  ]),
  'shared/matrix-management-copy::matrixManagementConfirmationCopy': eachLocale(locale =>
    (
      [
        { kind: 'provider-key', provider: 'openai' },
        { kind: 'provider-select', provider: 'openai', model: 'gpt' },
        { kind: 'provider-endpoint', name: 'Local', baseUrl: 'https://api.example.test/v1', model: 'gpt' },
        { kind: 'provider-oauth', provider: 'openai', planRisk: { policyVersion: '1', acknowledgedAt: '2026-01-01' } },
        { kind: 'provider-disconnect', provider: 'openai' },
        { kind: 'expensive-model', provider: 'openai', model: 'gpt', message: 'Atum asks first.' },
        { kind: 'mcp-add', name: 'kit', transport: 'stdio', target: 'kit serve' },
        { kind: 'mcp-remove', name: 'kit' },
        { kind: 'mcp-enabled', name: 'kit', enabled: true },
        { kind: 'mcp-install', name: 'kit', needsInstall: true },
        { kind: 'mcp-auth', name: 'kit' },
        { kind: 'mcp-test', name: 'kit' },
        { kind: 'mcp-reload' }
      ] as const
    ).map(request => [locale, 'Moon', request])
  ),
  'shared/matrix-tool-settings-copy::matrixTerminalBackendLabel': eachLocale(locale =>
    (['local', 'docker', 'singularity', 'ssh', 'modal', 'daytona'] as const).map(id => [locale, id])
  ),
  'shared/matrix-tool-settings-copy::matrixToolSettingLabel': eachLocale(locale =>
    (['terminal.backend', 'computer_use.max_image_dimension', 'computer_use.capture_after_mode'] as const).map(
      field => [locale, field]
    )
  ),
  'shared/matrix-tool-settings-copy::matrixToolSettingsConfirmationCopy': eachLocale(locale => [
    [locale, 'Moon', { field: 'terminal.backend', value: 'docker' }],
    [locale, 'Moon', { field: 'computer_use.max_image_dimension', value: 2048 }],
    [locale, 'Moon', { field: 'computer_use.capture_after_mode', value: 'vision' }]
  ]),
  'shared/matrix-voice-settings-copy::matrixVoiceFieldLabel': eachLocale(locale =>
    Object.keys(MATRIX_VOICE_SETTING_RULES).map(field => [locale, field])
  ),
  'shared/matrix-voice-settings-copy::matrixVoiceSettingsConfirmationCopy': eachLocale(locale => [
    [locale, 'Moon', { field: 'stt.provider', value: 'local' }]
  ])
}

const scanner = createBrandCopyScanner({
  locales: LOCALES,
  productName: PRODUCT_NAME,
  exceptions: TECHNICAL_EXCEPTIONS,
  explicitPlans: EXPLICIT_PLANS,
  callHook: (path, hook, locale) => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(I18nProvider, { configClient: null, initialLocale: locale, children })
    const { result, unmount } = renderHook(hook, { wrapper })

    try {
      return result.current
    } finally {
      unmount()
    }
  }
})

it('keeps Hermes and Matrix out of every user-visible copy value', async () => {
  const modules = await Promise.all(COPY_MODULES.map(async ([file, load]) => [file, await load()] as const))

  for (const [file, exports] of modules) {
    scanner.scan(file, exports)
  }

  expect(scanner.violations()).toEqual([])
})
