import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowSemaphores } from "./workflow-semaphores";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
/** 每项测试使用隔离磁盘配置，不访问生产数据。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "semaphores-")); roots.push(root);
  const path = join(root, "semaphores.json"), service = new WorkflowSemaphores(path);
  await service.initialize(); await service.save({ code: "gpu", name: "共享 GPU", limit: 3 });
  return { service, path };
}
it("加权申请严格 FIFO，不部分获取且禁止越权释放，取消唤醒下一项", async () => {
  const { service } = await fixture(); const first = new AbortController(), second = new AbortController();
  await service.acquire("gpu", 2, "owner", first.signal);
  const waiting = service.acquire("gpu", 2, "second", second.signal);
  const cancelled = expect(waiting).rejects.toThrow("取消等待");
  const third = vi.fn(); const last = service.acquire("gpu", 1, "third", first.signal).then(third);
  await vi.waitFor(() => expect(service.list()[0].waiting).toHaveLength(2));
  expect(third).not.toHaveBeenCalled(); expect(service.list()[0].used).toBe(2);
  await expect(service.release("gpu", 1, "other")).rejects.toThrow("仅持有");
  await expect(service.release("gpu", 3, "owner")).rejects.toThrow("不能释放");
  second.abort(new Error("取消等待")); await cancelled; await last;
  expect(service.list()[0]).toMatchObject({ used: 3, available: 0, waiting: [] });
  await service.releaseAll("owner"); await service.releaseAll("owner");
  expect(service.list()[0].used).toBe(1);
  await service.releaseAll("third"); expect(service.list()[0].used).toBe(0);
});
it("持久化配置与乐观版本保护，活动删除与降额被拒绝，重启清空占用", async () => {
  const { service, path } = await fixture();
  await service.acquire("gpu", 2, "run", new AbortController().signal);
  await expect(service.save({ code: "gpu", name: "更新", limit: 1 }, 1)).rejects.toThrow("当前占用");
  await expect(service.remove("gpu", 1)).rejects.toThrow("占用或等待");
  await expect(service.save({ code: "gpu", name: "更新", limit: 4 }, 2)).rejects.toThrow("版本变化");
  await service.save({ code: "gpu", name: "更新", limit: 4 }, 1);
  const restarted = new WorkflowSemaphores(path); await restarted.initialize();
  expect(restarted.list()[0]).toMatchObject({ code: "gpu", name: "更新", limit: 4, revision: 2, used: 0 });
});
it("非法数量不产生占用；提高额度唤醒等待者", async () => {
  const { service } = await fixture(); const signal = new AbortController().signal;
  for (const count of [0, -1, 1.2, 4, NaN]) await expect(service.acquire("gpu", count, "a", signal)).rejects.toThrow();
  await service.acquire("gpu", 3, "a", signal);
  const next = service.acquire("gpu", 1, "b", signal);
  await vi.waitFor(() => expect(service.list()[0].waiting).toHaveLength(1));
  await service.save({ code: "gpu", name: "GPU", limit: 4 }, 1); await next;
  expect(service.list()[0].used).toBe(4);
});
