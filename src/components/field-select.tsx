import { useId, useState, type ComponentProps, type ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { cn } from "../lib/utils";

export type FieldSelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};
type FieldSelectProps = Pick<
  ComponentProps<typeof SelectTrigger>,
  | "id"
  | "aria-label"
  | "aria-labelledby"
  | "aria-describedby"
  | "aria-invalid"
  | "onBlur"
> & {
  options: readonly FieldSelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

/** A shared, keyboard-accessible select with the same surface as studio inputs. */
export function FieldSelect({
  options,
  value,
  defaultValue = "",
  onValueChange,
  placeholder = "Select an option…",
  disabled,
  className,
  ...triggerProps
}: FieldSelectProps) {
  const id = useId();
  const [localValue, setLocalValue] = useState(defaultValue);
  const selected = options.findIndex(
    (option) => option.value === (value ?? localValue),
  );
  // Encode item IDs so an empty string remains a real selectable application value.
  const itemValue = (index: number) => `${id}-option-${index}`;
  return (
    <Select
      value={selected < 0 ? "" : itemValue(selected)}
      disabled={disabled || options.length === 0}
      onValueChange={(encoded) => {
        const option = options.find((_, index) => itemValue(index) === encoded);
        if (!option || option.disabled) return;
        setLocalValue(option.value);
        onValueChange(option.value);
      }}
    >
      <SelectTrigger
        {...triggerProps}
        className={cn("field-select-trigger", className)}
      >
        <SelectValue
          placeholder={options.length ? placeholder : "No options available"}
        />
      </SelectTrigger>
      <SelectContent
        className="field-select-menu"
        position="popper"
        align="start"
        sideOffset={4}
        collisionPadding={12}
      >
        {options.map((option, index) => (
          <SelectItem
            key={option.value}
            value={itemValue(index)}
            disabled={option.disabled}
            className="field-select-option"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
