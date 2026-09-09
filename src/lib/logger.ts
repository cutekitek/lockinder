import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type Fields = Record<string, string | number | boolean | null | undefined>;
const requests = new AsyncLocalStorage<Fields>();

// Never serialize arbitrary error messages: SDK/DB errors can contain tokens,
// request bodies or SQL parameters. Keep machine codes and source locations.
function errorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: 'UnknownError' };
  const value = error as Error & { code?: unknown; status?: unknown; cause?: unknown };
  return {
    type: error.constructor.name,
    code: typeof value.code === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(value.code) ? value.code : undefined,
    status: typeof value.status === 'number' ? value.status : undefined,
    stack: error.stack?.split('\n').slice(1).filter(line => /^\s+at /.test(line)).slice(0, 8).map(line => line.replace(/\?[^\s)]*/g, '?[redacted]')),
    cause: value.cause && depth < 2 ? errorDetails(value.cause, depth + 1) : undefined,
  };
}

export function logError(event: string, error: unknown, fields: Fields = {}, level: 'error' | 'warn' = 'error') {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...requests.getStore(), ...fields, error: errorDetails(error) }));
}

export function withRequestLog<T extends Response>(request: Request, task: () => Promise<T>) {
  // Query strings may contain OAuth codes. Normalize user-controlled path parts.
  const route = new URL(request.url).pathname.replace(/[^/]+/g, part => /^[a-z-]{1,32}$/.test(part) ? part : ':id');
  const requestId = randomUUID();
  return requests.run({ requestId, method: request.method, route }, async () => {
    try {
      const response = await task();
      response.headers.set('X-Request-ID', requestId);
      return response;
    } catch (error) { logError('api.unhandled_error', error); throw error; }
  });
}

export async function providerFetch(provider: string, operation: string, input: string | URL, init?: RequestInit) {
  try {
    const response = await fetch(input, init);
    if (!response.ok) logError('provider.http_error', new Error(), { provider, operation, status: response.status });
    return response;
  } catch (error) {
    logError('provider.network_error', error, { provider, operation });
    throw error;
  }
}
