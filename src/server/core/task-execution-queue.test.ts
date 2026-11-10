import { afterEach, expect, it, vi } from "vitest";
import { TaskExecutionQueue } from "./task-execution-queue";
afterEach(() => vi.useRealTimers());

it("并发满时接受提交，严格按顺序启动且不跳过被调用方额度阻塞的队首", async () => {
  const started: string[] = [];
  const finishes = new Map<string, () => void>();
  const errors = vi.fn();
  const queue = new TaskExecutionQueue({ global: 3, perOwner: 1, hourly: 10 }, errors);
  const add = (id: string, owner: string) => queue.add({ id, owner, execute: () => { started.push(id); return new Promise<void>((resolve) => finishes.set(id, resolve)); } });
  add("a", "one"); add("b", "one"); add("c", "two");
  expect(started).toEqual(["a"]);
  expect(queue.reason("b")).toContain("调用方并发额度");
  finishes.get("a")!();
  await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
  finishes.get("b")!(); finishes.get("c")!(); queue.close();
  expect(errors).not.toHaveBeenCalled();
});

it("小时额度恢复自动唤醒，取消队首不消耗额度且停服不再调度", async () => {
  vi.useFakeTimers();
  const execute = vi.fn(async () => undefined);
  const queue = new TaskExecutionQueue({ global: 2, perOwner: 2, hourly: 1 }, vi.fn());
  queue.restore("one", new Date().toISOString());
  queue.add({ id: "a", owner: "one", execute });
  queue.add({ id: "b", owner: "one", execute });
  expect(queue.remove("a")).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3600_000);
  expect(execute).toHaveBeenCalledTimes(1);
  queue.add({ id: "c", owner: "one", execute }); queue.close();
  await vi.advanceTimersByTimeAsync(3600_000);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("执行异常报告后释放额度并继续下一项", async () => {
  const error = new Error("持久化失败"), report = vi.fn(), next = vi.fn(async () => undefined);
  const queue = new TaskExecutionQueue({ global: 1, perOwner: 1, hourly: 10 }, report);
  queue.add({ id: "a", owner: "one", execute: async () => { throw error; } });
  queue.add({ id: "b", owner: "one", execute: next });
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  expect(report).toHaveBeenCalledWith(error); queue.close();
});

it("取消落盘期间保留队首，失败原位恢复，批量移除不会启动其他删除目标", async () => {
  const started: string[] = []; let finish!: () => void;
  const queue = new TaskExecutionQueue({ global: 1, perOwner: 1, hourly: 10 }, vi.fn());
  queue.add({ id: "active", owner: "one", execute: () => new Promise<void>((resolve) => { finish = resolve; }) });
  const add = (id: string) => queue.add({ id, owner: "one", execute: async () => { started.push(id); } });
  add("a"); add("b"); add("c");
  queue.suspend("a"); queue.suspend("b"); finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(started).toEqual([]);
  queue.remove("a"); expect(started).toEqual([]);
  queue.resume("b");
  await vi.waitFor(() => expect(started).toEqual(["b", "c"])); queue.close();
});
