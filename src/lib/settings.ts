import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { appSettings, settingsRevision, users } from './schema';
import { AppError } from './security';
import { requireAdmin } from './admin';
import { SETTING_KEYS, SETTINGS_DEFAULTS, type SettingsSnapshot, type SettingKey } from './settings-definition';

function snapshot(values: Record<SettingKey, string>, revision: number): SettingsSnapshot {
  return {
    revision,
    values: { ...values },
    configured: Object.fromEntries(SETTING_KEYS.map(key => [key, !!values[key]])) as Record<SettingKey, boolean>,
    databasePath: process.env.DATABASE_PATH || './data/lockinder.db'
  };
}

export function adminSettings(admin: { steamId: string }) {
  requireAdmin(admin);
  return db().transaction(tx => {
    const values = { ...SETTINGS_DEFAULTS, ...Object.fromEntries(tx.select().from(appSettings).all().map(row => [row.key, row.value])) };
    return snapshot(values, tx.select().from(settingsRevision).where(eq(settingsRevision.id, 1)).get()!.revision);
  });
}

const valueSchema = z.string().trim().max(4096).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const updateSchema = z.object({ revision: z.number().int().nonnegative(), values: z.partialRecord(z.enum(SETTING_KEYS), valueSchema) }).strict();

function validate(key: SettingKey, value: string) {
  if (key === 'APP_URL') {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { throw new AppError('invalidAppUrl'); }
  }
  if (key === 'ADMIN_STEAM_IDS') {
    const ids = value.split(/[\s,]+/).filter(Boolean);
    if (!ids.length || ids.length > 50 || ids.some(id => !/^\d{17}$/.test(id))) throw new AppError('invalidAdminIds');
    return [...new Set(ids)].join(',');
  }
  if (['DISCORD_CLIENT_ID', 'DISCORD_ADMIN_USER_ID', 'DISCORD_GUILD_ID'].includes(key) && value && !/^\d{17,20}$/.test(value)) throw new AppError('invalidDiscordId');
  if (key === 'DISCORD_INVITE_URL' && value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['discord.gg', 'discord.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error();
    } catch { throw new AppError('invalidDiscordInvite'); }
  }
  return value;
}

export function saveAdminSettings(admin: { steamId: string }, input: unknown) {
  requireAdmin(admin);
  const parsed = updateSchema.parse(input);
  const changes = Object.entries(parsed.values).map(([key, value]) => [key as SettingKey, validate(key as SettingKey, value)] as const);
  if (!changes.length) throw new AppError('invalidInput');
  return db().transaction(tx => {
    // Recheck access and revision while holding the write lock.
    requireAdmin(admin);
    const revision = tx.select().from(settingsRevision).where(eq(settingsRevision.id, 1)).get()!.revision;
    if (revision !== parsed.revision) throw new AppError('settingsConflict', 409);
    const values = { ...SETTINGS_DEFAULTS, ...Object.fromEntries(tx.select().from(appSettings).all().map(row => [row.key, row.value])) };
    for (const [key, value] of changes) values[key] = value;
    const admins = values.ADMIN_STEAM_IDS.split(/[\s,]+/).filter(Boolean);
    if (!admins.includes(admin.steamId)) throw new AppError('settingsKeepAdmin');
    if (tx.select({ banned: users.banned }).from(users).where(inArray(users.steamId, admins)).all().some(user => user.banned)) throw new AppError('settingsBannedAdmin');
    const now = Date.now();
    for (const [key, value] of changes) tx.insert(appSettings).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } }).run();
    tx.update(settingsRevision).set({ revision: revision + 1 }).where(eq(settingsRevision.id, 1)).run();
    return snapshot(values, revision + 1);
  }, { behavior: 'immediate' });
}
