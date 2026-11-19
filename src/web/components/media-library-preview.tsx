import { Minus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MediaFile } from "../../shared/media-library-contracts";
import { api } from "../api";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useErrorToast } from "../error-toast-provider";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";
import { ConfigurationEditorDialog } from "./configuration/configuration-editor-dialog";
import "./media-library-preview.css";

/** 原件仅在弹层打开时请求，卸载播放器即停止播放。 */
export function MediaPreview({ file, onClose, returnFocusSelector }: {
  file: MediaFile;
  onClose: () => void;
  returnFocusSelector?: string;
}) {
  const toast = useErrorToast();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  const source = api.mediaFileUrl(file.libraryId, file.id, "content");
  const playable = file.category !== "image";
  const fittedRatio = Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
  const ratio = zoom === 1 ? fittedRatio : zoom === 2 ? Math.max(1, fittedRatio * 2) : Math.max(2, fittedRatio * 4);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const media = player.current;
    const observer = new ResizeObserver(() => setViewport({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => {
      observer.disconnect();
      media?.pause();
    };
  }, []);

  useEffect(() => {
    const back = (event: Event) => { event.preventDefault(); onClose(); };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, back);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, back);
  }, [onClose]);

  function failed(media?: MediaError | null) {
    setState("error");
    const stage = media?.code === 3 || media?.code === 4 ? "解码或播放" : "读取原件";
    toast.push(toUnexpectedErrorNotice(new Error(stage + "未完成" + (media ? "（媒体错误 " + media.code + "）" : "")), "预览 " + file.name));
  }

  return <ConfigurationEditorDialog variant="confirmation" className="media-library-preview" title={file.name}
    description="媒体预览" busy={false} onClose={onClose} returnFocusSelector={returnFocusSelector}
    footer={<>
      {!playable && <div className="media-library-zoom" role="group" aria-label="图片缩放">
          <button type="button" className="icon-button" aria-label="缩小图片" disabled={zoom === 1 || state !== "ready"}
            onClick={() => setZoom(zoom - 1)}><Minus size={18} aria-hidden="true" /></button>
          <button type="button" className="configuration-secondary-action" disabled={zoom === 1} onClick={() => setZoom(1)}>
            {zoom === 1 ? "完整显示" : "恢复完整显示"}
          </button>
          <button type="button" className="icon-button" aria-label="放大图片" disabled={zoom === 3 || state !== "ready"}
            onClick={() => setZoom(zoom + 1)}><Plus size={18} aria-hidden="true" /></button>
      </div>}
      <button type="button" className="configuration-secondary-action" onClick={onClose}><X size={18} aria-hidden="true" />关闭预览</button>
    </>}>
    <div className={"media-library-preview__stage" + (!playable && zoom === 1 ? " is-fitted" : "")} ref={stage} tabIndex={zoom > 1 ? 0 : undefined}
      role="region" aria-label="媒体内容">
      {state === "loading" && <p role="status">正在读取媒体…</p>}
      {state === "error" ? <p role="alert">无法{playable ? "读取或播放" : "读取"}“{file.name}”。</p> : file.category === "image" ? (
        <img src={source} alt={file.name} className={state === "ready" ? "is-loaded" : undefined}
          style={natural.width && viewport.width ? { width: natural.width * ratio, height: natural.height * ratio } : undefined}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setNatural({ width: naturalWidth, height: naturalHeight });
            setState("ready");
          }} onError={() => failed()} />
      ) : file.category === "video" ? (
        <video ref={(element) => { player.current = element; }} src={source} controls playsInline preload="metadata" aria-label={file.name}
          onLoadedMetadata={() => setState("ready")} onError={(event) => failed(event.currentTarget.error)} />
      ) : <audio ref={(element) => { player.current = element; }} src={source} controls preload="metadata" aria-label={file.name}
        onLoadedMetadata={() => setState("ready")} onError={(event) => failed(event.currentTarget.error)} />}
    </div>
  </ConfigurationEditorDialog>;
}
