import { backupDatabase, connection } from '../src/lib/db';
const destination = process.argv[2];
if (!destination) throw new Error('Provide a new backup path: bun run db:backup ./backup.db');
try {
  backupDatabase(destination);
  console.log('Consistent SQLite backup completed');
} finally {
  connection().sqlite.close(true);
}
