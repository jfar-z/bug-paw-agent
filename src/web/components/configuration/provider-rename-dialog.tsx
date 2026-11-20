import { Button } from "../../ui/controls";
import { ConfigurationEditorDialog } from "./configuration-editor-dialog";
import { useId, useState } from "react";

interface ProviderRenameDialogProps {
  currentId: string;
  busy: boolean;
  /** 改名失败时在当前确认框保留可定位错误。 */
  error?: string;
  onCancel: () => void;
  onConfirm: (targetId: string) => void;
}

function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

/**
 * 在应用内确认 Provider 改名及其引用迁移，避免使用浏览器原生提示框。
 */
export function ProviderRenameDialog({ currentId, busy, error, onCancel, onConfirm }: ProviderRenameDialogProps) {
  const formId = useId();
  const [targetId, setTargetId] = useState(currentId);
  const normalizedId = targetId.trim();
  const isValid = validProviderId(normalizedId);

  return <ConfigurationEditorDialog variant="confirmation" classPrefix="provider" returnFocusSelector="[data-provider-create]" title="重命名 Provider" description="将同步迁移 API Key、Agent 默认模型和会话中的 Provider 引用。" busy={busy} onClose={onCancel} footer={<><Button type="button" className="configuration-secondary-action" disabled={busy} onClick={onCancel}>取消</Button><Button variant="primary" type="submit" form={formId} className="configuration-primary-action" disabled={busy || !isValid || normalizedId === currentId}>{busy ? "改名中…" : "确认改名"}</Button></>}>
    <form id={formId} onSubmit={(event) => { event.preventDefault(); if (!busy && isValid && normalizedId !== currentId) onConfirm(normalizedId); }}>
        <label className="provider-rename-dialog__field" htmlFor="provider-rename-id">
          新的 Provider ID
          <input id="provider-rename-id" aria-label="新的 Provider ID" autoFocus value={targetId} onChange={(event) => setTargetId(event.target.value)} />
        </label>
        <small className="provider-rename-dialog__help" role={targetId.trim() && !isValid ? "alert" : undefined}>
          {targetId.trim() && !isValid ? "ID 只能使用字母、数字、点、下划线或连字符，且不能以符号开头或结尾。" : "仅支持字母、数字、点、下划线和连字符。"}
        </small>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
    </form>
  </ConfigurationEditorDialog>;
}
