import { useId, type ReactNode } from "react";
import "./segmented-control.css";

/** 原生单选组提供方向键切换，并将选项类型传递给调用方。 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly { id: T; label: ReactNode }[];
  disabled?: boolean;
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="bp-segment">
      {options.map((option) => (
        <label key={option.id} className="bp-segment__option">
          <input
            type="radio"
            name={name}
            checked={value === option.id}
            disabled={disabled}
            onChange={() => onChange(option.id)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
