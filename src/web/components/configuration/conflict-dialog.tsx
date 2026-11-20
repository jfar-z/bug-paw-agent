import {Dialog} from "../../ui/dialog";
import {Button} from "../../ui/controls";

export interface ConfigurationDifference {
  field: string;
  local: unknown;
  disk: unknown;
}

interface ConflictDialogProps {
  differences: ConfigurationDifference[];
  onReload: () => void;
  onReapply: () => void;
}

/**
 * 展示 revision 冲突差异；刻意不提供跳过校验的强制覆盖入口。
 */
export function ConflictDialog({ differences, onReload, onReapply }: ConflictDialogProps) {
  return (
    <Dialog title="配置已在磁盘上发生变化" footer={<><Button onClick={onReload}>放弃修改并重新加载</Button><Button variant="primary" onClick={onReapply}>在新版本上重新应用</Button></>}>
      <p>请重新加载，或把本地字段应用到最新 revision 后再次校验。</p>
        <div className="conflict-differences">
          <div className="conflict-difference conflict-difference--heading"><strong>字段</strong><strong>本地修改</strong><strong>磁盘值</strong></div>
          {differences.map((difference) => <div className="conflict-difference" key={difference.field}><code>{difference.field}</code><span>{formatValue(difference.local)}</span><span>{formatValue(difference.disk)}</span></div>)}
        </div>
    </Dialog>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
