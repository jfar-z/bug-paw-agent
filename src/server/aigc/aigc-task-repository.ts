import type { AigcTaskRecord } from "../../shared/aigc-contracts";
import { readJson, writeJsonAtomic } from "../storage";
import { KeyedMutex } from "../core/keyed-mutex";

/** 以单文件 JSON 保存 AIGC 任务历史。 */
export class AigcTaskRepository {
  private readonly tasks = new Map<string, AigcTaskRecord>();
  private sequence = 0;
  private readonly ready: Promise<void>;
  /** 串行保存，避免并发任务用旧快照覆盖新状态。 */
  private readonly mutations = new KeyedMutex();

  /**
   * @param filePath 任务历史文件路径
   */
  constructor(private readonly filePath: string) {
    this.ready = this.load();
  }

  /** 列出全部任务，按创建时间倒序。 */
  async list(): Promise<AigcTaskRecord[]> {
    await this.ready;
    return [...this.tasks.values()].map(copyTask).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 读取单个任务。 */
  async get(id: string): Promise<AigcTaskRecord | undefined> {
    await this.ready;
    const task = this.tasks.get(id);
    return task ? copyTask(task) : undefined;
  }

  /** 创建任务。 */
  async create(task: AigcTaskRecord): Promise<AigcTaskRecord> {
    await this.ready;
    return this.mutations.run("tasks", async () => {
      if (this.tasks.has(task.id)) throw new TypeError("AIGC 任务标识重复");
      if (task.status === "queued") task = { ...task, queueOrder: ++this.sequence, submittedAt: new Date().toISOString() };
      this.tasks.set(task.id, copyTask(task));
      try {
        await this.persist();
      } catch (error) {
        this.tasks.delete(task.id);
        throw error;
      }
      return copyTask(task);
    });
  }

  /** 更新任务字段。 */
  async update(id: string, patch: Partial<AigcTaskRecord>): Promise<AigcTaskRecord | undefined> {
    await this.ready;
    return this.mutations.run("tasks", async () => {
      const current = this.tasks.get(id);
      if (!current) return undefined;
      const next = copyTask({ ...current, ...patch, id: current.id, ...(patch.status === "queued" && current.status !== "queued" ? { queueOrder: ++this.sequence, submittedAt: new Date().toISOString() } : {}) });
      this.tasks.set(id, next);
      try {
        await this.persist();
      } catch (error) {
        this.tasks.set(id, current);
        throw error;
      }
      return copyTask(next);
    });
  }

  /** 在同一次原子写入中提交整批状态，禁止部分任务提前执行。 */
  async submitPrepared(entries: { id: string; inputs: Record<string, unknown> }[]): Promise<AigcTaskRecord[]> {
    await this.ready;
    return this.mutations.run("tasks", async () => {
      const previous = entries.map(({ id }) => this.tasks.get(id));
      if (previous.some((task) => task?.status !== "prepared")) throw new TypeError("待运行任务已被取消或删除，请重新查询");
      const now = new Date().toISOString();
      const next = entries.map((entry, index) => copyTask({ ...previous[index]!, inputs: entry.inputs, status: "queued", queueOrder: ++this.sequence, submittedAt: now, updatedAt: now }));
      for (const task of next) this.tasks.set(task.id, task);
      try { await this.persist(); }
      catch (error) {
        for (const task of previous) this.tasks.set(task!.id, task!);
        throw error;
      }
      return next.map(copyTask);
    });
  }

  /** 删除任务并在持久化失败时恢复内存记录。 */
  async remove(id: string): Promise<AigcTaskRecord | undefined> {
    await this.ready;
    return this.mutations.run("tasks", async () => {
      const current = this.tasks.get(id);
      if (!current) return undefined;
      this.tasks.delete(id);
      try {
        await this.persist();
        return copyTask(current);
      } catch (error) {
        this.tasks.set(id, current);
        throw error;
      }
    });
  }

  /** 批量删除任务并只持久化一次，失败时恢复整批内存记录。 */
  async removeMany(ids: string[]): Promise<AigcTaskRecord[] | undefined> {
    await this.ready;
    return this.mutations.run("tasks", async () => {
      const current = ids.map((id) => this.tasks.get(id));
      if (current.some((task) => !task)) return undefined;
      const tasks = current as AigcTaskRecord[];
      for (const task of tasks) this.tasks.delete(task.id);
      try {
        await this.persist();
        return tasks.map(copyTask);
      } catch (error) {
        for (const task of tasks) this.tasks.set(task.id, task);
        throw error;
      }
    });
  }

  /** 加载历史文件并容错缺失或损坏内容。 */
  private async load(): Promise<void> {
    const value = await readJson<AigcTaskRecord[]>(this.filePath);
    if (!Array.isArray(value)) return;
    for (const task of value) {
      if (isTaskRecord(task)) { this.tasks.set(task.id, copyTask(task)); this.sequence = Math.max(this.sequence, task.queueOrder ?? 0); }
    }
    // 进程重启后不能假设上游没有执行，更不能自动重试计费任务。
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status === "running" || (task.status === "queued" && task.queueOrder === undefined)) {
        task.status = "failed";
        task.error = { code: "AIGC_INTERRUPTED", message: "服务重启，无法确认上游结果；请人工核对后再提交新任务" };
        task.updatedAt = task.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  /** 原子保存当前任务集合。 */
  private async persist(): Promise<void> {
    await writeJsonAtomic(this.filePath, [...this.tasks.values()].map(copyTask));
  }
}

/** 复制任务记录，避免调用方修改内存状态。 */
function copyTask(task: AigcTaskRecord): AigcTaskRecord {
  return structuredClone(task);
}

function isTaskRecord(value: unknown): value is AigcTaskRecord {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as AigcTaskRecord).id === "string"
    && typeof (value as AigcTaskRecord).interfaceId === "string"
    && typeof (value as AigcTaskRecord).status === "string"
    && Array.isArray((value as AigcTaskRecord).assets);
}
