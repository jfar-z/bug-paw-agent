import { useEffect } from "react";
import type { MediaFile } from "../../shared/media-library-contracts";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";
import { ConfirmDialog } from "../ui/dialog";

/** 工作台和对话共用确认清单，只展示本次确认覆盖的文件。 */
export function MediaFileDeleteDialog({ libraryName, files, busy, online, onCancel, onConfirm }: {
  libraryName: string;
  files: Pick<MediaFile, "id" | "name">[];
  busy: boolean;
  online: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const back = (event: Event) => {
      event.preventDefault();
      if (!busy) onCancel();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, back);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, back);
  }, [busy, onCancel]);

  return <ConfirmDialog title={"删除 " + files.length + " 个媒体文件"}
    description={"媒体库「" + libraryName + "」中的以下文件将永久删除，且无法恢复。"}
    confirmLabel="永久删除" confirmClassName="configuration-secondary-action configuration-secondary-action--danger"
    busy={busy} confirmDisabled={!online} onCancel={onCancel} onConfirm={onConfirm}>
    <ul>{files.map((file) => <li key={file.id}>{file.name}</li>)}</ul>
  </ConfirmDialog>;
}
