import { type MatrixClient, Method } from 'matrix-js-sdk'

import { DEFAULT_DESKTOP_LOCALE, type DesktopLocale } from '../../shared/desktop-locale'
import type { MatrixIdentity } from '../../shared/matrix'
import {
  MATRIX_DISPLAY_EVENTS,
  type MatrixAppearanceMode,
  matrixDisplayPreferenceChange,
  type MatrixDisplayPreferenceChange,
  type MatrixDisplayPreferences,
  type MatrixTextSize
} from '../../shared/matrix-display-preferences'

declare module 'matrix-js-sdk' {
  interface AccountDataEvents {
    'io.atum.desktop.appearance': { version: 1; value: MatrixAppearanceMode; [key: string]: unknown }
    'io.atum.desktop.text_size': { version: 1; value: MatrixTextSize; [key: string]: unknown }
    'io.atum.desktop.language': { version: 1; value: DesktopLocale; [key: string]: unknown }
    'io.atum.desktop.notifications': { version: 1; value: boolean; [key: string]: unknown }
    'io.atum.desktop.sound': { version: 1; value: boolean; [key: string]: unknown }
    'io.atum.desktop.share_activity': { version: 1; value: boolean; [key: string]: unknown }
  }
}

function content(field: MatrixDisplayPreferenceChange['field'], raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const row = raw as Record<string, unknown>

  try {
    matrixDisplayPreferenceChange(field, row.value)

    return row.version === 1 ? row : null
  } catch {
    return null
  }
}

/** Per-field SDK persistence avoids cross-device whole-record clobbering. The only
 * retained state is this SDK's last valid display projection and in-flight writes.
 * `language`: what an account that never chose a language is shown in (the system's
 * language where Atum speaks it, sdk.ts); a choice the account saved always wins. */
export function matrixDisplayPreferences(
  client: MatrixClient,
  identity: MatrixIdentity,
  active: () => boolean,
  language: DesktopLocale = DEFAULT_DESKTOP_LOCALE
) {
  const confirmed: {
    appearance: MatrixAppearanceMode
    textSize: MatrixTextSize
    language: DesktopLocale
    notifications: boolean
    sound: boolean
    shareActivity: boolean
  } = {
    appearance: 'system',
    textSize: 100,
    language,
    notifications: true,
    sound: true,
    // Read receipts and typing are visible to other people unless the person opts out
    // Preserve user-visible identity, state and recovery behavior across connection changes.
    shareActivity: true
  }

  const busy = new Set<MatrixDisplayPreferenceChange['field']>()

  function read(field: MatrixDisplayPreferenceChange['field'], ready: boolean) {
    const raw = client.getAccountData(MATRIX_DISPLAY_EVENTS[field])?.getContent()
    const parsed = content(field, raw)

    // Cached valid cosmetics can render before reconnect; only confirmed absence
    // after initial sync resets defaults. Readiness still gates every write.
    if (parsed || (ready && raw === undefined)) {
      if (field === 'appearance') {
        confirmed.appearance = parsed
          ? (matrixDisplayPreferenceChange(field, parsed.value).value as MatrixAppearanceMode)
          : 'system'
      } else if (field === 'textSize') {
        confirmed.textSize = parsed
          ? (matrixDisplayPreferenceChange(field, parsed.value).value as typeof confirmed.textSize)
          : 100
      } else if (field === 'language') {
        confirmed.language = parsed
          ? (matrixDisplayPreferenceChange(field, parsed.value).value as DesktopLocale)
          : language
      } else {
        confirmed[field] = parsed
          ? (matrixDisplayPreferenceChange(field, parsed.value).value as boolean)
          : true
      }
    }

    return {
      value: confirmed[field],
      writable: ready && (raw === undefined || Boolean(parsed))
    }
  }

  return {
    snapshot(ready: boolean): MatrixDisplayPreferences {
      return {
        appearance: read('appearance', ready),
        textSize: read('textSize', ready),
        language: read('language', ready),
        notifications: read('notifications', ready),
        sound: read('sound', ready),
        shareActivity: read('shareActivity', ready)
      } as MatrixDisplayPreferences
    },
    async change(input: MatrixDisplayPreferenceChange & { identity: MatrixIdentity }) {
      const change = matrixDisplayPreferenceChange(input.field, input.value)

      if (
        !active() ||
        input.identity.userId !== identity.userId ||
        input.identity.deviceId !== identity.deviceId ||
        client.getUserId() !== identity.userId
      ) {
        throw new Error('matrix_display_preference_stale')
      }

      if (busy.has(change.field)) {
        throw new Error('matrix_display_preference_pending')
      }

      busy.add(change.field)

      try {
        const type = MATRIX_DISPLAY_EVENTS[change.field]

        // Fresh per-field read preserves extensions and refuses newer schemas even
        // if this device's last sync still contains an older writable record.
        const raw = await client.http
          .authedRequest<unknown>(
            Method.Get,
            `/user/${encodeURIComponent(client.getSafeUserId())}/account_data/${type}`
          )
          .catch(error => {
            if (error?.errcode === 'M_NOT_FOUND') {
              return undefined
            }

            throw error
          })

        const previous = raw === undefined ? {} : content(change.field, raw)

        if (!previous) {
          throw new Error('matrix_display_preference_readonly')
        }

        if (!active()) {
          throw new Error('matrix_display_preference_stale')
        }

        // No cache mutation: HTTP acknowledgement never fabricates a sync echo.
        await client.setAccountDataRaw(type, { ...previous, version: 1, value: change.value })

        if (!active()) {
          throw new Error('matrix_display_preference_stale')
        }
      } finally {
        busy.delete(change.field)
      }
    }
  }
}
