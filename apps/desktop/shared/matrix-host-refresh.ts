import { TokenRefreshError } from 'matrix-js-sdk/lib/http-api/errors'

import type { MatrixRefreshResult } from './matrix'

/** SDK 43 removed the external refresh callback. Its OAuth refresh requires the
 * real secret in the SDK; host-owned credentials instead use the public fetch
 * and setAccessToken boundaries. Never send the opaque host handle over HTTP.
 */
export function matrixHostRefresh(options: {
  baseUrl: string
  accessToken: string
  handle?: string
  refresh: (handle: string) => Promise<MatrixRefreshResult>
  apply: (accessToken: string) => void
  active: () => boolean
  fetcher: typeof fetch
}) {
  let token = options.accessToken
  let handle = options.handle
  let pending: Promise<MatrixRefreshResult> | undefined

  const renew = () => {
    if (!handle || !options.active()) {return Promise.resolve<MatrixRefreshResult>({ ok: false, reauthenticate: false })}

    return (pending ??= options
      .refresh(handle)
      .then(result => {
        if (result.ok && options.active()) {
          token = result.accessToken
          handle = result.refreshToken ?? handle
          options.apply(token)
        }

        return result
      })
      .finally(() => {
        pending = undefined
      }))
  }

  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)

    const eligible =
      Boolean(handle) &&
      url.origin === new URL(options.baseUrl).origin &&
      url.pathname.includes('/_matrix/') &&
      request.headers.get('authorization') === `Bearer ${token}`

    // Keep a replayable copy before fetch consumes the request body.
    const retry = eligible ? request.clone() : undefined
    const sentToken = token
    const response = await options.fetcher(input, init)

    if (!retry || response.status !== 401 || !options.active()) {return response}

    const error = await response
      .clone()
      .json()
      .catch(() => undefined)

    if (error?.errcode !== 'M_UNKNOWN_TOKEN') {return response}

    if (sentToken === token) {
      const result = await renew()

      if (!options.active()) {throw new TokenRefreshError(new Error('matrix_stopped'))}

      if (!result.ok) {
        if (result.reauthenticate) {return response} // SDK emits its normal logout event.
        throw new TokenRefreshError(new Error('matrix_refresh_unavailable'))
      }
    }

    retry.headers.set('authorization', `Bearer ${token}`)

    // Exactly one retry; a second refusal goes through the SDK's logout handling.
    return options.fetcher(retry)
  }

  return { renew, fetcher }
}
