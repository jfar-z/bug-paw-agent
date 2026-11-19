import { readFile, stat } from "node:fs/promises";
import type { WorkflowRun } from "../../shared/workflow-contracts";
import type { AigcTaskService } from "../aigc/aigc-task-service";
import type { AigcAssetService } from "../aigc/aigc-asset-service";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { WorkflowService } from "../workflows/workflow-service";
import type { WorkflowFiles } from "../workflows/workflow-files";
import { workflowFileReferences } from "../workflows/workflow-file-references";
import { retainedName } from "./media-access";
import type { MediaStorage } from "./media-storage";

import type { SaveMediaResult } from "../../shared/media-library-contracts";

/** 只从指定运行的可读输出中查找，覆盖子工作流及循环内节点。 */
function hasOutput(run: WorkflowRun, id: string): boolean {
  return workflowFileReferences(run.outputs).has(id) || run.nodes.some(node =>
    workflowFileReferences(node.outputs).has(id) || node.children?.some(child => hasOutput(child, id)));
}

export class MediaResults {
  constructor(private storage: MediaStorage, private tasks: AigcTaskService, private assets: AigcAssetService,
    private workflows: WorkflowService, private files: WorkflowFiles) {}

  async save(libraryId: string, body: SaveMediaResult) {
    if (!body || typeof body.taskId !== "string" || typeof body.assetId !== "string")
      throw new DomainError("VALIDATION_FAILED", "请选择来源任务和具体媒体产物");
    return this.storage.withUpload(async () => {
      let name: string, path: string | undefined;
      if (body.source === "aigc") {
        const task = await this.tasks.get(body.taskId);
        const asset = task?.assets.find(item => item.id === body.assetId);
        if (!asset) throw new DomainError("NOT_FOUND", "指定任务没有该 AIGC 产物");
        name = asset.name;
        path = await this.assets.resolveOutputPath(body.taskId, asset.id);
      } else if (body.source === "workflow") {
        if (!hasOutput(this.workflows.getRun(body.taskId), body.assetId))
          throw new DomainError("NOT_FOUND", "指定工作流运行没有该输出文件");
        const resolved = await this.files.resolve({ assetId: body.assetId });
        name = resolved.file.name;
        path = resolved.path;
      } else throw new DomainError("VALIDATION_FAILED", "产物来源须为 aigc 或 workflow");
      if (!path) throw new DomainError("NOT_FOUND", "源媒体正文已清理");
      const target = retainedName(name, body.name);
      try {
        if ((await stat(path)).size > SYSTEM_LIMITS.mediaUploadBytes)
          throw new DomainError("MEDIA_UPLOAD_LIMIT", "每个媒体文件最大 50 MiB");
        return await this.storage.save(libraryId, target, await readFile(path));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new DomainError("NOT_FOUND", "源媒体正文已清理");
        throw cause;
      }
    });
  }
}
