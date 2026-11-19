import { mediaLibraryNoteMigration } from "./migrations/010-media-library-note";
import { mediaLibraryMigration } from "./migrations/009-media-library";
import { workflowIndexMigration } from "./migrations/008-workflow-index";
import { totpMigration } from "./migrations/007-totp";
import type { Database } from "./database";
import { initialMigration } from "./migrations/001-initial";
import { retrievalToolNamesMigration } from "./migrations/002-retrieval-tool-names";
import { browserAuditMigration } from "./migrations/003-browser-audit";
import { sessionPinningMigration } from "./migrations/004-session-pinning";
import { sessionQuestionsMigration } from "./migrations/005-session-questions";
import { aigcMcpMigration } from "./migrations/006-aigc-mcp";

const MIGRATIONS = [
  initialMigration,
  retrievalToolNamesMigration,
  browserAuditMigration,
  sessionPinningMigration,
  sessionQuestionsMigration,
  aigcMcpMigration,
  totpMigration,
  workflowIndexMigration,
  mediaLibraryMigration,
  mediaLibraryNoteMigration,
] as const;

/** 按版本顺序执行未应用的数据库 Migration。 */
export function runMigrations(database: Database, options: { throughVersion?: number } = {}): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  for (const migration of MIGRATIONS) {
    if (options.throughVersion !== undefined && migration.version > options.throughVersion) break;
    const applied = database.readOne<{ version: number }>(
      "SELECT version FROM schema_migrations WHERE version = ?",
      [migration.version],
    );
    if (applied) continue;
    database.transaction(() => {
      if ("sql" in migration) database.exec(migration.sql);
      else migration.apply(database);
      database.write(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        [migration.version, new Date().toISOString()],
      );
    });
  }
}
