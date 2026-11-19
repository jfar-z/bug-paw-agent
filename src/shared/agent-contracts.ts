import type { TtsCustomParameters } from "./tts-custom-parameters";

/**
 * Agent 角色与行为的稳定系统指令分区。
 */
export interface AgentInstructions {
  role: string;
  behavior: string;
  rules: string;
  user: string;
}

/**
 * 自动生成会话标题时使用的模型与思考策略。
 */
export interface TitleGenerationConfig {
  modelSource: "session" | "system-default" | "custom";
  model?: { provider: string; id: string };
  thinkingEnabled: boolean;
}

/** 每个库独立授予浏览、写入和公开副本传输权限。 */
export interface MediaLibraryGrant {
  libraryId: string;
  read: boolean;
  upload: boolean;
  publicTransfer: boolean;
  delete?: boolean;
}

/**
 * 持久化 Agent Profile v1。
 */
export interface AgentProfile {
  version: 1;
  id: string;
  name: string;
  avatar: { kind: "initial"; value: string } | {
    kind: "image";
    revision: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  };
  description: string;
  status: "active" | "archived";
  cwd: string;
  defaultModel?: { provider: string; id: string };
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  titleGeneration?: TitleGenerationConfig;
  ttsProfileId?: string;
  /** 覆盖所选 TTS 配置默认音色的 Agent 级音色。 */
  ttsVoice?: string;
  /** 覆盖所选 TTS 配置请求体的 Agent 级自定义参数。 */
  ttsCustomParameters?: TtsCustomParameters;
  ttsAutoPlay?: boolean;
  ttsStreamPlayback?: boolean;
  instructions: AgentInstructions;
  allowedTools: string[];
  mediaLibraryGrants?: MediaLibraryGrant[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 带乐观锁版本的 Agent Profile。
 */
export interface AgentProfileDocument {
  profile: AgentProfile;
  revision: string;
}

/**
 * 创建 Agent 时允许浏览器提交的字段。
 */
export interface CreateAgentInput {
  name: string;
  cwd?: string;
  description?: string;
  avatar?: { kind: "initial"; value: string };
  defaultModel?: { provider: string; id: string };
  defaultThinkingLevel?: AgentProfile["defaultThinkingLevel"];
  titleGeneration?: TitleGenerationConfig;
  ttsProfileId?: string;
  ttsVoice?: string;
  ttsCustomParameters?: TtsCustomParameters;
  ttsAutoPlay?: boolean;
  ttsStreamPlayback?: boolean;
  allowedTools?: string[];
  mediaLibraryGrants?: MediaLibraryGrant[];
}

/**
 * 更新 Agent 时允许修改的字段。
 */
export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "name" | "avatar" | "defaultModel" | "defaultThinkingLevel" | "titleGeneration" | "ttsProfileId" | "ttsVoice" | "ttsCustomParameters">> & {
  name?: string;
  avatar?: AgentProfile["avatar"];
  defaultModel?: AgentProfile["defaultModel"] | null;
  defaultThinkingLevel?: AgentProfile["defaultThinkingLevel"] | null;
  titleGeneration?: AgentProfile["titleGeneration"] | null;
  ttsProfileId?: string | null;
  ttsVoice?: string | null;
  ttsCustomParameters?: TtsCustomParameters | null;
};
