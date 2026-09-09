import { and, eq, lte, or } from 'drizzle-orm';
import { db } from './db';
import { discord, jobs, likes, profiles, ranks, users } from './schema';
import { id } from './security';
import { DiscordError, sendDM, verifyMembership } from './providers';
import { origin } from './config';
import { isBlocked } from './service';

export async function processJob() {
  const now = Date.now();
  const job = db().transaction(tx => {
    const candidate = tx.select().from(jobs).where(or(and(eq(jobs.status, 'pending'), lte(jobs.availableAt, now)), and(eq(jobs.status, 'processing'), lte(jobs.leaseUntil, now)))).orderBy(jobs.availableAt).get();
    if (!candidate) return;
    const leaseToken = id();
    tx.update(jobs).set({ status: 'processing', leaseUntil: now + 120_000, leaseToken, attempts: candidate.attempts + 1 }).where(eq(jobs.id, candidate.id)).run();
    return { ...candidate, attempts: candidate.attempts + 1, leaseToken };
  }, { behavior: 'immediate' });
  if (!job) return false;
  const owned = and(eq(jobs.id, job.id), eq(jobs.status, 'processing'), eq(jobs.leaseToken, job.leaseToken));
  const like = db().select().from(likes).where(eq(likes.id, job.likeId)).get();
  if (!like) return true;
  const recipient = db().select().from(users).where(eq(users.id, like.recipientId)).get();
  const connection = db().select().from(discord).where(eq(discord.userId, like.recipientId)).get();
  const sender = db().select().from(profiles).where(eq(profiles.userId, like.senderId)).get();
  if (!recipient?.notifications || !connection?.ready || !sender || isBlocked(like.senderId, like.recipientId)) {
    db().update(jobs).set({ status: 'cancelled', leaseToken: null }).where(owned).run();
    return true;
  }
  try {
    await verifyMembership(connection.discordId);
    // Recheck cancellation after the network call, before initiating delivery.
    if (!db().select().from(jobs).where(owned).get()) return true;
    const rank = db().select().from(ranks).where(eq(ranks.userId, like.senderId)).get();
    const ru = recipient.locale === 'ru';
    const rankLabel = rank?.tier ? `${ru ? 'Ранг' : 'Rank'} ${rank.tier}.${rank.division}` : ru ? 'Без ранга' : 'Unranked';
    const name = sender.name.replace(/[\[\]()*_~`<>@\\]/g, '');
    const message = ru ? `Вы понравились игроку ${name}! ${rankLabel}\nПосмотреть профиль и связаться: ${origin()}/players/${like.senderId}` : `${name} liked your profile! ${rankLabel}\nView their profile and connect: ${origin()}/players/${like.senderId}`;
    const messageId = await sendDM(connection.discordId, message, job.likeId);
    db().update(jobs).set({ status: 'sent', messageId, leaseToken: null, leaseUntil: null, error: null }).where(owned).run();
  } catch (error) {
    const permanent = error instanceof DiscordError && [400, 403, 404].includes(error.status);
    const code = error instanceof DiscordError ? error.code : 'discordUnavailable';
    const exhausted = job.attempts >= 5;
    const delay = error instanceof DiscordError && error.status === 429 ? Math.max(error.retryAfter, 1000) : Math.min(300_000, 1000 * 2 ** job.attempts);
    const changed = db().update(jobs).set({ status: permanent || exhausted ? 'failed' : 'pending', availableAt: Date.now() + delay, leaseToken: null, leaseUntil: null, error: code }).where(owned).returning({ id: jobs.id }).get();
    if (changed && (permanent || exhausted)) {
      db().update(discord).set({ ready: false, error: code }).where(and(eq(discord.userId, like.recipientId), eq(discord.discordId, connection.discordId))).run();
    }
    // A single worker respects Retry-After globally before attempting another job.
    if (error instanceof DiscordError && error.status === 429) return { wait: Math.max(error.retryAfter, 1000) };
  }
  return true;
}
