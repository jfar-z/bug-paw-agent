import { useEffect, useRef, useState } from "react";
import {Dialog} from "./dialog";
import {Button} from "./controls";
import { useApiTask } from "../api-task-provider";
import { NAVIGATION_BEFORE_EVENT, navigateTo, type AppRoute, type NavigationBeforeEvent } from "../router";

interface UnsavedChangesOptions {
  /** 草稿是否偏离最近一次保存的值，包含凭证及高级参数。 */
  dirty: boolean;
  /** 页面保存期间不允许切换，避免异步响应写回其他对象。 */
  busy: boolean;
  /** 当前配置对象的可读名称，不包含凭证。 */
  label: string;
  /** 只有全部待保存项成功提交才返回 true。 */
  save: () => Promise<boolean>;
  /** 离线或无有效配置时禁用保存并切换。 */
  canSave?: boolean;
  /** 安装等一次性操作只允许继续输入或放弃，不提供保存并切换。 */
  discardOnly?: boolean;
  onDiscard?: () => void;
}

/** 统一保护配置对象切换、站内导航和浏览器离开，不持久化草稿密钥。 */
export function useUnsavedChanges(options: UnsavedChangesOptions) {
  const latest = useRef(options);
  latest.current = options;
  const bypass = useRef(false);
  const [pending, setPending] = useState<(() => void)>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { runApiTask } = useApiTask();

  function request(action: () => void) {
    if (latest.current.busy || saving) return;
    if (!latest.current.dirty) { action(); return; }
    setError("");
    setPending(() => action);
  }

  useEffect(() => {
    const beforeNavigation = (event: Event) => {
      if (bypass.current) return;
      if (!latest.current.dirty && !latest.current.busy) return;
      event.preventDefault();
      if (latest.current.busy) return;
      const navigation = event as NavigationBeforeEvent;
      setError("");
      setPending(() => navigation.resume ?? (() => navigateTo((event as CustomEvent<AppRoute>).detail)));
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.dirty && !latest.current.busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener(NAVIGATION_BEFORE_EVENT, beforeNavigation);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener(NAVIGATION_BEFORE_EVENT, beforeNavigation);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  function proceed() {
    if (!pending) return;
    bypass.current = true;
    const action = pending;
    setPending(undefined);
    action();
    window.queueMicrotask(() => { bypass.current = false; });
  }

  async function saveAndProceed() {
    if (saving || latest.current.busy) return;
    setSaving(true);
    setError("");
    try {
      const result = await runApiTask(latest.current.save, { operation: `切换前保存${latest.current.label}` });
      if (result.status === "success" && result.data) proceed();
      else setError(`“${latest.current.label}”尚未完成保存，修改已保留。请处理页面中的校验或错误提示后重试。`);
    } finally { setSaving(false); }
  }

  return {
    request,
    pending: Boolean(pending),
    dialog: pending ? <UnsavedChangesDialog label={options.label} error={error} busy={saving || options.busy} canSave={options.canSave !== false}
      onCancel={() => setPending(undefined)} discardOnly={options.discardOnly === true} onDiscard={() => { options.onDiscard?.(); proceed(); }} onSave={() => void saveAndProceed()} /> : null,
  };
}

/** 三个明确出口与焦点约束让用户可以安全决定如何处理当前草稿。 */
function UnsavedChangesDialog({ label, error, busy, canSave, discardOnly, onCancel, onDiscard, onSave }: {
  label: string; error: string; busy: boolean; canSave: boolean; discardOnly: boolean;
  onCancel: () => void; onDiscard: () => void; onSave: () => void;
}) {
  const title=discardOnly ? (label.includes("安装") ? "还有未提交的安装输入" : "还有未提交的输入") : "还有未保存的修改";
  return <Dialog title={title} busy={busy} onClose={onCancel} footer={<>
    <Button data-initial-focus disabled={busy} onClick={onCancel}>继续编辑</Button>
    <Button variant="danger" disabled={busy} onClick={onDiscard}>放弃并切换</Button>
    {!discardOnly && <Button variant="primary" disabled={busy || !canSave} onClick={onSave}>{busy ? "保存中…" : "保存并切换"}</Button>}
  </>}><p>{discardOnly ? `“${label}”尚未提交；放弃输入不会执行操作。` : `“${label}”尚未保存。切换前，请选择如何处理当前修改。`}</p>{error && <p role="alert">{error}</p>}</Dialog>;
}
