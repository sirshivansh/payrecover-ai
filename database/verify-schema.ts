import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'] });
import pg from 'pg';

async function verify() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/payrecover';

  const pool = new pg.Pool({ connectionString });

  try {
    const resUser = await pool.query('SELECT current_user, current_database()');
    console.log('--- USER & DATABASE ---');
    console.log(resUser.rows[0]);

    const resEnums = await pool.query("SELECT typname FROM pg_type WHERE typtype='e' ORDER BY typname");
    console.log('\n--- ENUMS ---');
    console.log(resEnums.rows.map((r) => r.typname));

    const resTables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    console.log('\n--- TABLES ---');
    console.log(resTables.rows.map((r) => r.table_name));

    const resIndexes = await pool.query(
      "SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname",
    );
    console.log('\n--- INDEXES ---');
    resIndexes.rows.forEach((r) => console.log(`  ${r.tablename} -> ${r.indexname}`));

    const resFKs = await pool.query(`
      SELECT
        tc.table_name, 
        kcu.column_name, 
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name 
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
    `);
    console.log('\n--- FOREIGN KEYS ---');
    resFKs.rows.forEach((r) =>
      console.log(`  ${r.table_name}.${r.column_name} -> ${r.foreign_table_name}.${r.foreign_column_name}`),
    );

    const resMigrations = await pool.query('SELECT name, timestamp FROM kysely_migration ORDER BY name');
    console.log('\n--- KYSELY MIGRATION TABLE ---');
    console.log(resMigrations.rows);
  } finally {
    await pool.end();
  }
}

verify().catch((err) => {
  console.error(err);
  process.exit(1);
});
