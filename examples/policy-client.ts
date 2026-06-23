import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { createPolicyClient, definePolicies } from '../src/index.js';

type ExamplePolicyContext = {
  readonly isMaintenanceJob: boolean;
};

const policies = definePolicies<ExamplePolicyContext>()(policy => [
  policy.define({
    name: 'custom-name',
    read: () => 'ignore',
  }),
]);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.log('Set DATABASE_URL to run the drizzle-policy client example.');
  process.exit(0);
}

const pool = new Pool({ connectionString });
const rawDb = drizzle({ client: pool });
const { db, policyContext } = createPolicyClient(rawDb, {
  policies,
  rawExecution: 'allow',
});

try {
  await policyContext.run({ isMaintenanceJob: true }, async () => {
    const result = await db.execute(sql`select 1`);
    console.log(result);
  });
} finally {
  await pool.end();
}
