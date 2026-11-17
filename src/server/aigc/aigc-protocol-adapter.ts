import type {
  AigcChannelConfig,
  AigcInterfaceRecord,
  AigcTaskExecutionState,
  AigcTaskDiagnostics,
  AigcWorkflowDetail,
} from "../../shared/aigc-contracts";
import type { AigcAssetService } from "./aigc-asset-service";
import type { AigcPublicFileService } from "./aigc-public-file-service";
import type { AigcWorkflowService } from "./aigc-workflow-service";

export interface AigcExecutionInput {
  item: AigcInterfaceRecord;
  channel: AigcChannelConfig;
  apiKey?: string;
  inputs: Record<string, unknown>;
  assets: AigcAssetService;
  publicFiles?: AigcPublicFileService;
  workflows?: AigcWorkflowService;
  /** Agent 执行复核后的不可变 ComfyUI 定义，运行中不再读取新配置。 */
  workflowSnapshot?: AigcWorkflowDetail & { raw: unknown };
  signal: AbortSignal;
  /** 持久化脱敏诊断后再继续请求，避免失败丢失现场。 */
  onDiagnostics?: (patch: AigcTaskDiagnostics) => Promise<void>;
  /** 上报执行中的瞬态进度，调用方不得在此执行高频持久化。 */
  onProgress?: (state: AigcTaskExecutionState) => void;
  /** 报告精确任务取消的确认状态，不允许使用全局中断。 */
  onCancellation?: (status: "confirmed" | "unknown") => void;
}

export interface AigcExecutionAsset {
  name: string;
  mediaType: string;
  /** 对应 Agent 可见出参定义的稳定标识。 */
  outputId?: string;
  /** 对应 Agent 可见出参定义的展示名称。 */
  outputName?: string;
  content: Buffer;
}

export interface AigcExecutionResult {
  assets: AigcExecutionAsset[];
}

/** 统一协议适配器接口。 */
export interface AigcProtocolAdapter {
  execute(input: AigcExecutionInput): Promise<AigcExecutionResult>;
}
