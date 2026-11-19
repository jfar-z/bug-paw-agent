import { createReadStream } from "node:fs";
import { readFile, stat, readdir, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { WorkflowFile, WorkflowDraft, WorkflowManagedFile } from "../../shared/workflow-contracts";
import { AigcAssetService } from "../aigc/aigc-asset-service";
import type { WorkspaceFileManager } from "../workspace-files";
import type { WorkspaceFileService } from "../attachments";
import { readJson, writeJsonAtomic } from "../storage";
import { DomainError } from "../core/errors";
import { workflowFileReferences } from "./workflow-file-references";
import { record } from "./workflow-validation";

interface StoredFile extends WorkflowFile {
  mediaPublicTransfer?: boolean;
  owner?: string;
  directory?: "runtime" | "constants";
  createdAt?: string;
  runId?: string;
  deletedAt?: string;
}
/** 工作流媒体有独立资产目录与归属；Agent 只能输入其工作区文件。 */
export class WorkflowFiles {
  private readonly assets: AigcAssetService;
  private readonly constants: AigcAssetService;
  constructor(
    private readonly directory: string,
    private readonly workspace: WorkspaceFileManager,
    private readonly files: WorkspaceFileService,
  ) {
    this.assets = new AigcAssetService(directory);
    this.constants = new AigcAssetService(join(directory, "constants"));
  }
  async upload(
    stream: Readable,
    name: string,
    mediaType: string,
    owner?: string,
    directory: "runtime" | "constants" = "runtime",
    runId?: string,
    mediaPublicTransfer?: boolean,
  ): Promise<WorkflowFile> {
    const assets = directory === "constants" ? this.constants : this.assets;
    const saved = await assets.saveInput(stream, name, mediaType);
    if ((stream as Readable & { truncated?: boolean }).truncated) {
      await assets.removeInput(saved.id);
      throw new DomainError(
        "INVALID_ATTACHMENT",
        "文件上传超过大小限制，未保存截断内容",
      );
    }
    const file: StoredFile = {
      assetId: saved.id,
      name: saved.name,
      mediaType: saved.mediaType,
      size: saved.size,
      mediaPublicTransfer, owner, directory, runId, createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(
      join(this.directory, "metadata", `${file.assetId}.json`),
      file,
    );
    return this.public(file);
  }
  /** 创建任务只读校验工作区文件，不写入运行资产目录。 */
  async inspectPath(agentId: string, path: string) {
    return this.workspace.readFile(agentId, path, 100 * 1024 * 1024);
  }
  async importPath(agentId: string, path: string): Promise<WorkflowFile> {
    const file = await this.workspace.readFile(
      agentId,
      path,
      100 * 1024 * 1024,
    );
    return this.upload(
      Readable.from(file.content),
      file.name,
      file.mediaType,
      agentId,
    );
  }
  /** 不信任调用方提交的文件名、类型或大小，始终读取资产元数据。 */
  async resolve(
    value: unknown,
    owner?: string,
  ): Promise<{ file: WorkflowFile; path: string; mediaPublicTransfer?: boolean }> {
    if (
      !record(value) ||
      typeof value.assetId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.assetId)
    )
      throw new DomainError("INVALID_ATTACHMENT", "工作流文件引用不合法");
    const stored = await readJson<StoredFile>(
      join(this.directory, "metadata", `${value.assetId}.json`),
    );
    if (!stored || stored.deletedAt || (owner !== undefined && stored.owner !== owner && stored.directory !== "constants"))
      throw new DomainError(
        "INVALID_ATTACHMENT",
        "工作流文件不存在或不属于当前 Agent",
      );
    const path = await (stored.directory === "constants" ? this.constants : this.assets).resolveInputPath(stored.assetId);
    if (!path)
      throw new DomainError("INVALID_ATTACHMENT", "工作流文件内容已不存在");
    return { file: this.public(stored), path, mediaPublicTransfer: stored.mediaPublicTransfer };
  }
  async buffer(
    value: unknown,
    owner?: string,
    limit = 100 * 1024 * 1024,
    publicTransfer = false,
  ): Promise<{ file: WorkflowFile; content: Buffer }> {
    const { file, path, mediaPublicTransfer } = await this.resolve(value, owner);
    if (publicTransfer && mediaPublicTransfer === false)
      throw new DomainError("FORBIDDEN", "该次执行未授权将媒体库副本用于公网传输");
    if ((await stat(path)).size > limit)
      throw new DomainError(
        "INVALID_ATTACHMENT",
        "工作流文件超过当前节点的大小限制",
      );
    return { file, content: await readFile(path) };
  }
  async toWorkspace(
    value: unknown,
    targetAgent: string,
    owner?: string,
  ): Promise<{ path: string; name: string; mediaType: string; size: number }> {
    const { file, path } = await this.resolve(value, owner);
    const saved = await this.files.saveUpload(
      targetAgent,
      file.name,
      file.mediaType,
      createReadStream(path),
    );
    return {
      path: saved.path,
      name: saved.name,
      mediaType: saved.mediaType,
      size: saved.size,
    };
  }
  /** 仅列出工作流自身资产；旧运行文件沿用原目录，无需移动业务数据。 */
  async inventory(): Promise<(WorkflowManagedFile & { runId?: string })[]> {
    let names: string[];
    try { names = await readdir(join(this.directory, "metadata")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: (WorkflowManagedFile & { runId?: string })[] = [];
    for (const name of names.filter((item) => /^[a-f0-9-]{36}\.json$/.test(item))) {
      const stored = await readJson<StoredFile>(join(this.directory, "metadata", name));
      if (!stored || stored.deletedAt) continue;
      const assets = stored.directory === "constants" ? this.constants : this.assets;
      const path = await assets.resolveInputPath(stored.assetId);
      if (!path) throw new DomainError("INVALID_ATTACHMENT", `工作流文件 ${stored.name} 的内容缺失`);
      const info = await stat(path);
      result.push({ ...this.public(stored), directory: stored.directory ?? "runtime", createdAt: stored.createdAt ?? info.mtime.toISOString(), runId: stored.runId, usages: [] });
    }
    return result;
  }
  /** 保存和启动前核实所有固定文件，禁止把运行资产写入常量定义。 */
  async checkReferences(definition: WorkflowDraft, inputs?: unknown): Promise<void> {
    for (const file of workflowFileReferences(definition.nodes).values()) {
      await this.resolve(file);
      const metadata = await readJson<StoredFile>(join(this.directory, "metadata", `${file.assetId}.json`));
      if (metadata?.directory !== "constants")
        throw new DomainError("VALIDATION_FAILED", `固定文件 ${file.name} 必须从文件常量目录选择或重新上传`);
    }
    for (const file of workflowFileReferences(inputs).values()) await this.resolve(file);
  }
  /** 文本预览有界读取，二进制内容不作为文本输出。 */
  async text(id: string): Promise<{ path: string; content: string; truncated: boolean }> {
    const {file, path} = await this.resolve({assetId: id});
    if (!/^text\//.test(file.mediaType) && !/^(application\/(json|xml|javascript))$/.test(file.mediaType) && !/\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(file.name))
      throw new DomainError("TEXT_PREVIEW_UNAVAILABLE", "该文件类型不支持文本预览，请下载查看");
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(512 * 1024);
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) throw new DomainError("TEXT_PREVIEW_UNAVAILABLE", "该文件包含二进制内容，请下载查看");
      return {path: id, content: buffer.subarray(0, bytesRead).toString("utf8"), truncated: file.size > bytesRead};
    } finally { await handle.close(); }
  }
  /** 删除保留元数据墓碑，使运行历史可以明确展示文件已删除。 */
  async remove(id: string): Promise<void> {
    this.checkId(id);
    const path = join(this.directory, "metadata", `${id}.json`);
    const metadata = await readJson<StoredFile>(path);
    if (!metadata) throw new DomainError("NOT_FOUND", "工作流文件不存在");
    const assets = metadata.directory === "constants" ? this.constants : this.assets;
    const content = await assets.resolveInputPath(id);
    if (content) await rm(content);
    await writeJsonAtomic(path, { ...metadata, deletedAt: new Date().toISOString() });
  }
  /** 克隆运行详情后附加删除标记，不修改历史快照和输入输出记录。 */
  async annotateDeleted<T>(value: T): Promise<T> {
    const copy = structuredClone(value);
    const deleted = new Set<string>();
    for (const file of workflowFileReferences(copy).values()) {
      this.checkId(file.assetId);
      const stored = await readJson<StoredFile>(join(this.directory, "metadata", `${file.assetId}.json`));
      if (!stored || stored.deletedAt) deleted.add(file.assetId);
    }
    // 一次遍历覆盖同一资产的所有历史引用，避免文件较多时重复扫描运行树。
    const mark = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) { item.forEach(mark); return; }
      const record = item as Record<string, unknown>;
      if (typeof record.assetId === "string" && deleted.has(record.assetId)) record.deleted = true;
      Object.values(record).forEach(mark);
    };
    mark(copy);
    return copy;
  }
  /** 所有管理入口只接受随机资产 ID，禁止目录穿越。 */
  private checkId(id: string): void {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new DomainError("INVALID_ATTACHMENT", "工作流文件引用不合法");
  }
  private public(file: StoredFile): WorkflowFile {
    return {
      assetId: file.assetId,
      name: file.name,
      mediaType: file.mediaType,
      size: file.size,
    };
  }
}
