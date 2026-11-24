import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startHistoricalPort } from './historical-port.mjs';

const post = (socketPath, value, method='POST') => new Promise((resolve,reject) => {
  const req = request({socketPath,path:'/retrieve',method}, res => {
    let body=''; res.on('data',chunk=>{body+=chunk});
    res.on('end',()=>resolve({status:res.statusCode,body}));
  });
  req.on('error',reject); req.end(JSON.stringify(value));
});

test('native socket rejects foreign agents, writes, stale authority and withdrawal during read', async () => {
  const root = await mkdtemp(join(tmpdir(),'historical-')); await chmod(root,0o700);
  const binding = {owner:{kind:'personal',ownerPrincipal:'owner'},control:{state:'on'},
    agentPrincipal:'agent',audience:{class:'private_owner'}};
  const custody = {owner:{accountKey:'a'.repeat(64),generation:1},binding};
  let current = custody; let calls=0; let withdraw=false;
  const socketPath=join(root,'read.sock');
  const options={socketPath,...custody,current:()=>current,brain:{ready:()=>true,call:async (_owner,method)=>{
    calls++; assert.equal(method,'brain.retrieve');
    if(withdraw) current=null;
    return {status:'ok'};
  }}};
  const port=await startHistoricalPort(options);
  try {
    const req={agentPrincipal:'agent',audience:{class:'private_owner'}};
    assert.equal((await post(socketPath,req)).status,200);
    assert.equal((await post(socketPath,{...req,agentPrincipal:'other'})).status,403);
    assert.equal((await post(socketPath,req,'PUT')).status,403);
    assert.equal(calls,1);
    await assert.rejects(startHistoricalPort(options),{code:'EADDRINUSE'});
    withdraw=true;
    assert.equal((await post(socketPath,req)).status,403);
    assert.equal((await post(socketPath,req)).status,403);
    assert.equal(calls,2);
  } finally { await port.close(); await rm(root,{recursive:true,force:true}); }
});
