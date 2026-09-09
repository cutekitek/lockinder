import { processJob } from '../src/lib/worker';
import { connection } from '../src/lib/db';
import { logError } from '../src/lib/logger';
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
async function main() {
  console.log('Lockinder notification worker started');
  while (!stopping) {
    try {
      const result = await processJob();
      let wait = typeof result === 'object' ? result.wait : result ? 1000 : 2000;
      while (!stopping && wait > 0) { await new Promise(r => setTimeout(r, Math.min(wait, 1000))); wait -= 1000; }
    } catch (error) { logError('worker.iteration_failed', error, { retryInMs: 5000 }); await new Promise(r => setTimeout(r, 5000)); }
  }
  connection().sqlite.close();
}
void main();
