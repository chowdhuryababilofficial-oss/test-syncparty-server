const assert = require('assert');
process.env.HIGHLIGHT_SIGNING_SECRET = 'test-only-highlight-secret';
const fake = require('./fake-supabase');
const supabasePath = require.resolve('../supabase');
require.cache[supabasePath] = { id:supabasePath, filename:supabasePath, loaded:true, exports:fake };
for (const name of ['../auth-store','../scrapbook-store']) delete require.cache[require.resolve(name)];
const { signHighlightMessage, verifyHighlightMessage, signHighlightInteraction, verifyHighlightInteraction } = require('../highlight-proof');
const store = require('../scrapbook-store');
function makeMessage(messageId='message-1', authorId='member-a') {
  const mediaSnapshot = { mediaId:'got-s3e9', sourceKey:'got-s3e9', title:'Game of Thrones', platform:'netflix', season:3, episode:9, positionSeconds:2536, durationSeconds:3500, paused:false, artwork:null, sourceUrl:'https://www.netflix.com/title/123' };
  const m = { messageId, authorId, authorAccountId:authorId==='member-a'?'user-a':'user-b', name:authorId==='member-a'?'Alex':'Maya', avatar:'🙂', color:'#8877aa', authorName:authorId==='member-a'?'Alex':'Maya', authorAvatar:'🙂', authorColor:'#8877aa', sentAt:Date.now(), text:'This is getting interesting!', replyTo:null, mediaSnapshot, highlightRoom:'ROOM01', highlightConsent:true, positionSeconds:2536, mediaId:'got-s3e9', reactions:{'😂':1} };
  m.highlightProof=signHighlightMessage(m); return m;
}
function makeInteraction(type='quick-reaction', fields={}) {
  const kind = type === 'quick-reaction' ? 'reaction' : type === 'message-reaction' ? 'messageReaction' :
    type === 'typing-start' || type === 'typing-stop' ? 'typing' : 'highlight-seek';
  const signed = {
    kind, eventId:fields.eventId || `event-${type}-${Math.random().toString(36).slice(2,8)}`,
    highlightRoom:'ROOM01', id:'member-b', actorAccountId:'user-b', name:'Maya', avatar:'🐼',
    sentAt:fields.sentAt || Date.now(), highlightConsent:true,
    emoji:fields.emoji || (type.includes('reaction') ? '😂' : undefined),
    messageId:fields.messageId || (type === 'message-reaction' ? 'message-1' : undefined),
    action:fields.action || (type === 'message-reaction' ? 'add' : undefined),
    typing:type === 'typing-start' ? true : type === 'typing-stop' ? false : undefined,
    fromSeconds:fields.fromSeconds, toSeconds:fields.toSeconds
  };
  return {
    eventId:signed.eventId, type, actorId:signed.id, actorAccountId:signed.actorAccountId,
    actorName:signed.name, actorAvatar:signed.avatar, sentAt:signed.sentAt, positionSeconds:fields.positionSeconds ?? signed.toSeconds ?? 2538,
    segmentIndex:0, highlightConsent:true, highlightRoom:signed.highlightRoom,
    emoji:signed.emoji || null, messageId:signed.messageId || null, action:signed.action || null,
    fromSeconds:signed.fromSeconds ?? null, toSeconds:signed.toSeconds ?? null,
    highlightInteractionProof:signHighlightInteraction(signed)
  };
}
function makeHighlight(requestId='hl_123456789abc') {
  const message=makeMessage(); message.segmentIndex=0;
  const interactionEvents = [
    makeInteraction('quick-reaction',{eventId:'ev-quick',emoji:'🔥',positionSeconds:2537}),
    makeInteraction('message-reaction',{eventId:'ev-message-reaction',messageId:'message-1',emoji:'❤️',positionSeconds:2538}),
    makeInteraction('typing-start',{eventId:'ev-typing-start',positionSeconds:2539}),
    makeInteraction('typing-stop',{eventId:'ev-typing-stop',positionSeconds:2540}),
    makeInteraction('seek',{eventId:'ev-seek',fromSeconds:2539,toSeconds:2546,positionSeconds:2546})
  ];
  return { requestId, title:'The Red Wedding', note:'', createdBy:'member-a', createdByName:'Alex', captureMode:'historical', createdAt:Date.now(), media:{mediaId:'got-s3e9',title:'Game of Thrones',platform:'netflix',season:3,episode:9,sourceUrl:'https://www.netflix.com/title/123'}, segments:[{mediaId:'got-s3e9',startSeconds:2536,endSeconds:2560,startedAt:message.sentAt,endedAt:message.sentAt+24000}], playbackEvents:[{type:'pause',actorName:'Alex',segmentIndex:0,positionSeconds:2540,sentAt:message.sentAt+1000},{type:'resume',actorName:'Maya',segmentIndex:0,positionSeconds:2540,sentAt:message.sentAt+5000}], interactionEvents, messages:[message] };
}
(async()=>{
  fake.reset();
  const signed=makeMessage();
  assert.strictEqual(verifyHighlightMessage(signed),true,'relay signature verifies for the original payload');
  assert.strictEqual(verifyHighlightMessage({...signed,text:'tampered message'}),false,'relay signature rejects tampered message text');
  assert.strictEqual(verifyHighlightMessage({...signed,mediaSnapshot:{...signed.mediaSnapshot,positionSeconds:999}}),false,'relay signature rejects tampered playback position');
  const verifiedInteraction = makeInteraction('quick-reaction',{eventId:'verify-interaction',emoji:'🎉',positionSeconds:2537});
  const interactionProofInput = {kind:'reaction',eventId:verifiedInteraction.eventId,highlightRoom:'ROOM01',id:verifiedInteraction.actorId,actorAccountId:verifiedInteraction.actorAccountId,name:verifiedInteraction.actorName,avatar:verifiedInteraction.actorAvatar,sentAt:verifiedInteraction.sentAt,highlightConsent:true,emoji:verifiedInteraction.emoji};
  assert.strictEqual(verifyHighlightInteraction(interactionProofInput,verifiedInteraction.highlightInteractionProof),true,'relay signature verifies for a consented reaction event');
  assert.strictEqual(verifyHighlightInteraction({...interactionProofInput,emoji:'💀'},verifiedInteraction.highlightInteractionProof),false,'relay signature rejects a tampered reaction event');
  const forged=makeHighlight('hl_forged12345'); forged.messages[0].highlightProof='v1.forged';
  assert.throws(()=>store.normalizeHighlightRecord(forged),/valid relay-issued/,'forged opt-in is rejected');
  const mixedMedia=makeHighlight('hl_mixedmedia123');
  const otherMediaMessage=makeMessage('message-2');
  otherMediaMessage.mediaSnapshot={...otherMediaMessage.mediaSnapshot,mediaId:'different-episode',sourceKey:'different-episode'};
  otherMediaMessage.highlightProof=signHighlightMessage(otherMediaMessage);
  mixedMedia.messages.push(otherMediaMessage);
  assert.throws(()=>store.normalizeHighlightRecord(mixedMedia),/different media identity/,'server rejects signed messages from another title');
  const mixedRoom=makeHighlight('hl_mixedroom123');
  const otherRoomMessage=makeMessage('message-3'); otherRoomMessage.highlightRoom='ROOM02'; otherRoomMessage.highlightProof=signHighlightMessage(otherRoomMessage);
  mixedRoom.messages.push(otherRoomMessage);
  assert.throws(()=>store.normalizeHighlightRecord(mixedRoom),/different rooms/,'server rejects messages from another room');
  const mismatchedPosition=makeHighlight('hl_badposition123'); mismatchedPosition.messages[0].positionSeconds=2600;
  assert.throws(()=>store.normalizeHighlightRecord(mismatchedPosition),/inconsistent playback timestamp/,'server rejects a modified playback timestamp');
  const missingPosition=makeHighlight('hl_missingtime123');
  missingPosition.messages[0].positionSeconds=null;
  missingPosition.messages[0].mediaSnapshot={...missingPosition.messages[0].mediaSnapshot,positionSeconds:null};
  missingPosition.messages[0].highlightProof=signHighlightMessage(missingPosition.messages[0]);
  assert.throws(()=>store.normalizeHighlightRecord(missingPosition),/inconsistent playback timestamp/,'server does not reinterpret missing timestamps as zero');
  const unknownSeason=makeHighlight('hl_unknownseason123'); unknownSeason.media.season=null;
  assert.strictEqual(store.normalizeHighlightRecord(unknownSeason).media.season,null,'unknown season stays unknown');
  const specialSeason=makeHighlight('hl_specialseason123'); specialSeason.media.season=0;
  assert.strictEqual(store.normalizeHighlightRecord(specialSeason).media.season,0,'season zero remains a valid Specials season');
  const input=makeHighlight();
  const first=await store.createHighlight('user-a',input);
  assert.strictEqual(first.duplicate,false);
  assert.strictEqual(first.highlight.data.playbackEvents.length,2,'pause/resume events survive server normalization and persistence');
  assert.strictEqual(first.highlight.data.playbackEvents[0].actorName, 'Alex', 'playback system actor survives server normalization');
  assert.strictEqual(first.highlight.data.createdBy, 'member-a', 'highlight creator identity survives server normalization');
  assert.strictEqual(first.highlight.data.createdByName, 'Alex', 'highlight creator display name survives server normalization');
  assert.strictEqual(first.highlight.data.messages[0].playbackPaused,false,'message pause state is derived from signed media snapshot');
  assert.strictEqual(first.highlight.data.interactionEvents.length,5,'quick reactions, message reactions, typing, and seek events are persisted');
  assert.strictEqual(first.highlight.data.interactionEvents[0].actorAvatar,'🐼','relay-signed actor avatars survive server normalization');
  const badInteraction=makeHighlight('hl_forged_interaction_123');
  badInteraction.interactionEvents[0].emoji='💀';
  assert.throws(()=>store.normalizeHighlightRecord(badInteraction),/relay-issued consent proof/,'server rejects tampered interaction history');
  const retry=await store.createHighlight('user-a',input);
  assert.strictEqual(retry.duplicate,true,'idempotent request returns original record');
  assert.strictEqual((await store.listHighlights('user-a','personal')).length,1);
  assert.strictEqual((await store.listHighlights('user-b','personal')).length,0,'private record is not visible to another account');
  fake.tables.relations.push({id:'rel-a-b',user1_id:'user-a',user2_id:'user-b',created_at:Date.now(),accepted_at:Date.now(),archived_at:null,ended_at:null});
  const shared=await store.shareHighlight('user-a',first.highlight.id);
  assert.strictEqual(shared.ok,true);
  assert.strictEqual(shared.highlight.scope,'shared');
  assert.strictEqual((await store.listHighlights('user-a','personal')).length,1,'sharing preserves the personal copy');
  assert.strictEqual((await store.listHighlights('user-b','shared')).length,1,'active relationship partner can read explicitly shared Highlight');
  const sharedRetry=await store.shareHighlight('user-a',first.highlight.id);
  assert.strictEqual(sharedRetry.duplicate,true,'repeated share does not create a second shared record');
  // Automatic Our Story persistence: a capture created while offline may first
  // arrive as a personal row, then a retry carrying the captured relation ID
  // must repair the missing shared copy without duplicating either row.
  const automaticInput = makeHighlight('hl_auto_story_123456');
  const personalFirst = await store.createHighlight('user-a', automaticInput);
  assert.strictEqual(personalFirst.shared, false, 'without a captured active relation, save remains personal');
  const automaticRetry = await store.createHighlight('user-a', { ...automaticInput, relationId:'rel-a-b' });
  assert.strictEqual(automaticRetry.duplicate, true, 'retry reuses the existing personal highlight');
  assert.strictEqual(automaticRetry.shared, true, 'retry repairs the missing Our Story copy');
  assert.strictEqual(automaticRetry.sharedHighlight.relationId, 'rel-a-b', 'shared copy belongs to the exact captured relation');
  assert.strictEqual((await store.listHighlights('user-b','shared')).length, 2, 'partner sees the automatically shared highlight');
  const automaticAgain = await store.createHighlight('user-a', { ...automaticInput, relationId:'rel-a-b' });
  assert.strictEqual(automaticAgain.shared, true, 'repeat save confirms the same shared copy');
  assert.strictEqual((await store.listHighlights('user-b','shared')).length, 2, 'automatic sharing is idempotent');
  const wrongRelation = await store.createHighlight('user-a', { ...makeHighlight('hl_wrong_relation_123'), relationId:'rel-not-owned' });
  assert.strictEqual(wrongRelation.shared, false, 'unowned or inactive relation ID cannot create a shared copy');
  const deleted=await store.removeHighlight('user-a',shared.highlight.id);
  assert.strictEqual(deleted.removed,true);
  assert.strictEqual((await store.listHighlights('user-b','shared')).length,1,'deleting the explicit shared copy leaves the independent automatic Our Story copy intact');
  const automaticSharedRow = (await store.listHighlights('user-a','shared')).find(row => row.data?.sharedFromRequestId === automaticInput.requestId);
  assert(automaticSharedRow, 'automatic Our Story copy remains independently addressable');
  await store.removeHighlight('user-a', automaticSharedRow.id);
  assert.strictEqual((await store.listHighlights('user-b','shared')).length,0,'deleting both shared copies removes them from the partner listing');
  const afterDeleteRetry = await store.createHighlight('user-a', { ...automaticInput, relationId:'rel-a-b' });
  assert.strictEqual(afterDeleteRetry.shared, false, 'a deleted shared copy is not silently resurrected by a duplicate capture retry');
  assert.strictEqual((await store.listHighlights('user-b','shared')).length,0, 'deleted Our Story highlight remains deleted after retry');
  assert.strictEqual((await store.listHighlights('user-a','personal')).length,3,'deleting shared copies does not delete any personal Highlights');

  // A user may manually share from Scrapbook before the next capture retry.
  // The automatic capture path must converge on that exact relation-scoped
  // request ID rather than create a second Our Story copy.
  const convergeInput = makeHighlight('hl_manual_auto_converge_123');
  const convergePersonal = await store.createHighlight('user-a', convergeInput);
  const manualCopy = await store.shareHighlight('user-a', convergePersonal.highlight.id);
  const autoRetryAfterManual = await store.createHighlight('user-a', { ...convergeInput, relationId:'rel-a-b' });
  assert.strictEqual(autoRetryAfterManual.shared, true, 'automatic retry recognizes an already manually shared copy');
  assert.strictEqual(autoRetryAfterManual.sharedHighlight.id, manualCopy.highlight.id, 'manual and automatic sharing converge on the same shared record');

  // Older records may contain a streaming-site logo or no usable artwork.
  // Verify that a later list request repairs the existing JSON record through
  // the server's real TMDB metadata resolver, without changing ownership.
  const previousToken = process.env.TMDB_API_TOKEN;
  const previousFetch = global.fetch;
  try {
    delete process.env.TMDB_API_TOKEN;
    const legacyArtwork = makeHighlight('hl_artwork_recovery_123');
    legacyArtwork.media.artwork = 'https://reanime.cz/assets/provider-logo.png';
    legacyArtwork.media.backdrop = 'https://7movies.ac/images/site-logo.png';
    const legacySaved = await store.createHighlight('user-a', legacyArtwork);
    assert.strictEqual(legacySaved.highlight.data.media.artwork, null, 'streaming-site logos are not saved as movie artwork');
    assert.strictEqual(legacySaved.highlight.data.media.backdrop, null, 'streaming-site logos are not saved as backdrops');

    process.env.TMDB_API_TOKEN = 'test-tmdb-token';
    global.fetch = async url => {
      const parsed = new URL(String(url));
      let payload = {};
      if (parsed.pathname === '/3/search/tv') {
        payload = { results:[{ id:1399, name:'Game of Thrones', original_name:'Game of Thrones', first_air_date:'2011-04-17', poster_path:'/got-poster.jpg', backdrop_path:'/got-backdrop.jpg' }] };
      } else if (parsed.pathname === '/3/search/movie') {
        payload = { results:[] };
      } else if (parsed.pathname === '/3/tv/1399') {
        payload = { id:1399, name:'Game of Thrones', first_air_date:'2011-04-17', number_of_seasons:3,
          poster_path:'/got-poster.jpg', backdrop_path:'/got-backdrop.jpg',
          seasons:[{season_number:1,episode_count:10},{season_number:2,episode_count:10},{season_number:3,episode_count:10}] };
      } else if (parsed.pathname === '/3/tv/1399/season/3/episode/9') {
        payload = { id:887, name:'The Rains of Castamere', runtime:55 };
      }
      return { ok:true, status:200, json:async()=>payload };
    };
    const refreshed = await store.listHighlights('user-a','personal');
    const repaired = refreshed.find(row => row.requestId === legacyArtwork.requestId);
    assert(repaired, 'legacy Highlight remains visible after artwork repair');
    assert.strictEqual(repaired.data.media.metadataProvider, 'tmdb');
    assert.strictEqual(repaired.data.media.metadataId, '1399');
    assert.strictEqual(repaired.data.media.artwork, 'https://image.tmdb.org/t/p/w780/got-poster.jpg', 'legacy Highlight receives the canonical TMDB poster');
    assert.strictEqual(repaired.data.media.backdrop, 'https://image.tmdb.org/t/p/w1280/got-backdrop.jpg', 'legacy Highlight receives the canonical TMDB backdrop');
    const persistedArtwork = fake.tables.scrapbook_highlights.find(row => row.request_id === legacyArtwork.requestId);
    assert.strictEqual(persistedArtwork.data.media.artwork, repaired.data.media.artwork, 'resolved artwork is persisted to the existing Highlight row');
  } finally {
    global.fetch = previousFetch;
    if (previousToken == null) delete process.env.TMDB_API_TOKEN;
    else process.env.TMDB_API_TOKEN = previousToken;
  }
  console.log('Highlights store tests: PASS (forged message/event consent, interaction signatures, quick/message reactions, typing, seek history, idempotency, private ownership, explicit and automatic Our Story sharing, retry repair, deletion, TMDB artwork recovery)');
})().catch(error=>{console.error(error);process.exitCode=1;});
