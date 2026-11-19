import type { AgentInstructions, AgentProfile, CreateAgentInput, TitleGenerationConfig } from "../../shared/agent-contracts";
import { normalizeTtsCustomParameters } from "../../shared/tts-custom-parameters";
import { DEFAULT_AGENT_TOOL_NAMES } from "../../shared/tool-catalog";

/**
 * 默认的空角色指令分区。
 */
export const EMPTY_AGENT_INSTRUCTIONS: AgentInstructions = {
  role: "",
  behavior: "",
  rules: "",
  user: "",
};

interface LegacyAgentInstructions extends Partial<AgentInstructions> {
  principles?: string;
  prohibitions?: string;
  longTermDirection?: string;
}

/**
 * 把旧六分区角色指令无损归一化为新的四分区结构。
 *
 * @param value 磁盘或请求中的角色指令
 */
export function normalizeAgentInstructions(value: unknown): AgentInstructions {
  const source = typeof value === "object" && value !== null ? value as LegacyAgentInstructions : {};
  const role = typeof source.role === "string" ? source.role : "";
  const behavior = typeof source.behavior === "string" ? source.behavior : "";
  const user = typeof source.user === "string" ? source.user : "";
  const legacy = Object.prototype.hasOwnProperty.call(source, "principles") || Object.prototype.hasOwnProperty.call(source, "prohibitions");
  const rules = legacy
    ? [
        ["工作原则", source.principles],
        ["强制规则", source.rules],
        ["禁止事项", source.prohibitions],
      ]
        .filter((section): section is [string, string] => typeof section[1] === "string" && section[1].trim().length > 0)
        .map(([title, content]) => `## ${title}\n\n${content.trim()}`)
        .join("\n\n")
    : typeof source.rules === "string" ? source.rules : "";
  return { role, behavior, rules, user };
}

/**
 * 创建结构完整的 Agent Profile。
 *
 * @param id Agent 稳定标识
 * @param cwd 固定工作目录
 * @param input 用户可编辑字段
 * @param now ISO 创建时间
 */
export function createAgentProfile(id: string, cwd: string, input: CreateAgentInput, now: string): AgentProfile {
  const name = input.name.trim();
  const ttsVoice = input.ttsProfileId ? normalizeTtsVoice(input.ttsVoice) : undefined;
  const ttsCustomParameters = input.ttsProfileId
    ? normalizeTtsCustomParameters(input.ttsCustomParameters ?? {})
    : {};
  if (!name) {
    throw new TypeError("Agent 名称不能为空");
  }
  return {
    version: 1,
    id,
    name,
    avatar: input.avatar ?? { kind: "initial", value: name.slice(0, 1).toUpperCase() },
    description: input.description ?? "",
    status: "active",
    cwd,
    defaultModel: input.defaultModel,
    defaultThinkingLevel: input.defaultThinkingLevel,
    ...(input.titleGeneration ? { titleGeneration: normalizeTitleGeneration(input.titleGeneration) } : {}),
    ...(input.ttsProfileId ? {
      ttsProfileId: input.ttsProfileId,
      ...(ttsVoice ? { ttsVoice } : {}),
      ...(Object.keys(ttsCustomParameters).length > 0 ? { ttsCustomParameters } : {}),
      ttsAutoPlay: input.ttsAutoPlay === true,
      ttsStreamPlayback: input.ttsAutoPlay === true && input.ttsStreamPlayback === true,
    } : {}),
    // 长期提示词只由五个独立 Markdown 文件维护，新建 Agent 一律从空分区开始。
    instructions: { ...EMPTY_AGENT_INSTRUCTIONS },
    mediaLibraryGrants: input.mediaLibraryGrants ?? [],
    allowedTools: [...(input.allowedTools ?? DEFAULT_AGENT_TOOL_NAMES)],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 对磁盘 Profile 做必要结构校验。
 *
 * @param value 未知 JSON 值
 */
export function assertAgentProfile(value: unknown): asserts value is AgentProfile {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<AgentProfile>).version !== 1 ||
    typeof (value as Partial<AgentProfile>).id !== "string" ||
    typeof (value as Partial<AgentProfile>).cwd !== "string" ||
    typeof (value as Partial<AgentProfile>).name !== "string" ||
    !isTitleGenerationConfig((value as Partial<AgentProfile>).titleGeneration) ||
    ((value as Partial<AgentProfile>).ttsVoice !== undefined
      && typeof (value as Partial<AgentProfile>).ttsVoice !== "string") ||
    ((value as Partial<AgentProfile>).ttsCustomParameters !== undefined
      && (typeof (value as Partial<AgentProfile>).ttsCustomParameters !== "object"
        || (value as Partial<AgentProfile>).ttsCustomParameters === null
        || Array.isArray((value as Partial<AgentProfile>).ttsCustomParameters)))
  ) {
    throw new TypeError("Agent Profile 格式无效");
  }
}

/**
 * 规范化标题生成策略，避免非单独模型策略残留无效模型引用。
 *
 * @param value 标题生成策略
 */
export function normalizeTitleGeneration(value: TitleGenerationConfig): TitleGenerationConfig {
  if (value.modelSource === "custom" && (!value.model?.provider.trim() || !value.model.id.trim())) {
    throw new TypeError("单独标题模型不能为空");
  }
  return {
    modelSource: value.modelSource,
    ...(value.modelSource === "custom" ? { model: { provider: value.model!.provider, id: value.model!.id } } : {}),
    thinkingEnabled: value.thinkingEnabled === true,
  };
}

/**
 * 判断持久化的标题生成策略是否具有可接受结构。
 *
 * @param value 未知持久化字段
 */
function isTitleGenerationConfig(value: unknown): value is TitleGenerationConfig | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const source = value as Partial<TitleGenerationConfig>;
  if (source.modelSource !== "session" && source.modelSource !== "system-default" && source.modelSource !== "custom") return false;
  if (typeof source.thinkingEnabled !== "boolean") return false;
  if (source.modelSource !== "custom") return source.model === undefined;
  return typeof source.model?.provider === "string" && source.model.provider.trim().length > 0
    && typeof source.model.id === "string" && source.model.id.trim().length > 0;
}

/**
 * 规范化 Agent 级 TTS 音色覆盖。
 *
 * @param voice 用户提交的音色覆盖
 */
export function normalizeTtsVoice(voice: string | undefined): string | undefined {
  const normalized = voice?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 160) throw new TypeError("Agent 音色长度不能超过 160 个字符");
  return normalized;
}
