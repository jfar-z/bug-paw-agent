/** 本地持久化任务的执行额度；排队不占额度，小时窗口按实际启动计算。 */
export interface TaskQueueLimits {
  global: number;
  perOwner: number;
  hourly: number;
}
/** 已提交任务的调度描述，执行函数负责持久化启动状态及处理错误。 */
interface QueueJob {
  id: string;
  owner: string;
  execute: () => Promise<void>;
}
/** 严格 FIFO 调度器：队首额度不足时不允许后来的任务插队。 */
export class TaskExecutionQueue {
  private readonly pending: QueueJob[] = [];
  /** 取消或删除落盘期间保留原队位，禁止提前调度。 */
  private readonly suspended = new Set<string>();
  private readonly active = new Map<string, string>();
  private readonly starts = new Map<string, number[]>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly limits: TaskQueueLimits, private readonly onError: (error: Error) => void) {}

  /** 恢复最近启动记录；必须在恢复排队任务之前调用。 */
  restore(owner: string, at?: string): void {
    const time = Date.parse(at ?? "");
    if (time > Date.now() - 3600_000) this.starts.set(owner, [...this.starts.get(owner) ?? [], time].sort((a, b) => a - b));
  }
  /** 仅持久化成功的任务才能入队；同步保留批次内顺序。 */
  add(job: QueueJob): void {
    if (this.stopped || this.active.has(job.id) || this.pending.some((item) => item.id === job.id)) return;
    this.pending.push(job);
    this.pump();
  }
  /** 暂停待执行项，持久化失败时可原位恢复。 */
  suspend(id: string): boolean {
    if (!this.pending.some((job) => job.id === id)) return false;
    this.suspended.add(id);
    return true;
  }
  /** 仅恢复原队位，不重新入队或修改提交顺序。 */
  resume(id: string): void { this.suspended.delete(id); this.pump(); }
  /** 移除尚未启动的任务，不消耗任何执行额度。 */
  remove(id: string): boolean {
    const index = this.pending.findIndex((job) => job.id === id);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.suspended.delete(id);
    this.pump();
    return true;
  }
  /** 返回等待原因，供手动页面和 Agent 查询使用。 */
  reason(id: string): string | undefined {
    const index = this.pending.findIndex((job) => job.id === id);
    if (index < 0) return undefined;
    return `本地排队第 ${index + 1} 位：${index ? "等待前序任务调度" : this.blocked(this.pending[0]) ?? "等待启动"}`;
  }
  /** 停服仅停止调度，持久化队列由下次启动恢复。 */
  close(): void { this.stopped = true; clearTimeout(this.timer); }

  /** 清理过期小时额度；计算队首阻塞条件。 */
  private blocked(job: QueueJob): string | undefined {
    if (this.suspended.has(job.id)) return "等待取消或删除操作完成";
    const times = (this.starts.get(job.owner) ?? []).filter((at) => at > Date.now() - 3600_000);
    this.starts.set(job.owner, times);
    if (this.active.size >= this.limits.global) return "等待全局并发额度";
    if ([...this.active.values()].filter((owner) => owner === job.owner).length >= this.limits.perOwner) return "等待当前调用方并发额度";
    if (times.length >= this.limits.hourly) return "等待当前调用方小时额度恢复";
  }
  /** 同步预留额度，异步执行结束后唤醒下一项，避免并发超卖。 */
  private pump(): void {
    clearTimeout(this.timer);
    while (!this.stopped && this.pending.length) {
      const job = this.pending[0];
      if (this.blocked(job)) {
        const times = this.starts.get(job.owner) ?? [];
        if (times.length >= this.limits.hourly) {
          this.timer = setTimeout(() => this.pump(), Math.max(1, times[0] + 3600_000 - Date.now()));
          this.timer.unref();
        }
        return;
      }
      this.pending.shift();
      this.active.set(job.id, job.owner);
      this.starts.get(job.owner)!.push(Date.now());
      // 调用执行函数时即注册控制器，取消请求不会落入未注册的时间窗口。
      void job.execute().catch((error: unknown) => this.onError(error instanceof Error ? error : new Error("任务调度执行未返回可读异常"))).finally(() => {
        this.active.delete(job.id);
        this.pump();
      });
    }
  }
}
