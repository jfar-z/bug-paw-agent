import type { WorkflowFilePage, WorkflowManagedFile, WorkflowRun } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
import { workflowFileReferences } from "./workflow-file-references";
import type { WorkflowFiles } from "./workflow-files";
import type { WorkflowService } from "./workflow-service";

/** 聚合真实资产和全部 DAG 引用，删除时与保存、启动共用锁。 */
export class WorkflowFileManager {
  constructor(private readonly files: WorkflowFiles, private readonly workflows: WorkflowService) {}

  /** 每个物理资产只出现一次，输入、节点产物和最终输出保留全部关联。 */
  private async inventory(): Promise<WorkflowManagedFile[]> {
    const inventory = await this.files.inventory();
    const byId = new Map(inventory.map((file) => [file.assetId, file]));
    const { definitions, runs } = this.workflows.fileUsageSnapshot();
    const add = (value: unknown, usage: WorkflowManagedFile["usages"][number], active = false) => {
      for (const id of workflowFileReferences(value).keys()) {
        const file = byId.get(id);
        if (!file) continue;
        if (!file.usages.some((item) => item.workflowId === usage.workflowId && item.runId === usage.runId && item.role === usage.role)) file.usages.push(usage);
        if (usage.role === "constant") file.blockedReason = "仍被工作流或运行快照引用";
        else if (active) file.blockedReason = "正在被运行中的任务使用";
      }
    };
    for (const definition of definitions) add(definition.nodes, {workflowId: definition.id, workflowName: definition.name, role: "constant"});
    const visit = (run: WorkflowRun, root: WorkflowRun) => {
      const usage = {workflowId: run.workflowId, workflowName: run.definition.name, runId: root.id};
      const active = ["prepared", "queued", "running"].includes(root.status);
      add(run.definition.nodes, {...usage, role: "constant"});
      for (const definition of Object.values(run.dependencies ?? {})) add(definition.nodes, {workflowId: definition.id, workflowName: definition.name, runId: root.id, role: "constant"});
      add(run.inputs, {...usage, role: "input"}, active);
      add(run.outputs, {...usage, role: "output"}, active);
      for (const node of run.nodes) {
        add(node.inputs, {...usage, role: "input"}, active);
        add(node.outputs, {...usage, role: "output"}, active);
        for (const child of node.children ?? []) visit(child, root);
      }
    };
    for (const run of runs) visit(run, run);
    // 刚生成的文件可能尚未写入节点结果，上传时记录的运行 ID 也必须参与保护。
    for (const file of inventory) if (file.runId) {
      const run = runs.find((item) => item.id === file.runId || hasRun(item, file.runId!));
      if (run && ["prepared", "queued", "running"].includes(run.status)) file.blockedReason = "正在被运行中的任务使用";
    }
    return inventory.map(({runId: _, ...file}) => file);
  }

  /** 过滤与分页在服务端执行，常量目录只返回常量资产。 */
  async list(query: Record<string, unknown>): Promise<WorkflowFilePage> {
    const directory = query.directory ?? "runtime";
    if (!["runtime", "constants"].includes(String(directory))) throw new DomainError("VALIDATION_FAILED", "文件目录必须为运行文件或文件常量");
    const page = Number(query.page ?? 1), size = Number(query.pageSize ?? 50);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) throw new DomainError("VALIDATION_FAILED", "文件分页参数无效，每页必须为 1 到 100 项");
    const all = await this.inventory();
    const workflows = new Map<string, string>();
    for (const file of all) for (const usage of file.usages) workflows.set(usage.workflowId, usage.workflowName);
    const keyword = String(query.q ?? "").toLocaleLowerCase();
    const filtered = all.filter((file) => file.directory === directory &&
      (!keyword || file.name.toLocaleLowerCase().includes(keyword)) &&
      // 组合条件必须命中同一条关联，不能把不同工作流或批次的用途拼接匹配。
      (!(query.workflowId || query.runId || query.role) || file.usages.some((usage) =>
        (!query.workflowId || usage.workflowId === query.workflowId) &&
        (!query.runId || usage.runId?.includes(String(query.runId))) &&
        (!query.role || usage.role === query.role))) &&
      (!query.type || (query.type === "file" ? !/^(image|audio|video)\//.test(file.mediaType) : file.mediaType.startsWith(`${query.type}/`))))
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.assetId.localeCompare(b.assetId));
    return {files: filtered.slice((page - 1) * size, page * size), total: filtered.length, page, workflows: [...workflows].map(([id,name]) => ({id,name}))};
  }

  /** 在共享临界区内清理指定目录，跳过实时引用和运行保护，不受分页限制。 */
  async clearDirectory(directory: unknown): Promise<{deleted: number; skipped: number}> {
    if (directory !== "runtime" && directory !== "constants") throw new DomainError("VALIDATION_FAILED", "清理目录必须为运行文件或文件常量");
    return this.workflows.withFileMutation(async () => {
      const files = (await this.inventory()).filter((file) => file.directory === directory);
      let deleted = 0, skipped = 0;
      for (const file of files) {
        if (file.blockedReason) { skipped++; continue; }
        await this.files.remove(file.assetId);
        deleted++;
      }
      return {deleted, skipped};
    });
  }

  /** 批量操作先检查全部引用，再精确删除；拒绝前端绕过不可选状态。 */
  async remove(ids: unknown): Promise<void> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) || new Set(ids).size !== ids.length)
      throw new DomainError("VALIDATION_FAILED", "请选择 1 到 100 个不重复的工作流文件");
    await this.workflows.withFileMutation(async () => {
      const inventory = new Map((await this.inventory()).map((file) => [file.assetId, file]));
      for (const id of ids) {
        const file = inventory.get(id);
        if (!file) throw new DomainError("NOT_FOUND", "所选工作流文件已不存在，请刷新列表");
        if (file.blockedReason) throw new DomainError("CONFLICT", `文件 ${file.name} ${file.blockedReason}，不能删除`);
      }
      for (const id of ids) await this.files.remove(id);
    });
  }
}
/** 运行 ID 可能属于循环或子工作流，保护整棵执行树中的新产物。 */
function hasRun(run: WorkflowRun, id: string): boolean {
  return run.id === id || run.nodes.some((node) => node.children?.some((child) => hasRun(child, id)));
}
