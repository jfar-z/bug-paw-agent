import { TextField, IconButton } from "./controls";
import "./secret-input.css";
import { Eye, EyeOff } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

interface SecretInputProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "type"
> {
  /** 当前字段是否展示明文。 */
  visible: boolean;
  /** 用户请求切换明文状态时通知页面。 */
  onVisibilityChange: (visible: boolean) => void;
  /** 用于生成输入框和开关按钮的无障碍名称。 */
  "aria-label": string;
}

/**
 * 提供统一的敏感输入显示控制，具体读取策略由页面决定。
 *
 * @param props 输入框值、可见性状态与标准输入属性
 */
export function SecretInput({
  visible,
  onVisibilityChange,
  "aria-label": label,
  ...inputProps
}: SecretInputProps) {
  return (
    <span className="bp-secret">
      <TextField
        {...inputProps}
        aria-label={label}
        type={visible ? "text" : "password"}
      />
      <IconButton
        type="button"
        label={`${visible ? "隐藏" : "显示"}${label}`}
        onClick={() => onVisibilityChange(!visible)}
      >
        {visible ? (
          <EyeOff size={18} aria-hidden="true" />
        ) : (
          <Eye size={18} aria-hidden="true" />
        )}
      </IconButton>
    </span>
  );
}
