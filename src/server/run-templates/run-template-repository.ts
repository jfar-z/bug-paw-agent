import { randomUUID } from "node:crypto";
import type { RunTemplateDomain, RunTemplateSummary } from "../../shared/run-template-contracts";
import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

/** 只存储已复核的字段值和兼容性标识。 */
export interface TemplateSnapshot {
  inputs: Record<string, unknown>;
  types: Record<string, string>;
  channelKey?: string;
}

const columns = "id, targetId, targetName, name";
type SummaryRow = RunTemplateSummary & Record<string, unknown>;

export class RunTemplateRepository {
  constructor(private db: Database) {}

  list(domain: RunTemplateDomain) {
    return this.db.read<SummaryRow>(`SELECT ${columns} FROM run_templates WHERE domain=? ORDER BY name,id`, [domain]);
  }

  get(domain: RunTemplateDomain, id: string) {
    const row = this.db.readOne<SummaryRow & {snapshot: string}>(
      `SELECT ${columns}, snapshot FROM run_templates WHERE domain=? AND id=?`, [domain, id]);
    if (!row) throw new DomainError("NOT_FOUND", "运行模板已删除或不存在");
    return { ...row, snapshot: JSON.parse(row.snapshot) as TemplateSnapshot };
  }

  private name(domain: RunTemplateDomain, targetId: string, input: unknown, id: string) {
    const name = typeof input === "string" ? input.trim() : "";
    if (!name) throw new DomainError("VALIDATION_FAILED", "模板名称不能为空");
    if (this.db.readOne("SELECT id FROM run_templates WHERE domain=? AND targetId=? AND name=? AND id<>?", [domain, targetId, name, id]))
      throw new DomainError("RUN_TEMPLATE_CONFLICT", "当前运行对象已有同名模板");
    return name;
  }

  create(domain: RunTemplateDomain, targetId: string, targetName: string, input: unknown, snapshot: TemplateSnapshot) {
    return this.db.transaction(() => {
      const id = randomUUID();
      const name = this.name(domain, targetId, input, id);
      this.db.write("INSERT INTO run_templates(domain,id,targetId,targetName,name,snapshot) VALUES(?,?,?,?,?,?)",
        [domain, id, targetId, targetName, name, JSON.stringify(snapshot)]);
      return { id, targetId, targetName, name };
    });
  }

  overwrite(domain: RunTemplateDomain, id: string, targetId: string, targetName: string, snapshot: TemplateSnapshot) {
    return this.db.transaction(() => {
      const row = this.get(domain, id);
      if (row.targetId !== targetId) throw new DomainError("RUN_TEMPLATE_CONFLICT", "只能覆盖当前运行对象的模板");
      this.db.write("UPDATE run_templates SET targetName=?,snapshot=? WHERE domain=? AND id=?",
        [targetName, JSON.stringify(snapshot), domain, id]);
      return { id, targetId, targetName, name: row.name };
    });
  }

  rename(domain: RunTemplateDomain, id: string, input: unknown) {
    return this.db.transaction(() => {
      const { targetId, targetName } = this.get(domain, id);
      const name = this.name(domain, targetId, input, id);
      this.db.write("UPDATE run_templates SET name=? WHERE domain=? AND id=?", [name, domain, id]);
      return { id, targetId, targetName, name };
    });
  }

  remove(domain: RunTemplateDomain, id: string) {
    if (!this.db.write("DELETE FROM run_templates WHERE domain=? AND id=?", [domain, id]).changes)
      throw new DomainError("NOT_FOUND", "运行模板已删除或不存在");
  }
}
