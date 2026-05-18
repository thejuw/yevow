import { AlertTriangle, ChevronRight, CircleDot, Info } from "lucide-react";
import { PARAMETER_MATRIX, parameterHelp } from "@/lib/parameters";
import type { GlobalRiskConfig } from "@/lib/types";

type ParameterDescriptor = (typeof PARAMETER_MATRIX)[number];
type ConnectionStatus = "LOCKED" | "AUTHENTICATED" | "ERROR";

export function ParameterControl({
  param,
  value,
  onChange
}: {
  param: ParameterDescriptor;
  value: unknown;
  onChange: (value: string | number | boolean) => void;
}) {
  const help = parameterHelp(param);

  if (param.kind === "boolean") {
    return (
      <label className="param-control toggle-control">
        <span>{param.group}</span>
        <strong>
          {param.label}
          <InfoBadge text={help} />
        </strong>
        <input
          data-testid={`param-${String(param.key)}`}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  }

  if (param.kind === "select") {
    return (
      <label className="param-control">
        <span>{param.group}</span>
        <strong>
          {param.label}
          <InfoBadge text={help} />
        </strong>
        <select
          data-testid={`param-${String(param.key)}`}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          {param.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="param-control">
      <span>{param.group}</span>
      <strong>
        {param.label}
        <InfoBadge text={help} />
      </strong>
      <input
        data-testid={`param-${String(param.key)}`}
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={Number(value ?? 0)}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function InfoBadge({ text }: { text: string }) {
  return (
    <span className="info-badge" tabIndex={0}>
      <Info size={11} />
      <span className="info-popover">{text}</span>
    </span>
  );
}

export function ToggleField({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function NumberField({
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
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function StatusPill({ status }: { status: ConnectionStatus }) {
  return (
    <div className={`system-state ${status.toLowerCase()}`}>
      <CircleDot size={14} />
      <span>{status}</span>
    </div>
  );
}

export function Fault({ message }: { message: string }) {
  return (
    <div className="fault">
      <AlertTriangle size={16} />
      <span>{message}</span>
    </div>
  );
}

export function CommandMessage({ message }: { message: string }) {
  return (
    <div className="system-state">
      <ChevronRight size={14} />
      <span>{message}</span>
    </div>
  );
}

export function validateRiskDraft(
  draft: Partial<GlobalRiskConfig>,
  descriptors: Array<{
    kind: string;
    key: keyof GlobalRiskConfig;
    label: string;
    min?: number;
    max?: number;
  }>
): string | null {
  for (const descriptor of descriptors) {
    if (descriptor.kind !== "number" || !(descriptor.key in draft)) {
      continue;
    }

    const value = Number(draft[descriptor.key]);
    if (!Number.isFinite(value)) {
      return `${descriptor.label} must be a finite number.`;
    }
    if (descriptor.min !== undefined && value < descriptor.min) {
      return `${descriptor.label} must be greater than or equal to ${descriptor.min}.`;
    }
    if (descriptor.max !== undefined && value > descriptor.max) {
      return `${descriptor.label} must be less than or equal to ${descriptor.max}.`;
    }
  }

  return null;
}
