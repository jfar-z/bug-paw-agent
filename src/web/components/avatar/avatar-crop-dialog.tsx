import { Button } from "../../ui/controls";
import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Cropper, { type Area } from "react-easy-crop";

import type { AvatarCropArea } from "../../../shared/avatar-contracts";

export interface AvatarCropDialogProps {
  file: File;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onReplace(file: File): void;
  onConfirm(crop: AvatarCropArea): void;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const MOBILE_MEDIA_QUERY = "(max-width: 760px)";

/** 在桌面模态框或移动端全屏编辑器中完成固定 1:1 头像裁剪。 */
export function AvatarCropDialog({ file, busy, error, onCancel, onReplace, onConfirm }: AvatarCropDialogProps) {
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [cropArea, setCropArea] = useState<AvatarCropArea>();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [objectUrl, setObjectUrl] = useState("");
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const styles = cropDialogStyles(mobile);

  useEffect(() => {
    const nextObjectUrl = URL.createObjectURL(file);
    setObjectUrl(nextObjectUrl);
    return () => URL.revokeObjectURL(nextObjectUrl);
  }, [file]);

  useEffect(() => {
    setCropPosition({ x: 0, y: 0 });
    setZoom(1);
    setCropArea(undefined);
  }, [file]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const replaceFile = (event: ChangeEvent<HTMLInputElement>) => {
    const replacement = event.target.files?.[0];
    event.target.value = "";
    if (replacement) onReplace(replacement);
  };

  return (
    <div className="configuration-dialog-backdrop" role="presentation" style={styles.backdrop}>
      <section
        ref={dialogRef}
        className={`configuration-dialog${mobile ? " avatar-crop-dialog--mobile" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-crop-title"
        style={styles.dialog}
        onKeyDown={trapFocus}
      >
        <header style={styles.header}>
          <div>
            <h2 id="avatar-crop-title" style={styles.title}>调整头像</h2>
            <p style={styles.description}>拖动图片选择范围，使用滑杆缩放；上传后会自动压缩。</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="关闭头像裁剪"
            disabled={busy}
            style={styles.closeButton}
            onClick={onCancel}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div style={styles.body}>
          <div style={styles.editor}>
            <div aria-label="头像裁剪画布" style={styles.stage}>
              {objectUrl ? (
                <Cropper
                  image={objectUrl}
                  crop={cropPosition}
                  zoom={zoom}
                  aspect={1}
                  cropShape="rect"
                  showGrid
                  restrictPosition
                  roundCropAreaPixels
                  objectFit="contain"
                  style={{ cropAreaStyle: styles.cropArea }}
                  onCropChange={setCropPosition}
                  onZoomChange={setZoom}
                  onCropComplete={(area: Area) => setCropArea(toCropArea(area))}
                />
              ) : null}
            </div>
            <label style={styles.zoomControl}>
              <span>缩放</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                aria-label="头像缩放"
                style={styles.zoomInput}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
              <output style={styles.zoomOutput}>{Math.round(zoom * 100)}%</output>
            </label>
          </div>

          <aside aria-label="头像效果预览" style={styles.previewPanel}>
            <div style={styles.preview}>
              {objectUrl ? (
                <img
                  src={objectUrl}
                  alt="圆角方形头像预览"
                  style={{ ...styles.previewImage, ...previewStyle(cropArea) }}
                />
              ) : null}
            </div>
            <strong style={styles.previewTitle}>圆角方形头像</strong>
            <small style={styles.previewHelp}>透明 PNG 会保留透明通道，最终统一保存为 WebP。</small>
            <Button
              type="button"
              className="configuration-secondary-action"
              disabled={busy}
              style={styles.replaceButton}
              onClick={() => replaceInputRef.current?.click()}
            >
              <ImagePlus size={16} aria-hidden="true" />
              重新选择
            </Button>
            <input
              ref={replaceInputRef}
              className="visually-hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="重新选择头像"
              tabIndex={-1}
              disabled={busy}
              onChange={replaceFile}
            />
          </aside>
        </div>

        {error ? <div className="configuration-inline-error" role="alert">{error}</div> : null}

        <footer style={styles.footer}>
          <Button type="button" className="configuration-secondary-action" disabled={busy} style={styles.footerButton} onClick={onCancel}>取消</Button>
          <Button variant="primary"
            type="button"
            className="configuration-primary-action"
            disabled={busy || !cropArea}
            style={styles.footerButton}
            onClick={() => cropArea && onConfirm(cropArea)}
          >
            {busy ? "上传中…" : "裁剪并上传"}
          </Button>
        </footer>
      </section>
    </div>
  );
}

/** 订阅断点变化，使设备旋转后无需重开裁剪器即可更新布局。 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.(query);
    if (!mediaQuery) return undefined;
    const handleChange = () => setMatches(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener?.("change", handleChange);
    return () => mediaQuery.removeEventListener?.("change", handleChange);
  }, [query]);

  return matches;
}

function toCropArea(area: Area): AvatarCropArea {
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

/** 将裁剪器的孤立布局留在组件内，避免向全局样式表扩散专用选择器。 */
function cropDialogStyles(mobile: boolean): Record<string, CSSProperties> {
  const checkerSurface: CSSProperties = {
    position: "relative",
    aspectRatio: 1,
    overflow: "hidden",
    border: "1px solid var(--border-strong)",
    borderRadius: 12,
    background: "repeating-conic-gradient(var(--border) 0 25%, var(--surface-soft) 0 50%) 0 / 16px 16px",
  };
  return {
    backdrop: {
      zIndex: 120,
      display: mobile ? "block" : "grid",
      padding: mobile ? 0 : 20,
      background: mobile ? "var(--surface)" : "color-mix(in srgb, var(--canvas) 62%, transparent)",
      backdropFilter: mobile ? "none" : "blur(10px)",
    },
    dialog: {
      display: "grid",
      width: mobile ? "100%" : "min(880px, 100%)",
      minHeight: mobile ? "100dvh" : undefined,
      maxHeight: mobile ? "100dvh" : "calc(100dvh - 40px)",
      gridTemplateRows: mobile ? "auto minmax(0, 1fr) auto auto" : undefined,
      gap: mobile ? 14 : 18,
      padding: mobile ? "14px 16px calc(14px + env(safe-area-inset-bottom))" : 22,
      overflowY: "auto",
      overscrollBehavior: "contain",
      border: mobile ? 0 : undefined,
      borderRadius: mobile ? 0 : 14,
      boxShadow: mobile ? "none" : undefined,
    },
    header: { justifyContent: "space-between" },
    title: { fontSize: 20 },
    description: { display: mobile ? "none" : undefined, marginTop: 5, color: "var(--text-secondary)", fontSize: 12 },
    closeButton: { flex: "0 0 auto", width: 44, height: 44 },
    body: {
      display: "grid",
      gridTemplateColumns: mobile ? "1fr" : "minmax(0, 1fr) 220px",
      alignContent: mobile ? "start" : undefined,
      alignItems: mobile ? undefined : "center",
      gap: mobile ? 14 : 22,
    },
    editor: { display: "grid", minWidth: 0, gap: 14 },
    stage: {
      ...checkerSurface,
      width: mobile ? "min(100%, calc(100dvh - 330px))" : "min(100%, 560px)",
      minWidth: 0,
      margin: mobile ? "0 auto" : undefined,
      touchAction: "none",
    },
    cropArea: { borderRadius: 12, boxShadow: "0 0 0 9999em rgb(16 20 17 / 58%)" },
    zoomControl: {
      display: "grid",
      gridTemplateColumns: "auto minmax(0, 1fr) 46px",
      alignItems: "center",
      gap: 10,
      color: "var(--text-secondary)",
      fontSize: 12,
      fontWeight: 650,
    },
    zoomInput: { width: "100%", accentColor: "var(--accent)" },
    zoomOutput: { color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10, textAlign: "right" },
    previewPanel: mobile
      ? { display: "grid", gridTemplateColumns: "64px minmax(0, 1fr) auto", justifyItems: "start", gap: 10, textAlign: "left" }
      : { display: "grid", justifyItems: "center", gap: 10, textAlign: "center" },
    preview: {
      ...checkerSurface,
      width: mobile ? 64 : 156,
      gridRow: mobile ? "1 / 3" : undefined,
      borderRadius: mobile ? 8 : 12,
      boxShadow: "var(--shadow-soft)",
    },
    previewImage: { position: "absolute", display: "block", maxWidth: "none", userSelect: "none", pointerEvents: "none" },
    previewTitle: { alignSelf: mobile ? "end" : undefined },
    previewHelp: { display: mobile ? "none" : undefined, maxWidth: 210, color: "var(--text-tertiary)", fontSize: 11, lineHeight: 1.55 },
    replaceButton: {
      position: "relative",
      minHeight: 44,
      gridColumn: mobile ? 3 : undefined,
      gridRow: mobile ? "1 / 3" : undefined,
      alignSelf: mobile ? "center" : undefined,
      cursor: "pointer",
    },
    footer: {
      display: mobile ? "grid" : "flex",
      gridTemplateColumns: mobile ? "1fr 1fr" : undefined,
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 16,
      paddingTop: 16,
      borderTop: "1px solid var(--border)",
    },
    footerButton: { width: mobile ? "100%" : undefined, minWidth: mobile ? 0 : 112, minHeight: 44 },
  };
}

function previewStyle(crop: AvatarCropArea | undefined): React.CSSProperties {
  if (!crop) return { width: "100%", height: "100%", objectFit: "cover" };
  return {
    width: `${10000 / crop.width}%`,
    maxWidth: "none",
    height: "auto",
    left: `${-100 * crop.x / crop.width}%`,
    top: `${-100 * crop.y / crop.height}%`,
  };
}
