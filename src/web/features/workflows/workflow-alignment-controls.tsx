import { Button } from "../../ui/controls";
import { SearchSelect } from "../../ui/search-select";
import type { WorkflowEditorSettings } from "../../../shared/workflow-contracts";
import type { AlignmentAction } from "./workflow-alignment";

/** 桌面直达开关，窄画布折叠设置；手动对齐与拖动辅助开关相互独立。 */
export function WorkflowAlignmentControls({ settings, onChange, canAlign, onAlign }: {
  settings: WorkflowEditorSettings;
  onChange: (settings: WorkflowEditorSettings) => void;
  canAlign: boolean;
  onAlign: (action: AlignmentAction) => void;
}) {
  const switches = ([['snapToGrid', '网格吸附'], ['snapToNodes', '节点对齐']] as const).map(([key, label]) => (
    <Button key={key} type="button" className="wf-button" role="switch"
      aria-label={label} aria-checked={settings[key]}
      title={`${label}仅影响当前工作流；按住 Alt 临时取消吸附`}
      onClick={() => onChange({ ...settings, [key]: !settings[key] })}>
      {label} · {settings[key] ? '开' : '关'}
    </Button>
  ));
  return <>
    <div className="wf-alignment-switches">{switches}</div>
    <details className="wf-alignment-settings" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }
    }}>
      <summary className="wf-button">画布设置</summary>
      <div>{switches}</div>
    </details>
    <SearchSelect className="wf-alignment-actions" ariaLabel="对齐所选节点" placeholder="对齐" disabled={!canAlign}
      onChange={onAlign}
      options={[
        { value: "left", label: "左对齐" },
        { value: "centerX", label: "水平居中" },
        { value: "right", label: "右对齐" },
        { value: "top", label: "顶部对齐" },
        { value: "centerY", label: "垂直居中" },
        { value: "bottom", label: "底部对齐" },
      ]}
    />
  </>;
}
