import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run dev --port 3100', url: 'http://localhost:3100/api/health',
    reuseExistingServer: false, timeout: 60_000,
    env: { APP_URL: 'http://localhost:3100', DATABASE_PATH: './data/e2e.db', ADMIN_STEAM_IDS: '76561197960266728', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_BOT_TOKEN: '', DISCORD_GUILD_ID: '' }
  }
});
