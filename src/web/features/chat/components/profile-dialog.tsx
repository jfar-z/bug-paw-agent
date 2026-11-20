import { Button } from "../../../ui/controls";
import { X } from "lucide-react";

interface ProfileDialogProps {
  open: boolean;
  displayName: string;
  saving: boolean;
  ready: boolean;
  avatarError?: string;
  onClose(): void;
  onDisplayNameChange(value: string): void;
  onAvatarSelected(file: File | undefined): void;
  onSave(): void;
}

/** 个人资料编辑弹层保持应用内确认交互，不使用浏览器原生弹窗。 */
export function ProfileDialog(props: ProfileDialogProps) {
  if (!props.open) return null;
  return <div className="archive-dialog__backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section className="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title">
      <header><div><span>个人资料</span><h2 id="profile-dialog-title">编辑个人资料</h2></div><button type="button" className="icon-button" aria-label="关闭个人资料" onClick={props.onClose}><X size={18} /></button></header>
      <div className="profile-dialog__form">
        <label><span>显示名</span><input aria-label="显示名" value={props.displayName} maxLength={64} onChange={(event) => props.onDisplayNameChange(event.target.value)} /></label>
        <label><span>头像图片</span><input aria-label="上传个人头像" type="file" accept="image/png,image/jpeg,image/webp" disabled={!props.ready || props.saving} onChange={(event) => { props.onAvatarSelected(event.target.files?.[0]); event.target.value = ""; }} /><small>PNG、JPEG 或 WebP，原图最大 20 MB；上传前可裁剪，系统将自动压缩。</small></label>
        {props.avatarError ? <p className="configuration-inline-error" role="alert">{props.avatarError}</p> : null}
        <Button variant="primary" type="button" className="configuration-primary-action" disabled={!props.ready || props.saving || !props.displayName.trim()} onClick={props.onSave}>保存显示名</Button>
      </div>
    </section>
  </div>;
}
