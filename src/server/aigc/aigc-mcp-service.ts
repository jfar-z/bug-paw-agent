import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { AigcRunInputValue, AigcSingleRunInputValue, AigcTaskRecord } from "../../shared/aigc-contracts";
import type { Database } from "../database/database";
import { KeyedMutex } from "../core/keyed-mutex";
import { toSafePublicMessage } from "../core/errors";
import type { AigcAssetService } from "./aigc-asset-service";
import type { AigcConnectionService } from "./aigc-connection-service";
import type { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcPublicFileService } from "./aigc-public-file-service";
import type { AigcTaskService } from "./aigc-task-service";
import type { AigcWorkflowService } from "./aigc-workflow-service";
import { agentFields, agentOutputs, validateAgentParameters, type AigcAgentParameter } from "./aigc-agent-parameters";
import { DEFAULT_AIGC_AGENT_LIMITS, type AigcAgentLimits } from "./aigc-agent-limits";

export const MCP_OPERATIONS = ["list", "run", "get", "cancel", "upload", "download"] as const;
export type McpOperation = typeof MCP_OPERATIONS[number];
const MCP_INPUT_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-matroska",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac", "audio/ogg", "audio/mp4", "audio/aac",
]);

/** 对外只返回令牌元数据，令牌明文仅在创建时返回一次。 */
export interface AigcMcpClient {
  id: string;
  name: string;
  interfaceIds: string[];
  operations: McpOperation[];
  createdAt: string;
  revokedAt?: string;
}

interface ClientRow extends Record<string, unknown> {
  id: string; name: string; interface_ids_json: string; operations_json: string;
  created_at: string; revoked_at: string | null;
}

interface UploadRow extends Record<string, unknown> {
  id: string; client_id: string; name: string; media_type: string; size: number; created_at: string;
}

/** 外部客户端操作失败时返回稳定代码，避免泄露底层凭证。 */
export class AigcMcpError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** 令牌、上传及任务只以外部客户端 ID 作为安全边界。 */
export class AigcMcpService {
  private readonly lastQueries = new Map<string, number>();

  constructor(private readonly dependencies: {
    database: Database;
    interfaces: AigcInterfaceService;
    connections: AigcConnectionService;
    workflows: AigcWorkflowService;
    tasks: AigcTaskService;
    assets: AigcAssetService;
    publicFiles: AigcPublicFileService;
    publicOrigin?: string;
  }, private readonly lock: KeyedMutex = new KeyedMutex(),
  private readonly limits: Readonly<AigcAgentLimits> = DEFAULT_AIGC_AGENT_LIMITS) {}

  /** 管理员创建指定接口和操作范围的令牌。 */
  async create(input: { name: string; interfaceIds: string[]; operations: McpOperation[] }) {
    const name = await this.validateScope(input);
    const token = `bpmcp_${randomBytes(32).toString("base64url")}`;
    const client: AigcMcpClient = {
      id: randomUUID(), name, interfaceIds: input.interfaceIds,
      operations: input.operations, createdAt: new Date().toISOString(),
    };
    this.dependencies.database.write(
      "INSERT INTO aigc_mcp_clients(id,name,token_hash,interface_ids_json,operations_json,created_at) VALUES (?,?,?,?,?,?)",
      [client.id, name, hash(token), JSON.stringify(client.interfaceIds), JSON.stringify(client.operations), client.createdAt],
    );
    return { client, token };
  }

  /** 修改授权范围时保留原令牌，禁止恢复已撤销的客户端。 */
  async update(id: string, input: { name: string; interfaceIds: string[]; operations: McpOperation[] }): Promise<AigcMcpClient> {
    const name = await this.validateScope(input);
    const result = this.dependencies.database.write(
      "UPDATE aigc_mcp_clients SET name = ?, interface_ids_json = ?, operations_json = ? WHERE id = ? AND revoked_at IS NULL",
      [name, JSON.stringify(input.interfaceIds), JSON.stringify(input.operations), id],
    );
    if (!result.changes) throw new AigcMcpError("MCP_CLIENT_NOT_FOUND", "MCP 客户端不存在或已撤销");
    return this.currentClient(id);
  }

  /** 签发与编辑共用校验；未开放的历史接口可移除，但不可重新授权。 */
  private async validateScope(input: { name: string; interfaceIds: string[]; operations: McpOperation[] }): Promise<string> {
    const name = input.name?.trim();
    if (!name || name.length > 80 || !Array.isArray(input.interfaceIds) || input.interfaceIds.length < 1
      || input.interfaceIds.length > 100 || new Set(input.interfaceIds).size !== input.interfaceIds.length
      || !Array.isArray(input.operations) || input.operations.length < 1
      || new Set(input.operations).size !== input.operations.length
      || input.operations.some((operation) => !MCP_OPERATIONS.includes(operation))) {
      throw new TypeError("MCP 客户端名称、接口或操作范围无效");
    }
    for (const id of input.interfaceIds) {
      const item = await this.dependencies.interfaces.get(id);
      if (!item?.mcpPublishEnabled) throw new AigcMcpError("MCP_INTERFACE_UNAVAILABLE", "所选接口尚未开放给外部 MCP");
    }
    return name;
  }

  /** 每次操作读取最新权限，避免请求准备期间继续使用已移除的授权。 */
  private currentClient(id: string): AigcMcpClient {
    const row = this.dependencies.database.readOne<ClientRow>(
      "SELECT id,name,interface_ids_json,operations_json,created_at,revoked_at FROM aigc_mcp_clients WHERE id = ? AND revoked_at IS NULL", [id],
    );
    if (!row) throw new AigcMcpError("MCP_ACCESS_DENIED", "MCP 客户端未获授权或令牌已撤销");
    return toClient(row);
  }

  /** 列表绝不包含令牌明文或哈希。 */
  listClients(): AigcMcpClient[] {
    return this.dependencies.database.read<ClientRow>(
      "SELECT id,name,interface_ids_json,operations_json,created_at,revoked_at FROM aigc_mcp_clients ORDER BY created_at DESC",
    ).map(toClient);
  }

  /** 撤销即时生效，历史任务与产物保留给管理员查看。 */
  async revoke(id: string): Promise<void> {
    const result = this.dependencies.database.write(
      "UPDATE aigc_mcp_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      [new Date().toISOString(), id],
    );
    if (!result.changes) throw new AigcMcpError("MCP_CLIENT_NOT_FOUND", "MCP 客户端不存在或已撤销");
    await this.cleanupUploads(id, true);
  }

  /** 每次请求重新查询令牌状态，不缓存已撤销授权。 */
  authenticate(token: string | undefined): AigcMcpClient | undefined {
    if (!token || !/^bpmcp_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const row = this.dependencies.database.readOne<ClientRow>(
      "SELECT id,name,interface_ids_json,operations_json,created_at,revoked_at FROM aigc_mcp_clients WHERE token_hash = ? AND revoked_at IS NULL",
      [hash(token)],
    );
    return row ? toClient(row) : undefined;
  }

  /** 工具执行时再次核验客户端撤销状态及操作范围。 */
  private authorize(client: AigcMcpClient, operation: McpOperation): void {
    const current = this.currentClient(client.id);
    if (!current.operations.includes(operation)) {
      throw new AigcMcpError("MCP_ACCESS_DENIED", "MCP 客户端未获授权或令牌已撤销");
    }
    // 同步已认证请求的权限快照，后续接口检查只使用最新范围。
    client.interfaceIds = current.interfaceIds;
    client.operations = current.operations;
  }

  /** 同时检查令牌范围、接口开关及渠道状态。 */
  private async published(client: AigcMcpClient, interfaceId: string) {
    if (!this.currentClient(client.id).interfaceIds.includes(interfaceId)) throw new AigcMcpError("MCP_INTERFACE_UNAVAILABLE", "接口不在当前客户端授权范围内");
    const item = await this.dependencies.interfaces.get(interfaceId);
    const channel = item && (await this.dependencies.connections.read()).channels.find((candidate) => candidate.id === item.channelId);
    if (!item?.enabled || !item.mcpPublishEnabled || !channel?.enabled || channel.type !== item.protocol) {
      throw new AigcMcpError("MCP_INTERFACE_UNAVAILABLE", "接口不存在、未开放或渠道已停用");
    }
    const workflow = item.protocol === "comfyui"
      ? (await this.dependencies.workflows.get((item.config as { workflowId: string }).workflowId)).workflow : undefined;
    // 异步读取配置期间授权可能变化，返回接口前再次核验范围。
    if (!this.currentClient(client.id).interfaceIds.includes(interfaceId)) {
      throw new AigcMcpError("MCP_INTERFACE_UNAVAILABLE", "接口不在当前客户端授权范围内");
    }
    return { item, fields: agentFields(item, workflow), outputs: agentOutputs(item, workflow) };
  }

  /** 分页发现接口或查询真实 ID 的字段定义。 */
  async list(client: AigcMcpClient, input: { interfaceId?: string; offset?: number }) {
    this.authorize(client, "list");
    if (input.interfaceId) {
      const { item, fields, outputs } = await this.published(client, input.interfaceId);
      return { interfaces: [{ id: item.id, name: item.name, description: item.toolDescription || item.description,
        fields: fields.map((field) => field.source ? { ...field, source: "upload", description: `${field.description ?? "媒体输入"}；value 传 aigc_upload_input 返回的 inputId` } : field), outputs }] };
    }
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("分页起点无效");
    const available = [];
    for (const id of this.currentClient(client.id).interfaceIds) {
      try {
        const { item } = await this.published(client, id);
        available.push({ id: item.id, name: item.name, description: item.toolDescription || item.description, capability: item.capability });
      } catch (error) {
        if (!(error instanceof AigcMcpError) || error.code !== "MCP_INTERFACE_UNAVAILABLE") throw error;
      }
    }
    return { interfaces: available.slice(offset, offset + 20), total: available.length,
      ...(offset + 20 < available.length ? { nextOffset: offset + 20 } : {}) };
  }

  /** 上传文件绑定客户端，工具参数只接受其私有上传 ID。 */
  async upload(client: AigcMcpClient, stream: Readable, name: string, mediaType: string) {
    return this.lock.run(`uploads:${client.id}`, async () => {
      this.authorize(client, "upload");
      if (!MCP_INPUT_MEDIA_TYPES.has(mediaType.toLowerCase())) throw new TypeError("媒体类型不受支持，请上传常见图片、视频或音频格式");
      const unusedBytes = await this.cleanupUploads(client.id, false);
      if (unusedBytes >= 500 * 1024 * 1024) throw new AigcMcpError("MCP_UPLOAD_QUOTA_EXCEEDED", "未使用的输入文件已达到 500 MiB 限额");
      const asset = await this.dependencies.assets.saveInput(stream, name, mediaType);
      try {
        this.authorize(client, "upload");
        if (asset.size > 100 * 1024 * 1024) throw new TypeError("MCP 单个输入文件不能超过 100 MiB");
        if (unusedBytes + asset.size > 500 * 1024 * 1024) throw new AigcMcpError("MCP_UPLOAD_QUOTA_EXCEEDED", "未使用的输入文件已达到 500 MiB 限额");
        this.dependencies.database.write(
          "INSERT INTO aigc_mcp_uploads(id,client_id,name,media_type,size,created_at) VALUES (?,?,?,?,?,?)",
          [asset.id, client.id, asset.name, asset.mediaType, asset.size, new Date().toISOString()],
        );
        return { inputId: asset.id, name: asset.name, mediaType: asset.mediaType, size: asset.size };
      } catch (error) {
        await this.dependencies.assets.removeInput(asset.id);
        throw error;
      }
    });
  }

  /** 在提交锁中复用现有参数校验、任务引擎及计费任务幂等语义。 */
  async run(client: AigcMcpClient, input: { interfaceId: string; requestKey: string; parameters: AigcAgentParameter[] }) {
    return this.lock.run("submissions", async () => {
      this.authorize(client, "run");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.requestKey)) throw new TypeError("requestKey 格式无效");
      const { item, fields } = await this.published(client, input.interfaceId);
      const values = validateAgentParameters(fields, input.parameters);
      if (item.protocol === "grok" && values.size !== undefined && !/^\d{2,5}x\d{2,5}$/.test(String(values.size))) {
        throw new TypeError("size 必须使用 WIDTHxHEIGHT 格式");
      }
      const requestHash = hash(JSON.stringify([item.id, Object.entries(values).sort(([a], [b]) => a.localeCompare(b))]));
      const records = await this.dependencies.tasks.listRecords();
      const previous = records.find((task) => task.mcpOrigin?.clientId === client.id && task.mcpOrigin.requestKey === input.requestKey);
      if (previous) {
        if (previous.mcpOrigin?.requestHash !== requestHash) throw new AigcMcpError("MCP_IDEMPOTENCY_CONFLICT", "相同 requestKey 的参数已改变");
        return summary(previous);
      }
      const prepared: Record<string, AigcRunInputValue> = Object.create(null);
      const publicUploads: string[] = [];
      try {
        let mediaBytes = 0;
        for (const field of fields) {
          const value = values[field.name];
          if (value === undefined) continue;
          if (!field.source) { prepared[field.name] = value as AigcSingleRunInputValue; continue; }
          const references: AigcSingleRunInputValue[] = [];
          for (const inputId of Array.isArray(value) ? value : [value]) {
            const upload = this.dependencies.database.readOne<UploadRow>(
              "SELECT id,client_id,name,media_type,size,created_at FROM aigc_mcp_uploads WHERE id = ? AND client_id = ?",
              [String(inputId), client.id],
            );
            if (!upload || Date.now() - Date.parse(upload.created_at) >= 24 * 60 * 60_000
              || !upload.media_type.startsWith(`${field.type}/`) || !await this.dependencies.assets.resolveInputPath(upload.id)) {
              throw new AigcMcpError("MCP_INPUT_NOT_FOUND", `参数 ${field.name} 的 inputId 不存在或媒体类型不匹配`);
            }
            mediaBytes += upload.size;
            if (mediaBytes > 200 * 1024 * 1024) throw new TypeError("单任务媒体入参不能超过 200 MiB");
            if (item.protocol === "grok") {
              const publicOrigin = normalizePublicOrigin(this.dependencies.publicOrigin);
              if (!publicOrigin) throw new AigcMcpError("MCP_PUBLIC_ORIGIN_UNAVAILABLE", "Grok 媒体输入需要配置 BUG_PAW_PUBLIC_ORIGIN");
              const path = await this.dependencies.assets.resolveInputPath(upload.id);
              const { createReadStream } = await import("node:fs");
              const saved = await this.dependencies.publicFiles.save(createReadStream(path!), `mcp-${randomUUID()}-${upload.name}`, upload.media_type);
              publicUploads.push(saved.id);
              references.push(`${publicOrigin}/aigc-public/files/${encodeURIComponent(saved.id)}`);
            } else references.push({ assetId: upload.id, name: upload.name, mediaType: upload.media_type });
          }
          prepared[field.name] = Array.isArray(value) ? references : references[0];
        }
        this.authorize(client, "run");
        const latest = await this.published(client, item.id);
        if (JSON.stringify(latest.item) !== JSON.stringify(item)) throw new AigcMcpError("MCP_INTERFACE_CHANGED", "文件准备期间接口配置已变化");
        // 发布配置读取完成后再检查操作权限，避免使用异步等待前的授权。
        this.authorize(client, "run");
        const task = await this.dependencies.tasks.createRun({ interfaceId: item.id, inputs: prepared }, undefined,
          { clientId: client.id, requestKey: input.requestKey, requestHash });
        return summary(task);
      } catch (error) {
        await Promise.all(publicUploads.map((id) => this.dependencies.publicFiles.remove(id)));
        throw error;
      }
    });
  }

  /** 只返回可经认证下载的产物引用，不复制到内部 Agent 工作区。 */
  async get(client: AigcMcpClient, taskId: string) {
    this.authorize(client, "get");
    const task = await this.owned(client, taskId);
    await this.published(client, task.interfaceId);
    const key = `${client.id}:${taskId}`;
    const now = Date.now();
    if (now - (this.lastQueries.get(key) ?? 0) < this.limits.queryIntervalMs) {
      throw new AigcMcpError("MCP_QUERY_TOO_FREQUENT", `任务查询间隔至少 ${this.limits.queryIntervalMs / 1_000} 秒`);
    }
    this.lastQueries.set(key, now);
    if (this.lastQueries.size > 1_000) this.lastQueries.delete(this.lastQueries.keys().next().value!);
    if (task.assets.length > 20 || task.assets.reduce((total, asset) => total + asset.size, 0) > 200 * 1024 * 1024) {
      throw new AigcMcpError("MCP_DELIVERY_LIMIT", "产物超过 20 个或总量超过 200 MiB，请在 AIGC 工作台查看");
    }
    return { ...summary(task), files: task.status === "succeeded" ? task.assets.map((asset) => ({
      id: asset.id, name: asset.name, mediaType: asset.mediaType, size: asset.size,
      outputId: asset.outputId ?? "result", outputName: asset.outputName ?? "result",
      downloadPath: `/api/v1/aigc/mcp/tasks/${encodeURIComponent(task.id)}/assets/${encodeURIComponent(asset.id)}`,
    })) : [] };
  }

  /** 下载时重新检查令牌、任务归属、接口发布和产物 ID。 */
  async output(client: AigcMcpClient, taskId: string, assetId: string) {
    this.authorize(client, "download");
    const task = await this.owned(client, taskId);
    await this.published(client, task.interfaceId);
    if (task.status !== "succeeded") throw new AigcMcpError("MCP_ASSET_NOT_FOUND", "任务产物尚不可用");
    const asset = task.assets.find((item) => item.id === assetId);
    const path = asset && await this.dependencies.assets.resolveOutputPath(task.id, asset.id);
    if (!asset || !path) throw new AigcMcpError("MCP_ASSET_NOT_FOUND", "任务产物不存在");
    return { asset, path };
  }

  /** MCP-only 客户端可直接读取最多 8 MiB 的产物。 */
  async readSmallOutput(client: AigcMcpClient, taskId: string, assetId: string) {
    const { asset } = await this.output(client, taskId, assetId);
    if (asset.size > 8 * 1024 * 1024) throw new AigcMcpError("MCP_ASSET_TOO_LARGE", "产物超过 8 MiB，请使用经认证的下载路径");
    const content = await this.dependencies.assets.readOutput(taskId, assetId, 8 * 1024 * 1024);
    return { id: asset.id, name: asset.name, mediaType: asset.mediaType, size: asset.size, base64: content.toString("base64") };
  }

  /** 仅允许任务所有者取消已有任务。 */
  async cancel(client: AigcMcpClient, taskId: string) {
    this.authorize(client, "cancel");
    const task = await this.owned(client, taskId);
    if (task.status === "cancelled") return summary(task);
    if (!["queued", "running"].includes(task.status)) throw new AigcMcpError("MCP_NOT_CANCELLABLE", "任务已结束，不能取消");
    return summary((await this.dependencies.tasks.cancel(task.id))!);
  }

  private async owned(client: AigcMcpClient, taskId: string) {
    const task = await this.dependencies.tasks.get(taskId);
    if (!task || task.mcpOrigin?.clientId !== client.id) throw new AigcMcpError("MCP_TASK_NOT_FOUND", "任务不存在或不属于当前客户端");
    return task;
  }

  /** 清理过期或已撤销客户端的孤立输入，保留任务历史引用。 */
  private async cleanupUploads(clientId: string, allUnused: boolean): Promise<number> {
    const records = await this.dependencies.tasks.listRecords();
    const referenced = new Set(records.flatMap((task) => Object.values(task.inputs).flatMap((value) =>
      (Array.isArray(value) ? value : [value]).flatMap((entry) =>
        entry && typeof entry === "object" && "assetId" in entry && typeof entry.assetId === "string" ? [entry.assetId] : []))));
    const uploads = this.dependencies.database.read<UploadRow>(
      "SELECT id,client_id,name,media_type,size,created_at FROM aigc_mcp_uploads WHERE client_id = ?", [clientId],
    );
    let unusedBytes = 0;
    for (const upload of uploads) {
      if (referenced.has(upload.id)) continue;
      if (allUnused || Date.now() - Date.parse(upload.created_at) >= 24 * 60 * 60_000) {
        await this.dependencies.assets.removeInput(upload.id);
        this.dependencies.database.write("DELETE FROM aigc_mcp_uploads WHERE id = ? AND client_id = ?", [upload.id, clientId]);
      } else unusedBytes += upload.size;
    }
    return unusedBytes;
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function normalizePublicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new TypeError("BUG_PAW_PUBLIC_ORIGIN 必须是不含路径、凭据、查询参数或片段的 HTTP(S) Origin");
  }
  return url.origin;
}

function toClient(row: ClientRow): AigcMcpClient {
  return { id: row.id, name: row.name, interfaceIds: JSON.parse(row.interface_ids_json) as string[],
    operations: JSON.parse(row.operations_json) as McpOperation[], createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}) };
}

function summary(task: AigcTaskRecord) {
  return { taskId: task.id, interfaceId: task.interfaceId, status: task.status,
    ...(task.execution ? { progress: { phase: task.execution.phase, value: task.execution.progressValue,
      max: task.execution.progressMax, queueAhead: task.execution.queueAhead } } : {}),
    ...(task.error ? { error: { code: task.error.code,
      message: toSafePublicMessage(task.error.message, `AIGC 任务 ${task.id} 执行失败`) } } : {}),
    ...(task.status === "cancelled" ? { upstreamCancellation: task.upstreamCancellation ?? "unknown" } : {}),
    pollAfterMs: 5_000 };
}
