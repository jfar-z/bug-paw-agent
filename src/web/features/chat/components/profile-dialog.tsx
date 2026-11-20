import { Button, TextField } from "../../../ui/controls";
import { Dialog } from "../../../ui/dialog";

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

/** 编辑显示名和头像，头像裁剪在独立步骤中完成。 */
export function ProfileDialog(props: ProfileDialogProps) {
  if (!props.open) return null;
  return <Dialog title="编辑个人资料" closeLabel="关闭个人资料" onClose={props.onClose} busy={props.saving}
    footer={<Button variant="primary" loading={props.saving} disabled={!props.ready || !props.displayName.trim()} onClick={props.onSave}>保存显示名</Button>}>
    <div className="profile-dialog__form">
      <label><span>显示名</span><TextField data-initial-focus aria-label="显示名" value={props.displayName} maxLength={64} onChange={(event) => props.onDisplayNameChange(event.target.value)} /></label>
      <label><span>头像图片</span><TextField aria-label="上传个人头像" type="file" accept="image/png,image/jpeg,image/webp" disabled={!props.ready || props.saving} onChange={(event) => { props.onAvatarSelected(event.target.files?.[0]); event.target.value = ""; }} /><small>PNG、JPEG 或 WebP，原图最大 20 MB；上传前可裁剪，系统将自动压缩。</small></label>
      {props.avatarError ? <p className="configuration-inline-error" role="alert">{props.avatarError}</p> : null}
    </div>
  </Dialog>;
}
