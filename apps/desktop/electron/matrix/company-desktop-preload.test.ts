import { describe, expect, it, vi } from 'vitest'

import { type CompanyDesktopInvoke, createMatrixCompanyDesktopBridge } from './company-desktop-preload'

const companyId = '00000000-0000-4000-8000-3fff02fcbe73'
const cardId = '00000000-0000-4000-8000-1794b62d2fb7'
const orderId = '00000000-0000-4000-8000-2f5656bb7927'

function fixture(value: unknown = {ok: true}) {
  const requests: unknown[] = []

  const invoke = vi.fn(async (request: unknown) => {
    requests.push(request)

    return value
  }) as unknown as CompanyDesktopInvoke

  return { requests, invoke, bridge: createMatrixCompanyDesktopBridge(invoke) }
}

describe('Company Desktop preload bridge',()=>{
  it('turns every adapter method into one closed request and returns the main value',async()=>{
    const view = {schemaVersion:1,companyId,boardId:cardId,revision:4,
      columns:['suggested','to_do','in_progress','blocked','done'] as const}
    const fixtureWithView = fixture({ok:true,value:view})

    await expect(fixtureWithView.bridge.readBoardView(companyId)).resolves.toBe(view)
    expect(fixtureWithView.requests).toEqual([{action:'read-board-view',companyId}])

    const page = {schemaVersion:1,board:{},cards:[],nextCursor:null}
    const fixtureWithPage = fixture({ok:true,value:page})
    await expect(fixtureWithPage.bridge.listBoard(companyId,{cursor:null,projectId:null,ownerMemberRef:null,
      due:'all',includeArchived:false})).resolves.toBe(page)
    expect(fixtureWithPage.requests).toEqual([{action:'list-board',companyId,filters:{cursor:null,projectId:null,
      ownerMemberRef:null,due:'all',includeArchived:false}}])

    const fixtureWithCard = fixture({ok:true,value:{cardId}})
    await expect(fixtureWithCard.bridge.readBoardCard(companyId,cardId)).resolves.toEqual({cardId})
    expect(fixtureWithCard.requests).toEqual([{action:'read-board-card',companyId,cardId}])

    const command = {schemaVersion:1 as const,operation:'create' as const,
      requestId:'00000000-0000-4000-8000-7487b628e7ea',cardId,title:'Send launch draft'}

    const fixtureWithCommand = fixture({ok:true,value:{duplicate:false}})
    await expect(fixtureWithCommand.bridge.commandBoard(companyId,command)).resolves.toEqual({duplicate:false})
    expect(fixtureWithCommand.requests).toEqual([{action:'command-board',companyId,contractVersion:'1',command}])
  })

  it('forwards brain, AI and funding requests unchanged',async()=>{
    const projectId = '00000000-0000-4000-8000-bd674f59504c'

    const correction = {schemaVersion:4 as const,requestId:'00000000-0000-4000-8000-7c028b2713e7',expectedBriefVersion:1,
      expectedBoardRevision:4,expectedSourceGeneration:3,targetKind:'decision' as const,targetItemId:'a'.repeat(64),
      text:'Corrected.'}

    const fixtureValue = fixture({ok:true,value:{}})
    await fixtureValue.bridge.readProjectBrain(companyId,projectId)
    await fixtureValue.bridge.correctProjectBrain(companyId,projectId,correction)
    await fixtureValue.bridge.readAI(companyId)
    await fixtureValue.bridge.configureAI(companyId,{schemaVersion:1,requestId:orderId,expectedRevision:1,
      enabled:true})
    await fixtureValue.bridge.readWallet(companyId)
    await fixtureValue.bridge.readPacks(companyId)
    await fixtureValue.bridge.createOrder(companyId,{schemaVersion:2,requestId:orderId,packId:'protons-100k'})
    await fixtureValue.bridge.readOrder(companyId,orderId)
    await fixtureValue.bridge.fundFromMember(companyId,{schemaVersion:2,requestId:orderId,protons:40})
    await fixtureValue.bridge.readPendingFund(companyId)

    expect(fixtureValue.requests).toEqual([
      {action:'read-project-brain',companyId,projectId},
      {action:'correct-project-brain',companyId,projectId,request:correction},
      {action:'read-ai',companyId},
      {action:'configure-ai',companyId,request:{schemaVersion:1,requestId:orderId,expectedRevision:1,enabled:true}},
      {action:'read-wallet',companyId},
      {action:'read-packs',companyId},
      {action:'create-order',companyId,request:{schemaVersion:2,requestId:orderId,packId:'protons-100k'}},
      {action:'read-order',companyId,orderId},
      {action:'fund-from-member',companyId,request:{schemaVersion:2,requestId:orderId,protons:40}},
      {action:'read-pending-fund',companyId}
    ])
  })

  it('keeps private Chief of Staff view, ensure, receipt and Stop on the closed owner surface', async () => {
    const fixtureValue = fixture({ ok: true, value: {} })
    const runId = '00000000-0000-4000-8000-8e46c3a61153'
    const requestId = '00000000-0000-4000-8000-7d4ef186dc5c'

    await fixtureValue.bridge.readPrivateCosCapability!(companyId)
    await fixtureValue.bridge.readPrivateCos!(companyId)
    await fixtureValue.bridge.ensurePrivateCos!(companyId, {
      schemaVersion: 1, requestId, action: 'ensure', trigger: 'dm_open'
    })
    await fixtureValue.bridge.readPrivateCosReceipt!(companyId, runId)
    await fixtureValue.bridge.stopPrivateCos!(companyId, runId, { schemaVersion: 1, requestId })

    expect(fixtureValue.requests).toEqual([
      { action: 'read-private-cos-capability', companyId },
      { action: 'read-private-cos', companyId },
      { action: 'ensure-private-cos', companyId,
        request: { schemaVersion: 1, requestId, action: 'ensure', trigger: 'dm_open' } },
      { action: 'read-private-cos-receipt', companyId, runId },
      { action: 'stop-private-cos', companyId, runId, request: { schemaVersion: 1, requestId } }
    ])
  })

  it('rejects on a closed native refusal and resolves void for fire-and-forget opens',async()=>{
    const refused = fixture({ok:false,error:'denied'})
    await expect(refused.bridge.readWallet(companyId)).rejects.toThrow('denied')

    const opener = fixture({ok:true,value:null})

    const citation = {kind:'channel' as const,sourceId:companyId,channelId:cardId,eventId:'$task:atum.example',
      at:'2026-10-27T02:10:00Z'}

    await expect(opener.bridge.openCitation(companyId,citation)).resolves.toBeUndefined()
    await expect(opener.bridge.openOrder(companyId,orderId)).resolves.toBeUndefined()
    expect(opener.requests).toEqual([
      {action:'open-citation',companyId,citation},
      {action:'open-order',companyId,orderId}
    ])
  })
})
