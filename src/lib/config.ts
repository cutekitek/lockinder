import { logError } from './logger';
import { connection } from './db';
import { SETTINGS_DEFAULTS, type SettingKey } from './settings-definition';

export function setting(name: SettingKey) {
  const row = connection().sqlite.query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?').get(name);
  return row?.value ?? SETTINGS_DEFAULTS[name];
}

export function origin() {
  const value = setting('APP_URL');
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('APP_URL must be an origin');
  return url.origin;
}
export function required(name: SettingKey) {
  const value = setting(name);
  if (!value) {
    const error = new Error(`Missing configuration: ${name}`);
    logError('configuration.missing', error, { setting: name });
    throw error;
  }
  return value;
}
export const DEADLOCK = 'https://api.deadlock-api.com';
export function isAdmin(steamId: string) {
  return setting('ADMIN_STEAM_IDS').split(/[\s,]+/).filter(value => /^\d{17}$/.test(value)).includes(steamId);
}
export const DISCORD = 'https://discord.com/api/v10';
