import { WorkflowSemaphores } from "./workflow-semaphores";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowSummary,
  WorkflowRun,
} from "../../shared/workflow-contracts";
import { readJson, writeJsonAtomic } from "../storage";
import type { Database } from "../database/database";
import { DefinitionRepository } from "./definition-repository";
import { DomainError } from "../core/errors";
import { KeyedMutex } from "../core/keyed-mutex";

/** DAG 列表保存在数据库，定义与运行快照分别按 ID 保存。 */
export class WorkflowRepository {
  readonly semaphores: WorkflowSemaphores;
  private readonly lock = new KeyedMutex();
  /** 提交凭据在全部成员落入独立运行文件后立即清理。 */
  private readonly batches = new Map<string, Set<string>>();
  private readonly store;
  constructor(private readonly directory: string, database: Database) {
    this.semaphores = new WorkflowSemaphores(join(directory, "semaphores.json"));
    this.store = new DefinitionRepository<WorkflowDefinition, WorkflowSummary>(database, "dag", join(directory, "definitions"), workflowSummary);
  }
  /** 查询列表摘要，不加载节点正文。 */
  definitions(): WorkflowSummary[] {
    return this.store.list().items;
  }
  /** 读取单个最新文件；损坏或缺失必须明确报错。 */
  definition(id: string): WorkflowDefinition | undefined {
    const value = this.store.get(id);
    if (!value) return undefined;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || typeof value.name !== "string"
      || !Number.isInteger(value.revision) || typeof value.published !== "boolean") {
      throw new DomainError("INTERNAL_ERROR", "DAG 工作流定义结构无效");
    }
    return { ...value, description: value.description ?? "" };
  }
  /** 仅修改当前 ID，在同一个同步临界区内校验业务版本并保存。 */
  mutateDefinition<T>(id: string, operation: (current: WorkflowDefinition | undefined) => { value?: WorkflowDefinition; result: T }): T {
    const revision = this.store.list().revision;
    const { value, result } = operation(this.definition(id));
    if (value) this.store.save(value, revision);
    else this.store.remove(id, revision);
    return result;
  }
  async saveRun(run: WorkflowRun): Promise<void> {
    await this.lock.run(run.id, () =>
      writeJsonAtomic(
        join(this.directory, "runs", `${run.id}.json`),
        structuredClone(run),
      ),
    );
    await this.settleBatch(run.id);
  }
  /** 一次原子写入提交整批任务；各运行后续状态仍按原文件独立保存。 */
  async saveBatch(runs: WorkflowRun[]): Promise<void> {
    const name = `batch-${runs[0].id}.json`;
    await writeJsonAtomic(join(this.directory, "runs", name), structuredClone(runs));
    this.batches.set(name, new Set(runs.map((run) => run.id)));
  }
  async runs(): Promise<WorkflowRun[]> {
    let names: string[];
    try {
      names = await readdir(join(this.directory, "runs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: WorkflowRun[] = [];
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const run = await readJson<WorkflowRun>(
        join(this.directory, "runs", name),
      );
      if (run) result.push(run);
    }
    // 批次记录是提交凭据；重启时只覆盖未提交的 prepared 快照，不覆盖后续执行结果。
    for (const name of names.filter((n) => /^batch-[a-f0-9-]{36}\.json$/.test(n))) {
      const batch = await readJson<WorkflowRun[]>(join(this.directory, "runs", name));
      if (!Array.isArray(batch)) throw new DomainError("INTERNAL_ERROR", "工作流批量提交记录结构无效");
      const pending = new Set<string>();
      for (const run of batch) {
        const index = result.findIndex((current) => current.id === run.id);
        if (index < 0) { result.push(run); pending.add(run.id); }
        else if (result[index].status === "prepared") { result[index] = run; pending.add(run.id); }
      }
      if (pending.size) this.batches.set(name, pending);
      else await rm(join(this.directory, "runs", name));
    }
    return result;
  }
  /** 串行清理已完成写入的批次凭据；失败直接传播，不静默遗漏。 */
  private async settleBatch(id: string): Promise<void> {
    await this.lock.run("batches", async () => {
      for (const [name, pending] of this.batches) {
        pending.delete(id);
        if (!pending.size) {
          await rm(join(this.directory, "runs", name));
          this.batches.delete(name);
        }
      }
    });
  }

}

/** 明确投影列表字段，节点、脚本和连线不得进入数据库。 */
export function workflowSummary(value: WorkflowDefinition): WorkflowSummary {
  return { id: value.id, name: value.name, description: value.description ?? "", published: value.published,
    revision: value.revision, nodeCount: value.nodes.length, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
