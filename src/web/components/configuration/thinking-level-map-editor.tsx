import { Checkbox } from "../../ui/choice";
import type { ThinkingLevelKey } from "../../../shared/configuration-contracts";

const levels: ThinkingLevelKey[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface ThinkingLevelMapEditorProps {
  value: Partial<Record<ThinkingLevelKey, string | null>>;
  onChange: (value: Partial<Record<ThinkingLevelKey, string | null>>) => void;
}

/**
 * 显式区分未覆盖映射与 null（模型不支持该等级）。
 */
export function ThinkingLevelMapEditor({ value, onChange }: ThinkingLevelMapEditorProps) {
  return (
    <section className="thinking-map" aria-label="思考等级映射">
      <header><strong>思考等级映射</strong><small>勾选“不支持”会写入 null</small></header>
      {levels.map((level) => (
        <div key={level}>
          <code>{level}</code>
          <input aria-label={`${level} 映射`} disabled={value[level] === null} value={value[level] ?? ""} placeholder="沿用默认" onChange={(event) => onChange({ ...value, [level]: event.target.value || undefined })} />
          <label><Checkbox checked={value[level] === null} onChange={(event) => onChange({ ...value, [level]: event.target.checked ? null : undefined })} />不支持</label>
        </div>
      ))}
    </section>
  );
}
