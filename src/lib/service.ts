import { and, eq, or, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import countries from 'i18n-iso-countries';
import { connection, db } from './db';
import { users, profiles, discord, ranks, preferences, likes, passes, blocks, jobs } from './schema';
import { AppError, id, rateLimit } from './security';
import { LANGUAGES, ROLES, orderPlayers, type Filters, type Player } from './model';
import { catalog } from './providers';
import { isAdmin } from './config';

export const filterSchema = z.object({ minRank: z.number().int().min(0).max(71).nullable(), maxRank: z.number().int().min(0).max(71).nullable(), roles: z.array(z.enum(ROLES)).max(5) }).strict().refine(f => f.minRank === null || f.maxRank === null || f.minRank <= f.maxRank);
export function communityStats() {
  return connection().sqlite.prepare(`SELECT
    (SELECT count(*) FROM users) AS registeredPlayers,
    (SELECT count(*) FROM likes a JOIN likes b
      ON a.sender_id = b.recipient_id AND a.recipient_id = b.sender_id
      WHERE a.sender_id < a.recipient_id) AS teammateConnections
  `).get() as { registeredPlayers: number; teammateConnections: number };
}
const profileSchema = z.object({
  name: z.string().trim().min(2).max(40), country: z.string().refine(c => c === '' || (countries.isValid(c) && /^[A-Z]{2}$/.test(c))).default(''),
  languages: z.array(z.enum(LANGUAGES)).min(1).max(12), roles: z.array(z.enum(ROLES)).min(1).max(5),
  heroes: z.array(z.number().int().positive()).max(12), bio: z.string().trim().max(600)
}).strict();
export function playerRows() {
  return db().select({ user: users, profile: profiles, discord, rank: ranks }).from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id)).leftJoin(discord, eq(discord.userId, users.id)).leftJoin(ranks, eq(ranks.userId, users.id));
}
type Row = ReturnType<ReturnType<typeof playerRows>['all']>[number];
export function publicPlayer(row: Row): Player {
  return { id: row.user.id, name: row.profile.name, avatar: row.user.avatar, country: row.profile.country,
    languages: row.profile.languages, roles: row.profile.roles, heroes: row.profile.heroes, bio: row.profile.bio,
    tier: row.rank?.tier ?? null, division: row.rank?.division ?? null, rankFetchedAt: row.rank?.fetchedAt ?? null, rankError: row.rank?.error ?? null };
}
export function getMe(userId: string) {
  const row = playerRows().where(eq(users.id, userId)).get();
  if (!row) throw new AppError('unauthorized', 401);
  if (row.user.banned) throw new AppError('accountBanned', 403);
  return { ...publicPlayer(row), isAdmin: isAdmin(row.user.steamId), locale: row.user.locale, paused: row.user.paused, notifications: row.user.notifications,
    complete: row.profile.complete, discord: row.discord ? { username: row.discord.username, ready: row.discord.ready, error: row.discord.error } : null,
    ready: row.profile.complete && !row.user.paused,
    filters: db().select().from(preferences).where(eq(preferences.userId, userId)).get() || { minRank: null, maxRank: null, roles: [] },
    blocks: db().select({ id: profiles.userId, name: profiles.name }).from(blocks).innerJoin(profiles, eq(profiles.userId, blocks.recipientId)).innerJoin(users, eq(users.id, profiles.userId)).where(and(eq(blocks.senderId, userId), eq(users.banned, false))).all()
  };
}
export function requireReady(userId: string) { if (!getMe(userId).ready) throw new AppError('setupRequired', 403); }
export function isBlocked(a: string, b: string) {
  return !!db().select().from(blocks).where(or(and(eq(blocks.senderId, a), eq(blocks.recipientId, b)), and(eq(blocks.senderId, b), eq(blocks.recipientId, a)))).get();
}
export function discovery(userId: string) {
  requireReady(userId);
  const me = getMe(userId);
  const omitted = new Set([
    ...db().select({ id: likes.recipientId }).from(likes).where(eq(likes.senderId, userId)).all(),
    ...db().select({ id: passes.recipientId }).from(passes).where(eq(passes.senderId, userId)).all(),
    ...db().select({ id: blocks.recipientId }).from(blocks).where(eq(blocks.senderId, userId)).all(),
    ...db().select({ id: blocks.senderId }).from(blocks).where(eq(blocks.recipientId, userId)).all()
  ].map(r => r.id));
  const players = playerRows().where(and(ne(users.id, userId), eq(users.paused, false), eq(users.banned, false), eq(profiles.complete, true))).all()
    .filter(r => !omitted.has(r.user.id)).map(publicPlayer);
  const sorted = orderPlayers(me, players, me.filters);
  return { players: sorted.slice(0, 30), total: sorted.length };
}
export async function saveProfile(userId: string, input: unknown) {
  const parsed = profileSchema.parse(input);
  const validHeroes = new Set((await catalog('en')).heroes.map(h => h.id));
  if (parsed.heroes.some(h => !validHeroes.has(h))) throw new AppError('invalidInput');
  db().update(profiles).set({ ...parsed, languages: [...new Set(parsed.languages)], roles: [...new Set(parsed.roles)], heroes: [...new Set(parsed.heroes)], complete: true }).where(eq(profiles.userId, userId)).run();
}
export function saveFilters(userId: string, input: unknown) {
  const filters: Filters = filterSchema.parse(input);
  db().insert(preferences).values({ userId, ...filters }).onConflictDoUpdate({ target: preferences.userId, set: filters }).run();
}
export function act(userId: string, target: string, action: 'like' | 'pass') {
  return db().transaction(tx => {
    requireReady(userId);
    if (userId === target || isBlocked(userId, target)) throw new AppError('notFound', 404);
    const recipient = playerRows().where(eq(users.id, target)).get();
    if (!recipient || recipient.user.banned || !recipient.profile.complete || recipient.user.paused) throw new AppError('notFound', 404);
    if (action === 'pass') {
      tx.insert(passes).values({ senderId: userId, recipientId: target }).onConflictDoNothing().run();
      return { liked: false };
    }
    const existing = tx.select().from(likes).where(and(eq(likes.senderId, userId), eq(likes.recipientId, target))).get();
    if (existing) return { liked: true };
    rateLimit(`likes:${userId}`, 30, 3600_000);
    const likeId = id();
    tx.insert(likes).values({ id: likeId, senderId: userId, recipientId: target, createdAt: Date.now() }).run();
    tx.insert(jobs).values({ id: id(), likeId, availableAt: Date.now(), status: recipient.user.notifications && recipient.discord?.ready ? 'pending' : 'cancelled' }).run();
    return { liked: true };
  }, { behavior: 'immediate' });
}
export function receivedLikes(userId: string) {
  return db().select().from(likes).where(eq(likes.recipientId, userId)).all().sort((a, b) => b.createdAt - a.createdAt)
    .filter(l => !isBlocked(userId, l.senderId)).map(l => {
      const row = playerRows().where(eq(users.id, l.senderId)).get();
      return row && !row.user.banned ? { ...publicPlayer(row), likedAt: l.createdAt } : null;
    }).filter(Boolean);
}
export function profileDetail(viewer: string, target: string) {
  if (isBlocked(viewer, target)) throw new AppError('notFound', 404);
  const row = playerRows().where(eq(users.id, target)).get();
  const incoming = db().select().from(likes).where(and(eq(likes.senderId, target), eq(likes.recipientId, viewer))).get();
  if (!row || row.user.banned || (!incoming && (!row.profile.complete || row.user.paused))) throw new AppError('notFound', 404);
  // Contact details are disclosed to a recipient of this person's like only.
  return { ...publicPlayer(row), discordUsername: incoming ? row.discord?.username : null, discordId: incoming ? row.discord?.discordId : null, steamUrl: incoming ? `https://steamcommunity.com/profiles/${row.user.steamId}` : null };
}
export function cancelJobs(userId: string) {
  const ids = db().select({ id: likes.id }).from(likes).where(eq(likes.recipientId, userId)).all().map(l => l.id);
  if (ids.length) db().update(jobs).set({ status: 'cancelled', leaseToken: null }).where(and(inArray(jobs.likeId, ids), inArray(jobs.status, ['pending', 'processing']))).run();
}
export function disconnectDiscord(userId: string) {
  db().transaction(tx => {
    cancelJobs(userId);
    tx.delete(discord).where(eq(discord.userId, userId)).run();

  }, { behavior: 'immediate' });
}
export function blockUser(userId: string, target: string, remove = false) {
  if (target === userId || !db().select().from(users).where(eq(users.id, target)).get()) throw new AppError('notFound', 404);
  db().transaction(tx => {
    if (remove) tx.delete(blocks).where(and(eq(blocks.senderId, userId), eq(blocks.recipientId, target))).run();
    else {
      tx.insert(blocks).values({ senderId: userId, recipientId: target }).onConflictDoNothing().run();
      const ids = tx.select({ id: likes.id }).from(likes).where(or(and(eq(likes.senderId, userId), eq(likes.recipientId, target)), and(eq(likes.senderId, target), eq(likes.recipientId, userId)))).all().map(l => l.id);
      if (ids.length) tx.update(jobs).set({ status: 'cancelled', leaseToken: null }).where(and(inArray(jobs.likeId, ids), inArray(jobs.status, ['pending', 'processing']))).run();
    }
  }, { behavior: 'immediate' });
}
