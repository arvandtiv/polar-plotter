import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  usePlotter,
  parseJsonScript,
  streamQueries,
  type SendResult,
  type StreamHealth,
  type ParsedLine,
  type GeneratorSpec,
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
  matrixToQuery,
  boundsToQuery,
  IDENTITY_PARAMS,
} from '../hooks/usePlotter';
import { apiGet } from '../lib/api';
import { digestGcode, type PenMode, type PlaceMode, type GcodeResult } from '../lib/gcode';
import { decodeBgcode } from '../lib/bgcode';
import { optimizeOrder, simplifyFrame, buildProgressPaths } from '../lib/toolpath';
import { compileFrame, expandGenerator } from '../lib/runPipeline';
import { computeCell, gridClearQueries } from '../lib/gridScript';
import type { Frame } from '../lib/frame';
import { listModules, getModule, defaultsOf } from '../lib/registry';
import { evaluate, type Layer, type LayerGroup } from '../lib/pipeline';
import { loadImageToGray } from '../lib/image';
import type { GrayImage } from '../lib/registry';
import type { VectorFont } from '../lib/textbox';
import { loadDocs as loadStudioDocs, saveDocs as saveStudioDocs, serializeDoc, parseDocFile, type StudioDoc } from '../lib/studioDoc';
import { exportGcode, DEFAULT_EXPORT } from '../lib/gcode-export';
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
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => onInput(Math.min(max, Math.max(min, parseFloat(e.target.value) || min)))}
            onBlur={(e) => onCommit(Math.min(max, Math.max(min, parseFloat(e.target.value) || min)))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
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
          onFocus={(e) => e.currentTarget.select()}   /* first keystroke replaces the old value */
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
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
  const vbX = -left - pad, vbY = -up - pad;
  const vbW = left + right + 2 * pad, vbH = up + down + 2 * pad;

  const gridStep = vbW > 800 ? 100 : 50;
  const gx: number[] = [], gy: number[] = [];
  for (let x = Math.ceil(-left / gridStep) * gridStep; x <= right; x += gridStep) gx.push(x);
  for (let y = Math.ceil(-up / gridStep) * gridStep; y <= down; y += gridStep) gy.push(y);

  const sw = vbW / 400;

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} className="w-full"
        style={{ aspectRatio: `${vbW} / ${vbH}`, display: 'block' }} preserveAspectRatio="xMidYMid meet">
        {bounds.shape === 'ellipse' ? (
          <>
            {/* faint bounding box (what the inputs edit) + the actual drawable ellipse */}
            <rect x={-left} y={-up} width={left + right} height={up + down}
              fill="none" stroke="#dce3ec" strokeWidth={sw} strokeDasharray={`${sw * 3} ${sw * 2}`} />
            <ellipse cx={(right - left) / 2} cy={(down - up) / 2} rx={(left + right) / 2} ry={(up + down) / 2}
              fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.5} />
          </>
        ) : (
          <rect x={-left} y={-up} width={left + right} height={up + down}
            fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.5} rx={sw} />
        )}
        {gx.map((x) => <line key={`gx${x}`} x1={x} y1={-up} x2={x} y2={down} stroke="#eef2f6" strokeWidth={sw * 0.6} />)}
        {gy.map((y) => <line key={`gy${y}`} x1={-left} y1={y} x2={right} y2={y} stroke="#eef2f6" strokeWidth={sw * 0.6} />)}
        <line x1={-left} y1={0} x2={right} y2={0} stroke="#cbd5e1" strokeWidth={sw} />
        <line x1={0} y1={-up} x2={0} y2={down} stroke="#cbd5e1" strokeWidth={sw} />
        <circle cx={0} cy={0} r={sw * 3} fill="none" stroke="#94a3b8" strokeWidth={sw} />
        <g>
          {moving && <circle cx={pen.x} cy={pen.y} r={sw * 9} fill={pen.down ? '#059669' : '#0284c7'} opacity="0.18" />}
          <circle cx={pen.x} cy={pen.y} r={sw * 4.5} fill={pen.down ? '#059669' : 'none'}
            stroke={pen.down ? '#059669' : '#0284c7'} strokeWidth={sw * 1.6} />
          <circle cx={pen.x} cy={pen.y} r={sw * 1.2} fill={pen.down ? '#ffffff' : '#0284c7'} />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] text-ink-600">
        <span className="absolute left-2 top-2">−Y {down}</span>
        <span className="absolute left-2 bottom-2">+Y {up}</span>
        <span className="absolute left-2 top-1/2 -translate-y-1/2">−X {left}</span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2">+X {right}</span>
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
        <input autoFocus value={val} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setVal(e.target.value)}
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
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => { onKey(e); if (e.key === 'Enter') e.currentTarget.blur(); }}
          onBlur={() => apply()}   /* Tab/click-away also takes effect */
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

function ChipInfoContent({ status }: { status: PlotterStatus | null }) {
  const m = status?.motion;
  const live = m ? [
    { label: 'Run current',  value: `${m.run_ma} mA`,       note: 'IRUN — active during motion' },
    { label: 'Hold current', value: `${m.hold_ma} mA`,      note: 'IHOLD — gondola must hold while idle' },
    { label: 'VMAX',         value: m.vmax.toLocaleString(), note: 'µsteps/s target velocity' },
    { label: 'AMAX',         value: m.amax.toLocaleString(), note: 'µsteps/s² peak acceleration' },
  ] : null;
  return (
    <>
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
    </>
  );
}

// ================================================================
//  Main App
// ================================================================
// ScriptTab — bulk CSV command entry
// ================================================================

// Bare-array format — paste directly into the textarea or load via "Load JSON" button.
// Also accepted: { "metadata": {...}, "commands": [...] } wrapper (klee-style composition files).
const SCRIPT_HINT = `[
  { "type": "pen", "position": "up" },
  { "type": "goto", "x": 0, "y": 0 },
  { "type": "circle", "cx": 0, "cy": 0, "r": 80 },
  { "type": "square", "cx": 0, "cy": 0, "size": 160, "fill_mode": 1 },
  { "type": "line", "x0": -80, "y0": 0, "x1": 80, "y1": 0, "cycles": 2 },
  { "type": "wobbly", "cx": 0, "cy": 50, "r": 60, "wobble": 0.4, "harmonics": 3 },
  { "type": "truchet", "n": 4, "spacing": 3, "angle": 45, "seed": 42 },
  { "type": "generate", "generator": "spirograph", "params": { "R": 80, "r": 30, "d": 50 } },
  { "type": "generate", "generator": "noiseOrbit", "params": { "numCircles": 20, "maxRadius": 100 },
    "warp": { "mode": "water", "params": { "amplitude": 10, "wavelength": 80 } } },
  { "type": "set_speed", "vmax": 150000 },
  { "type": "set_current", "run_ma": 400, "hold_ma": 200 },
  { "type": "bounds", "xn": -260, "xp": 260, "yn": -115, "yp": 273 },
  { "type": "matrix", "a": 1, "b": 0, "c": 0, "d": 1, "tx": 0, "ty": 0 },
  { "type": "speed", "vmax": 200000 },
  { "type": "home" }
]

// Grid-composition format (metadata provides work_area + grid for grid_select / grid_clear):
// {
//   "metadata": {
//     "work_area": { "x_min": -260, "x_max": 260, "y_min": -115, "y_max": 273 },
//     "grid": { "cols": 3, "rows": 2, "padding_mm": 5 }
//   },
//   "commands": [
//     { "type": "set_speed", "vmax": 150000 },
//     { "type": "grid_select", "col": 0, "row": 0 },
//     { "type": "generate", "generator": "spirograph", "params": { "R": 50, "r": 10, "d": 40 } },
//     { "type": "grid_select", "col": 1, "row": 0 },
//     { "type": "generate", "generator": "noiseOrbit", "params": { "numCircles": 8 } },
//     { "type": "grid_clear" },
//     { "type": "home" }
//   ]
// }`;

function plotterBounds(b: PlotterBounds) {
  return { left: b.left, right: b.right, up: b.up, down: b.down };
}

function ScriptTab({ sendRaw, sendAndWait, sendBatch, getPending, getHealth, runCancelRef, pushLog, bounds }: {
  sendRaw: (ep: string, json?: string) => Promise<SendResult>;
  sendAndWait: (ep: string, json?: string) => Promise<SendResult>;
  sendBatch: (queries: string[]) => Promise<{ accepted: number; rejected: number } | 'error'>;
  getPending: () => Promise<number | null>;
  getHealth: () => Promise<StreamHealth | null>;
  runCancelRef: React.MutableRefObject<boolean>;
  pushLog: (kind: 'cmd'|'ok'|'err'|'warn'|'sys'|'fw', text: string) => void;
  bounds: PlotterBounds;
}) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef(false);
  const [run, setRun] = useState<{ status: 'idle'|'running'|'done'; sent: number; errors: number; total: number }>({
    status: 'idle', sent: 0, errors: 0, total: 0,
  });

  const loadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setText(ev.target?.result as string ?? '');
      setRun({ status: 'idle', sent: 0, errors: 0, total: 0 });
    };
    reader.readAsText(file);
    e.target.value = '';   // reset so the same file can be re-loaded
  };

  const parsed = useMemo(
    () => parseJsonScript(text, { plotterBounds: bounds }),
    [text, bounds.left, bounds.right, bounds.up, bounds.down],
  );
  const good   = parsed.filter(l => l.query || l.generator || l.gridSelect || l.gridClear);
  const bad    = parsed.filter(l => l.error);

  const start = useCallback(async () => {
    if (!good.length) return;
    abortRef.current = false;
    runCancelRef.current = false;
    const cancelled = () => abortRef.current || runCancelRef.current;
    // Grid scripts must run strictly in order: grid_select → draw → next cell.
    // If we apply every grid_select first and queue all draws later, the matrix
    // ends up on the last cell and every circle lands in the same place.
    const gridMode = good.some(l => l.gridSelect);

    const runGridSelect = async (line: typeof good[0]) => {
      const { col, row, gc } = line.gridSelect!;
      const cell = computeCell(gc, col, row);
      pushLog('cmd', `> ${line.raw}`);
      const bw = await sendAndWait(cell.boundsQuery, line.raw);
      if (bw !== 'ok') { pushLog('err', `[script] grid_select bounds failed (${bw})`); return false; }
      const mw = await sendRaw(cell.matrixQuery, line.raw);
      if (mw !== 'ok') { pushLog('err', `[script] grid_select matrix failed (${mw})`); return false; }
      if (col === 0) pushLog('sys', `[script] row ${row}: cell (${col},${row}) active — ${cell.cellW}×${cell.cellH} mm`);
      return true;
    };

    const runGridClear = async (line: typeof good[0]) => {
      const q = gridClearQueries(line.gridClear!.gc);
      pushLog('cmd', `> ${line.raw}`);
      const bw = await sendAndWait(q.boundsQuery, line.raw);
      if (bw !== 'ok') { pushLog('err', `[script] grid_clear bounds failed (${bw})`); return false; }
      const mw = await sendRaw(q.matrixQuery, line.raw);
      if (mw !== 'ok') { pushLog('err', `[script] grid_clear matrix failed (${mw})`); return false; }
      pushLog('ok', '[script] grid cleared');
      return true;
    };

    if (gridMode) {
      let sent = 0, errors = 0;
      let gridTouched = false, gridCleared = false;
      const gridGc =
        good.find(l => l.gridSelect)?.gridSelect?.gc
        ?? good.find(l => l.gridClear)?.gridClear?.gc;
      setRun({ status: 'running', sent: 0, errors: 0, total: good.length });
      pushLog('cmd', `> script: grid mode — ${good.length} steps (flow-controlled draws)`);
      pushLog('sys', `[script] work area from Work Area tab: yn=${-bounds.up} yp=${bounds.down} (metadata.work_area ignored)`);

      // Pre-flight: check that draw commands fit inside the computed cell dimensions.
      // All cells in a uniform grid are the same size, so checking one is enough.
      const firstGs = good.find(l => l.gridSelect);
      if (firstGs) {
        try {
          const { cellW, cellH } = computeCell(firstGs.gridSelect!.gc, firstGs.gridSelect!.col, firstGs.gridSelect!.row);
          const maxR = Math.min(cellW, cellH) / 2;
          pushLog('sys', `[script] cell size ${cellW}×${cellH} mm — max safe radius = ${maxR.toFixed(1)} mm`);
          const oversized = good.find(l => {
            if (!l.query) return false;
            const p = new URLSearchParams(l.query.split('?')[1] ?? '');
            if (l.query.startsWith('circle?')) return Number(p.get('r') ?? 0) > maxR;
            if (l.query.startsWith('square?')) return Number(p.get('size') ?? 0) / 2 > maxR;
            return false;
          });
          if (oversized) {
            const p = new URLSearchParams(oversized.query!.split('?')[1] ?? '');
            const dim = oversized.query!.startsWith('circle?')
              ? `r=${p.get('r')} (needs ±${p.get('r')}mm)`
              : `size=${p.get('size')} (needs ±${(Number(p.get('size')) / 2).toFixed(1)}mm)`;
            pushLog('warn', `[script] ⚠ ${dim} won't fit in ${cellW}×${cellH} mm cells — firmware will reject these. Reduce size or use fewer grid cells.`);
          }
        } catch { /* computeCell throws on bad gc — already caught later */ }
      }

      // Draw commands are queued here and batch-streamed. sendAndWait(bounds) at each
      // grid_select / grid_clear acts as a FIFO barrier: bounds is queued after all pending
      // draws, so waiting for it implicitly means all previous draws have also completed.
      const pendingDraws: { query: string; raw: string }[] = [];
      const flushPendingDraws = async (): Promise<boolean> => {
        if (!pendingDraws.length || cancelled()) return !cancelled();
        const batch = pendingDraws.splice(0);
        const { stopped, errors: errs } = await streamQueries(
          batch,
          { sendRaw, sendBatch, getPending, getHealth, isCancelled: cancelled, pushLog, label: 'script',
            onProgress: () => setRun(r => ({ ...r, sent, errors })) },
        );
        errors += errs;
        setRun(r => ({ ...r, sent, errors }));
        return !stopped;
      };

      try {
        for (const line of good) {
          if (cancelled()) break;
          if (line.gridSelect) {
            if (!(await flushPendingDraws())) break;
            gridTouched = true;
            if (!(await runGridSelect(line))) break;
            sent++; setRun(r => ({ ...r, sent }));
            continue;
          }
          if (line.gridClear) {
            if (!(await flushPendingDraws())) break;
            gridCleared = true;
            if (!(await runGridClear(line))) break;
            sent++; setRun(r => ({ ...r, sent }));
            continue;
          }
          if (line.generator) {
            let queries: string[];
            try {
              queries = expandGenerator(line.generator, plotterBounds(bounds));
            } catch (e) {
              pushLog('err', `[script] generate "${line.generator.key}" failed: ${(e as Error).message}`);
              errors++; setRun(r => ({ ...r, errors }));
              continue;
            }
            pushLog('sys', `[script] generate "${line.generator.key}" → ${queries.length} commands`);
            for (const q of queries) pendingDraws.push({ query: q, raw: line.raw });
            sent++; setRun(r => ({ ...r, sent }));
            continue;
          }
          if (line.query) {
            pendingDraws.push({ query: line.query, raw: line.raw });
            sent++; setRun(r => ({ ...r, sent }));
          }
        }
        await flushPendingDraws();
      } finally {
        if (gridTouched && !gridCleared && gridGc) {
          pushLog('sys', '[script] grid cleanup — restoring full bounds + matrix identity');
          await flushPendingDraws();
          await runGridClear({ idx: -1, raw: '{"type":"grid_clear"}', gridClear: { gc: gridGc } });
        }
      }
      const stopped = cancelled();
      pushLog(stopped ? 'warn' : (errors === 0 ? 'ok' : 'warn'),
              stopped
                ? `[script] halted — ${sent - errors}/${good.length} completed`
                : `[script] done — ${sent - errors} completed` +
                  (errors ? `, ${errors} failed` : ', no failures'));
      setRun(r => ({ ...r, status: 'done' }));
      return;
    }

    // Non-grid scripts: expand generators, then flow-control the flat queue.
    const items: { query: string; raw: string }[] = [];
    for (const line of good) {
      if (line.generator) {
        let queries: string[];
        try {
          queries = expandGenerator(line.generator, plotterBounds(bounds));
        } catch (e) {
          pushLog('err', `[script] generate "${line.generator.key}" failed: ${(e as Error).message}`);
          continue;
        }
        pushLog('sys', `[script] generate "${line.generator.key}" → ${queries.length} commands`);
        for (const q of queries) items.push({ query: q, raw: line.raw });
      } else if (line.query) {
        items.push({ query: line.query, raw: line.raw });
      }
    }
    if (!items.length) { setRun(r => ({ ...r, status: 'done' })); return; }
    setRun({ status: 'running', sent: 0, errors: 0, total: items.length });
    pushLog('cmd', `> script: queuing ${items.length} commands (flow-controlled)`);
    const { sent, errors, stopped } = await streamQueries(
      items,
      { sendRaw, sendBatch, getPending, getHealth, isCancelled: cancelled, pushLog, label: 'script',
        onProgress: (s, e) => setRun(r => ({ ...r, sent: s, errors: e })) },
    );
    pushLog(stopped ? 'warn' : (errors === 0 ? 'ok' : 'warn'),
            stopped
              ? `[script] halted by STOP/CLEAR — ${sent}/${items.length} sent, ${items.length - sent} not queued`
              : `[script] done — ${sent - errors} queued` +
                (errors ? `, ${errors} rejected (NOT queue-full — check bounds/syntax)` : ', no rejections'));
    setRun(r => ({ ...r, status: 'done' }));
  }, [good, bounds, sendRaw, sendAndWait, sendBatch, getPending, getHealth, runCancelRef, pushLog]);

  const abort = useCallback(() => { abortRef.current = true; }, []);

  const pct = run.total ? Math.round((run.sent / run.total) * 100) : 0;

  return (
    <Card title="Script" icon="≡" accent="#0891b2" defaultCollapsed={false}>
      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={loadFile} />
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
            ? <span className="text-ink-600">paste JSON or load a .json file</span>
            : <><span className="text-ink-300 font-semibold">{good.length}</span> commands</>}
          {bad.length > 0 && <span className="ml-2 text-red-400 font-semibold">· {bad.length} error{bad.length > 1 ? 's' : ''}</span>}
        </span>
        <button
          className="ml-auto text-[11px] text-ink-500 hover:text-cyanx transition-colors"
          onClick={() => fileRef.current?.click()}
          title="Load a .json script file"
        >
          Load JSON
        </button>
        {text && (
          <button className="text-[11px] text-ink-600 hover:text-ink-400" onClick={() => { setText(''); setRun({ status: 'idle', sent: 0, errors: 0, total: 0 }); }}>
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
function FramePreview({ bounds, frame, contain = false }: { bounds: PlotterBounds; frame: Frame; contain?: boolean }) {
  const { left, right, up, down } = bounds;
  const pad = Math.max(20, (left + right) * 0.06);
  const vbX = -left - pad, vbY = -up - pad, vbW = left + right + 2 * pad, vbH = up + down + 2 * pad;
  const sw = vbW / 400;
  const CAP = 6000;   // guard against pathological path counts freezing the SVG
  const shown = frame.paths.slice(0, CAP);
  return (
    <div className={contain ? 'h-full w-full overflow-hidden' : 'rounded-lg border border-ink-800 bg-ink-950 overflow-hidden'}>
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        className={contain ? 'h-full w-full' : 'w-full'}
        style={contain ? { display: 'block' } : { aspectRatio: `${vbW} / ${vbH}`, display: 'block' }}
        preserveAspectRatio="xMidYMid meet">
        <rect x={-left} y={-up} width={left + right} height={up + down} fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.2} rx={sw} />
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
const newLayerId  = () => `L${Date.now().toString(36)}${(_layerSeq++).toString(36)}`;
const newGroupId  = () => `G${Date.now().toString(36)}${(_layerSeq++).toString(36)}`;

interface StudioData { layers: Layer[]; groups: LayerGroup[]; }

function loadStudioData(): StudioData {
  try {
    const raw = localStorage.getItem(STUDIO_KEY);
    if (!raw) return { layers: [], groups: [] };
    const parsed = JSON.parse(raw);
    // Migration: old format was a bare Layer[] array
    const rawLayers: unknown[] = Array.isArray(parsed) ? parsed : (parsed?.layers ?? []);
    const rawGroups: unknown[] = Array.isArray(parsed) ? [] : (parsed?.groups ?? []);
    const layers = rawLayers.flatMap((l): Layer[] => {
      if (!l || typeof (l as Layer).moduleKey !== 'string') return [];
      const x = l as Partial<Layer>;
      // Keep layer even if module is not registered yet — don't silently drop and
      // immediately overwrite localStorage with the shorter list.
      if (!x.moduleKey) return [];
      return [{ id: x.id || newLayerId(), moduleKey: x.moduleKey, params: x.params || {}, groupId: typeof x.groupId === 'string' ? x.groupId : undefined }];
    });
    const groups = rawGroups.flatMap((g): LayerGroup[] => {
      if (!g || typeof (g as LayerGroup).id !== 'string') return [];
      const x = g as Partial<LayerGroup>;
      return [{ id: x.id!, name: x.name ?? 'Group', tx: x.tx ?? 0, ty: x.ty ?? 0, rotateDeg: x.rotateDeg ?? 0 }];
    });
    return { layers, groups };
  } catch { /* ignore */ }
  return { layers: [], groups: [] };
}

function saveStudioData(layers: Layer[], groups: LayerGroup[]): void {
  // Guard: never save an empty stack over existing data (e.g. during SSR or a bad
  // re-render before localStorage has been read). Only save if we have layers, or if
  // the key is already empty/absent.
  try {
    if (layers.length === 0 && groups.length === 0) {
      const existing = localStorage.getItem(STUDIO_KEY);
      if (existing && existing !== '{"v":2,"layers":[],"groups":[]}') return;
    }
    localStorage.setItem(STUDIO_KEY, JSON.stringify({ v: 2, layers, groups }));
  } catch { /* ignore */ }
}

// v1.3: the Studio is its own full-page product — a layer STACK (generators + modifiers,
// evaluated bottom→top), a big live preview on the left, controls on the right. New
// modules appear in the Add picker automatically.
function StudioPage({ P, status, moving, bounds, topControls }: {
  P: ReturnType<typeof usePlotter>;
  status: PlotterStatus | null;
  moving: boolean;
  bounds: PlotterBounds;
  /** Cards rendered at the top of the right column, above the Design section
   *  (Work area boundaries + Affine matrix — built in App so they close over its state). */
  topControls?: React.ReactNode;
}) {
  const { sendRaw, sendBatch, getPending, getHealth, runCancelRef, pushLog } = P;
  const allMods = useMemo(() => listModules(), []);
  const makes = useMemo(() => listModules('make'), []);
  const [studioData] = useState<StudioData>(() => loadStudioData());
  const [layers, setLayers] = useState<Layer[]>(() => studioData.layers);
  const [groups, setGroups] = useState<LayerGroup[]>(() => studioData.groups);
  const [selId, setSelId] = useState<string>(() => studioData.layers[0]?.id ?? '');
  const [addKey, setAddKey] = useState<string>(makes[0]?.key ?? '');
  const [checkedLayerIds, setCheckedLayerIds] = useState<Set<string>>(new Set());
  const abortRef = useRef(false);
  const [run, setRun] = useState<{ status: 'idle'|'running'|'done'; sent: number; total: number; errors: number }>({
    status: 'idle', sent: 0, total: 0, errors: 0,
  });

  useEffect(() => { saveStudioData(layers, groups); }, [layers, groups]);

  // Source image for image modules (loaded in the UI, fed to evaluate via ctx.image).
  const [image, setImage] = useState<GrayImage | undefined>(undefined);
  const [imageName, setImageName] = useState('');
  const imgRef = useRef<HTMLInputElement>(null);
  const needsImage = layers.some((l) => getModule(l.moduleKey)?.group === 'Image');

  // Uploaded outline font for the Text module's "custom" font (fed to evaluate via ctx.font).
  const [font, setFont] = useState<VectorFont | undefined>(undefined);
  const [fontName, setFontName] = useState('');
  const fontRef = useRef<HTMLInputElement>(null);
  const needsFont = layers.some((l) => l.moduleKey === 'text' && l.params.font === 'custom');

  const sel = layers.find((l) => l.id === selId);
  const selGroup = groups.find((g) => g.id === selId);
  const selMod = sel ? getModule(sel.moduleKey) : undefined;

  const [orderPct, setOrderPct] = useState(100);   // drawing-order scrubber (% revealed)
  const [useArcs, setUseArcs] = useState(false);   // collapse circular runs to arc jobs (needs firmware flash)
  const frame = useMemo(
    () => evaluate(layers, { left: bounds.left, right: bounds.right, up: bounds.up, down: bounds.down }, groups, image, font),
    [layers, groups, bounds.left, bounds.right, bounds.up, bounds.down, image, font],
  );
  const optFrame = useMemo(() => optimizeOrder(simplifyFrame(frame)), [frame]);
  const queries = useMemo(
    () => compileFrame(frame, plotterBounds(bounds), { arcTol: useArcs ? 0.3 : undefined }),
    [frame, useArcs, bounds.left, bounds.right, bounds.up, bounds.down],
  );
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

  // ---- group operations ----
  const createGroup = (layerIds: string[]) => {
    const gid = newGroupId();
    const g: LayerGroup = { id: gid, name: 'Group', tx: 0, ty: 0, rotateDeg: 0 };
    setGroups((gs) => [...gs, g]);
    setLayers((ls) => ls.map((l) => (layerIds.includes(l.id) ? { ...l, groupId: gid } : l)));
    setCheckedLayerIds(new Set());
    setSelId(gid);
  };
  const disbandGroup = (gid: string) => {
    setGroups((gs) => gs.filter((g) => g.id !== gid));
    setLayers((ls) => ls.map((l) => (l.groupId === gid ? { ...l, groupId: undefined } : l)));
    if (selId === gid) setSelId('');
  };
  const removeFromGroup = (lid: string) =>
    setLayers((ls) => ls.map((l) => (l.id === lid ? { ...l, groupId: undefined } : l)));
  const updateGroup = (gid: string, key: keyof Omit<LayerGroup, 'id'>, val: string | number) =>
    setGroups((gs) => gs.map((g) => (g.id === gid ? { ...g, [key]: val } : g)));
  const toggleLayerCheck = (id: string) =>
    setCheckedLayerIds((s) => { const ns = new Set(s); if (ns.has(id)) ns.delete(id); else ns.add(id); return ns; });

  // ---- named documents (save/load/rename/delete + JSON export/import) ----
  const [docs, setDocs] = useState<StudioDoc[]>(() => loadStudioDocs());
  const [docName, setDocName] = useState('');
  const [docModal, setDocModal] = useState<{ mode: 'save' | 'rename'; initial: string; target?: string } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => { saveStudioDocs(docs); }, [docs]);

  const loadLayersFresh = (src: Layer[], srcGroups: LayerGroup[] = []) => {
    const fresh = src.map((l) => ({ id: newLayerId(), moduleKey: l.moduleKey, params: { ...l.params }, groupId: l.groupId }));
    // Remap group IDs to match the new layer IDs
    const idMap = new Map(src.map((l, i) => [l.id, fresh[i].id]));
    const freshGroups = srcGroups.map((g) => ({ ...g, id: newGroupId() }));
    const groupIdMap = new Map(srcGroups.map((g, i) => [g.id, freshGroups[i].id]));
    fresh.forEach((l) => { if (l.groupId) l.groupId = groupIdMap.get(l.groupId) ?? l.groupId; void idMap; });
    setLayers(fresh); setGroups(freshGroups); setSelId(fresh[0]?.id ?? ''); setRun((r) => ({ ...r, status: 'idle' }));
  };
  const saveDoc = (name: string) => {
    const doc: StudioDoc = {
      name,
      layers: layers.map((l) => ({ id: l.id, moduleKey: l.moduleKey, params: { ...l.params }, groupId: l.groupId })),
      groups: groups.map((g) => ({ ...g })),
    };
    setDocs((ds) => [...ds.filter((d) => d.name !== name), doc]); setDocName(name);
    pushLog('ok', `[studio] saved "${name}"`);
  };
  const loadDoc = (name: string) => { const d = docs.find((x) => x.name === name); if (d) { loadLayersFresh(d.layers, d.groups); pushLog('ok', `[studio] loaded "${name}"`); } };
  const renameDoc = (oldName: string, newName: string) => { if (newName.trim()) setDocs((ds) => ds.map((d) => (d.name === oldName ? { ...d, name: newName.trim() } : d))); setDocName(newName.trim()); };
  const deleteDoc = (name: string) => setDocs((ds) => ds.filter((d) => d.name !== name));
  const exportDoc = () => {
    const blob = new Blob([serializeDoc(docName || 'design', layers, groups)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${(docName || 'design').replace(/[^\w.-]+/g, '_')}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  const exportGcodeFile = () => {
    const text = exportGcode(optFrame);
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${(docName || 'design').replace(/[^\w.-]+/g, '_')}.gcode`; a.click(); URL.revokeObjectURL(a.href);
  };
  const importDoc = async (file: File) => {
    try { const d = parseDocFile(await file.text()); loadLayersFresh(d.layers, d.groups); setDocName(d.name); pushLog('ok', `[studio] imported "${d.name}" (${d.layers.length} layers, ${d.groups.length} groups)`); }
    catch (e) { pushLog('err', `[studio] import: ${(e as Error).message}`); }
  };

  const start = useCallback(async () => {
    abortRef.current = false; runCancelRef.current = false;
    setRun({ status: 'running', sent: 0, total: queries.length, errors: 0 });
    const layerNames = layers.map((l) => getModule(l.moduleKey)?.label ?? l.moduleKey).join(', ');
    const arcCount = queries.filter((q) => q.startsWith('arc?')).length;
    pushLog('cmd', `> studio: [${layerNames}] → ${queries.length} ops (${draws} lines, ${travels} travels${arcCount ? `, ${arcCount} arcs` : ''})`);
    const { sent, errors, stopped } = await streamQueries(
      queries.map((q) => ({ query: q })),
      { sendRaw, sendBatch, getPending, getHealth, isCancelled: () => abortRef.current || runCancelRef.current, pushLog, label: 'studio',
        onProgress: (s, e) => setRun((r) => ({ ...r, sent: s, errors: e })) },
    );
    pushLog(stopped ? 'warn' : (errors ? 'warn' : 'ok'),
      stopped ? `[studio] halted — ${sent}/${queries.length} sent`
              : `[studio] done — ${sent - errors} queued${errors ? `, ${errors} rejected` : ''}`);
    setRun((r) => ({ ...r, status: 'done' }));
  }, [queries, layers, draws, travels, sendRaw, getPending, getHealth, runCancelRef, pushLog]);

  const abort = useCallback(() => { abortRef.current = true; }, []);
  const pct = run.total ? Math.round((run.sent / run.total) * 100) : 0;
  const busy = run.status === 'running';

  return (
    <div className="mx-auto max-w-[1500px] px-4 py-4 sm:px-6 sm:py-6 lg:h-full">
      <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(0,1fr)_400px] lg:[grid-template-rows:minmax(0,1fr)]">

        {/* ====== LEFT: live preview canvas + run/scrub/machine controls ====== */}
        <div className="flex flex-col gap-4 lg:min-h-0">
          <div className="flex flex-col rounded-xl border border-ink-750 bg-ink-900 shadow-card p-4 lg:flex-1 lg:min-h-0">
            <div className="mb-3 flex items-center justify-between shrink-0">
              <h2 className="text-[13px] font-bold tracking-tight text-ink-100">Preview</h2>
              <span className="font-mono text-[11px] text-ink-500">{draws} draws · {travels} travels · {queries.length} ops</span>
            </div>
            <div className="aspect-[4/3] rounded-lg border border-ink-800 bg-ink-950 overflow-hidden lg:aspect-auto lg:flex-1 lg:min-h-0">
              <FramePreview bounds={bounds} frame={previewFrame} contain />
            </div>
            <div className="mt-3 flex items-center gap-3 shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 shrink-0">Order</span>
              <input type="range" min={0} max={100} step={1} value={orderPct} onChange={(e) => setOrderPct(Number(e.target.value))}
                className="flex-1" title="Scrub the drawing order" />
              <span className="w-10 text-right font-mono text-[11px] text-ink-500">{orderPct}%</span>
            </div>
          </div>

          {/* run + machine controls */}
          <div className="shrink-0 rounded-xl border border-ink-750 bg-ink-900 shadow-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              {!busy
                ? <Btn variant="go" onClick={start} disabled={draws === 0}>▶ Run</Btn>
                : <Btn variant="danger" onClick={abort}>Abort feed</Btn>}
              <Btn variant="default" onClick={resetSel} disabled={busy || !selMod}>⟲ Reset layer</Btn>
              <button onClick={() => setUseArcs((v) => !v)} disabled={busy}
                title="Collapse circular runs into single arc jobs (needs firmware with /api/arc — flash first)"
                className={`rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50 ${useArcs ? 'bg-cyanx/15 text-cyanx border border-cyanx/40' : 'text-ink-500 hover:text-ink-300 border border-ink-700'}`}>
                ◜ Arcs {useArcs ? 'on' : 'off'}
              </button>
              <div className="ml-auto flex items-center gap-1">
                <PauseButton paused={!!status?.paused} onPause={P.pause} onResume={P.resume} />
                <StopButton onClick={P.stop} moving={moving} />
                <ClearButton onClick={P.clearQueue} pending={status?.pending ?? 0} />
              </div>
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
          </div>
        </div>

        {/* ====== RIGHT: controls (scroll) ====== */}
        <div className="flex flex-col lg:min-h-0">
          <div className="rounded-xl border border-ink-750 bg-ink-900 shadow-card p-4 flex flex-col gap-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">

            {/* Machine setup — Work area + Affine, moved here above the design (collapsible) */}
            {topControls}

            {/* Documents */}
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Design</p>
              <div className="flex flex-wrap items-center gap-2">
                <select value={docName} onChange={(e) => setDocName(e.target.value)} disabled={busy}
                  className="flex-1 min-w-[120px] rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-[12px] text-ink-200 focus:outline-none focus:border-cyanx/50 disabled:opacity-50">
                  <option value="">— saved designs —</option>
                  {docs.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                </select>
                <Btn variant="default" onClick={() => docName && loadDoc(docName)} disabled={busy || !docName}>Load</Btn>
                <Btn variant="default" onClick={() => docName && setDocModal({ mode: 'rename', initial: docName, target: docName })} disabled={busy || !docName}>✎</Btn>
                <Btn variant="default" onClick={() => docName && deleteDoc(docName)} disabled={busy || !docName}>✕</Btn>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn variant="default" onClick={() => setDocModal({ mode: 'save', initial: docName })} disabled={busy || layers.length === 0}>💾 Save as…</Btn>
                <Btn variant="default" onClick={exportDoc} disabled={layers.length === 0}>⤓ Export</Btn>
                <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
                  onChange={(e) => { const fl = e.target.files?.[0]; e.target.value = ''; if (fl) importDoc(fl); }} />
                <Btn variant="default" onClick={() => importRef.current?.click()} disabled={busy}>⤒ Import</Btn>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Btn variant="go" onClick={start} disabled={draws === 0 || busy}>▶ Plot now</Btn>
                <Btn variant="default" onClick={exportGcodeFile} disabled={draws === 0}>⤓ Export .gcode</Btn>
              </div>
            </div>

            {/* Source image — only when an Image module is in the stack */}
            {needsImage && (
              <div className="flex items-center gap-2 border-t border-ink-800 pt-4">
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

            {/* Custom font — only when a Text layer is set to the uploaded "custom" font */}
            {needsFont && (
              <div className="flex items-center gap-2 border-t border-ink-800 pt-4">
                <input ref={fontRef} type="file" accept=".ttf,.otf" className="hidden"
                  onChange={async (e) => {
                    const fl = e.target.files?.[0]; e.target.value = '';
                    if (!fl) return;
                    // Lazy import: opentype.js resolves as CJS under SSR prerender but ESM in the
                    // browser bundle; loading it here (browser-only handler) avoids that mismatch.
                    try { const { parse } = await import('opentype.js'); setFont(parse(await fl.arrayBuffer()) as unknown as VectorFont); setFontName(fl.name); pushLog('ok', `[studio] font ${fl.name}`); }
                    catch (err) { pushLog('err', `[studio] font: ${(err as Error).message}`); }
                  }} />
                <Btn variant="primary" onClick={() => fontRef.current?.click()} disabled={busy}>🅰 Custom font…</Btn>
                {fontName ? <span className="font-mono text-[11px] text-ink-500 truncate max-w-[160px]">{fontName}</span>
                          : <span className="text-[11px] text-amber-400">load a .ttf / .otf (else uses Sans)</span>}
              </div>
            )}

            {/* Sequence (layer stack) — evaluated bottom→top; a modifier sees the layers below it. */}
            <div className="border-t border-ink-800 pt-4">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Sequence</p>
              <div className="space-y-1">
                {(() => {
                  const seenGroups = new Set<string>();
                  return layers.flatMap((l, i) => {
                    const m = getModule(l.moduleKey);
                    const active = l.id === selId;
                    const grp = l.groupId ? groups.find((g) => g.id === l.groupId) : undefined;
                    const rows: React.ReactNode[] = [];

                    // Insert group header on first encounter
                    if (grp && !seenGroups.has(grp.id)) {
                      seenGroups.add(grp.id);
                      const grpActive = selId === grp.id;
                      rows.push(
                        <div key={`grp-${grp.id}`} className={`rounded-t-md border-x border-t px-2 py-1 ${grpActive ? 'border-violet-500/40 bg-violet-500/10' : 'border-ink-700 bg-ink-800'}`}>
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => setSelId(grp.id)} className="flex-1 flex items-center gap-1.5 text-left">
                              <span className="text-[10px] text-ink-500">▼</span>
                              <input
                                type="text" value={grp.name}
                                onClick={(e) => { e.stopPropagation(); setSelId(grp.id); }}
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => updateGroup(grp.id, 'name', e.target.value)}
                                className="flex-1 bg-transparent text-[12px] font-semibold text-violet-300 outline-none min-w-0 focus:text-violet-200" />
                            </button>
                            <button onClick={() => disbandGroup(grp.id)} disabled={busy}
                              className="text-ink-500 hover:text-stop disabled:opacity-30 text-[11px]" title="Disband group">✕</button>
                          </div>
                          {/* Inline transform controls */}
                          <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap pb-1">
                            {(['tx','ty','rotateDeg'] as const).map((k) => (
                              <label key={k} className="flex items-center gap-1">
                                <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-500 w-6 text-right">
                                  {k === 'tx' ? 'X' : k === 'ty' ? 'Y' : 'R°'}
                                </span>
                                <input type="number" step={k === 'rotateDeg' ? 1 : 0.5}
                                  value={grp[k]}
                                  onFocus={(e) => e.currentTarget.select()}
                                  onChange={(e) => updateGroup(grp.id, k, parseFloat(e.target.value) || 0)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                                  className="w-16 rounded bg-ink-950 border border-ink-700 px-1.5 py-0.5 text-[11px] text-ink-100 font-mono focus:outline-none focus:border-violet-500/50" />
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    // Is this the last layer in its group?
                    const nextInGroup = grp && layers[i + 1]?.groupId === grp.id;
                    const rowBase = grp
                      ? `flex items-center gap-1.5 border-x px-2 py-1 pl-5 bg-ink-850 ${nextInGroup ? 'border-ink-700' : 'rounded-b-md border-b border-ink-700'}`
                      : `flex items-center gap-1.5 rounded-md border px-2 py-1 ${active ? 'border-cyanx/40 bg-cyanx/10' : 'border-ink-800 bg-ink-850'}`;

                    rows.push(
                      <div key={l.id} className={rowBase}>
                        {!grp && (
                          <input type="checkbox" checked={checkedLayerIds.has(l.id)}
                            onChange={() => toggleLayerCheck(l.id)}
                            className="accent-cyanx shrink-0" title="Select for grouping" />
                        )}
                        <button onClick={() => { setSelId(l.id); setCheckedLayerIds(new Set()); }}
                          className={`flex-1 text-left text-[12px] ${active ? 'text-cyanx' : 'text-ink-200 hover:text-cyanx'}`}>
                          {m?.label ?? l.moduleKey}
                          {m?.kind === 'modify' && <span className="ml-1 text-[10px] text-ink-500">modify</span>}
                        </button>
                        <button onClick={() => move(l.id, -1)} disabled={i === 0 || busy}
                          className="text-ink-500 hover:text-cyanx disabled:opacity-30 text-[12px]" title="Up">↑</button>
                        <button onClick={() => move(l.id, 1)} disabled={i === layers.length - 1 || busy}
                          className="text-ink-500 hover:text-cyanx disabled:opacity-30 text-[12px]" title="Down">↓</button>
                        {grp ? (
                          <button onClick={() => removeFromGroup(l.id)} disabled={busy}
                            className="text-ink-500 hover:text-amber-400 disabled:opacity-30 text-[11px]" title="Remove from group">⊗</button>
                        ) : (
                          <button onClick={() => removeLayer(l.id)} disabled={busy}
                            className="text-ink-500 hover:text-stop disabled:opacity-30 text-[12px]" title="Remove">✕</button>
                        )}
                      </div>
                    );

                    return rows;
                  });
                })()}
                {layers.length === 0 && <p className="text-[11px] text-ink-600">No layers — add one below.</p>}
              </div>

              {/* Group-selected button + add picker */}
              <div className="mt-2 flex flex-col gap-2">
                {checkedLayerIds.size >= 2 && (
                  <Btn variant="go" onClick={() => createGroup([...checkedLayerIds])}>
                    Group {checkedLayerIds.size} selected
                  </Btn>
                )}
                <div className="flex items-center gap-2">
                  <select value={addKey} onChange={(e) => setAddKey(e.target.value)} disabled={busy}
                    className="flex-1 rounded bg-ink-900 border border-ink-700 px-2 py-1.5 text-[12px] text-ink-200 focus:outline-none focus:border-cyanx/50 disabled:opacity-50">
                    {allMods.map((m) => <option key={m.key} value={m.key}>{m.label}{m.kind === 'modify' ? ' · modify' : ''}</option>)}
                  </select>
                  <Btn variant="default" onClick={addLayer} disabled={busy}>+ Add</Btn>
                </div>
              </div>
            </div>

            {/* Selected layer's parameters — hidden when a group header is selected */}
            {sel && selMod && !selGroup && (
              <div className="border-t border-ink-800 pt-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">{selMod.label}</p>
                {selMod.description && <p className="mb-3 text-[11px] leading-relaxed text-ink-500">{selMod.description}</p>}
                <ParamPanel sections={selMod.sections} values={sel.params} onChange={setParam} />
              </div>
            )}
          </div>
        </div>
      </div>

      {docModal && (
        <TextPromptModal
          title={docModal.mode === 'save' ? 'Save current design as…' : 'Rename design'}
          label="Design name" initial={docModal.initial}
          confirmText={docModal.mode === 'save' ? 'Save' : 'Rename'}
          onCancel={() => setDocModal(null)}
          onConfirm={(name) => {
            if (name.trim()) { if (docModal.mode === 'save') saveDoc(name.trim()); else if (docModal.target) renameDoc(docModal.target, name); }
            setDocModal(null);
          }} />
      )}
    </div>
  );
}

function GcodeTab({ sendRaw, sendBatch, getPending, getHealth, runCancelRef, pushLog, bounds }: {
  sendRaw: (ep: string, json?: string) => Promise<SendResult>;
  sendBatch: (queries: string[]) => Promise<{ accepted: number; rejected: number } | 'error'>;
  getPending: () => Promise<number | null>;
  getHealth: () => Promise<StreamHealth | null>;
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
      { sendRaw, sendBatch, getPending, getHealth, isCancelled: cancelled, pushLog, label: 'gcode',
        onProgress: (s, e) => setRun((r) => ({ ...r, sent: s, errors: e })) },
    );
    pushLog(stopped ? 'warn' : (errors === 0 ? 'ok' : 'warn'),
            stopped
              ? `[gcode] halted by STOP/CLEAR — ${sent}/${result.queries.length} sent`
              : `[gcode] done — ${sent - errors} queued` + (errors ? `, ${errors} rejected` : ''));
    setRun((r) => ({ ...r, status: 'done' }));
  }, [result, sendRaw, getPending, getHealth, runCancelRef, pushLog]);

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

// ---- Grid tiling state -------------------------------------------------------

interface GridState {
  cols: number;
  rows: number;
  paddingMm: number;
  selCol: number;
  selRow: number;
  active: boolean;
  fullBounds: PlotterBounds | null;
}

const GRID_KEY = 'plotterGrid';
const GRID_DEFAULTS: GridState = { cols: 2, rows: 2, paddingMm: 5, selCol: 0, selRow: 0, active: false, fullBounds: null };

function loadGrid(): GridState {
  try {
    const raw = localStorage.getItem(GRID_KEY);
    if (raw) { const g = JSON.parse(raw); return { ...GRID_DEFAULTS, ...g }; }
  } catch { /* ignore */ }
  return { ...GRID_DEFAULTS };
}

function saveGrid(g: GridState): void {
  try { localStorage.setItem(GRID_KEY, JSON.stringify(g)); } catch { /* ignore */ }
}

/** Returns the cell centre (cx, cy in global coords) and cell dimensions for grid cell (col, row). */
function cellGeom(g: GridState, fb: PlotterBounds, col: number, row: number) {
  const tw = fb.left + fb.right;
  const th = fb.up   + fb.down;
  const cellW = (tw - (g.cols - 1) * g.paddingMm) / g.cols;
  const cellH = (th - (g.rows - 1) * g.paddingMm) / g.rows;
  const lx = -fb.left + col * (cellW + g.paddingMm);
  const ty = -fb.up   + row * (cellH + g.paddingMm);
  return { cellW, cellH, cx: lx + cellW / 2, cy: ty + cellH / 2 };
}

// ------------------------------------------------------------------------------

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
  const [view, setView]     = useState<'console' | 'studio'>('console');
  const [showHwInfo, setShowHwInfo] = useState(false);
  const [paperModal, setPaperModal] = useState<{ mode: 'save' | 'rename'; initial: string; target?: string } | null>(null);
  const [matrixModal, setMatrixModal] = useState<{ mode: 'save' | 'rename'; initial: string; target?: string } | null>(null);

  // Grid tiling
  const [grid, setGridState] = useState<GridState>(() => loadGrid());
  useEffect(() => { saveGrid(grid); }, [grid]);

  const applyGridCell = useCallback(async (col: number, row: number) => {
    const fb = grid.active ? grid.fullBounds! : bounds;   // full work area bounds
    const { cellW, cellH, cx, cy } = cellGeom(grid, fb, col, row);
    const cellBounds: PlotterBounds = { left: cellW / 2, right: cellW / 2, up: cellH / 2, down: cellH / 2, shape: 'rect' };
    const newGrid: GridState = { ...grid, selCol: col, selRow: row, active: true, fullBounds: grid.active ? grid.fullBounds : bounds };
    setGridState(newGrid);
    P.setBounds(cellBounds);
    if (P.ip) {
      // 1. Lift pen first (queued — ensures pen is up before cell transition).
      // 2. Wait for bounds change (queued after pen-up) — this acts as a FIFO barrier:
      //    all prior draws complete before done >= bounds_id, so the pen is guaranteed
      //    to be up and idle when the matrix switches.
      // 3. Apply matrix immediately (safe now — firmware queue is empty).
      try {
        await P.sendRaw('pen?pos=up');
        await P.sendAndWait(boundsToQuery(cellBounds));
        await apiGet(P.ip, matrixToQuery({ a: 1, b: 0, c: 0, d: 1, tx: cx, ty: cy }));
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, bounds, P.ip, P.sendRaw, P.sendAndWait]);

  const clearGridCell = useCallback(async () => {
    const fb = grid.fullBounds ?? bounds;
    setGridState((g) => ({ ...g, active: false, fullBounds: null }));
    P.setBounds(fb);
    if (P.ip) {
      try {
        await P.sendRaw('pen?pos=up');
        await P.sendAndWait(boundsToQuery(fb));
        await apiGet(P.ip, matrixToQuery(IDENTITY_PARAMS));
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.fullBounds, bounds, P.ip, P.sendRaw, P.sendAndWait]);

  const fg = f(gotoF, setGoto);
  const fc = f(circle, setCircle);
  const fs = f(square, setSquare);
  const fl = f(lineF, setLine);
  const fw = f(wobbly, setWobbly);
  const ft = f(truchet, setTruchet);
  const fca = f(calib, setCalib);

  return (
    <div className="min-h-screen flex flex-col bg-ink-950 text-ink-300 lg:h-screen lg:overflow-hidden">
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
              <button onClick={() => setShowHwInfo(true)}
                className="hidden font-mono text-[11px] text-ink-500 hover:text-cyanx transition-colors sm:block">
                V-plotter console · Pico 2 W · TMC5072
              </button>
            </div>
          </div>
          {/* product switcher: Console (v1.2 panels) vs Studio (full-page design app) */}
          <div className="flex rounded-xl border border-ink-750 bg-ink-900 shadow-card p-1">
            {([['console', 'Console'], ['studio', 'Studio']] as ['console' | 'studio', string][]).map(([id, lbl]) => (
              <button key={id} onClick={() => setView(id)}
                className={`rounded-lg px-4 py-1.5 text-[12px] font-semibold transition-colors ${view === id ? 'bg-ink-800 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>{lbl}</button>
            ))}
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

      <main className="flex-1 overflow-y-auto lg:min-h-0 lg:overflow-hidden">
        {view === 'studio' ? (
          <StudioPage P={P} status={status} moving={moving} bounds={bounds}
            topControls={(
              <>
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

                  {/* ---- Grid tiling ---- */}
                  <div className="my-4 h-px bg-ink-800" />
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Grid tiling</p>
                  <p className="mb-3 text-[11px] leading-relaxed text-ink-500">
                    Subdivide the work area into cells. Selecting a cell remaps <span className="font-mono text-ink-300">(0,0)</span> to its
                    centre and clips all jobs to its bounds.
                  </p>

                  {/* Active cell banner */}
                  {grid.active && (
                    <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                      <span className="flex-1 text-[11px] font-semibold text-amber-300">
                        Cell col {grid.selCol + 1} · row {grid.selRow + 1} active
                        {grid.fullBounds && <span className="ml-2 font-normal text-amber-500/70">
                          ({Math.round(grid.fullBounds.left + grid.fullBounds.right)}×{Math.round(grid.fullBounds.up + grid.fullBounds.down)} mm full area)
                        </span>}
                      </span>
                      <Btn onClick={clearGridCell}>↩ Full area</Btn>
                    </div>
                  )}

                  {/* Cols / Rows / Padding */}
                  <div className="mb-3 grid grid-cols-3 gap-3">
                    <FieldInline label="Cols" value={grid.cols} min={1} max={12} step={1}
                      onChange={(v) => setGridState((g) => ({ ...g, cols: Math.max(1, Math.round(v as number)) }))} />
                    <FieldInline label="Rows" value={grid.rows} min={1} max={12} step={1}
                      onChange={(v) => setGridState((g) => ({ ...g, rows: Math.max(1, Math.round(v as number)) }))} />
                    <FieldInline label="Gap" unit="mm" value={grid.paddingMm} min={0} max={50} step={0.5}
                      onChange={(v) => setGridState((g) => ({ ...g, paddingMm: Math.max(0, v as number) }))} />
                  </div>

                  {/* Visual cell picker */}
                  {(() => {
                    const fb = grid.active ? grid.fullBounds! : bounds;
                    const tw = fb.left + fb.right;
                    const th = fb.up + fb.down;
                    // Show cell dimensions in the picker tooltip
                    const cellW = Math.round((tw - (grid.cols - 1) * grid.paddingMm) / grid.cols);
                    const cellH = Math.round((th - (grid.rows - 1) * grid.paddingMm) / grid.rows);
                    return (
                      <div>
                        <div className="inline-grid gap-1 w-full"
                          style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))` }}>
                          {Array.from({ length: grid.rows * grid.cols }).map((_, i) => {
                            const col = i % grid.cols;
                            const row = Math.floor(i / grid.cols);
                            const isActive = grid.active && grid.selCol === col && grid.selRow === row;
                            return (
                              <button key={`${col}-${row}`}
                                onClick={() => applyGridCell(col, row)}
                                title={`Col ${col + 1}, Row ${row + 1} · ${cellW}×${cellH} mm`}
                                className={`h-9 rounded border text-[10px] font-mono transition-colors ${
                                  isActive
                                    ? 'border-cyanx bg-cyanx/20 text-cyanx font-bold'
                                    : 'border-ink-700 bg-ink-900 text-ink-500 hover:border-cyanx/50 hover:bg-ink-850 hover:text-ink-200'
                                }`}>
                                {col + 1},{row + 1}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-1 text-[10px] text-ink-600">
                          Each cell ≈ {cellW} × {cellH} mm · click a cell to activate
                        </p>
                      </div>
                    );
                  })()}
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
              </>
            )}
          />
        ) : (
        <div className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6 lg:h-full">
        <div className="grid grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:[grid-template-rows:minmax(0,1fr)]">

          {/* ====== LEFT: machine state ====== */}
          <div className="space-y-4 lg:overflow-y-auto">
            <Card title="Position" icon="◎" accent="#0284c7" defaultCollapsed={false} right={
              <span className={`font-mono text-[12px] ${pen.down ? 'text-go' : 'text-ink-500'}`}>{pen.down ? '▼ pen down' : '△ pen up'}</span>
            }>
              {/* Quick controls — jog + home/pen pinned to the top for fast access */}
              <div className="mb-4 space-y-3">
                <div>
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Jog</p>
                  <JogPad onJog={(dx, dy) => {
                    const nx = pen.x + dx, ny = pen.y + dy;
                    setGoto({ x: nx, y: ny });
                    P.enqueue({ type: 'goto', x: nx, y: ny });
                  }} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Btn variant="primary"  onClick={() => P.enqueue({ type: 'home' })}>⌂ Home</Btn>
                  <Btn                    onClick={() => P.enqueue({ type: 'sethome' })}>Set Home</Btn>
                  <Btn variant={pen.down ? 'default' : 'go'} onClick={() => P.enqueue({ type: 'pen', pos: 'up' })}>Pen Up</Btn>
                  <Btn variant={pen.down ? 'go' : 'default'} onClick={() => P.enqueue({ type: 'pen', pos: 'down' })}>Pen Down</Btn>
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
              </div>
              <PlotterCanvas bounds={bounds} pen={pen} moving={moving} />
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Readout label="X" value={pen.x.toFixed(1)} unit="mm" />
                <Readout label="Y" value={pen.y.toFixed(1)} unit="mm" />
                <Readout label="Pending" value={status?.pending ?? 0} unit="job" />
                <Readout label="Done" value={status?.done ?? 0} unit="" />
              </div>
              {(Math.abs(matrix.tx) > 0.5 || Math.abs(matrix.ty) > 0.5) && (
                <div className="mt-2 rounded border border-amber-700/50 bg-amber-950/40 px-2.5 py-1.5 text-[11px] text-amber-200">
                  Affine offset active (tx={matrix.tx.toFixed(1)}, ty={matrix.ty.toFixed(1)}) — position is cell-local.
                  Click <button type="button" className="underline hover:text-amber-100" onClick={() => P.resetMatrix()}>↺ Identity</button> or Home to reset.
                </div>
              )}
              {/* Current job — its exact JSON while running (console + Script tab), else idle. */}
              <div className="mt-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Current job</div>
                <div className={`rounded-md border border-ink-800 bg-ink-950 px-2.5 py-1.5 font-mono text-[11px] break-all ${P.currentJob ? 'text-cyanx' : 'text-ink-600'}`}>
                  {P.currentJob || '— idle —'}
                </div>
              </div>

              {/* Driver health — inline, no extra card wrapper */}
              <div className="mt-3">
                <DriverBanner status={status} onClearFault={P.clearFault} />
              </div>

              {/* Move to point */}
              <div className="mt-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Move to point</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <FieldInline label="X" unit="mm" value={gotoF.x} onChange={fg('x') as (v: number) => void} />
                  <FieldInline label="Y" unit="mm" value={gotoF.y} onChange={fg('y') as (v: number) => void} />
                  <Btn variant="primary" className="col-span-2 sm:col-span-1"
                    onClick={() => P.enqueue({ type: 'goto', ...gotoF })}>Go →</Btn>
                </div>
              </div>

            </Card>

          </div>

          {/* ====== RIGHT: controls ======
               Single top-aligned scroll column. The tab bar pins to the top;
               below it the active tab's method cards flow and the Log card sits
               directly after them (no bottom gap). The scroll region is flex-col
               so the Log can flex-1 to absorb any leftover height when the method
               cards are short, while keeping a usable min height and scrolling
               the whole region when content overflows. */}
          <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
            {/* Tab bar */}
            <div className="shrink-0 flex gap-1 rounded-xl border border-ink-750 bg-ink-900 shadow-card p-1">
              {([['area','Calibration'],['draw','Draw'],['ai','Autonomous']] as [Tab,string][]).map(([id, lbl]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors ${tab === id ? 'bg-ink-800 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>{lbl}</button>
              ))}
            </div>

            {/* Methods + Log scroll region (flows top→bottom) */}
            <div className="flex flex-col gap-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
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

            {/* ---- Work area tab (work area + calibration) ---- */}
            {tab === 'area' && (
              <>
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

                <LogCard title="Log" icon="❯" accent="#059669" defaultSize="minimized"
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

                <ScriptTab sendRaw={P.sendRaw} sendAndWait={P.sendAndWait} sendBatch={P.sendBatch} getPending={P.getPending} getHealth={P.getHealth} runCancelRef={P.runCancelRef} pushLog={P.pushLog} bounds={bounds} />

                <GcodeTab sendRaw={P.sendRaw} sendBatch={P.sendBatch} getPending={P.getPending} getHealth={P.getHealth} runCancelRef={P.runCancelRef} pushLog={P.pushLog} bounds={bounds} />

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
        )}
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

      {/* Hardware info popup — triggered by clicking the header subtitle */}
      {showHwInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setShowHwInfo(false)}>
          <div className="w-full max-w-lg rounded-2xl border border-ink-750 bg-ink-900 shadow-2xl overflow-y-auto max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-ink-800">
              <div className="flex items-center gap-2">
                <span className="text-[13px]" style={{ color: '#7c3aed' }}>⚙</span>
                <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-400">Hardware · TMC5072</h2>
              </div>
              <button onClick={() => setShowHwInfo(false)}
                className="text-ink-500 hover:text-ink-200 text-[18px] leading-none px-1">×</button>
            </div>
            <div className="p-5">
              <ChipInfoContent status={status} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
