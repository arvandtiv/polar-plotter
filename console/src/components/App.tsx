import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  usePlotter,
  parseJsonScript,
  type ParsedLine,
  type PlotterBounds,
  type MotionParams,
  type FillMode,
  type PlotCmd,
  type Stroke,
  type PenState,
  type LogEntry,
  type PlotterStatus,
  type JobEntry,
  DEFAULTS,
  TRUCHET_MOTIF_NAMES,
  TRUCHET_DEFAULT_MASK,
} from '../hooks/usePlotter';

// ================================================================
//  Primitives
// ================================================================

function Card({ title, icon, accent = '#0284c7', right, children, className = '',
  collapsible = false, defaultCollapsed = false, collapsed: collapsedProp, onToggle }: {
  title?: string; icon?: string; accent?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
  collapsible?: boolean; defaultCollapsed?: boolean;
  collapsed?: boolean; onToggle?: () => void;
}) {
  const isFlexCol = className.includes('flex-col');
  const [collapsedState, setCollapsedState] = useState(defaultCollapsed);
  const controlled = collapsedProp !== undefined;
  const collapsed = controlled ? collapsedProp : collapsedState;
  const toggle = controlled ? onToggle : () => setCollapsedState((c) => !c);
  const isCollapsed = collapsible && collapsed;
  return (
    <section className={`rounded-xl border border-ink-750 bg-ink-900 shadow-card ${isCollapsed ? '!flex-none' : ''} ${className}`}>
      {title && (
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-800 shrink-0">
          <button
            type="button"
            onClick={collapsible ? toggle : undefined}
            disabled={!collapsible}
            className={`flex items-center gap-2 -mx-1 px-1 rounded ${collapsible ? 'cursor-pointer hover:text-ink-200' : 'cursor-default'}`}
          >
            {collapsible && (
              <span className={`text-ink-600 text-[10px] transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>▾</span>
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

function StopButton({ onClick, moving }: { onClick: () => void; moving: boolean }) {
  return (
    <button onClick={onClick}
      className="group relative flex items-center gap-2.5 px-5 py-2.5 rounded-xl border-2 border-stop/60 bg-stop/15 hover:bg-stop/25 text-stop font-bold tracking-wide transition-all active:scale-95"
    >
      {moving && <span className="absolute left-4 h-3 w-3 rounded-full bg-stop blink" />}
      <span className={`inline-block h-3 w-3 ${moving ? 'opacity-0' : ''} bg-stop`} style={{ borderRadius: 2 }} />
      <span className="text-[15px]">STOP</span>
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

function PlotterCanvas({ bounds, pen, paths, activePath, moving }: {
  bounds: PlotterBounds; pen: PenState; paths: Stroke[]; activePath: Stroke | null; moving: boolean;
}) {
  const { left, right, up, down } = bounds;
  const pad = Math.max(20, (left + right) * 0.06);
  const vbX = -left - pad, vbY = -up - pad;
  const vbW = left + right + 2 * pad, vbH = up + down + 2 * pad;
  const py = (y: number) => -y;  // +Y up in display, +Y down in firmware

  const gridStep = vbW > 800 ? 100 : 50;
  const gx: number[] = [], gy: number[] = [];
  for (let x = Math.ceil(-left / gridStep) * gridStep; x <= right; x += gridStep) gx.push(x);
  for (let y = Math.ceil(-down / gridStep) * gridStep; y <= up; y += gridStep) gy.push(y);

  const toPoly = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${py(p.y)}`).join(' ');
  const sw = vbW / 400;

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} className="w-full"
        style={{ aspectRatio: `${vbW} / ${vbH}`, display: 'block' }} preserveAspectRatio="xMidYMid meet">
        {bounds.shape === 'ellipse' ? (
          <>
            {/* faint bounding box (what the inputs edit) + the actual drawable ellipse */}
            <rect x={-left} y={py(up)} width={left + right} height={up + down}
              fill="none" stroke="#dce3ec" strokeWidth={sw} strokeDasharray={`${sw * 3} ${sw * 2}`} />
            <ellipse cx={(right - left) / 2} cy={(down - up) / 2} rx={(left + right) / 2} ry={(up + down) / 2}
              fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.5} />
          </>
        ) : (
          <rect x={-left} y={py(up)} width={left + right} height={up + down}
            fill="#ffffff" stroke="#cbd5e1" strokeWidth={sw * 1.5} rx={sw} />
        )}
        {gx.map((x) => <line key={`gx${x}`} x1={x} y1={py(up)} x2={x} y2={py(-down)} stroke="#eef2f6" strokeWidth={sw * 0.6} />)}
        {gy.map((y) => <line key={`gy${y}`} x1={-left} y1={py(y)} x2={right} y2={py(y)} stroke="#eef2f6" strokeWidth={sw * 0.6} />)}
        <line x1={-left} y1={0} x2={right} y2={0} stroke="#cbd5e1" strokeWidth={sw} />
        <line x1={0} y1={py(up)} x2={0} y2={py(-down)} stroke="#cbd5e1" strokeWidth={sw} />
        {paths.map((pa, i) => (
          <polyline key={i} points={toPoly(pa.points)} fill="none" stroke={pa.color}
            strokeWidth={sw * 1.4} strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
        ))}
        {activePath && (
          <polyline points={toPoly(activePath.points)} fill="none" stroke={activePath.color}
            strokeWidth={sw * 1.8} strokeLinejoin="round" strokeLinecap="round" />
        )}
        <circle cx={0} cy={0} r={sw * 3} fill="none" stroke="#94a3b8" strokeWidth={sw} />
        <g>
          {moving && <circle cx={pen.x} cy={py(pen.y)} r={sw * 9} fill={pen.down ? '#059669' : '#0284c7'} opacity="0.18" />}
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 4.5} fill={pen.down ? '#059669' : 'none'}
            stroke={pen.down ? '#059669' : '#0284c7'} strokeWidth={sw * 1.6} />
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 1.2} fill={pen.down ? '#ffffff' : '#0284c7'} />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] text-ink-600">
        <span className="absolute left-2 top-2">+Y {up}</span>
        <span className="absolute left-2 bottom-2">−Y {down}</span>
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
// Work-area presets: X is fixed at ±240mm; Y grows through 5 sizes.
const BOUNDS_PRESETS = [
  { label: '±100', up: 100, down: 100, left: 240, right: 240 },
  { label: '±200', up: 200, down: 200, left: 240, right: 240 },
  { label: '±300', up: 300, down: 300, left: 240, right: 240 },
  { label: '±350', up: 350, down: 350, left: 240, right: 240 },
  { label: '±400', up: 400, down: 400, left: 240, right: 240 },
] as const;

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

  const applyPreset = (p: typeof BOUNDS_PRESETS[number]) => {
    if (refs.up.current)    refs.up.current.value    = String(p.up);
    if (refs.down.current)  refs.down.current.value  = String(p.down);
    if (refs.left.current)  refs.left.current.value  = String(p.left);
    if (refs.right.current) refs.right.current.value = String(p.right);
    const nb: PlotterBounds = { up: p.up, down: p.down, left: p.left, right: p.right, shape };
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
      {/* ---- Presets: Y grows, X stays ±240 ---- */}
      <div>
        <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          Presets — X ±240 mm, Y grows
        </span>
        <div className="flex gap-1">
          {BOUNDS_PRESETS.map((p) => {
            const active = bounds.up === p.up && bounds.down === p.down
                        && bounds.left === p.left && bounds.right === p.right;
            return (
              <button key={p.label} onClick={() => applyPreset(p)}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-mono font-semibold transition-colors
                  ${active
                    ? 'bg-cyanx text-white'
                    : 'bg-ink-850 border border-ink-700 text-ink-400 hover:border-cyanx/40 hover:text-cyanx'}`}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {row(refs.up,    'Up  (+Y)',   bounds.up)}
      {row(refs.down,  'Down (−Y)',  bounds.down)}
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
    <div ref={ref} className="h-[100px] overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed">
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
        <Arrow dx={0}  dy={1}  char="↑" cls="col-start-2 row-start-1" />
        <Arrow dx={-1} dy={0}  char="←" cls="col-start-1 row-start-2" />
        <div className="col-start-2 row-start-2 flex items-center justify-center font-mono text-[10px] text-ink-600">{step}mm</div>
        <Arrow dx={1}  dy={0}  char="→" cls="col-start-3 row-start-2" />
        <Arrow dx={0}  dy={-1} char="↓" cls="col-start-2 row-start-3" />
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
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${fault ? 'border-stop/60 bg-stop/10' : 'border-go/40 bg-go/[0.06]'}`}>
      <span className="relative flex h-3 w-3 shrink-0">
        {fault && <span className="absolute inline-flex h-full w-full rounded-full bg-stop opacity-70 blink" />}
        <span className={`relative inline-flex h-3 w-3 rounded-full ${status == null ? 'bg-ink-600' : fault ? 'bg-stop' : 'bg-go'}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[12px] font-semibold uppercase tracking-wider ${status == null ? 'text-ink-500' : fault ? 'text-stop' : 'text-go'}`}>
          {status == null ? 'Driver — no data' : fault ? 'Driver fault' : 'Driver healthy'}
        </div>
        {fault && <div className="font-mono text-[12.5px] text-ink-200 break-words">{status?.drvFlags}</div>}
      </div>
      {fault && (
        <button onClick={onClearFault}
          className="shrink-0 rounded-lg border border-stop/50 bg-stop/15 px-3 py-1.5 text-[12px] font-semibold text-stop hover:bg-stop/25 transition-colors active:scale-[.97]">
          Clear fault
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
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [jobs.length]);
  if (!jobs.length) return <p className="text-[12px] text-ink-500">No jobs yet. Queue work from the MCP or the Draw tab.</p>;
  const dot = (s: JobEntry['state']) => (s === 'done' ? '✓' : s === 'doing' ? '▶' : '○');
  const cls = (s: JobEntry['state']) => (s === 'done' ? 'text-go' : s === 'doing' ? 'text-warn' : 'text-ink-600');
  return (
    <div ref={ref} className="h-[100px] space-y-0.5 overflow-y-auto font-mono text-[12.5px]">
      {jobs.map((j) => (
        <div key={j.id} className={`flex items-center gap-2 rounded-md px-2 py-1 ${j.state === 'doing' ? 'bg-warn/10' : ''}`}>
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
    <div ref={ref} className="h-[100px] overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed">
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

function ScriptTab({ sendRaw, pushLog }: {
  sendRaw: (ep: string) => Promise<boolean>;
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
    setRun({ status: 'running', sent: 0, errors: 0, total: good.length });
    pushLog('cmd', `> script: queuing ${good.length} commands`);
    let errors = 0;
    for (let i = 0; i < good.length; i++) {
      if (abortRef.current) break;
      const ok = await sendRaw(good[i].query!);
      if (!ok) errors++;
      setRun(r => ({ ...r, sent: i + 1, errors }));
    }
    pushLog(errors === 0 ? 'ok' : 'warn', `[script] queued ${good.length} commands, ${errors} errors`);
    setRun(r => ({ ...r, status: 'done' }));
  }, [good, sendRaw, pushLog]);

  const abort = useCallback(() => { abortRef.current = true; }, []);

  const pct = run.total ? Math.round((run.sent / run.total) * 100) : 0;

  return (
    <Card title="Script" icon="≡" accent="#0891b2">
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

type Tab = 'draw' | 'jog' | 'area' | 'calib' | 'ai' | 'script';
const f = <T extends object>(obj: T, set: React.Dispatch<React.SetStateAction<T>>) =>
  (k: keyof T) => (v: T[keyof T]) => set({ ...obj, [k]: v });

export default function App() {
  const P = usePlotter();
  const { pen, moving, connected, motion, bounds, paths, activePath, queue, log, status, jobs } = P;

  const [gotoF, setGoto]   = useState({ x: 0, y: 0 });
  const [circle, setCircle] = useState({ cx: 0, cy: 0, r: 50, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [square, setSquare] = useState({ cx: 0, cy: 0, size: 100, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [lineF, setLine]    = useState({ x0: 0, y0: 0, x1: 100, y1: 0, cycles: 1 });
  const [wobbly, setWobbly]     = useState({ cx: 0, cy: 0, r: 60, boundR: 90, wobble: 0.4, harmonics: 3, seed: 42, cycles: 1 });
  const [truchet, setTruchet]   = useState({ n: 4, spacing: 3, angle: 45, seed: 42, motifs: TRUCHET_DEFAULT_MASK });
  const [calib, setCalib]       = useState({ cx: 0, cy: 0 });
  const [tab, setTab]       = useState<Tab>('draw');

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
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-cyanx">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>
                <line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            <div>
              <h1 className="text-[15px] font-bold tracking-tight text-ink-100">Polar Plotter</h1>
              <p className="hidden font-mono text-[11px] text-ink-500 sm:block">console</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <IpInput ip={P.ip} onSave={P.setIp} />
            <StatusChip connected={connected} />
            <StopButton onClick={P.stop} moving={moving} />
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6">
        <div className="h-full grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:[grid-template-rows:minmax(0,1fr)]">

          {/* ====== LEFT: machine state ====== */}
          <div className="space-y-4 overflow-y-auto">
            <Card title="Position" icon="◎" accent="#0284c7" right={
              <div className="flex items-center gap-3 font-mono text-[12px]">
                <span className={moving ? 'text-warn' : 'text-ink-500'}>{moving ? '● MOVING' : '○ idle'}</span>
                <span className={pen.down ? 'text-go' : 'text-ink-500'}>{pen.down ? '▼ pen down' : '△ pen up'}</span>
              </div>
            }>
              <PlotterCanvas bounds={bounds} pen={pen} paths={paths} activePath={activePath} moving={moving} />
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Readout label="X" value={pen.x.toFixed(1)} unit="mm" />
                <Readout label="Y" value={pen.y.toFixed(1)} unit="mm" />
                <Readout label="Queue" value={queue.length} unit="cmd" />
                <Readout label="Strokes" value={paths.length} unit="" />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Btn variant="primary"  onClick={() => P.enqueue({ type: 'home' })}>⌂ Home</Btn>
                <Btn                    onClick={() => P.enqueue({ type: 'sethome' })}>Set Home</Btn>
                <Btn variant={pen.down ? 'default' : 'go'} onClick={() => P.enqueue({ type: 'pen', pos: 'up' })}>Pen Up</Btn>
                <Btn variant={pen.down ? 'go' : 'default'} onClick={() => P.enqueue({ type: 'pen', pos: 'down' })}>Pen Down</Btn>
                <Btn variant="ghost" onClick={P.clearPaths} className="ml-auto">Clear canvas</Btn>
              </div>
            </Card>

            {/* Motion */}
            <Card title="Motion" icon="⚡" accent="#d97706" collapsible>
              <div className="space-y-5">
                <ParamSlider label="Speed" unit="µstep/t" value={motion.vmax} min={10000} max={400000} step={5000} def={DEFAULTS.motion.vmax} accent="#0284c7"
                  onInput={(v) => P.setMotion('vmax', v)} onCommit={(v) => { P.setMotion('vmax', v); P.commitMotion('vmax', v); }} />
                <ParamSlider label="Acceleration" unit="AMAX=DMAX" value={motion.amax} min={50} max={2000} step={10} def={DEFAULTS.motion.amax} accent="#059669"
                  onInput={(v) => P.setMotion('amax', v)} onCommit={(v) => { P.setMotion('amax', v); P.commitMotion('amax', v); }} />
                <div className="h-px bg-ink-800" />
                <ParamSlider label="Run current" unit="mA" value={motion.run} min={100} max={1200} step={20} def={DEFAULTS.motion.run} accent="#d97706"
                  onInput={(v) => P.setMotion('run', v)} onCommit={(v) => { P.setMotion('run', v); P.commitMotion('run', v); }} />
                <ParamSlider label="Hold current" unit="mA" value={motion.hold} min={0} max={800} step={20} def={DEFAULTS.motion.hold} accent="#ea580c"
                  onInput={(v) => P.setMotion('hold', v)} onCommit={(v) => { P.setMotion('hold', v); P.commitMotion('hold', v); }} />
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
          <div className="flex flex-col gap-4 h-full min-h-0">
            {/* Tab bar */}
            <div className="shrink-0 flex gap-1 rounded-xl border border-ink-750 bg-ink-900 shadow-card p-1">
              {([['draw','Draw'],['jog','Move'],['script','Script'],['area','Work Area'],['calib','Calibrate'],['ai','Autonomous']] as [Tab,string][]).map(([id, lbl]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors ${tab === id ? 'bg-ink-800 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>{lbl}</button>
              ))}
            </div>

            {/* Methods + Log scroll region (flows top→bottom) */}
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
            {/* Tab panels */}
            <div className="space-y-4">
            {/* ---- Move tab ---- */}
            {tab === 'jog' && (
              <Card title="Move to point" icon="↗" accent="#0284c7">
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
            )}

            {/* ---- Draw tab ---- */}
            {tab === 'draw' && (
              <>
                <Card title="Circle" icon="○" accent="#0284c7" collapsible
                  right={<Btn variant="go" onClick={() => P.enqueue({ type: 'circle', ...circle })}>Draw ○</Btn>}>
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
                  right={<Btn variant="go" onClick={() => P.enqueue({ type: 'square', ...square })}>Draw □</Btn>}>
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
                  right={<Btn variant="go" onClick={() => P.enqueue({ type: 'line', ...lineF })}>Draw ／</Btn>}>
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
                  right={<Btn variant="go" onClick={() => P.enqueue({ type: 'wobbly', ...wobbly })}>Draw ∿</Btn>}>
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
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <FieldInline label="Seed" value={wobbly.seed} min={0} max={99999} step={1}
                      onChange={fw('seed') as (v: number) => void} />
                    <FieldInline label="Cycles" value={wobbly.cycles} min={1}
                      onChange={fw('cycles') as (v: number) => void} />
                    <div className="flex items-end">
                      <p className="text-[11px] leading-relaxed text-ink-500">
                        0 = circle · 1 = max wobble<br/>harmonics = shape complexity
                      </p>
                    </div>
                  </div>
                </Card>

                {/* Truchet */}
                <Card title="Truchet" icon="◔" accent="#0891b2" collapsible
                  right={<Btn variant="go"
                    title={'Queue the full Truchet plot. The work area is split into a grid of square cells; each cell gets a random motif (from the enabled chips below). The white ribbons connect cell-to-cell because every motif meets the cell edges at the same 1/3 and 2/3 points; everything that is NOT ribbon gets hatched. Slow job — try Hatch spacing 0 first for a quick outlines-only proof on paper.'}
                    onClick={() => P.enqueue({
                      type: 'truchet', ...truchet,
                      left: bounds.left, right: bounds.right, up: bounds.up, down: bounds.down, shape: bounds.shape,
                    })}>Draw ◔</Btn>}>
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

            {/* ---- Script tab ---- */}
            {tab === 'script' && <ScriptTab sendRaw={P.sendRaw} pushLog={P.pushLog} />}

            {/* ---- Work Area tab ---- */}
            {tab === 'area' && (
              <Card title="Work area boundaries" icon="⛶" accent="#7c3aed" collapsible>
                <p className="mb-4 text-[12px] leading-relaxed text-ink-400">
                  Distance from origin <span className="font-mono text-ink-300">(0,0)</span> to each edge.
                  Updates the canvas and sends to firmware.
                </p>
                <BoundsControl bounds={bounds} setBounds={P.setBounds} commitBounds={P.commitBounds} />
                <div className="mt-4 flex gap-2">
                  <Btn variant="ghost" onClick={() => { P.setBounds(DEFAULTS.bounds); P.commitBounds(DEFAULTS.bounds); }}>Reset to default</Btn>
                </div>
              </Card>
            )}

            {/* ---- Calibrate tab ---- */}
            {tab === 'calib' && (
              <Card title="Calibration" icon="✛" accent="#db2777" collapsible>
                {/* Limit path: walk the active work-area boundary once (pen down) so you
                    can compare the firmware's reachable edge against the physical machine. */}
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
                  Traces the boundary set under <span className="text-ink-300">Work Area</span>. Walk it once,
                  then hatch with Grid on top if you want to verify the whole area — both can run pen-down.
                </p>

                <div className="my-4 h-px bg-ink-800" />

                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Center patterns</p>
                <div className="grid grid-cols-2 gap-3">
                  <FieldInline label="Center X" unit="mm" value={calib.cx} onChange={fca('cx') as (v: number) => void} />
                  <FieldInline label="Center Y" unit="mm" value={calib.cy} onChange={fca('cy') as (v: number) => void} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn variant="primary" onClick={() => P.enqueue({ type: 'bullseye', ...calib })}>◎ Bullseye</Btn>
                  <Btn variant="primary" onClick={() => P.enqueue({ type: 'grid', ...calib })}>▦ Grid</Btn>
                </div>
              </Card>
            )}

            {/* ---- Autonomous tab ---- */}
            {tab === 'ai' && (
              <>
                <Card title="Driver health" icon="❤" accent="#059669">
                  <DriverBanner status={status} onClearFault={P.clearFault} />
                  <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
                    The MCP halts the running job and pauses the script on a real TMC5072 fault
                    (over-temp, coil short). Fix the cause, then <span className="text-ink-300">Clear fault</span> to resume.
                  </p>
                </Card>

                <Card title="Job queue" icon="▦" accent="#0284c7" collapsible>
                  <div className="space-y-4">
                    <JobProgress status={status} />
                    <div className="h-px bg-ink-800" />
                    <JobList jobs={jobs} />
                  </div>
                </Card>

                <Card title="Errors" icon="⚠" accent="#dc2626" collapsible>
                  <ErrorsPanel log={log} />
                </Card>
              </>
            )}

            </div>{/* end tab panels */}

            {/* Log — sits directly after the method cards, flex-1 to fill any
                leftover height. Collapses to just its header. */}
            <Card title="Log" icon="❯" accent="#059669" className=""
              collapsible
              right={
                <button onClick={() => P.pushLog('sys', '— cleared —')}
                  className="text-[11px] text-ink-500 hover:text-ink-300">clear</button>
              }>
              <LogView log={log} />
            </Card>
            </div>{/* end methods + log scroll region */}
          </div>
        </div>
        </div>
      </main>
    </div>
  );
}
