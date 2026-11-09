import type { MatrixSnapshot, MatrixSdkCommand } from '../../../apps/desktop/shared/matrix'
import type { MatrixRecoveryKey, MatrixSecurityCommand } from '../../../apps/desktop/shared/matrix-security'
import { connectMatrixSdk } from '../../../apps/desktop/src/matrix/sdk-host-queue'
import { serveMatrixSdk } from '../../../apps/desktop/src/matrix/sdk-host-serve'

import { BrowserFailure } from './record'
import { BoundDevice } from './session'
import { CloudOwnerHandoff } from '../../../apps/desktop/src/matrix/cloud-handoff-owner'

/** One human reader, no execution/delegation authority or raw verification command. */
export function startBrowserRuntime(device: BoundDevice, snapshot: (value: MatrixSnapshot) => void,
  serve: typeof serveMatrixSdk = serveMatrixSdk) {
  const { port, queue } = connectMatrixSdk({ configuration: async () => device.configuration(), refresh: handle => device.refresh(handle), snapshot })
  const { started } = serve(port)
  const ready = started.then(() => device.cryptoStarted())
  // Keep the writer lock until the actual engine stop resolves, not the queue's timeout.
  let stopping: Promise<void> | undefined
  let ownerKey: string | undefined
  let handoff: CloudOwnerHandoff | undefined
  let handoffTimer: ReturnType<typeof setInterval> | undefined
  const stop = () => stopping ??= (async () => {
    handoff?.stop()
    clearInterval(handoffTimer)
    ownerKey=undefined
    const sdk = await started.catch(() => undefined)
    if (sdk) await sdk.stop()
    queue.close()
  })()
  const command = async (value: MatrixSdkCommand) => {
    if (stopping) throw new BrowserFailure('signed_out')
    await ready
    return queue.command(value)
  }
  return {
    ready, stop,
    selectRoom: (roomId: string) => command({ kind: 'select', roomId }),
    createRecoveryKey: () => command({ kind: 'recoveryCreateKey' }) as Promise<MatrixRecoveryKey>,
    setUpRecovery: async (id: string) => {
      ownerKey=await command({kind:'ownerRecovery',command:{kind:'recoverySetUp',id}}) as string
    },
    restoreRecovery: async (key: string) => {
      ownerKey=await command({kind:'ownerRecovery',command:{kind:'recoveryRestore',key}}) as string
    },
    discardRecovery: () => command({ kind: 'recoveryDiscard' }),
    rememberCloudEnrollment: (enrollmentId:string, source:{enrollments():Promise<unknown>;roster():Promise<unknown>}) => {
      if(stopping)throw new BrowserFailure('signed_out')
      handoff??=new CloudOwnerHandoff({deviceId:device.identity().deviceId,...source,
        receive:sender=>command({kind:'agentIdentityToDeviceRead',sender,limit:32}),
        send:async(recipient,event)=>{await command({kind:'agentIdentityToDeviceSend',recipient,event} as MatrixSdkCommand)},
        recoveryKey:async(userId,key)=>{
          if(!ownerKey||stopping)throw new BrowserFailure('recovery_needed')
          return await command({kind:'agentRecoveryKey',userId,ownerKey,...(key?{key}:{})}) as string|null
        }})
      handoff.remember(enrollmentId)
      handoffTimer??=setInterval(()=>void handoff!.pump(),5000)
      void handoff.pump()
    },
    // Public standard SAS flow is available through the same canonical commands.
    verification: (value: Extract<MatrixSecurityCommand, { kind: 'verificationStart' | 'verificationRespond' }>) => {
      if (!['verificationStart', 'verificationRespond'].includes(value.kind)) throw new BrowserFailure('operation_failed')
      return command(value)
    }
  }
}

export function readableMessages(snapshot: MatrixSnapshot) {
  const room = snapshot.rooms.find(r => r.id === snapshot.roomId)
  if (!room?.encrypted || room.membership !== 'join') return []
  return snapshot.messages.filter(message => message.encrypted && !message.decryptionFailed)
}
