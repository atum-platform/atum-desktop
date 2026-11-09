import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
// Desktop request bytes through the actual Shell handler; synthetic owner and in-memory RPC.
// Usage: node apps/desktop/scripts/prove-chatgpt-relay-publication.mjs /path/to/atum-platform
const app = fileURLToPath(new URL('../../../', import.meta.url))
if (!process.argv[2]) throw new Error('Pass the platform checkout path')
const platform = resolve(process.argv[2])
const work = await mkdtemp(join(tmpdir(), 'chatgpt-wire-'))
try {
  await build({
    stdin: {
      contents: `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestMatrixModelDestinations } from ${JSON.stringify(app + '/apps/desktop/electron/matrix/model-destinations.ts')};
import { matrixManagedModel } from ${JSON.stringify(platform + '/apps/shell/src/lib/managed-model-authority.ts')};
import { MatrixChatGptRelay, requestMatrixChatGptRelay } from ${JSON.stringify(app + '/apps/desktop/electron/matrix/chatgpt-relay-client.ts')};
import { chatGptRelay } from ${JSON.stringify(platform + '/apps/shell/src/lib/chatgpt-relay.ts')};
const owner = {issuer:'https://issuer.test',subject:'owner',principal:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const device = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const models = [{id:'gpt-test',displayName:'Test model',efforts:['medium'],defaultEffort:'medium',contextBudget:128000,outputBudget:16384}];
let snapshot = {profile:'atum.chatgpt-relay/1',revision:0,state:'disabled',models:[]};
const calls = [];
const domain = chatGptRelay(async (name,args) => {
 calls.push(name);
 if(name==='chatgpt_relay_enable') snapshot = {...snapshot,revision:1,state:'enabled',deviceServiceId:device,selectedAt:1,models:args.p_input.models};
 if(name==='chatgpt_relay_disable') snapshot = {profile:'atum.chatgpt-relay/1',revision:2,state:'disabled',models:[]};
 return snapshot;
});
globalThis.fetch = async (url,init) => {
 const action = String(url).endsWith('/enable') ? 'enable' : String(url).endsWith('/disable') ? 'disable' : 'status';
 const answer = await domain(owner,new Request(url,init),action==='status'?'chatgpt-relay':{kind:'chatgpt-relay',action});
 console.log(action, 'HTTP',answer.status);
 return answer;
};
const relay = new MatrixChatGptRelay({scope:()=>({accountKey:'synthetic',generation:1}),changed:()=>{},call:(action,signal,body)=>requestMatrixChatGptRelay('https://shell.test/api/matrix/v1','synthetic',action,signal,body)});
assert.equal((await relay.refresh()).state,'disabled');
assert.equal(await relay.enable(device,models),true,'desktop bytes must reach real Shell enable RPC');
assert.deepEqual(relay.view().models,models);
assert.equal(await relay.disable(),true);
assert.deepEqual(calls,['chatgpt_relay_status','chatgpt_relay_enable','chatgpt_relay_disable']);
const fixtures = ${JSON.stringify(platform + '/spec/model-choice/v1.5/fixtures/')};
const fixture = name => JSON.parse(readFileSync(fixtures+name,'utf8'));
const destination = fixture('destination-chatgpt-relay.snapshot.json');
const input = fixture('destination-cloud-chatgpt-relay.request.json');
let selected = false;
const managed = matrixManagedModel(async (name,args) => {
 assert.equal(name,'matrix_model_destination_write');
 assert.deepEqual(args.p_input,input);
 selected = true;
 return destination;
},{open:()=>true});
globalThis.fetch = async (url,init) => managed(owner,new Request(url,init),destination.agentPrincipal,'model-destinations');
const choice = await requestMatrixModelDestinations('https://shell.test/api/matrix/v1','synthetic',destination.agentPrincipal,'write',AbortSignal.timeout(1000),input);
console.log('select ChatGPT model HTTP',choice.status);
assert.equal(choice.status,200,'a visible ChatGPT model must also be selectable through Shell');
assert.equal(selected,true);
console.log('CHATGPT_RELAY_DESKTOP_SHELL_SEAM_OK');
`,
      resolveDir: platform,
      sourcefile: 'relay-proof.ts'
    },
    outfile: join(work, 'proof.mjs'),
    alias: { '@atum/protocol': platform + '/packages/protocol/src/index.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning'
  })
  await import(pathToFileURL(join(work, 'proof.mjs')).href)
} finally {
  await rm(work, { recursive: true, force: true })
}
