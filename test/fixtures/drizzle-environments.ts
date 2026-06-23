import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleV1 } from 'drizzle-orm/pglite';
import { drizzle as drizzleV0 } from 'drizzle-orm-v0/pglite';

import * as v0Schema from './v0-schema';
import * as v1Schema from './v1-schema';

export const createV1TestEnvironment = (): {
  client: PGlite;
  db: object;
  relations: typeof v1Schema.tableRelations;
  schema: typeof v1Schema;
} => {
  const client = new PGlite();
  const db = drizzleV1({
    client,
    relations: v1Schema.tableRelations,
  });

  return {
    client,
    db,
    relations: v1Schema.tableRelations,
    schema: v1Schema,
  };
};

export const createV0TestEnvironment = (): {
  client: PGlite;
  db: object;
  schema: typeof v0Schema;
} => {
  const client = new PGlite();
  const db = drizzleV0(client, {
    schema: v0Schema,
  });

  return {
    client,
    db,
    schema: v0Schema,
  };
};
