/**
 * PHANTOM black-box REST lifecycle acceptance probe.
 * Requires Node 18+; no dependencies.
 * Usage: PHANTOM_API=http://127.0.0.1:8787 node scripts/contract_probe.mjs
 * Expected API contract: collection GET -> array, item POST -> JSON object with id,
 * GET item -> object, PATCH item -> object, DELETE item -> 204 or 200.
 * Uses its own unique resource names and deletes everything it creates.
 */
import assert from 'node:assert/strict';

const base = (process.env.PHANTOM_API || 'http://127.0.0.1:8787').replace(/\/$/, '');
const uid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const tests = [];
const note = (name, fn) => tests.push([name, fn]);
async function request(method, path, data, headers={}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(data === undefined ? {} : {'content-type':'application/json'}), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${path}: response is not JSON: ${text.slice(0, 250)}`); }
  return { status: res.status, body: json };
}
function expectStatus(actual, allowed, label) {
  assert.ok(allowed.includes(actual), `${label}: expected ${allowed.join('/')} got ${actual}`);
}
let taskId;
let noteId;

note('Cold GET collection returns an array', async () => {
  const r=await request('GET','/api/tasks');
  expectStatus(r.status,[200],'GET /api/tasks');
  assert.ok(Array.isArray(r.body),'GET /api/tasks response must be a JSON array');
});

note('Undeclared POST creates a real task',async () => {
  const r=await request('POST','/api/tasks',{title:`Probe ${uid}`,description:'verified end-to-end',status:'todo'});
  expectStatus(r.status,[201],'POST /api/tasks');
  assert.ok(r.body && typeof r.body==='object','POST returns JSON record');
  assert.ok(r.body.id!==undefined,'POST must return id');
  assert.equal(r.body.title,`Probe ${uid}`);
  taskId=encodeURIComponent(String(r.body.id));
});

note('GET item and collection both include saved record', async () => {
  const one=await request('GET',`/api/tasks/${taskId}`);
  expectStatus(one.status,[200],'GET item');
  assert.equal(one.body.title,`Probe ${uid}`);
  const many=await request('GET','/api/tasks');
  assert.ok(Array.isArray(many.body),'GET collection returns array');
  assert.ok(many.body.some(x=>String(x.id)===decodeURIComponent(taskId)),'Created record appears in collection');
});

note('PATCH actually mutates the saved record', async () => {
  const r=await request('PATCH',`/api/tasks/${taskId}`,{status:'done'});
  expectStatus(r.status,[200],'PATCH item');
  const one=await request('GET',`/api/tasks/${taskId}`);
  assert.equal(one.body.status,'done');
});

note('An entirely new resource is discovered automatically',async () => {
  const post=await request('POST','/api/notes',{title:`New resource ${uid}`,content:'Phantom should never need a route registration'});
  expectStatus(post.status,[201],'POST /api/notes');
  assert.ok(post.body?.id!==undefined,'Notes creation returns id');
  noteId=encodeURIComponent(String(post.body.id));
  const get=await request('GET',`/api/notes/${noteId}`);
  expectStatus(get.status,[200],'GET note');
  assert.equal(get.body.title,`New resource ${uid}`);
});

note('DELETE removes record; missing record returns 404',async () => {
  const del=await request('DELETE',`/api/tasks/${taskId}`);
  expectStatus(del.status,[200,204],'DELETE task');
  const get=await request('GET',`/api/tasks/${taskId}`);
  expectStatus(get.status,[404],'GET deleted task');
  const list=await request('GET','/api/tasks');
  assert.ok(!list.body.some(x=>String(x.id)===decodeURIComponent(taskId)),'Deleted task absent from collection');
  taskId=undefined;
});

let failed=0;
try {
  for(const [name,fn] of tests) {
    try { await fn(); console.log('PASS',name); }
    catch(err) { failed++; console.error('FAIL',name,'\n ',err.message); }
  }
} finally {
  if(taskId) await request('DELETE',`/api/tasks/${taskId}`).catch(()=>{});
  if(noteId) await request('DELETE',`/api/notes/${noteId}`).catch(()=>{});
}
console.log(`\n${tests.length-failed}/${tests.length} acceptance checks passed against ${base}`);
if(failed) process.exitCode=1;
