import { SearchSelect } from "../../ui/search-select";
import { BrainCircuit } from "lucide-react";
import type { ThinkingLevel } from "../../../shared/configuration-contracts";

const labels: Record<ThinkingLevel | "default", string> = {
  default: "模型默认", off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大",
};

/** 模型框右侧的强度图标，仅提供模型支持的等级并支持键盘选择。 */
export function WorkflowThinkingControl({ levels, value, disabled, onChange }: {
  levels: readonly ThinkingLevel[];
  value?: ThinkingLevel;
  disabled: boolean;
  onChange(value: ThinkingLevel | undefined): void;
}) {
  const selected = value ?? "default";
  const label = `思考强度：${labels[selected]}${disabled ? "；当前不可调整" : ""}`;

  const available: readonly (ThinkingLevel | "default")[] = ["default", ...levels];
  return <SearchSelect
    ariaLabel={label}
    listLabel="思考强度"
    triggerTitle={label}
    iconOnly
    placeholderIcon={<BrainCircuit size={18} />}
    searchable={false}
    disabled={disabled}
    value={selected}
    options={available.map((level) => ({
      value: level,
      label: labels[level],
    }))}
    onChange={(level) => {
      // 选择模型默认时省略请求中的思考强度，由模型配置决定。
      onChange(level === "default" ? undefined : level);
    }}
  />;
}
