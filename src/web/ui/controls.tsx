import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { LoaderCircle, X } from "lucide-react";
import "./controls.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
  icon?: ReactNode;
};

/** 忙碌时保留内容宽度，通过原生禁用阻止重复操作。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading,
      icon,
      disabled,
      children,
      className = "",
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || props["aria-busy"] || undefined}
        className={`bp-button bp-button--${variant} bp-button--${size} ${className}`}
      >
        <span className="bp-button__content">
          {icon}
          {children}
        </span>
        {loading && <LoaderCircle aria-hidden className="bp-button__spinner" />}
      </button>
    );
  },
);

export function IconButton({
  label,
  pressed,
  danger,
  children,
  ...props
}: ButtonProps & { label: string; pressed?: boolean; danger?: boolean }) {
  return (
    <Button
      {...props}
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={pressed}
      variant={danger ? "danger" : "ghost"}
      className={`bp-button--icon ${props.className ?? ""}`}
    >
      <span aria-hidden="true">{children}</span>
    </Button>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function TextField({ className = "", ...props }, ref) {
  return <input {...props} ref={ref} className={`bp-input ${className}`} />;
});
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={`bp-input bp-input--area ${className}`}
    />
  );
});
export function NumberField(props: InputHTMLAttributes<HTMLInputElement>) {
  return <TextField {...props} type="number" />;
}

/** 统一随输随搜和清除，重置后保持输入焦点。 */
export function SearchField({
  label,
  value,
  onChange,
  shortcut = false,
  placeholder = label,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  shortcut?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut) return;
    const focus = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !(event.target as Element)?.closest(
          "input,textarea,[contenteditable=true]",
        )
      ) {
        event.preventDefault();
        ref.current?.focus();
      }
    };
    document.addEventListener("keydown", focus);
    return () => document.removeEventListener("keydown", focus);
  }, [shortcut]);
  return (
    <div className={`bp-search ${className}`}>
      <TextField
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <IconButton
          label={"清除" + label}
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <X />
        </IconButton>
      )}
    </div>
  );
}
