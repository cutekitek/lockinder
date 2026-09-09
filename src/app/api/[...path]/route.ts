import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { discord, profiles, sessions, users, passes } from '@/lib/schema';
import { AppError, authenticate, consumeState, cookie, cookieValue, csrf, hash, id, newSession, newState, rateLimit } from '@/lib/security';
import { origin, required } from '@/lib/config';
import { catalog, DiscordError, discordIdentity, refreshRank, sendDM, steamLoginUrl, steamSummary, verifyMembership, verifySteam } from '@/lib/providers';
import { communityStats, act, blockUser, cancelJobs, disconnectDiscord, discovery, getMe, profileDetail, receivedLikes, saveFilters, saveProfile } from '@/lib/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
function redirect(path: string) { return NextResponse.redirect(new URL(path, origin()), 303); }
function failure(error: unknown) {
  if (error instanceof AppError) return json({ error: error.code }, error.status);
  if (error instanceof z.ZodError) return json({ error: 'invalidInput' }, 400);
  if (error instanceof DiscordError) return json({ error: error.code }, error.status === 429 ? 429 : 503);
  console.error('Request failed', error instanceof Error ? error.constructor.name : 'UnknownError');
  return json({ error: 'unavailable' }, 503);
}
async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('invalidInput');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('invalidInput');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > 16_384) { await reader.cancel(); throw new AppError('invalidInput', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('invalidInput'); }
}

export async function GET(request: Request, context: Context) {
  const path = (await context.params).path.join('/');
  const url = new URL(request.url);
  try {
    if (path === 'stats') return json(communityStats());
    if (path === 'catalog') return json(await catalog(url.searchParams.get('locale') === 'ru' ? 'ru' : 'en'));
    if (path === 'health') { db().select({ id: users.id }).from(users).limit(1).all(); return json({ ok: true }); }
    if (path === 'auth/steam') {
      const state = newState('steam');
      const response = NextResponse.redirect(steamLoginUrl(state));
      response.headers.append('Set-Cookie', cookie('steam_state', state, 600));
      return response;
    }
    if (path === 'auth/steam/callback') {
      const state = url.searchParams.get('state') || '';
      consumeState(state, cookieValue(request, 'steam_state'), 'steam');
      const steamId = await verifySteam(url, state);
      const summary = await steamSummary(steamId);
      const userId = db().transaction(tx => {
        const existing = tx.select().from(users).where(eq(users.steamId, steamId)).get();
        if (existing) { if (summary.avatar) tx.update(users).set({ avatar: summary.avatar }).where(eq(users.id, existing.id)).run(); return existing.id; }
        const userId = id();
        tx.insert(users).values({ id: userId, steamId, avatar: summary.avatar, locale: request.headers.get('accept-language')?.startsWith('ru') ? 'ru' : 'en', createdAt: Date.now() }).run();
        tx.insert(profiles).values({ userId, name: summary.name }).run();
        return userId;
      }, { behavior: 'immediate' });
      await refreshRank(userId);
      const response = redirect('/');
      // Rotate any previous session held by this browser.
      db().delete(sessions).where(eq(sessions.hash, hash(cookieValue(request, 'session')))).run();
      response.headers.append('Set-Cookie', cookie('session', newSession(userId), 30 * 86400));
      response.headers.append('Set-Cookie', cookie('steam_state', '', 0));
      return response;
    }
    const user = authenticate(request);
    if (path === 'auth/discord') {
      rateLimit(`discordLink:${user.id}`, 10, 600_000);
      const clientId = required('DISCORD_CLIENT_ID');
      required('DISCORD_CLIENT_SECRET'); required('DISCORD_BOT_TOKEN'); required('DISCORD_GUILD_ID');
      const state = newState('discord', user.id);
      const query = new URLSearchParams({ client_id: clientId, redirect_uri: `${origin()}/api/auth/discord/callback`, response_type: 'code', scope: 'identify', state });
      const response = NextResponse.redirect(`https://discord.com/oauth2/authorize?${query}`);
      response.headers.append('Set-Cookie', cookie('discord_state', state, 600));
      return response;
    }
    if (path === 'auth/discord/callback') {
      consumeState(url.searchParams.get('state') || '', cookieValue(request, 'discord_state'), 'discord', user.id);
      const identity = await discordIdentity(url.searchParams.get('code') || '');
      db().transaction(tx => {
        const existing = tx.select().from(discord).where(eq(discord.discordId, identity.id)).get();
        if (existing && existing.userId !== user.id) throw new AppError('discordInUse');
        cancelJobs(user.id);
        tx.insert(discord).values({ userId: user.id, discordId: identity.id, username: identity.username }).onConflictDoUpdate({ target: discord.userId, set: { discordId: identity.id, username: identity.username, ready: false, checkedAt: null, error: null } }).run();
      }, { behavior: 'immediate' });
      const response = redirect('/settings');
      response.headers.append('Set-Cookie', cookie('discord_state', '', 0));
      return response;
    }
    if (path === 'me') {
      await refreshRank(user.id);
      return json({ ...getMe(user.id), discordInvite: process.env.DISCORD_INVITE_URL || null,
        discordConfigured: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID) });
    }
    if (path === 'discovery') return json(discovery(user.id));
    if (path === 'likes') return json({ players: receivedLikes(user.id) });
    if (path.startsWith('players/')) return json(profileDetail(user.id, path.split('/')[1]));
    throw new AppError('notFound', 404);
  } catch (error) {
    if (path.startsWith('auth/')) return redirect(`/?error=${encodeURIComponent(error instanceof AppError ? error.code : 'authUnavailable')}`);
    return failure(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    csrf(request);
    const user = authenticate(request);
    const path = (await context.params).path.join('/');
    if (path === 'logout') {
      db().delete(sessions).where(eq(sessions.hash, hash(cookieValue(request, 'session')))).run();
      const response = json({ ok: true }); response.headers.append('Set-Cookie', cookie('session', '', 0)); return response;
    }
    if (path === 'profile') { await saveProfile(user.id, await body(request)); return json({ ok: true }); }
    if (path === 'filters') { saveFilters(user.id, await body(request)); return json({ ok: true }); }
    if (path === 'settings') {
      const settings = z.object({ paused: z.boolean().optional(), notifications: z.boolean().optional(), locale: z.enum(['en', 'ru']).optional() }).strict().refine(v => Object.keys(v).length > 0).parse(await body(request));
      db().transaction(tx => {
        tx.update(users).set(settings).where(eq(users.id, user.id)).run();
        if (settings.notifications === false) cancelJobs(user.id);
      }, { behavior: 'immediate' });
      return json({ ok: true });
    }
    if (path === 'rank/refresh') { await refreshRank(user.id, true); return json({ ok: true }); }
    if (path === 'passes/reset') { db().delete(passes).where(eq(passes.senderId, user.id)).run(); return json({ ok: true }); }
    if (path === 'like' || path === 'pass') {
      const { target } = z.object({ target: z.string().regex(/^[a-f0-9]{24}$/) }).strict().parse(await body(request));
      return json(act(user.id, target, path));
    }
    if (path === 'block') {
      const { target, remove } = z.object({ target: z.string().regex(/^[a-f0-9]{24}$/), remove: z.boolean().default(false) }).strict().parse(await body(request));
      blockUser(user.id, target, remove); return json({ ok: true });
    }
    if (path === 'discord/disconnect') { disconnectDiscord(user.id); return json({ ok: true }); }
    if (path === 'discord/test') {
      rateLimit(`testDM:${user.id}`, 3, 600_000);
      const linked = db().select().from(discord).where(eq(discord.userId, user.id)).get();
      if (!linked) throw new AppError('linkDiscord');
      try {
        await verifyMembership(linked.discordId);
        await sendDM(linked.discordId, user.locale === 'ru' ? 'Lockinder подключён. Здесь появятся уведомления, когда ваш профиль кому-то понравится.' : 'Lockinder is connected. You will receive a notification here when someone likes your profile.');
        db().update(discord).set({ ready: true, checkedAt: Date.now(), error: null }).where(and(eq(discord.userId, user.id), eq(discord.discordId, linked.discordId))).run();

      } catch (error) {
        db().update(discord).set({ ready: false, error: error instanceof DiscordError ? error.code : 'discordUnavailable' }).where(and(eq(discord.userId, user.id), eq(discord.discordId, linked.discordId))).run();
        throw error;
      }
      return json({ ok: true });
    }
    throw new AppError('notFound', 404);
  } catch (error) { return failure(error); }
}
