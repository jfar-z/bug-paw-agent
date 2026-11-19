import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AgentProfile } from "../../shared/agent-contracts";
import { mediaReference, type MediaCategory } from "../../shared/media-library-contracts";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { WorkspaceFileManager } from "../workspace-files";
import { mediaName, type MediaRepository } from "./media-repository";
import type { MediaStorage } from "./media-storage";

export { isMediaReference, mediaReference } from "../../shared/media-library-contracts";

export function retainedName(original: string, requested?: string | null) {
  const name = mediaName(requested ?? original, true);
  if (extname(name).toLowerCase() !== extname(original).toLowerCase())
    throw new DomainError("VALIDATION_FAILED", "请保留源文件扩展名", { field: "name" });
  return name;
}

/** 在调用及接受任务时读取当前 Profile，执行数据由目标系统独立持有。 */
export class MediaAccess {
  constructor(private repo: MediaRepository, private storage: MediaStorage,
    private profile: (id: string) => Promise<AgentProfile | undefined>, private workspace: WorkspaceFileManager) {}

  private async grants(agentId: string) {
    const profile = await this.profile(agentId);
    if (!profile?.allowedTools.includes("media_library"))
      throw new DomainError("FORBIDDEN", "当前 Agent 未获媒体库工具权限");
    return profile.mediaLibraryGrants ?? [];
  }

  private async authorize(agentId: string, libraryId: string, action: "read" | "upload" | "publicTransfer") {
    if (!(await this.grants(agentId)).some(g => g.libraryId === libraryId && g[action] === true))
      throw new DomainError("FORBIDDEN", "当前 Agent 未获指定媒体库的" + ({ read: "读取", upload: "上传", publicTransfer: "公网传输" })[action] + "权限");
  }

  async libraries(agentId: string) {
    const grants = await this.grants(agentId);
    return this.repo.list().flatMap(({ id, name }) => {
      const grant = grants.find(g => g.libraryId === id && (g.read || g.upload));
      return grant ? [{ id, name, ...grant }] : [];
    });
  }

  async files(agentId: string, libraryId: string, category: MediaCategory | null) {
    await this.authorize(agentId, libraryId, "read");
    return this.repo.listFiles(libraryId, category ?? undefined).map(file => ({ ...file, reference: mediaReference(libraryId, file.id) }));
  }

  async describe(reference: string, field: string, type: string, agentId?: string, publish = false) {
    const match = /^media-library:\/\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(reference);
    if (!match) throw new DomainError("VALIDATION_FAILED", "参数 " + field + " 的媒体库引用无效", { field });
    try {
      if (agentId !== undefined) {
        await this.authorize(agentId, match[1], "read");
        if (publish) await this.authorize(agentId, match[1], "publicTransfer");
      }
      const file = this.repo.file(match[1], match[2]);
      if (type !== "file" && type !== file.category) throw new DomainError("VALIDATION_FAILED", "媒体类型不匹配");
      return file;
    } catch (error) {
      if (error instanceof DomainError) throw new DomainError(error.code, "参数 " + field + "：" + error.message, { field });
      throw error;
    }
  }

  async read(reference: string, field: string, type: string, agentId?: string, publish = false, preview = false) {
    const file = await this.describe(reference, field, type, agentId, publish);
    const resolved = await this.storage.resolve(file, preview);
    const content = await readFile(resolved.absolutePath);
    return { name: file.name, mediaType: resolved.mediaType, content };
  }

  async upload(agentId: string, libraryId: string, path: string, name: string | null) {
    await this.authorize(agentId, libraryId, "upload");
    return this.storage.withUpload(async () => {
      const file = await this.workspace.readFile(agentId, path, SYSTEM_LIMITS.mediaUploadBytes);
      return this.storage.save(libraryId, retainedName(file.name, name), file.content, () => this.authorize(agentId, libraryId, "upload"));
    });
  }
}
