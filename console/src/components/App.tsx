import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  usePlotter,
  parseJsonScript,
  streamQueries,
  type ParsedLine,
  type PlotterBounds,
  type MotionParams,
  type FillMode,
  type PlotCmd,
  type PenState,
  type LogEntry,
  type PlotterStatus,
  type JobEntry,
  DEFAULTS,
  TRUCHET_MOTIF_NAMES,
  TRUCHET_DEFAULT_MASK,
} from '../hooks/usePlotter';
import { digestGcode, type PenMode, type PlaceMode, type GcodeResult } from '../lib/gcode';
import { decodeBgcode } from '../lib/bgcode';
import { compile } from '../lib/compile';
import { optimizeOrder, simplifyFrame, buildProgressPaths } from '../lib/toolpath';
import type { Frame } from '../lib/frame';
import { listModules, getModule, defaultsOf } from '../lib/registry';
import { evaluate, type Layer } from '../lib/pipeline';
import { loadImageToGray } from '../lib/image';
import type { GrayImage } from '../lib/registry';
import '../lib/modules';   // side effect: registers all generators/modifiers
import { ParamPanel } from './ParamPanel';

// ================================================================
//  Primitives
// ================================================================

// Remembers each card's collapsed state by title so a card you expanded stays
// expanded across tab switches (cards unmount when their tab is hidden; this
// module-scoped store persists across those remounts for the session).
const cardCollapse = new Map<string, boolean>();

// Crisp accordion chevron: points right when closed, smoothly rotates down when open.
function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`shrink-0 text-ink-500 transition-transform duration-200 ease-out ${open ? 'rotate-90' : ''}`}>
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

// "Queue this drawing" — icon-only play button with a soft green tint.
function DrawBtn({ onClick, title }: { onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title ?? 'Queue this drawing'} aria-label="Draw"
      className="inline-flex items-center justify-center rounded-lg border border-go/25 bg-go/10 px-2.5 py-1.5
        text-go/90 transition-colors hover:bg-go/20 hover:text-go active:scale-[.97]">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 4.5v15l13-7.5z" />
      </svg>
    </button>
  );
}

function Card({ title, icon, accent = '#0284c7', right, children, className = '',
  collapsible = true, defaultCollapsed = true, collapsed: collapsedProp, onToggle }: {
  title?: string; icon?: string; accent?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
  collapsible?: boolean; defaultCollapsed?: boolean;
  collapsed?: boolean; onToggle?: () => void;
}) {
  const isFlexCol = className.includes('flex-col');
  const key = title ?? '';
  const [collapsedState, setCollapsedState] = useState(
    () => (key && cardCollapse.has(key) ? cardCollapse.get(key)! : defaultCollapsed),
  );
  const controlled = collapsedProp !== undefined;
  const collapsed = controlled ? collapsedProp : collapsedState;
  const toggle = controlled ? onToggle : () => setCollapsedState((c) => {
    const next = !c;
    if (key) cardCollapse.set(key, next);   // remember across tab switches / remounts
    return next;
  });
  const isCollapsed = collapsible && collapsed;

  // Keep Tab inside the panel you're working in: cycle through the body fields and
  // the header action (the ▶ Draw button), wrapping around instead of escaping to
  // other panels. The collapse toggle is excluded; header actions come last so the
  // order reads fields → Draw → (wrap).
  const trapTab = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab') return;
    const root = e.currentTarget;
    const sel = 'a[href],button:not([disabled]):not([data-card-toggle]),input:not([disabled]),'
      + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    let nodes = Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) => el.offsetParent !== null);
    const head = root.querySelector('header');
    if (head) nodes = [...nodes.filter((el) => !head.contains(el)), ...nodes.filter((el) => head.contains(el))];
    if (nodes.length < 2) return;
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) return;   // focus isn't inside this panel yet — let it tab in normally
    e.preventDefault();
    const dir = e.shiftKey ? -1 : 1;
    nodes[(idx + dir + nodes.length) % nodes.length].focus();
  };

  return (
    <section onKeyDown={trapTab}
      className={`rounded-xl border border-ink-750 bg-ink-900 shadow-card ${isCollapsed ? '!flex-none' : ''} ${className}`}>
      {title && (
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-800 shrink-0">
          <button
            type="button"
            data-card-toggle
            onClick={collapsible ? toggle : undefined}
            disabled={!collapsible}
            className={`flex items-center gap-2 -mx-1 px-1 rounded ${collapsible ? 'cursor-pointer hover:text-ink-200' : 'cursor-default'}`}
          >
            {collapsible && (
              <Chevron open={!isCollapsed} />
            )}
            {icon && <span style={{ color: accent }} className="text-[13px]">{icon}</span>}
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">{title}</h2>
          </button>
          {right}
        </header>
      )}
      {!isCollapsed && (
        <div className={`p-4 ${isFlexCol ? 'flex flex-col flex-1 min-h-0' : ''}`}>{children}</div>
      )}
    </section>
  );
}

type LogSize = 'collapsed' | 'minimized' | 'expanded';
const LOG_SIZE_BTNS: { key: LogSize; label: string; hint: string }[] = [
  { key: 'collapsed', label: '×', hint: 'Collapse' },
  { key: 'minimized', label: '▬', hint: 'Minimized (100 px)' },
  { key: 'expanded', label: '⤢', hint: 'Expanded (500 px)' },
];

function LogCard({ title, icon, accent = '#0284c7', right, children, defaultSize = 'minimized' }: {
  title: string; icon?: string; accent?: string; right?: React.ReactNode; children: React.ReactNode;
  defaultSize?: LogSize;
}) {
  const [size, setSize] = useState<LogSize>(defaultSize);
  const contentH = size === 'minimized' ? 'h-[100px]' : 'h-[500px]';
  return (
    <section className="rounded-xl border border-ink-750 bg-ink-900 shadow-card">
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-800 shrink-0">
        <button
          type="button"
          onClick={() => setSize((s) => (s === 'collapsed' ? 'minimized' : 'collapsed'))}
          className="flex items-center gap-2 -mx-1 px-1 rounded cursor-pointer hover:text-ink-200"
        >
          <Chevron open={size !== 'collapsed'} />
          {icon && <span style={{ color: accent }} className="text-[13px]">{icon}</span>}
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">{title}</h2>
        </button>
        <div className="flex items-center gap-2">
          {right}
          <div className="flex gap-0.5 ml-1 border-l border-ink-800 pl-2">
            {LOG_SIZE_BTNS.map(({ key, label, hint }) => (
              <button key={key} onClick={() => setSize(key)} title={hint}
                className={`w-5 h-5 rounded text-[10px] font-mono transition-colors
                  ${size === key ? 'bg-ink-700 text-ink-200' : 'text-ink-600 hover:text-ink-300 hover:bg-ink-800'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {size !== 'collapsed' && (
        <div className={`${contentH} p-4 overflow-hidden flex flex-col`}>
          {children}
        </div>
      )}
    </section>
  );
}

type BtnVariant = 'default' | 'primary' | 'go' | 'ghost' | 'danger';
function Btn({ children, onClick, variant = 'default', disabled, className = '', title }: {
  children: React.ReactNode; onClick?: () => void; variant?: BtnVariant;
  disabled?: boolean; className?: string; title?: string;
}) {
  const styles: Record<BtnVariant, string> = {
    default: 'bg-ink-800 hover:bg-ink-750 border-ink-700 text-ink-300',
    primary: 'bg-cyanx/15 hover:bg-cyanx/25 border-cyanx/40 text-cyanx',
    go:      'bg-go/15 hover:bg-go/25 border-go/40 text-go',
    ghost:   'bg-transparent hover:bg-ink-800 border-ink-750 text-ink-400',
    danger:  'bg-stop/15 hover:bg-stop/25 border-stop/40 text-stop',
  };
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`px-3 py-1.5 rounded-lg border text-[13px] font-medium transition-colors active:scale-[.97] disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >{children}</button>
  );
}

// Compact icon-only run controls (live in the Job queue panel header).
function StopButton({ onClick, moving }: { onClick: () => void; moving: boolean }) {
  return (
    <button onClick={onClick} aria-label="Stop" title="Stop — halt now, keep the queue"
      className="relative flex h-7 w-7 items-center justify-center rounded-md border border-stop/55 bg-stop/15 text-stop hover:bg-stop/25 transition-colors active:scale-95">
      {moving && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-stop blink" />}
      <span className="h-2.5 w-2.5 bg-stop" style={{ borderRadius: 2 }} />
    </button>
  );
}

function ClearButton({ onClick, pending }: { onClick: () => void; pending: number }) {
  return (
    <button onClick={onClick} aria-label="Clear queue"
      title={`Clear the queue${pending > 0 ? ` (${pending} pending)` : ''} — discard all pending jobs`}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-ink-700 bg-ink-850 text-ink-400 hover:text-stop hover:bg-stop/15 transition-colors active:scale-95">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      </svg>
    </button>
  );
}

function PauseButton({ paused, onPause, onResume }: { paused: boolean; onPause: () => void; onResume: () => void }) {
  return (
    <button onClick={paused ? onResume : onPause} aria-label={paused ? 'Resume' : 'Pause'}
      title={paused ? 'Resume the held queue' : 'Pause after current job (keeps the queue) — swap pen / fix ink'}
      className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors active:scale-95 ${
        paused ? 'border-go/55 bg-go/15 text-go hover:bg-go/25'
               : 'border-warn/55 bg-warn/15 text-warn hover:bg-warn/25'}`}>
      {paused
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1" /><rect x="13.8" y="5" width="4.2" height="14" rx="1" /></svg>}
    </button>
  );
}

function StatusChip({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-750 bg-ink-850 pl-3 pr-3 py-1.5">
      <span className="relative flex h-2.5 w-2.5">
        {connected && <span className="absolute inline-flex h-full w-full rounded-full bg-go opacity-60" style={{ animation: 'pulse-ring 1.8s ease-out infinite' }} />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connected ? 'bg-go' : 'bg-stop'}`} />
      </span>
      <span className={`whitespace-nowrap font-mono text-[12px] ${connected ? 'text-go' : 'text-stop'}`}>
        {connected ? 'LINK UP' : 'LINK DOWN'}
      </span>
    </div>
  );
}

function ParamSlider({ label, value, onInput, onCommit, min, max, step, unit, def, accent = '#0284c7' }: {
  label: string; value: number; onInput: (v: number) => void; onCommit: (v: number) => void;
  min: number; max: number; step: number; unit: string; def: number; accent?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const isDefault = value === def;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-ink-300">{label}</span>
        <div className="flex items-center gap-2">
          <input type="number" value={value}
            onChange={(e) => onInput(Math.min(max, Math.max(min, parseFloat(e.target.value) || min)))}
            onBlur={(e) => onCommit(Math.min(max, Math.max(min, parseFloat(e.target.value) || min)))}
            className="w-24 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-right font-mono text-[13px] text-ink-100 outline-none focus:border-cyanx/50"
          />
          <span className="w-20 font-mono text-[10px] text-ink-500">{unit}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onInput(parseFloat(e.target.value))}
          onMouseUp={(e) => onCommit(parseFloat((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => onCommit(parseFloat((e.target as HTMLInputElement).value))}
          className="flex-1"
          style={{ '--thumb': accent, '--track': `linear-gradient(90deg, ${accent} ${pct}%, #cbd5e1 ${pct}%)` } as React.CSSProperties}
        />
        <button onClick={() => { onInput(def); onCommit(def); }}
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-mono transition-colors ${isDefault ? 'text-ink-600' : 'text-ink-400 hover:text-cyanx hover:bg-ink-800'}`}
          title={`Reset to default (${def})`}>⟲ {def}</button>
      </div>
    </div>
  );
}

// FieldInline is intentionally UNCONTROLLED (defaultValue + useRef, not value + useState).
// A controlled numeric input would re-render on every parent state change, which erases
// partial values like "-" or "1." mid-type and makes the field feel broken.
// Instead the DOM owns the string; we only read and validate it on blur/Enter.
function FieldInline({ label, value, onChange, unit, step = 1, min = -100000, max = 100000, title }: {
  label: string; value: number; onChange: (v: number) => void;
  unit?: string; step?: number; min?: number; max?: number; title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  const commit = () => {
    const raw = ref.current?.value ?? '';
    let n = parseFloat(raw);
    if (isNaN(n)) n = value;
    onChange(Math.min(max, Math.max(min, n)));
  };

  return (
    <div className="flex flex-col gap-1" title={title}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</span>
      <div className="flex items-center rounded-lg border border-ink-700 bg-ink-850 focus-within:border-cyanx/50 transition-colors">
        <input ref={ref} type="text" inputMode="numeric" defaultValue={String(value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'ArrowUp')   { onChange(Math.min(max, value + step)); if (ref.current) ref.current.value = String(value + step); }
            if (e.key === 'ArrowDown') { onChange(Math.max(min, value - step)); if (ref.current) ref.current.value = String(value - step); }
          }}
          className="min-w-0 w-full bg-transparent px-2 py-1.5 font-mono text-[13px] text-ink-200 outline-none"
        />
        {unit && <span className="pr-2 text-[10px] text-ink-500 font-mono">{unit}</span>}
      </div>
    </div>
  );
}

function FillPicker({ value, onChange }: { value: FillMode; onChange: (v: FillMode) => void }) {
  const opts: [FillMode, string][] = [[0, 'None'], [1, 'Hatch'], [2, 'Concentric']];
  return (
    <div>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 mb-1 block">Fill</span>
      <div className="flex rounded-lg border border-ink-700 bg-ink-900 p-0.5 gap-0.5">
        {opts.map(([v, lbl]) => (
          <button key={v} onClick={() => onChange(v)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${value === v ? 'bg-ink-700 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

function OutlineToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 mb-1 block">Outline</span>
      <div className="flex rounded-lg border border-ink-700 bg-ink-900 p-0.5 gap-0.5">
        {([true, false] as const).map((v) => (
          <button key={String(v)} onClick={() => onChange(v)}
            className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${value === v ? 'bg-ink-700 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>
            {v ? 'On' : 'Off'}
          </button>
        ))}
      </div>
    </div>
  );
}

function Readout({ label, value, unit }: { label: string; value: string | number; unit: string }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</div>
      <div className="font-mono text-[16px] text-ink-100">{value}<span className="ml-1 text-[10px] text-ink-500">{unit}</span></div>
    </div>
  );
}

// ================================================================
//  Canvas
// ================================================================

function PlotterCanvas({ bounds, pen, moving }: {
  bounds: PlotterBounds; pen: PenState; moving: boolean;
}) {
  const { left, right, up, down } = bounds;
  const pad = Math.max(20, (left + right) * 0.06);
  const vbX = -left - pad, vbY = -down - pad;
  const vbW = left + right + 2 * pad, vbH = up + down + 2 * pad;
  const py = (y: number) => y;  // +Y down in firmware and in display

  const gridStep = vbW > 800 ? 100 : 50;
  const gx: number[] = [], gy: number[] = [];
  for (let x = Math.ceil(-left / gridStep) * gridStep; x <= right; x += gridStep) gx.push(x);
  for (let y = Math.ceil(-down / gridStep) * gridStep; y <= up; y += gridStep) gy.push(y);

  const sw = vbW / 400;

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} className="w-full"
        style={{ aspectRatio: `${vbW} / ${vbH}`, display: 'block' }} preserveAspectRatio="xMidYMid meet">
        {bounds.shape === 'ellipse' ? (
          <>
            {/* faint bounding box (what the inputs edit) + the actual drawable ellipse */}
            <rect x={-left} y={-down} width={left + right} height={up + down}
              fill="none" stroke="#dce3ec" strokeWidth={sw} strokeDasharray={`${sw * 3} ${sw * 2}`} />
            <ellipse cx={(right - left) / 2} cy={(up - down) / 2} rx={(left + right) / 2} ry={(up + down) / 2}
              fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.5} />
          </>
        ) : (
          <rect x={-left} y={-down} width={left + right} height={up + down}
            fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.5} rx={sw} />
        )}
        {gx.map((x) => <line key={`gx${x}`} x1={x} y1={py(up)} x2={x} y2={py(-down)} stroke="#eef2f6" strokeWidth={sw * 0.6} />)}
        {gy.map((y) => <line key={`gy${y}`} x1={-left} y1={py(y)} x2={right} y2={py(y)} stroke="#eef2f6" strokeWidth={sw * 0.6} />)}
        <line x1={-left} y1={0} x2={right} y2={0} stroke="#cbd5e1" strokeWidth={sw} />
        <line x1={0} y1={py(up)} x2={0} y2={py(-down)} stroke="#cbd5e1" strokeWidth={sw} />
        <circle cx={0} cy={0} r={sw * 3} fill="none" stroke="#94a3b8" strokeWidth={sw} />
        <g>
          {moving && <circle cx={pen.x} cy={py(pen.y)} r={sw * 9} fill={pen.down ? '#059669' : '#0284c7'} opacity="0.18" />}
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 4.5} fill={pen.down ? '#059669' : 'none'}
            stroke={pen.down ? '#059669' : '#0284c7'} strokeWidth={sw * 1.6} />
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 1.2} fill={pen.down ? '#ffffff' : '#0284c7'} />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] text-ink-600">
        <span className="absolute left-2 top-2">−Y {down}</span>
        <span className="absolute left-2 bottom-2">+Y {up}</span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2">+X {right}</span>
        <span className="absolute left-2 top-1/2 -translate-y-1/2">−X {left}</span>
      </div>
    </div>
  );
}

// ================================================================
//  Bounds control
// ================================================================

// BoundsControl uses the same uncontrolled-input pattern as FieldInline, plus
// an explicit "Apply bounds" button instead of updating on every keystroke.
// The previous keystroke-driven approach caused the canvas to repaint and the
// firmware to receive a new /api/bounds on every character typed ("too noisy").
// Small in-app modal that prompts for a single line of text (used to name a paper).
function TextPromptModal({ title, label, initial, confirmText, onConfirm, onCancel }: {
  title: string; label: string; initial: string; confirmText: string;
  onConfirm: (value: string) => void; onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="w-80 rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-2 text-[13px] font-semibold text-ink-100">{title}</h3>
        <label className="text-[11px] text-ink-500">{label}</label>
        <input autoFocus value={val} onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) onConfirm(val.trim()); if (e.key === 'Escape') onCancel(); }}
          className="mt-1 w-full rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-ink-100 outline-none focus:border-cyanx/50" />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-md px-3 py-1.5 text-[12px] text-ink-400 hover:text-ink-200">Cancel</button>
          <button onClick={() => val.trim() && onConfirm(val.trim())} disabled={!val.trim()}
            className="rounded-md border border-cyanx/40 bg-cyanx/15 px-3 py-1.5 text-[12px] font-semibold text-cyanx hover:bg-cyanx/25 disabled:opacity-40">
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function BoundsControl({ bounds, setBounds, commitBounds }: {
  bounds: PlotterBounds;
  setBounds: (b: PlotterBounds | ((p: PlotterBounds) => PlotterBounds)) => void;
  commitBounds: (b: PlotterBounds) => void;
}) {
  const refs = {
    up:    useRef<HTMLInputElement>(null),
    down:  useRef<HTMLInputElement>(null),
    left:  useRef<HTMLInputElement>(null),
    right: useRef<HTMLInputElement>(null),
  };

  const [shape, setShape] = useState<'rect' | 'ellipse'>(bounds.shape);
  const parse = (s: string | undefined) => Math.max(0, parseFloat(s ?? '0') || 0);

  // Sync uncontrolled inputs when bounds are seeded from the firmware on load.
  useEffect(() => {
    if (refs.up.current)    refs.up.current.value    = String(bounds.up);
    if (refs.down.current)  refs.down.current.value  = String(bounds.down);
    if (refs.left.current)  refs.left.current.value  = String(bounds.left);
    if (refs.right.current) refs.right.current.value = String(bounds.right);
    setShape(bounds.shape);
  // refs object is recreated each render but underlying refs are stable;
  // only bounds needs to trigger this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds]);

  const apply = (shapeOverride?: 'rect' | 'ellipse') => {
    const nb: PlotterBounds = {
      up:    parse(refs.up.current?.value),
      down:  parse(refs.down.current?.value),
      left:  parse(refs.left.current?.value),
      right: parse(refs.right.current?.value),
      shape: shapeOverride ?? shape,
    };
    setBounds(nb);
    commitBounds(nb);
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') apply(); };

  // Switching shape applies immediately (and re-sends bounds) so the canvas + firmware
  // update without needing a second "Apply" click.
  const pickShape = (s: 'rect' | 'ellipse') => { setShape(s); apply(s); };

  const row = (ref: React.RefObject<HTMLInputElement>, label: string, init: number) => (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-[12px] text-ink-400">{label}</span>
      <div className="flex flex-1 items-center rounded-lg border border-ink-700 bg-ink-850 focus-within:border-cyanx/50">
        <input ref={ref} type="text" inputMode="numeric" defaultValue={String(init)}
          onKeyDown={onKey}
          className="min-w-0 w-full bg-transparent px-3 py-2 font-mono text-[13px] text-ink-200 outline-none"
        />
        <span className="pr-3 text-[11px] text-ink-500 font-mono">mm</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {row(refs.up,    'Down (+Y)',  bounds.up)}
      {row(refs.down,  'Up  (−Y)',   bounds.down)}
      {row(refs.left,  'Left  (−X)', bounds.left)}
      {row(refs.right, 'Right (+X)', bounds.right)}

      <div>
        <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-ink-500">Shape</span>
        <div className="flex gap-0.5 rounded-lg border border-ink-700 bg-ink-900 p-0.5">
          {([['rect', '▭ Rectangle'], ['ellipse', '⬭ Ellipse']] as ['rect' | 'ellipse', string][]).map(([s, lbl]) => (
            <button key={s} onClick={() => pickShape(s)}
              className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${shape === s ? 'bg-ink-700 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>
              {lbl}
            </button>
          ))}
        </div>
        {shape === 'ellipse' && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
            Drawable area = the ellipse inscribed in the box: full height at center X, tapering to nothing at the X edges.
          </p>
        )}
      </div>

      <button onClick={() => apply()}
        className="w-full rounded-lg bg-cyanx/10 border border-cyanx/30 px-4 py-2 text-[13px] font-semibold text-cyanx hover:bg-cyanx/20 transition-colors">
        Apply bounds
      </button>
    </div>
  );
}

// ================================================================
//  Log
// ================================================================

function LogView({ log }: { log: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [log]);
  const color = (kind: LogEntry['kind']) => ({
    cmd: 'text-cyanx', ok: 'text-go', err: 'text-stop', warn: 'text-warn', sys: 'text-ink-500', fw: 'text-ink-400',
  }[kind]);
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
  return (
    <div ref={ref} className="h-full overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed">
      {log.map((l) => (
        <div key={l.id} className={`log-line flex gap-2.5 ${color(l.kind)}`}>
          <span className="shrink-0 text-ink-700 tabular-nums" suppressHydrationWarning>{fmtTime(l.t)}</span>
          <span className="whitespace-pre-wrap break-all">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

// ================================================================
//  Jog pad
// ================================================================

function JogPad({ onJog }: { onJog: (dx: number, dy: number) => void }) {
  const [step, setStep] = useState(10);
  const Arrow = ({ dx, dy, char, cls }: { dx: number; dy: number; char: string; cls: string }) => (
    <button onClick={() => onJog(dx * step, dy * step)}
      className={`flex items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800 hover:text-cyanx transition-colors h-11 ${cls}`}>{char}</button>
  );
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="grid grid-cols-3 grid-rows-3 gap-1.5 w-[150px]">
        <Arrow dx={0}  dy={-1} char="↑" cls="col-start-2 row-start-1" />
        <Arrow dx={-1} dy={0}  char="←" cls="col-start-1 row-start-2" />
        <div className="col-start-2 row-start-2 flex items-center justify-center font-mono text-[10px] text-ink-600">{step}mm</div>
        <Arrow dx={1}  dy={0}  char="→" cls="col-start-3 row-start-2" />
        <Arrow dx={0}  dy={1}  char="↓" cls="col-start-2 row-start-3" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">Step</span>
        <div className="flex gap-1">
          {[1, 10, 50].map((s) => (
            <button key={s} onClick={() => setStep(s)}
              className={`rounded-md px-2.5 py-1.5 text-[12px] font-mono transition-colors ${step === s ? 'bg-cyanx/20 text-cyanx border border-cyanx/40' : 'bg-ink-850 text-ink-400 border border-ink-700 hover:text-ink-200'}`}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ================================================================
//  IP config input (header)
// ================================================================

function IpInput({ ip, onSave }: { ip: string; onSave: (v: string) => void }) {
  const [val, setVal] = useState(ip);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(val); }}
      className="flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 pl-2 pr-1 py-1">
      <span className="text-[10px] font-mono text-ink-500 shrink-0">http://</span>
      <input
        value={val} onChange={(e) => setVal(e.target.value)}
        placeholder="192.168.x.x"
        className="min-w-0 w-32 bg-transparent font-mono text-[12px] text-ink-200 outline-none placeholder:text-ink-700"
      />
      <button type="submit"
        className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-400 hover:text-cyanx hover:bg-ink-800 transition-colors">
        connect
      </button>
    </form>
  );
}

// ================================================================
//  Autonomous (AI) tab — driver health, job progress, errors
// ================================================================

function DriverBanner({ status, onClearFault }: { status: PlotterStatus | null; onClearFault: () => void }) {
  const fault = status ? !status.drvOk : false;
  const estop = status?.estop ?? false;
  const bad = fault || estop;
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${bad ? 'border-stop/60 bg-stop/10' : 'border-go/40 bg-go/[0.06]'}`}>
      <span className="relative flex h-3 w-3 shrink-0">
        {bad && <span className="absolute inline-flex h-full w-full rounded-full bg-stop opacity-70 blink" />}
        <span className={`relative inline-flex h-3 w-3 rounded-full ${status == null ? 'bg-ink-600' : bad ? 'bg-stop' : 'bg-go'}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[12px] font-semibold uppercase tracking-wider ${status == null ? 'text-ink-500' : bad ? 'text-stop' : 'text-go'}`}>
          {status == null ? 'Driver — no data'
            : estop ? '⛔ Hardware E-STOP — motors cut'
            : fault ? 'Driver fault'
            : 'Driver healthy'}
        </div>
        {fault && <div className="font-mono text-[12.5px] text-ink-200 break-words">{status?.drvFlags}</div>}
        {estop && !fault && <div className="text-[11.5px] text-ink-400">Clear to release the latch &amp; re-enable, then re-home.</div>}
        {!bad && status && <div className="font-mono text-[11.5px] text-ink-500">flags: {status.drvFlags}</div>}
      </div>
      {bad && (
        <button onClick={onClearFault}
          className="shrink-0 rounded-lg border border-stop/50 bg-stop/15 px-3 py-1.5 text-[12px] font-semibold text-stop hover:bg-stop/25 transition-colors active:scale-[.97]">
          {estop ? 'Clear E-STOP' : 'Clear fault'}
        </button>
      )}
    </div>
  );
}

function JobProgress({ status }: { status: PlotterStatus | null }) {
  if (!status) return <p className="text-[12px] text-ink-500">Waiting for plotter status…</p>;
  const { enqueued, done, pending, idle, aborting, job } = status;
  const pct = enqueued > 0 ? Math.round((done / enqueued) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className={`font-mono text-[12px] ${aborting ? 'text-stop' : idle ? 'text-ink-500' : 'text-warn'}`}>
          {aborting ? '■ aborting' : idle ? '○ idle' : '● running'}
        </span>
        <span className="font-mono text-[12px] text-ink-400">{done}/{enqueued} done · {pending} pending</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink-850">
        <div className={`h-full transition-all ${aborting ? 'bg-stop' : 'bg-go'}`} style={{ width: `${pct}%` }} />
      </div>
      {!idle && job && <div className="font-mono text-[12px] text-ink-300">current: <span className="text-cyanx">{job}</span></div>}
    </div>
  );
}

function JobList({ jobs }: { jobs: JobEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const interacting = useRef(false);       // user is scrolling → don't auto-move
  const idleTimer = useRef<number | null>(null);
  const progUntil = useRef(0);             // ignore our own programmatic scroll events until this time

  // Park the CURRENT (doing) job 150 px below the window's top — the first ~148 px
  // is covered by the panel chrome above the list — unless the user is actively
  // scrolling. Adding pending jobs no longer yanks the view to the bottom.
  const TOP_OFFSET = 150;
  const centerCurrent = useCallback(() => {
    const c = ref.current;
    if (!c || interacting.current) return;
    const el = c.querySelector<HTMLElement>('[data-doing="1"]');
    if (!el) return;
    // el's offset within the scroll content (robust regardless of offsetParent)
    const elTop = el.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop;
    const target = elTop - TOP_OFFSET;
    progUntil.current = Date.now() + 700;  // smooth scroll fires many events; ignore them all
    c.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, []);

  // A real (user) scroll pauses auto-centering; it resumes ~4 s after they stop.
  const markInteract = useCallback(() => {
    interacting.current = true;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => { interacting.current = false; centerCurrent(); }, 4000);
  }, [centerCurrent]);

  const onScroll = useCallback(() => {
    if (Date.now() < progUntil.current) return;   // our own scrollTo — not the user
    markInteract();
  }, [markInteract]);

  // Re-center when the current job advances or the list changes (idle only).
  const doingId = jobs.find((j) => j.state === 'doing')?.id;
  useEffect(() => { centerCurrent(); }, [doingId, jobs.length, centerCurrent]);
  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);

  if (!jobs.length) return <p className="text-[12px] text-ink-500">No jobs yet. Queue work from the MCP or the Draw tab.</p>;
  const dot = (s: JobEntry['state']) => (s === 'done' ? '✓' : s === 'doing' ? '▶' : '○');
  const cls = (s: JobEntry['state']) => (s === 'done' ? 'text-go' : s === 'doing' ? 'text-warn' : 'text-ink-600');
  return (
    <div ref={ref} onScroll={onScroll} onWheel={markInteract} onTouchStart={markInteract} onPointerDown={markInteract}
      className="h-full space-y-0.5 overflow-y-auto font-mono text-[12.5px]">
      {jobs.map((j) => (
        <div key={j.id} data-doing={j.state === 'doing' ? '1' : undefined}
          className={`flex items-center gap-2 rounded-md px-2 py-1 ${j.state === 'doing' ? 'bg-warn/10' : ''}`}>
          <span className={`${cls(j.state)} ${j.state === 'doing' ? 'blink' : ''}`}>{dot(j.state)}</span>
          <span className="w-9 shrink-0 tabular-nums text-ink-700">#{j.id}</span>
          <span className={`flex-1 truncate ${j.state === 'pending' ? 'text-ink-500' : 'text-ink-200'}`}>
            {j.state === 'pending'
              ? `${j.label || 'job'} — pending`
              : (j.label || '—')}
          </span>
        </div>
      ))}
    </div>
  );
}

// Separate "errors window": the SSE log filtered to faults/errors only. Driver
// faults arrive as warn lines ("!! DRIVER FAULT …"); command/network failures as err.
function ErrorsPanel({ log }: { log: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const errs = log.filter((l) => l.kind === 'err' || l.kind === 'warn');
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [errs.length]);
  const fmtTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
  return (
    <div ref={ref} className="h-full overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed">
      {errs.length === 0 ? (
        <div className="text-ink-600">No errors. Driver faults and command errors will appear here.</div>
      ) : (
        errs.map((l) => (
          <div key={l.id} className={`flex gap-2.5 ${l.kind === 'err' ? 'text-stop' : 'text-warn'}`}>
            <span className="shrink-0 tabular-nums text-ink-700" suppressHydrationWarning>{fmtTime(l.t)}</span>
            <span className="whitespace-pre-wrap break-all">{l.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

// Hover help for the Truchet motif chips, indexed like TRUCHET_MOTIF_NAMES.
// Each motif is one tile design from Carlson's winged-tile family: a white
// ribbon (strip of width cell/3) routed through the cell, ending exactly at
// the 1/3 and 2/3 points of each edge so neighbouring cells join seamlessly.
const TRUCHET_MOTIF_HELP = [
  '\\  Diagonal ribbon: two arc strips hugging the top-right and bottom-left corners. The classic Truchet curve.',
  '/  Diagonal ribbon, mirrored: arc strips on the top-left and bottom-right corners.',
  '-  Horizontal ribbon straight across, plus a dot on the top and bottom edges.',
  '|  Vertical ribbon straight down, plus a dot on the left and right edges.',
  '+.  No ribbons — just a dot on all four edges. Calm filler tile.',
  'x.  Centre blob: the square with all four corners bitten off, touching all four edges.',
  '+  Two ribbons crossing in the middle: connects all four edges.',
  'fne  "Frown north-east": one arc ribbon joining the top and right edges, dots on the other two.',
  'fsw  "Frown south-west": arc ribbon joining the bottom and left edges, dots on the other two.',
  'fnw  "Frown north-west": arc ribbon joining the top and left edges, dots on the other two.',
  'fse  "Frown south-east": arc ribbon joining the bottom and right edges, dots on the other two.',
  'tn  "T north": ribbon across left↔right with a stem up to the top edge; dot on the bottom.',
  'ts  "T south": ribbon across left↔right with a stem down to the bottom edge; dot on the top.',
  'te  "T east": ribbon down top↔bottom with a stem to the right edge; dot on the left.',
  'tw  "T west": ribbon down top↔bottom with a stem to the left edge; dot on the right.',
];

// ================================================================
//  Hardware / chip reference data
// ================================================================

const FW_VERSION = 'pico2 · v1.2 dev';

const TMC5072_SPECS = [
  { label: 'Driver IC',      value: 'TMC5072',                    note: 'Trinamic / Analog Devices' },
  { label: 'Interface',      value: 'SPI Mode 3 · 40-bit',        note: '2 MHz · manual CS · MSB-first' },
  { label: 'Ramp engine',    value: '6-point integrated',         note: 'RAMPMODE 0 — write XTARGET, chip ramps' },
  { label: 'Microsteps',     value: '256 (native)',               note: '200 steps/rev × 256 = 51 200 µsteps/rev' },
  { label: 'Steps / mm',     value: '1 280',                      note: '51 200 µsteps / 40 mm per rev (GT2 20T)' },
  { label: 'Motor 1',        value: 'THETA — left belt',          note: 'm=0 in firmware; right anchor' },
  { label: 'Motor 2',        value: 'RHO — right belt',           note: 'm=1 in firmware; left anchor' },
  { label: 'Current sense',  value: 'R_SENSE = 0.15 Ω',          note: 'Unverified — measure coil current to confirm' },
  { label: 'VSENSE',         value: 'Low (0)',                    note: 'Full-scale ≈ 325 mA at R_SENSE = 0.15 Ω' },
  { label: 'Chopper',        value: 'CHOPCONF 0x000100C3',        note: 'TOFF=3 · HSTRT=0 · HEND=1 · TBL=1' },
  { label: 'MCU',            value: 'RP2350 · Pico 2W',          note: 'CYW43439 WiFi/BT · FreeRTOS ARM_CM33_NTZ' },
  { label: 'Span',           value: '978 mm anchor-to-anchor',   note: 'Measure at belt take-off points, not shaft centres' },
  { label: 'Home belt',      value: '715 mm each side',          note: 'Belt length motor→gondola at the midpoint origin' },
];

function ChipInfoCard({ status }: { status: PlotterStatus | null }) {
  const m = status?.motion;
  const live = m ? [
    { label: 'Run current',  value: `${m.run_ma} mA`,                    note: 'IRUN — active during motion' },
    { label: 'Hold current', value: `${m.hold_ma} mA`,                   note: 'IHOLD — gondola must hold while idle' },
    { label: 'VMAX',         value: m.vmax.toLocaleString(),              note: 'µsteps/s target velocity' },
    { label: 'AMAX',         value: m.amax.toLocaleString(),             note: 'µsteps/s² peak acceleration' },
  ] : null;
  return (
    <Card title="Hardware · TMC5072" icon="⚙" accent="#7c3aed">
      <div className="space-y-1">
        {TMC5072_SPECS.map(({ label, value, note }) => (
          <div key={label} className="grid grid-cols-[130px_1fr] gap-2 py-1 border-b border-ink-800/60 last:border-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-500 pt-px">{label}</span>
            <div>
              <span className="font-mono text-[12.5px] text-ink-200">{value}</span>
              <span className="ml-2 text-[11px] text-ink-600">{note}</span>
            </div>
          </div>
        ))}
      </div>
      {live && (
        <>
          <div className="mt-4 mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">Live motion state</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {live.map(({ label, value, note }) => (
              <div key={label} className="rounded-lg border border-ink-800 bg-ink-950 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-600">{label}</div>
                <div className="font-mono text-[14px] text-cyanx">{value}</div>
                <div className="text-[10px] text-ink-700 mt-0.5">{note}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ================================================================
//  Main App
// ================================================================
// ScriptTab — bulk CSV command entry
// ================================================================

const SCRIPT_HINT = `[
  { "type": "pen", "position": "up" },
  { "type": "goto", "x": 0, "y": 0 },
  { "type": "circle", "cx": 0, "cy": 0, "r": 80 },
  { "type": "square", "cx": 0, "cy": 0, "size": 160, "fill_mode": 1 },
  { "type": "line", "x0": -80, "y0": 0, "x1": 80, "y1": 0, "cycles": 2 },
  { "type": "wobbly", "cx": 0, "cy": 50, "r": 60, "wobble": 0.4, "harmonics": 3 },
  { "type": "truchet", "n": 4, "spacing": 3, "angle": 45, "seed": 42 },
  { "type": "speed", "vmax": 200000 },
  { "type": "home" }
]`;

function ScriptTab({ sendRaw, getPending, runCancelRef, pushLog }: {
  sendRaw: (ep: string, json?: string) => Promise<boolean>;
  getPending: () => Promise<number | null>;
  runCancelRef: React.MutableRefObject<boolean>;
  pushLog: (kind: 'cmd'|'ok'|'err'|'warn'|'sys'|'fw', text: string) => void;
}) {
  const [text, setText] = useState('');
  const abortRef = useRef(false);
  const [run, setRun] = useState<{ status: 'idle'|'running'|'done'; sent: number; errors: number; total: number }>({
    status: 'idle', sent: 0, errors: 0, total: 0,
  });

  const parsed = useMemo(() => parseJsonScript(text), [text]);
  const good   = parsed.filter(l => l.query);
  const bad    = parsed.filter(l => l.error);

  const start = useCallback(async () => {
    if (!good.length) return;
    abortRef.current = false;
    runCancelRef.current = false;   // clear any prior STOP/CLEAR signal before a fresh run
    setRun({ status: 'running', sent: 0, errors: 0, total: good.length });
    pushLog('cmd', `> script: queuing ${good.length} commands (flow-controlled)`);
    const cancelled = () => abortRef.current || runCancelRef.current;  // STOP/CLEAR halt the feed
    const { sent, errors, stopped } = await streamQueries(
      good.map(l => ({ query: l.query!, raw: l.raw })),
      { sendRaw, getPending, isCancelled: cancelled, pushLog, label: 'script',
        onProgress: (s, e) => setRun(r => ({ ...r, sent: s, errors: e })) },
    );
    pushLog(stopped ? 'warn' : (errors === 0 ? 'ok' : 'warn'),
            stopped
              ? `[script] halted by STOP/CLEAR — ${sent}/${good.length} sent, ${good.length - sent} not queued`
              : `[script] done — ${sent - errors} queued` +
                (errors ? `, ${errors} rejected (NOT queue-full — check bounds/syntax)` : ', no rejections'));
    setRun(r => ({ ...r, status: 'done' }));
  }, [good, sendRaw, getPending, runCancelRef, pushLog]);

  const abort = useCallback(() => { abortRef.current = true; }, []);

  const pct = run.total ? Math.round((run.sent / run.total) * 100) : 0;

  return (
    <Card title="Script" icon="≡" accent="#0891b2" defaultCollapsed={false}>
      <textarea
        className="w-full h-56 resize-y rounded bg-ink-900 border border-ink-700 p-2 font-mono text-[12px] text-ink-300 placeholder-ink-600 focus:outline-none focus:border-cyan-600"
        placeholder={SCRIPT_HINT}
        value={text}
        onChange={e => { setText(e.target.value); setRun(r => ({ ...r, status: 'idle' })); }}
        spellCheck={false}
        disabled={run.status === 'running'}
      />

      {/* parse summary */}
      <div className="mt-2 flex items-center gap-3 text-[12px]">
        <span className="text-ink-400">
          {parsed.length === 0
            ? <span className="text-ink-600">paste commands above</span>
            : <><span className="text-ink-300 font-semibold">{good.length}</span> commands</>}
          {bad.length > 0 && <span className="ml-2 text-red-400 font-semibold">· {bad.length} error{bad.length > 1 ? 's' : ''}</span>}
        </span>
        {text && (
          <button className="ml-auto text-[11px] text-ink-600 hover:text-ink-400" onClick={() => { setText(''); setRun({ status: 'idle', sent: 0, errors: 0, total: 0 }); }}>
            Clear
          </button>
        )}
      </div>

      {/* parse errors (up to 5) */}
      {bad.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {bad.slice(0, 5).map(l => (
            <div key={l.idx} className="font-mono text-[11px] text-red-400">
              {l.idx === -1 ? l.error : `item ${l.idx + 1}: ${l.error}`}
            </div>
          ))}
          {bad.length > 5 && <div className="text-[11px] text-ink-600">…and {bad.length - 5} more</div>}
        </div>
      )}

      {/* action row */}
      <div className="mt-3 flex items-center gap-3">
        {run.status !== 'running' ? (
          <Btn variant="go" onClick={start} disabled={good.length === 0}>
            Queue {good.length} cmd{good.length !== 1 ? 's' : ''} →
          </Btn>
        ) : (
          <Btn variant="danger" onClick={abort}>Abort</Btn>
        )}
        {run.status === 'done' && (
          <span className="text-[12px] text-ink-400">
            Done — {run.sent - run.errors} ok{run.errors > 0 ? `, ${run.errors} failed` : ''}
          </span>
        )}
      </div>

      {/* progress bar */}
      {run.status !== 'idle' && run.total > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-ink-500 mb-1">
            <span>{run.status === 'running' ? 'Sending…' : 'Done'}</span>
            <span>{run.sent} / {run.total}</span>
          </div>
          <div className="h-1.5 rounded bg-ink-800 overflow-hidden">
            <div
              className={`h-full rounded transition-all ${run.errors > 0 ? 'bg-amber-500' : 'bg-cyan-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

// ================================================================
// GcodeTab — G-code digester: paste or upload .gcode / .bgcode, translate to
// goto/line/pen ops, and stream them flow-controlled like the JSON script tab.
// ================================================================

const PEN_MODES: [PenMode, string][] = [
  ['auto', 'Auto-detect'], ['z', 'Z height'], ['spindle', 'Spindle M3/M5'],
  ['servo', 'Servo M280'], ['g01', 'G0 travel / G1 draw'],
];
const PLACE_MODES: [PlaceMode, string][] = [
  ['fit', 'Auto-fit & center'], ['center', 'Center, no scale'],
  ['rawflip', 'Raw + Y-flip'], ['raw', 'Raw (no transform)'],
];

function GcodeSelect<T extends string>({ label, value, opts, onChange, disabled }: {
  label: string; value: T; opts: [T, string][]; onChange: (v: T) => void; disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</span>
      <select
        className="rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-[12px] text-ink-200 focus:outline-none focus:border-cyan-600 disabled:opacity-50"
        value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}>
        {opts.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
      </select>
    </label>
  );
}

// v1.3 / S4 (Day 5): the Studio — pick a generator, tweak its schema-driven params,
// and Run it through Frame → compile → streamQueries. Auto-lists every registered
// "make" module, so new generators (S5+) appear here with zero UI wiring.
// v1.3 / S17 (Day 23-24): live Frame preview with a drawing-order scrubber. Draws the
// active (optimised, progress-sliced) frame in plotter coords. Self-contained SVG.
function FramePreview({ bounds, frame }: { bounds: PlotterBounds; frame: Frame }) {
  const { left, right, up, down } = bounds;
  const pad = Math.max(20, (left + right) * 0.06);
  const vbX = -left - pad, vbY = -down - pad, vbW = left + right + 2 * pad, vbH = up + down + 2 * pad;
  const sw = vbW / 400;
  const CAP = 6000;   // guard against pathological path counts freezing the SVG
  const shown = frame.paths.slice(0, CAP);
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950 overflow-hidden">
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} className="w-full"
        style={{ aspectRatio: `${vbW} / ${vbH}`, display: 'block' }} preserveAspectRatio="xMidYMid meet">
        <rect x={-left} y={-down} width={left + right} height={up + down} fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.2} rx={sw} />
        {shown.map((p, i) => {
          const pts = p.closed && p.points.length > 2 ? [...p.points, p.points[0]] : p.points;
          return <polyline key={i} points={pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')}
            fill="none" stroke="#7c3aed" strokeWidth={sw * 1.2} strokeLinejoin="round" strokeLinecap="round" />;
        })}
      </svg>
    </div>
  );
}

// ---- Studio layer-stack persistence (localStorage) ----
const STUDIO_KEY = 'plotterStudioLayers';
let _layerSeq = 0;
const newLayerId = () => `L${Date.now().toString(36)}${(_layerSeq++).toString(36)}`;
function loadStudioLayers(): Layer[] {
  try {
    const raw = localStorage.getItem(STUDIO_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter((l) => l && getModule(l.moduleKey))
                  .map((l) => ({ id: l.id || newLayerId(), moduleKey: l.moduleKey, params: l.params || {} }));
      }
    }
  } catch { /* ignore */ }
  return [];
}

// v1.3 / S10 (Day 16): the Studio is now a layer STACK. Each layer is a generator or
// modifier; the stack evaluates bottom→top (a modifier sees everything beneath it),
// then optimize → compile → stream. New modules appear in the Add picker automatically.
function StudioTab({ sendRaw, getPending, runCancelRef, pushLog, bounds }: {
  sendRaw: (ep: string, json?: string) => Promise<boolean>;
  getPending: () => Promise<number | null>;
  runCancelRef: React.MutableRefObject<boolean>;
  pushLog: (kind: LogEntry['kind'], text: string) => void;
  bounds: PlotterBounds;
}) {
  const allMods = useMemo(() => listModules(), []);
  const makes = useMemo(() => listModules('make'), []);
  const [layers, setLayers] = useState<Layer[]>(() => {
    const stored = loadStudioLayers();
    if (stored.length) return stored;
    const m = makes[0];
    return m ? [{ id: newLayerId(), moduleKey: m.key, params: defaultsOf(m) }] : [];
  });
  const [selId, setSelId] = useState<string>(() => layers[0]?.id ?? '');
  const [addKey, setAddKey] = useState<string>(makes[0]?.key ?? '');
  const abortRef = useRef(false);
  const [run, setRun] = useState<{ status: 'idle'|'running'|'done'; sent: number; total: number; errors: number }>({
    status: 'idle', sent: 0, total: 0, errors: 0,
  });

  useEffect(() => { try { localStorage.setItem(STUDIO_KEY, JSON.stringify(layers)); } catch { /* ignore */ } }, [layers]);

  // Source image for image modules (loaded in the UI, fed to evaluate via ctx.image).
  const [image, setImage] = useState<GrayImage | undefined>(undefined);
  const [imageName, setImageName] = useState('');
  const imgRef = useRef<HTMLInputElement>(null);
  const needsImage = layers.some((l) => getModule(l.moduleKey)?.group === 'Image');

  const sel = layers.find((l) => l.id === selId) ?? layers[0];
  const selMod = sel ? getModule(sel.moduleKey) : undefined;

  const [orderPct, setOrderPct] = useState(100);   // drawing-order scrubber (% revealed)
  const frame = useMemo(() => evaluate(layers, { left: bounds.left, right: bounds.right, up: bounds.up, down: bounds.down }, image),
    [layers, bounds.left, bounds.right, bounds.up, bounds.down, image]);
  const optFrame = useMemo(() => optimizeOrder(simplifyFrame(frame)), [frame]);
  const queries = useMemo(() => compile(optFrame), [optFrame]);
  const previewFrame = useMemo(() => buildProgressPaths(optFrame, orderPct / 100), [optFrame, orderPct]);
  const draws = queries.filter((q) => q.startsWith('line?')).length;
  const travels = queries.filter((q) => q.startsWith('goto?')).length;

  const addLayer = () => {
    const m = getModule(addKey); if (!m) return;
    const layer: Layer = { id: newLayerId(), moduleKey: addKey, params: defaultsOf(m) };
    setLayers((ls) => [...ls, layer]); setSelId(layer.id); setRun((r) => ({ ...r, status: 'idle' }));
  };
  const removeLayer = (id: string) => setLayers((ls) => {
    const next = ls.filter((l) => l.id !== id);
    if (selId === id) setSelId(next[next.length - 1]?.id ?? '');
    return next;
  });
  const move = (id: string, dir: -1 | 1) => setLayers((ls) => {
    const i = ls.findIndex((l) => l.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= ls.length) return ls;
    const next = ls.slice(); [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const setParam = (key: string, val: number | string | boolean) =>
    setLayers((ls) => ls.map((l) => (l.id === sel?.id ? { ...l, params: { ...l.params, [key]: val } } : l)));
  const resetSel = () => { if (selMod && sel) setLayers((ls) => ls.map((l) => (l.id === sel.id ? { ...l, params: defaultsOf(selMod) } : l))); };

  const start = useCallback(async () => {
    abortRef.current = false; runCancelRef.current = false;
    setRun({ status: 'running', sent: 0, total: queries.length, errors: 0 });
    pushLog('cmd', `> studio: ${layers.length} layer(s), ${queries.length} ops (${draws} draws, ${travels} travels)`);
    const { sent, errors, stopped } = await streamQueries(
      queries.map((q) => ({ query: q })),
      { sendRaw, getPending, isCancelled: () => abortRef.current || runCancelRef.current, pushLog, label: 'studio',
        onProgress: (s, e) => setRun((r) => ({ ...r, sent: s, errors: e })) },
    );
    pushLog(stopped ? 'warn' : (errors ? 'warn' : 'ok'),
      stopped ? `[studio] halted — ${sent}/${queries.length} sent`
              : `[studio] done — ${sent - errors} queued${errors ? `, ${errors} rejected` : ''}`);
    setRun((r) => ({ ...r, status: 'done' }));
  }, [queries, layers.length, draws, travels, sendRaw, getPending, runCancelRef, pushLog]);

  const abort = useCallback(() => { abortRef.current = true; }, []);
  const pct = run.total ? Math.round((run.sent / run.total) * 100) : 0;
  const busy = run.status === 'running';

  return (
    <Card title="Studio (v1.3)" icon="✦" accent="#7c3aed" defaultCollapsed={false}>
      {/* Sequence (layer stack) — evaluated bottom→top; a modifier sees the layers below it. */}
      {/* Source image — only relevant when an Image module is in the stack */}
      {needsImage && (
        <div className="mb-3 flex items-center gap-2">
          <input ref={imgRef} type="file" accept="image/*" className="hidden"
            onChange={async (e) => {
              const fl = e.target.files?.[0]; e.target.value = '';
              if (!fl) return;
              try { setImage(await loadImageToGray(fl)); setImageName(fl.name); pushLog('ok', `[studio] image ${fl.name}`); }
              catch (err) { pushLog('err', `[studio] image: ${(err as Error).message}`); }
            }} />
          <Btn variant="primary" onClick={() => imgRef.current?.click()} disabled={busy}>🖼 Source image…</Btn>
          {imageName ? <span className="font-mono text-[11px] text-ink-500 truncate max-w-[160px]">{imageName} {image && `(${image.width}×${image.height})`}</span>
                     : <span className="text-[11px] text-amber-400">load an image</span>}
        </div>
      )}

      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Sequence</p>
      <div className="space-y-1">
        {layers.map((l, i) => {
          const m = getModule(l.moduleKey);
          const active = l.id === sel?.id;
          return (
            <div key={l.id} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 ${active ? 'border-cyanx/40 bg-cyanx/10' : 'border-ink-800 bg-ink-850'}`}>
              <button onClick={() => setSelId(l.id)} className={`flex-1 text-left text-[12px] ${active ? 'text-cyanx' : 'text-ink-200 hover:text-cyanx'}`}>
                {m?.label ?? l.moduleKey}
                {m?.kind === 'modify' && <span className="ml-1 text-[10px] text-ink-500">modify</span>}
              </button>
              <button onClick={() => move(l.id, -1)} disabled={i === 0 || busy} className="text-ink-500 hover:text-cyanx disabled:opacity-30 text-[12px]" title="Up">↑</button>
              <button onClick={() => move(l.id, 1)} disabled={i === layers.length - 1 || busy} className="text-ink-500 hover:text-cyanx disabled:opacity-30 text-[12px]" title="Down">↓</button>
              <button onClick={() => removeLayer(l.id)} disabled={busy} className="text-ink-500 hover:text-stop disabled:opacity-30 text-[12px]" title="Remove">✕</button>
            </div>
          );
        })}
        {layers.length === 0 && <p className="text-[11px] text-ink-600">No layers — add one below.</p>}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <select value={addKey} onChange={(e) => setAddKey(e.target.value)} disabled={busy}
          className="flex-1 rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-[12px] text-ink-200 focus:outline-none focus:border-cyanx/50 disabled:opacity-50">
          {allMods.map((m) => <option key={m.key} value={m.key}>{m.label}{m.kind === 'modify' ? ' · modify' : ''}</option>)}
        </select>
        <Btn variant="default" onClick={addLayer} disabled={busy}>+ Add</Btn>
      </div>

      {/* Selected layer's parameters */}
      {sel && selMod && (
        <div className="mt-4 border-t border-ink-800 pt-3">
          {selMod.description && <p className="mb-3 text-[11px] leading-relaxed text-ink-500">{selMod.description}</p>}
          <ParamPanel sections={selMod.sections} values={sel.params} onChange={setParam} />
        </div>
      )}

      {/* Live preview + drawing-order scrubber */}
      <div className="mt-4 border-t border-ink-800 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">Preview</span>
          <span className="font-mono text-[11px] text-ink-500">order {orderPct}%</span>
        </div>
        <FramePreview bounds={bounds} frame={previewFrame} />
        <input type="range" min={0} max={100} step={1} value={orderPct} onChange={(e) => setOrderPct(Number(e.target.value))}
          className="mt-2 w-full" title="Scrub the drawing order" />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 text-[12px] text-ink-400">
        <span><span className="text-ink-500">draws</span> <span className="font-semibold">{draws}</span></span>
        <span><span className="text-ink-500">travels</span> <span className="font-semibold">{travels}</span></span>
        <span><span className="text-ink-500">ops</span> <span className="font-semibold">{queries.length}</span></span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        {!busy
          ? <Btn variant="go" onClick={start} disabled={draws === 0}>▶ Run</Btn>
          : <Btn variant="danger" onClick={abort}>Abort</Btn>}
        <Btn variant="default" onClick={resetSel} disabled={busy || !selMod}>⟲ Reset layer</Btn>
      </div>

      {run.status !== 'idle' && run.total > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-ink-500 mb-1">
            <span>{busy ? 'Streaming…' : 'Done'}</span>
            <span>{run.sent} / {run.total}</span>
          </div>
          <div className="h-1.5 rounded bg-ink-800 overflow-hidden">
            <div className={`h-full rounded transition-all ${run.errors > 0 ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
    </Card>
  );
}

function GcodeTab({ sendRaw, getPending, runCancelRef, pushLog, bounds }: {
  sendRaw: (ep: string, json?: string) => Promise<boolean>;
  getPending: () => Promise<number | null>;
  runCancelRef: React.MutableRefObject<boolean>;
  pushLog: (kind: LogEntry['kind'], text: string) => void;
  bounds: PlotterBounds;
}) {
  const [text, setText] = useState('');
  const [penMode, setPenMode] = useState<PenMode>('auto');
  const [placeMode, setPlaceMode] = useState<PlaceMode>('fit');
  const [fileName, setFileName] = useState('');
  const [decoding, setDecoding] = useState(false);
  const [decodeErr, setDecodeErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);
  const [run, setRun] = useState<{ status: 'idle'|'running'|'done'; sent: number; errors: number; total: number }>({
    status: 'idle', sent: 0, errors: 0, total: 0,
  });

  const result = useMemo<GcodeResult | null>(() => {
    if (!text.trim()) return null;
    try {
      return digestGcode(text, {
        penMode, placeMode,
        bounds: { left: bounds.left, right: bounds.right, up: bounds.up, down: bounds.down },
      });
    } catch { return null; }
  }, [text, penMode, placeMode, bounds.left, bounds.right, bounds.up, bounds.down]);

  const loadFile = useCallback(async (file: File) => {
    setDecodeErr(''); setFileName(file.name);
    const lower = file.name.toLowerCase();
    const isBinary = lower.endsWith('.bgcode') || lower.endsWith('.bgc');
    try {
      if (isBinary) {
        setDecoding(true);
        const txt = await decodeBgcode(await file.arrayBuffer());
        setText(txt);
        pushLog('ok', `[gcode] decoded ${file.name} → ${txt.length.toLocaleString()} chars`);
      } else {
        setText(await file.text());
        pushLog('ok', `[gcode] loaded ${file.name}`);
      }
    } catch (e) {
      setDecodeErr((e as Error).message);
      pushLog('err', `[gcode] ${file.name}: ${(e as Error).message}`);
    } finally {
      setDecoding(false);
      setRun((r) => ({ ...r, status: 'idle' }));
    }
  }, [pushLog]);

  const start = useCallback(async () => {
    if (!result || !result.queries.length) return;
    abortRef.current = false;
    runCancelRef.current = false;
    setRun({ status: 'running', sent: 0, errors: 0, total: result.queries.length });
    pushLog('cmd', `> gcode: queuing ${result.queries.length} ops (${result.draws} draws, ${result.travels} travels)`);
    const cancelled = () => abortRef.current || runCancelRef.current;
    const { sent, errors, stopped } = await streamQueries(
      result.queries.map((q) => ({ query: q })),
      { sendRaw, getPending, isCancelled: cancelled, pushLog, label: 'gcode',
        onProgress: (s, e) => setRun((r) => ({ ...r, sent: s, errors: e })) },
    );
    pushLog(stopped ? 'warn' : (errors === 0 ? 'ok' : 'warn'),
            stopped
              ? `[gcode] halted by STOP/CLEAR — ${sent}/${result.queries.length} sent`
              : `[gcode] done — ${sent - errors} queued` + (errors ? `, ${errors} rejected` : ''));
    setRun((r) => ({ ...r, status: 'done' }));
  }, [result, sendRaw, getPending, runCancelRef, pushLog]);

  const abort = useCallback(() => { abortRef.current = true; }, []);
  const pct = run.total ? Math.round((run.sent / run.total) * 100) : 0;

  return (
    <Card title="G-code" icon="⌀" accent="#7c3aed" defaultCollapsed={false}>
      {/* upload row */}
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".gcode,.gco,.g,.nc,.bgcode,.bgc" className="hidden"
          onChange={(e) => { const fl = e.target.files?.[0]; if (fl) loadFile(fl); e.target.value = ''; }} />
        <Btn variant="primary" onClick={() => fileRef.current?.click()} disabled={run.status === 'running' || decoding}>
          ⬆ Upload .gcode / .bgcode
        </Btn>
        {decoding && <span className="text-[12px] text-amber-400">decoding…</span>}
        {fileName && !decoding && <span className="font-mono text-[11px] text-ink-500 truncate max-w-[200px]">{fileName}</span>}
      </div>

      {decodeErr && <div className="mt-2 font-mono text-[11px] text-red-400">{decodeErr}</div>}

      <textarea
        className="mt-3 w-full h-44 resize-y rounded bg-ink-900 border border-ink-700 p-2 font-mono text-[12px] text-ink-300 placeholder-ink-600 focus:outline-none focus:border-cyan-600"
        placeholder={`; paste G-code here, or upload a file above\nG21\nG90\nG0 X10 Y10\nG1 Z0\nG1 X40 Y10\nG1 X40 Y40\nG0 Z2`}
        value={text}
        onChange={(e) => { setText(e.target.value); setRun((r) => ({ ...r, status: 'idle' })); }}
        spellCheck={false}
        disabled={run.status === 'running'}
      />

      {/* options */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <GcodeSelect label="Pen control" value={penMode} opts={PEN_MODES} onChange={setPenMode} disabled={run.status === 'running'} />
        <GcodeSelect label="Placement" value={placeMode} opts={PLACE_MODES} onChange={setPlaceMode} disabled={run.status === 'running'} />
      </div>

      {/* digest summary */}
      {result && (
        <div className="mt-3 rounded border border-ink-800 bg-ink-850 p-2.5 text-[12px] space-y-1">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-ink-300">
            <span><span className="text-ink-500">draws</span> <span className="font-semibold">{result.draws}</span></span>
            <span><span className="text-ink-500">travels</span> <span className="font-semibold">{result.travels}</span></span>
            <span><span className="text-ink-500">pen</span> <span className="font-mono">{penMode === 'auto' ? `auto → ${result.resolvedPen}` : result.resolvedPen}</span></span>
            {placeMode === 'fit' && <span><span className="text-ink-500">scale</span> <span className="font-mono">{(result.scale * 100).toFixed(0)}%</span></span>}
          </div>
          {result.bbox && (
            <div className="font-mono text-[11px] text-ink-500">
              source bbox: ({result.bbox.x0.toFixed(1)}, {result.bbox.y0.toFixed(1)}) → ({result.bbox.x1.toFixed(1)}, {result.bbox.y1.toFixed(1)}) mm
            </div>
          )}
          {result.warnings.map((w, i) => (
            <div key={i} className="text-[11px] text-amber-400">⚠ {w}</div>
          ))}
        </div>
      )}

      {/* action row */}
      <div className="mt-3 flex items-center gap-3">
        {run.status !== 'running' ? (
          <Btn variant="go" onClick={start} disabled={!result || result.queries.length === 0}>
            Run {result ? result.draws + result.travels : 0} move{result && (result.draws + result.travels) !== 1 ? 's' : ''} →
          </Btn>
        ) : (
          <Btn variant="danger" onClick={abort}>Abort</Btn>
        )}
        {text && run.status !== 'running' && (
          <button className="ml-auto text-[11px] text-ink-600 hover:text-ink-400"
            onClick={() => { setText(''); setFileName(''); setDecodeErr(''); setRun({ status: 'idle', sent: 0, errors: 0, total: 0 }); }}>
            Clear
          </button>
        )}
      </div>

      {/* progress */}
      {run.status !== 'idle' && run.total > 0 && (
        <div className="mt-3">
          <div className="flex justify-between text-[11px] text-ink-500 mb-1">
            <span>{run.status === 'running' ? 'Streaming…' : 'Done'}</span>
            <span>{run.sent} / {run.total}</span>
          </div>
          <div className="h-1.5 rounded bg-ink-800 overflow-hidden">
            <div className={`h-full rounded transition-all ${run.errors > 0 ? 'bg-amber-500' : 'bg-cyan-500'}`}
              style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
        Translates G-code to the plotter's goto/line/pen moves (Z/E/F are ignored — only X/Y + pen).
        Binary <span className="font-mono">.bgcode</span> is decoded in the browser. Coordinates are
        placed into the active work area; pen up/down is read per the selected convention.
      </p>
    </Card>
  );
}

// ================================================================

type Tab = 'area' | 'draw' | 'ai';
const f = <T extends object>(obj: T, set: React.Dispatch<React.SetStateAction<T>>) =>
  (k: keyof T) => (v: T[keyof T]) => set({ ...obj, [k]: v });

export default function App() {
  const P = usePlotter();
  const { pen, moving, connected, motion, bounds, log, status, jobs, papers, matrix, matrices } = P;

  const [gotoF, setGoto]   = useState({ x: 0, y: 0 });
  const [circle, setCircle] = useState({ cx: 0, cy: 0, r: 50, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [square, setSquare] = useState({ cx: 0, cy: 0, size: 100, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [lineF, setLine]    = useState({ x0: 0, y0: 0, x1: 100, y1: 0, cycles: 1 });
  const [wobbly, setWobbly]     = useState({ cx: 0, cy: 0, r: 60, boundR: 90, wobble: 0.4, harmonics: 3, seed: 42, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [truchet, setTruchet]   = useState({ n: 4, spacing: 3, angle: 45, seed: 42, motifs: TRUCHET_DEFAULT_MASK });
  const [calib, setCalib]       = useState({ cx: 0, cy: 0 });
  const [tab, setTab]       = useState<Tab>('area');
  const [paperModal, setPaperModal] = useState<{ mode: 'save' | 'rename'; initial: string; target?: string } | null>(null);
  const [matrixModal, setMatrixModal] = useState<{ mode: 'save' | 'rename'; initial: string; target?: string } | null>(null);

  const fg = f(gotoF, setGoto);
  const fc = f(circle, setCircle);
  const fs = f(square, setSquare);
  const fl = f(lineF, setLine);
  const fw = f(wobbly, setWobbly);
  const ft = f(truchet, setTruchet);
  const fca = f(calib, setCalib);

  return (
    <div className="h-screen flex flex-col bg-ink-950 text-ink-300 overflow-hidden">
      {/* top bar */}
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:px-6 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyanx/30 bg-cyanx/10 text-cyanx shadow-[0_0_12px_rgba(6,182,212,0.15)]">
              {/* V-plotter glyph: top rail + two motor pulleys, belts converging to the gondola/pen */}
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3.5" y1="5" x2="20.5" y2="5"/>
                <circle cx="5" cy="5" r="1.5" fill="currentColor" stroke="none"/>
                <circle cx="19" cy="5" r="1.5" fill="currentColor" stroke="none"/>
                <line x1="5" y1="5" x2="12" y2="14.5"/>
                <line x1="19" y1="5" x2="12" y2="14.5"/>
                <circle cx="12" cy="15" r="2.3" fill="currentColor" stroke="none"/>
                <line x1="12" y1="17.3" x2="12" y2="20.5"/>
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-bold tracking-tight text-ink-100">Polar Plotter</h1>
                <span className="hidden sm:inline-flex items-center rounded-md border border-cyanx/30 bg-cyanx/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyanx tracking-wide">{FW_VERSION}</span>
              </div>
              <p className="hidden font-mono text-[11px] text-ink-500 sm:block">V-plotter console · Pico 2 W · TMC5072</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            {status?.estop && (
              <button onClick={P.clearFault}
                title="Hardware E-STOP latched — motors cut. Click to clear & re-enable, then re-home."
                className="flex items-center gap-1.5 rounded-lg border border-stop/60 bg-stop/15 px-3 py-1.5 text-[12px] font-bold text-stop animate-pulse">
                ⛔ E-STOP — clear
              </button>
            )}
            <IpInput ip={P.ip} onSave={P.setIp} />
            <StatusChip connected={connected} />
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6">
        <div className="h-full grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:[grid-template-rows:minmax(0,1fr)]">

          {/* ====== LEFT: machine state ====== */}
          <div className="space-y-4 overflow-y-auto">
            <Card title="Position" icon="◎" accent="#0284c7" defaultCollapsed={false} right={
              <span className={`font-mono text-[12px] ${pen.down ? 'text-go' : 'text-ink-500'}`}>{pen.down ? '▼ pen down' : '△ pen up'}</span>
            }>
              <PlotterCanvas bounds={bounds} pen={pen} moving={moving} />
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Readout label="X" value={pen.x.toFixed(1)} unit="mm" />
                <Readout label="Y" value={pen.y.toFixed(1)} unit="mm" />
                <Readout label="Pending" value={status?.pending ?? 0} unit="job" />
                <Readout label="Done" value={status?.done ?? 0} unit="" />
              </div>
              {/* Current job — its exact JSON while running (console + Script tab), else idle. */}
              <div className="mt-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Current job</div>
                <div className={`rounded-md border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11px] break-all ${P.currentJob ? 'text-cyanx' : 'text-ink-600'}`}>
                  {P.currentJob || '— idle —'}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Btn variant="primary"  onClick={() => P.enqueue({ type: 'home' })}>⌂ Home</Btn>
                <Btn                    onClick={() => P.enqueue({ type: 'sethome' })}>Set Home</Btn>
                <Btn variant={pen.down ? 'default' : 'go'} onClick={() => P.enqueue({ type: 'pen', pos: 'up' })}>Pen Up</Btn>
                <Btn variant={pen.down ? 'go' : 'default'} onClick={() => P.enqueue({ type: 'pen', pos: 'down' })}>Pen Down</Btn>
                {/* Paper type selector — right-aligned; manage papers in the Calibration tab. */}
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">Paper</span>
                  <select
                    value={papers.find((p) => p.left === bounds.left && p.right === bounds.right && p.up === bounds.up && p.down === bounds.down)?.name ?? ''}
                    onChange={(e) => { const p = papers.find((x) => x.name === e.target.value); if (p) P.applyPaper(p); }}
                    className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-ink-100 outline-none focus:border-cyanx/50">
                    <option value="" disabled hidden>Custom…</option>
                    {papers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </div>
              </div>
            </Card>

            <Card title="Driver health" icon="❤" accent="#059669">
              <DriverBanner status={status} onClearFault={P.clearFault} />
              <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
                The MCP halts the running job and pauses the script on a real TMC5072 fault
                (over-temp, coil short). Fix the cause, then <span className="text-ink-300">Clear</span> to resume.
              </p>
            </Card>

            <ChipInfoCard status={status} />

          </div>

          {/* ====== RIGHT: controls ======
               Single top-aligned scroll column. The tab bar pins to the top;
               below it the active tab's method cards flow and the Log card sits
               directly after them (no bottom gap). The scroll region is flex-col
               so the Log can flex-1 to absorb any leftover height when the method
               cards are short, while keeping a usable min height and scrolling
               the whole region when content overflows. */}
          <div className="flex flex-col gap-4 h-full min-h-0">
            {/* Tab bar */}
            <div className="shrink-0 flex gap-1 rounded-xl border border-ink-750 bg-ink-900 shadow-card p-1">
              {([['area','Calibration'],['draw','Draw'],['ai','Autonomous']] as [Tab,string][]).map(([id, lbl]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors ${tab === id ? 'bg-ink-800 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>{lbl}</button>
              ))}
            </div>

            {/* Methods + Log scroll region (flows top→bottom) */}
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
            {/* Tab panels */}
            <div className="space-y-4">
            {/* ---- Draw tab ---- */}
            {tab === 'draw' && (
              <>
                <Card title="Circle" icon="○" accent="#0284c7" collapsible
                  right={<DrawBtn onClick={() => P.enqueue({ type: 'circle', ...circle })} />}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <FieldInline label="Center X" unit="mm" value={circle.cx} onChange={fc('cx') as (v: number) => void} />
                    <FieldInline label="Center Y" unit="mm" value={circle.cy} onChange={fc('cy') as (v: number) => void} />
                    <FieldInline label="Radius" unit="mm" value={circle.r} min={1} onChange={fc('r') as (v: number) => void} />
                    <FieldInline label="Cycles" value={circle.cycles} min={1} onChange={fc('cycles') as (v: number) => void} />
                    <FieldInline label="Angle" unit="°" value={circle.angle} onChange={fc('angle') as (v: number) => void} />
                    <FieldInline label="Spacing" unit="mm" value={circle.spacing} min={0.5} step={0.5} onChange={fc('spacing') as (v: number) => void} />
                  </div>
                  <div className="mt-3 flex gap-3">
                    <div className="flex-1"><FillPicker value={circle.fillMode} onChange={(v) => setCircle({ ...circle, fillMode: v })} /></div>
                    <div className="w-28"><OutlineToggle value={circle.outline} onChange={(v) => setCircle({ ...circle, outline: v })} /></div>
                  </div>
                </Card>

                <Card title="Square" icon="□" accent="#059669" collapsible
                  right={<DrawBtn onClick={() => P.enqueue({ type: 'square', ...square })} />}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <FieldInline label="Center X" unit="mm" value={square.cx} onChange={fs('cx') as (v: number) => void} />
                    <FieldInline label="Center Y" unit="mm" value={square.cy} onChange={fs('cy') as (v: number) => void} />
                    <FieldInline label="Side length" unit="mm" value={square.size} min={1} onChange={fs('size') as (v: number) => void} />
                    <FieldInline label="Cycles" value={square.cycles} min={1} onChange={fs('cycles') as (v: number) => void} />
                    <FieldInline label="Angle" unit="°" value={square.angle} onChange={fs('angle') as (v: number) => void} />
                    <FieldInline label="Spacing" unit="mm" value={square.spacing} min={0.5} step={0.5} onChange={fs('spacing') as (v: number) => void} />
                  </div>
                  <div className="mt-3 flex gap-3">
                    <div className="flex-1"><FillPicker value={square.fillMode} onChange={(v) => setSquare({ ...square, fillMode: v })} /></div>
                    <div className="w-28"><OutlineToggle value={square.outline} onChange={(v) => setSquare({ ...square, outline: v })} /></div>
                  </div>
                </Card>

                <Card title="Line" icon="／" accent="#d97706" collapsible
                  right={<DrawBtn onClick={() => P.enqueue({ type: 'line', ...lineF })} />}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <FieldInline label="X0" unit="mm" value={lineF.x0} onChange={fl('x0') as (v: number) => void} />
                    <FieldInline label="Y0" unit="mm" value={lineF.y0} onChange={fl('y0') as (v: number) => void} />
                    <FieldInline label="X1" unit="mm" value={lineF.x1} onChange={fl('x1') as (v: number) => void} />
                    <FieldInline label="Y1" unit="mm" value={lineF.y1} onChange={fl('y1') as (v: number) => void} />
                  </div>
                  <div className="mt-3 w-28">
                    <FieldInline label="Cycles" value={lineF.cycles} min={1} onChange={fl('cycles') as (v: number) => void} />
                  </div>
                </Card>

                <Card title="Wobbly" icon="∿" accent="#7c3aed" collapsible
                  right={<DrawBtn onClick={() => P.enqueue({ type: 'wobbly', ...wobbly })} />}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <FieldInline label="Center X" unit="mm" value={wobbly.cx} onChange={fw('cx') as (v: number) => void} />
                    <FieldInline label="Center Y" unit="mm" value={wobbly.cy} onChange={fw('cy') as (v: number) => void} />
                    <FieldInline label="Base radius" unit="mm" value={wobbly.r} min={1} onChange={fw('r') as (v: number) => void} />
                    <FieldInline label="Bound radius" unit="mm" value={wobbly.boundR} min={1}
                      onChange={fw('boundR') as (v: number) => void} />
                    <FieldInline label="Wobble" value={wobbly.wobble} min={0} max={1} step={0.05}
                      onChange={fw('wobble') as (v: number) => void} />
                    <FieldInline label="Harmonics" value={wobbly.harmonics} min={1} max={8} step={1}
                      onChange={fw('harmonics') as (v: number) => void} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <FieldInline label="Seed" value={wobbly.seed} min={0} max={99999} step={1}
                      onChange={fw('seed') as (v: number) => void} />
                    <FieldInline label="Cycles" value={wobbly.cycles} min={1}
                      onChange={fw('cycles') as (v: number) => void} />
                    <FieldInline label="Angle" unit="°" value={wobbly.angle} onChange={fw('angle') as (v: number) => void} />
                    <FieldInline label="Spacing" unit="mm" value={wobbly.spacing} min={0.5} step={0.5} onChange={fw('spacing') as (v: number) => void} />
                  </div>
                  <div className="mt-3 flex gap-3">
                    <div className="flex-1"><FillPicker value={wobbly.fillMode} onChange={(v) => setWobbly({ ...wobbly, fillMode: v })} /></div>
                    <div className="w-28"><OutlineToggle value={wobbly.outline} onChange={(v) => setWobbly({ ...wobbly, outline: v })} /></div>
                  </div>
                </Card>

                {/* Truchet */}
                <Card title="Truchet" icon="◔" accent="#0891b2" collapsible
                  right={<DrawBtn
                    title={'Queue the full Truchet plot. The work area is split into a grid of square cells; each cell gets a random motif (from the enabled chips below). The white ribbons connect cell-to-cell because every motif meets the cell edges at the same 1/3 and 2/3 points; everything that is NOT ribbon gets hatched. Slow job — try Hatch spacing 0 first for a quick outlines-only proof on paper.'}
                    onClick={() => P.enqueue({
                      type: 'truchet', ...truchet,
                      left: bounds.left, right: bounds.right, up: bounds.up, down: bounds.down, shape: bounds.shape,
                    })} />}>
                  <p className="mb-3 text-[12px] leading-relaxed text-ink-400">
                    Carlson winged-motif tiling over the whole work area: the motif ribbons stay
                    white, the background is hatched. Hatching is slow — wider spacing plots faster;
                    spacing 0 = outlines only. Hover any control for details.
                  </p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <FieldInline label="Columns" value={truchet.n} min={1} max={64} step={1}
                      title={'How many cells across the work area. Cell size = work-area width ÷ columns, clamped to a 40 mm minimum (the pen can\'t draw the cell/3-wide ribbons cleanly below that). Rows are derived from the height, so the grid is always square cells, centred — a thin unhatched margin can remain top/bottom.'}
                      onChange={ft('n') as (v: number) => void} />
                    <FieldInline label="Hatch spacing" unit="mm" value={truchet.spacing} min={0} max={20} step={0.5}
                      title={'Distance between hatch lines filling the background (negative space). Smaller = darker ground and much longer plot time; 3–4 mm is a good balance. 0 disables hatching entirely — only the ribbon outlines are drawn (fast, good for a positioning proof).'}
                      onChange={ft('spacing') as (v: number) => void} />
                    <FieldInline label="Hatch angle" unit="°" value={truchet.angle} min={0} max={180} step={5}
                      title={'Direction of the hatch lines, in degrees (0 = horizontal, 45 = diagonal). All cells share one global line lattice, so the texture runs continuously across cell boundaries instead of restarting in every cell.'}
                      onChange={ft('angle') as (v: number) => void} />
                    <FieldInline label="Seed" value={truchet.seed} min={0} max={99999} step={1}
                      title={'Random seed for the motif placed in each cell. The same seed + same settings always reproduces the identical pattern (the preview and the plotter use the same generator). Change it to reshuffle the design without changing its character.'}
                      onChange={ft('seed') as (v: number) => void} />
                  </div>
                  <div className="mt-3">
                    <p className="mb-1 text-[11px] text-ink-500"
                      title={'Each chip is one tile design from Carlson\'s set (Bridges 2018). Enabled chips form the pool the random picker draws from — mixing 2–3 different shapes gives the richest patterns. All motifs share the same edge connection points, so any mix still joins seamlessly.'}>
                      Motifs (cell size = width / columns, min 40 mm)</p>
                    <div className="flex flex-wrap gap-1">
                      {TRUCHET_MOTIF_NAMES.map((name, i) => (
                        <button key={name} title={TRUCHET_MOTIF_HELP[i]}
                          onClick={() => setTruchet(t => ({ ...t, motifs: t.motifs ^ (1 << i) }))}
                          className={`rounded px-2 py-1 text-xs font-mono transition-colors ${
                            truchet.motifs & (1 << i)
                              ? 'bg-cyan-600 text-white'
                              : 'bg-ink-800 text-ink-400 hover:bg-ink-700'}`}>
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                </Card>
              </>
            )}

            {/* ---- Work area tab (work area + move + calibration) ---- */}
            {tab === 'area' && (
              <>
                <Card title="Move to point" icon="↗" accent="#0284c7" defaultCollapsed={false}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <FieldInline label="X" unit="mm" value={gotoF.x} onChange={fg('x') as (v: number) => void} />
                    <FieldInline label="Y" unit="mm" value={gotoF.y} onChange={fg('y') as (v: number) => void} />
                    <Btn variant="primary" className="col-span-2 sm:col-span-1"
                      onClick={() => P.enqueue({ type: 'goto', ...gotoF })}>Go →</Btn>
                  </div>
                  <div className="mt-4">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Jog</p>
                    <JogPad onJog={(dx, dy) => {
                      const nx = pen.x + dx, ny = pen.y + dy;
                      setGoto({ x: nx, y: ny });
                      P.enqueue({ type: 'goto', x: nx, y: ny });
                    }} />
                  </div>
                </Card>

                <Card title="Work area boundaries" icon="⛶" accent="#7c3aed" collapsible>
                  <p className="mb-4 text-[12px] leading-relaxed text-ink-400">
                    Distance from origin <span className="font-mono text-ink-300">(0,0)</span> to each edge.
                    Updates the canvas and sends to firmware.
                  </p>
                  <BoundsControl bounds={bounds} setBounds={P.setBounds} commitBounds={P.commitBounds} />
                  <div className="mt-4 flex gap-2">
                    <Btn variant="go" onClick={() => setPaperModal({ mode: 'save', initial: '' })}>💾 Save as paper…</Btn>
                  </div>

                  {/* Saved papers — apply / rename / delete. New ones come from "Save as paper". */}
                  <div className="my-4 h-px bg-ink-800" />
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Paper types</p>
                  <div className="space-y-1.5">
                    {papers.map((p) => {
                      const active = p.left === bounds.left && p.right === bounds.right && p.up === bounds.up && p.down === bounds.down;
                      return (
                        <div key={p.name} className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${active ? 'border-cyanx/40 bg-cyanx/10' : 'border-ink-800 bg-ink-850'}`}>
                          <button onClick={() => P.applyPaper(p)} className={`flex-1 text-left text-[13px] ${active ? 'text-cyanx' : 'text-ink-200 hover:text-cyanx'}`}>
                            {p.name} <span className="font-mono text-[11px] text-ink-500">{p.left + p.right}×{p.up + p.down} mm</span>
                          </button>
                          <button onClick={() => setPaperModal({ mode: 'rename', initial: p.name, target: p.name })}
                            title="Rename" className="text-ink-500 hover:text-cyanx text-[12px]">✎</button>
                          <button onClick={() => P.deletePaper(p.name)}
                            title="Delete" className="text-ink-500 hover:text-stop text-[12px]">✕</button>
                        </div>
                      );
                    })}
                    {papers.length === 0 && <p className="text-[11px] text-ink-600">No papers saved yet.</p>}
                  </div>
                </Card>

                <Card title="Helper" icon="✛" accent="#db2777" collapsible>
                  {/* Limit path: walk the active work-area boundary once (pen down). */}
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Limit path</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Btn variant="go" onClick={() => P.enqueue({ type: 'border', ...bounds })}>
                      ⬡ Walk limits ({bounds.shape === 'ellipse' ? 'ellipse' : 'rect'})
                    </Btn>
                    <span className="font-mono text-[11px] text-ink-500">
                      {bounds.left + bounds.right}×{bounds.up + bounds.down} mm
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                    Traces the active work-area boundary once (pen down) so you can compare the
                    firmware's reachable edge against the physical machine.
                  </p>

                  <div className="my-4 h-px bg-ink-800" />

                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Center patterns</p>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldInline label="Center X" unit="mm" value={calib.cx} onChange={fca('cx') as (v: number) => void} />
                    <FieldInline label="Center Y" unit="mm" value={calib.cy} onChange={fca('cy') as (v: number) => void} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Btn variant="primary" onClick={() => P.enqueue({ type: 'bullseye', ...calib })}>◎ Bullseye</Btn>
                  </div>
                </Card>

                <Card title="Motion" icon="⚡" accent="#d97706" collapsible>
                  <div className="space-y-5">
                    <ParamSlider label="Speed" unit="µstep/t" value={motion.vmax} min={260000} max={440000} step={5000} def={DEFAULTS.motion.vmax} accent="#0284c7"
                      onInput={(v) => P.setMotion('vmax', v)} onCommit={(v) => { P.setMotion('vmax', v); P.commitMotion('vmax', v); }} />
                    <ParamSlider label="Acceleration" unit="AMAX=DMAX" value={motion.amax} min={1270} max={2110} step={10} def={DEFAULTS.motion.amax} accent="#059669"
                      onInput={(v) => P.setMotion('amax', v)} onCommit={(v) => { P.setMotion('amax', v); P.commitMotion('amax', v); }} />
                    <div className="h-px bg-ink-800" />
                    <ParamSlider label="Run current" unit="mA" value={motion.run} min={700} max={1180} step={20} def={DEFAULTS.motion.run} accent="#d97706"
                      onInput={(v) => P.setMotion('run', v)} onCommit={(v) => { P.setMotion('run', v); P.commitMotion('run', v); }} />
                    <ParamSlider label="Hold current" unit="mA" value={motion.hold} min={320} max={560} step={20} def={DEFAULTS.motion.hold} accent="#ea580c"
                      onInput={(v) => P.setMotion('hold', v)} onCommit={(v) => { P.setMotion('hold', v); P.commitMotion('hold', v); }} />
                  </div>
                </Card>

                <Card title="Affine matrix" icon="⧉" accent="#7c3aed" collapsible>
                  <p className="mb-3 text-[12px] leading-relaxed text-ink-400">
                    Warps the logical drawing space before the belt math:
                    <span className="font-mono text-ink-300"> x′ = a·x + b·y + tx</span>,
                    <span className="font-mono text-ink-300"> y′ = c·x + d·y + ty</span>.
                    Session-only (never saved to the board); resets to identity on power-up.
                    For exploring rotation/shear/scale/offset — it can't fix the line bow.
                  </p>
                  {/* 2×3 grid: [a b tx] / [c d ty]. Keyed by value so applying a preset
                      remounts the uncontrolled inputs with the new numbers. */}
                  <div className="grid grid-cols-3 gap-3">
                    <FieldInline key={`a-${matrix.a}`}  label="a"  value={matrix.a}  step={0.01} onChange={(v) => P.setMatrixVal('a', v)} />
                    <FieldInline key={`b-${matrix.b}`}  label="b"  value={matrix.b}  step={0.01} onChange={(v) => P.setMatrixVal('b', v)} />
                    <FieldInline key={`tx-${matrix.tx}`} label="tx" unit="mm" value={matrix.tx} step={1} onChange={(v) => P.setMatrixVal('tx', v)} />
                    <FieldInline key={`c-${matrix.c}`}  label="c"  value={matrix.c}  step={0.01} onChange={(v) => P.setMatrixVal('c', v)} />
                    <FieldInline key={`d-${matrix.d}`}  label="d"  value={matrix.d}  step={0.01} onChange={(v) => P.setMatrixVal('d', v)} />
                    <FieldInline key={`ty-${matrix.ty}`} label="ty" unit="mm" value={matrix.ty} step={1} onChange={(v) => P.setMatrixVal('ty', v)} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Btn variant="go" onClick={() => P.applyMatrixVals()}>✓ Apply</Btn>
                    <Btn variant="default" onClick={() => P.resetMatrix()}>↺ Identity</Btn>
                    <Btn variant="default" onClick={() => setMatrixModal({ mode: 'save', initial: '' })}>💾 Save as preset…</Btn>
                  </div>

                  {/* Saved matrix presets — apply / rename / delete. */}
                  <div className="my-4 h-px bg-ink-800" />
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Presets</p>
                  <div className="space-y-1.5">
                    {matrices.map((m) => {
                      const active = m.a === matrix.a && m.b === matrix.b && m.c === matrix.c
                        && m.d === matrix.d && m.tx === matrix.tx && m.ty === matrix.ty;
                      return (
                        <div key={m.name} className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${active ? 'border-cyanx/40 bg-cyanx/10' : 'border-ink-800 bg-ink-850'}`}>
                          <button onClick={() => P.applyMatrix(m)} className={`flex-1 text-left text-[13px] ${active ? 'text-cyanx' : 'text-ink-200 hover:text-cyanx'}`}>
                            {m.name} <span className="font-mono text-[11px] text-ink-500">[{m.a} {m.b} {m.tx} / {m.c} {m.d} {m.ty}]</span>
                          </button>
                          <button onClick={() => setMatrixModal({ mode: 'rename', initial: m.name, target: m.name })}
                            title="Rename" className="text-ink-500 hover:text-cyanx text-[12px]">✎</button>
                          <button onClick={() => P.deleteMatrix(m.name)}
                            title="Delete" className="text-ink-500 hover:text-stop text-[12px]">✕</button>
                        </div>
                      );
                    })}
                    {matrices.length === 0 && <p className="text-[11px] text-ink-600">No presets saved yet.</p>}
                  </div>
                </Card>

                <LogCard title="Log" icon="❯" accent="#059669" defaultSize="collapsed"
                  right={
                    <button onClick={() => P.pushLog('sys', '— cleared —')}
                      className="text-[11px] text-ink-500 hover:text-ink-300">clear</button>
                  }>
                  <LogView log={log} />
                </LogCard>
              </>
            )}

            {/* ---- Autonomous tab ---- */}
            {tab === 'ai' && (
              <>
                <LogCard title="Job queue" icon="▦" accent="#0284c7" defaultSize="expanded"
                  right={
                    <div className="flex items-center gap-1">
                      <PauseButton paused={!!status?.paused} onPause={P.pause} onResume={P.resume} />
                      <StopButton onClick={P.stop} moving={moving} />
                      <ClearButton onClick={P.clearQueue} pending={status?.pending ?? 0} />
                    </div>
                  }>
                  <div className="flex flex-col h-full gap-4">
                    <div className="shrink-0">
                      <JobProgress status={status} />
                    </div>
                    <div className="h-px bg-ink-800 shrink-0" />
                    <div className="flex-1 min-h-0">
                      <JobList jobs={jobs} />
                    </div>
                  </div>
                </LogCard>

                <ScriptTab sendRaw={P.sendRaw} getPending={P.getPending} runCancelRef={P.runCancelRef} pushLog={P.pushLog} />

                <GcodeTab sendRaw={P.sendRaw} getPending={P.getPending} runCancelRef={P.runCancelRef} pushLog={P.pushLog} bounds={bounds} />

                <StudioTab sendRaw={P.sendRaw} getPending={P.getPending} runCancelRef={P.runCancelRef} pushLog={P.pushLog} bounds={bounds} />

                <LogCard title="Errors" icon="⚠" accent="#dc2626">
                  <ErrorsPanel log={log} />
                </LogCard>
              </>
            )}

            </div>{/* end tab panels */}
            </div>{/* end methods scroll region */}
          </div>
        </div>
        </div>
      </main>

      {paperModal && (
        <TextPromptModal
          title={paperModal.mode === 'save' ? 'Save current work area as paper' : 'Rename paper'}
          label="Paper name"
          initial={paperModal.initial}
          confirmText={paperModal.mode === 'save' ? 'Save' : 'Rename'}
          onCancel={() => setPaperModal(null)}
          onConfirm={(name) => {
            if (paperModal.mode === 'save') P.savePaper(name);
            else if (paperModal.target) P.renamePaper(paperModal.target, name);
            setPaperModal(null);
          }}
        />
      )}

      {matrixModal && (
        <TextPromptModal
          title={matrixModal.mode === 'save' ? 'Save current matrix as preset' : 'Rename matrix preset'}
          label="Preset name"
          initial={matrixModal.initial}
          confirmText={matrixModal.mode === 'save' ? 'Save' : 'Rename'}
          onCancel={() => setMatrixModal(null)}
          onConfirm={(name) => {
            if (matrixModal.mode === 'save') P.saveMatrix(name);
            else if (matrixModal.target) P.renameMatrix(matrixModal.target, name);
            setMatrixModal(null);
          }}
        />
      )}
    </div>
  );
}
