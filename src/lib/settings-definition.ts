// Shared metadata only. Values and credentials are read exclusively on the server.
export const SETTING_KEYS = ['APP_URL', 'ADMIN_STEAM_IDS', 'STEAM_API_KEY', 'DEADLOCK_API_KEY', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_ADMIN_USER_ID', 'DISCORD_GUILD_ID', 'DISCORD_INVITE_URL'] as const;
export type SettingKey = typeof SETTING_KEYS[number];
export const SECRET_SETTINGS: readonly SettingKey[] = ['STEAM_API_KEY', 'DEADLOCK_API_KEY', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'];
export const SETTINGS_DEFAULTS: Record<SettingKey, string> = {
  APP_URL: 'http://localhost:3000', ADMIN_STEAM_IDS: '', STEAM_API_KEY: '', DEADLOCK_API_KEY: '',
  DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_BOT_TOKEN: '', DISCORD_ADMIN_USER_ID: '', DISCORD_GUILD_ID: '', DISCORD_INVITE_URL: ''
};
export type SettingsSnapshot = {
  revision: number;
  values: Record<SettingKey, string>;
  configured: Record<SettingKey, boolean>;
  databasePath: string;
};
