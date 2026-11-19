import { useEffect, useRef, useState } from "react";
import type { MediaDeletePrompt } from "../../../../shared/media-library-contracts";
import { api, ApiClientError } from "../../../api";
import { toUnexpectedErrorNotice } from "../../../api-error-policy";
import { MediaFileDeleteDialog } from "../../../components/media-file-delete-dialog";
import { useOnlineStatus } from "../../../use-online-status";
import "../../../configuration-dialog.css";

/** 每次挂载只处理一个会话的在途 Run，重连后以服务端清单为准。 */
export function ChatMediaDeleteConfirmation({ agentId, sessionId, onError }: {
  agentId: string;
  sessionId: string;
  onError: (error: { code: string; message: string }) => void;
}) {
  const online = useOnlineStatus();
  const [prompts, setPrompts] = useState<MediaDeletePrompt[]>([]);
  const [busy, setBusy] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const submitting = useRef(false);
  const settled = useRef(new Set<string>());
  const prompt = prompts[0];

  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);

  function report(error: unknown, operation: string) {
    const notice = toUnexpectedErrorNotice(error, operation);
    onError({ code: notice.code ?? "MEDIA_DELETE_CONFIRMATION_ERROR",
      message: [operation, notice.summary, notice.requestId].filter(Boolean).join(" · ") });
  }

  useEffect(() => {
    if (!online) return;
    const polling = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let reported = false;
    async function poll() {
      try {
        const result = await api.listMediaDeleteConfirmations(agentId, sessionId, polling.signal);
        if (polling.signal.aborted) return;
        setPrompts(result.confirmations.filter(({ id, expiresAt }) => !settled.current.has(id) && expiresAt > Date.now()));
        reported = false;
      } catch (error) {
        if (polling.signal.aborted) return;
        // 无法核对清单时撤下确认按钮，恢复后重新读取权威状态。
        setPrompts([]);
        if (!reported) report(error, "读取媒体删除确认");
        reported = true;
      }
      if (!polling.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { polling.abort(); clearTimeout(timer); };
  }, [agentId, sessionId, online, pollRevision, onError]);

  async function decide(confirm: boolean) {
    if (!online || !prompt || submitting.current || !controller.current) return;
    const { signal } = controller.current;
    submitting.current = true;
    setBusy(true);
    const dismiss = () => {
      settled.current.add(prompt.id);
      setPrompts((current) => current.filter(({ id }) => id !== prompt.id));
    };
    try {
      await api.decideMediaDelete(agentId, sessionId, prompt.id, confirm, signal);
      if (!signal.aborted) dismiss();
    } catch (error) {
      if (signal.aborted) return;
      report(error, confirm ? "提交媒体删除确认" : "取消媒体删除");
      if (error instanceof ApiClientError && error.status === 404) dismiss();
    } finally {
      submitting.current = false;
      if (!signal.aborted) {
        setBusy(false);
        setPollRevision((current) => current + 1);
      }
    }
  }

  return online && prompt ? <MediaFileDeleteDialog libraryName={prompt.libraryName} files={prompt.files}
    online={online} busy={busy} onCancel={() => void decide(false)} onConfirm={() => void decide(true)} /> : null;
}
