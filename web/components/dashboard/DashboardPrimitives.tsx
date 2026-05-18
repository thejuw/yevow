import type { ReactNode } from "react";
import type { DiagnosticCheck } from "@/lib/types";

const compact = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4
});

export function Metric({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="metric">
      <span>
        {icon}
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

export function DiagnosticRow({ check }: { check: DiagnosticCheck }) {
  return (
    <div className={`diagnostic-row ${check.status.toLowerCase()}`}>
      <code>{check.status}</code>
      <div>
        <strong>{check.label}</strong>
        <span>{check.detail}</span>
      </div>
    </div>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      {label}
      <div className="range-line">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <output>{compact.format(value)}</output>
      </div>
    </label>
  );
}
