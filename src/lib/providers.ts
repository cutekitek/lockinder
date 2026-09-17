import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { assets, ranks, users } from './schema';
import { AppError, claimNonce, id, rateLimit } from './security';
import { DEADLOCK, DISCORD, origin, required } from './config';
import { logError, providerFetch } from './logger';
import type { Catalog, Locale } from './model';
import fallbackEn from '../data/catalog-en.json';
import fallbackRu from '../data/catalog-ru.json';

export const STEAM = 'https://steamcommunity.com/openid/login';
export function steamAccountId(steamId: string) {
  if (!/^\d{17}$/.test(steamId)) throw new AppError('invalidAuth');
  const value = BigInt(steamId) - 76561197960265728n;
  if (value < 0n || value > 4294967295n) throw new AppError('invalidAuth');
  return Number(value);
}
export function steamLoginUrl(state: string) {
  const url = new URL(STEAM);
  url.search = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup',
    'openid.return_to': `${origin()}/api/auth/steam/callback?state=${state}`,
    'openid.realm': `${origin()}/`,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
  }).toString();
  return url.toString();
}
export async function verifySteam(url: URL, state: string) {
  const p = url.searchParams;
  for (const key of p.keys()) if (p.getAll(key).length !== 1) throw new AppError('invalidAuth');
  const claimed = p.get('openid.claimed_id') || '';
  const match = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed);
  const signed = new Set((p.get('openid.signed') || '').split(','));
  if (!match || p.get('openid.mode') !== 'id_res' || p.get('openid.ns') !== 'http://specs.openid.net/auth/2.0' ||
      p.get('openid.op_endpoint') !== STEAM || p.get('openid.identity') !== claimed ||
      p.get('openid.return_to') !== `${origin()}/api/auth/steam/callback?state=${state}` ||
      !['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'].every(k => signed.has(k))) throw new AppError('invalidAuth');
  steamAccountId(match[1]);
  claimNonce(p.get('openid.response_nonce') || '');
  const body = new URLSearchParams();
  p.forEach((value, key) => { if (key.startsWith('openid.')) body.set(key, value); });
  body.set('openid.mode', 'check_authentication');
  const response = await providerFetch('steam', 'verify_login', STEAM, { method: 'POST', body, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok || !/^is_valid:true\r?$/m.test(await response.text())) throw new AppError('invalidAuth');
  return match[1];
}
export async function steamSummary(steamId: string) {
  if (!process.env.STEAM_API_KEY) return { name: `Player ${steamId.slice(-4)}`, avatar: '' };
  try {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
    url.searchParams.set('key', process.env.STEAM_API_KEY);
    url.searchParams.set('steamids', steamId);
    const response = await providerFetch('steam', 'player_summary', url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new AppError('authUnavailable', 503);
    const body = await response.json();
    const player = body.response?.players?.[0];
    return { name: typeof player?.personaname === 'string' ? player.personaname.slice(0, 40) : 'Player', avatar: safeImage(player?.avatarfull) };
  } catch (error) { logError('steam.summary_failed', error); return { name: `Player ${steamId.slice(-4)}`, avatar: '' }; }
}
export function safeImage(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['assets-bucket.deadlock-api.com', 'assets.deadlock-api.com', 'api.deadlock-api.com', 'avatars.steamstatic.com', 'avatars.akamai.steamstatic.com', 'cdn.akamai.steamstatic.com'].includes(url.hostname) ? value : '';
  } catch { return ''; }
}
const rankSchema = z.object({ rank: z.number().int().min(0).max(12), subrank: z.number().int().min(0).max(6), badge: z.number().int().nonnegative() }).refine(v => v.rank === 0 ? v.subrank === 0 && v.badge === 0 : v.subrank >= 1 && v.badge === v.rank * 10 + v.subrank);
export async function refreshRank(userId: string, manual = false) {
  const now = Date.now();
  const shouldFetch = db().transaction(tx => {
    const row = tx.select().from(ranks).where(eq(ranks.userId, userId)).get();
    if (row?.attemptedAt && now - row.attemptedAt < 300_000) {
      if (manual) throw new AppError('rankCooldown', 429);
      return false;
    }
    if (!manual && row?.fetchedAt && now - row.fetchedAt < 3600_000) return false;
    tx.insert(ranks).values({ userId, attemptedAt: now }).onConflictDoUpdate({ target: ranks.userId, set: { attemptedAt: now } }).run();
    return true;
  }, { behavior: 'immediate' });
  if (!shouldFetch) return;
  const user = db().select().from(users).where(eq(users.id, userId)).get();
  if (!user) return;
  try {
    const response = await providerFetch('deadlock', 'player_rank', `${DEADLOCK}/v1/players/${steamAccountId(user.steamId)}/rank`, { headers: process.env.DEADLOCK_API_KEY ? { 'X-API-Key': process.env.DEADLOCK_API_KEY } : {}, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('rankUnavailable');
    const rank = rankSchema.parse(await response.json());
    db().update(ranks).set({ tier: rank.rank, division: rank.subrank, fetchedAt: Date.now(), error: null }).where(eq(ranks.userId, userId)).run();
  } catch (error) {
    logError('rank.refresh_failed', error, { userId });
    db().update(ranks).set({ error: 'rankUnavailable' }).where(eq(ranks.userId, userId)).run();
  }
}
export async function catalog(locale: Locale): Promise<Catalog> {
  const cached = db().select().from(assets).where(eq(assets.key, locale)).get();
  if (cached && Date.now() - cached.fetchedAt < 86400_000) return JSON.parse(cached.json);
  try {
    const language = locale === 'ru' ? 'russian' : 'english';
    const responses = await Promise.all(['heroes', 'ranks'].map(asset => providerFetch('deadlock', asset, `${DEADLOCK}/v1/assets/${asset}?language=${language}`, { signal: AbortSignal.timeout(8000) })));
    if (responses.some(r => !r.ok)) throw new Error('unavailable');
    const heroData = z.array(z.object({ id: z.number().int(), name: z.string(), player_selectable: z.boolean(), disabled: z.boolean().optional(), in_development: z.boolean().optional(), images: z.record(z.string(), z.unknown()) })).parse(await responses[0].json());
    const rankData = z.array(z.object({ tier: z.number().int(), name: z.string(), images: z.record(z.string(), z.unknown()) })).parse(await responses[1].json());
    if (!heroData.length || !rankData.length) throw new Error('unavailable');
    const result: Catalog = {
      heroes: heroData.filter(h => h.player_selectable && !h.disabled && !h.in_development).map(h => ({ id: h.id, name: h.name, image: safeImage(h.images.icon_image_small_webp), portrait: safeImage(h.images.icon_hero_card_webp) })),
      ranks: rankData.map(r => ({ tier: r.tier, name: r.name, image: safeImage(r.images.large_webp), divisions: [1, 2, 3, 4, 5, 6] })), stale: false
    };
    db().insert(assets).values({ key: locale, json: JSON.stringify(result), fetchedAt: Date.now() }).onConflictDoUpdate({ target: assets.key, set: { json: JSON.stringify(result), fetchedAt: Date.now() } }).run();
    return result;
  } catch (error) { logError('catalog.refresh_failed', error, { locale, cached: !!cached }); return { ...(cached ? JSON.parse(cached.json) : locale === 'ru' ? fallbackRu : fallbackEn), stale: true }; }
}

export class DiscordError extends Error {
  constructor(public status: number, public retryAfter = 0, public code = 'discordUnavailable') { super(code); }
}
export async function discordRequest(path: string, init: RequestInit = {}, accessToken?: string) {
  const response = await providerFetch('discord', path.replace(/\d+/g, ':id'), `${DISCORD}${path}`, {
    ...init, headers: { Authorization: accessToken ? `Bearer ${accessToken}` : `Bot ${required('DISCORD_BOT_TOKEN')}`, 'Content-Type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(error => { logError('discord.invalid_response', error, { status: response.status }); return {}; });
  if (!response.ok) {
    const error = new DiscordError(response.status, Number(body.retry_after || response.headers.get('retry-after') || 1) * 1000, response.status === 403 ? 'dmBlocked' : response.status === 404 ? 'joinServer' : 'discordUnavailable');
    logError('discord.request_failed', error, { operation: path.replace(/\d+/g, ':id'), discordCode: typeof body.code === 'number' ? body.code : undefined, retryAfterMs: error.retryAfter });
    throw error;
  }
  return body;
}
export async function discordIdentity(code: string) {
  const response = await providerFetch('discord', 'oauth_token', `${DISCORD}/oauth2/token`, { method: 'POST', body: new URLSearchParams({
    client_id: required('DISCORD_CLIENT_ID'), client_secret: required('DISCORD_CLIENT_SECRET'), grant_type: 'authorization_code', code,
    redirect_uri: `${origin()}/api/auth/discord/callback`
  }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new AppError('invalidAuth');
  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new AppError('invalidAuth');
  // Only the verified identity is retained; no long-lived user OAuth tokens are stored.
  return z.object({ id: z.string().regex(/^\d{17,20}$/), username: z.string() }).parse(await discordRequest('/users/@me', {}, body.access_token));
}
export async function verifyMembership(discordId: string) {
  await discordRequest(`/guilds/${required('DISCORD_GUILD_ID')}/members/${discordId}`);
}
export async function sendDM(userId: string, discordId: string, content: string, nonce = id()) {
  // Charge complaints to their author and personal notifications to their recipient.
  rateLimit(`discordMessage:${userId}`, 2, 60_000);
  const channel = await discordRequest('/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: discordId }) });
  const message = await discordRequest(`/channels/${channel.id}/messages`, { method: 'POST', body: JSON.stringify({ content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }) });
  return z.string().parse(message.id);
}
