import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sqlClient } from './client.js';

export async function runMigrations() {
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log('migrations applied');
  await sqlClient.end();
}
