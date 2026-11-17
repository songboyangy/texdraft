import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

export const sqlClient = postgres(config.databaseUrl, { max: 10 });
export const db = drizzle(sqlClient, { schema });
export { schema };
