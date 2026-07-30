import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

let pool: any;
let db: any;

try {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set");
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzle(pool, { schema });
} catch {
  console.warn('[AI Studio] Database not connected — using mock');
  const noOp = { 
    findMany: async () => [], 
    findFirst: async () => null,
    findUnique: async () => null, 
    create: async (d: any) => d?.data ?? {},
    update: async (d: any) => d?.data ?? {}, 
    delete: async () => ({}),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
    select: () => ({ from: () => ({ where: async () => [] }) })
  };
  
  db = new Proxy({}, {
    get: (_, prop) => {
      if (prop === 'query') return new Proxy({}, { get: () => noOp });
      if (prop === 'insert') return () => ({ values: () => ({ returning: async () => [], onConflictDoUpdate: () => ({ returning: async () => [] }) }) });
      if (prop === 'select') return () => ({ from: () => ({ where: async () => [], limit: async () => [] }), leftJoin: () => ({}) });
      if (prop === 'update') return () => ({ set: () => ({ where: async () => [], returning: async () => [] }) });
      if (prop === 'delete') return () => ({ where: async () => [], returning: async () => [] });
      if (prop === '$with') return () => ({});
      return async () => [];
    }
  });
  
  pool = {
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} })
  };
}

export { pool, db };
export * from "./schema";
