import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {toFile} from 'openai';

test('Azure media uses deployment-scoped versioned URLs for JSON and multipart requests',async()=>{
 process.env.AZURE_OPENAI_ENDPOINT='https://grove-test.openai.azure.com';
 process.env.AZURE_OPENAI_API_KEY='local-transport-fixture-only';
 process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT='grove-image';
 process.env.AZURE_OPENAI_TRANSCRIPTION_DEPLOYMENT='grove-transcribe';
 delete process.env.OPENAI_BASE_URL;
 const requests:{url:URL;method:string;contentType:string}[]=[];
 const originalFetch=globalThis.fetch;
 const mocked=mock.method(globalThis,'fetch',async(input:any,init:any)=>{
  const request=new Request(input,init);
  if(request.url.startsWith('data:'))return originalFetch(input,init);
  requests.push({url:new URL(request.url),method:request.method,contentType:request.headers.get('content-type')||''});
  assert.equal(request.headers.get('api-key'),'local-transport-fixture-only');
  return new Response(JSON.stringify(request.url.includes('/audio/')?{text:'Fixture transcription.'}:{created:1,data:[{b64_json:'fixture'}]}),{status:200,headers:{'Content-Type':'application/json'}});
 });
 try{
  const {mediaAiClient}=await import('../server/ai.js');
  const client=mediaAiClient('image');
  await mediaAiClient('transcription').audio.transcriptions.create({model:'grove-transcribe',file:await toFile(Buffer.from('audio'),'test.wav',{type:'audio/wav'})});
  await client.images.generate({model:'grove-image',prompt:'Transport fixture',n:1});
  await client.images.edit({model:'grove-image',prompt:'Transport fixture',image:await toFile(Buffer.from('image'),'test.png',{type:'image/png'})});
  assert.deepEqual(requests.map(r=>r.url.pathname),['/openai/deployments/grove-transcribe/audio/transcriptions','/openai/deployments/grove-image/images/generations','/openai/deployments/grove-image/images/edits']);
  assert.ok(requests.every(r=>r.method==='POST'&&r.url.searchParams.get('api-version')==='2025-04-01-preview'));
  assert.match(requests[0].contentType,/multipart\/form-data/);assert.match(requests[2].contentType,/multipart\/form-data/);
 }finally{mocked.mock.restore();}
});
