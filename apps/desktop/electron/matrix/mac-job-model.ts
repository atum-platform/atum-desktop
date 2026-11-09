import { createHash } from 'node:crypto'

import { MAC_JOB_MODEL_SIGNATURE_HEADER, MacJobModelEnvelopeSchema } from '../../../../packages/device-protocol/vendor/mac-jobs-0.7.72/mac-jobs'
import { GatewayUpstream } from '../../../../packages/model-client/src/gateway-upstream'

import type { MacJobsOptions } from './mac-jobs'

/** N7a4 signed gateway transport. The header contains a base64url UTF-8 signed
 * envelope {meta,home,request:{method,path,grantDigest}} under MacJobModel.
 * The grant plaintext is carried ONLY by x-atum-model-grant, never by the signature
 * envelope, logs, argv or persistent state. No ordinary-chat fallback is possible.
 */
export { MAC_JOB_MODEL_SIGNATURE_HEADER }

export function macJobModelUpstream(options: MacJobsOptions & { baseUrl: string; assistantId: string }): GatewayUpstream {
  return new GatewayUpstream({
    baseUrl: options.baseUrl,
    transport: async (url, init, request) => {
      const signal = init.signal ?? request.signal

      return options.request(async bearer => {
        signal.throwIfAborted()
        const home = await options.authority(options.assistantId, signal)

        if (!home) {throw new Error('mac_job_not_home')}

        const frame = await options.auth.sign('MacJobModel', meta => ({
          meta, home,
          request: { method: 'POST', path: new URL(url).pathname,
            grantDigest: createHash('sha256').update(request.token, 'utf8').digest('hex') }
        }))

        if (!MacJobModelEnvelopeSchema.safeParse(frame).success) {throw new Error('mac_job_model_invalid')}
        signal.throwIfAborted()
        const headers = new Headers(init.headers)
        headers.set('authorization', `Bearer ${bearer}`)
        headers.delete('x-atum-controller')
        headers.set(MAC_JOB_MODEL_SIGNATURE_HEADER, Buffer.from(JSON.stringify(frame), 'utf8').toString('base64url'))

        return (options.fetch ?? fetch)(url, { ...init, headers, signal, credentials: 'omit', redirect: 'error' })
      }, signal)
    }
  })
}
