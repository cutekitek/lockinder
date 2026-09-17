import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.beforeEach(() => execFileSync('bun', ['tests/browser/seed.ts', '--admin'], { stdio: 'inherit' }));

test('reports reach admin, users paginate and search, bans hide profiles and can be reversed', async ({ page, context }) => {
  await context.addCookies([{ name: 'session', value: 'e2e-viewer', url: 'http://localhost:3100' }]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Report player', exact: true }).click();
  const report = page.getByRole('dialog');
  await expect(report.getByRole('heading')).toContainText('Nightjar');
  await expect(report.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await report.getByLabel('Reason for reporting').fill('Harassment in voice chat');
  await report.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(report).toHaveCount(0);
  await expect(page.getByText('Your report has been saved for administrator review.')).toBeVisible();

  await context.addCookies([{ name: 'session', value: 'e2e-admin', url: 'http://localhost:3100' }]);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin panel', exact: true })).toBeVisible();
  await expect(page.getByText('Total: 26 · Page 1 / 2')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(20);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Total: 26 · Page 2 / 2')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await page.getByLabel('Search users').fill('nIgHtJaR');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Total: 1 · Page 1 / 1')).toBeVisible();
  await page.getByRole('button', { name: 'Reported users', exact: true }).click();
  await page.getByRole('button', { name: 'View reports (1)' }).click();
  await expect(page.getByText('Harassment in voice chat', { exact: true })).toBeVisible();
  await expect(page.locator('.admin-report-meta')).toContainText('Test Captain');
  await page.screenshot({ path: 'test-results/admin-reports-desktop.png', fullPage: true });

  await page.getByRole('button', { name: 'Ban user', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Nightjar');
  await page.getByRole('dialog').getByRole('button', { name: 'Ban user', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tbody tr')).toContainText('Banned');
  await expect(page.getByRole('button', { name: 'Unban user', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'RU', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Админ-панель', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/admin-mobile-ru.png', fullPage: true });

  await context.addCookies([{ name: 'session', value: 'e2e-viewer', url: 'http://localhost:3100' }]);
  const discovery = await (await page.request.get('/api/discovery')).json();
  expect(discovery.players.some((player: { name: string }) => player.name === 'Nightjar')).toBe(false);
  expect((await page.request.get('/api/players/bbbbbbbbbbbbbbbbbbbbbbbb')).status()).toBe(404);
  await context.addCookies([{ name: 'session', value: 'e2e-candidate', url: 'http://localhost:3100' }]);
  expect((await page.request.get('/api/me')).status()).toBe(401);
  await page.goto('/?error=accountBanned');
  await expect(page.locator('.notice[role="alert"]')).toContainText('Ваш аккаунт заблокирован');

  await context.addCookies([{ name: 'session', value: 'e2e-admin', url: 'http://localhost:3100' }]);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Пользователи с жалобами', exact: true }).click();
  await page.getByRole('button', { name: 'Снять бан', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Снять бан', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tbody tr')).toContainText('Активен');
});

test('ordinary users cannot open admin data or ban accounts', async ({ page, context }) => {
  await context.addCookies([{ name: 'session', value: 'e2e-viewer', url: 'http://localhost:3100' }]);
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: 'Admin panel', exact: true })).toHaveCount(0);
  await expect(page.locator('.admin-panel')).toHaveCount(0);
  expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  expect((await page.request.get('/api/admin/users/bbbbbbbbbbbbbbbbbbbbbbbb/reports')).status()).toBe(403);
  expect((await page.request.post('/api/admin/ban', { headers: { origin: 'http://localhost:3100' }, data: { target: 'bbbbbbbbbbbbbbbbbbbbbbbb', banned: true } })).status()).toBe(403);
});
