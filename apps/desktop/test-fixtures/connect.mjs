import test from 'node:test';
import assert from 'node:assert/strict';
import {atumConnectAdapter} from '../electron/work/connect.ts';
const config={enabled:true,relayUrl:'https://relay.test',platformUrl:'https://platform.test'};
test('off by default',()=>assert.equal(atumConnectAdapter({},{}),undefined));
test('fixed endpoint, no redirects, new device approval, memory-only assertion',async()=>{
 const adapter=atumConnectAdapter(config,{owner:()=> 'owner',bearer:async()=> 'fixture',fetch:async(url,init)=>{
 assert.equal(url,'https://platform.test/api/work/connect/assertion'); assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer fixture');
 return Response.json({assertion:'a.b.c',expires_in:60});
 }});
 assert.equal(adapter.requireNewDeviceApproval,true); assert.equal(await adapter.getAssertion(),'a.b.c');
});
test('account switch discards result',async()=>{
 let owner='first'; const adapter=atumConnectAdapter(config,{owner:()=>owner,bearer:async()=> 'fixture',fetch:async()=>{owner='second';return Response.json({assertion:'a.b.c',expires_in:60})}});
 await assert.rejects(adapter.getAssertion(),/account_changed/);
});
test('unsafe origins refused',()=>assert.throws(()=>atumConnectAdapter({...config,relayUrl:'http://relay.test'},{})));
