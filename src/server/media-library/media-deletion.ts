import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import {
  MediaDeleteBatchSchema, type MediaDeleteBatch, type MediaDeleteItemResult, type MediaDeletePrompt,
} from "../../shared/media-library-contracts";
import { DomainError } from "../core/errors";
import type { MediaRepository } from "./media-repository";
import type { MediaStorage } from "./media-storage";

/** 先逐项提交带版本的删除，再回收独占目录。批次中一个文件变化不影响其他文件。 */
export async function deleteMediaBatch(repo: MediaRepository, storage: MediaStorage, libraryId: string, batch: MediaDeleteBatch) {
  if (!Check(MediaDeleteBatchSchema, batch) || new Set(batch.files.map(file => file.id)).size !== batch.files.length)
    throw new DomainError("VALIDATION_FAILED", "请提供同一库内互不重复的文件标识及正整数版本");

  const results = batch.files.map(({ id, revision }): MediaDeleteItemResult => {
    try {
      repo.removeFile(libraryId, id, revision);
      return { id, status: "deleted" };
    } catch (error) {
      if (error instanceof DomainError)
        return { id, status: error.code === "NOT_FOUND" ? "missing" : "failed", code: error.code, message: error.message };
      return { id, status: "failed", code: "INTERNAL_ERROR", message: "提交媒体文件删除事务失败" };
    }
  });
  for (const item of results) {
    if (item.status !== "deleted") continue;
    try {
      await storage.discard(item.id);
    } catch {
      item.status = "cleanup_failed";
      item.code = "MEDIA_STORAGE_FAILED";
      item.message = "媒体文件已不可访问，受管目录清理失败，服务重启时将重新清理";
    }
  }
  return { results };
}

type Pending = {
  agentId: string;
  sessionId: string;
  prompt: MediaDeletePrompt;
  settle(error?: DomainError): void;
};

/** 仅已登录工作台的决定可恢复等待中的工具调用。重启、停止或过期均使确认失效。 */
export class MediaDeleteConfirmations {
  private readonly pending = new Map<string, Pending>();

  list(agentId: string, sessionId: string) {
    return [...this.pending.values()].filter(p => p.agentId === agentId && p.sessionId === sessionId)
      .map(p => p.prompt);
  }

  wait(agentId: string, sessionId: string, snapshot: Omit<MediaDeletePrompt, "id" | "expiresAt">, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const lifetime = 5 * 60_000;
    const prompt = { ...snapshot, id: randomUUID(), expiresAt: Date.now() + lifetime };
    return new Promise<void>((resolve, reject) => {
      const abort = () => settle(new DomainError("VALIDATION_FAILED", "会话已停止，媒体删除确认已取消"));
      const settle = (error?: DomainError) => {
        this.pending.delete(prompt.id);
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => settle(new DomainError("VALIDATION_FAILED", "媒体删除确认已过期")), lifetime);
      this.pending.set(prompt.id, { agentId, sessionId, prompt, settle });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  decide(agentId: string, sessionId: string, id: string, confirm: unknown) {
    if (typeof confirm !== "boolean") throw new DomainError("VALIDATION_FAILED", "媒体删除确认须为布尔值");
    const item = this.pending.get(id);
    if (!item || item.agentId !== agentId || item.sessionId !== sessionId || item.prompt.expiresAt <= Date.now())
      throw new DomainError("NOT_FOUND", "当前会话的媒体删除确认已失效");
    item.settle(confirm ? undefined : new DomainError("VALIDATION_FAILED", "用户已取消媒体文件删除"));
  }
}
