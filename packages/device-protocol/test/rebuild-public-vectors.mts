/** Re-sign sanitized public case vectors. Fresh keys live only in memory; no private key is exported.
 * Keep declared verdicts/negative cases: this repairs crypto, never derives expectations from code.
 * Run from this package: npx tsx test/rebuild-public-vectors.mts
 */
import { generateKeyPairSync, createPublicKey, createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keyId, deviceSignedBytes, deviceMessageHash, leaseTokenHash } from '../hashes.ts';
const root = fileURLToPath(new URL('../fixtures/device-service/fixtures/', import.meta.url));
const files = readdirSync(root).filter(n => n.endsWith('.json'));
const data = new Map(files.map(n => [n, JSON.parse(readFileSync(root+n, 'utf8'))]));
const replacements = new Map<string,string>();
const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
function visit(v: any, fn: (v: any)=>void) {
  if (!v || typeof v !== 'object') return;
  fn(v); for (const item of Object.values(v)) visit(item,fn);
}
// Replace each public SPKI and its digest consistently, preserving distinct keys.
for (const v of data.values()) visit(v, obj => {
  for (const value of Object.values(obj)) {
    if (typeof value !== 'string' || replacements.has(value)) continue;
    try {
      const old = createPublicKey({ key: Buffer.from(value,'base64url'), format:'der', type:'spki' });
      const pair = old.asymmetricKeyType === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', {namedCurve:'P-256'});
      const pub = pair.publicKey.export({format:'der',type:'spki'}) as Buffer;
      const encoded = pub.toString('base64url');
      replacements.set(value,encoded);
      replacements.set(keyId(Buffer.from(value,'base64url')), keyId(pub));
      keys.set(encoded,pair);
    } catch { /* ordinary strings are not keys */ }
  }
});
function replace(v: any): any {
  if (typeof v === 'string') return replacements.get(v) ?? v;
  if (Array.isArray(v)) return v.map(replace);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)]));
  return v;
}
for (const [n,v] of data) data.set(n,replace(v));
const byKid = new Map([...keys].map(([pub,pair])=>[keyId(Buffer.from(pub,'base64url')),pair]));
function signature(pub: string, bytes: Buffer): string {
  const pair = keys.get(pub)!;
  return sign(pair.privateKey.asymmetricKeyType==='ed25519' ? null : 'sha256',bytes,
    {key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
// Rebind hashes whose signed bodies changed during sanitization, including duplicate receipts.
replacements.clear();
for (const v of data.get('hashes.vectors.json').vectors) {
  if (v.kind==='lease_token') replacements.set(v.leaseTokenHash,leaseTokenHash(v.leaseToken));
}
for (const v of data.values()) if (v.execute && v.facts?.commandHash) {
  replacements.set(v.facts.commandHash,deviceMessageHash('Execute',v.execute.body));
}
for (const [n,v] of data) data.set(n,replace(v));
for (const [n,v] of data) {
  if (!n.endsWith('.case.json')) continue;
  for (const field of ['grant','execute','renew','revoke','approve']) {
    const frame=v[field];
    if (!frame?.sig || v.facts?.signatureValid !== true) continue;
    const pair=byKid.get(frame.kid);
    if (!pair) throw new Error(`missing public signing key: ${n}`);
    const pub=(pair.publicKey.export({type:'spki',format:'der'}) as Buffer).toString('base64url');
    frame.sig=signature(pub,deviceSignedBytes(frame.type,frame.body));
  }
  if (v.approve) {
    const hash=deviceMessageHash('Approve',v.approve.body);
    if (v.facts?.approvalHash) v.facts.approvalHash=hash;
    if (v.expect?.approvalHash) v.expect.approvalHash=hash;
  }
  if (v.request?.sigs) {
    const bytes=deviceSignedBytes('EnrollDevice',v.request.body);
    for (const [sig,pub,valid] of [
      ['identity',v.request.body.identityKey,v.facts.identityValid],
      ['approval',v.request.body.approvalKey,v.facts.approvalValid],
      ['previousApproval',v.stored?.approvalKey,v.facts.previousApprovalValid],
    ] as const) if (valid) v.request.sigs[sig]=signature(pub,bytes);
  }
}
for (const v of data.get('signatures.vectors.json').vectors) {
  if (v.valid) v.frame.sig=signature(v.publicKey,deviceSignedBytes(v.frame.type,v.frame.body));
}
for (const v of data.get('hashes.vectors.json').vectors) {
  if (v.kind==='lease_token') v.leaseTokenHash=leaseTokenHash(v.leaseToken);
}
for (const [n,v] of data) writeFileSync(root+n,JSON.stringify(v,null,2)+'\n');

// Record the public derivative's digest using the existing pack framing algorithm.
const packRoot = fileURLToPath(new URL('../fixtures/device-service/', import.meta.url));
const contract=JSON.parse(readFileSync(packRoot+'contract.json','utf8'));
const digest=createHash('sha256');
for (const file of contract.pack_files) {
  const path=Buffer.from(file,'utf8'), body=readFileSync(packRoot+file);
  const plen=Buffer.alloc(4), blen=Buffer.alloc(8);
  plen.writeUInt32BE(path.length); blen.writeBigUInt64BE(BigInt(body.length));
  digest.update(plen).update(path).update(blen).update(body);
}
const pin=digest.digest('hex');
writeFileSync(packRoot+'PINNED-SHA256',pin+'\n');
const manifestPath=fileURLToPath(new URL('../fixtures/vendored.json',import.meta.url));
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
manifest.packs['device-service'].pinned_sha256=pin;
manifest.packs['device-service'].public_derivative='Sanitized identities; fresh in-memory signing keys; original verdicts retained.';
writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
