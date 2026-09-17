import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { authStates, discord, jobs, likes, playerReports, profiles, sessions, users } from './schema';
import { AppError, id, rateLimit } from './security';
import { isAdmin } from './config';

export function requireAdmin(user: { steamId: string }) {
  if (!isAdmin(user.steamId)) throw new AppError('forbidden', 403);
}

export function reportPlayer(reporterId: string, input: unknown) {
  const { target, text } = z.object({ target: z.string().regex(/^[a-f0-9]{24}$/), text: z.string().trim().min(1).max(1500) }).strict().parse(input);
  if (target === reporterId) throw new AppError('invalidInput');
  return db().transaction(tx => {
    if (!tx.select({ id: users.id }).from(users).where(and(eq(users.id, target), eq(users.banned, false))).get()) throw new AppError('notFound', 404);
    rateLimit(`playerReport:${reporterId}`, 2, 60_000);
    tx.insert(playerReports).values({ id: id(), reporterId, targetId: target, text, createdAt: Date.now() }).run();
    return { ok: true };
  }, { behavior: 'immediate' });
}

const pagination = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});

// SQLite's built-in NOCASE only folds ASCII. GLOB character pairs also match
// Cyrillic names without treating user-supplied wildcard characters as syntax.
function searchPattern(value: string) {
  return '*' + Array.from(value).map(char => {
    if (char === '*') return '[*]';
    if (char === '?') return '[?]';
    if (char === '[') return '[[]';
    const lower = char.toLowerCase(), upper = char.toUpperCase();
    return lower !== upper && Array.from(lower).length === 1 && Array.from(upper).length === 1 ? `[${lower}${upper}]` : char;
  }).join('') + '*';
}

export function adminUsers(input: unknown) {
  const { q, scope, page: requestedPage, pageSize } = pagination.extend({ q: z.string().trim().max(100).default(''), scope: z.enum(['all', 'reported']).default('all') }).strict().parse(input);
  const reportCount = sql<number>`(select count(*) from ${playerReports} where ${playerReports.targetId} = ${users.id})`;
  const lastReportAt = sql<number | null>`(select max(${playerReports.createdAt}) from ${playerReports} where ${playerReports.targetId} = ${users.id})`;
  const pattern = searchPattern(q);
  const condition = and(
    scope === 'reported' ? sql`${reportCount} > 0` : undefined,
    q ? or(sql`${profiles.name} GLOB ${pattern}`, sql`${users.steamId} GLOB ${pattern}`, sql`${discord.username} GLOB ${pattern}`) : undefined
  );
  return db().transaction(tx => {
    const total = tx.select({ value: count() }).from(users).innerJoin(profiles, eq(profiles.userId, users.id)).leftJoin(discord, eq(discord.userId, users.id)).where(condition).get()!.value;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = tx.select({ id: users.id, steamId: users.steamId, name: profiles.name, avatar: users.avatar, country: profiles.country,
      createdAt: users.createdAt, complete: profiles.complete, paused: users.paused, banned: users.banned, bannedAt: users.bannedAt, discordUsername: discord.username, reportCount, lastReportAt })
      .from(users).innerJoin(profiles, eq(profiles.userId, users.id)).leftJoin(discord, eq(discord.userId, users.id)).where(condition)
      .orderBy(...(scope === 'reported' ? [desc(lastReportAt)] : []), desc(users.createdAt), users.id).limit(pageSize).offset((page - 1) * pageSize).all();
    return { users: rows.map(row => ({ ...row, canBan: !isAdmin(row.steamId) })), total, page, pageSize, totalPages };
  });
}

export function setUserBan(admin: { id: string; steamId: string }, input: unknown) {
  requireAdmin(admin);
  const { target, banned } = z.object({ target: z.string().regex(/^[a-f0-9]{24}$/), banned: z.boolean() }).strict().parse(input);
  return db().transaction(tx => {
    const user = tx.select().from(users).where(eq(users.id, target)).get();
    if (!user) throw new AppError('notFound', 404);
    if (target === admin.id || isAdmin(user.steamId)) throw new AppError('cannotBanAdmin', 400);
    tx.update(users).set({ banned, bannedAt: banned ? Date.now() : null, bannedBy: banned ? admin.id : null }).where(eq(users.id, target)).run();
    if (banned) {
      tx.delete(sessions).where(eq(sessions.userId, target)).run();
      tx.delete(authStates).where(eq(authStates.userId, target)).run();
      const relatedLikes = tx.select({ id: likes.id }).from(likes).where(or(eq(likes.senderId, target), eq(likes.recipientId, target)));
      tx.update(jobs).set({ status: 'cancelled', leaseToken: null, leaseUntil: null }).where(and(inArray(jobs.likeId, relatedLikes), inArray(jobs.status, ['pending', 'processing']))).run();
    }
    return { ok: true };
  }, { behavior: 'immediate' });
}

export function adminReports(target: string, input: unknown) {
  z.string().regex(/^[a-f0-9]{24}$/).parse(target);
  const { page: requestedPage, pageSize } = pagination.strict().parse(input);
  return db().transaction(tx => {
    const user = tx.select({ id: users.id, name: profiles.name, steamId: users.steamId }).from(users).innerJoin(profiles, eq(profiles.userId, users.id)).where(eq(users.id, target)).get();
    if (!user) throw new AppError('notFound', 404);
    const total = tx.select({ value: count() }).from(playerReports).where(eq(playerReports.targetId, target)).get()!.value;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const reports = tx.select({ id: playerReports.id, text: playerReports.text, createdAt: playerReports.createdAt,
      reporterId: users.id, reporterName: profiles.name, reporterSteamId: users.steamId })
      .from(playerReports).innerJoin(users, eq(users.id, playerReports.reporterId)).innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(playerReports.targetId, target)).orderBy(desc(playerReports.createdAt), playerReports.id).limit(pageSize).offset((page - 1) * pageSize).all();
    return { user, reports, total, page, pageSize, totalPages };
  });
}
