import { Button, IconButton } from "../ui/controls";
import { Archive } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { MediaCategory, MediaFile, MediaLibrary, SaveMediaResult } from "../../shared/media-library-contracts";
import { api, type ApiClientError } from "../api";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useApiTask } from "../api-task-provider";
import { useErrorToast } from "../error-toast-provider";
import { useOnlineStatus } from "../use-online-status";
const PickMediaDialog = lazy(() => import("./media-library-action-dialogs").then((module) => ({ default: module.PickMediaDialog })));
const SaveMediaDialog = lazy(() => import("./media-library-action-dialogs").then((module) => ({ default: module.SaveMediaDialog })));
const TransferDialog = lazy(() => import("./media-library-action-dialogs").then((module) => ({ default: module.MediaPublicTransferDialog })));

function MediaDialogFallback() {
  return <span role="status">正在打开媒体操作…</span>;
}

export type Catalog<T> = { status: "loading" } | { status: "error" } | { status: "ready"; items: T[] };

/** 在弹层和 Agent 配置中共用媒体库目录，读取失败时保留重试入口。 */
export function useMediaLibraries() {
  const { runApiTask } = useApiTask();
  const [catalog, setCatalog] = useState<Catalog<MediaLibrary>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void runApiTask(() => api.listMediaLibraries(controller.signal), { operation: "读取媒体库列表" }).then((result) => {
      if (!controller.signal.aborted) setCatalog(result.status === "success"
        ? { status: "ready", items: result.data.libraries }
        : { status: "error" });
    });
    return () => controller.abort();
  }, [attempt, runApiTask]);
  return { catalog, retry: () => { setCatalog({ status: "loading" }); setAttempt((count) => count + 1); } };
}

export function MediaLibraryCatalogStatus({ catalog, retry }: ReturnType<typeof useMediaLibraries>) {
  if (catalog.status === "loading") return <p role="status">正在读取媒体库…</p>;
  if (catalog.status === "error") return <Button type="button" className="configuration-secondary-action" onClick={retry}>重新读取媒体库</Button>;
  if (!catalog.items.length) return <p>暂无可选媒体库。<a href="/media-library">前往创建</a></p>;
  return null;
}

/** 选择只提交稳定标识给页面表单，真正读取原件由执行接口完成。 */
export function MediaLibraryPicker({ label, category, disabled, onSelect }: {
  label: string;
  category?: MediaCategory;
  disabled?: boolean;
  onSelect: (file: MediaFile) => void;
}) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" className="configuration-secondary-action" aria-label={`从媒体库选择 ${label}`}
      disabled={disabled || !online} onClick={() => setOpen(true)}>从媒体库选择</Button>
    {open && <Suspense fallback={<MediaDialogFallback />}><PickMediaDialog label={label} category={category} onClose={() => setOpen(false)}
      onSelect={(file) => { onSelect(file); setOpen(false); }} /></Suspense>}
  </>;
}

export type SaveTarget = Omit<SaveMediaResult, "name"> & { name: string; mediaType: string };

/** 归档入口对应单个产物。文件类型及是否仍可读取以保存接口复核为准。 */
export function SaveMediaResultButton({ target }: { target: SaveTarget }) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);
  if (!/^(image|audio|video)\//.test(target.mediaType)) return null;
  return <>
    <IconButton title="保存到媒体库" label={`保存到媒体库 ${target.name}`}
      disabled={!online} onClick={() => setOpen(true)}><Archive /></IconButton>
    {open && <Suspense fallback={<MediaDialogFallback />}><SaveMediaDialog key={target.assetId} target={target} onClose={() => setOpen(false)} /></Suspense>}
  </>;
}

/** 仅拦截服务端明确要求确认的业务分支，其余错误继续进入统一通知。 */
export function useMediaPublicTransfer(operation: string, onValidation?: (message: string) => void) {
  const toast = useErrorToast();
  const [message, setMessage] = useState("");
  const [missing, setMissing] = useState<{ field: string; message: string }>();
  return {
    message,
    missing,
    clear: () => setMessage(""),
    clearMissing: (field?: string) => setMissing((current) => !field || current?.field === field ? undefined : current),
    /** 失效引用只标记对应参数，保留表单草稿供用户重选。 */
    missingReference: (error: ApiClientError, hasMedia: (field: string) => boolean) => {
      const field = error.details?.field;
      if (typeof field === "string" && hasMedia(field)) {
        setMissing({ field, message: [error.message, error.code, error.requestId].filter(Boolean).join(" · ") });
      } else {
        toast.push(toUnexpectedErrorNotice(error, operation));
      }
    },
    validation: (error: ApiClientError) => {
      if (error.details?.requiresPublicTransfer === true) {
        setMessage(error.message);
        return;
      }
      onValidation?.(error.message);
      toast.push(toUnexpectedErrorNotice(error, operation));
    },
  };
}

export function MediaPublicTransferDialog(props: React.ComponentProps<typeof TransferDialog>) {
  return <Suspense fallback={<MediaDialogFallback />}><TransferDialog {...props} /></Suspense>;
}
