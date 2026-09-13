import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyFirebaseJwt } from '../src/security/firebase-jwt.ts';
import { hashSecret, parseBoundedJson, validatePairingCode, connectorIsStale } from '../src/security/security.ts';

const project='sagebridge-identity-hypedmoon';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'}) as JsonWebKey;
const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
function token(overrides:Record<string,unknown>={}, header:Record<string,unknown>={}) {
 const now=Math.floor(Date.now()/1000), h=enc({alg:'RS256',kid:'kid1',typ:'JWT',...header});
 const p=enc({iss:`https://securetoken.google.com/${project}`,aud:project,sub:'firebase-subject',iat:now-2,exp:now+300,auth_time:now-3,email:'a@example.com',...overrides});
 const input=`${h}.${p}`; const sig=createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url'); return `${input}.${sig}`;
}
const fetchKeys=async()=>new Response(JSON.stringify({kid1:jwk}),{headers:{'cache-control':'max-age=60'}});

test('cryptographically verifies a valid Firebase RS256 token',async()=>{
 const claims=await verifyFirebaseJwt(token(),project,{fetch:fetchKeys,now:()=>Math.floor(Date.now()/1000)});
 assert.equal(claims.sub,'firebase-subject');
});
for (const [name,change] of [
 ['wrong project',{aud:'other'}],['expired',{exp:1}],['future iat',{iat:Math.floor(Date.now()/1000)+120}],['future auth_time',{auth_time:Math.floor(Date.now()/1000)+120}],['missing subject',{sub:''}]
] as const) test(`rejects ${name}`,async()=>assert.rejects(()=>verifyFirebaseJwt(token(change),project,{fetch:fetchKeys})));
test('rejects invalid signature, unknown kid and non-RS256',async()=>{
 await assert.rejects(()=>verifyFirebaseJwt(token().slice(0,-2)+'aa',project,{fetch:fetchKeys}));
 await assert.rejects(()=>verifyFirebaseJwt(token({}, {kid:'nope'}),project,{fetch:fetchKeys}));
 await assert.rejects(()=>verifyFirebaseJwt(token({}, {alg:'HS256'}),project,{fetch:fetchKeys}));
});
test('hashing is deterministic but does not preserve secret',async()=>{assert.equal(await hashSecret('x'),await hashSecret('x'));assert.notEqual(await hashSecret('x'),'x')});
test('bounded JSON rejects oversized and malformed requests',async()=>{
 await assert.rejects(()=>parseBoundedJson(new Request('https://x',{method:'POST',body:'123456'}),5));
 await assert.rejects(()=>parseBoundedJson(new Request('https://x',{method:'POST',body:'{'}),100));
 assert.deepEqual(await parseBoundedJson(new Request('https://x',{method:'POST',body:'{"a":1}'}),100),{a:1});
});
test('pairing code format and heartbeat staleness are strict',()=>{
 assert.equal(validatePairingCode('ABCD-EFGH'),true); assert.equal(validatePairingCode('abcd_efgh'),false);
 assert.equal(connectorIsStale(new Date(Date.now()-121000).toISOString(),120),true);
 assert.equal(connectorIsStale(new Date().toISOString(),120),false);
});
