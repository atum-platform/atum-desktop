import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import type { MatrixCompanyChannelDirectory } from '../../shared/matrix-company'

import { handleMatrixCompanyDesktop } from './main-company-desktop'

const here = dirname(fileURLToPath(import.meta.url))

const read = (pack: string, file: string) =>
  JSON.parse(readFileSync(resolve(here, '../../contracts', pack, 'fixtures', file), 'utf8')) as Record<string, unknown>

const boardView = read('atum-company-board-v1', 'board.response.json')
const board = read('atum-company-board-v1', 'page-empty.response.json')
const card = read('atum-company-board-v1', 'card-human.response.json')
const command = read('atum-company-board-v1', 'command.response.json')
const brain = read('atum-company-project-brain-v4', 'brain-live.response.json')
const ai = read('atum-company-ai-v1', 'ai-view.response.json')
const wallet = read('atum-company-funding-v2', 'wallet.response.json')
const packs = read('atum-company-funding-v2', 'packs.response.json')
const order = read('atum-company-funding-v2', 'order.response.json')
const privateCos = read('atum-company-private-cos-v1', 'lazy-first-open.uncreated.response.json')

const boardCompany = '00000000-0000-4000-8000-3fff02fcbe73'
const cardId = '00000000-0000-4000-8000-1794b62d2fb7'
const brainCompany = '00000000-0000-4000-8000-42eb2dd5dae7'
const brainProject = '00000000-0000-4000-8000-bd674f59504c'
const aiCompany = '00000000-0000-4000-8000-887900f65a05'
const fundingCompany = '00000000-0000-4000-8000-61b0206ddea9'
const orderId = '00000000-0000-4000-8000-2f5656bb7927'
const channelId = '00000000-0000-4000-8000-af517c7d26bd'

function directory(roomId: string | null = '!launch:test'): MatrixCompanyChannelDirectory {
  return {
    schemaVersion: 1,
    channels: [
      {
        schemaVersion: 1,
        channel: {
          id: channelId,
          companyId: boardCompany,
          displayName: 'launch',
          visibility: 'company',
          state: 'active',
          projectId: null,
          authorityGeneration: 5,
          channelGeneration: 3
        },
        memberPrincipals: [],
        room: roomId ? { state: 'ready', roomId } : { state: 'not_provisioned', roomId: null }
      }
    ]
  }
}

function context(overrides: Record<string, unknown> = {}) {
  const boardRequest = vi.fn(async (request: Record<string, unknown>) =>
    request.action === 'board-view' ? boardView
      : request.action === 'board-card-v11' ? { negotiatedProfile: '1', value: card }
        : request.action === 'board-list-v11' ? { negotiatedProfile: '1', value: board }
          : request.action === 'board-command' ? command : board
  )

  const aiRequest = vi.fn(async () => ai)
  const privateCosRequest = vi.fn(async () => privateCos)

  const fundingRequest = vi.fn(async (request: Record<string, unknown>) =>
    request.action === 'funding-wallet' ? wallet : request.action === 'funding-packs' ? packs : order
  )

  const brainRequest = vi.fn(async () => brain)
  const sdk = vi.fn(async () => null)
  const openExternal = vi.fn(async () => {})
  const openBoardAttachment = vi.fn(async () => {})

  return {
    boardRequest,
    aiRequest,
    privateCosRequest,
    fundingRequest,
    brainRequest,
    sdk,
    openExternal,
    openBoardAttachment,
    context: {
      event: {} as never,
      ui: {} as never,
      uiUrl: 'https://app.test',
      enabled: true,
      closing: false,
      available: () => true,
      board: boardRequest,
      ai: aiRequest,
      privateCos: privateCosRequest,
      funding: fundingRequest,
      projectBrain: brainRequest,
      channels: vi.fn(async () => (overrides.directory as unknown) ?? directory()),
      sdk,
      openBoardAttachment,
      openExternal
    } as unknown as Parameters<typeof handleMatrixCompanyDesktop>[1]
  }
}

/** The caller check is exercised by its own suite; here it only has to pass. */
vi.mock('./ipc-policy', () => ({ requireMatrixCaller: () => undefined }))

describe('Company Desktop adapter handler',()=>{
  it('keeps the private pair owner-derived across view and ensure', async () => {
    const fixture = context()
    const companyId = (privateCos.pair as { companyPrincipal: string }).companyPrincipal
    const requestId = '00000000-0000-4000-8000-7d4ef186dc5c'

    await expect(handleMatrixCompanyDesktop({ action: 'read-private-cos-capability', companyId }, fixture.context))
      .resolves.toEqual({ ok: true, value: privateCos })
    await expect(handleMatrixCompanyDesktop({ action: 'read-private-cos', companyId }, fixture.context))
      .resolves.toEqual({ ok: true, value: privateCos })
    await expect(handleMatrixCompanyDesktop({
      action: 'ensure-private-cos',
      companyId,
      request: { schemaVersion: 1, requestId, action: 'ensure', trigger: 'dm_open' }
    }, fixture.context)).resolves.toEqual({ ok: true, value: privateCos })
    await expect(handleMatrixCompanyDesktop({
      action: 'ensure-private-cos',
      companyId,
      request: { schemaVersion: 1, requestId, action: 'ensure', trigger: 'first_company_visit', locale: 'vi' }
    }, fixture.context)).resolves.toEqual({ ok: true, value: privateCos })
    expect(fixture.privateCosRequest.mock.calls).toEqual([
      [{ action: 'private-cos-capability', companyId }],
      [{ action: 'private-cos-view', companyId }],
      [{ action: 'private-cos-ensure', companyId, schemaVersion: 1, requestId, trigger: 'dm_open' }],
      [{ action: 'private-cos-ensure', companyId, schemaVersion: 1, requestId,
        trigger: 'first_company_visit', locale: 'vi' }]
    ])

    await expect(handleMatrixCompanyDesktop({
      action: 'ensure-private-cos',
      companyId,
      request: { schemaVersion: 1, requestId, action: 'ensure', trigger: 'sidebar_render' }
    }, fixture.context)).resolves.toEqual({ ok: false, error: 'invalid' })
    expect(fixture.privateCosRequest).toHaveBeenCalledTimes(4)
  })

  it('reads the board, one card and one command through the D1 board consumer',async()=>{
    const fixture = context()

    await expect(handleMatrixCompanyDesktop({action:'read-board-view',companyId:boardCompany},fixture.context))
      .resolves.toEqual({ok:true,value:boardView})
    expect(fixture.boardRequest).toHaveBeenCalledWith({action:'board-view',companyId:boardCompany})

    await expect(handleMatrixCompanyDesktop({action:'list-board',companyId:boardCompany,
      filters:{cursor:null,projectId:null,ownerMemberRef:null,due:'all',includeArchived:false}},fixture.context))
      .resolves.toEqual({ok:true,value:{...board,contractVersion:'1'}})
    expect(fixture.boardRequest).toHaveBeenCalledWith({action:'board-list-v11',companyId:boardCompany,cursor:null,
      projectId:null,ownerMemberRef:null,due:'all',includeArchived:false})

    await expect(handleMatrixCompanyDesktop({action:'read-board-card',companyId:boardCompany,cardId},
      fixture.context)).resolves.toEqual({ok:true,value:card})
    expect(fixture.boardRequest).toHaveBeenLastCalledWith({action:'board-card-v11',companyId:boardCompany,cardId})

    await expect(handleMatrixCompanyDesktop({action:'command-board',companyId:boardCompany,
      contractVersion:'1',
      command:{schemaVersion:1,operation:'create',requestId:'00000000-0000-4000-8000-7487b628e7ea',cardId,
        title:'Send launch draft'}},fixture.context)).resolves.toEqual({ok:true,value:command})
  })

  it('reads and configures the company CoS view',async()=>{
    const fixture = context()

    await expect(handleMatrixCompanyDesktop({action:'read-ai',companyId:aiCompany},fixture.context))
      .resolves.toEqual({ok:true,value:ai})
    await expect(handleMatrixCompanyDesktop({action:'configure-ai',companyId:aiCompany,request:{
      schemaVersion:1,requestId:'00000000-0000-4000-8000-f3cb80828804',expectedRevision:1,enabled:false}},
    fixture.context)).resolves.toEqual({ok:true,value:ai})
    expect(fixture.aiRequest).toHaveBeenLastCalledWith({action:'company-ai-configure',companyId:aiCompany,
      requestId:'00000000-0000-4000-8000-f3cb80828804',expectedRevision:1,enabled:false})
  })

  it('reads the wallet, packs and a created order through the funding consumer',async()=>{
    const fixture = context()

    await expect(handleMatrixCompanyDesktop({action:'read-wallet',companyId:fundingCompany},fixture.context))
      .resolves.toEqual({ok:true,value:wallet})
    await expect(handleMatrixCompanyDesktop({action:'read-packs',companyId:fundingCompany},fixture.context))
      .resolves.toEqual({ok:true,value:packs})
    await expect(handleMatrixCompanyDesktop({action:'create-order',companyId:fundingCompany,request:{
      schemaVersion:2,requestId:'00000000-0000-4000-8000-e4b838e987a5',packId:'protons-100k'}},fixture.context))
      .resolves.toEqual({ok:true,value:{schemaVersion:2,companyId:fundingCompany,orderId,packId:'protons-100k',
        protons:100000,state:'pending',credited:false}})
  })

  it('funds the company from the caller wallet with exactly requestId and whole Protons',async()=>{
    const fixture = context()

    const transfer = {schemaVersion:2,companyId:fundingCompany,requestId:'00000000-0000-4000-8000-6ea014a92b8f',
      protons:40,amountMicroProtons:40000000,fromPromoMicroProtons:30000000,fromPaidMicroProtons:10000000,wallet}

    fixture.fundingRequest.mockResolvedValueOnce(transfer as never)

    await expect(handleMatrixCompanyDesktop({action:'fund-from-member',companyId:fundingCompany,request:{
      schemaVersion:2,requestId:transfer.requestId,protons:40}},fixture.context)).resolves.toEqual({ok:true,value:transfer})

    expect(fixture.fundingRequest).toHaveBeenLastCalledWith({action:'funding-member-fund',companyId:fundingCompany,
      requestId:transfer.requestId,protons:40})

    fixture.fundingRequest.mockClear()

    for (const request of [
      {schemaVersion:2,requestId:transfer.requestId,protons:40,from:'paid'},
      {schemaVersion:1,requestId:transfer.requestId,protons:40},
      {schemaVersion:2,requestId:transfer.requestId}
    ]) {
      await expect(handleMatrixCompanyDesktop({action:'fund-from-member',companyId:fundingCompany,request},
        fixture.context)).resolves.toEqual({ok:false,error:'invalid'})
    }

    await expect(handleMatrixCompanyDesktop({action:'fund-from-member',companyId:fundingCompany,
      request:{schemaVersion:2,requestId:transfer.requestId,protons:40},payer:'company'},fixture.context))
      .resolves.toEqual({ok:false,error:'invalid'})
    expect(fixture.fundingRequest).not.toHaveBeenCalled()
  })

  it('reads the unresolved transfer through the funding consumer',async()=>{
    const fixture = context()

    fixture.fundingRequest.mockResolvedValueOnce({pending:null} as never)

    await expect(handleMatrixCompanyDesktop({action:'read-pending-fund',companyId:fundingCompany},fixture.context))
      .resolves.toEqual({ok:true,value:{pending:null}})
    expect(fixture.fundingRequest).toHaveBeenLastCalledWith({action:'funding-member-fund-pending',companyId:fundingCompany})
    await expect(handleMatrixCompanyDesktop({action:'read-pending-fund',companyId:fundingCompany,requestId:'x'},
      fixture.context)).resolves.toEqual({ok:false,error:'invalid'})
  })

  it('never returns a provider checkout URL to the renderer',async()=>{
    const fixture = context()

    await expect(handleMatrixCompanyDesktop({action:'read-order',companyId:fundingCompany,orderId},fixture.context))
      .resolves.toEqual({ok:true,value:{schemaVersion:2,companyId:fundingCompany,orderId,packId:'protons-100k',
        protons:100000,state:'pending',credited:false}})
    await expect(handleMatrixCompanyDesktop({action:'open-order',companyId:fundingCompany,orderId},fixture.context))
      .resolves.toEqual({ok:true,value:null})
    expect(fixture.openExternal).toHaveBeenCalledWith('https://pay.payos.vn/web/payosfixture')
  })

  it('refuses to open an order that is not pending with a checkout URL',async()=>{
    const paid = {...order,state:'paid'}
    const fixture = context()
    fixture.fundingRequest.mockResolvedValue(paid as never)

    await expect(handleMatrixCompanyDesktop({action:'open-order',companyId:fundingCompany,orderId},fixture.context))
      .resolves.toEqual({ok:false,error:'invalid'})
    expect(fixture.openExternal).not.toHaveBeenCalled()
  })

  it('refuses a checkout URL that is not the exact PayOS host',async()=>{
    for (const checkoutUrl of ['https://evil.example/web/payosfixture',
      'https://pay.payos.vn.evil.example/web/payosfixture',
      'https://pay.payos.vn@evil.example/web/payosfixture',
      'https://pay.payos.vn/web/payosfixture?redirect=https://evil.example',
      'http://pay.payos.vn/web/payosfixture']) {
      const fixture = context()
      fixture.fundingRequest.mockResolvedValue({...order,checkoutUrl} as never)

      await expect(handleMatrixCompanyDesktop({action:'open-order',companyId:fundingCompany,orderId},fixture.context))
        .resolves.toEqual({ok:false,error:'invalid'})
      expect(fixture.openExternal).not.toHaveBeenCalled()
    }
  })

  it('refuses to open a pending order whose provider URL was read for another order',async()=>{
    const fixture = context()
    fixture.fundingRequest.mockResolvedValue({...order,
      orderId:'00000000-0000-4000-8000-76b3bacc1035'} as never)

    await expect(handleMatrixCompanyDesktop({action:'open-order',companyId:fundingCompany,orderId},fixture.context))
      .resolves.toEqual({ok:false,error:'invalid'})
    expect(fixture.openExternal).not.toHaveBeenCalled()
  })

  it('applies a correction only to the exact brief the person saw',async()=>{
    const fixture = context()

    const request = {schemaVersion:4,requestId:'00000000-0000-4000-8000-7c028b2713e7',expectedBriefVersion:1,
      expectedBoardRevision:4,expectedSourceGeneration:3,targetKind:'decision',
      targetItemId:'a'.repeat(64),text:'Corrected decision.'}

    await handleMatrixCompanyDesktop({action:'correct-project-brain',companyId:brainCompany,
      projectId:brainProject,request},fixture.context)
    expect(fixture.brainRequest).toHaveBeenLastCalledWith(expect.objectContaining({action:'brain-correct',
      companyId:brainCompany,projectId:brainProject,base:brain,requestId:request.requestId}))

    await expect(handleMatrixCompanyDesktop({action:'correct-project-brain',companyId:brainCompany,
      projectId:brainProject,request:{...request,expectedBriefVersion:2}},fixture.context))
      .resolves.toEqual({ok:false,error:'conflict'})
  })

  it('opens a channel citation only after the same channel is still admitted',async()=>{
    const fixture = context()

    const citation = {kind:'channel',sourceId:'00000000-0000-4000-8000-e4842fbace4f',channelId,
      eventId:'$task:atum.example',at:'2026-10-27T02:10:00Z'}

    await expect(handleMatrixCompanyDesktop({action:'open-citation',companyId:boardCompany,citation},
      fixture.context)).resolves.toEqual({ok:true,value:null})
    expect(fixture.sdk).toHaveBeenNthCalledWith(1,{kind:'companyCitationOpen',companyId:boardCompany,channelId,
      roomId:'!launch:test',eventId:'$task:atum.example'})
    expect(fixture.sdk).toHaveBeenNthCalledWith(2,{kind:'companyMessageSelect',companyId:boardCompany,channelId,
      roomId:'!launch:test'})
  })

  it('refuses a citation into a channel this person is not admitted to',async()=>{
    const fixture = context({directory:directory(null)})

    await expect(handleMatrixCompanyDesktop({action:'open-citation',companyId:boardCompany,citation:{
      kind:'channel',sourceId:'00000000-0000-4000-8000-e4842fbace4f',channelId,eventId:'$task:atum.example',
      at:'2026-10-27T02:10:00Z'}},fixture.context)).resolves.toEqual({ok:false,error:'denied'})
    expect(fixture.sdk).not.toHaveBeenCalled()
  })

  it('keeps the adapter closed: unknown actions, extra keys and disabled windows are refused',async()=>{
    const fixture = context()

    await expect(handleMatrixCompanyDesktop({action:'delete-everything',companyId:boardCompany},fixture.context))
      .resolves.toEqual({ok:false,error:'invalid'})
    await expect(handleMatrixCompanyDesktop({action:'read-ai',companyId:boardCompany,ownerUserId:'x'},
      fixture.context)).resolves.toEqual({ok:false,error:'invalid'})
    await expect(handleMatrixCompanyDesktop({action:'read-ai',companyId:boardCompany},
      {...fixture.context,enabled:false})).resolves.toEqual({ok:false,error:'unavailable'})
    await expect(handleMatrixCompanyDesktop({action:'read-ai',companyId:boardCompany},
      {...fixture.context,available:() => false})).resolves.toEqual({ok:false,error:'authentication'})
  })
})
