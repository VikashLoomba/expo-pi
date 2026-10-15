import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, type Context as ModelContext } from '@earendil-works/pi-ai';
import { configure } from '@earendil-works/pi-durable';
import { openNodeStore } from '../src/node.mjs';
import { ConfigDoc } from '../src/summary.mjs';
import { openOptChat } from '../src/app.mjs';
import { MemoryDoc } from '../src/memory.mjs';

function gate() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; }

test('SQLite reopen resumes interrupted summary and preserves saved views before the next fresh turn', {timeout:30_000}, async()=>{
  const path=await mkdtemp(join(tmpdir(),'optchat-recovery-'));
  const main=fauxProvider({provider:'main',api:'main-faux',models:[{id:'chat',contextWindow:100_000}]});
  const summary=fauxProvider({provider:'summary',api:'summary-faux',models:[{id:'summary',contextWindow:100_000}]});
  const requests:ModelContext[]=[];
  main.setResponses(Array.from({length:3},(_,i)=>(request:ModelContext)=>{requests.push(structuredClone(request));return fauxAssistantMessage(`reply ${i+1}`);}));
  const started=gate();
  summary.setResponses([async (_input,options)=>{
    started.resolve();
    await new Promise<void>((_resolve,reject)=>{
      const fail=()=>reject(options?.signal?.reason ?? new Error('aborted'));
      if(options?.signal?.aborted)fail();else options?.signal?.addEventListener('abort',fail,{once:true});
    });
    return fauxAssistantMessage('uncommitted summary must not publish');
  }]);
  const models=createModels();models.setProvider(main.provider);models.setProvider(summary.provider);
  const reports:unknown[]=[];
  const options={models,onReport:(e:unknown)=>reports.push(e)};
  let store=await openNodeStore(path);
  let chat=await openOptChat(store.storage,options,context);
  try {
    await chat.root.commit(async tx=>{await configure(tx,chat.root.id,{model:{provider:'main',modelId:'chat'}});(await tx.doc(ConfigDoc,chat.root.id)).summary={model:{provider:'summary',modelId:'summary'},thinkingLevel:'off'};},context);
    await chat.accept({requestId:'anchor',content:'ANCHOR fact'});
    await chat.waitForAnswer('anchor');
    const watch=await chat.harness.watchDoc(MemoryDoc,chat.root.id,context);
    assert.ok(watch);
    const built=gate();
    watch.start(async value=>{if(value && value.nextMessage>=2 && value.frontier===value.nextMessage)built.resolve();});
    if(watch.value && watch.value.nextMessage>=2 && watch.value.frontier===watch.value.nextMessage)built.resolve();
    await built.promise;await watch.stop();
    await chat.accept({requestId:'long',content:'RECOVERY FACT. '+ 'padding '.repeat(200)});
    await chat.waitForAnswer('long');
    await started.promise;
    const saved=await chat.harness.snapshot(MemoryDoc,chat.root.id,context);
    assert.ok(saved);assert.ok(saved.main.refs.length>0);
    const savedViews=structuredClone({main:saved.main,compact:saved.compact});
    const rootId=chat.root.id;
    await chat.close();await store.close(context);
    const resumed=gate(), release=gate();
    summary.setResponses([async()=>{resumed.resolve();await release.promise;return fauxAssistantMessage('user: RECOVERY FACT.');}]);
    store=await openNodeStore(path);
    chat=await openOptChat(store.storage,options,context);
    assert.equal(chat.root.id,rootId);
    await resumed.promise;
    const reopened=await chat.harness.snapshot(MemoryDoc,chat.root.id,context);
    assert.deepEqual({main:reopened!.main,compact:reopened!.compact},savedViews);
    await chat.accept({requestId:'after-restart',content:'continue'});
    assert.equal(requests.length,2);
    release.resolve();
    assert.equal((await chat.waitForAnswer('after-restart')).status,'done');
    assert.equal(requests.length,3);
    const third=requests[2]!;
    assert.equal(third.messages.filter(message=>message.role==='assistant').length,0);
    assert.match(JSON.stringify(third),/ANCHOR fact/);
    assert.match(JSON.stringify(third),/RECOVERY FACT/);
    assert.ok(!JSON.stringify(third).includes('uncommitted summary must not publish'));
    assert.deepEqual(reports,[]);
  } finally {await chat.close();await store.close(context);await rm(path,{recursive:true,force:true});}
});
