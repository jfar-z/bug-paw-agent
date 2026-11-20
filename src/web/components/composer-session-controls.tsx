import { BrainCircuit, CircleOff } from "lucide-react";
import { SearchSelect } from "../ui/search-select";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/configuration-contracts";
import type { ModelSummary } from "../api";

interface ComposerSessionControlsProps {
  models: readonly ModelSummary[];
  selectedModel?: ModelSummary;
  thinkingLevel: ThinkingLevel;
  disabled?: boolean;
  onThinkingLevelChange(thinkingLevel: ThinkingLevel): void;
  onModelChange(model: ModelSummary): void;
}

/** 承载输入区会话级思考深度与模型选择。 */
export function ComposerSessionControls({
  models,
  selectedModel,
  thinkingLevel,
  disabled = false,
  onThinkingLevelChange,
  onModelChange,
}: ComposerSessionControlsProps) {
  const thinkingLevels = selectedModel?.thinkingLevels ?? THINKING_LEVELS;
  const thinkingUnavailable = thinkingLevels.length <= 1;
  const thinkingLabel = thinkingLevelLabels[thinkingLevel];
  const thinkingAriaLabel = thinkingUnavailable
    ? `思考深度：${thinkingLabel}；当前模型不支持调整`
    : `思考深度：${thinkingLabel}`;

  return <div className="composer-session-controls">
    <SearchSelect
      className="composer-thinking-control"
      ariaLabel={thinkingAriaLabel}
      listLabel="思考深度"
      triggerTitle={thinkingAriaLabel}
      iconOnly
      placeholderIcon={<BrainCircuit size={18} />}
      searchable={false}
      disabled={disabled || thinkingUnavailable}
      value={thinkingLevel}
      onChange={onThinkingLevelChange}
      options={thinkingLevels.map((level) => ({
        value: level,
        label: thinkingLevelLabels[level],
        description: level,
        ariaLabel: `${thinkingLevelLabels[level]} ${level}`,
        icon: level === "off" ? <CircleOff size={15} /> : <BrainCircuit size={15} />,
      }))}
    />
    <SearchSelect
      className="composer-model-control"
      ariaLabel={`切换模型，当前 ${selectedModel?.name ?? "未选择"}`}
      listLabel="可用模型"
      triggerTitle={selectedModel?.name}
      placeholder="选择模型"
      searchable={false}
      disabled={disabled || models.length === 0}
      value={selectedModel && modelKey(selectedModel)}
      options={models.map((model) => ({
        value: modelKey(model),
        label: model.name,
        description: `${model.provider} · ${model.id}`,
      }))}
      onChange={(value) => {
        const model = models.find((item) => modelKey(item) === value);
        if (model) onModelChange(model);
      }}
    />
  </div>;
}

const thinkingLevelLabels: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

/** 模型标识只在同一提供商内唯一。 */
function modelKey(model: ModelSummary): string {
  return JSON.stringify([model.provider, model.id]);
}
