import { createHash } from 'node:crypto';
import { openDatabase } from '../../src/lib/db';
import en from '../../src/data/catalog-en.json';
import ru from '../../src/data/catalog-ru.json';
import { SETTING_KEYS, SETTINGS_DEFAULTS } from '../../src/lib/settings-definition';

const ids = { viewer: 'aaaaaaaaaaaaaaaaaaaaaaaa', candidate: 'bbbbbbbbbbbbbbbbbbbbbbbb', onboarding: 'cccccccccccccccccccccccc' };
function seed() {
  const { sqlite } = openDatabase('./data/e2e.db');
  sqlite.exec('DELETE FROM users; DELETE FROM asset_cache; DELETE FROM rate_limits;');
  const now = Date.now();
  const settings = { ...SETTINGS_DEFAULTS, APP_URL: 'http://localhost:3100', ADMIN_STEAM_IDS: '76561197960266728' };
  for (const key of SETTING_KEYS) sqlite.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, settings[key], now);
  sqlite.exec('UPDATE settings_revision SET revision = 0');
  for (const [key, userId] of Object.entries(ids)) {
    const n = Object.keys(ids).indexOf(key) + 1;
    sqlite.prepare('INSERT INTO users (id, steam_id, created_at) VALUES (?, ?, ?)').run(userId, String(76561197960265728n + BigInt(n)), now);
    sqlite.prepare('INSERT INTO profiles (user_id, name, country, languages, roles, heroes, bio, complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, key === 'candidate' ? 'Nightjar' : key === 'viewer' ? 'Test Captain' : 'New Player', 'US', '["en","ru"]', '["Support","Flex"]', '[1]', 'Calm comms, evening games. Let’s learn and climb together.', key === 'onboarding' ? 0 : 1);
    sqlite.prepare('INSERT INTO rank_snapshots (user_id, tier, division, fetched_at, attempted_at) VALUES (?, 6, 2, ?, ?)').run(userId, now, now);
    if (key !== 'onboarding') sqlite.prepare('INSERT INTO discord_connections (user_id, discord_id, username, ready) VALUES (?, ?, ?, 1)').run(userId, `12345678901234567${n}`, `test_${key}`);
    sqlite.prepare('INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(`e2e-${key}`).digest('hex'), userId, now + 3600_000);
  }
  for (const [locale, data] of [['en', en], ['ru', ru]] as const) sqlite.prepare('INSERT INTO asset_cache VALUES (?, ?, ?)').run(locale, JSON.stringify({ ...data, stale: false }), now);
  if (process.argv.includes('--admin')) {
    for (let n = 0; n < 23; n++) {
      const userId = (1000 + n).toString(16).padStart(24, '0');
      sqlite.prepare('INSERT INTO users (id, steam_id, created_at, paused) VALUES (?, ?, ?, 1)').run(userId, String(76561197960266728n + BigInt(n)), now + n);
      sqlite.prepare('INSERT INTO profiles (user_id, name, complete) VALUES (?, ?, 1)').run(userId, n === 0 ? 'Test Administrator' : `Admin fixture ${n}`);
      if (n === 0) sqlite.prepare('INSERT INTO sessions (hash, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update('e2e-admin').digest('hex'), userId, now + 3600_000);
    }
  }
  sqlite.close();
}
seed();
