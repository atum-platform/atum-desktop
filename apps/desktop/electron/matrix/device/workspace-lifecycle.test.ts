import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { workspaceBinding, workspaceResultHash } from '../../../../../packages/device-protocol/workspace'
import type { WorkspaceConfirm, WorkspaceFinalize, WorkspaceResult } from '../../../../../packages/device-protocol/workspace-messages'

import { DeviceLedger } from './ledger'
import { DeviceService, type DeviceSessionFacts } from './service'
import { type ConflictCopyRelay, DriveWorkspaceCopies, workspaceCopyDigest } from './workspace'
import { DeviceWorkspaceLifecycle } from './workspace-lifecycle'
const roots:string[]=[], services:DeviceService[]=[]
afterEach(()=>{for(const s of services.splice(0)){s.stop('local_stop');}

for(const p of roots.splice(0)){rmSync(p,{recursive:true,force:true})}})

async function setup(){
  const home=realpathSync(mkdtempSync(path.join(tmpdir(),'atum-workspace-completion-')));roots.push(home)
  const folder=path.join(home,'Drive','Agents','T');mkdirSync(folder,{recursive:true});writeFileSync(path.join(folder,'input.txt'),'original')
  const session:DeviceSessionFacts={workspaceProtocol:1,connectionId:randomUUID(),connectionEpoch:12,localGeneration:1,deviceServiceId:randomUUID(),enrollmentEpoch:3,accountEpoch:7}

  const grant={grantId:randomUUID(),ownerUserId:'@owner:atum.test',agentPrincipal:randomUUID(),agentUserId:'@agent:atum.test',invocationId:randomUUID(),originKind:'other' as const,
    originAssertionHash:null,writerEpoch:{leaseGeneration:4,leaseTokenHash:'a'.repeat(43)},targetDeviceServiceId:session.deviceServiceId,enrollmentEpoch:3,accountEpoch:7,
    scopes:['files' as const],connectionId:session.connectionId,issuedAt:Date.now(),expiresAt:Date.now()+120_000}

  const values=new Map<string,string>()
  let journalDirty=false

  const service=new DeviceService({ledger:new DeviceLedger({getItem:key=>values.get(key)??null,setItem:(key,value)=>void values.set(key,value)}),
    executor:{run(){throw Error('no model tool requested')}},standingGrants:{list:()=>[]},approve:async()=>{throw Error('no approval')},
    identity:()=>({ownerUserId:grant.ownerUserId,signedIn:true,localScopes:['files'],cloudAgents:[grant.agentUserId]}),originLog:()=>[],send:async()=>true,audit:{record:()=>{}},accountEpoch:()=>7})

  services.push(service)
  expect((await service.frame({type:'TurnGrant',body:grant,kid:'controller',verdict:'ok',receivedAt:performance.now()},session))[0]?.body.accepted).toBe(true)

  const copies=new DriveWorkspaceCopies({drive:{manifestFor:async paths=>({root:path.join(home,'Drive'),files:new Map(paths.map(p=>[p,
    journalDirty?null:{resource:{storage:'storage',space:'personal',opaque:'input'},etag:'"v1"',size:statSync(path.join(folder,'input.txt')).size}]))})},workspaceLabel:async()=>'/Agents/T',
    tasksRoot:path.join(home,'Atum Tasks'),artifactsRoot:path.join(home,'artifacts')})

  const cwd=(await copies.prepare(grant)).cwd!;mkdirSync(path.join(cwd,'reports'));writeFileSync(path.join(cwd,'reports','Đề án.txt'),'finished output')
  const request:WorkspaceFinalize={...workspaceBinding({...session,requestId:randomUUID(),grantId:grant.grantId,invocationId:grant.invocationId,writerEpoch:grant.writerEpoch}),issuedAt:Date.now(),expiresAt:grant.expiresAt}
  const frames:Array<{type:string;body:any}>=[],sent:Array<{name:string;bytes:Buffer}>=[],saved:string[]=[]
  let quiesce=async()=>{},freezes=0
  let conflicts: Pick<ConflictCopyRelay, 'scan' | 'confirm'> | undefined

  const lifecycle=new DeviceWorkspaceLifecycle({service,copies,quiesce:async()=>{freezes++;await quiesce()},send:async(type,body)=>{frames.push({type,body});

return true},
    sendArtifact:async(_id,a)=>{sent.push({name:a.name,bytes:readFileSync(a.path)});

return true},copyDigest:workspaceCopyDigest,
    saved:async(copy,digest)=>{if(await workspaceCopyDigest(copy)===digest){saved.push(copy)}},
    conflicts: { scan: async () => conflicts ? conflicts.scan() : { offered: [], tooLarge: [] }, confirm: async keys => { await conflicts?.confirm(keys) } }})

  const result=()=>frames.find(f=>f.type==='WorkspaceResult')!.body as WorkspaceResult
  const confirm=(over:Partial<WorkspaceConfirm>={})=>lifecycle.confirm({...workspaceBinding(request),resultHash:result().resultHash,saved:true,confirmedConflictKeys:[],...over},session)

  /** The engine stops vouching for the Drive files: an owner edit it has not synced yet. */
  const unsynced=()=>{journalDirty=true}

  return {cwd,home,copies,unsynced,grant,service,session,request,lifecycle,frames,sent,saved,result,confirm,
    conflicts:(value:Pick<ConflictCopyRelay,'scan'|'confirm'>)=>{conflicts=value},quiesce:(fn:()=>Promise<void>)=>{quiesce=fn},freezes:()=>freezes}
}

it('freezes nested Unicode paths under opaque wire IDs and keeps the confirmed working copy',async()=>{
  const s=await setup();await s.lifecycle.finalize(s.request,s.session)
  expect(s.result().outputs).toEqual([{path:'reports/Đề án.txt',artifactName:'output-0'}]);expect(s.result().complete).toBe(true)
  expect(s.sent[0]?.bytes.toString()).toBe('finished output');await s.confirm();expect(s.saved).toEqual([s.cwd])
  expect(readFileSync(path.join(s.cwd,'reports','Đề án.txt'),'utf8')).toBe('finished output')
})
it('coalesces duplicates and reuses one frozen snapshot',async()=>{
  const s=await setup();let release!:()=>void;s.quiesce(()=>new Promise(resolve=>{release=resolve}))
  const first=s.lifecycle.finalize(s.request,s.session),duplicate=s.lifecycle.finalize(s.request,s.session)

  while(!release){await new Promise(resolve=>setTimeout(resolve,1));}release();await Promise.all([first,duplicate])
  await s.lifecycle.finalize(s.request,s.session);expect(s.freezes()).toBe(1);expect(s.frames.filter(f=>f.type==='WorkspaceResult')).toHaveLength(2)
})
it.each(['hash','session','stop','edited','unknown'] as const)('retains unsaved work when %s invalidates confirmation',async kind=>{
  const s=await setup();await s.lifecycle.finalize(s.request,s.session)

  if(kind==='edited'){writeFileSync(path.join(s.cwd,'reports','Đề án.txt'),'owner edit')}

  if(kind==='stop'){s.service.stop('local_stop')}

  if(kind==='session'){await s.lifecycle.confirm({...workspaceBinding(s.request),resultHash:s.result().resultHash,saved:true,confirmedConflictKeys:[]},{...s.session,connectionId:randomUUID()})}
  else {await s.confirm(kind==='hash'?{resultHash:'x'.repeat(43)}:kind==='unknown'?{saved:false}:{})}

  expect(s.saved).toEqual([]);expect(readFileSync(path.join(s.cwd,'reports','Đề án.txt'),'utf8')).toBe(kind==='edited'?'owner edit':'finished output')
})
it('does not acknowledge a proposed deletion as saved',async()=>{
  const s=await setup();unlinkSync(path.join(s.cwd,'input.txt'));await s.lifecycle.finalize(s.request,s.session)
  expect(s.result().deleted).toEqual(['input.txt']);expect(s.result().complete).toBe(false);await s.confirm();expect(s.saved).toEqual([])
})
it.each(['failure','stop'] as const)('sends no snapshot after quiescence %s',async kind=>{
  const s=await setup();s.quiesce(async()=>{if(kind==='stop'){s.service.stop('local_stop');}else {throw Error('writer alive')}})
  await s.lifecycle.finalize(s.request,s.session);expect(s.sent).toEqual([]);expect(s.frames[0]?.type).toBe('WorkspaceRefused')
  expect(readFileSync(path.join(s.cwd,'reports','Đề án.txt'),'utf8')).toBe('finished output')
})
it('offers only this agent and folder, then confirms only exact offered conflict keys',async()=>{
  const s=await setup(),file=path.join(s.home,'relay-owned.artifact');writeFileSync(file,'conflict bytes')

  const copy={key:'a'.repeat(64),agentPrincipal:s.grant.agentPrincipal,label:'/Agents/T',path:'draft_conflict-20261005-153000.md',
    artifact:{name:'draft',path:file,size:14,sha256:createHash('sha256').update('conflict bytes').digest('base64url')}}

  const confirmed:string[][]=[]
  s.conflicts({scan:async()=>({offered:[copy,{...copy,key:'b'.repeat(64),agentPrincipal:randomUUID()},
    {...copy,key:'c'.repeat(64),label:'/Agents/Other'}],tooLarge:[]}),confirm:async keys=>{confirmed.push(keys)}})
  await s.lifecycle.finalize(s.request,s.session)
  expect(s.result().conflicts).toEqual([{key:copy.key,path:copy.path,label:copy.label,artifactName:'conflict-1'}])
  expect(s.sent.map(sent=>sent.bytes.toString())).toEqual(['finished output','conflict bytes'])
  await s.confirm({saved:false,confirmedConflictKeys:['b'.repeat(64)]});expect(confirmed).toEqual([])
  await s.confirm({saved:false,confirmedConflictKeys:[copy.key]});expect(confirmed).toEqual([[copy.key]])
  expect(s.saved).toEqual([]);expect(readFileSync(file,'utf8')).toBe('conflict bytes')
})
it('keeps relay-owned files and sends no result when Stop occurs during a conflict scan',async()=>{
  const s=await setup()
  s.conflicts({scan:async()=>{s.service.stop('local_stop');

return {offered:[],tooLarge:[]}},confirm:async()=>{throw Error('no confirm')}})
  await s.lifecycle.finalize(s.request,s.session)
  expect(s.sent).toEqual([]);expect(s.frames.map(frame=>frame.type)).toEqual(['WorkspaceRefused'])
  expect(readFileSync(path.join(s.cwd,'reports','Đề án.txt'),'utf8')).toBe('finished output')
})

// Review round 2 (2026-10-24, P2): the Drive twin is looked at again just before each file is sent.
const driveFile=(s:Awaited<ReturnType<typeof setup>>,name:string)=>path.join(s.home,'Drive','Agents','T',name)
const noConflicts={scan:async()=>({offered:[],tooLarge:[]}),confirm:async()=>{}}
it('looks at each Drive twin again just before it is sent, and holds back one the owner edited since the freeze',async()=>{
  const s=await setup();writeFileSync(path.join(s.cwd,'input.txt'),'agent edit of the input')
  // The freeze looked first (nothing had changed); the owner types into Drive before the bytes leave.
  s.conflicts({scan:async()=>{writeFileSync(driveFile(s,'input.txt'),'the owner typed this directly, so it is longer');s.unsynced();return {offered:[],tooLarge:[]}},confirm:noConflicts.confirm})
  await s.lifecycle.finalize(s.request,s.session)
  const result=s.result()
  expect(result.outputs).toEqual([{path:'reports/Đề án.txt',artifactName:'output-1'}])
  expect(result.artifacts.map(artifact=>artifact.name)).toEqual(['output-1']);expect(s.sent.map(sent=>sent.bytes.toString())).toEqual(['finished output'])
  expect(result.complete,'unpublished work is not a complete result').toBe(false);expect(workspaceResultHash(result)).toBe(result.resultHash)
  expect(readFileSync(path.join(s.cwd,'input.txt'),'utf8'),'the agent version stays in its copy').toBe('agent edit of the input')
  expect(readFileSync(path.join(s.cwd,'.atum','DRIVE-CHANGED.txt'),'utf8')).toContain('input.txt')
  expect(readFileSync(driveFile(s,'input.txt'),'utf8'),'and the owner edit is untouched').toBe('the owner typed this directly, so it is longer')
  expect(readdirSync(path.join(s.home,'artifacts')),'only the file that left keeps its frozen copy').toHaveLength(1)
  await s.confirm();expect(s.saved,'a copy with unpublished work is never pruneable').toEqual([])
  expect(readdirSync(path.join(s.home,'artifacts'))).toHaveLength(0)
})
it('keeps every file back, and still answers, when the look itself fails',async()=>{
  const s=await setup();writeFileSync(path.join(s.cwd,'input.txt'),'agent edit of the input')
  s.copies.publicationGuard=()=>async()=>{throw Error('engine down')}
  await s.lifecycle.finalize(s.request,s.session)
  expect(s.sent).toEqual([]);expect(s.result().outputs).toEqual([]);expect(s.result().artifacts).toEqual([]);expect(s.result().complete).toBe(false)
  expect(workspaceResultHash(s.result())).toBe(s.result().resultHash);expect(readdirSync(path.join(s.home,'artifacts'))).toHaveLength(0)
  expect(readFileSync(path.join(s.cwd,'reports','Đề án.txt'),'utf8'),'the work is still in the copy').toBe('finished output')
})
it('never changes a result the controller already has: a repeat sends the same bytes and hash',async()=>{
  const s=await setup();writeFileSync(path.join(s.cwd,'input.txt'),'agent edit of the input')
  await s.lifecycle.finalize(s.request,s.session);const first=s.result()
  expect(first.outputs.map(output=>output.path).sort()).toEqual(['input.txt','reports/Đề án.txt']);expect(first.complete).toBe(true)
  writeFileSync(driveFile(s,'input.txt'),'the owner typed this later, longer than before');s.unsynced()
  await s.lifecycle.finalize(s.request,s.session)
  const results=s.frames.filter(frame=>frame.type==='WorkspaceResult').map(frame=>frame.body as WorkspaceResult)
  expect(results).toHaveLength(2);expect(results[1]).toEqual(results[0]);expect(s.sent).toHaveLength(4)
})
it('looks again when the first attempt never got its result out',async()=>{
  const s=await setup();writeFileSync(path.join(s.cwd,'input.txt'),'agent edit of the input')
  let failures=1
  const lifecycle=new DeviceWorkspaceLifecycle({service:s.service,copies:s.copies,quiesce:async()=>{},copyDigest:workspaceCopyDigest,
    send:async(type,body)=>{if(failures>0){failures--;return false}s.frames.push({type,body});return true},
    sendArtifact:async(_id,a)=>{s.sent.push({name:a.name,bytes:readFileSync(a.path)});return true},saved:async()=>{},conflicts:noConflicts})
  await lifecycle.finalize(s.request,s.session);expect(s.frames).toEqual([]);expect(s.sent).toHaveLength(2)
  writeFileSync(driveFile(s,'input.txt'),'the owner typed this between the attempts');s.unsynced()
  await lifecycle.finalize(s.request,s.session)
  const result=s.result();expect(result.outputs.map(output=>output.path)).toEqual(['reports/Đề án.txt']);expect(result.complete).toBe(false)
})
it('a file kept back at the freeze makes the result incomplete, so its copy is never pruneable',async()=>{
  const s=await setup();writeFileSync(path.join(s.cwd,'input.txt'),'agent edit of the input')
  writeFileSync(driveFile(s,'input.txt'),'the owner typed this before the turn ended, longer');s.unsynced()
  await s.lifecycle.finalize(s.request,s.session)
  expect(s.result().outputs.map(output=>output.path)).toEqual(['reports/Đề án.txt']);expect(s.result().complete).toBe(false)
  expect(existsSync(path.join(s.cwd,'.atum','DRIVE-CHANGED.txt'))).toBe(true)
  await s.confirm();expect(s.saved).toEqual([])
})
