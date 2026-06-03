import fs from "fs/promises";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, "..", "migrations");

function normalizePostgresUrl(databaseUrl) {
  if (!databaseUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(databaseUrl);
    const sslMode = parsedUrl.searchParams.get("sslmode");

    if (["prefer", "require", "verify-ca"].includes(sslMode)) {
      parsedUrl.searchParams.set("sslmode", "verify-full");
    }

    return parsedUrl.toString();
  } catch {
    return databaseUrl.replace(
      /([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/i,
      "$1verify-full",
    );
  }
}

if (!process.env.DATABASE_URL) {
  console.error("Defina DATABASE_URL antes de rodar as migracoes.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: normalizePostgresUrl(process.env.DATABASE_URL),
  ssl:
    process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

async function migrate() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );

      if (alreadyApplied.rowCount > 0) {
        console.log(`Ignorando ${file}, ja aplicada.`);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1)",
        [file],
      );
      console.log(`Aplicada ${file}.`);
    }

    await client.query("COMMIT");
    console.log("Migracoes concluidas.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Falha ao rodar migracoes:", err.message);
  process.exit(1);
});
