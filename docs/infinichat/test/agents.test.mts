import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineDoc } from '@earendil-works/pi-durable';
import { memoryTools } from '../src/tools.mjs';
import { AgentTask, AgentDirectoryDoc, PrivateAgentDoc, AgentReportDoc, launchAgent, takeAgentReports } from '../src/agents.mjs';

test('private agent freezes view, inherits configuration, publishes full final text once without reasoning', async () => {
  const faux = fauxProvider({ models: [{ id: 'agent', contextWindow: 100_000 }] });
  const requests: unknown[] = [];
  const fullText = 'report '.repeat(6000);
  faux.setResponses([request => {
    requests.push(structuredClone(request));
    const response = fauxAssistantMessage(fullText);
    response.content.unshift({type:'thinking',thinking:'private reasoning',thinkingSignature:'retained-signature'});
    return response;
  }]);
  const models = createModels(); models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const registry = createRegistry(); registry.install(defineExtension({name:'optchat', tasks:[AgentTask]}));
  const reports: unknown[] = [];
  const harness = await Harness.open(storage, {models, registry, onReport:e=>reports.push(e)}, context);
  const WorkDoc = defineDoc({kind:'test.work', version:1,scope:'conversation',history:'latest',fork:'current', initial:()=>({items:[] as {requestId:string;text:string}[]})});
  const root = await harness.root(context,{agent:{model:{provider:'faux',modelId:'agent'},instructions:'Same immutable system',thinkingLevel:'high'}});
  try {
    const id = await root.commit(tx=>launchAgent(tx,root.id,{name:'Research',task:'Investigate the question.',frozenView:'<chat>\nfrozen memory\n</chat>'}),context);
    const done = await harness.waitForTask(id,context);
    assert.equal(done.state.outcome.status,'completed');
    const agent = await harness.snapshot(PrivateAgentDoc,root.id,'Research',context);
    assert.equal(agent?.status,'completed'); assert.ok(agent?.conversationId);
    const childRecord = await storage.conversation(agent.conversationId,context);
    assert.equal(childRecord?.owner?.taskId,id);
    const native = await (await harness.conversation(agent.conversationId,context))!.context(context);
    assert.ok(JSON.stringify(native).includes('retained-signature'));
    const serialized = JSON.stringify(requests);
    assert.ok(serialized.includes('frozen memory')); assert.ok(serialized.includes('Investigate the question.'));
    assert.ok(serialized.includes('Same immutable system'));
    assert.equal(requests.length,1);
    const report = await harness.snapshot(AgentReportDoc,root.id,'Research',context);
    assert.equal(report?.text,`[Research] ${fullText}`);
    assert.equal(report?.consumed,false);
    assert.ok(!report?.text.includes('private reasoning'));
    const mainBefore = await root.context(context);
    assert.equal(mainBefore.messages.length,0);
    await root.commit(async tx=>{ (await tx.doc(WorkDoc,root.id)).items.push(...await takeAgentReports(tx,root.id)); },context);
    await root.commit(async tx=>{ (await tx.doc(WorkDoc,root.id)).items.push(...await takeAgentReports(tx,root.id)); },context);
    assert.equal((await harness.snapshot(WorkDoc,root.id,context))?.items.length,1);
    assert.deepEqual((await harness.snapshot(AgentDirectoryDoc,root.id,context))?.pendingReports,[]);
    await assert.rejects(root.commit(tx=>launchAgent(tx,root.id,{name:'Research',task:'different',frozenView:'changed'}),context),/already exists/);
    registry.install(defineExtension({name:'inspect-private',tools:memoryTools(root.id)}));
    let zoomRequest = '';
    faux.appendResponses([
      fauxAssistantMessage([fauxToolCall('zoom',{id:'Research',page:0})],{stopReason:'toolUse'}),
      request=>{zoomRequest=JSON.stringify(request);return fauxAssistantMessage('inspected');},
    ]);
    await (await root.submit({type:'input',requestId:'inspect',content:'Inspect private transcript'},context)).wait(context);
    assert.ok(zoomRequest.includes('frozen memory'));
    assert.ok(zoomRequest.includes('Investigate the question.'));
    assert.ok(zoomRequest.includes('assistant: report'));
    assert.ok(!zoomRequest.includes('private reasoning'));
    assert.ok(zoomRequest.includes('Page 1/2'));
    assert.deepEqual(reports,[]);
  } finally { await harness.close(context); }
});

test('background launch waits for captured complete summary cutoff, not future messages', async () => {
  const {appendMessage, publishNode, MemoryDoc} = await import('../src/memory.mjs');
  const faux = fauxProvider({models:[{id:'agent',contextWindow:100_000}]});
  const calls: unknown[] = [];
  faux.setResponses([request=>{calls.push(structuredClone(request));return fauxAssistantMessage('done');}]);
  const models=createModels();models.setProvider(faux.provider);
  const registry=createRegistry();registry.install(defineExtension({name:'optchat',tasks:[AgentTask]}));
  const harness=await Harness.open(new MemoryStorage(),{models,registry},context);
  const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'agent'}}});
  try {
    const id=await root.commit(async tx=>{
      await appendMessage(tx,root.id,{kind:'user',text:'earlier content',date:'2026-10-15',source:'one',images:[]});
      const id=await launchAgent(tx,root.id,{name:'Later',task:'work',cutoff:1});
      await appendMessage(tx,root.id,{kind:'user',text:'future content',date:'2026-10-15',source:'two',images:[]});
      return id;
    },context);
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(calls.length,0);
    await root.commit(tx=>publishNode(tx,root.id,{ref:[0,0],text:'earlier summary',bytes:15,builder:id as unknown as import('@earendil-works/pi-durable').TaskId<string>}),context);
    const completed=await harness.waitForTask(id,context);
    assert.equal(completed.state.outcome.status,'completed');
    assert.equal(calls.length,1);
    assert.ok(JSON.stringify(calls).includes('earlier summary'));
    assert.ok(!JSON.stringify(calls).includes('future content'));
    assert.equal((await harness.snapshot(MemoryDoc,root.id,context))?.frontier,1);
  } finally {await harness.close(context);}
});
