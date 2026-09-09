export function origin() {
  const value = process.env.APP_URL || 'http://localhost:3000';
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('APP_URL must be an origin');
  return url.origin;
}
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
export const DEADLOCK = 'https://api.deadlock-api.com';
export const DISCORD = 'https://discord.com/api/v10';
