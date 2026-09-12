import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeClientIp,clientRateKey} from '../server/core/rate-limit.js';

process.env.DATABASE_URL=process.env.TEST_DATABASE_URL||'postgres://grove:grove_local_only@127.0.0.1:55432/grove';
if(!['127.0.0.1','localhost'].includes(new URL(process.env.DATABASE_URL).hostname))throw new Error('Runtime tests require local PostgreSQL.');
const db=await import('../server/core/db.js');
after(async()=>{await db.closeDb();});
const req=(ip:string,remoteAddress='127.0.0.1')=>({ip,socket:{remoteAddress}}) as any;
test('Azure client port variations share a rate-limit identity',()=>{
 assert.equal(normalizeClientIp('203.0.113.4:54321'),'203.0.113.4');
 assert.equal(clientRateKey(req('203.0.113.4:54321')),clientRateKey(req('203.0.113.4:32100')));
 assert.notEqual(clientRateKey(req('203.0.113.4:54321')),clientRateKey(req('203.0.113.5:54321')));
});
test('IPv6 addresses preserve subnet grouping; malformed proxy identities use the socket',()=>{
 assert.equal(normalizeClientIp('[2001:db8::42]:4444'),'2001:db8::42');
 assert.equal(normalizeClientIp('2001:db8::1234'),'2001:db8::1234');
 assert.equal(clientRateKey(req('[2001:db8::42]:4444')),clientRateKey(req('2001:db8::42')));
 assert.equal(clientRateKey(req('not-an-ip','192.0.2.3')),clientRateKey(req('192.0.2.3')));
});
test('a checked-out PostgreSQL connection loss is handled and the pool remains usable',async()=>{
 const client=await db.pool.connect();let timeout:ReturnType<typeof setTimeout>|undefined;
 try{
  const {rows:[row]}=await client.query('SELECT pg_backend_pid() AS pid');
  const failed=new Promise<Error>((resolve,reject)=>{client.once('error',resolve);timeout=setTimeout(()=>reject(new Error('Expected database disconnect was not observed')),3000);});
  await db.query('SELECT pg_terminate_backend($1)',[row.pid]);
  const error=await failed;assert.ok(error instanceof Error);
  await assert.rejects(()=>client.query('SELECT 1'));
 }finally{clearTimeout(timeout);client.release(true);}
 assert.equal((await db.query<{value:number}>('SELECT 1 AS value'))[0].value,1);
});
