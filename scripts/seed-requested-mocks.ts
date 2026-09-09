import { randomBytes } from 'node:crypto';
import { openDatabase } from '../src/lib/db';

const fixtures = [
  { steamId: '76561198099536661', name: 'Mock · Nightshift', country: 'RU', languages: ['ru', 'en'], roles: ['Carry', 'Flex'], heroes: [2, 7], tier: 7, division: 3,
    bio: 'Тестовый профиль. Играю по вечерам, люблю активные линии и командные драки. Ищу напарника для рейтинга без токсичности.' },
  { steamId: '76561198452320925', name: 'Mock · Brass', country: 'RU', languages: ['ru', 'en'], roles: ['Support', 'Tank'], heroes: [6, 8], tier: 6, division: 5,
    bio: 'Тестовый профиль. Обычно играю после 20:00 МСК. Помогаю на линии, общаюсь в голосе. Можно рейтинг или обычные матчи.' },
];
const { sqlite } = openDatabase();
try {
  sqlite.transaction(() => {
    for (const f of fixtures) {
      if (sqlite.prepare('SELECT 1 FROM users WHERE steam_id = ?').get(f.steamId)) {
        console.log(`Skipped existing Steam ID ${f.steamId}`);
        continue;
      }
      const id = randomBytes(12).toString('hex'), now = Date.now();
      sqlite.prepare('INSERT INTO users (id, steam_id, locale, notifications, created_at) VALUES (?, ?, ?, 0, ?)').run(id, f.steamId, 'ru', now);
      sqlite.prepare('INSERT INTO profiles (user_id, name, country, languages, roles, heroes, bio, complete) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(id, f.name, f.country, JSON.stringify(f.languages), JSON.stringify(f.roles), JSON.stringify(f.heroes), f.bio);
      sqlite.prepare('INSERT INTO rank_snapshots (user_id, tier, division, fetched_at, attempted_at) VALUES (?, ?, ?, ?, ?)').run(id, f.tier, f.division, now, now);
      // Non-routable placeholder IDs; these fixtures must never receive Discord DMs.
      sqlite.prepare('INSERT INTO discord_connections (user_id, discord_id, username, ready, checked_at) VALUES (?, ?, ?, 1, ?)')
        .run(id, `mock:${f.steamId}`, `mock_${f.steamId}`, now);
      sqlite.prepare('INSERT INTO search_preferences (user_id) VALUES (?)').run(id);
      console.log(`Created ${f.steamId}: ${f.name}`);
    }
  }).immediate();
  console.log(sqlite.prepare(`SELECT u.steam_id, p.name, p.complete, u.notifications, r.tier, r.division,
    (p.complete = 1 AND d.ready = 1 AND u.paused = 0) AS discoverable
    FROM users u JOIN profiles p ON p.user_id = u.id JOIN rank_snapshots r ON r.user_id = u.id
    JOIN discord_connections d ON d.user_id = u.id WHERE u.steam_id IN (?, ?)`)
    .all(...fixtures.map(f => f.steamId)));
} finally { sqlite.close(); }
