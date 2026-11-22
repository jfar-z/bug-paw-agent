/** 模板在目标删除后仍可管理，独立于任务和定义的生命周期。 */
export const runTemplatesMigration = {
  version: 11,
  sql: `CREATE TABLE run_templates (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL CHECK(domain IN ('aigc','workflow')),
    targetId TEXT NOT NULL,
    targetName TEXT NOT NULL,
    name TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    UNIQUE(domain, targetId, name)
  ) STRICT`,
} as const;
