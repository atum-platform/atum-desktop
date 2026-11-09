import { EventType, type MatrixClient, MatrixEvent, MsgType } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import greetingClaim from '../../contracts/atum-company-private-cos-v1.2/fixtures/greeting.claim.json'
import greetingContent from '../../contracts/atum-company-private-cos-v1.2/fixtures/greeting.matrix-content.json'
import type {MatrixCompanyAIWatchCheckpoint} from '../../shared/matrix-company-ai-sdk'
import { MATRIX_COMPANY_CHANNEL_BINDING, MATRIX_COMPANY_CHANNEL_TYPE } from '../../shared/matrix-company-channel-room'

import {
  findCompanyThread,
  joinCompanyAIChannel,
  joinCompanyPrivateCosRoom,
  openCompanyCitation,
  publishCompanyPrivateCosGreeting,
  publishCompanyThread,
  publishCompanyThreadMessage,
  readCompanyAIEvent,
  readCompanyAIQuestion,
  watchCompanyAI,
  watchCompanyPrivateCos
} from './company-ai-sdk'

const companyId = '00000000-0000-4000-8000-540eb3b6436f'
const channelId = '00000000-0000-4000-8000-e860663e054f'
const otherCompanyId = '00000000-0000-4000-8000-876425eb0072'
const roomId = '!cos-channel:test'
const otherRoomId = '!cos-other:test'
const agentUserId = '@private-cos:atum.example'
const memberUserId = '@member:atum.example'
const incarnation = '00000000-0000-4000-8000-77b665e3862d'
const privateExecutor = '00000000-0000-4000-8000-81dca3a207ec'
const privateAttempt = '00000000-0000-4000-8000-ea69cba7080b'
const privateRoomId = '!private-cos:test'

const privatePowers = {users:{'@manager:test':100 as const,[memberUserId]:0 as const,[agentUserId]:0 as const},
  users_default:0 as const,events_default:0 as const,state_default:100 as const,invite:100 as const,kick:100 as const,
  ban:100 as const,redact:100 as const,events:{'m.room.join_rules':100 as const,'m.room.power_levels':100 as const,
    'm.room.history_visibility':100 as const,'m.room.encryption':100 as const,'m.room.guest_access':100 as const,
    'm.room.name':100 as const,'m.room.avatar':100 as const,'m.room.topic':100 as const,
    'io.atum.company_private_cos':100 as const,'m.room.server_acl':100 as const,'m.room.tombstone':100 as const}}

const privateScope={roomId:privateRoomId,companyId,memberPrincipal:'00000000-0000-4000-8000-ef2223ad86ad',
  membershipIncarnation:incarnation,executorId:privateExecutor,attemptId:privateAttempt,
  memberUserId,agentUserId,managerUserId:'@manager:test',
  roomName:'Chief of Staff' as const,
  historyVisibility:'joined' as const,joinRule:'invite' as const,guestAccess:'forbidden' as const,powerLevels:privatePowers}

function room(id = roomId, channel = channelId, company = companyId,
  membership:'join'|'invite'|'leave'='join',encrypted=false) {
  const creation = {
    getContent: () => ({
      type: MATRIX_COMPANY_CHANNEL_TYPE,
      room_version: '11',
      [MATRIX_COMPANY_CHANNEL_BINDING]: { companyId: company, channelId: channel }
    }),
    getSender: () => '@manager:test',
    getRoomId: () => id
  }

  const events: MatrixEvent[] = []
  const threads: Array<{ events: MatrixEvent[] }> = []
  let currentMembership = membership

  return {
    roomId: id,
    events,
    threads,
    getMyMembership: () => currentMembership,
    setMembership: (value: 'join' | 'invite' | 'leave') => {currentMembership = value},
    getType: () => MATRIX_COMPANY_CHANNEL_TYPE,
    getLiveTimeline: () => ({ getEvents: () => events }),
    getThreads: () => threads,
    getEventForTxnId: () => undefined,
    currentState: {
      getStateEvents:(type:string,key:string)=>key!==''?null:type===EventType.RoomCreate?creation:
        type===EventType.RoomEncryption&&encrypted?{getContent:()=>({algorithm:'m.megolm.v1.aes-sha2'})}:null
    }
  }
}

function privateRoom(input:{marker?:Record<string,unknown>;powers?:unknown;id?:string;members?:string[];
  type?:string;encrypted?:boolean;name?:string}={}){
  let membership:'invite'|'join'='invite'
  let members=input.members??[agentUserId]
  const events:MatrixEvent[]=[]
  const threads:Array<{events:MatrixEvent[]}>=[]

  const marker={v:1,classification:'company_private_cos',companyId,membershipIncarnation:incarnation,
    executorId:privateExecutor,attemptId:privateAttempt,...input.marker}

  return {roomId:input.id??privateRoomId,getMyMembership:()=>membership,
    setMembership:(value:'invite'|'join')=>{membership=value},getType:()=>input.type??'io.atum.assistant',
    setMembers:(value:string[])=>{members=value},getJoinedMembers:()=>members.map(userId=>({userId})),events,threads,
    getLiveTimeline:()=>({getEvents:()=>events}),getThreads:()=>threads,getEventForTxnId:()=>undefined,
    currentState:{getStateEvents:(type:string,key:string)=>key!==''?null:type==='io.atum.company_private_cos'
      ?{getContent:()=>marker}:type===EventType.RoomPowerLevels?{getContent:()=>input.powers??privatePowers}
        :type===EventType.RoomName?{getContent:()=>({name:input.name??'Chief of Staff'})}
          :type===EventType.RoomHistoryVisibility?{getContent:()=>({history_visibility:'joined'})}
            :type===EventType.RoomJoinRules?{getContent:()=>({join_rule:'invite'})}
              :type===EventType.RoomGuestAccess?{getContent:()=>({guest_access:'forbidden'})}
                :type===EventType.RoomEncryption&&input.encrypted?{getContent:()=>({algorithm:'m.megolm.v1.aes-sha2'})}:null}}
}

function event(
  id: string,
  input: {
    room?: string
    body?: string
    sender?: string
    at?: number
    mentions?: string[]
    threadRoot?: string
    replyTo?: string
    type?: string
  } = {}
) {
  const content: Record<string, unknown> = {
    msgtype: MsgType.Text,
    body: input.body ?? 'Question for the CoS',
    ...(input.mentions ? { 'm.mentions': { user_ids: input.mentions } } : {})
  }

  if (input.type !== undefined) {
    content.msgtype = input.type
  }

  if (input.threadRoot) {
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: input.threadRoot,
      is_falling_back: true,
      ...(input.replyTo ? { 'm.in_reply_to': { event_id: input.replyTo } } : {})
    }
  } else if (input.replyTo) {
    content['m.relates_to'] = { 'm.in_reply_to': { event_id: input.replyTo } }
  }

  return new MatrixEvent({
    type: EventType.RoomMessage,
    event_id: id,
    room_id: input.room ?? roomId,
    sender: input.sender ?? '@avery:test',
    origin_server_ts: input.at ?? 1_000,
    content
  })
}

function client(rooms: ReturnType<typeof room>[], wire: Record<string, MatrixEvent>) {
  const fetchRoomEvent = vi.fn(async (_roomId: string, eventId: string) => {
    const found = wire[eventId]

    if (!found) {
      throw new Error('matrix_not_found')
    }

    return found.getEffectiveEvent() as never
  })

  const sendEvent = vi.fn(async () => ({ event_id: '$answer:test' }))
  const relations = vi.fn(async (): Promise<{ events: MatrixEvent[]; nextBatch?: string }> => ({ events: [] }))
  const joinRoom = vi.fn(async (id: string) => rooms.find(item => item.roomId === id) ?? null)
  const leave = vi.fn(async()=>({}))

  const createMessagesRequest=vi.fn(async(id:string,from:string|null,_limit:number,direction:string)=>{
    if(direction==='b'){return {start:'tail-token',end:'seed-token',chunk:[]}}
    const target=rooms.find(item=>item.roomId===id)

    const events=[...new Map([...(target?.events??[]),...(target?.threads??[]).flatMap(thread=>thread.events)]
      .map(item=>[item.getId(),item])).values()]

    return {start:from??'seed-token',end:'next-token',chunk:events.map(item=>item.getEffectiveEvent())}
  })

  return {
    isInitialSyncComplete: () => true,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find(item => item.roomId === id) ?? null,
    getUserId: () => agentUserId,
    fetchRoomEvent,
    joinRoom,
    leave,
    sendEvent,
    relations,
    createMessagesRequest,
    decryptEventIfNeeded:vi.fn(async()=>{}),
    store:{getSyncToken:()=> 'tail-token'}
  } as unknown as MatrixClient & { fetchRoomEvent: typeof fetchRoomEvent; joinRoom: typeof joinRoom;leave:typeof leave;
    sendEvent: typeof sendEvent; relations: typeof relations }
}

describe('Company AI SDK commands',()=>{
  it('accepts only the bound private invite with the exact marker and power plan',async()=>{
    const invited=privateRoom()
    const sdk=client([invited as never],{})
    sdk.joinRoom.mockImplementationOnce(async()=>{invited.setMembership('join');

return {roomId:privateRoomId} as never})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('joined')
    expect(sdk.joinRoom).toHaveBeenCalledWith(privateRoomId)
  })

  it('accepts the power plan with the historical:100 key Synapse adds on its own (11-08 quarantine)',async()=>{
    const invited=privateRoom({powers:{...privatePowers,historical:100}})
    const sdk=client([invited as never],{})
    sdk.joinRoom.mockImplementationOnce(async()=>{invited.setMembership('join');

return {roomId:privateRoomId} as never})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('joined')
    expect(sdk.leave).not.toHaveBeenCalled()
  })

  it('keeps waiting for the manager to leave when the room carries historical:100',async()=>{
    const invited=privateRoom({members:[agentUserId,privateScope.managerUserId],powers:{...privatePowers,historical:100}})
    const sdk=client([invited as never],{})
    sdk.joinRoom.mockImplementationOnce(async()=>{invited.setMembership('join');return {roomId:privateRoomId} as never})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('manager_pending')
    expect(sdk.leave).not.toHaveBeenCalled()
  })

  it('waits for the bootstrap manager to leave before validating or exposing intake',async()=>{
    const invited=privateRoom({members:[agentUserId,privateScope.managerUserId]})
    const sdk=client([invited as never],{})
    sdk.joinRoom.mockImplementationOnce(async()=>{invited.setMembership('join');return {roomId:privateRoomId} as never})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('manager_pending')
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('manager_pending')
    expect(sdk.joinRoom).toHaveBeenCalledTimes(1)
    expect(sdk.leave).not.toHaveBeenCalled()
  })

  it('keeps only HTTP status and declared Matrix errcode on a refused private join',async()=>{
    const sdk=client([privateRoom() as never],{})
    sdk.joinRoom.mockRejectedValueOnce(Object.assign(Error('secret server response'),
      {httpStatus:404,errcode:'M_UNKNOWN',data:{access_token:'secret'}}))
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).rejects.toThrow(
      'matrix_private_cos_join_request_failed:http=404:errcode=M_UNKNOWN')
  })

  it('keeps a cold-sync host alive until its bound private invite arrives',async()=>{
    const rooms:ReturnType<typeof room>[]=[]
    const sdk=client(rooms,{})
    sdk.isInitialSyncComplete=()=>false
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('join_pending')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
    const invited=privateRoom()
    rooms.push(invited as never)
    sdk.joinRoom.mockImplementationOnce(async()=>{invited.setMembership('join');return {roomId:privateRoomId} as never})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('joined')
    expect(sdk.joinRoom).toHaveBeenCalledExactlyOnceWith(privateRoomId)
  })

  it('waits for the exact room across cached initial sync, and never joins another room',async()=>{
    const sdk=client([privateRoom() as never],{})
    const scope={...privateScope,roomId:'!wrong:example.org'}
    sdk.isInitialSyncComplete=()=>false
    await expect(joinCompanyPrivateCosRoom(sdk,scope)).resolves.toBe('join_pending')
    sdk.isInitialSyncComplete=()=>true
    await expect(joinCompanyPrivateCosRoom(sdk,scope)).resolves.toBe('join_pending')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
  })

  it('accepts the replacement invitation arriving after cached sync reports complete',async()=>{
    const rooms: ReturnType<typeof room>[]=[]
    const sdk=client(rooms,{})
    sdk.isInitialSyncComplete=()=>true
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('join_pending')
    expect(sdk.joinRoom).not.toHaveBeenCalled()

    const replacement=privateRoom()
    rooms.push(replacement as never)
    sdk.joinRoom.mockImplementation(async()=>{replacement.setMembership('join');return replacement as never})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).resolves.toBe('joined')
    expect(sdk.joinRoom).toHaveBeenCalledExactlyOnceWith(privateRoomId)
  })

  it('distinguishes a stopped engine from an active engine with the wrong identity',async()=>{
    const sdk=client([],{})
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope,()=>false)).rejects.toThrow('matrix_company_ai_unavailable')
    sdk.getUserId=()=>memberUserId
    await expect(joinCompanyPrivateCosRoom(sdk,privateScope)).rejects.toThrow('matrix_private_cos_identity_unavailable')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
  })

  it('rejects malformed scope even when the invite has not synced',async()=>{
    const sdk=client([],{})
    await expect(joinCompanyPrivateCosRoom(sdk,{...privateScope,roomId:'invalid'}))
      .rejects.toThrow('matrix_private_cos_scope_invalid')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
  })

  it.each([
    ['marker',privateRoom({marker:{companyId:otherCompanyId}}),privateScope],
    ['incarnation',privateRoom(),{...privateScope,membershipIncarnation:'00000000-0000-4000-8000-7d39ad22fa1f'}],
    ['power',privateRoom({powers:{...privatePowers,invite:0}}),privateScope],
    ['historical power level',privateRoom({powers:{...privatePowers,historical:50}}),privateScope],
    ['extra power key beside historical',privateRoom({powers:{...privatePowers,historical:100,invite:0}}),privateScope],
    ['name',privateRoom({name:'Wrong'}),privateScope],
    ['encryption',privateRoom({encrypted:true}),privateScope]
  ])('joins, then leaves and quarantines a private room with wrong %s',async(_kind,invited,scope)=>{
    const sdk=client([invited as never],{})
    sdk.joinRoom.mockImplementationOnce(async()=>{invited.setMembership('join');

return {roomId:privateRoomId} as never})
    await expect(joinCompanyPrivateCosRoom(sdk,scope as typeof privateScope)).resolves.toBe('quarantined')
    expect(sdk.joinRoom).toHaveBeenCalledWith(privateRoomId)
    expect(sdk.leave).toHaveBeenCalledWith(privateRoomId)
  })

  it.each([
    ['create type',privateScope]
  ])('refuses a private invite with wrong %s before joining',async(kind,scope)=>{
    const invited=privateRoom(kind==='create type'?{type:'wrong.type'}:{})
    const sdk=client([invited as never],{})
    await expect(joinCompanyPrivateCosRoom(sdk,scope as typeof privateScope)).rejects.toThrow('matrix_private_cos_room_type_invalid')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
    expect(sdk.leave).not.toHaveBeenCalled()
  })

  it('waits for the member join before offering private-room intake',async()=>{
    const joined=privateRoom();joined.setMembership('join')
    joined.events.push(event('$private-request',{room:privateRoomId,sender:memberUserId,mentions:[agentUserId],at:2_000}))
    joined.threads.push({events:[joined.events[0]!,event('$private-followup',{room:privateRoomId,sender:memberUserId,
      mentions:[agentUserId],threadRoot:'$private-request',replyTo:'$private-request',at:2_100})]})
    const sdk=client([joined as never],{})
    await expect(watchCompanyPrivateCos(sdk,{...privateScope,checkpoint:{positions:[]},catchupAfterMs:0}))
      .resolves.toEqual({schemaVersion:2,events:[],checkpoint:{positions:[]},pairJoined:false})
    joined.setMembers([memberUserId,agentUserId])
    const seeded=await watchCompanyPrivateCos(sdk,{...privateScope,checkpoint:{positions:[]},catchupAfterMs:0})
    await expect(watchCompanyPrivateCos(sdk,{...privateScope,checkpoint:seeded.checkpoint,catchupAfterMs:0})).resolves.toEqual({schemaVersion:2,events:[
      {roomId:privateRoomId,eventId:'$private-request',senderUserId:memberUserId,mentionedAgentUserId:agentUserId,
        original:true,eventType:'m.room.message',messageType:'m.text',atMs:2_000},
      {roomId:privateRoomId,eventId:'$private-followup',senderUserId:memberUserId,mentionedAgentUserId:agentUserId,
        original:true,eventType:'m.room.message',messageType:'m.text',atMs:2_100}],
    checkpoint:{positions:[{roomId:privateRoomId,token:'next-token',liveEventId:'$private-request',draining:true}],
      nextRoomId:null},pairJoined:true})
  })

  it('publishes the frozen member mention and agent pill only after both participants joined',async()=>{
    const joined=privateRoom({members:[memberUserId,agentUserId]});joined.setMembership('join')
    const sdk=client([joined as never],{})
    await expect(publishCompanyPrivateCosGreeting(sdk,{...privateScope,transactionId:'tx-private-greeting',locale:'en',
      text:greetingClaim.text,mention:{userId:memberUserId},agentPill:{userId:agentUserId,
        displayName:'Chief of Staff',label:'@Chief of Staff',href:`https://matrix.to/#/${agentUserId}`},
      link:{kind:'company_board',companyId,boardId:'00000000-0000-4000-8000-7b0cac15d6b0',
        title:'Open company board',url:`https://atumplatform.com/#atum-board/${companyId}/00000000-0000-4000-8000-7b0cac15d6b0`}}))
      .resolves.toBe('$answer:test')
    expect(sdk.sendEvent).toHaveBeenCalledWith(privateRoomId,EventType.RoomMessage,greetingContent,'tx-private-greeting')
    expect(((sdk.sendEvent.mock.calls[0] as unknown[] | undefined)?.[2] as {formatted_body?: string} | undefined)?.formatted_body).toContain(
      '<a href="https://atumplatform.com/#atum-board/00000000-0000-4000-8000-540eb3b6436f/00000000-0000-4000-8000-7b0cac15d6b0">Open company board</a>')
  })

  it('carries the exact getting-started card URL as the formatted link anchor',async()=>{
    const joined=privateRoom({members:[memberUserId,agentUserId]});joined.setMembership('join')
    const sdk=client([joined as never],{}),boardId='00000000-0000-4000-8000-7b0cac15d6b0'
    const cardId='00000000-0000-4000-8000-ed2914fe0e5a'
    const url=`https://atumplatform.com/#atum-board/${companyId}/${boardId}/card/${cardId}`
    await publishCompanyPrivateCosGreeting(sdk,{...privateScope,transactionId:'tx-private-card',locale:'en',
      text:'Welcome @Chief of Staff',mention:{userId:memberUserId},agentPill:{userId:agentUserId,
        displayName:'Chief of Staff',label:'@Chief of Staff',href:`https://matrix.to/#/${agentUserId}`},
      link:{kind:'company_board_card',companyId,boardId,cardId,title:'Getting started',url}})
    expect((sdk.sendEvent.mock.calls[0] as unknown[] | undefined)?.[2]).toMatchObject({body:`Welcome @Chief of Staff\n\nGetting started: ${url}`,
      formatted_body:expect.stringContaining(`<a href="${url}">Getting started</a>`)})
  })

  it('accepts only an exact invitation and treats an already joined room as a no-op', async () => {
    const invited = room(roomId, channelId, companyId, 'invite')
    const sdk = client([invited], {})
    sdk.joinRoom.mockImplementationOnce(async () => {
      invited.setMembership('join')

      return invited as never
    })

    const command = {companyId, channelId, roomId}
    await expect(joinCompanyAIChannel(sdk, command, agentUserId)).resolves.toBe('joined')
    expect(sdk.joinRoom).toHaveBeenCalledOnce()

    await expect(joinCompanyAIChannel(sdk, command, agentUserId)).resolves.toBe('already_joined')
    expect(sdk.joinRoom).toHaveBeenCalledOnce()
  })

  it('confirms the join when sync delivers it after joinRoom returns a detached room', async () => {
    // matrix-js-sdk 42 returns `syncApi.createRoom(roomId)`; the stored room stays `invite`
    // until the next sync, so the read-back must wait for it instead of failing.
    const invited = room(roomId, channelId, companyId, 'invite')
    const sdk = client([invited], {})
    sdk.joinRoom.mockImplementationOnce(async () => {
      setTimeout(() => invited.setMembership('join'), 250)

      return { roomId } as never
    })

    await expect(joinCompanyAIChannel(sdk, {companyId, channelId, roomId}, agentUserId)).resolves.toBe('joined')
  })

  it('reports a server-accepted join that sync has not delivered as pending, not failed', async () => {
    const invited = room(roomId, channelId, companyId, 'invite')
    const sdk = client([invited], {})
    sdk.joinRoom.mockImplementationOnce(async () => ({ roomId }) as never)

    await expect(joinCompanyAIChannel(sdk, {companyId, channelId, roomId}, agentUserId, () => true, 150))
      .resolves.toBe('join_pending')
  })

  it('does not join, and does not fail, when the CoS is not invited yet', async () => {
    const left = room(roomId, channelId, companyId, 'leave')
    const sdk = client([left], {})

    await expect(joinCompanyAIChannel(sdk, {companyId, channelId, roomId}, agentUserId)).resolves.toBe('not_invited')
    await expect(joinCompanyAIChannel(client([], {}), {companyId, channelId, roomId}, agentUserId))
      .resolves.toBe('not_invited')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
  })

  it('requires the logged-in Matrix user to be the expected CoS', async () => {
    const invited = room(roomId, channelId, companyId, 'invite')
    const sdk = client([invited], {})

    await expect(joinCompanyAIChannel(sdk, {companyId, channelId, roomId}, '@other:test'))
      .rejects.toThrow('matrix_company_ai_unavailable')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
  })

  it('refuses forgeable room metadata that does not match the platform-selected binding', async () => {
    const forged = room(roomId, channelId, otherCompanyId, 'invite')
    const sdk = client([forged], {})

    await expect(joinCompanyAIChannel(sdk, {companyId, channelId, roomId}, agentUserId))
      .rejects.toThrow('matrix_company_ai_unavailable')
    expect(sdk.joinRoom).not.toHaveBeenCalled()
  })

  it('requires a joined room and the same immutable binding after joinRoom returns', async () => {
    const invited = room(roomId, channelId, companyId, 'invite')
    const rooms = [invited]
    const sdk = client(rooms, {})
    sdk.joinRoom.mockImplementationOnce(async () => {
      rooms[0] = room(roomId, channelId, otherCompanyId, 'join')

      return rooms[0] as never
    })

    await expect(joinCompanyAIChannel(sdk, {companyId, channelId, roomId}, agentUserId))
      .rejects.toThrow('matrix_company_ai_unavailable')
    expect(sdk.joinRoom).toHaveBeenCalledOnce()
  })

  it('watches only addressed messages of this company, newest first, and resumes at the last instant',async()=>{
    const joined = room()
    joined.events.push(
      event('$old', { at: 400, mentions: [agentUserId] }),
      event('$addressed', { at: 1_000, mentions: [agentUserId] }),
      event('$unaddressed', { at: 1_100 }),
      event('$own', { at: 1_200, sender: agentUserId, mentions: [agentUserId] }),
      event('$reply', { at: 1_300, replyTo: '$addressed', mentions: [agentUserId] })
    )
    joined.threads.push({events:[
      joined.events[1]!,
      event('$threaded', { at: 1_350, threadRoot: '$addressed', replyTo: '$addressed', mentions: [agentUserId] })
    ]})
    const foreign = room(otherRoomId, channelId, otherCompanyId)
    foreign.events.push(event('$foreign', { room: otherRoomId, at: 1_400, mentions: [agentUserId] }))
    const left = room('!left:test', channelId, companyId, 'leave')
    left.events.push(event('$left', { room: '!left:test', at: 1_500, mentions: [agentUserId] }))

    const sdk=client([joined,foreign,left],{})
    const seeded=await watchCompanyAI(sdk,{companyId,agentUserId,checkpoint:{positions:[]},catchupAfterMs:500})
    expect(seeded.diagnostics).toMatchObject({rooms: 3, joined: 2, bound: 1, otherCompany: 1, seeded: 1, seedPages: 1})
    await expect(watchCompanyAI(sdk,{companyId,agentUserId,checkpoint:seeded.checkpoint,
      catchupAfterMs:500})).resolves.toMatchObject({
      schemaVersion: 2,
      hints: [
        {roomId,eventId:'$old',atMs:400},
        {roomId,eventId:'$addressed',atMs:1_000},
        {roomId,eventId:'$reply',atMs:1_300},
        {roomId,eventId:'$threaded',atMs:1_350}
      ],checkpoint:{positions:[{roomId,token:'next-token',liveEventId:'$reply',draining:true}],nextRoomId:null}
    })
  })

  it('fails loudly if a company channel ever becomes encrypted instead of filtering its mentions silently',async()=>{
    const encrypted=room(roomId,channelId,companyId,'join',true)
    const sdk=client([encrypted],{})
    await expect(watchCompanyAI(sdk,{companyId,agentUserId,checkpoint:{positions:[]},catchupAfterMs:0}))
      .rejects.toThrow('matrix_company_ai_unavailable')
    expect(sdk.createMessagesRequest).not.toHaveBeenCalled()
  })

  it('catches a mention made during controller downtime from the persisted Matrix position, not the loaded timeline',async()=>{
    const joined=room()
    const sdk=client([joined],{})
    const duringDowntime=event('$during-downtime',{at:2_000,mentions:[agentUserId]})
    vi.mocked(sdk.createMessagesRequest).mockResolvedValueOnce({start:'ack-token',end:'caught-up-token',
      chunk:[duringDowntime.getEffectiveEvent()]} as never)

    await expect(watchCompanyAI(sdk,{companyId,agentUserId,
      checkpoint:{positions:[{roomId,token:'ack-token'}]},catchupAfterMs:0})).resolves.toMatchObject({
      schemaVersion:2,hints:[{roomId,eventId:'$during-downtime',atMs:2_000}],
      checkpoint:{positions:[{roomId,token:'caught-up-token',liveEventId:null,draining:true}],nextRoomId:null}})
    expect(joined.events).toHaveLength(0)
  })

  it('paginates more than 100 addressed events with one timestamp without starving the later page',async()=>{
    const joined=room()
    const sdk=client([joined],{})

    const events=Array.from({length:150},(_,index)=>event(`$same-${String(index).padStart(3,'0')}:test`,{
      at:5_000,mentions:[agentUserId]}))

    vi.mocked(sdk.createMessagesRequest).mockImplementation(async(_room,from,limit)=>{
      expect(limit).toBe(25)
      const page=Number(String(from).split('-').at(-1)),start=page*25

      return {start:from,end:`page-${page+1}`,chunk:events.slice(start,start+25)
        .map(value=>value.getEffectiveEvent())} as never
    })

    let checkpoint:MatrixCompanyAIWatchCheckpoint={positions:[{roomId,token:'page-0'}]}
    const found:string[]=[]

    for(let page=0;page<6;page+=1){
      const value=await watchCompanyAI(sdk,{companyId,agentUserId,checkpoint,catchupAfterMs:0})
      found.push(...value.hints.map(hint=>hint.eventId));checkpoint=value.checkpoint
    }

    expect(found).toHaveLength(150)
    expect(new Set(found).size).toBe(150)
  })

  it('reads one exact event and its thread root from the server copy',async()=>{
    const joined = room()
    const root = event('$root', { at: 500 })
    const reply = event('$reply', { threadRoot: '$root', replyTo: '$root', mentions: [agentUserId], at: 900 })
    const reader = client([joined], { $root: root, $reply: reply })

    await expect(readCompanyAIEvent(reader, { companyId, roomId, eventId: '$root' })).resolves.toMatchObject({
      roomBinding: { companyId, channelId },
      roomId,
      eventId: '$root',
      relation: 'top_level',
      threadRootEventId: '$root',
      root: null,
      mentionedUserIds: []
    })
    await expect(readCompanyAIEvent(reader, { companyId, roomId, eventId: '$reply' })).resolves.toMatchObject({
      relation: 'thread',
      threadRootEventId: '$root',
      inReplyToEventId: '$root',
      root: { eventId: '$root', relation: 'top_level' },
      mentionedUserIds: [agentUserId]
    })
    await expect(readCompanyAIEvent(reader,{companyId:otherCompanyId,roomId,eventId:'$root'})).resolves.toBeNull()
  })

  it('terminally ignores a redacted, missing, or no-longer-joined event',async()=>{
    const joined=room()

    const redacted=new MatrixEvent({type:EventType.RoomMessage,event_id:'$redacted',room_id:roomId,
      sender:'@human:test',origin_server_ts:1,content:{},unsigned:{redacted_because:{event_id:'$redaction'} as never}})

    const reader=client([joined],{$redacted:redacted})
    await expect(readCompanyAIEvent(reader,{companyId,roomId,eventId:'$redacted'})).resolves.toBeNull()
    await expect(readCompanyAIEvent(reader,{companyId,roomId,eventId:'$missing'})).resolves.toBeNull()
    joined.setMembership('leave')
    await expect(readCompanyAIEvent(reader,{companyId,roomId,eventId:'$redacted'})).resolves.toBeNull()
  })

  it('keeps the old room token when sync advances during a no-end tail request, then finds that mention',async()=>{
    const joined=room(),old=event('$old-tail',{at:1_000})
    joined.events.push(old)
    const sdk=client([joined],{})
    vi.spyOn(sdk.store,'getSyncToken').mockReturnValue('after-mention-token')
    vi.mocked(sdk.createMessagesRequest).mockResolvedValueOnce({start:'from-token',chunk:[]} as never)

    const first=await watchCompanyAI(sdk,{companyId,agentUserId,
      checkpoint:{positions:[{roomId,token:'from-token',liveEventId:'$old-tail',draining:true}]},catchupAfterMs:0})

    expect(first.hints).toEqual([])
    expect(first.checkpoint).toEqual({positions:[{roomId,token:'from-token',liveEventId:'$old-tail',draining:false}],
      nextRoomId:null})
    expect((vi.mocked(sdk.createMessagesRequest).mock.calls[0]?.[4] as any).getDefinition())
      .toMatchObject({room:{timeline:{types:[EventType.RoomMessage]}}})
    const mention=event('$arrived-during-request',{at:2_000,mentions:[agentUserId]})
    joined.events.push(mention)
    vi.mocked(sdk.createMessagesRequest).mockResolvedValueOnce({start:'from-token',end:'after-room-token',
      chunk:[mention.getEffectiveEvent()]} as never)
    const second=await watchCompanyAI(sdk,{companyId,agentUserId,checkpoint:first.checkpoint,catchupAfterMs:0})
    expect(second.hints).toEqual([{roomId,eventId:'$arrived-during-request',atMs:2_000}])
    expect(vi.mocked(sdk.createMessagesRequest).mock.calls[1]?.[1]).toBe('from-token')
  })

  it('rotates room batches so companies with more than 100 rooms are all checkpointed',async()=>{
    const rooms=Array.from({length:105},(_,index)=>room(`!room-${String(index).padStart(3,'0')}:test`))
    const sdk=client(rooms,{})
    let checkpoint:MatrixCompanyAIWatchCheckpoint={positions:[]}

    for(let scan=0;scan<27;scan+=1){checkpoint=(await watchCompanyAI(sdk,{companyId,agentUserId,
      checkpoint,catchupAfterMs:0})).checkpoint}

    expect(checkpoint.positions).toHaveLength(105)
    expect(new Set(vi.mocked(sdk.createMessagesRequest).mock.calls.map(call=>call[0])).size).toBe(105)
  })

  it('walks quiet rooms for free and detects late sync-order events regardless of timestamp or event-id order',async()=>{
    const rooms=Array.from({length:40},(_,index)=>room(`!quiet-${String(index).padStart(2,'0')}:test`))

    const positions=rooms.map((value,index)=>{
      const base=event(index===38?'$z-base':`$base-${index}:test`,{room:value.roomId,at:1_000+index})
      value.events.push(base)

      return {roomId:value.roomId,token:`token-${index}`,liveEventId:base.getId(),draining:false}
    })

    rooms[38]!.events.push(event('$a-late',{room:rooms[38]!.roomId,at:1_038,mentions:[agentUserId]}))
    rooms[39]!.events.push(event('$older-late',{room:rooms[39]!.roomId,at:1,mentions:[agentUserId]}))
    const sdk=client(rooms,{})
    const value=await watchCompanyAI(sdk,{companyId,agentUserId,checkpoint:{positions},catchupAfterMs:0})
    expect(value.hints.map(hint=>hint.eventId)).toEqual(['$older-late','$a-late'])
    expect(vi.mocked(sdk.createMessagesRequest).mock.calls.map(call=>call[0]))
      .toEqual([rooms[38]!.roomId,rooms[39]!.roomId])
  })

  it('reads the trigger with bounded same-thread history and never another thread',async()=>{
    const joined = room()
    const root = event('$root', { at: 100 })
    const earlier = event('$earlier', { threadRoot: '$root', body: 'Earlier', at: 200 })
    const answer = event('$answer', { threadRoot: '$root', sender: agentUserId, body: 'Answered', at: 300 })
    const trigger = event('$trigger', { threadRoot: '$root', body: 'And then?', mentions: [agentUserId], at: 400 })
    const sibling = event('$sibling', { threadRoot: '$other', body: 'Elsewhere', at: 350 })
    joined.events.push(root, earlier, answer, sibling, trigger)
    const reader = client([joined], { $root: root, $trigger: trigger })

    await expect(readCompanyAIQuestion(reader, { companyId, channelId, threadRootEventId: '$root',
      triggerEventId: '$trigger' }, agentUserId)).resolves.toEqual({
      text: 'And then?',
      history: [
        { role: 'user', text: 'Earlier' },
        { role: 'assistant', text: 'Answered' }
      ]
    })
  })

  it('publishes the frozen thread relation under the platform transaction id',async()=>{
    const joined = room()
    const root = event('$root')
    const trigger = event('$trigger', { threadRoot: '$root', replyTo: '$root' })
    const publisher = client([joined], { $root: root, $trigger: trigger })

    await expect(publishCompanyThread(publisher, { companyId, roomId, threadRootEventId: '$root',
      triggerEventId: '$trigger', transactionId: 'tx-12345678', text: 'The answer.' }))
      .resolves.toBe('$answer:test')
    expect(publisher.sendEvent).toHaveBeenCalledWith(roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      body: 'The answer.',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: true,
        'm.in_reply_to': { event_id: '$trigger' } }
    }, 'tx-12345678')
  })

  it('publishes one reminder reply into the channel thread with exact mentions',async()=>{
    const joined = room()
    const root = event('$root')
    const publisher = client([joined], { $root: root })

    await expect(publishCompanyThreadMessage(publisher, { companyId, channelId, threadRootEventId: '$root',
      transactionId: 'atum-board-reminder-00000000-0000-4000-8000-8fa0033d3751', text: 'Task due reminder.',
      mentions: ['@avery:test'] })).resolves.toBe('$answer:test')
    expect(publisher.sendEvent).toHaveBeenCalledWith(roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      body: 'Task due reminder.',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: true,
        'm.in_reply_to': { event_id: '$root' } },
      'm.mentions': { user_ids: ['@avery:test'] }
    }, 'atum-board-reminder-00000000-0000-4000-8000-8fa0033d3751')
  })

  it('reads back the exact published answer by thread relation and proves absence',async()=>{
    const joined = room()

    const answer = event('$published', {threadRoot: '$root', replyTo: '$trigger', sender: agentUserId,
      body: 'The answer.', at: 2_000})

    const lookup = {companyId,roomId,threadRootEventId:'$root',triggerEventId:'$trigger',
      transactionId:'tx-12345678',text:'The answer.',sinceMs:1_500}

    joined.events.push(answer)
    await expect(findCompanyThread(client([joined], {}), lookup)).resolves.toBe('$published')

    joined.events.length = 0
    const page = client([joined], {})
    page.relations.mockResolvedValueOnce({events: [answer], nextBatch: undefined})
    await expect(findCompanyThread(page, lookup)).resolves.toBe('$published')
    expect(page.relations).toHaveBeenCalledWith(roomId, '$root', 'm.thread', EventType.RoomMessage,
      expect.objectContaining({limit: 50}))

    const absent = client([joined], {})
    absent.relations.mockResolvedValueOnce({events: [event('$older', {at: 1})], nextBatch: undefined})
    await expect(findCompanyThread(absent, lookup)).resolves.toBeNull()
  })

  it('never treats an inconclusive publication scan as absent',async()=>{
    const joined = room()
    const reader = client([joined], {})
    reader.relations.mockResolvedValue({events: [event('$other', {sender: '@avery:test', at: 9_000})],
      nextBatch: 'next'})

    await expect(findCompanyThread(reader, {companyId,roomId,threadRootEventId:'$root',triggerEventId:'$trigger',
      transactionId:'tx-12345678',text:'The answer.',sinceMs:1_500}))
      .rejects.toThrow('matrix_company_ai_lookup_unconfirmed')
  })

  it('opens a citation only in its own joined channel, reporting a thread reply root',async()=>{
    const joined = room()
    const root = event('$root')
    const reply = event('$reply', { threadRoot: '$root' })
    const reader = client([joined], { $root: root, $reply: reply })

    await expect(openCompanyCitation(reader, { companyId, channelId, roomId, eventId: '$root' }))
      .resolves.toEqual({ threadRootEventId: null })
    await expect(openCompanyCitation(reader, { companyId, channelId, roomId, eventId: '$reply' }))
      .resolves.toEqual({ threadRootEventId: '$root' })
    await expect(openCompanyCitation(reader, { companyId, channelId: companyId, roomId, eventId: '$root' }))
      .rejects.toThrow('matrix_company_ai_unavailable')
  })
})
