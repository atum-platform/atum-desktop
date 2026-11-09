import { EventEmitter } from 'node:events'

import { type MatrixClient, MatrixError } from 'matrix-js-sdk'
import { VerificationPhase } from 'matrix-js-sdk/lib/crypto-api'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent'
import { encodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key'
import { calculateKeyCheck } from 'matrix-js-sdk/lib/secret-storage'
import { afterEach, describe, expect, it, vi } from 'vitest'

const deviceVerification = vi.hoisted(() => ({ loadIdentity: vi.fn(async () => {}) }))

vi.mock('./sdk-device-verification', () => ({
  loadIdentityForVerification: deviceVerification.loadIdentity
}))

import { matrixSecurity, recoveryKeyCache, verificationCancellation } from './security'

const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach(stop => stop())
  deviceVerification.loadIdentity.mockClear()
  vi.useRealTimers()
})

function fixture() {
  const client = new EventEmitter()

  const crypto = {
    getUserDeviceInfo: vi.fn(async () => new Map()),
    userHasCrossSigningKeys: vi.fn(async () => true),
    getCrossSigningStatus: vi.fn(async () => ({
      publicKeysOnDevice: false,
      privateKeysCachedLocally: { masterKey: false, selfSigningKey: false, userSigningKey: false }
    })),
    checkKeyBackupAndEnable: vi.fn(async (): Promise<unknown> => null),
    createRecoveryKeyFromPassphrase: vi.fn(async () => ({
      privateKey: new Uint8Array(32).fill(1),
      encodedPrivateKey: 'synthetic-display-key'
    })),
    bootstrapCrossSigning: vi.fn(async () => {}),
    bootstrapSecretStorage: vi.fn(async () => {}),
    isSecretStorageReady: vi.fn(async () => true),
    getActiveSessionBackupVersion: vi.fn(async () => '1'),
    requestDeviceVerification: vi.fn(),
    crossSignDevice: vi.fn(async () => {}),
    isCrossSigningReady: vi.fn(async () => true),
    loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
    restoreKeyBackup: vi.fn(async () => ({ imported: 2 }))
  }

  const storage = {
    getDefaultKeyId: vi.fn(async (): Promise<string | null> => null),
    getKey: vi.fn(async () => [
      'key-id',
      { algorithm: 'm.secret_storage.v1.aes-hmac-sha2', iv: 'synthetic-iv', mac: 'synthetic-mac' }
    ]),
    checkKey: vi.fn(async () => true),
    get: vi.fn(async (): Promise<string | null> => 'synthetic-encrypted-secret')
  }

  const http = {
    authedRequest: vi.fn(async (): Promise<unknown> => {
      throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'No backup' }, 404)
    })
  }

  // Synced account data: before the first sync nothing is known about recovery.
  const synced = { complete: false, defaultKey: undefined as unknown }

  Object.assign(client, {
    getCrypto: () => crypto,
    getUserId: () => '@alice:test',
    getDeviceId: () => 'A',
    isInitialSyncComplete: () => synced.complete,
    getAccountData: (type: string) =>
      type === 'm.secret_storage.default_key' && synced.defaultKey !== undefined
        ? { getContent: () => synced.defaultKey }
        : undefined,
    secretStorage: storage,
    setAccountData: vi.fn(async () => ({})),
    http
  })
  const cache = recoveryKeyCache()
  const changed = vi.fn()
  const security = matrixSecurity(client as unknown as MatrixClient, cache, changed)
  stops.push(() => security.stop())

  return { client, crypto, storage, http, cache, changed, security, synced }
}

function request() {
  const req = new EventEmitter()

  const change = (phase: VerificationPhase) => {
    Object.assign(req, { phase, pending: phase !== VerificationPhase.Done && phase !== VerificationPhase.Cancelled })
    req.emit('change')
  }

  const sas = {
    sas: { decimal: [1, 2, 3], emoji: [['🐶', 'dog']] },
    confirm: vi.fn(async () => change(VerificationPhase.Done)),
    mismatch: vi.fn(() => change(VerificationPhase.Cancelled))
  }

  const verifier = Object.assign(new EventEmitter(), {
    verify: vi.fn(() => new Promise(() => {})),
    getShowSasCallbacks: () => sas
  })

  return Object.assign(req, {
    pending: true,
    initiatedByMe: false,
    otherUserId: '@alice:test',
    otherDeviceId: 'B',
    phase: VerificationPhase.Requested,
    cancel: vi.fn(async () => change(VerificationPhase.Cancelled)),
    accept: vi.fn(async () => change(VerificationPhase.Ready)),
    startVerification: vi.fn(async () => {
      Object.assign(req, { verifier })
      change(VerificationPhase.Started)

      return verifier
    }),
    sas,
    change
  })
}

describe('Matrix SDK security presentation adapter', () => {
  it('keeps enrollment-bound standard SAS off the renderer and confirms only its exact native flow',async()=>{
    const f=fixture(), req=request()
    const deviceId='ATUM_COMPANION_11111111-2222-4333-8444-555555555555'
    Object.assign(req,{isSelfVerification:true,otherDeviceId:deviceId,transactionId:'actual-flow',chosenMethod:'m.sas.v1'})
    req.sas.sas.decimal=[1000,9191,4000]
    await f.security.nativeCommand({kind:'ownerReaderVerificationPrepare',deviceId,expiresAt:Date.now()+60000})
    f.client.emit(CryptoEvent.VerificationRequestReceived,req)
    await vi.waitFor(()=>expect(req.accept).toHaveBeenCalledOnce())
    await req.startVerification()
    expect(f.security.snapshot().verification).toBeUndefined()
    await expect(f.security.nativeCommand({kind:'ownerReaderVerificationRead',deviceId})).resolves.toEqual({flowId:'actual-flow',decimal:[1000,9191,4000]})
    await expect(f.security.command({kind:'verificationRespond',id:'guessed-native-id',action:'confirm'})).rejects.toThrow('matrix_verification_stale')
    await expect(f.security.nativeCommand({kind:'ownerReaderVerificationRespond',deviceId,flowId:'wrong-flow',decimal:[1000,9191,4000],action:'confirm'})).rejects.toThrow('matrix_owner_reader_stale')
    expect(req.sas.confirm).not.toHaveBeenCalled()
    await f.security.nativeCommand({kind:'ownerReaderVerificationRespond',deviceId,flowId:'actual-flow',decimal:[1000,9191,4000],action:'confirm'})
    expect(req.sas.confirm).toHaveBeenCalledOnce()
    expect(f.security.snapshot().verification).toBeUndefined()
  })

  it('expires the pinned native verifier and never confirms after teardown',async()=>{
    const f=fixture(), req=request(),deviceId='ATUM_COMPANION_11111111-2222-4333-8444-555555555555'
    Object.assign(req,{isSelfVerification:true,otherDeviceId:deviceId,transactionId:'actual-flow',chosenMethod:'m.sas.v1'})
    req.sas.sas.decimal=[1000,9191,4000]
    await f.security.nativeCommand({kind:'ownerReaderVerificationPrepare',deviceId,expiresAt:Date.now()+30})
    f.client.emit(CryptoEvent.VerificationRequestReceived,req)
    await vi.waitFor(()=>expect(req.cancel).toHaveBeenCalled())
    expect(req.sas.confirm).not.toHaveBeenCalled()
    f.security.stop()
    await expect(f.security.nativeCommand({kind:'ownerReaderVerificationRead',deviceId})).rejects.toThrow('matrix_security_stopped')
  })

  it('refuses a native verdict once the pinned deadline passes even before its timer runs', async () => {
    vi.useFakeTimers()
    const f = fixture(), req = request()
    const deviceId = 'ATUM_COMPANION_11111111-2222-4333-8444-555555555555'
    Object.assign(req, { isSelfVerification: true, otherDeviceId: deviceId, transactionId: 'actual-flow', chosenMethod: 'm.sas.v1' })
    req.sas.sas.decimal = [1000, 9191, 4000]
    await f.security.nativeCommand({ kind: 'ownerReaderVerificationPrepare', deviceId, expiresAt: Date.now() + 60000 })
    f.client.emit(CryptoEvent.VerificationRequestReceived, req)
    await req.startVerification()
    vi.setSystemTime(Date.now() + 60001)
    await expect(f.security.nativeCommand({ kind: 'ownerReaderVerificationRespond', deviceId, flowId: 'actual-flow', decimal: [1000, 9191, 4000], action: 'confirm' })).resolves.toBeNull()
    expect(req.sas.confirm).not.toHaveBeenCalled()
  })

  it('cross-signs only a bounded native reader target without opening a verification or recovery flow', async () => {
    const { security, crypto } = fixture()
    const deviceId = 'ATUM_COMPANION_11111111-2222-4333-8444-555555555555'
    crypto.getUserDeviceInfo.mockResolvedValueOnce(new Map([['@alice:test', new Map([[deviceId, {}]])]]))

    await expect(security.nativeCommand({ kind: 'ownerReaderCrossSignDevice', deviceId })).resolves.toBeNull()
    expect(crypto.isCrossSigningReady).toHaveBeenCalledOnce()
    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledExactlyOnceWith('@alice:test', true)
    expect(crypto.getUserDeviceInfo).toHaveBeenCalledExactlyOnceWith(['@alice:test'], false)
    expect(crypto.crossSignDevice).toHaveBeenCalledExactlyOnceWith(deviceId)
    expect(crypto.requestDeviceVerification).not.toHaveBeenCalled()
  })

  it('refuses to cross-sign a reader absent from the refreshed owner device list', async () => {
    const { security, crypto } = fixture()

    await expect(security.nativeCommand({ kind: 'ownerReaderCrossSignDevice', deviceId: 'ATUM_COMPANION_11111111-2222-4333-8444-555555555555' })).rejects.toThrow('matrix_owner_reader_device_unavailable')
    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledExactlyOnceWith('@alice:test', true)
    expect(crypto.crossSignDevice).not.toHaveBeenCalled()
  })

  it('refuses reader signing when the owner keys are not ready or the target is malformed', async () => {
    const { security, crypto } = fixture()
    crypto.isCrossSigningReady.mockResolvedValue(false)
    await expect(security.nativeCommand({ kind: 'ownerReaderCrossSignDevice', deviceId: 'ATUM_COMPANION_11111111-2222-4333-8444-555555555555' })).rejects.toThrow('cross_signing_unavailable')

    for (const deviceId of ['ATUM_COMPANION_READER', 'HUMAN_DEVICE', 'reader\nother']) {
      await expect(security.nativeCommand({ kind: 'ownerReaderCrossSignDevice', deviceId })).rejects.toThrow('owner_reader_invalid')
    }

    expect(crypto.crossSignDevice).not.toHaveBeenCalled()
  })

  it('says whether the account already has a recovery key, from synced account data only', () => {
    const { security, synced } = fixture()
    expect(security.snapshot().storage).toBeUndefined()
    synced.complete = true
    expect(security.snapshot().storage).toBe('absent')
    synced.defaultKey = {}
    expect(security.snapshot().storage).toBe('absent')
    synced.defaultKey = { key: 'key-id' }
    expect(security.snapshot().storage).toBe('present')
    // A presentation fact: nothing secret rides along.
    expect(JSON.stringify(security.snapshot())).not.toContain('key-id')
  })

  it('counts each replacement of the identity this device verified, so main checks its kept key again', () => {
    const { client, changed, security } = fixture()

    const trust = (was: boolean, is: boolean) => ({
      wasCrossSigningVerified: () => was,
      isCrossSigningVerified: () => is
    })

    expect(security.snapshot().identityChanges).toBeUndefined()

    // This device verifying the identity, someone else's identity, or a new Mac's first look: no.
    client.emit(CryptoEvent.UserTrustStatusChanged, '@alice:test', trust(true, true))
    client.emit(CryptoEvent.UserTrustStatusChanged, '@alice:test', trust(false, false))
    client.emit(CryptoEvent.UserTrustStatusChanged, '@bob:test', trust(true, false))
    expect(security.snapshot().identityChanges).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()

    // Replaced from another device or sign-in: counted, and the window and main hear of it.
    client.emit(CryptoEvent.UserTrustStatusChanged, '@alice:test', trust(true, false))
    expect(security.snapshot().identityChanges).toBe(1)
    expect(changed).toHaveBeenCalledOnce()

    security.stop()
    client.emit(CryptoEvent.UserTrustStatusChanged, '@alice:test', trust(true, false))
    expect(changed).toHaveBeenCalledOnce()
  })

  it('counts changes to the person’s own device list only, so main reads which ones need verifying', () => {
    const { client, changed, security } = fixture()

    // Someone else's devices, or nothing at all: no.
    client.emit(CryptoEvent.DevicesUpdated, ['@bob:test'], false)
    client.emit(CryptoEvent.DevicesUpdated, [], true)
    expect(security.snapshot().ownDevicesChanges).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()

    // A phone signs in, or is signed: counted, and main hears of it.
    client.emit(CryptoEvent.DevicesUpdated, ['@bob:test', '@alice:test'], false)
    expect(security.snapshot().ownDevicesChanges).toBe(1)
    expect(changed).toHaveBeenCalledOnce()

    security.stop()
    client.emit(CryptoEvent.DevicesUpdated, ['@alice:test'], false)
    expect(changed).toHaveBeenCalledOnce()
  })

  it('native recovery never returns a failed or incomplete key to the vault', async () => {
    const { security, storage } = fixture()
    storage.get.mockResolvedValue(null)
    await expect(
      security.nativeCommand({
        kind: 'ownerRecovery',
        command: {
          kind: 'recoveryRestore',
          key: encodeRecoveryKey(new Uint8Array(32).fill(3))!
        }
      })
    ).rejects.toThrow('incomplete')
    expect(security.snapshot()).toEqual({ recovery: 'failed' })
  })

  it('rejects overlapping preparation and cannot retain a key produced after teardown', async () => {
    const { security, crypto } = fixture()
    let resolve!: (key: { privateKey: Uint8Array<ArrayBuffer>; encodedPrivateKey: string }) => void
    crypto.createRecoveryKeyFromPassphrase.mockImplementation(
      () =>
        new Promise(yes => {
          resolve = yes
        })
    )
    const first = security.command({ kind: 'recoveryCreateKey' })
    await vi.waitFor(() => expect(crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledOnce())
    await expect(security.command({ kind: 'recoveryCreateKey' })).rejects.toThrow('pending')
    security.stop()
    const key = new Uint8Array(32).fill(4)
    resolve({ privateKey: key, encodedPrivateKey: 'never-publish' })
    await expect(first).rejects.toThrow('stopped')
    expect(key.every(byte => byte === 0)).toBe(true)
  })
  it('compares SDK SAS, never marks trust locally, and rejects stale or wrong-phase confirmation', async () => {
    const { client, security } = fixture()
    const req = request()
    client.emit(CryptoEvent.VerificationRequestReceived, req)
    const id = security.snapshot().verification!.id
    await expect(security.command({ kind: 'verificationRespond', id, action: 'confirm' })).rejects.toThrow('phase')
    await security.command({ kind: 'verificationRespond', id, action: 'accept' })
    await security.command({ kind: 'verificationRespond', id, action: 'start' })
    expect(security.snapshot().verification).toMatchObject({
      state: 'compare',
      decimals: [1, 2, 3],
      emoji: [['🐶', 'dog']]
    })
    await security.command({ kind: 'verificationRespond', id, action: 'mismatch' })
    expect(security.snapshot().verification).toMatchObject({ state: 'cancelled' })
    await expect(security.command({ kind: 'verificationRespond', id, action: 'confirm' })).rejects.toThrow('stale')
    expect(req.sas.confirm).not.toHaveBeenCalled()
  })
  it('names a cancel’s protocol code, and between two people which side ended it', () => {
    const { client, security } = fixture()
    const req = request()
    Object.assign(req, { otherUserId: '@agent:test', otherDeviceId: 'AGENT' })
    client.emit(CryptoEvent.VerificationRequestReceived, req)
    Object.assign(req, { cancellationCode: 'm.key_mismatch', cancellingUserId: '@alice:test' })
    req.change(VerificationPhase.Cancelled)
    expect(security.snapshot().verification).toMatchObject({
      state: 'cancelled',
      cancelCode: 'm.key_mismatch',
      cancelledBy: 'self'
    })

    // The other person ended it.
    expect(
      verificationCancellation(
        { cancellationCode: 'm.user', cancellingUserId: '@agent:test', otherUserId: '@agent:test' },
        '@alice:test'
      )
    ).toEqual({ cancelCode: 'm.user', cancelledBy: 'peer' })
    // One person's own devices: the code, never a side (both sides are "me").
    expect(
      verificationCancellation(
        { cancellationCode: 'm.timeout', cancellingUserId: '@alice:test', otherUserId: '@alice:test' },
        '@alice:test'
      )
    ).toEqual({ cancelCode: 'm.timeout' })
    // Free text is never a code.
    expect(
      verificationCancellation(
        { cancellationCode: 'the other side said no', cancellingUserId: undefined, otherUserId: '@agent:test' },
        '@alice:test'
      )
    ).toEqual({})
  })
  it('rejects competing requests and stops publishing after teardown', () => {
    const { client, security, changed } = fixture()

    const first = request(),
      second = request()

    client.emit(CryptoEvent.VerificationRequestReceived, first)
    client.emit(CryptoEvent.VerificationRequestReceived, second)
    expect(second.cancel).toHaveBeenCalledOnce()
    security.stop()
    const count = changed.mock.calls.length
    first.change(VerificationPhase.Done)
    expect(changed).toHaveBeenCalledTimes(count)
    expect(client.listenerCount(CryptoEvent.VerificationRequestReceived)).toBe(0)
  })
  it('puts an incoming owner-device request ahead of an outgoing cross-user check', async () => {
    const { client, crypto, security } = fixture()
    const background = request()
    Object.assign(background, {
      initiatedByMe: true,
      isSelfVerification: false,
      otherUserId: '@agent:test',
      otherDeviceId: 'AGENT'
    })
    const phone = request()
    Object.assign(phone, {
      initiatedByMe: false,
      isSelfVerification: true,
      otherUserId: '@alice:test',
      otherDeviceId: 'PHONE'
    })

    crypto.requestDeviceVerification.mockResolvedValueOnce(background)
    await security.nativeCommand({ kind: 'agentVerificationStart', userId: '@agent:test', deviceId: 'AGENT' })
    client.emit(CryptoEvent.VerificationRequestReceived, phone)

    await vi.waitFor(() => expect(background.cancel).toHaveBeenCalledOnce())
    expect(phone.cancel).not.toHaveBeenCalled()
    expect(security.snapshot().verification).toMatchObject({
      incoming: true,
      userId: '@alice:test',
      deviceId: 'PHONE',
      state: 'requested'
    })

    // A late event from the detached quiet request cannot replace the phone.
    background.change(VerificationPhase.Cancelled)
    expect(security.snapshot().verification).toMatchObject({ deviceId: 'PHONE', state: 'requested' })
    await expect(
      security.command({ kind: 'verificationStart', userId: '@friend:test', deviceId: 'FRIEND' })
    ).rejects.toThrow('matrix_verification_pending')

    // Once the phone is done, the fail-closed agent gate can start a fresh check.
    phone.change(VerificationPhase.Done)
    const retry = request()
    Object.assign(retry, {
      initiatedByMe: true,
      isSelfVerification: false,
      otherUserId: '@agent:test',
      otherDeviceId: 'AGENT'
    })
    crypto.requestDeviceVerification.mockResolvedValueOnce(retry)
    await expect(
      security.nativeCommand({ kind: 'agentVerificationStart', userId: '@agent:test', deviceId: 'AGENT' })
    ).resolves.toBeNull()
    expect(security.snapshot().verification).toMatchObject({ deviceId: 'AGENT', state: 'requested' })
  })
  it.each([
    {
      name: 'another incoming owner device',
      current: { initiatedByMe: false, isSelfVerification: true, otherUserId: '@alice:test' }
    },
    {
      name: 'an outgoing owner-device request',
      current: { initiatedByMe: true, isSelfVerification: true, otherUserId: '@alice:test' }
    },
    {
      name: 'an incoming cross-user request',
      current: { initiatedByMe: false, isSelfVerification: false, otherUserId: '@friend:test' }
    },
    {
      name: 'a person-started outgoing cross-user request',
      current: { initiatedByMe: true, isSelfVerification: false, otherUserId: '@friend:test' }
    }
  ])('keeps $name ahead of a new owner-device request', ({ current: shape }) => {
    const { client, security } = fixture()
    const current = request()
    Object.assign(current, shape, { otherDeviceId: 'CURRENT' })
    const phone = request()
    Object.assign(phone, {
      initiatedByMe: false,
      isSelfVerification: true,
      otherUserId: '@alice:test',
      otherDeviceId: 'PHONE'
    })

    client.emit(CryptoEvent.VerificationRequestReceived, current)
    client.emit(CryptoEvent.VerificationRequestReceived, phone)

    expect(current.cancel).not.toHaveBeenCalled()
    expect(phone.cancel).toHaveBeenCalledOnce()
    expect(security.snapshot().verification).toMatchObject({ deviceId: 'CURRENT', state: 'requested' })
  })
  it('keeps an active owner-reader verification ahead of a new owner-device request', async () => {
    const { client, security } = fixture()
    const reader = request()
    const readerDevice = 'ATUM_COMPANION_11111111-2222-4333-8444-555555555555'
    Object.assign(reader, {
      isSelfVerification: true,
      otherDeviceId: readerDevice,
      transactionId: 'reader-flow',
      chosenMethod: 'm.sas.v1'
    })
    await security.nativeCommand({
      kind: 'ownerReaderVerificationPrepare',
      deviceId: readerDevice,
      expiresAt: Date.now() + 60_000
    })
    client.emit(CryptoEvent.VerificationRequestReceived, reader)
    await vi.waitFor(() => expect(reader.accept).toHaveBeenCalledOnce())

    const phone = request()
    Object.assign(phone, { isSelfVerification: true, otherDeviceId: 'PHONE' })
    client.emit(CryptoEvent.VerificationRequestReceived, phone)

    expect(reader.cancel).not.toHaveBeenCalled()
    expect(phone.cancel).toHaveBeenCalledOnce()
    expect(security.snapshot().verification).toBeUndefined()
  })
  it('keeps the phone when a later cross-user request arrives', () => {
    const { client, security } = fixture()
    const phone = request()
    Object.assign(phone, { isSelfVerification: true, otherDeviceId: 'PHONE' })
    const later = request()
    Object.assign(later, {
      initiatedByMe: true,
      isSelfVerification: false,
      otherUserId: '@agent:test',
      otherDeviceId: 'AGENT'
    })

    client.emit(CryptoEvent.VerificationRequestReceived, phone)
    client.emit(CryptoEvent.VerificationRequestReceived, later)

    expect(phone.cancel).not.toHaveBeenCalled()
    expect(later.cancel).toHaveBeenCalledOnce()
    expect(security.snapshot().verification).toMatchObject({ deviceId: 'PHONE', state: 'requested' })
  })
  it('does not displace a quiet agent check for a replayed terminal owner-device request', async () => {
    const { client, crypto, security } = fixture()
    const background = request()
    Object.assign(background, {
      initiatedByMe: true,
      isSelfVerification: false,
      otherUserId: '@agent:test',
      otherDeviceId: 'AGENT'
    })
    crypto.requestDeviceVerification.mockResolvedValueOnce(background)
    await security.nativeCommand({ kind: 'agentVerificationStart', userId: '@agent:test', deviceId: 'AGENT' })

    const terminal = request()
    Object.assign(terminal, {
      pending: false,
      phase: VerificationPhase.Done,
      isSelfVerification: true,
      otherDeviceId: 'PHONE'
    })
    client.emit(CryptoEvent.VerificationRequestReceived, terminal)

    expect(background.cancel).not.toHaveBeenCalled()
    expect(terminal.cancel).toHaveBeenCalledOnce()
    expect(security.snapshot().verification).toMatchObject({ deviceId: 'AGENT', state: 'requested' })
  })
  it('never creates over an existing secret store, backup, or unknown signing identity', async () => {
    for (const existing of ['storage', 'backup', 'identity']) {
      const { security, storage, http, crypto } = fixture()

      if (existing === 'storage') {
        storage.getDefaultKeyId.mockResolvedValue('existing')
      }

      if (existing === 'backup') {
        http.authedRequest.mockResolvedValue({ version: 'existing' })
      }

      if (existing === 'identity') {
        crypto.getCrossSigningStatus.mockResolvedValue({
          publicKeysOnDevice: true,
          privateKeysCachedLocally: { masterKey: false, selfSigningKey: false, userSigningKey: false }
        })
      }

      await expect(security.command({ kind: 'recoveryCreateKey' })).rejects.toThrow('exists')
      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled()
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
    }
  })
  it('fails closed on backup discovery failures even when the SDK status helper reports null', async () => {
    for (const error of [
      new Error('network failed'),
      new MatrixError({ errcode: 'M_UNKNOWN', error: 'Server error' }, 503),
      new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Slow down' }, 429),
      new MatrixError({ errcode: 'M_UNRECOGNIZED', error: 'Wrong endpoint' }, 404),
      new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Not a protocol absence' }, 500)
    ]) {
      const { security, http, crypto } = fixture()
      http.authedRequest.mockRejectedValue(error)
      await expect(security.command({ kind: 'recoveryCreateKey' })).rejects.toBe(error)
      expect(crypto.checkKeyBackupAndEnable).not.toHaveBeenCalled()
      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled()
      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled()
    }
  })
  it('rechecks absence after signing and never bootstraps backup on a failed or changed response', async () => {
    for (const mode of ['error', 'exists']) {
      const { security, http, crypto } = fixture()
      const { id } = (await security.command({ kind: 'recoveryCreateKey' })) as { id: string }
      crypto.bootstrapCrossSigning.mockImplementation(async () => {
        if (mode === 'error') {
          http.authedRequest.mockRejectedValue(new Error('network failed'))
        } else {
          http.authedRequest.mockResolvedValue({ version: 'created-elsewhere' })
        }
      })
      await security.command({ kind: 'recoverySetUp', id })
      await vi.waitFor(() => expect(security.snapshot().recovery).toBe('failed'))
      expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce()
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled()
      const generated = await crypto.createRecoveryKeyFromPassphrase.mock.results[0].value
      expect(generated.privateKey.every((byte: number) => byte === 0)).toBe(true)
    }
  })
  it('requires the still-live saved-key confirmation and clears expired private key bytes', async () => {
    vi.useFakeTimers()
    const { security, crypto } = fixture()
    const created = (await security.command({ kind: 'recoveryCreateKey' })) as { id: string }
    expect(JSON.stringify(security.snapshot())).not.toContain('synthetic-display-key')
    const key = await crypto.createRecoveryKeyFromPassphrase.mock.results[0].value
    await vi.advanceTimersByTimeAsync(120_001)
    await expect(security.command({ kind: 'recoverySetUp', id: created.id })).rejects.toThrow('stale')
    expect(key.privateKey.every((byte: number) => byte === 0)).toBe(true)
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled()
  })
  it('rechecks server state after saved-key confirmation instead of overwriting a concurrent setup', async () => {
    const { security, storage, crypto } = fixture()
    const { id } = (await security.command({ kind: 'recoveryCreateKey' })) as { id: string }
    storage.getDefaultKeyId.mockResolvedValue('created-elsewhere')
    await security.command({ kind: 'recoverySetUp', id })
    await vi.waitFor(() => expect(security.snapshot().recovery).toBe('failed'))
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
  })
  it('rejects a wrong valid-format key without bootstrap or backup writes', async () => {
    const { security, storage, crypto } = fixture()
    storage.checkKey.mockResolvedValue(false)
    await security.command({ kind: 'recoveryRestore', key: encodeRecoveryKey(new Uint8Array(32).fill(9))! })
    await vi.waitFor(() => expect(security.snapshot().recovery).toBe('failed'))
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
    expect(crypto.restoreKeyBackup).not.toHaveBeenCalled()
  })
  it('does not invoke bootstrap on incomplete cross-signing secrets and clears the callback cache', async () => {
    const { security, storage, cache, crypto } = fixture()
    storage.get.mockResolvedValue(null)
    await security.command({ kind: 'recoveryRestore', key: encodeRecoveryKey(new Uint8Array(32).fill(9))! })
    await vi.waitFor(() => expect(security.snapshot().recovery).toBe('failed'))
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
    expect(await cache.callbacks.getSecretStorageKey!({ keys: { 'key-id': {} as never } }, 'test')).toBeNull()
  })
  it('restores with SDK APIs, never resets or saves the recovery key in presentation state', async () => {
    const { security, crypto, cache } = fixture()
    const key = encodeRecoveryKey(new Uint8Array(32).fill(9))!
    await security.command({ kind: 'recoveryRestore', key })
    await vi.waitFor(() => expect(security.snapshot()).toMatchObject({ recovery: 'ready', restored: 2 }))
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({})
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledOnce()
    expect(crypto.restoreKeyBackup).toHaveBeenCalledOnce()
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled()
    expect(JSON.stringify(security.snapshot())).not.toContain(key)
    expect(await cache.callbacks.getSecretStorageKey!({ keys: { 'key-id': {} as never } }, 'test')).toBeNull()
  })
})

/** The account's recovery as the server holds it (the authoritative reads secret-storage.ts
 * makes): a default key whose check (`iv`/`mac`) was made with `key`. */
async function serverRecovery(
  http: ReturnType<typeof fixture>['http'],
  key: Uint8Array<ArrayBuffer>,
  /** The key description's check as the server serves it: by default the real one. */
  check?: { iv?: string; mac?: string }
) {
  const { iv, mac } = check ?? (await calculateKeyCheck(key))

  http.authedRequest.mockImplementation(async (...args: unknown[]) => {
    const path = String(args[1])

    if (path.endsWith('/account_data/m.secret_storage.default_key')) {
      return { key: 'key-id' }
    }

    if (path.endsWith('/account_data/m.secret_storage.key.key-id')) {
      return {
        algorithm: 'm.secret_storage.v1.aes-hmac-sha2',
        ...(iv !== undefined ? { iv } : {}),
        ...(mac !== undefined ? { mac } : {})
      }
    }

    throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Not found' }, 404)
  })
}

describe('the person’s own recovery, for main’s silent unlock and agent trust', () => {
  const right = new Uint8Array(32).fill(7)
  const wrong = new Uint8Array(32).fill(8)

  function extended() {
    const value = fixture()

    Object.assign(value.crypto, {
      isCrossSigningReady: vi.fn(async () => false),
      getDeviceVerificationStatus: vi.fn(async (): Promise<unknown> => ({ crossSigningVerified: false })),
      getSessionBackupPrivateKey: vi.fn(async (): Promise<Uint8Array | null> => null),
      crossSignDevice: vi.fn(async () => {}),
      getOwnDeviceKeys: vi.fn(async () => ({ ed25519: 'own-ed25519', curve25519: 'own-curve25519' })),
      getUserVerificationStatus: vi.fn(async () => ({ known: true, isCrossSigningVerified: () => true }))
    })

    return value as typeof value & { crypto: typeof value.crypto & Record<string, ReturnType<typeof vi.fn>> }
  }

  it('says what this device still lacks, with flags and a public key id only', async () => {
    const { security, synced, storage, crypto } = extended()
    expect(await security.nativeCommand({ kind: 'ownerStatus' })).toEqual({
      signing: false,
      deviceSigned: false,
      backup: false,
      ownKey: 'own-ed25519'
    })

    synced.complete = true
    synced.defaultKey = { key: 'key-id' }
    storage.getDefaultKeyId.mockResolvedValue('key-id')
    crypto.isCrossSigningReady.mockResolvedValue(true)
    crypto.getDeviceVerificationStatus.mockResolvedValue({ crossSigningVerified: true })
    const backupKey = new Uint8Array(32).fill(5)
    crypto.getSessionBackupPrivateKey.mockResolvedValue(backupKey)

    expect(await security.nativeCommand({ kind: 'ownerStatus' })).toEqual({
      storage: 'present',
      keyId: 'key-id',
      signing: true,
      deviceSigned: true,
      backup: true,
      ownKey: 'own-ed25519'
    })
    // The backup key was only looked at, then wiped.
    expect(backupKey.every(byte => byte === 0)).toBe(true)
  })

  it('checks a key against the server’s current recovery without unlocking anything', async () => {
    const { security, http, crypto, cache } = extended()
    await serverRecovery(http, right)

    expect(await security.nativeCommand({ kind: 'recoveryCheck', key: encodeRecoveryKey(right)! })).toEqual({
      valid: true,
      keyId: 'key-id'
    })
    expect(await security.nativeCommand({ kind: 'recoveryCheck', key: encodeRecoveryKey(wrong)! })).toEqual({
      valid: false
    })
    expect(await security.nativeCommand({ kind: 'recoveryCheck', key: 'not a recovery key' })).toEqual({
      valid: false
    })
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).not.toHaveBeenCalled()
    expect(await cache.callbacks.getSecretStorageKey!({ keys: { 'key-id': {} as never } }, 'test')).toBeNull()
  })

  it('unlocks completely and silently: signing from recovery, then the key backup', async () => {
    const { security, http, crypto, cache, storage, changed } = extended()
    await serverRecovery(http, right)
    let signed = false
    crypto.bootstrapCrossSigning.mockImplementation(async () => {
      signed = true
    })
    crypto.getDeviceVerificationStatus.mockImplementation(async () => ({ crossSigningVerified: signed }))
    crypto.getSessionBackupPrivateKey.mockImplementation(async () => new Uint8Array(32).fill(5))
    const before = changed.mock.calls.length

    expect(await security.nativeCommand({ kind: 'ownerRestore', key: encodeRecoveryKey(right)! })).toEqual({
      keyId: 'key-id',
      signed: true,
      backup: true
    })

    // The SDK's own import (all three secrets read from recovery), never a new identity.
    expect(storage.get).toHaveBeenCalledWith('m.cross_signing.master')
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({})
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled()
    expect(crypto.crossSignDevice).not.toHaveBeenCalled()
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledOnce()
    expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(crypto.restoreKeyBackup).toHaveBeenCalledOnce())
    // Silent: the visible recovery state never moved, and the key is gone from the cache.
    expect(security.snapshot().recovery).toBe('idle')
    expect(changed.mock.calls.length).toBe(before)
    expect(await cache.callbacks.getSecretStorageKey!({ keys: { 'key-id': {} as never } }, 'test')).toBeNull()
  })

  it('signs this device with signing keys it already holds, without importing them again', async () => {
    const { security, http, crypto } = extended()
    await serverRecovery(http, right)
    crypto.getCrossSigningStatus.mockResolvedValue({
      publicKeysOnDevice: true,
      privateKeysCachedLocally: { masterKey: true, selfSigningKey: true, userSigningKey: true }
    })
    crypto.crossSignDevice.mockImplementation(async () => {
      crypto.getDeviceVerificationStatus.mockResolvedValue({ crossSigningVerified: true })
    })

    expect(await security.nativeCommand({ kind: 'ownerRestore', key: encodeRecoveryKey(right)! })).toMatchObject({
      signed: true
    })
    expect(crypto.crossSignDevice).toHaveBeenCalledWith('A')
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
  })

  it('still signs when the account has no key backup, and says so', async () => {
    const { security, http, crypto } = extended()
    await serverRecovery(http, right)
    crypto.bootstrapCrossSigning.mockImplementation(async () => {
      crypto.getDeviceVerificationStatus.mockResolvedValue({ crossSigningVerified: true })
    })
    crypto.loadSessionBackupPrivateKeyFromSecretStorage.mockRejectedValue(new Error('no backup secret'))

    expect(await security.nativeCommand({ kind: 'ownerRestore', key: encodeRecoveryKey(right)! })).toEqual({
      keyId: 'key-id',
      signed: true,
      backup: false
    })
    expect(crypto.restoreKeyBackup).not.toHaveBeenCalled()
  })

  it('never takes a recovery whose key description has no check, which any key would open', async () => {
    for (const check of [{}, { iv: '', mac: '' }, { iv: 'AAAAAAAAAAAAAAAAAAAAAA' }]) {
      const { security, http, crypto } = extended()
      await serverRecovery(http, right, check)

      for (const key of [right, wrong]) {
        expect(await security.nativeCommand({ kind: 'recoveryCheck', key: encodeRecoveryKey(key)! })).toEqual({
          valid: false
        })
        await expect(security.nativeCommand({ kind: 'ownerRestore', key: encodeRecoveryKey(key)! })).rejects.toThrow(
          'matrix_recovery_key_invalid'
        )
      }

      expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
      expect(crypto.crossSignDevice).not.toHaveBeenCalled()
    }
  })

  it('refuses a wrong or malformed key with the closed code, before touching signing or backup', async () => {
    const { security, http, crypto } = extended()
    await serverRecovery(http, right)

    for (const key of [encodeRecoveryKey(wrong)!, 'not a recovery key']) {
      await expect(security.nativeCommand({ kind: 'ownerRestore', key })).rejects.toThrow('matrix_recovery_key_invalid')
    }

    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled()
    expect(crypto.crossSignDevice).not.toHaveBeenCalled()
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).not.toHaveBeenCalled()
  })

  it('tells agent trust what this store knows of one other device: public keys and flags', async () => {
    const { security, crypto } = extended()
    const device = { getFingerprint: () => 'agent-ed25519' }
    crypto.getUserDeviceInfo.mockResolvedValue(new Map([['@agent:test', new Map([['AGENT', device]])]]))
    crypto.getDeviceVerificationStatus.mockImplementation(async (...args: unknown[]) => ({
      crossSigningVerified: args[0] === '@agent:test'
    }))

    expect(
      await security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId: '@agent:test', deviceId: 'AGENT' } })
    ).toEqual({
      ownKey: 'own-ed25519',
      peerKey: 'agent-ed25519',
      peerIdentityKnown: true,
      peerIdentityVerified: true,
      peerDeviceCrossSigned: true,
      ownDeviceCrossSigned: false
    })
    expect(crypto.getUserVerificationStatus).toHaveBeenCalledBefore(crypto.getUserDeviceInfo)
    expect(crypto.getUserDeviceInfo).toHaveBeenCalledWith(['@agent:test'], false)
    expect(deviceVerification.loadIdentity).not.toHaveBeenCalled()

    // A device this store has never seen: no key, never a guess.
    expect(
      await security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId: '@agent:test', deviceId: 'OTHER' } })
    ).not.toHaveProperty('peerKey')

    crypto.getUserVerificationStatus
      .mockResolvedValueOnce({ known: false, isCrossSigningVerified: () => false })
      .mockResolvedValueOnce({ known: true, isCrossSigningVerified: () => false })
    expect(
      await security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId: '@agent:test', deviceId: 'AGENT' } })
    ).toMatchObject({ peerKey: 'agent-ed25519', peerIdentityKnown: true, peerIdentityVerified: false })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledExactlyOnceWith(crypto, '@agent:test')
    expect(crypto.getUserVerificationStatus).toHaveBeenCalledTimes(4)
    expect(deviceVerification.loadIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      crypto.getUserDeviceInfo.mock.invocationCallOrder.at(-1)!
    )

    crypto.getUserVerificationStatus.mockResolvedValue({ known: false, isCrossSigningVerified: () => false })
    expect(
      await security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId: '@agent:test', deviceId: 'AGENT' } })
    ).toMatchObject({ peerKey: 'agent-ed25519', peerIdentityKnown: false, peerIdentityVerified: false })

    await expect(
      security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId: 'agent', deviceId: 'AGENT' } })
    ).rejects.toThrow('matrix_agent_identity_invalid')
  })

  it('fails agent trust closed when the Rust identity-import seam is unavailable', async () => {
    const { security, crypto } = extended()
    crypto.getUserVerificationStatus.mockResolvedValue({ known: false, isCrossSigningVerified: () => false })
    deviceVerification.loadIdentity.mockRejectedValueOnce(new Error('matrix_device_query_unavailable'))

    await expect(
      security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId: '@agent:test', deviceId: 'AGENT' } })
    ).rejects.toThrow('matrix_device_query_unavailable')
    expect(crypto.getUserDeviceInfo).not.toHaveBeenCalled()
    expect(JSON.stringify(security.snapshot())).not.toContain('@agent:test')
  })

  it('imports one identity once when concurrent trust calls race for the same unknown peer', async () => {
    const { security, crypto } = extended()
    let release: (() => void) | undefined
    deviceVerification.loadIdentity.mockImplementationOnce(
      () => new Promise<void>(resolve => { release = resolve })
    )
    crypto.getUserVerificationStatus.mockResolvedValue({ known: false, isCrossSigningVerified: () => false })

    const peer = { userId: '@agent:test', deviceId: 'AGENT' }
    const first = security.nativeCommand({ kind: 'agentTrustStatus', peer })
    const second = security.nativeCommand({ kind: 'agentTrustStatus', peer })

    await vi.waitFor(() => expect(deviceVerification.loadIdentity).toHaveBeenCalledOnce())
    release!()

    await expect(first).resolves.toMatchObject({ peerIdentityKnown: false })
    await expect(second).resolves.toMatchObject({ peerIdentityKnown: false })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledOnce()
  })

  it('does not import a peer that stays unknown until its short retry window passes', async () => {
    vi.useFakeTimers()
    const { security, crypto } = extended()
    crypto.getUserVerificationStatus.mockResolvedValue({ known: false, isCrossSigningVerified: () => false })
    const peer = { userId: '@agent:test', deviceId: 'AGENT' }

    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).resolves.toMatchObject({
      peerIdentityKnown: false
    })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledOnce()

    // Still inside the window: identity is read again first, but no new query.
    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).resolves.toMatchObject({
      peerIdentityKnown: false
    })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledOnce()
    expect(crypto.getUserVerificationStatus).toHaveBeenCalledTimes(3)

    vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).resolves.toMatchObject({
      peerIdentityKnown: false
    })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledTimes(2)
  })

  it('never imports once the peer identity becomes known', async () => {
    const { security, crypto } = extended()
    crypto.getUserVerificationStatus
      .mockResolvedValueOnce({ known: false, isCrossSigningVerified: () => false })
      .mockResolvedValue({ known: true, isCrossSigningVerified: () => false })
    const peer = { userId: '@agent:test', deviceId: 'AGENT' }

    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).resolves.toMatchObject({
      peerIdentityKnown: true
    })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledOnce()

    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).resolves.toMatchObject({
      peerIdentityKnown: true
    })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledOnce()
  })

  it('does not cache a failed import and retries on the next trust call', async () => {
    const { security, crypto } = extended()
    crypto.getUserVerificationStatus.mockResolvedValue({ known: false, isCrossSigningVerified: () => false })
    deviceVerification.loadIdentity.mockRejectedValueOnce(new Error('matrix_device_query_unavailable'))
    const peer = { userId: '@agent:test', deviceId: 'AGENT' }

    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).rejects.toThrow(
      'matrix_device_query_unavailable'
    )
    expect(crypto.getUserDeviceInfo).not.toHaveBeenCalled()

    await expect(security.nativeCommand({ kind: 'agentTrustStatus', peer })).resolves.toMatchObject({
      peerIdentityKnown: false
    })
    expect(deviceVerification.loadIdentity).toHaveBeenCalledTimes(2)
  })

  it('tracks the import window per peer', async () => {
    const { security, crypto } = extended()
    crypto.getUserVerificationStatus.mockResolvedValue({ known: false, isCrossSigningVerified: () => false })

    for (const userId of ['@agent:test', '@agent:test', '@other:test', '@other:test']) {
      await expect(
        security.nativeCommand({ kind: 'agentTrustStatus', peer: { userId, deviceId: 'AGENT' } })
      ).resolves.toMatchObject({ peerIdentityKnown: false })
    }

    expect(deviceVerification.loadIdentity).toHaveBeenCalledTimes(2)
    expect(deviceVerification.loadIdentity).toHaveBeenNthCalledWith(1, crypto, '@agent:test')
    expect(deviceVerification.loadIdentity).toHaveBeenNthCalledWith(2, crypto, '@other:test')
  })
})

describe('one-tap approval, on the person’s SDK', () => {
  function approvalFixture() {
    const value = fixture()

    const request = Object.assign(new EventEmitter(), {
      pending: true,
      initiatedByMe: true,
      otherUserId: '@alice:test',
      otherDeviceId: undefined as string | undefined,
      phase: VerificationPhase.Requested,
      cancel: vi.fn(async () => {})
    })

    const crypto = Object.assign(value.crypto, {
      requestOwnUserVerification: vi.fn(async () => request),
      getDeviceVerificationStatus: vi.fn(async (_user: string, device: string) => ({
        signedByOwner: device === 'MACBOOK',
        crossSigningVerified: false
      })),
      getUserVerificationStatus: vi.fn(
        async (): Promise<unknown> => ({ isCrossSigningVerified: () => true, wasCrossSigningVerified: () => true })
      ),
      crossSignDevice: vi.fn(async () => {})
    })

    value.crypto.getUserDeviceInfo.mockResolvedValue(
      new Map([
        [
          '@alice:test',
          new Map([
            ['A', { deviceId: 'A', displayName: 'This Mac' }],
            ['MACBOOK', { deviceId: 'MACBOOK', displayName: 'MacBook' }],
            ['PHONE', { deviceId: 'PHONE', displayName: undefined }]
          ])
        ]
      ]) as never
    )
    Object.assign(value.client, {
      getDevices: vi.fn(async () => ({
        devices: [
          { device_id: 'MACBOOK', display_name: 'Atum · MacBook Pro mẫu', last_seen_ts: 1_700_000_000_000 }
        ]
      }))
    })

    return { ...value, crypto, request }
  }

  it('asks the person’s other devices once, never beside another comparison', async () => {
    const { security, crypto, request } = approvalFixture()

    const reply = await security.nativeCommand({ kind: 'approvalRequest' })
    expect(crypto.requestOwnUserVerification).toHaveBeenCalledOnce()
    expect(reply).toEqual(security.snapshot().verification)
    expect(security.snapshot().verification).toMatchObject({
      userId: '@alice:test',
      incoming: false,
      state: 'requested'
    })
    await expect(security.nativeCommand({ kind: 'approvalRequest' })).rejects.toThrow('matrix_verification_pending')
    expect(request.cancel).not.toHaveBeenCalled()
  })

  it('lists the other devices with their own names, when last active and whether signed', async () => {
    const { security, crypto } = approvalFixture()

    expect(await security.nativeCommand({ kind: 'ownDevices' })).toEqual({
      devices: [
        {
          deviceId: 'MACBOOK',
          name: 'Atum · MacBook Pro mẫu',
          lastSeenAt: 1_700_000_000_000,
          signedByOwner: true,
          crossSigningVerified: false
        },
        { deviceId: 'PHONE', signedByOwner: false, crossSigningVerified: false }
      ],
      identity: 'verified'
    })

    // A device verified by hand here (a fingerprint check) says so: the reminder leaves it be.
    crypto.getDeviceVerificationStatus.mockImplementation(async (_user: string, device: string) => ({
      signedByOwner: device === 'MACBOOK',
      crossSigningVerified: false,
      ...(device === 'PHONE' ? { localVerified: true } : {})
    }))
    expect(((await security.nativeCommand({ kind: 'ownDevices' })) as { devices: unknown[] }).devices[1]).toEqual({
      deviceId: 'PHONE',
      signedByOwner: false,
      crossSigningVerified: false,
      locallyVerified: true
    })

    // What this device knows of the person's identity: never verified one (a new Mac), or
    // verified an earlier one and the server now serves another (replaced elsewhere).
    for (const [now, before, identity] of [
      [false, false, 'new'],
      [false, true, 'changed'],
      [true, true, 'verified']
    ] as const) {
      crypto.getUserVerificationStatus.mockResolvedValue({
        isCrossSigningVerified: () => now,
        wasCrossSigningVerified: () => before
      })
      expect(await security.nativeCommand({ kind: 'ownDevices' })).toMatchObject({ identity })
    }
  })

  it('writes only this device’s waiting marker, with no secret, and clears it', async () => {
    const { security, client } = approvalFixture()
    const setAccountData = (client as unknown as { setAccountData: ReturnType<typeof vi.fn> }).setAccountData
    const marker = { deviceId: 'A', requestedAt: 1, expiresAt: 2 }

    await security.nativeCommand({ kind: 'approvalMarker', marker })
    expect(setAccountData).toHaveBeenLastCalledWith('io.atum.device_approval', marker)
    await security.nativeCommand({ kind: 'approvalMarker', marker: null })
    expect(setAccountData).toHaveBeenLastCalledWith('io.atum.device_approval', {})

    for (const bad of [
      { ...marker, deviceId: 'MACBOOK' },
      { ...marker, expiresAt: 1 },
      { ...marker, requestedAt: 0.5 }
    ]) {
      await expect(security.nativeCommand({ kind: 'approvalMarker', marker: bad })).rejects.toThrow(
        'matrix_approval_invalid'
      )
    }
  })

  it('signs only the device it just finished comparing with', async () => {
    const { security, crypto, client } = approvalFixture()
    const incoming = request()
    Object.assign(incoming, { otherDeviceId: 'MACBOOK' })
    client.emit(CryptoEvent.VerificationRequestReceived, incoming)

    await expect(security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'MACBOOK' })).rejects.toThrow(
      'matrix_verification_stale'
    )

    incoming.change(VerificationPhase.Done)
    await expect(security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'PHONE' })).rejects.toThrow(
      'matrix_verification_stale'
    )
    await security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'MACBOOK' })
    expect(crypto.crossSignDevice).toHaveBeenCalledExactlyOnceWith('MACBOOK')
  })

  it('remembers the other device and the comparison’s transaction ID after the SDK forgets the device', async () => {
    const { security, crypto, client } = approvalFixture()
    const incoming = request()
    Object.assign(incoming, { otherUserId: '@alice:test', otherDeviceId: 'MACBOOK', transactionId: 'txn-0042' })
    client.emit(CryptoEvent.VerificationRequestReceived, incoming)
    expect(security.snapshot().verification).toMatchObject({ deviceId: 'MACBOOK', flowId: 'txn-0042' })

    // The Rust SDK no longer names the other device once the request is done.
    Object.assign(incoming, { otherDeviceId: undefined })
    incoming.change(VerificationPhase.Done)
    expect(security.snapshot().verification).toMatchObject({ state: 'done', deviceId: 'MACBOOK', flowId: 'txn-0042' })

    // The device just compared with can still be signed; any other cannot.
    await expect(security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'PHONE' })).rejects.toThrow(
      'matrix_verification_stale'
    )
    await security.nativeCommand({ kind: 'approveOwnDevice', deviceId: 'MACBOOK' })
    expect(crypto.crossSignDevice).toHaveBeenCalledExactlyOnceWith('MACBOOK')
  })

  it('carries a waiting device’s marker into the snapshot, never anything else', () => {
    const { security, client } = approvalFixture()
    const content = { deviceId: 'NEWMAC', requestedAt: 5, expiresAt: 10 }

    Object.assign(client, {
      getAccountData: (type: string) =>
        type === 'io.atum.device_approval' ? { getContent: () => ({ ...content, secret: 'x' }) } : undefined
    })

    expect(security.snapshot().approvalMarker).toEqual(content)
  })

  it('names this device only when it has no name of its own, and never with control characters', async () => {
    const { security, client } = approvalFixture()
    const setDeviceDetails = vi.fn(async () => ({}))
    let current: string | undefined
    Object.assign(client, {
      getDevice: vi.fn(async () => ({ device_id: 'A', display_name: current })),
      setDeviceDetails
    })

    expect(await security.nativeCommand({ kind: 'nameOwnDevice', name: 'Atum · MacBook Air' })).toEqual({ named: true })
    expect(setDeviceDetails).toHaveBeenCalledWith('A', { display_name: 'Atum · MacBook Air' })

    current = 'Minh’s phone of choice'
    expect(await security.nativeCommand({ kind: 'nameOwnDevice', name: 'Atum · MacBook Air' })).toEqual({
      named: false
    })
    expect(setDeviceDetails).toHaveBeenCalledOnce()

    for (const name of ['', '   ', 'a\nb', 'x'.repeat(101)]) {
      await expect(security.nativeCommand({ kind: 'nameOwnDevice', name })).rejects.toThrow(
        'matrix_device_name_invalid'
      )
    }
  })
})

it('native peer review starts the real watched SAS flow without pinning or sending a draft', async () => {
  const f = fixture()
  const req = request()
  Object.assign(req, { otherUserId: '@friend:test', transactionId: 'peer-flow', initiatedByMe: true })
  const room = { getMyMembership: () => 'join', hasEncryptionStateEvent: () => true, getMember: () => ({ membership: 'join' }) }
  Object.assign(f.client, { getRoom: () => room })
  const requestVerificationDM = vi.fn(async () => req)
  const withdrawVerificationRequirement = vi.fn()
  Object.assign(f.crypto, {
    getUserVerificationStatus: async () => ({ known: true, needsUserApproval: true, isCrossSigningVerified: () => false }),
    requestVerificationDM, withdrawVerificationRequirement
  })
  await f.security.nativeCommand({ kind: 'peerIdentityStart', roomId: '!room:test', userId: '@friend:test' })
  expect(requestVerificationDM).toHaveBeenCalledWith('@friend:test', '!room:test')
  expect(f.security.snapshot().verification).toMatchObject({ userId: '@friend:test', state: 'requested' })
  expect(req.sas.confirm).not.toHaveBeenCalled()
  expect(withdrawVerificationRequirement).not.toHaveBeenCalled()
  await expect(f.security.nativeCommand({ kind: 'peerIdentityStart', roomId: '!room:test', userId: '@friend:test' })).rejects.toThrow('pending')
})

it('cancels a peer request that returns after its SDK host stops', async () => {
  const f = fixture()
  const req = request()
  const room = { getMyMembership: () => 'join', hasEncryptionStateEvent: () => true, getMember: () => ({ membership: 'join' }) }
  Object.assign(f.client, { getRoom: () => room })
  Object.assign(f.crypto, {
    getUserVerificationStatus: async () => ({ known: true, needsUserApproval: true, isCrossSigningVerified: () => false }),
    requestVerificationDM: async () => { f.security.stop();

 return req }
  })
  await expect(f.security.nativeCommand({ kind: 'peerIdentityStart', roomId: '!room:test', userId: '@friend:test' })).rejects.toThrow('stale')
  expect(req.cancel).toHaveBeenCalledOnce()
  expect(req.sas.confirm).not.toHaveBeenCalled()
})
