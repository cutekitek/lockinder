import { connection } from '../src/lib/db';
connection().sqlite.close();
console.log('Database migrations applied');
