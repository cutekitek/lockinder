import { afterAll as after, afterEach, beforeEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { backupDatabase, connection, db, openDatabase } from '../src/lib/db';
import { assets, authStates, discord, jobs, likes, limits, profiles, ranks, sessions, users } from '../src/lib/schema';
import { act, blockUser, disconnectDiscord, discovery, getMe, profileDetail, receivedLikes, saveFilters, saveProfile } from '../src/lib/service';
import { authenticate, consumeState, csrf, hash, id, newSession, newState, rateLimit, RateLimitError } from '../src/lib/security';
import { catalog, refreshRank, sendDM, steamAccountId, verifySteam } from '../src/lib/providers';
import { orderPlayers, rankPosition, type Player } from '../src/lib/model';
import { processJob } from '../src/lib/worker';
import { GET, POST } from '../src/app/api/[...path]/route';
import enCatalog from '../src/data/catalog-en.json';

const directory = mkdtempSync(join(tmpdir(), 'lockinder-'));
process.env.DATABASE_PATH = join(directory, 'test.db');
process.env.APP_URL = 'http://localhost:3000';
process.env.DISCORD_BOT_TOKEN = 'test-only';
process.env.DISCORD_GUILD_ID = '123456789012345678';
const originalFetch = global.fetch;
let sequence = 0;
function fixture(options: { language?: string; tier?: number | null; division?: number | null; ready?: boolean; paused?: boolean; complete?: boolean } = {}) {
  const userId = id(); const n = ++sequence;
  db().insert(users).values({ id: userId, steamId: (76561197960265728n + BigInt(n)).toString(), createdAt: Date.now(), paused: options.paused || false }).run();
  db().insert(profiles).values({ userId, name: `Player ${n}`, country: 'US', languages: [options.language || 'en'], roles: ['Support'], heroes: [1], complete: options.complete ?? true }).run();
  db().insert(discord).values({ userId, discordId: `12345678901234${String(n).padStart(4, '0')}`, username: `test${n}`, ready: options.ready ?? true }).run();
  db().insert(ranks).values({ userId, tier: options.tier === undefined ? 5 : options.tier, division: options.division === undefined ? 3 : options.division, fetchedAt: Date.now(), attemptedAt: Date.now() - 600_000 }).run();
  return userId;
}
function request(path: string, session: string, value: unknown = {}) {
  return new Request(`http://localhost:3000/api/${path}`, { method: 'POST', headers: { origin: 'http://localhost:3000', cookie: `session=${session}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
}
const context = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });
function mockDiscord(status = 200) {
  const sent: { content: string; nonce: string; allowed_mentions: unknown }[] = [];
  global.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/members/')) return Response.json(status === 404 ? { message: 'missing' } : { user: {} }, { status: status === 404 ? 404 : 200 });
    if (url.endsWith('/users/@me/channels')) return Response.json({ id: '123456789012345678' });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json(status === 200 ? { id: '234567890123456789' } : { retry_after: 2 }, { status });
  }) as unknown as typeof fetch;
  return sent;
}
beforeEach(() => {
  connection().sqlite.exec('DELETE FROM users; DELETE FROM nonces; DELETE FROM rate_limits; DELETE FROM asset_cache; DELETE FROM auth_states;');
  global.fetch = (async () => { throw new Error('Unexpected network request in test'); }) as unknown as typeof fetch;
  db().insert(assets).values({ key: 'en', json: JSON.stringify({ ...enCatalog, stale: false }), fetchedAt: Date.now() }).run();
});
afterEach(() => { global.fetch = originalFetch; });
after(() => { connection().sqlite.close(true); rmSync(directory, { recursive: true, force: true }); });

test('Bun SQLite backups include committed WAL data and refuse overwrite', () => {
  const user = fixture();
  const path = join(directory, 'snapshot.db');
  backupDatabase(path);
  const snapshot = openDatabase(path);
  try {
    assert.ok(snapshot.sqlite.query('SELECT id FROM users WHERE id = ?').get(user));
    assert.deepEqual(snapshot.sqlite.query('PRAGMA integrity_check').get(), { integrity_check: 'ok' });
    assert.throws(() => backupDatabase(path), /must not exist/);
  } finally { snapshot.sqlite.close(true); }
});

test('rank positions are consecutive across tier boundaries', () => {
  assert.equal(rankPosition(5, 6)! + 1, rankPosition(6, 1));
  assert.equal(rankPosition(0, 0), null);
  assert.equal(rankPosition(null, null), null);
});
test('SteamID64 conversion preserves precision across the complete account range', () => {
  assert.equal(steamAccountId('76561197960265729'), 1);
  assert.equal(steamAccountId('76561202255233023'), 4294967295);
  assert.throws(() => steamAccountId('76561202255233024'));
  assert.throws(() => steamAccountId('invalid'));
});
test('language has priority over rank distance and unknown rank', () => {
  const viewer = fixture({ tier: 5, division: 6 });
  const near = fixture({ tier: 6, division: 1 });
  const far = fixture({ tier: 1, division: 1 });
  const foreign = fixture({ language: 'ru', tier: 5, division: 6 });
  const unknown = fixture({ tier: null, division: null });
  assert.deepEqual(discovery(viewer).players.map(p => p.id), [near, far, unknown, foreign]);
});
test('rank range is inclusive, removes unknowns, and role filter uses any selected role', () => {
  const viewer = fixture(); const edge = fixture({ tier: 6, division: 1 }); fixture({ tier: null }); fixture({ tier: 1 });
  saveFilters(viewer, { minRank: 30, maxRank: 30, roles: ['Carry', 'Support'] });
  assert.deepEqual(discovery(viewer).players.map(p => p.id), [edge]);
  saveFilters(viewer, { minRank: null, maxRank: null, roles: ['Carry'] });
  assert.equal(discovery(viewer).players.length, 0);
  assert.throws(() => saveFilters(viewer, { minRank: 40, maxRank: 10, roles: [] }));
});
test('unranked viewer uses deterministic ID ties, after separating unknown ranks', () => {
  const viewer = getMe(fixture({ tier: 0, division: 0 }));
  const base = { ...viewer } as Player;
  const players = [{ ...base, id: 'b', tier: 12, division: 6 }, { ...base, id: 'a', tier: 1, division: 1 }, { ...base, id: '0', tier: null, division: null }];
  assert.deepEqual(orderPlayers(viewer, players, { minRank: null, maxRank: null, roles: [] }).map(p => p.id), ['a', 'b', '0']);
});
test('discovery excludes self, incomplete, paused, passed, liked and blocks in either direction', () => {
  const viewer = fixture(); fixture({ complete: false }); fixture({ paused: true });
  const passed = fixture(); act(viewer, passed, 'pass');
  const liked = fixture(); act(viewer, liked, 'like');
  const blocked = fixture(); blockUser(viewer, blocked);
  const blockedBy = fixture(); blockUser(blockedBy, viewer);
  const visible = fixture();
  assert.deepEqual(discovery(viewer).players.map(p => p.id), [visible]);
});
test('passed-player reset restores only passes, not likes', async () => {
  const viewer = fixture(); const passed = fixture(); const liked = fixture();
  act(viewer, passed, 'pass'); act(viewer, liked, 'like');
  const response = await POST(request('passes/reset', newSession(viewer)), context('passes/reset'));
  assert.equal(response.status, 200);
  assert.deepEqual(discovery(viewer).players.map(p => p.id), [passed]);
});
test('overlapping like requests create exactly one like and one notification job', async () => {
  const viewer = fixture(); const target = fixture(); const session = newSession(viewer);
  const responses = await Promise.all(Array.from({ length: 8 }, () => POST(request('like', session, { target }), context('like'))));
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(db().select().from(likes).all().length, 1);
  assert.equal(db().select().from(jobs).all().length, 1);
});
test('database unique constraint rejects independent duplicate inserts', () => {
  const senderId = fixture(), recipientId = fixture(); act(senderId, recipientId, 'like');
  const second = openDatabase(process.env.DATABASE_PATH);
  assert.throws(() => second.sqlite.prepare('INSERT INTO likes VALUES (?, ?, ?, ?)').run(id(), senderId, recipientId, Date.now()));
  second.sqlite.close();
});
test('like and outbox insertion roll back together', () => {
  const sender = fixture(), recipient = fixture();
  connection().sqlite.exec("CREATE TRIGGER reject_job BEFORE INSERT ON notification_jobs BEGIN SELECT RAISE(ABORT, 'test'); END;");
  try { assert.throws(() => act(sender, recipient, 'like')); assert.equal(db().select().from(likes).all().length, 0); }
  finally { connection().sqlite.exec('DROP TRIGGER reject_job'); }
});
test('onboarding gates discovery and likes, without requiring a rank', () => {
  const unready = fixture({ complete: false }), target = fixture();
  assert.throws(() => discovery(unready)); assert.throws(() => act(unready, target, 'like'));
  const unranked = fixture({ tier: 0, division: 0 }); assert.doesNotThrow(() => act(unranked, target, 'like'));
});
test('public statistics count registrations and each reciprocal pair once', async () => {
  const stats = async () => (await GET(new Request('http://localhost:3000/api/stats'), context('stats'))).json();
  assert.deepEqual(await stats(), { registeredPlayers: 0, teammateConnections: 0 });
  const a = fixture(), b = fixture(), c = fixture({ complete: false });
  assert.ok(c);
  act(a, b, 'like');
  assert.deepEqual(await stats(), { registeredPlayers: 3, teammateConnections: 0 });
  act(b, a, 'like'); act(b, a, 'like');
  assert.deepEqual(await stats(), { registeredPlayers: 3, teammateConnections: 1 });
});

test('players without Discord can discover, like and use Steam contacts without queued DMs', () => {
  const sender = fixture(), recipient = fixture();
  db().delete(discord).run();
  assert.equal(getMe(sender).ready, true);
  assert.deepEqual(discovery(sender).players.map(p => p.id), [recipient]);
  assert.doesNotThrow(() => profileDetail(sender, recipient));
  act(sender, recipient, 'like');
  assert.equal(receivedLikes(recipient).length, 1);
  assert.equal(db().select().from(jobs).get()?.status, 'cancelled');
  assert.ok(profileDetail(recipient, sender).steamUrl);
  assert.equal(profileDetail(recipient, sender).discordId, undefined);
});

test('contact details are exposed only after an incoming like; blocks revoke access', () => {
  const sender = fixture(), recipient = fixture();
  assert.equal(profileDetail(recipient, sender).steamUrl, null);
  act(sender, recipient, 'like');
  assert.ok(profileDetail(recipient, sender).discordId);
  assert.equal(receivedLikes(recipient).length, 1);
  blockUser(sender, recipient);
  assert.throws(() => profileDetail(recipient, sender)); assert.equal(receivedLikes(recipient).length, 0);
  assert.equal(db().select().from(jobs).get()?.status, 'cancelled');
});
test('disconnect and opt-out cancel notifications while preserving likes', async () => {
  const sender = fixture(), recipient = fixture(); act(sender, recipient, 'like');
  const response = await POST(request('settings', newSession(recipient), { notifications: false }), context('settings'));
  assert.equal(response.status, 200); assert.equal(db().select().from(jobs).get()?.status, 'cancelled');
  disconnectDiscord(recipient);
  assert.equal(getMe(recipient).ready, true); assert.equal(getMe(recipient).paused, false);
  assert.equal(receivedLikes(recipient).length, 1);
});
test('session tokens are hashed; expiry and invalid cookies reject authentication', () => {
  const user = fixture(), session = newSession(user);
  assert.equal(authenticate(request('me', session)).id, user);
  assert.equal(db().select().from(sessions).get()?.hash, hash(session));
  db().update(sessions).set({ expiresAt: Date.now() - 1 }).run();
  assert.throws(() => authenticate(request('me', session)));
  assert.throws(() => authenticate(request('me', 'forged')));
});
test('CSRF rejects foreign and absent origins', () => {
  assert.throws(() => csrf(new Request('http://localhost:3000/api/like', { method: 'POST' })));
  assert.throws(() => csrf(new Request('http://localhost:3000/api/like', { method: 'POST', headers: { origin: 'https://evil.example' } })));
  assert.doesNotThrow(() => csrf(request('like', 'x')));
});
test('OAuth states are browser-bound, user-bound, expiring and one-use', () => {
  const a = fixture(), b = fixture();
  const mismatch = newState('discord', a); assert.throws(() => consumeState(mismatch, mismatch, 'discord', b));
  const state = newState('discord', a); assert.throws(() => consumeState(state, 'forged', 'discord', a));
  consumeState(state, state, 'discord', a); assert.throws(() => consumeState(state, state, 'discord', a));
  const expired = newState('steam'); db().update(authStates).set({ expiresAt: Date.now() - 1 }).run();
  assert.throws(() => consumeState(expired, expired, 'steam'));
});
function steamCallback() {
  const url = new URL('http://localhost:3000/api/auth/steam/callback?state=test');
  const values = { ns: 'http://specs.openid.net/auth/2.0', mode: 'id_res', op_endpoint: 'https://steamcommunity.com/openid/login', claimed_id: 'https://steamcommunity.com/openid/id/76561197960265729', identity: 'https://steamcommunity.com/openid/id/76561197960265729', return_to: 'http://localhost:3000/api/auth/steam/callback?state=test', response_nonce: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') + id(), assoc_handle: 'test', signed: 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', sig: 'test' };
  Object.entries(values).forEach(([k, v]) => url.searchParams.set(`openid.${k}`, v)); return url;
}
test('Steam assertion must pass provider verification and cannot be replayed', async () => {
  const callback = steamCallback();
  global.fetch = (async () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n')) as unknown as typeof fetch;
  assert.equal(await verifySteam(callback, 'test'), '76561197960265729');
  await assert.rejects(() => verifySteam(callback, 'test'));
});
test('Steam rejects forged signatures, endpoints, duplicate fields, return URLs and stale nonces', async () => {
  global.fetch = (async () => new Response('is_valid:false\n')) as unknown as typeof fetch;
  await assert.rejects(() => verifySteam(steamCallback(), 'test'));
  for (const [field, value] of [['op_endpoint', 'https://evil.example'], ['return_to', 'https://evil.example'], ['response_nonce', '2000-01-01T00:00:00Zbad'], ['signed', 'identity']]) {
    const callback = steamCallback(); callback.searchParams.set(`openid.${field}`, value);
    await assert.rejects(() => verifySteam(callback, 'test'));
  }
  const duplicate = steamCallback(); duplicate.searchParams.append('openid.identity', 'evil');
  await assert.rejects(() => verifySteam(duplicate, 'test'));
});
test('Discord callback cannot link an account already owned by someone else', async () => {
  const a = fixture(), b = fixture();
  const existing = db().select().from(discord).where(eq(discord.userId, a)).get()!;
  const state = newState('discord', b);
  process.env.DISCORD_CLIENT_ID = 'test'; process.env.DISCORD_CLIENT_SECRET = 'test';
  global.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/oauth2/token') ? Response.json({ access_token: 'test' }) : Response.json({ id: existing.discordId, username: 'test' })) as unknown as typeof fetch;
  const response = await GET(new Request(`http://localhost:3000/api/auth/discord/callback?state=${state}&code=test`, { headers: { cookie: `session=${newSession(b)}; discord_state=${state}` } }), context('auth/discord/callback'));
  assert.match(response.headers.get('location')!, /discordInUse/);
  assert.equal(db().select().from(discord).where(eq(discord.userId, a)).get()?.discordId, existing.discordId);
});
test('profile updates cannot override owner, rank or unexpected fields', async () => {
  const a = fixture(), b = fixture(); const session = newSession(a);
  const value = { name: 'New name', country: 'US', languages: ['en'], roles: ['Flex'], heroes: [1], bio: 'Hello' };
  const rejected = await POST(request('profile', session, { ...value, userId: b, tier: 12 }), context('profile'));
  assert.equal(rejected.status, 400);
  const accepted = await POST(request('profile', session, value), context('profile'));
  assert.equal(accepted.status, 200); assert.equal(getMe(a).name, 'New name'); assert.notEqual(getMe(b).name, 'New name');
  await assert.rejects(() => saveProfile(a, { ...value, heroes: [9999999] }));
});
test('profiles accept an empty or omitted country while rejecting invalid country codes', async () => {
  const user = fixture({ complete: false });
  const session = newSession(user);
  const value = { name: 'New teammate', languages: ['en'], roles: ['Flex'], heroes: [1], bio: '' };
  for (const input of [{ ...value, country: '' }, { ...value, country: 'US' }, value]) {
    const response = await POST(request('profile', session, input), context('profile'));
    assert.equal(response.status, 200);
    assert.equal(getMe(user).country, 'country' in input ? input.country : '');
    assert.equal(getMe(user).ready, true);
  }
  for (const country of ['ZZ', 'us', 'USA']) {
    const response = await POST(request('profile', session, { ...value, country }), context('profile'));
    assert.equal(response.status, 400);
    assert.equal(getMe(user).country, '');
  }
});
test('rank outage preserves previous value and records a retry cooldown', async () => {
  const user = fixture(); db().update(ranks).set({ fetchedAt: Date.now() - 7200_000 }).run();
  global.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  await refreshRank(user); const me = getMe(user);
  assert.equal(me.tier, 5); assert.equal(me.rankError, 'rankUnavailable');
  await assert.rejects(() => refreshRank(user, true));
});
test('fresh rank skips network; successful unranked result clears stale known rank', async () => {
  const user = fixture(); await refreshRank(user); // the default mock throws if called
  global.fetch = (async () => Response.json({ rank: 0, subrank: 0, badge: 0 })) as unknown as typeof fetch;
  await refreshRank(user, true); assert.equal(getMe(user).tier, 0); assert.equal(getMe(user).rankError, null);
});
test('catalog outage falls back to bundled game assets', async () => {
  db().delete(assets).run(); const result = await catalog('ru');
  assert.equal(result.stale, true); assert.ok(result.heroes.length > 10); assert.ok(result.ranks.length > 10);
});
test('rate limits survive independent database connections and reset windows', () => {
  rateLimit('test', 1, 10_000); assert.throws(() => rateLimit('test', 1, 10_000));
  const other = openDatabase(process.env.DATABASE_PATH);
  assert.equal((other.sqlite.prepare('SELECT count FROM rate_limits WHERE key = ?').get('test') as { count: number }).count, 1);
  other.sqlite.close();
});
test('Discord onboarding test checks membership and DM permission before becoming ready', async () => {
  const user = fixture({ ready: false }); const session = newSession(user);
  mockDiscord(403);
  assert.equal((await POST(request('discord/test', session), context('discord/test'))).status, 503);
  assert.equal(getMe(user).discord?.ready, false); assert.equal(getMe(user).ready, true);
  mockDiscord();
  assert.equal((await POST(request('discord/test', session), context('discord/test'))).status, 200);
  assert.equal(getMe(user).ready, true);
});
test('Discord quota persists, limits concurrent sends per user and resets after one minute', async () => {
  const user = fixture(), another = fixture();
  const sent = mockDiscord();
  const before = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => sendDM(user, '123456789012345678', 'test')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof RateLimitError);
  assert.ok(rejected.reason.retryAfter > 0 && rejected.reason.retryAfter <= 60_000);
  assert.equal(sent.length, 2);
  const other = openDatabase(process.env.DATABASE_PATH);
  try {
    const row = other.sqlite.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').get(`discordMessage:${user}`) as { count: number; reset_at: number };
    assert.equal(row.count, 2);
    assert.ok(row.reset_at >= before + 60_000 && row.reset_at <= Date.now() + 60_000);
  } finally { other.sqlite.close(); }
  await sendDM(another, '123456789012345678', 'different user');
  db().update(limits).set({ resetAt: Date.now() - 1 }).where(eq(limits.key, `discordMessage:${user}`)).run();
  await sendDM(user, '123456789012345678', 'new window');
  assert.equal(sent.length, 4);
});
test('complaints, tests and queued notifications share a user quota without breaking Discord', async () => {
  const previousAdmin = process.env.DISCORD_ADMIN_USER_ID;
  process.env.DISCORD_ADMIN_USER_ID = '987654321098765432';
  try {
    const user = fixture(), sender = fixture(), otherRecipient = fixture();
    const session = newSession(user), secondSession = newSession(user);
    const sent = mockDiscord();
    assert.equal((await POST(request('complaint', session, { text: 'test' }), context('complaint'))).status, 200);
    assert.equal((await POST(request('discord/test', secondSession), context('discord/test'))).status, 200);
    for (const path of ['complaint', 'discord/test']) {
      const response = await POST(request(path, session, { text: 'test' }), context(path));
      assert.equal(response.status, 429);
      assert.equal((await response.json()).error, 'rateLimited');
      assert.ok(Number(response.headers.get('Retry-After')) > 0 && Number(response.headers.get('Retry-After')) <= 60);
    }
    assert.equal(sent.length, 2);
    act(sender, user, 'like');
    const queued = db().select().from(jobs).get()!;
    // Even a job on its last retry must survive quota exhaustion.
    db().update(jobs).set({ attempts: 4 }).where(eq(jobs.id, queued.id)).run();
    const before = Date.now();
    assert.equal(await processJob(), true);
    const deferred = db().select().from(jobs).where(eq(jobs.id, queued.id)).get()!;
    assert.equal(deferred.status, 'pending');
    assert.equal(deferred.attempts, 4);
    assert.ok(deferred.availableAt > before);
    assert.equal(deferred.leaseToken, null);
    assert.equal(getMe(user).discord?.ready, true);
    assert.equal(getMe(user).discord?.error, null);
    assert.equal(receivedLikes(user).length, 1);
    assert.equal(sent.length, 2);
    act(sender, otherRecipient, 'like');
    assert.equal(await processJob(), true);
    assert.equal(sent.length, 3);
    assert.equal(await processJob(), false);
    db().update(limits).set({ resetAt: Date.now() - 1 }).where(eq(limits.key, `discordMessage:${user}`)).run();
    db().update(jobs).set({ availableAt: Date.now() - 1 }).where(eq(jobs.id, queued.id)).run();
    await processJob();
    assert.equal(db().select().from(jobs).where(eq(jobs.id, queued.id)).get()?.status, 'sent');
    assert.equal(sent.length, 4);
    assert.equal(sent[3].nonce, queued.likeId);
  } finally {
    if (previousAdmin === undefined) delete process.env.DISCORD_ADMIN_USER_ID;
    else process.env.DISCORD_ADMIN_USER_ID = previousAdmin;
  }
});
test('missing server membership fails the requested Discord test', async () => {
  const user = fixture({ ready: false }); mockDiscord(404);
  await POST(request('discord/test', newSession(user)), context('discord/test'));
  assert.equal(getMe(user).discord?.error, 'joinServer'); assert.equal(getMe(user).discord?.ready, false); assert.equal(getMe(user).ready, true);
});
test('worker delivers localized like message with stable nonce and no mentions', async () => {
  const sender = fixture(), recipient = fixture(); db().update(users).set({ locale: 'ru' }).where(eq(users.id, recipient)).run();
  act(sender, recipient, 'like'); const sent = mockDiscord(); await processJob();
  const job = db().select().from(jobs).get()!;
  assert.equal(job.status, 'sent'); assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Вы понравились/); assert.match(sent[0].content, new RegExp(`/players/${sender}`));
  assert.equal(sent[0].nonce, job.likeId); assert.deepEqual(sent[0].allowed_mentions, { parse: [] });
  assert.equal(await processJob(), false);
});
test('Discord 403 preserves like, fails job and requests connection repair', async () => {
  const sender = fixture(), recipient = fixture(); act(sender, recipient, 'like'); mockDiscord(403); await processJob();
  assert.equal(db().select().from(jobs).get()?.status, 'failed'); assert.equal(receivedLikes(recipient).length, 1);
  assert.equal(getMe(recipient).discord?.error, 'dmBlocked'); assert.equal(getMe(recipient).ready, true);
});
test('Discord 429 honors Retry-After and persists retry for worker restart', async () => {
  const sender = fixture(), recipient = fixture(); act(sender, recipient, 'like'); mockDiscord(429);
  const before = Date.now(); assert.deepEqual(await processJob(), { wait: 2000 });
  const job = db().select().from(jobs).get()!; assert.equal(job.status, 'pending'); assert.ok(job.availableAt >= before + 2000);
  assert.equal(await processJob(), false);
});
test('worker reclaims expired leases but leaves active leases alone', async () => {
  const sender = fixture(), recipient = fixture(); act(sender, recipient, 'like');
  db().update(jobs).set({ status: 'processing', leaseUntil: Date.now() + 120_000, leaseToken: id() }).run();
  assert.equal(await processJob(), false);
  db().update(jobs).set({ leaseUntil: Date.now() - 1 }).run(); mockDiscord(); await processJob();
  assert.equal(db().select().from(jobs).get()?.status, 'sent');
});
test('transient failures use bounded retries and preserve received likes on exhaustion', async () => {
  const sender = fixture(), recipient = fixture(); act(sender, recipient, 'like'); mockDiscord(503);
  for (let i = 0; i < 5; i++) {
    db().update(limits).set({ resetAt: Date.now() - 1 }).where(eq(limits.key, `discordMessage:${recipient}`)).run();
    db().update(jobs).set({ availableAt: Date.now() - 1 }).run(); await processJob();
  }
  assert.equal(db().select().from(jobs).get()?.status, 'failed'); assert.equal(db().select().from(jobs).get()?.attempts, 5);
  assert.equal(receivedLikes(recipient).length, 1);
});
test('SQLite data and applied migration history survive reopen', () => {
  const user = fixture(); const another = openDatabase(process.env.DATABASE_PATH);
  assert.ok(another.sqlite.prepare('SELECT id FROM users WHERE id = ?').get(user));
  assert.equal((another.sqlite.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number }).n, 1);
  assert.deepEqual(another.sqlite.query('PRAGMA journal_mode').get(), { journal_mode: 'wal' }); another.sqlite.close(true);
});

test('complete controlled flow: Steam callback, profile, Discord callback/test, discovery, like and delivery', async () => {
  const recipient = fixture();
  const state = newState('steam');
  const callback = steamCallback();
  callback.searchParams.set('state', state);
  callback.searchParams.set('openid.return_to', `http://localhost:3000/api/auth/steam/callback?state=${state}`);
  // Use an account not already present in this isolated test database.
  callback.searchParams.set('openid.claimed_id', 'https://steamcommunity.com/openid/id/76561197970265728');
  callback.searchParams.set('openid.identity', 'https://steamcommunity.com/openid/id/76561197970265728');
  process.env.DISCORD_CLIENT_ID = 'test'; process.env.DISCORD_CLIENT_SECRET = 'test';
  global.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).includes('steamcommunity.com') ? new Response('is_valid:true\n') : Response.json({ rank: 5, subrank: 3, badge: 53 })) as unknown as typeof fetch;
  const login = await GET(new Request(callback, { headers: { cookie: `steam_state=${state}` } }), context('auth/steam/callback'));
  const session = /session=([a-f0-9]{64})/.exec(login.headers.get('set-cookie') || '')?.[1];
  assert.ok(session);
  const userId = authenticate(request('me', session)).id;
  assert.equal(getMe(userId).ready, false);
  const saved = await POST(request('profile', session, { name: 'New teammate', country: 'US', languages: ['en'], roles: ['Support'], heroes: [1], bio: 'Hello!' }), context('profile'));
  assert.equal(saved.status, 200);
  const authStart = await GET(new Request('http://localhost:3000/api/auth/discord', { headers: { cookie: `session=${session}` } }), context('auth/discord'));
  const discordState = new URL(authStart.headers.get('location')!).searchParams.get('state')!;
  global.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('/oauth2/token') ? Response.json({ access_token: 'test' }) : Response.json({ id: '999999999999999999', username: 'new_teammate' })) as unknown as typeof fetch;
  const linked = await GET(new Request(`http://localhost:3000/api/auth/discord/callback?state=${discordState}&code=test`, { headers: { cookie: `session=${session}; discord_state=${discordState}` } }), context('auth/discord/callback'));
  assert.equal(linked.headers.get('location'), 'http://localhost:3000/settings');
  const sent = mockDiscord();
  assert.equal((await POST(request('discord/test', session), context('discord/test'))).status, 200);
  assert.equal(getMe(userId).ready, true);
  assert.deepEqual(discovery(userId).players.map(p => p.id), [recipient]);
  assert.equal((await POST(request('like', session, { target: recipient }), context('like'))).status, 200);
  await processJob();
  assert.equal(sent.length, 2); // requested onboarding test, then the like notification
  assert.equal(db().select().from(jobs).get()?.status, 'sent');
  assert.equal(receivedLikes(recipient)[0]?.id, userId);
  assert.equal(profileDetail(recipient, userId).discordUsername, 'new_teammate');
});

test('complaints validate input, deliver to the configured administrator and limit requests', async () => {
  const previous = process.env.DISCORD_ADMIN_USER_ID;
  process.env.DISCORD_ADMIN_USER_ID = '987654321098765432';
  try {
    const user = fixture({ complete: false });
    const session = newSession(user);
    const deliveries: { url: string; body: Record<string, unknown> }[] = [];
    global.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      deliveries.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ id: '123456789012345678' });
    }) as typeof fetch;
    assert.equal((await POST(request('complaint', '', { text: 'test' }), context('complaint'))).status, 401);
    for (const text of ['   ', 'x'.repeat(1501)]) {
      assert.equal((await POST(request('complaint', session, { text }), context('complaint'))).status, 400);
    }
    assert.equal(deliveries.length, 0);
    for (let n = 0; n < 2; n++) assert.equal((await POST(request('complaint', session, { text: '  Bug @everyone  ' }), context('complaint'))).status, 200);
    assert.equal(deliveries[0].body.recipient_id, '987654321098765432');
    assert.match(String(deliveries[1].body.content), /Steam: https:\/\/steamcommunity.com\/profiles\/\d+\n\nBug @everyone$/);
    assert.deepEqual(deliveries[1].body.allowed_mentions, { parse: [] });
    assert.equal((await POST(request('complaint', session, { text: 'test' }), context('complaint'))).status, 429);
    assert.equal(deliveries.length, 4);
    delete process.env.DISCORD_ADMIN_USER_ID;
    assert.equal((await POST(request('complaint', session, { text: 'test' }), context('complaint'))).status, 503);
    process.env.DISCORD_ADMIN_USER_ID = '987654321098765432';
    const anotherSession = newSession(fixture());
    mockDiscord(403);
    const failed = await POST(request('complaint', anotherSession, { text: 'test' }), context('complaint'));
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'complaintUnavailable');
  } finally {
    if (previous === undefined) delete process.env.DISCORD_ADMIN_USER_ID;
    else process.env.DISCORD_ADMIN_USER_ID = previous;
  }
});

test('API error logs correlate Discord failures without exposing message text or credentials', async () => {
  const previousAdmin = process.env.DISCORD_ADMIN_USER_ID;
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => { logs.push(args.join(' ')); };
  process.env.DISCORD_ADMIN_USER_ID = '987654321098765432';
  try {
    const session = newSession(fixture());
    mockDiscord(403);
    const response = await POST(request('complaint', session, { text: 'PRIVATE-COMPLAINT-CONTENT' }), context('complaint'));
    assert.equal(response.status, 503);
    const entries = logs.map(line => JSON.parse(line));
    const requestId = response.headers.get('X-Request-ID');
    assert.ok(requestId);
    assert.ok(entries.some(entry => entry.event === 'complaint.delivery_failed' && entry.error.code === 'dmBlocked'));
    assert.ok(entries.some(entry => entry.event === 'provider.http_error' && entry.status === 403));
    assert.ok(entries.some(entry => entry.event === 'api.request_failed' && entry.status === 503));
    assert.ok(entries.every(entry => entry.requestId === requestId && entry.route === '/api/complaint' && entry.method === 'POST'));
    assert.ok(!logs.join('').includes('PRIVATE-COMPLAINT-CONTENT'));
    assert.ok(!logs.join('').includes(session));
    assert.ok(!logs.join('').includes('test-only'));
    logs.length = 0;
    global.fetch = (async () => { throw new Error('TOKEN=private-token BODY=private-body'); }) as unknown as typeof fetch;
    await POST(request('complaint', session, { text: 'another complaint' }), context('complaint'));
    assert.ok(logs.some(line => line.includes('provider.network_error')));
    assert.ok(!logs.join('').includes('private-token'));
    assert.ok(!logs.join('').includes('private-body'));
  } finally {
    console.error = originalError;
    if (previousAdmin === undefined) delete process.env.DISCORD_ADMIN_USER_ID;
    else process.env.DISCORD_ADMIN_USER_ID = previousAdmin;
  }
});
