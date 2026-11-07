import test from 'node:test';
import assert from 'node:assert/strict';
import { SwitchAgentAdapter, SwitchAdapterError } from '../src/switch/SwitchAgentAdapter.js';

const fixture = responder => {
  const calls=[];
  const adapter=new SwitchAgentAdapter({apiUrl:'https://switch.example/api',agentId:'orchestrator-1',apiKey:'server-secret',connectionId:'active-connection',roomId:'room-42',agentNames:{recon:'RECON',auditor:'AUDITOR',resolver:'RESOLVER'},timeoutMs:100,fetchImpl:async(url,options)=>{calls.push({url,options});const body=responder(url,options);return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})}});
  return {adapter,calls};
};

const ops = {operations:{connect_to_room:{},list_participants:{},send_targeted_message:{},read_context:{}}};

test('connection check uses documented operation routes, headers, bodies, and agent participants',async()=>{
  const {adapter,calls}=fixture(url=>url.endsWith('/ops')?ops:url.endsWith('/connect_to_room')?{result:{room_id:'room-42',name:'MATCHPOINT'}}:{result:[{id:'1',name:'RECON',type:'agent',status:'connected'},{id:'2',name:'AUDITOR',type:'agent',status:'connected'},{id:'3',name:'RESOLVER',type:'agent',status:'connected'}]});
  const result=await adapter.checkConnection();
  assert.equal(result.connected,true);assert.equal(result.mode,'LIVE');assert.equal(result.roomName,'MATCHPOINT');
  assert.equal(calls[0].url,'https://switch.example/api/agents/orchestrator-1/ops');
  assert.equal(calls[1].url,'https://switch.example/api/agents/orchestrator-1/ops/connect_to_room');
  assert.equal(calls[1].options.headers.Authorization,'Bearer server-secret');
  assert.equal(calls[1].options.headers['X-Switch-Connection-Id'],'active-connection');
  assert.deepEqual(JSON.parse(calls[1].options.body),{room_id:'room-42'});
});

test('participant names that belong to users do not satisfy configured agent identities',async()=>{
  const {adapter}=fixture(url=>url.endsWith('/ops')?ops:url.endsWith('/connect_to_room')?{result:{name:'MATCHPOINT'}}:{result:[{name:'RECON',type:'user'},{name:'AUDITOR',type:'agent'},{name:'RESOLVER',type:'agent'}]});
  const status=await adapter.checkConnection();assert.equal(status.connected,false);assert.match(status.error,/RECON/);
});

test('targeted message validates event correlation id and documented delivery statuses',async()=>{
  const {adapter,calls}=fixture(()=>({result:{event_id:'evt-1',target_statuses:{RECON:'live'}}}));
  const sent=await adapter.sendTask({role:'RECON',prompt:'Investigate source values.'});
  assert.equal(sent.event_id,'evt-1');assert.equal(sent.delivery,'live');
  assert.equal(calls[0].url,'https://switch.example/api/agents/orchestrator-1/ops/send_targeted_message');
  assert.deepEqual(JSON.parse(calls[0].options.body),{body:'Investigate source values.',target_names:['RECON']});
});

test('targeted message allows documented polling delivery status and policy refusal for reply validation',async()=>{
  for (const delivery of ['awaiting_manual_poll','not_permitted']) {
    const {adapter}=fixture(()=>({result:{event_id:'evt-1',target_statuses:{RECON:delivery}}}));
    assert.equal((await adapter.sendTask({role:'RECON',prompt:'task'})).delivery,delivery);
  }
});

test('targeted message fails closed for missing, malformed, or unreachable target statuses',async()=>{
  for (const result of [{event_id:'e',target_statuses:{}},{event_id:'e'},{event_id:'e',target_statuses:{RECON:'disconnected'}},{event_id:'e',target_statuses:{RECON:'no_session'}}]) {
    const {adapter}=fixture(()=>({result}));
    await assert.rejects(adapter.sendTask({role:'RECON',prompt:'task'}),SwitchAdapterError);
  }
});

test('read_context maps documented root and reply entries to the root thread id',async()=>{
  const {adapter,calls}=fixture(()=>({result:{threads:[{root:{id:'evt-1',kind:'message',sender:'orchestrator-1',sender_name:'MATCHPOINT',body:'task',timestamp:'2026-11-05T00:00:00Z',attachments:[]},replies:[{id:'reply-1',kind:'message',sender:'recon-id',sender_name:'RECON',body:'{"ok":true}',timestamp:'2026-11-05T00:00:01Z',attachments:[]}]}],truncated:false,oldest_timestamp:null}}));
  const updates=await adapter.readUpdates({since:Date.parse('2026-11-05T00:00:00Z')});
  assert.deepEqual(JSON.parse(calls[0].options.body),{room_id:'room-42',limit:100,since:'2026-11-05T00:00:00.000Z'});
  assert.equal(updates[1].threadId,'evt-1');assert.equal(updates[1].id,'reply-1');
});

test('agent reply polling requires sender and exact task thread; ignores unrelated or duplicate root messages',async()=>{
  let reads=0;
  const {adapter}=fixture(()=>{reads++;return {result:{threads:[
    {root:{id:'other-root',kind:'message',sender:'recon-id',sender_name:'RECON',body:'{"wrong":true}',timestamp:'2026-11-05T00:00:01Z'},replies:[]},
    {root:{id:'task-root',kind:'message',sender:'orchestrator-1',sender_name:'MATCHPOINT',body:'task',timestamp:'2026-11-05T00:00:00Z'},replies:[{id:'reply-1',kind:'message',sender:'recon-id',sender_name:'RECON',body:'{"ok":true}',timestamp:'2026-11-05T00:00:02Z'}]}
  ],truncated:false,oldest_timestamp:null}}});
  const reply=await adapter.waitForAgentReply({role:'RECON',after:Date.parse('2026-11-05T00:00:00Z'),threadId:'task-root',timeoutMs:100,pollMs:1});
  assert.equal(reply.id,'reply-1');assert.equal(reads,1);
});

test('known participant identity prevents another agent from replying under the same display name',async()=>{
  const {adapter}=fixture(url=>url.endsWith('/ops')?ops:url.endsWith('/connect_to_room')?{result:{name:'MATCHPOINT'}}:url.endsWith('/list_participants')?{result:[{id:'recon-correct',name:'RECON',type:'agent'},{id:'auditor-id',name:'AUDITOR',type:'agent'},{id:'resolver-id',name:'RESOLVER',type:'agent'}]}:{result:{threads:[{root:{id:'task-root',kind:'message',sender:'orchestrator-1',sender_name:'MATCHPOINT',body:'task',timestamp:'2026-11-05T00:00:00Z'},replies:[{id:'reply-1',kind:'message',sender:'wrong-agent',sender_name:'RECON',body:'{}',timestamp:'2026-11-05T00:00:02Z'}]}],truncated:false,oldest_timestamp:null}});
  assert.equal((await adapter.checkConnection()).connected,true);
  await assert.rejects(adapter.waitForAgentReply({role:'RECON',after:Date.parse('2026-11-05T00:00:00Z'),threadId:'task-root',timeoutMs:5,pollMs:1}),e=>e.code==='agent_timeout');
});

test('reply polling times out when only a wrong participant or unrelated thread replies',async()=>{
  const {adapter}=fixture(()=>({result:{threads:[{root:{id:'other-root',kind:'message',sender:'x',sender_name:'RECON',body:'{}',timestamp:'2026-11-05T00:00:02Z'},replies:[]}],truncated:false,oldest_timestamp:null}}));
  await assert.rejects(adapter.waitForAgentReply({role:'RECON',after:Date.parse('2026-11-05T00:00:00Z'),threadId:'task-root',timeoutMs:5,pollMs:1}),e=>e.code==='agent_timeout');
});

test('malformed Switch operation envelope and malformed read_context fail closed',async()=>{
  const {adapter}=fixture(()=>({unexpected:true}));
  await assert.rejects(adapter.operation('connect_to_room'),e=>e.code==='invalid_response');
  const broken=fixture(()=>({result:{threads:[{root:{id:'x'},replies:null}]}}));
  await assert.rejects(broken.adapter.readUpdates(),e=>e.code==='invalid_response');
});

test('request timeout, invalid JSON and server errors propagate as typed failures',async()=>{
  const timeout=new SwitchAgentAdapter({apiUrl:'https://switch.example/api',agentId:'a',apiKey:'k',connectionId:'c',roomId:'r',agentNames:{},fetchImpl:async()=>{throw Object.assign(new Error('late'),{name:'TimeoutError'});}});
  await assert.rejects(timeout.request('/agents/a/ops'),e=>e.code==='timeout');
  const invalid=new SwitchAgentAdapter({apiUrl:'https://switch.example/api',agentId:'a',apiKey:'k',connectionId:'c',roomId:'r',agentNames:{},fetchImpl:async()=>new Response('not json',{status:200})});
  await assert.rejects(invalid.request('/agents/a/ops'),e=>e.code==='invalid_response');
  const failed=new SwitchAgentAdapter({apiUrl:'https://switch.example/api',agentId:'a',apiKey:'k',connectionId:'c',roomId:'r',agentNames:{},fetchImpl:async()=>new Response('{}',{status:503})});
  await assert.rejects(failed.request('/agents/a/ops'),e=>e.code==='switch_error'&&e.status===503);
});

test('live status reports credential rejection without falling back to mock',async()=>{
  const adapter=new SwitchAgentAdapter({apiUrl:'https://switch.example/api',agentId:'agent',apiKey:'bad',connectionId:'connection',roomId:'room',agentNames:{recon:'RECON',auditor:'AUDITOR',resolver:'RESOLVER'},fetchImpl:async()=>new Response('{}',{status:401})});
  const status=await adapter.checkConnection();assert.equal(status.mode,'LIVE');assert.equal(status.connected,false);assert.match(status.error,/rejected/);
});
