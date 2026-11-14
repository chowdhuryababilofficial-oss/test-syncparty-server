'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const EventEmitter = require('node:events');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const OPTIONAL = new Set([
  'episode_metadata_provider','episode_metadata_id','episode_numbering_system',
  'absolute_episode_number','media_position_sec','media_duration_sec'
]);
const clone = value => value == null ? value : structuredClone(value);

function createDb() {
  const tables = {
    scrapbook_entries: [], journey_state: [], sitting_decisions: [], sitting_ledger: [],
    shared_memories: [], shared_memory_members: [], chapters: [], relations: [], users: []
  };
  const db = {
    tables,
    rpc: async (name, args) => {
      if (db.failWith) return { data: null, error: clone(db.failWith) };
      if (name === 'sp_scrapbook_save_ledger') return { data: { status: 'inserted' }, error: null };
      if (name === 'sp_scrapbook_bump_totals') {
        const columns = { shared_memory_members:['watch_sec','together_sec','session_count'], shared_memories:[null,'together_sec','session_count'], scrapbook_entries:['watch_duration_sec','together_duration_sec','session_count'] }[args.p_table];
        const row = (tables[args.p_table]||[]).find(x=>String(x.id)===String(args.p_id));
        if(row&&columns) { [args.p_watch,args.p_together,args.p_sessions].forEach((v,i)=>{if(columns[i])row[columns[i]]=Math.max(0,Number(row[columns[i]]||0)+Number(v||0));}); row.updated_at=args.p_at; if(args.p_table!=='scrapbook_entries')row.last_watched_at=Math.max(Number(row.last_watched_at||0),Number(args.p_at)); }
        return { data: !!row, error: null };
      }
      return { data: true, error: null };
    },
    from(table) { return new Query(this, table); }
  };
  return db;
}
class Query {
  constructor(db, table) { this.db=db; this.table=table; this.mode='select'; this.filters=[]; this.payload=null; this.single=false; this.max=null; }
  select() { return this; }
  eq(column,value) { this.filters.push([column,value]); return this; }
  in(column,values) { this.filters.push([column,values,'in']); return this; }
  limit(n) { this.max=n; return this; }
  order() { return this; }
  like(column,value) { this.filters.push([column,value,'like']); return this; }
  maybeSingle() { this.single=true; return this; }
  insert(value) { this.mode='insert'; this.payload=value; return this; }
  update(value) { this.mode='update'; this.payload=value; return this; }
  delete() { this.mode='delete'; return this; }
  then(resolve,reject) { return this.execute().then(resolve,reject); }
  async execute() {
    if (this.db.failWith) return {data:null,error:clone(this.db.failWith)};
    const rows=this.db.tables[this.table]||(this.db.tables[this.table]=[]);
    const missing = column => OPTIONAL.has(column);
    if (this.mode==='select') {
      const missingFilter=this.filters.find(([column])=>missing(column));
      if (missingFilter) return {data:null,error:{code:'PGRST204',message:`Could not find the '${missingFilter[0]}' column of '${this.table}' in the schema cache`}};
      let selected=rows.filter(row=>this.filters.every(([column,value,op])=>{
        if(op==='in')return value.includes(row[column]);
        if(op==='like')return String(row[column]||'').startsWith(String(value).replace(/%$/,''));
        return row[column]===value;
      }));
      if(this.max!=null)selected=selected.slice(0,this.max);
      return {data:this.single?(selected[0]?clone(selected[0]):null):clone(selected),error:null};
    }
    if (this.mode==='insert' || this.mode==='update') {
      const data=this.mode==='insert'?(Array.isArray(this.payload)?this.payload:[this.payload]):this.payload;
      const payloads=Array.isArray(data)?data:[data];
      const missingColumn=payloads.flatMap(x=>Object.keys(x||{})).find(missing);
      if(missingColumn)return {data:null,error:{code:'PGRST204',message:`Could not find the '${missingColumn}' column of '${this.table}' in the schema cache`}};
      if(this.mode==='insert'){
        const inserted=payloads.map(row=>{const value=clone(row);rows.push(value);return value;});
        return {data:this.single?(inserted[0]||null):inserted,error:null};
      }
      const updated=rows.filter(row=>this.filters.every(([column,value,op])=>op==='in'?value.includes(row[column]):row[column]===value));
      for(const row of updated)Object.assign(row,clone(this.payload));
      return {data:this.single?(updated[0]?clone(updated[0]):null):clone(updated),error:null};
    }
    if(this.mode==='delete'){
      const keep=rows.filter(row=>!this.filters.every(([column,value])=>row[column]===value));
      this.db.tables[this.table]=keep;return {data:null,error:null};
    }
    return {data:null,error:null};
  }
}
function loadStore(storePath,db) {
  const resolved=path.resolve(storePath);
  const basedir=path.dirname(resolved);
  const supaPath=require.resolve(path.join(basedir,'supabase.js'));
  const authPath=require.resolve(path.join(basedir,'auth-store.js'));
  delete require.cache[resolved];
  require.cache[supaPath]={id:supaPath,filename:supaPath,loaded:true,exports:{getSupabaseAdmin:()=>db}};
  require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{publicUser:user=>user||null,resolveSession:async token=>token==='Bearer keep-http-test-token'?{id:'user-A'}:null}};
  return require(resolved);
}
function decision(db, sourceKey='episode:tmdb:555:s1:e3') {
  db.tables.sitting_decisions.push({
    sitting_id:'sit_keep_0001',user_id:'user-A',source_key:sourceKey,destination:'PERSONAL',
    chapter_id:null,co_sitting_id:null,reason:'solo',decided_at:1700000000000,last_active_at:1700000000000
  });
}
const episode=()=>({
  sourceKey:'episode:tmdb:555:s1:e3',title:'Example Show',canonicalTitle:'Example Show',contentType:'series',kind:'series',
  metadataProvider:'tmdb',metadataId:'555',metadataYear:2024,season:1,episode:3,episodeTitle:'Episode Three',
  episodeMetadataProvider:'tvdb',episodeMetadataId:'3003',episodeNumberingSystem:'season_episode',
  progress:.42,mediaPositionSec:252,mediaDurationSec:600,watchDurationDeltaSec:30,togetherDurationDeltaSec:8,
  sessionCountDelta:1,firstWatchedAt:1699999990000,lastWatchedAt:1700000001000
});
async function main() {
  process.env.SCRAPBOOK_DB_LOCKS='0';
  const finalStorePath=path.join(ROOT,'scrapbook-store.js');
  const baselineStorePath=process.env.SP_BASELINE_STORE;
  const log=[];

  // Reproduce the previous V2 /keep code against the pre-migration schema.
  if(baselineStorePath){
    const db=createDb();decision(db);
    const store=loadStore(baselineStorePath,db);
    let failed=false,detail='';
    try{await store.saveSitting('user-A',{sittingId:'sit_keep_0001',seq:1,entry:episode(),watchSecCum:30,togetherSecCum:8});}
    catch(e){failed=true;detail=`${e.code||'ERROR'}: ${e.message}`;}
    assert.equal(failed,true,'baseline should fail when the six additive columns are absent');
    assert.match(detail,/episode_metadata_provider|schema cache|column/i);
    log.push('BASELINE FAIL (reproduced): V2 /keep sitting-save rejects pre-migration schema: '+detail);
    console.log('BASELINE FAIL (reproduced): '+detail);
  }

  // The exact server acknowledgement classifier must reject ignored results.
  {
    const store=loadStore(finalStorePath,createDb());
    assert.equal(store.wasSittingSavePersisted({ok:true,target:{destination:'PERSONAL',id:'entry-1'}}),true);
    assert.equal(store.wasSittingSavePersisted({ok:true,duplicate:true}),true);
    assert.equal(store.wasSittingSavePersisted({ok:true,ignored:'removed'}),false);
    assert.equal(store.wasSittingSavePersisted({ok:true}),false);
    log.push('PASS: server persistence acknowledgement is true only for an actual target or confirmed ledger duplicate; ignored/empty saves are false.');
  }

  // Corrected V2 /keep path uses the real production saveSitting ->
  // ensurePersonalRow -> writePersonalRow pipeline. The fake PostgREST layer
  // rejects all six migration columns on both filters and writes.
  {
    const db=createDb();decision(db);
    const store=loadStore(finalStorePath,db);
    const result=await store.saveSitting('user-A',{sittingId:'sit_keep_0001',seq:1,entry:episode(),watchSecCum:30,togetherSecCum:8});
    assert.equal(result.ok,true);
    assert.equal(result.persisted,undefined); // persistence marker belongs to HTTP route
    assert.equal(result.target.destination,'PERSONAL');
    assert.equal(db.tables.scrapbook_entries.length,1);
    const row=db.tables.scrapbook_entries[0];
    assert.equal(row.source_key,'episode:tmdb:555:s1:e3');
    assert.equal(row.metadata_provider,'tmdb');
    assert.equal(row.metadata_id,'555');
    assert.equal(row.season,1);assert.equal(row.episode,3);
    for(const column of OPTIONAL)assert.equal(Object.hasOwn(row,column),false);
    log.push('FIX PASS: production saveSitting persisted one personal episode row on a pre-migration schema; canonical series provider + S/E retained; optional columns safely omitted.');
    console.log('PASS V2 /keep persists under pre-migration schema; row=',JSON.stringify({id:row.id,source_key:row.source_key,metadata_provider:row.metadata_provider,metadata_id:row.metadata_id,season:row.season,episode:row.episode,watch_duration_sec:row.watch_duration_sec,session_count:row.session_count}));
  }

  // Direct /entries personal save on an existing legacy row: optional-column
  // UPDATE fallback plus lost-ack idempotency for watch/session deltas.
  {
    const db=createDb();
    db.tables.scrapbook_entries.push({
      id:'entry-existing',user_id:'user-A',scope:'personal',relation_id:null,source_key:'episode:tmdb:555:s1:e3',
      title:'Example Show',kind:'series',content_type:'series',canonical_title:'Example Show',
      metadata_provider:'tmdb',metadata_id:'555',metadata_year:2024,season:1,episode:3,
      progress:.25,watch_duration_sec:100,together_duration_sec:20,session_count:2,
      first_watched_at:1699999990000,last_watched_at:1700000001000,created_at:1700000000000,updated_at:1700000000000
    });
    const store=loadStore(finalStorePath,db);
    const same=await store.upsertEntry('user-A',episode());
    assert.equal(same.watchDurationSec,100,'same event replay must not double-count');
    assert.equal(same.togetherDurationSec,20);
    assert.equal(same.sessionCount,2);
    const newer={...episode(),lastWatchedAt:1700000002000,watchDurationDeltaSec:25,togetherDurationDeltaSec:5,sessionCountDelta:1};
    const saved=await store.upsertEntry('user-A',newer);
    assert.equal(saved.watchDurationSec,125);
    assert.equal(saved.togetherDurationSec,25);
    assert.equal(saved.sessionCount,3);
    const retry=await store.upsertEntry('user-A',newer);
    assert.equal(retry.watchDurationSec,125);
    assert.equal(retry.togetherDurationSec,25);
    assert.equal(retry.sessionCount,3);
    assert.equal(db.tables.scrapbook_entries.length,1);
    log.push('PASS: direct personal UPDATE works with missing six columns; retry of same event is idempotent; newer event increments totals once.');
    console.log('PASS direct /entries UPDATE + idempotency; stored=',JSON.stringify({source_key:db.tables.scrapbook_entries[0].source_key,watch_duration_sec:db.tables.scrapbook_entries[0].watch_duration_sec,together_duration_sec:db.tables.scrapbook_entries[0].together_duration_sec,session_count:db.tables.scrapbook_entries[0].session_count,last_watched_at:db.tables.scrapbook_entries[0].last_watched_at}));
  }

  // Direct /entries INSERT with absent new columns must retain legacy series
  // identity; this is a separate route from the V2 sitting save.
  {
    const db=createDb();
    const store=loadStore(finalStorePath,db);
    const saved=await store.upsertEntry('user-B',{...episode(),sourceKey:'episode:tmdb:555:s1:e4',episode:4,watchDurationDeltaSec:12,sessionCountDelta:1});
    assert.ok(saved?.id);
    const row=db.tables.scrapbook_entries[0];
    assert.equal(row.metadata_provider,'tmdb');assert.equal(row.metadata_id,'555');
    assert.equal(row.season,1);assert.equal(row.episode,4);
    assert.equal(row.watch_duration_sec,12);assert.equal(row.session_count,1);
    log.push('PASS: direct /entries INSERT retries without optional episode columns while retaining canonical series metadata and watch totals.');
    console.log('PASS direct /entries INSERT; stored=',JSON.stringify({id:row.id,source_key:row.source_key,metadata_provider:row.metadata_provider,metadata_id:row.metadata_id,season:row.season,episode:row.episode,watch_duration_sec:row.watch_duration_sec,session_count:row.session_count}));
  }

  // Direct Our Story /keep retries must not increment participant totals twice.
  {
    const db=createDb();
    db.tables.relations.push({id:'rel-keep-1',user1_id:'user-A',user2_id:'user-B',accepted_at:Date.now(),archived_at:null,ended_at:null});
    const store=loadStore(finalStorePath,db);
    const start=Date.now()+10;
    const event={...episode(),lastWatchedAt:start,watchDurationDeltaSec:40,togetherDurationDeltaSec:20,sessionCountDelta:1};
    const partnerEvent={...event,lastWatchedAt:start+5000,watchDurationDeltaSec:60,togetherDurationDeltaSec:30,sessionCountDelta:1};
    // Both participants invoke /keep concurrently, alongside an exact retry
    // from participant A. The chapter lock must create one shared memory and
    // one member row per participant.
    const [first,concurrentDuplicate,partnerFirst]=await Promise.all([
      store.upsertEntry('user-A',event,'rel-keep-1'),
      store.upsertEntry('user-A',event,'rel-keep-1'),
      store.upsertEntry('user-B',partnerEvent,'rel-keep-1')
    ]);
    assert.ok(first?.id);assert.equal(concurrentDuplicate?.id,first.id);assert.equal(partnerFirst?.id,first.id);
    let member=db.tables.shared_memory_members.find(x=>x.user_id==='user-A');
    let partner=db.tables.shared_memory_members.find(x=>x.user_id==='user-B');
    assert.equal(member.watch_sec,40);assert.equal(member.together_sec,20);assert.equal(member.session_count,1);
    assert.equal(partner.watch_sec,60);assert.equal(partner.together_sec,30);assert.equal(partner.session_count,1);
    await Promise.all([
      store.upsertEntry('user-A',event,'rel-keep-1'),
      store.upsertEntry('user-B',partnerEvent,'rel-keep-1')
    ]);
    member=db.tables.shared_memory_members.find(x=>x.user_id==='user-A');
    partner=db.tables.shared_memory_members.find(x=>x.user_id==='user-B');
    assert.equal(member.watch_sec,40,'lost-ack retry cannot double-count shared watch time');
    assert.equal(member.together_sec,20);assert.equal(member.session_count,1);
    assert.equal(partner.watch_sec,60,'partner retry cannot double-count shared watch time');
    assert.equal(partner.together_sec,30);assert.equal(partner.session_count,1);
    const later=await store.upsertEntry('user-A',{...event,lastWatchedAt:start+10000,watchDurationDeltaSec:15,togetherDurationDeltaSec:7,sessionCountDelta:1},'rel-keep-1');
    member=db.tables.shared_memory_members.find(x=>x.user_id==='user-A');
    assert.equal(member.watch_sec,55);assert.equal(member.together_sec,27);assert.equal(member.session_count,2);
    assert.equal(db.tables.shared_memories.length,1,'both participants share one Our Story memory');
    assert.equal(db.tables.shared_memory_members.length,2,'each partner has exactly one individual member row');
    log.push('PASS: direct shared /keep is idempotent under concurrent duplicate calls, a later event increments once, and two participants retain separate totals in one shared memory.');
    console.log('PASS direct shared /keep retry + two participants; stored=',JSON.stringify({memoryCount:db.tables.shared_memories.length,memberCount:db.tables.shared_memory_members.length,memberA:{watch_sec:member.watch_sec,together_sec:member.together_sec,session_count:member.session_count,last_watched_at:member.last_watched_at},memberB:{watch_sec:partner.watch_sec,together_sec:partner.together_sec,session_count:partner.session_count,last_watched_at:partner.last_watched_at}}));
  }

  // Exercise the real HTTP route and sanitized request/response correlation.
  // The only HTTP dependency stubbed here is ws transport; the actual server.js
  // route and the actual production scrapbook-store are loaded.
  {
    const db=createDb();
    const store=loadStore(finalStorePath,db);
    const authPath=require.resolve(path.join(ROOT,'auth-store.js'));
    require.cache[authPath].exports={publicUser:user=>user||null,resolveSession:async token=>token==='Bearer keep-http-test-token'?{id:'user-A'}:null};
    const capturedInfo=[],capturedError=[];
    const originalInfo=console.info.bind(console),originalError=console.error.bind(console);
    console.info=(...args)=>{capturedInfo.push(args);originalInfo(...args);};
    console.error=(...args)=>{capturedError.push(args);originalError(...args);};
    const probe=net.createServer();
    await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
    const port=probe.address().port;
    await new Promise(resolve=>probe.close(resolve));
    process.env.PORT=String(port);
    process.env.SP_DISABLE_SCRAPBOOK_MAINTENANCE='1';
    const originalLoad=Module._load;
    class FakeWebSocketServer extends EventEmitter { constructor(){super();this.clients=new Set();} }
    Module._load=function(request,parent,isMain){
      if(request==='ws')return {WebSocketServer:FakeWebSocketServer};
      return originalLoad.call(this,request,parent,isMain);
    };
    try { require(path.join(ROOT,'server.js')); }
    finally { Module._load=originalLoad; }
    const url=`http://127.0.0.1:${port}/api/scrapbook/entries`;
    const send=async(requestId,entry)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer keep-http-test-token','X-Request-ID':requestId,'X-SyncParty-Operation':'entry-save'},body:JSON.stringify({entry,scope:'personal'})});
    let response;
    for(let attempt=0;attempt<30;attempt++){
      try { response=await send('keep-http-success-001',{...episode(),sourceKey:'episode:tmdb:555:s1:e8'});break; }
      catch { await new Promise(resolve=>setTimeout(resolve,25)); }
    }
    assert.ok(response,'HTTP server should start and accept the /keep request');
    const successBody=await response.json();
    assert.equal(response.status,200);assert.equal(successBody.persisted,true);
    assert.equal(response.headers.get('x-request-id'),'keep-http-success-001');
    assert.equal(db.tables.scrapbook_entries.length,1);
    const successLog=capturedInfo.find(args=>args[0]==='[SyncParty Scrapbook keep]'&&args[1]?.requestId==='keep-http-success-001');
    assert.ok(successLog,'successful API write must emit a request-correlated persistence log');
    assert.equal(successLog[1].httpStatus,200);assert.equal(successLog[1].persisted,true);assert.ok(successLog[1].recordId);
    console.log('PASS HTTP personal /keep; requestId=keep-http-success-001 status=200 persisted=true recordId='+successLog[1].recordId+' rowCount='+db.tables.scrapbook_entries.length);

    // Matched series /keep uses the V2 sitting route. A real target row is
    // acknowledged, while a tombstoned/removed journey is explicitly 409 and
    // never called persisted.
    const v2Entry={...episode(),sourceKey:'episode:tmdb:556:s1:e10',title:'Second Example Show',canonicalTitle:'Second Example Show',metadataId:'556'};
    decision(db,v2Entry.sourceKey);
    const sittingUrl=`http://127.0.0.1:${port}/api/scrapbook/sittings/save`;
    response=await fetch(sittingUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer keep-http-test-token','X-Request-ID':'keep-http-sitting-003','X-SyncParty-Operation':'sitting-save'},body:JSON.stringify({sittingId:'sit_keep_0001',seq:1,entry:v2Entry,watchSecCum:30,togetherSecCum:0})});
    const sittingBody=await response.json();
    assert.equal(response.status,200);assert.equal(sittingBody.persisted,true);
    const sittingLog=capturedInfo.find(args=>args[0]==='[SyncParty Scrapbook keep]'&&args[1]?.requestId==='keep-http-sitting-003');
    assert.ok(sittingLog);assert.equal(sittingLog[1].httpStatus,200);assert.equal(sittingLog[1].persisted,true);assert.ok(sittingLog[1].targetId);
    assert.equal(db.tables.scrapbook_entries.length,2);
    console.log('PASS HTTP V2 sitting /keep; requestId=keep-http-sitting-003 status=200 persisted=true targetId='+sittingLog[1].targetId);

    const ignoredEntry={...episode(),sourceKey:'episode:tmdb:557:s1:e11',title:'Removed Example Show',canonicalTitle:'Removed Example Show',metadataId:'557'};
    db.tables.sitting_decisions.push({sitting_id:'sit_keep_ignored',user_id:'user-A',source_key:ignoredEntry.sourceKey,destination:'PERSONAL',chapter_id:null,co_sitting_id:null,reason:'solo',decided_at:1700000000000,last_active_at:1700000000000});
    db.tables.journey_state.push({id:'removed-j1',space:'u:user-A',journey_key:'removed example show',generation:1,removed_at:1700000000100});
    const beforeIgnored=db.tables.scrapbook_entries.length;
    response=await fetch(sittingUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer keep-http-test-token','X-Request-ID':'keep-http-ignored-004','X-SyncParty-Operation':'sitting-save'},body:JSON.stringify({sittingId:'sit_keep_ignored',seq:1,entry:ignoredEntry,watchSecCum:30,togetherSecCum:0})});
    const ignoredBody=await response.json();
    assert.equal(response.status,409);assert.equal(ignoredBody.persisted,false);assert.equal(ignoredBody.ignored,'removed');
    assert.equal(db.tables.scrapbook_entries.length,beforeIgnored,'ignored sitting must not write a memory');
    const ignoredLog=capturedInfo.find(args=>args[0]==='[SyncParty Scrapbook keep]'&&args[1]?.requestId==='keep-http-ignored-004');
    assert.ok(ignoredLog);assert.equal(ignoredLog[1].httpStatus,409);assert.equal(ignoredLog[1].persisted,false);assert.equal(ignoredLog[1].ignored,'removed');
    console.log('PASS HTTP V2 ignored save; requestId=keep-http-ignored-004 status=409 persisted=false ignored=removed rowCount='+db.tables.scrapbook_entries.length);

    db.failWith={code:'XX001',message:'synthetic database write fault',details:'deterministic test-only database failure'};
    response=await send('keep-http-failure-002',{...episode(),sourceKey:'episode:tmdb:555:s1:e9'});
    const failedBody=await response.json();
    assert.equal(response.status,500);assert.equal(failedBody.requestId,'keep-http-failure-002');
    assert.equal(response.headers.get('x-request-id'),'keep-http-failure-002');
    assert.equal(db.tables.scrapbook_entries.length,2,'failed request must not create another row');
    const errorLog=capturedError.find(args=>args[0]==='[SyncParty Scrapbook API]'&&args[1]?.requestId==='keep-http-failure-002');
    assert.ok(errorLog,'database failure must emit a correlated sanitized error log');
    assert.equal(errorLog[1].httpStatus,500);assert.equal(errorLog[1].operation,'POST /api/scrapbook/entries');assert.equal(errorLog[1].code,'XX001');
    console.log('PASS HTTP failure; requestId=keep-http-failure-002 status=500 code=XX001 persisted=false rowCount='+db.tables.scrapbook_entries.length);
    console.info=originalInfo;console.error=originalError;
    log.push('PASS: real server.js /api/scrapbook/entries route returns persisted=true only after the production store created a row; request ID and HTTP status correlate to sanitized server logs.');
    log.push('PASS: matched series /keep sitting endpoint acknowledges a real target row, while a removed/tombstoned sitting returns HTTP 409 persisted=false with no write.');
    log.push('PASS: injected deterministic DB fault returns HTTP 500, includes request ID, logs operation/code/status, and leaves row count unchanged.');
  }

  console.log(`\n${log.length} server persistence assertions passed.`);
  // server.js owns an HTTP listener. This disposable test process exits after
  // assertions; it never deploys or contacts a live Supabase instance.
  process.exit(0);
}
main().catch(error=>{console.error(error);process.exit(1);});
