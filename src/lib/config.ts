import { logError } from './logger';

export function origin() {
  const value = process.env.APP_URL || 'http://localhost:3000';
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('APP_URL must be an origin');
  return url.origin;
}
export function required(name: string) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Missing configuration: ${name}`);
    logError('configuration.missing', error, { setting: name });
    throw error;
  }
  return value;
}
export const DEADLOCK = 'https://api.deadlock-api.com';
export const DISCORD = 'https://discord.com/api/v10';
