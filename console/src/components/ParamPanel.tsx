// Schema-driven parameter panel: renders any module's `sections`/`fields` into native
// controls and reports edits. Controlled — the parent owns the values object.
// See docs/v1.3/02-fields-and-registry.md.
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Section, Field, ParamValues, Module } from '../lib/registry';
import { defaultsOf } from '../lib/registry';
import { loadValues, saveValues } from '../lib/paramStore';

type Val = number | string | boolean;

// ---- per-field controls (styled to match the existing console controls) ----

function RangeField({ field, value, onChange }: {
  field: Extract<Field, { type: 'range' }>; value: number; onChange: (v: number) => void;
}) {
  const { min, max, step } = field;
  const def = Number(field.default);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const pct = ((value - min) / (max - min)) * 100;
  const isDefault = value === def;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-ink-300">{field.label}</span>
        <div className="flex items-center gap-2">
          <input type="number" value={value}
            onChange={(e) => onChange(clamp(parseFloat(e.target.value) || min))}
            className="w-20 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-right font-mono text-[13px] text-ink-100 outline-none focus:border-cyanx/50" />
          {field.unit && <span className="w-10 font-mono text-[10px] text-ink-500">{field.unit}</span>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1"
          style={{ '--thumb': '#0284c7', '--track': `linear-gradient(90deg, #0284c7 ${pct}%, #cbd5e1 ${pct}%)` } as React.CSSProperties} />
        <button onClick={() => onChange(def)}
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-mono transition-colors ${isDefault ? 'text-ink-600' : 'text-ink-400 hover:text-cyanx hover:bg-ink-800'}`}
          title={`Reset to default (${def})`}>⟲ {def}</button>
      </div>
    </div>
  );
}

// Uncontrolled (defaultValue + key) so mid-typing "-"/"1." isn't erased; `key`
// remounts it when the value changes externally (e.g. reset).
function NumberField({ field, value, onChange }: {
  field: Extract<Field, { type: 'number' }>; value: number; onChange: (v: number) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const min = field.min ?? -1e9, max = field.max ?? 1e9;
  const commit = () => {
    let n = parseFloat(ref.current?.value ?? '');
    if (isNaN(n)) n = value;
    onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[12px] font-medium text-ink-300">{field.label}</span>
      <div className="flex items-center rounded-lg border border-ink-700 bg-ink-850 focus-within:border-cyanx/50">
        <input key={value} ref={ref} type="text" inputMode="numeric" defaultValue={String(value)}
          onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="w-24 bg-transparent px-2 py-1.5 text-right font-mono text-[13px] text-ink-200 outline-none" />
        {field.unit && <span className="pr-2 text-[10px] text-ink-500 font-mono">{field.unit}</span>}
      </div>
    </label>
  );
}

function SelectField({ field, value, onChange }: {
  field: Extract<Field, { type: 'select' }>; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[12px] font-medium text-ink-300">{field.label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-[12px] text-ink-200 focus:outline-none focus:border-cyanx/50">
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ToggleField({ field, value, onChange }: {
  field: Extract<Field, { type: 'toggle' }>; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-[12px] font-medium text-ink-300">{field.label}</span>
      <button onClick={() => onChange(!value)}
        className={`relative h-5 w-9 rounded-full transition-colors ${value ? 'bg-cyanx' : 'bg-ink-700'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${value ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

function ColorField({ field, value, onChange }: {
  field: Extract<Field, { type: 'color' }>; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[12px] font-medium text-ink-300">{field.label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="h-7 w-12 rounded border border-ink-700 bg-ink-850 cursor-pointer" />
    </label>
  );
}

function TextField({ field, value, onChange }: {
  field: Extract<Field, { type: 'text' }>; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{field.label}</span>
      <input type="text" value={value} placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-ink-200 outline-none focus:border-cyanx/50" />
    </label>
  );
}

function renderField(field: Field, value: Val, onChange: (v: Val) => void) {
  switch (field.type) {
    case 'range':  return <RangeField  field={field} value={Number(value)}  onChange={onChange as (v: number) => void} />;
    case 'number': return <NumberField field={field} value={Number(value)}  onChange={onChange as (v: number) => void} />;
    case 'select': return <SelectField field={field} value={String(value)}  onChange={onChange as (v: string) => void} />;
    case 'toggle': return <ToggleField field={field} value={Boolean(value)} onChange={onChange as (v: boolean) => void} />;
    case 'color':  return <ColorField  field={field} value={String(value)}  onChange={onChange as (v: string) => void} />;
    case 'text':   return <TextField   field={field} value={String(value)}  onChange={onChange as (v: string) => void} />;
  }
}

export function ParamPanel({ sections, values, onChange }: {
  sections: Section[];
  values: ParamValues;
  onChange: (key: string, value: Val) => void;
}) {
  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{section.title}</p>
          <div className="space-y-3">
            {section.fields.map((f) => (
              <div key={f.key}>{renderField(f, values[f.key], (v) => onChange(f.key, v))}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Stateful values for a module, persisted to localStorage; reloads when the module changes. */
export function useModuleValues(mod: Module): {
  values: ParamValues;
  setValue: (key: string, value: Val) => void;
  reset: () => void;
} {
  const [values, setValues] = useState<ParamValues>(() => loadValues(mod));
  useEffect(() => { setValues(loadValues(mod)); }, [mod.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const setValue = useCallback((key: string, value: Val) => {
    setValues((prev) => { const next = { ...prev, [key]: value }; saveValues(mod.key, next); return next; });
  }, [mod.key]);
  const reset = useCallback(() => {
    const d = defaultsOf(mod); setValues(d); saveValues(mod.key, d);
  }, [mod.key]);
  return { values, setValue, reset };
}
