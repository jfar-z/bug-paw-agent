import type { WorkflowSemaphore, WorkflowSemaphoreInput, WorkflowSemaphoreView } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
import { KeyedMutex } from "../core/keyed-mutex";
import { readJson, writeJsonAtomic } from "../storage";

/** 等待者以根运行归属，取消监听必须在完成或移出队列时移除。 */
interface Waiter {
  owner: string;
  count: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}
/** 全工作流共享的计数信号量；配置落盘，持有额度随运行生命周期回收。 */
export class WorkflowSemaphores {
  private definitions: WorkflowSemaphore[] = [];
  private readonly holdings = new Map<string, Map<string, number>>();
  private readonly waiting = new Map<string, Waiter[]>();
  private readonly lock = new KeyedMutex();
  constructor(private readonly path: string) {}

  /** 重启后的旧运行不重放，因此不恢复任何旧占用。 */
  async initialize(): Promise<void> {
    const values = await readJson<WorkflowSemaphore[]>(this.path) ?? [];
    if (!Array.isArray(values)) throw new DomainError("INTERNAL_ERROR", "信号量配置文件结构无效");
    const codes = new Set<string>();
    for (const value of values) {
      this.validate(value);
      if (!Number.isSafeInteger(value.revision) || value.revision < 1 || codes.has(value.code)) throw new DomainError("INTERNAL_ERROR", "信号量配置版本或 code 重复");
      codes.add(value.code);
    }
    this.definitions = values;
  }
  /** 返回配置和实时用量，不包含生产凭据。 */
  list(): WorkflowSemaphoreView[] {
    return this.definitions.map((item) => {
      const holders = [...this.holdings.get(item.code) ?? []].map(([runId, count]) => ({ runId, count }));
      const used = holders.reduce((sum, holder) => sum + holder.count, 0);
      return { ...item, used, available: item.limit - used, holders, waiting: (this.waiting.get(item.code) ?? []).map((waiter) => ({ runId: waiter.owner, count: waiter.count })) };
    });
  }
  /** 配置与调度共用互斥区，防止删除检查后发生新占用。 */
  async save(input: WorkflowSemaphoreInput, revision?: number): Promise<WorkflowSemaphore> {
    this.validate(input);
    return this.lock.run("semaphores", async () => {
      const current = this.definitions.find((item) => item.code === input.code);
      if (current ? revision !== current.revision : revision !== undefined) throw new DomainError("VERSION_CONFLICT", "信号量已存在或版本变化，请刷新后重试");
      const view = this.list().find((item) => item.code === input.code);
      if (view && (input.limit < view.used || view.waiting.some((waiter) => waiter.count > input.limit))) throw new DomainError("CONFLICT", "信号量上限不能低于当前占用量或等待申请量");
      const next = { code: input.code, name: input.name.trim(), limit: input.limit, revision: (current?.revision ?? 0) + 1 };
      const values = current ? this.definitions.map((item) => item.code === input.code ? next : item) : [...this.definitions, next];
      await writeJsonAtomic(this.path, values);
      this.definitions = values;
      this.drain(input.code);
      return next;
    });
  }
  /** 引用保护由领域服务检查，持有与等待保护在同一调度锁中复核。 */
  async remove(code: string, revision: number): Promise<void> {
    await this.lock.run("semaphores", async () => {
      const current = this.get(code);
      if (current.revision !== revision) throw new DomainError("VERSION_CONFLICT", "信号量版本变化，请刷新后删除");
      if (this.holdings.get(code)?.size || this.waiting.get(code)?.length) throw new DomainError("CONFLICT", "信号量仍有占用或等待，不能删除");
      const values = this.definitions.filter((item) => item.code !== code);
      await writeJsonAtomic(this.path, values);
      this.definitions = values;
    });
  }
  /** 获取请求按到达顺序排队，整笔分配；不把等待 Promise 留在互斥区。 */
  async acquire(code: string, count: number, owner: string, signal: AbortSignal): Promise<void> {
    const result = await this.lock.run("semaphores", async () => {
      signal.throwIfAborted();
      const definition = this.get(code);
      this.count(count);
      if (count > definition.limit) throw new DomainError("VALIDATION_FAILED", `信号量 ${code} 申请 ${count} 个，超过上限 ${definition.limit}`);
      const promise = new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { owner, count, resolve, reject, signal, abort: () => {
          const queue = this.waiting.get(code) ?? [];
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(signal.reason);
          // 配置正在落盘时不能按旧上限唤醒后续请求。
          void this.lock.run("semaphores", async () => this.drain(code)).catch(reject);
        } };
        signal.addEventListener("abort", waiter.abort, { once: true });
        const queue = this.waiting.get(code) ?? [];
        queue.push(waiter);
        this.waiting.set(code, queue);
        this.drain(code);
      });
      return { promise };
    });
    await result.promise;
  }
  /** 只允许释放当前根运行实际持有的额度，不能释放其他运行资源。 */
  async release(code: string, count: number, owner: string): Promise<void> {
    await this.lock.run("semaphores", async () => {
      this.get(code); this.count(count);
      const holders = this.holdings.get(code);
      const held = holders?.get(owner) ?? 0;
      if (count > held) throw new DomainError("CONFLICT", `当前运行仅持有信号量 ${code} 的 ${held} 个额度，不能释放 ${count} 个`);
      if (held === count) holders!.delete(owner); else holders!.set(owner, held - count);
      this.drain(code);
    });
  }
  /** 根运行终止后统一撤销等待并释放，重复调用不会扩大可用额度。 */
  async releaseAll(owner: string): Promise<void> {
    await this.lock.run("semaphores", async () => {
      for (const definition of this.definitions) {
        const code = definition.code;
        const queue = this.waiting.get(code) ?? [];
        for (const waiter of queue.filter((item) => item.owner === owner)) {
          queue.splice(queue.indexOf(waiter), 1);
          waiter.signal.removeEventListener("abort", waiter.abort);
          waiter.reject(new DomainError("CONFLICT", "工作流已结束，信号量等待已撤销"));
        }
        this.holdings.get(code)?.delete(owner);
        this.drain(code);
      }
    });
  }
  /** 运行前检查配置仍存在，配置删除不能产生无限等待。 */
  get(code: string): WorkflowSemaphore {
    const item = this.definitions.find((definition) => definition.code === code);
    if (!item) throw new DomainError("NOT_FOUND", `信号量 ${code} 不存在`);
    return { ...item };
  }
  /** 同步分配避免额度超卖，较小的后续请求也不能越过队首。 */
  private drain(code: string): void {
    const definition = this.definitions.find((item) => item.code === code);
    if (!definition) return;
    const holders = this.holdings.get(code) ?? new Map<string, number>();
    this.holdings.set(code, holders);
    const queue = this.waiting.get(code) ?? [];
    while (queue.length) {
      const waiter = queue[0];
      const used = [...holders.values()].reduce((sum, count) => sum + count, 0);
      if (definition.limit - used < waiter.count) return;
      queue.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      holders.set(waiter.owner, (holders.get(waiter.owner) ?? 0) + waiter.count);
      waiter.resolve();
    }
  }
  /** 公共请求与磁盘数据使用相同约束。 */
  private validate(input: WorkflowSemaphoreInput): void {
    if (!input || typeof input.code !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(input.code)
      || typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw new DomainError("VALIDATION_FAILED", "信号量 code 必须为字母开头的 1–80 位字母、数字、下划线或连字符，名称为 1–100 个字符");
    this.count(input.limit);
  }
  /** 数量只允许安全正整数，拒绝零、负数和隐式字符串转换。 */
  private count(count: number): void {
    if (!Number.isSafeInteger(count) || count < 1) throw new DomainError("VALIDATION_FAILED", "信号量数量和上限必须为正整数");
  }
}
