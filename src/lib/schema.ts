import { integer, sqliteTable, text, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), steamId: text('steam_id').notNull().unique(),
  avatar: text('avatar').notNull().default(''), locale: text('locale').notNull().default('en'),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  notifications: integer('notifications', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull()
});
export const profiles = sqliteTable('profiles', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), country: text('country').notNull().default(''),
  languages: text('languages', { mode: 'json' }).$type<string[]>().notNull().default([]),
  roles: text('roles', { mode: 'json' }).$type<string[]>().notNull().default([]),
  heroes: text('heroes', { mode: 'json' }).$type<number[]>().notNull().default([]),
  bio: text('bio').notNull().default(''), complete: integer('complete', { mode: 'boolean' }).notNull().default(false)
});
export const sessions = sqliteTable('sessions', {
  hash: text('hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull()
});
export const authStates = sqliteTable('auth_states', {
  hash: text('hash').primaryKey(), provider: text('provider').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }), expiresAt: integer('expires_at').notNull()
});
export const nonces = sqliteTable('nonces', { value: text('value').primaryKey(), expiresAt: integer('expires_at').notNull() });
export const discord = sqliteTable('discord_connections', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  discordId: text('discord_id').notNull().unique(), username: text('username').notNull(),
  ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
  checkedAt: integer('checked_at'), error: text('error')
});
export const ranks = sqliteTable('rank_snapshots', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  tier: integer('tier'), division: integer('division'), fetchedAt: integer('fetched_at'),
  attemptedAt: integer('attempted_at'), error: text('error')
});
export const preferences = sqliteTable('search_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  minRank: integer('min_rank'), maxRank: integer('max_rank'),
  roles: text('roles', { mode: 'json' }).$type<string[]>().notNull().default([])
});
export const likes = sqliteTable('likes', {
  id: text('id').primaryKey(), senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull()
}, t => [index('likes_recipient').on(t.recipientId), uniqueIndex('likes_pair').on(t.senderId, t.recipientId)]);
export const passes = sqliteTable('passes', {
  senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' })
}, t => [primaryKey({ columns: [t.senderId, t.recipientId] })]);
export const blocks = sqliteTable('blocks', {
  senderId: text('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  recipientId: text('recipient_id').notNull().references(() => users.id, { onDelete: 'cascade' })
}, t => [primaryKey({ columns: [t.senderId, t.recipientId] })]);
export const jobs = sqliteTable('notification_jobs', {
  id: text('id').primaryKey(), likeId: text('like_id').notNull().unique().references(() => likes.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0),
  availableAt: integer('available_at').notNull(), leaseUntil: integer('lease_until'), leaseToken: text('lease_token'),
  error: text('error'), messageId: text('message_id')
}, t => [index('jobs_due').on(t.status, t.availableAt)]);
export const limits = sqliteTable('rate_limits', { key: text('key').primaryKey(), count: integer('count').notNull(), resetAt: integer('reset_at').notNull() });
export const assets = sqliteTable('asset_cache', { key: text('key').primaryKey(), json: text('json').notNull(), fetchedAt: integer('fetched_at').notNull() });
