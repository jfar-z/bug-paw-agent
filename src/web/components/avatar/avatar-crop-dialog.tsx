import { Button, FilePickerButton } from "../../ui/controls";
import { Dialog } from "../../ui/dialog";
import { ImagePlus } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
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

const MOBILE_MEDIA_QUERY = "(max-width: 760px)";

/** 在桌面模态框或移动端全屏编辑器中完成固定 1:1 头像裁剪。 */
export function AvatarCropDialog({ file, busy, error, onCancel, onReplace, onConfirm }: AvatarCropDialogProps) {
  const [cropPosition, setCropPosition] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [cropArea, setCropArea] = useState<AvatarCropArea>();
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

  return (
    <Dialog title="调整头像" closeLabel="关闭头像裁剪" busy={busy} onClose={onCancel}
      dismissOnBackdrop={false} style={styles.dialog} bodyStyle={styles.scrollArea} footer={
        <div style={styles.footer}>
          <Button disabled={busy} style={styles.footerButton} onClick={onCancel}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!cropArea} style={styles.footerButton}
            onClick={() => cropArea && onConfirm(cropArea)}>裁剪并上传</Button>
        </div>
      }>
      <p style={styles.description}>拖动图片选择范围，使用滑杆缩放。上传后会自动压缩。</p>
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
          <FilePickerButton label="重新选择头像" className="configuration-secondary-action"
            disabled={busy} style={styles.replaceButton} accept="image/png,image/jpeg,image/webp"
            icon={<ImagePlus aria-hidden="true" />} onFilesSelected={([replacement]) => onReplace(replacement)}>
            重新选择
          </FilePickerButton>
        </aside>
      </div>

      {error ? <div className="configuration-inline-error" role="alert">{error}</div> : null}

    </Dialog>
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
    dialog: {
      width: mobile ? "100%" : 880,
      maxWidth: mobile ? "100%" : "calc(100vw - 40px)",
      height: mobile ? "100dvh" : undefined,
      maxHeight: mobile ? "100dvh" : "calc(100dvh - 40px)",
      padding: mobile ? "14px 16px calc(14px + env(safe-area-inset-bottom))" : 22,
      overscrollBehavior: "contain",
      border: mobile ? 0 : undefined,
      borderRadius: mobile ? 0 : 14,
      boxShadow: mobile ? "none" : undefined,
    },
    scrollArea: { maxHeight: mobile ? "calc(100dvh - 145px)" : "calc(100dvh - 206px)" },
    description: { display: mobile ? "none" : undefined, color: "var(--text-secondary)", fontSize: 12 },
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
      width: "100%",
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
