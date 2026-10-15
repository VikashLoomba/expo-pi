import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { memoryTools, pageText, toolPolicy } from '../src/tools.mjs';
import { MessageDoc, clipToolText } from '../src/memory.mjs';
import { originalPrompt, sharedPrompt } from '../src/prompt.mjs';

test('shared system prompt retains exact guide text unless permitted options substitute it', () => {
  assert.equal(sharedPrompt('Unii', true), originalPrompt);
  assert.ok(sharedPrompt('OptChat', true).includes('- unii: OptChat'));
  assert.equal(sharedPrompt('Dot', false, 'My files live here.').includes("The user's computers"), false);
  assert.ok(sharedPrompt('Dot', false, 'My files live here.').endsWith('My files live here.'));
});
test('Unicode pages return every scalar without clipping or overlap',()=>{
 const source='😀'.repeat(60_000);let rebuilt='';for(let i=0;i<3;i++)rebuilt+=pageText(source,i).split('\n').slice(1).join('\n');assert.equal(rebuilt,source);
});
test('real native zoom/date tools read permanent docs and preserve original image',async()=>{
 const faux=fauxProvider({models:[{id:'test'}],tokensPerSecond:1e9});const models=createModels();models.setProvider(faux.provider);
 const registry=createRegistry();const harness=await Harness.open(new MemoryStorage(),{models,registry,settings:{compaction:{enabled:false},toolExecution:'sequential'}},context);
 try {
  const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'test'}}});
  const tools=memoryTools(root.id);registry.install(defineExtension({name:'memory',tools}));registry.install(toolPolicy(tools,async()=>undefined));
  await root.commit(async tx=>{await tx.doc(MessageDoc,root.id,'0',{i:0,kind:'user',text:'Original 😀',bytes:13,date:'2026-10-15T00:00:00Z',source:'input',images:[{data:'YWJj',mimeType:'image/png'}]});},context);
  let seen:any;
  faux.setResponses([fauxAssistantMessage([fauxToolCall('zoom',{id:0,n:1}),fauxToolCall('date',{id:0})],{stopReason:'toolUse'}),(request:any)=>{seen=request;return fauxAssistantMessage('done');}]);
  assert.equal((await(await root.submit({type:'input',content:'read memory'},context)).wait(context)).status,'done');
  const results=seen.messages.filter((m:any)=>m.role==='toolResult');assert.equal(results.length,2);
  assert.ok(results[0].content.some((x:any)=>x.type==='text'&&x.text.includes('Original 😀')));assert.ok(results[0].content.some((x:any)=>x.type==='image'&&x.data==='YWJj'));
  assert.ok(results[1].content.some((x:any)=>x.text==='2026-10-15T00:00:00Z'));
 }finally{await harness.close(context);}
});

test('native output hook keeps exact Unicode head and tail including diagnostic-inclusive model budget',async()=>{
 const { defineTool }=await import('@earendil-works/pi-durable');const {Type}=await import('@earendil-works/pi-ai');
 const full='HEAD'+'😀\n'.repeat(40_000)+'TAIL';
 const tool=defineTool({name:'large',description:'large',parameters:Type.Object({}),async execute(){return{output:[{type:'text' as const,text:full}],diagnostics:[{severity:'info' as const,message:'d'.repeat(20_000)}]};}});
 const faux=fauxProvider({models:[{id:'test',contextWindow:1_000_000}],tokensPerSecond:1e9});const models=createModels();models.setProvider(faux.provider);const registry=createRegistry();registry.install(defineExtension({name:'tools',tools:[tool]}));registry.install(toolPolicy([tool],async()=>undefined));let seen:any;
 faux.setResponses([fauxAssistantMessage([fauxToolCall('large',{})],{stopReason:'toolUse'}),(request:any)=>{seen=request;return fauxAssistantMessage('done');}]);
 const harness=await Harness.open(new MemoryStorage(),{models,registry,settings:{compaction:{enabled:false}}},context);
 try{const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'test'}}});await(await root.submit({type:'input',content:'run'},context)).wait(context);const result=seen.messages.find((m:any)=>m.role==='toolResult');const text=result.content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('');assert.equal(Array.from(text).length,30_000);assert.ok(text.startsWith('HEAD'));const entry=(await root.entries({order:'ascending'},100,undefined,context)).items.find(e=>e.kind==='pi.tool-result')!;const raw=entry.model![0]!;assert.equal(raw.role,'toolResult');if(raw.role==='toolResult')assert.equal(text,clipToolText(raw.content.filter(x=>x.type==='text').map(x=>x.text).join('')));assert.ok(text.includes('d'.repeat(100)));}finally{await harness.close(context);}
});
test('native sequential beforeTool admits steer after current call and blocks stale remaining calls',async()=>{
 const { defineTool }=await import('@earendil-works/pi-durable');const {Type}=await import('@earendil-works/pi-ai');
 let started!:()=>void,release!:()=>void;const began=new Promise<void>(r=>started=r),go=new Promise<void>(r=>release=r);const calls:string[]=[];
 const tool=defineTool({name:'work',description:'work',parameters:Type.Object({name:Type.String()}),async execute({name}){calls.push(name);if(name==='a'){started();await go;}return{output:[{type:'text' as const,text:name}]};}});
 const faux=fauxProvider({models:[{id:'test'}],tokensPerSecond:1e9});const models=createModels();models.setProvider(faux.provider);const registry=createRegistry();registry.install(defineExtension({name:'tools',tools:[tool]}));registry.install(toolPolicy([tool],async()=>undefined));let seen:any;
 faux.setResponses([fauxAssistantMessage([fauxToolCall('work',{name:'a'}),fauxToolCall('work',{name:'b'}),fauxToolCall('work',{name:'c'})],{stopReason:'toolUse'}),(request:any)=>{seen=request;return fauxAssistantMessage('done');}]);
 const harness=await Harness.open(new MemoryStorage(),{models,registry,settings:{compaction:{enabled:false},toolExecution:'sequential',steeringMode:'all'}},context);
 try{const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'test'}}});const first=await root.submit({type:'input',content:'run'},context);await began;const steer=await root.submit({type:'input',content:'change plans',whenBusy:'steer'},context);release();await first.wait(context);await steer.wait(context);assert.deepEqual(calls,['a']);assert.ok(seen.messages.some((m:any)=>m.role==='user'&&JSON.stringify(m.content).includes('change plans')));assert.equal(seen.messages.filter((m:any)=>m.role==='toolResult').length,3);}finally{await harness.close(context);}
});

test('completed native bash spill recovers full Unicode head and tail through public environment API',async()=>{
 const {createBashTool}=await import('@earendil-works/pi-durable/tools');const {NodeExecutionEnv}=await import('@earendil-works/pi-durable/env/node');
 const env=new NodeExecutionEnv({cwd:'/tmp'}),tool=createBashTool();
 const faux=fauxProvider({models:[{id:'test',contextWindow:1_000_000}],tokensPerSecond:1e9});const models=createModels();models.setProvider(faux.provider);const registry=createRegistry();registry.install(defineExtension({name:'tools',tools:[tool]}));registry.install(toolPolicy([tool],async()=>env,{bash:"bash"}));let seen:any;
 faux.setResponses([fauxAssistantMessage([fauxToolCall('bash',{command:`node -e 'process.stdout.write("HEAD" + "😀\\n".repeat(80000) + "TAIL")'`})],{stopReason:'toolUse'}),(request:any)=>{seen=request;return fauxAssistantMessage('done');}]);
 const harness=await Harness.open(new MemoryStorage(),{models,registry,env:()=>env,settings:{compaction:{enabled:false}}},context);
 try{const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'test'}}});await(await root.submit({type:'input',content:'run'},context)).wait(context);const result=seen.messages.find((m:any)=>m.role==='toolResult');const text=result.content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('');assert.equal(result.isError,false);assert.ok(text.startsWith('HEAD'));assert.ok(text.includes('TAIL'));assert.equal(Array.from(text).length,30_000);}finally{await harness.close(context);}
});

for (const body of ['😀'.repeat(40_000), '\n'.repeat(40_000)]) test('native bounds preserve original head before final diagnostic-inclusive cap: '+(body[0]==='\n'?'newlines':'four-byte Unicode'),async()=>{
 const {defineTool}=await import('@earendil-works/pi-durable');const {Type}=await import('@earendil-works/pi-ai');
 const full='HEAD'+body+'TAIL';const tool=defineTool({name:'boundary',description:'boundary',parameters:Type.Object({}),async execute(){return{output:[{type:'text' as const,text:full}],diagnostics:[{severity:'info' as const,message:'diagnostic'}]};}});
 const faux=fauxProvider({models:[{id:'test',contextWindow:1_000_000}],tokensPerSecond:1e9});const models=createModels();models.setProvider(faux.provider);const registry=createRegistry();registry.install(defineExtension({name:'tools',tools:[tool]}));registry.install(toolPolicy([tool],async()=>undefined));let seen:any;
 faux.setResponses([fauxAssistantMessage([fauxToolCall('boundary',{})],{stopReason:'toolUse'}),(request:any)=>{seen=request;return fauxAssistantMessage('done');}]);
 const harness=await Harness.open(new MemoryStorage(),{models,registry,settings:{compaction:{enabled:false}}},context);
 try{const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'test'}}});await(await root.submit({type:'input',content:'run'},context)).wait(context);const entry=(await root.entries({order:'ascending'},100,undefined,context)).items.find(e=>e.kind==='pi.tool-result')!;const original=entry.model![0]!;assert.equal(original.role,'toolResult');if(original.role!=='toolResult')throw new Error('Missing tool result');const raw=original.content.filter(x=>x.type==='text').map(x=>x.text).join('');assert.ok(raw.startsWith('HEAD'));assert.ok(raw.includes('TAIL'));const result=seen.messages.find((m:any)=>m.role==='toolResult');const text=result.content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('');assert.equal(text,clipToolText(raw));assert.equal(Array.from(text).length,30_000);assert.ok(text.startsWith('HEAD'));assert.ok(text.includes('TAIL'));}finally{await harness.close(context);}
});
