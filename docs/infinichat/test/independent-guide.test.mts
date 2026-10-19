import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, configure, createRegistry, defineExtension, type TaskId } from '@earendil-works/pi-durable';
import {
  MemoryDoc, MessageDoc, NodeDoc, appendMessage, publishNode, readNode, reduceView,
  renderMain, renderCompaction, moreDue, clipToolText, type NodeRef, type View,
} from '../src/memory.mjs';

async function memoryHarness() {
 const h=await Harness.open(new MemoryStorage(),{models:createModels(),registry:createRegistry()},context);
 const root=await h.root(context,{init:async(tx,id)=>{await tx.doc(MemoryDoc,id);}});
 return {h,root};
}
const input=(text:string,source='test')=>({kind:'user' as const,text,date:'2026-10-15T01:02:03.000Z',source,images:[]});
const builder=1 as TaskId<string>;

test('independent scalar clipping and exact lossless canonical splitting',async()=>{
 const text='😀é雪'.repeat(12_000);const clipped=clipToolText(text);
 assert.equal(Array.from(clipped).length,30_000);assert.ok(clipped.startsWith(text.slice(0,200)));assert.ok(clipped.endsWith(text.slice(-200)));
 const {h,root}=await memoryHarness();try{
  const ids=await h.commit(tx=>appendMessage(tx,root.id,{...input(text),images:[{data:'original',mimeType:'image/png'}]},true,777),context);
  const records=await Promise.all(ids.map(i=>h.snapshot(MessageDoc,root.id,String(i),context)));
  assert.equal(records.map(x=>x!.text).join(''),text);assert.equal(records.reduce((n,x)=>n+x!.images.length,0),1);
  assert.ok(records.every(x=>x!.bytes===Buffer.byteLength(x!.text,'utf8')));
 }finally{await h.close(context);}
});

test('independent T=10 last-message due counterexample selects newest sibling pair',async()=>{
 const {h,root}=await memoryHarness();try{
  await h.commit(async tx=>{
   const refs:NodeRef[]=[[2,0],[2,1],[0,8],[0,9],[3,0],[1,4]];
   for(const ref of refs)await tx.doc(NodeDoc,root.id,`${ref[0]}:${ref[1]}`,{ref,text:'x'.repeat(60),bytes:60,builder});
   const view:View={refs:[[2,0],[2,1],[0,8],[0,9]],reducing:true};
   await reduceView(tx,root.id,view,10,220);
   assert.deepEqual(view.refs,[[2,0],[2,1],[1,4]]);
  },context);
 }finally{await h.close(context);}
});

test('independent due priority uses exact width-scaled age and oldest tie',()=>{
 assert.equal(moreDue([0,8],[2,0],10),true);
 // Compare ages measured from each pair's LAST covered record.
 // T=11: pair0+4 => (11-3)/2=4, pair8+2 =>(11-9)/1=2, so old wins.
 assert.equal(moreDue([1,0],[0,8],11),true);
 const candidates:NodeRef[]=[[0,0],[0,2],[1,0],[1,2],[2,0]];
 for(let T=16;T<40;T++)for(const a of candidates)for(const b of candidates){
  const aw=2**a[0],bw=2**b[0];const av=(T-((a[1]+2)*aw-1))/aw,bv=(T-((b[1]+2)*bw-1))/bw;
  assert.equal(moreDue(a,b,T),av>bv||(av===bv&&a[1]*aw<b[1]*bw));
 }
});

test('independent compaction cutoff stops at hole and never exposes future text',async()=>{
 const {h,root}=await memoryHarness();try{
  await h.commit(async tx=>{
   for(let i=0;i<5;i++)await appendMessage(tx,root.id,input(`SOURCE_${i}`),true);
   for(const i of [0,2,3,4])await publishNode(tx,root.id,{ref:[0,i],text:`user: SOURCE_${i}`,bytes:14,builder});
   assert.equal(await renderCompaction(tx,root.id,5),'<chat>\n0+1|user: SOURCE_0\n</chat>');
   await assert.rejects(()=>renderMain(tx,root.id),/not ready/);
   await publishNode(tx,root.id,{ref:[0,1],text:'user: SOURCE_1',bytes:14,builder});
   const beforeTwo=await renderCompaction(tx,root.id,2);
   assert.ok(beforeTwo.includes('SOURCE_0'));assert.ok(beforeTwo.includes('SOURCE_1'));
   assert.ok(!beforeTwo.includes('SOURCE_2'));assert.ok(!beforeTwo.includes('not summarized'));
   const complete=await renderMain(tx,root.id);for(let i=0;i<5;i++)assert.ok(complete.includes(`SOURCE_${i}`));
  },context);
 }finally{await h.close(context);}
});

test('independent permanent node publication refuses overwrite',async()=>{
 const {h,root}=await memoryHarness();try{
  await h.commit(async tx=>{await appendMessage(tx,root.id,input('exact'));await publishNode(tx,root.id,{ref:[0,0],text:'user: exact',bytes:11,builder});},context);
  await assert.rejects(h.commit(tx=>publishNode(tx,root.id,{ref:[0,0],text:'changed',bytes:7,builder}),context),/already published/);
  assert.equal((await h.snapshot(NodeDoc,root.id,'0:0',context))?.value?.text,'user: exact');
 }finally{await h.close(context);}
});

test('independent rollback push oracle matches due merges through twenty thousand messages',()=>{
 type State={keep:number;state:number;older:State|null};
 function push(value:number,states:State|null):State{
  if(states===null)return {keep:0,state:value,older:null};
  return states.keep===0?{...states,keep:1}:{keep:0,state:value,older:push(states.state,states.older)};
 }
 let rollback:State|null=null;let refs:NodeRef[]=[];
 for(let i=0;i<=20_000;i++){
  rollback=push(i,rollback);const starts:number[]=[];for(let at:State|null=rollback;at;at=at.older)starts.unshift(at.state);
  refs.push([0,i]);
  while(refs.length>starts.length){let best=-1;
   for(let j=0;j+1<refs.length;j++){const a=refs[j]!,b=refs[j+1]!;
    if(a[0]===b[0]&&a[1]%2===0&&b[1]===a[1]+1&&(best<0||moreDue(a,refs[best]!,i+1)))best=j;
   }
   assert.ok(best>=0,`No merge at count ${i+1}`);const a=refs[best]!;refs.splice(best,2,[a[0]+1,a[1]/2]);
  }
  const actual=refs.map(([l,index])=>[index*2**l,2**l]);
  const expected=starts.map((start,j)=>[start,(starts[j+1]??i+1)-start]);
  assert.deepEqual(actual,expected,`Rollback divergence at count ${i+1}`);
 }
});

test('independent incomplete sawtooth waits for a message boundary rather than parent publication',async()=>{
 const {h,root}=await memoryHarness();try{
  await h.commit(async tx=>{
   for(let i=0;i<260;i++){
    await appendMessage(tx,root.id,input(`message ${i}`));
    await publishNode(tx,root.id,{ref:[0,i],text:'x'.repeat(500),bytes:500,builder});
   }
   const s=await tx.doc(MemoryDoc,root.id);assert.equal(s.main.reducing,true);assert.equal(s.main.refs.length,260);
   const saved=JSON.stringify(s.main.refs);
   for(let i=0;i<130;i++)await publishNode(tx,root.id,{ref:[1,i],text:`pair${i}`,bytes:Buffer.byteLength(`pair${i}`),builder});
   assert.equal(JSON.stringify(s.main.refs),saved,'Parent completions cannot create a new message boundary');
   await appendMessage(tx,root.id,input('next boundary'));
   await publishNode(tx,root.id,{ref:[0,260],text:'next',bytes:4,builder});
   const view=await renderMain(tx,root.id);assert.ok(Buffer.byteLength(view)<=64_000);assert.equal(s.main.reducing,false);
   assert.ok(s.main.refs.length<260);assert.ok(Buffer.byteLength(await renderCompaction(tx,root.id,261))<=16_000);
  },context);
 }finally{await h.close(context);}
});


import { BuildNode, ConfigDoc, pumpBuilds } from '../src/summary.mjs';
import { AppDoc, InputDoc, admitInput } from '../src/app.mjs';

test('independent non-retryable summary failure retries on next assistant canonical message, not immediate pump',async()=>{
 const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);
 // Neither the model's doing nor passing (a missing credential): released until the next message.
 faux.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:'No API key for provider: faux'}),fauxAssistantMessage('summary recovered')]);
 const registry=createRegistry();registry.install(defineExtension({name:'independent-summary',tasks:[BuildNode]}));
 const h=await Harness.open(new MemoryStorage(),{models,registry},context);const root=await h.root(context);
 const model={provider:'faux',modelId:faux.getModel().id};
 try{
  const first=await h.commit(async tx=>{(await tx.doc(ConfigDoc,root.id)).summary={model,thinkingLevel:'off'};await appendMessage(tx,root.id,input('long '.repeat(300)));return await pumpBuilds(tx,root.id);},context);
  assert.equal(first.length,1);assert.equal((await h.waitForTask(first[0]!,context)).state.outcome.status,'failed');
  assert.deepEqual(await h.commit(tx=>pumpBuilds(tx,root.id),context),[]);assert.equal(faux.state.callCount,1);
  const retry=await h.commit(async tx=>{await appendMessage(tx,root.id,{...input('later assistant reply'),'kind':'unii'});return await pumpBuilds(tx,root.id);},context);
  assert.ok(retry.length>=1);for(const id of retry)await h.waitForTask(id,context);
  assert.equal((await h.snapshot(NodeDoc,root.id,'0:0',context))?.value?.text,'summary recovered');
  assert.equal(faux.state.callCount,2);
 }finally{await h.close(context);}
});

test('independent acceptance closes settled native epoch before coordinator acknowledgement',async()=>{
 const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage('finished first answer')]);
 const h=await Harness.open(new MemoryStorage(),{models,registry:createRegistry()},context);
 const root=await h.root(context,{agent:{model:{provider:'faux',modelId:faux.getModel().id}}});
 try{
  await h.commit(async tx=>{
   await admitInput(tx,root.id,{requestId:'first',kind:'user',content:'first input',date:'2026-10-15'});
   const app=await tx.doc(AppDoc,root.id);app.started=true;
   const stored=await tx.doc(InputDoc,root.id,'first',null);stored.value!.phase='prepared';stored.value!.envelope='first input';
  },context);
  await (await root.submit({type:'input',requestId:'optchat:first',content:'first input'},context)).wait(context);
  // Deliberately omit the application's submission acknowledgement and idle processing.
  await h.commit(tx=>admitInput(tx,root.id,{requestId:'second',kind:'user',content:'second input',date:'2026-10-15'}),context);
  const second=(await h.snapshot(InputDoc,root.id,'second',context))!.value!;
  assert.equal(second.fresh,true);assert.equal(second.epoch,2);
  assert.equal((await h.snapshot(InputDoc,root.id,'first',context))!.value!.phase,'prepared');
  const before=(await h.snapshot(MemoryDoc,root.id,context))!.messageProgress;
  await h.commit(tx=>admitInput(tx,root.id,{requestId:'second',kind:'user',content:'second input',date:'different duplicate date'}),context);
  assert.equal((await h.snapshot(MemoryDoc,root.id,context))!.messageProgress,before);
 }finally{await h.close(context);}
});

test('independent strict main and compact high-water byte thresholds',async()=>{
 for(const [count,target,field,low] of [[256,128_000,'main',64_000],[64,32_000,'compact',16_000]] as const){
  const {h,root}=await memoryHarness();try{
   await h.commit(async tx=>{
    const lengths=Array<number>(count).fill(490);
    const overhead=14+Array.from({length:count},(_,i)=>`${i}+1|`.length+1).reduce((a,b)=>a+b,0);
    let remaining=target-overhead-lengths.reduce((a,b)=>a+b,0);
    for(let i=0;i<count&&remaining>0;i++){const add=Math.min(22,remaining);lengths[i]!+=add;remaining-=add;}
    assert.equal(remaining,0,'Fixture must use legal <=512-byte node text');
    for(let i=0;i<count;i++){
     await appendMessage(tx,root.id,input(`source${i}`));
     await publishNode(tx,root.id,{ref:[0,i],text:'x'.repeat(lengths[i]!),bytes:lengths[i]!,builder});
     // Parents become available normally, after both children, but must not trigger a main batch.
     if(i%2===1)await publishNode(tx,root.id,{ref:[1,(i-1)/2],text:'p',bytes:1,builder});
    }
    const s=await tx.doc(MemoryDoc,root.id);
    const render=field==='main'?await renderMain(tx,root.id):await renderCompaction(tx,root.id,count);
    assert.equal(Buffer.byteLength(render),target);assert.equal(s[field].reducing,false);
    const compactBefore=s.compact.refs.map((ref):NodeRef=>[ref[0],ref[1]]);
    await appendMessage(tx,root.id,input('threshold plus one'));
    await publishNode(tx,root.id,{ref:[0,count],text:'x',bytes:1,builder});
    const after=field==='main'?await renderMain(tx,root.id):await renderCompaction(tx,root.id,count+1);
    assert.ok(Buffer.byteLength(after)<=low);assert.ok(s[field].refs.length<count);
    // Each view batches on its own size: the chat's batch only appends to the compactions' view.
    if(field==='main')assert.deepEqual(s.compact.refs,[...compactBefore,[0,count]]);
   },context);
  }finally{await h.close(context);}
 }
});

import { openOptChat } from '../src/app.mjs';
import { PrivateAgentDoc } from '../src/agents.mjs';
import type { Context as ModelContext } from '@earendil-works/pi-ai';

test('independent native agent tool lets main finish then delivers one complete report as fresh turn', {timeout:30_000}, async()=>{
 const faux=fauxProvider({models:[{id:'agent-model',contextWindow:100_000}]});const models=createModels();models.setProvider(faux.provider);
 let release!:()=>void;const privateGate=new Promise<void>(r=>{release=r;});let privateStarted=false,privateFinished=false;
 const requests:ModelContext[]=[];
 const respond=async(request:ModelContext)=>{
  requests.push(structuredClone(request));
  const users=request.messages.filter(m=>m.role==='user');const last=users.at(-1)!;
  const blocks=typeof last.content==='string'?[{type:'text' as const,text:last.content}]:last.content;
  const latestText=blocks.filter(b=>b.type==='text').map(b=>b.text).join('');
  const lastBlock=blocks.at(-1);
  if(lastBlock?.type==='text'&&lastBlock.text==='PRIVATE_TASK_SENTINEL'){
   privateStarted=true;await privateGate;privateFinished=true;return fauxAssistantMessage('PRIVATE_REPLY_COMPLETE');
  }
  if(latestText.includes('[Worker] PRIVATE_REPLY_COMPLETE'))return fauxAssistantMessage('RECEIVED_REPORT');
  if(request.messages.some(m=>m.role==='toolResult'))return fauxAssistantMessage('MAIN_FINISHED_WITHOUT_WAIT');
  return fauxAssistantMessage([{type:'toolCall',id:'spawn-worker',name:'agent',arguments:{name:'Worker',task:'PRIVATE_TASK_SENTINEL'}}],{stopReason:'toolUse'});
 };
 faux.setResponses(Array.from({length:20},()=>respond));
 const reports:unknown[]=[];const model={provider:'faux',modelId:'agent-model'};
 const chat=await openOptChat(new MemoryStorage(),{models,onReport:e=>reports.push(e)},context);
 try{
  await chat.root.commit(async tx=>{await configure(tx,chat.root.id,{model});(await tx.doc(ConfigDoc,chat.root.id)).summary={model,thinkingLevel:'off'};},context);
  await chat.accept({requestId:'spawn-request',content:'Please use a subagent.'});
  assert.equal((await chat.waitForAnswer('spawn-request')).status,'done');
  assert.equal(privateFinished,false,'Foreground must not wait for private report');
  const agent=(await chat.harness.snapshot(PrivateAgentDoc,chat.root.id,'Worker',context))!;assert.ok(agent);
  const reportId=`optchat:agent:${agent.taskId}:report`;
  const watch=await chat.harness.watchDoc(AppDoc,chat.root.id,context);assert.ok(watch);
  let admitted!:()=>void;const admittedPromise=new Promise<void>(r=>{admitted=r;});
  const inspect=(v:typeof watch.value)=>{if(v?.requests.includes(reportId)||v?.pending.includes(reportId))admitted();};
  watch.start(async v=>inspect(v));inspect(watch.value);
  release();await admittedPromise;await watch.stop();
  assert.equal((await chat.waitForAnswer(reportId)).status,'done');
  assert.equal(privateStarted,true);assert.equal(privateFinished,true);
  const reportInput=(await chat.harness.snapshot(InputDoc,chat.root.id,reportId,context))!.value!;
  assert.equal(reportInput.fresh,true);assert.equal(reportInput.content,'[Worker] PRIVATE_REPLY_COMPLETE');
  const memory=(await chat.harness.snapshot(MemoryDoc,chat.root.id,context))!;
  const canonical=await Promise.all(Array.from({length:memory.nextMessage},(_,i)=>chat.harness.snapshot(MessageDoc,chat.root.id,String(i),context)));
  assert.equal(canonical.filter(m=>m?.kind==='work').length,1);
  assert.equal(canonical.filter(m=>m?.text==='PRIVATE_REPLY_COMPLETE').length,0,'Private output never enters main as ordinary assistant record');
  assert.equal(canonical.find(m=>m?.kind==='work')?.text,'[Worker] PRIVATE_REPLY_COMPLETE');
  assert.deepEqual(reports,[]);
 }finally{release();await chat.close();}
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNodeStore } from '../src/node.mjs';

test('independent saved main and compaction views survive actual SQLite app reopen without refitting', {timeout:30_000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'optchat-view-reopen-'));
 const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);
 const model={provider:'faux',modelId:faux.getModel().id};
 const options={models};let store=await openNodeStore(dir);let chat=await openOptChat(store.storage,options,context);
 try{
  await chat.root.commit(async tx=>{await configure(tx,chat.root.id,{model});(await tx.doc(ConfigDoc,chat.root.id)).summary={model,thinkingLevel:'off'};},context);
  for(let i=0;i<4;i++)await chat.accept({requestId:`note${i}`,kind:'note',content:`original note ${i}`});
  const watch=await chat.harness.watchDoc(MemoryDoc,chat.root.id,context);assert.ok(watch);
  let finished!:()=>void;const done=new Promise<void>(r=>{finished=r;});
  const inspect=(s:typeof watch.value)=>{if(s&&s.frontier===4&&s.readyParents.length===0&&Object.keys(s.active).length===0)finished();};
  watch.start(async value=>inspect(value));inspect(watch.value);await done;await watch.stop();
  // Different valid saved granularities detect a forbidden reconstruction from leaves.
  await chat.harness.commit(async tx=>{
   assert.ok(await readNode(tx,chat.root.id,[2,0]));
   const s=await tx.doc(MemoryDoc,chat.root.id);s.main.refs=[[1,0],[1,1]];s.compact.refs=[[2,0]];
  },context);
  const before=await chat.harness.commit(async tx=>({main:await renderMain(tx,chat.root.id),compact:await renderCompaction(tx,chat.root.id,4),state:JSON.parse(JSON.stringify(await tx.doc(MemoryDoc,chat.root.id)))}),context);
  const rootId=chat.root.id;await chat.close();await store.close(context);
  store=await openNodeStore(dir);chat=await openOptChat(store.storage,options,context);
  assert.equal(chat.root.id,rootId);
  const after=await chat.harness.commit(async tx=>({main:await renderMain(tx,chat.root.id),compact:await renderCompaction(tx,chat.root.id,4),state:JSON.parse(JSON.stringify(await tx.doc(MemoryDoc,chat.root.id)))}),context);
  assert.equal(after.main,before.main);assert.equal(after.compact,before.compact);
  assert.deepEqual(after.state.main,before.state.main);assert.deepEqual(after.state.compact,before.state.compact);
  assert.equal(faux.state.callCount,0,'Short imported sources and parents need no provider');
 }finally{await chat.close();await store.close(context);await rm(dir,{recursive:true,force:true});}
});
