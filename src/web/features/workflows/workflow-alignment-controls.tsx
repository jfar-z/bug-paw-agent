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
    <button key={key} type="button" className="wf-button" role="switch"
      aria-label={label} aria-checked={settings[key]}
      title={`${label}仅影响当前工作流；按住 Alt 临时取消吸附`}
      onClick={() => onChange({ ...settings, [key]: !settings[key] })}>
      {label} · {settings[key] ? '开' : '关'}
    </button>
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
    <select className="wf-alignment-actions" aria-label="对齐所选节点" value="" disabled={!canAlign}
      title={canAlign ? '按所选节点整体边界对齐' : '请选择至少两个已显示的节点'}
      onChange={(event) => onAlign(event.target.value as AlignmentAction)}>
      <option value="" disabled>对齐</option>
      <option value="left">左对齐</option>
      <option value="centerX">水平居中</option>
      <option value="right">右对齐</option>
      <option value="top">顶部对齐</option>
      <option value="centerY">垂直居中</option>
      <option value="bottom">底部对齐</option>
    </select>
  </>;
}
