import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from './db';
import { authStates, limits, nonces, sessions, users } from './schema';
import { origin } from './config';

export class AppError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
export class RateLimitError extends AppError {
  constructor(public retryAfter: number) { super('rateLimited', 429); }
}
export const token = () => randomBytes(32).toString('hex');
export const id = () => randomBytes(12).toString('hex');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function equal(a: string, b: string) { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function cookieValue(request: Request, name: string) {
  return request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
export function cookie(name: string, value: string, seconds: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${origin().startsWith('https:') ? '; Secure' : ''}`;
}
export function csrf(request: Request) {
  if (request.headers.get('origin') !== origin() || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('forbidden', 403);
}
export function authenticate(request: Request) {
  const session = db().select({ user: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.hash, hash(cookieValue(request, 'session'))), gt(sessions.expiresAt, Date.now()))).get();
  if (!session) throw new AppError('unauthorized', 401);
  if (session.user.banned) throw new AppError('accountBanned', 403);
  return session.user;
}
export function newSession(userId: string) {
  const value = token();
  db().transaction(tx => {
    const user = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new AppError('unauthorized', 401);
    if (user.banned) throw new AppError('accountBanned', 403);
    tx.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
    tx.insert(sessions).values({ hash: hash(value), userId, expiresAt: Date.now() + 30 * 86400_000 }).run();
  }, { behavior: 'immediate' });
  return value;
}
export function newState(provider: string, userId: string | null = null) {
  const value = token();
  db().delete(authStates).where(lt(authStates.expiresAt, Date.now())).run();
  db().insert(authStates).values({ hash: hash(value), provider, userId, expiresAt: Date.now() + 600_000 }).run();
  return value;
}
export function consumeState(value: string, browserValue: string, provider: string, userId: string | null = null) {
  if (!value || !browserValue || !equal(value, browserValue)) throw new AppError('invalidAuth', 400);
  const row = db().delete(authStates).where(and(eq(authStates.hash, hash(value)), eq(authStates.provider, provider), gt(authStates.expiresAt, Date.now()))).returning().get();
  if (!row || row.userId !== userId) throw new AppError('invalidAuth', 400);
}
export function claimNonce(nonce: string) {
  const time = Date.parse(nonce.slice(0, 20));
  if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 300_000) throw new AppError('invalidAuth');
  db().delete(nonces).where(lt(nonces.expiresAt, Date.now())).run();
  if (!db().insert(nonces).values({ value: nonce, expiresAt: Date.now() + 600_000 }).onConflictDoNothing().returning({ value: nonces.value }).get()) throw new AppError('invalidAuth');
}
export function rateLimit(key: string, max: number, period: number) {
  db().transaction(tx => {
    const now = Date.now();
    const row = tx.select().from(limits).where(eq(limits.key, key)).get();
    if (!row || row.resetAt <= now) {
      tx.insert(limits).values({ key, count: 1, resetAt: now + period }).onConflictDoUpdate({ target: limits.key, set: { count: 1, resetAt: now + period } }).run();
    } else {
      if (row.count >= max) throw new RateLimitError(row.resetAt - now);
      tx.update(limits).set({ count: row.count + 1 }).where(eq(limits.key, key)).run();
    }
  }, { behavior: 'immediate' });
}
