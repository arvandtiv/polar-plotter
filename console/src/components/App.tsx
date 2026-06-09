import { useState, useRef, useEffect } from 'react';
import {
  usePlotter,
  type PlotterBounds,
  type MotionParams,
  type FillMode,
  type PlotCmd,
  type Stroke,
  type PenState,
  type LogEntry,
  DEFAULTS,
} from '../hooks/usePlotter';

// ================================================================
//  Primitives
// ================================================================

function Card({ title, icon, accent = '#38bdf8', right, children, className = '' }: {
  title?: string; icon?: string; accent?: string; right?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  const isFlexCol = className.includes('flex-col');
  return (
    <section className={`rounded-xl border border-ink-750 bg-ink-900/70 ${className}`}>
      {title && (
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-800 shrink-0">
          <div className="flex items-center gap-2">
            {icon && <span style={{ color: accent }} className="text-[13px]">{icon}</span>}
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">{title}</h2>
          </div>
          {right}
        </header>
      )}
      <div className={`p-4 ${isFlexCol ? 'flex flex-col flex-1 min-h-0' : ''}`}>{children}</div>
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

function ParamSlider({ label, value, onInput, onCommit, min, max, step, unit, def, accent = '#38bdf8' }: {
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
          style={{ '--thumb': accent, '--track': `linear-gradient(90deg, ${accent} ${pct}%, #2a3845 ${pct}%)` } as React.CSSProperties}
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
function FieldInline({ label, value, onChange, unit, step = 1, min = -100000, max = 100000 }: {
  label: string; value: number; onChange: (v: number) => void;
  unit?: string; step?: number; min?: number; max?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);

  const commit = () => {
    const raw = ref.current?.value ?? '';
    let n = parseFloat(raw);
    if (isNaN(n)) n = value;
    onChange(Math.min(max, Math.max(min, n)));
  };

  return (
    <div className="flex flex-col gap-1">
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
        <rect x={-left} y={py(up)} width={left + right} height={up + down}
          fill="#0e1318" stroke="#2a3845" strokeWidth={sw * 1.5} rx={sw} />
        {gx.map((x) => <line key={`gx${x}`} x1={x} y1={py(up)} x2={x} y2={py(-down)} stroke="#172029" strokeWidth={sw * 0.6} />)}
        {gy.map((y) => <line key={`gy${y}`} x1={-left} y1={py(y)} x2={right} y2={py(y)} stroke="#172029" strokeWidth={sw * 0.6} />)}
        <line x1={-left} y1={0} x2={right} y2={0} stroke="#2f4150" strokeWidth={sw} />
        <line x1={0} y1={py(up)} x2={0} y2={py(-down)} stroke="#2f4150" strokeWidth={sw} />
        {paths.map((pa, i) => (
          <polyline key={i} points={toPoly(pa.points)} fill="none" stroke={pa.color}
            strokeWidth={sw * 1.4} strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
        ))}
        {activePath && (
          <polyline points={toPoly(activePath.points)} fill="none" stroke={activePath.color}
            strokeWidth={sw * 1.8} strokeLinejoin="round" strokeLinecap="round" />
        )}
        <circle cx={0} cy={0} r={sw * 3} fill="none" stroke="#3a4c5c" strokeWidth={sw} />
        <g>
          {moving && <circle cx={pen.x} cy={py(pen.y)} r={sw * 9} fill={pen.down ? '#34d399' : '#38bdf8'} opacity="0.18" />}
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 4.5} fill={pen.down ? '#34d399' : 'none'}
            stroke={pen.down ? '#34d399' : '#38bdf8'} strokeWidth={sw * 1.6} />
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 1.2} fill={pen.down ? '#0a0d11' : '#38bdf8'} />
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

  const parse = (s: string | undefined) => Math.max(0, parseFloat(s ?? '0') || 0);

  const apply = () => {
    const nb = {
      up:    parse(refs.up.current?.value),
      down:  parse(refs.down.current?.value),
      left:  parse(refs.left.current?.value),
      right: parse(refs.right.current?.value),
    };
    setBounds(nb);
    commitBounds(nb);
  };

  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') apply(); };

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
      {row(refs.up,    'Up  (+Y)',   bounds.up)}
      {row(refs.down,  'Down (−Y)',  bounds.down)}
      {row(refs.left,  'Left  (−X)', bounds.left)}
      {row(refs.right, 'Right (+X)', bounds.right)}
      <button onClick={apply}
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
    <div ref={ref} className="overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed h-full">
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
//  Main App
// ================================================================

type Tab = 'draw' | 'jog' | 'area' | 'calib';
const f = <T extends object>(obj: T, set: React.Dispatch<React.SetStateAction<T>>) =>
  (k: keyof T) => (v: T[keyof T]) => set({ ...obj, [k]: v });

export default function App() {
  const P = usePlotter();
  const { pen, moving, connected, motion, bounds, paths, activePath, queue, log } = P;

  const [gotoF, setGoto]   = useState({ x: 0, y: 0 });
  const [circle, setCircle] = useState({ cx: 0, cy: 0, r: 50, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [square, setSquare] = useState({ cx: 0, cy: 0, size: 100, cycles: 1, fillMode: 0 as FillMode, angle: 0, spacing: 3, outline: true });
  const [lineF, setLine]    = useState({ x0: 0, y0: 0, x1: 100, y1: 0, cycles: 1 });
  const [wobbly, setWobbly] = useState({ cx: 0, cy: 0, r: 60, boundR: 90, wobble: 0.4, harmonics: 3, seed: 42, cycles: 1 });
  const [calib, setCalib]   = useState({ cx: 0, cy: 0 });
  const [tab, setTab]       = useState<Tab>('draw');

  const fg = f(gotoF, setGoto);
  const fc = f(circle, setCircle);
  const fs = f(square, setSquare);
  const fl = f(lineF, setLine);
  const fw = f(wobbly, setWobbly);
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
            <Card title="Position" icon="◎" accent="#38bdf8" right={
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
            <Card title="Motion" icon="⚡" accent="#fbbf24">
              <div className="space-y-5">
                <ParamSlider label="Speed" unit="µstep/t" value={motion.vmax} min={10000} max={400000} step={5000} def={DEFAULTS.motion.vmax} accent="#38bdf8"
                  onInput={(v) => P.setMotion('vmax', v)} onCommit={(v) => { P.setMotion('vmax', v); P.commitMotion('vmax', v); }} />
                <ParamSlider label="Acceleration" unit="AMAX=DMAX" value={motion.amax} min={50} max={2000} step={10} def={DEFAULTS.motion.amax} accent="#34d399"
                  onInput={(v) => P.setMotion('amax', v)} onCommit={(v) => { P.setMotion('amax', v); P.commitMotion('amax', v); }} />
                <div className="h-px bg-ink-800" />
                <ParamSlider label="Run current" unit="mA" value={motion.run} min={100} max={1200} step={20} def={DEFAULTS.motion.run} accent="#fbbf24"
                  onInput={(v) => P.setMotion('run', v)} onCommit={(v) => { P.setMotion('run', v); P.commitMotion('run', v); }} />
                <ParamSlider label="Hold current" unit="mA" value={motion.hold} min={0} max={800} step={20} def={DEFAULTS.motion.hold} accent="#fb923c"
                  onInput={(v) => P.setMotion('hold', v)} onCommit={(v) => { P.setMotion('hold', v); P.commitMotion('hold', v); }} />
              </div>
            </Card>
          </div>

          {/* ====== RIGHT: controls ======
               Uses CSS Grid with explicit row tracks instead of flexbox.
               Flexbox children don't shrink below their content height, so
               the log card would overflow the viewport. With grid + minmax(0,1fr)
               both inner rows get equal height and DO shrink — the log always
               fills exactly the bottom half of the available space. */}
          <div className="grid gap-4 h-full min-h-0" style={{ gridTemplateRows: 'auto minmax(0,1fr) minmax(0,1fr)' }}>
            {/* Tab bar — row 1 */}
            <div className="flex gap-1 rounded-xl border border-ink-750 bg-ink-900/70 p-1">
              {([['draw','Draw'],['jog','Move'],['area','Work Area'],['calib','Calibrate']] as [Tab,string][]).map(([id, lbl]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors ${tab === id ? 'bg-ink-800 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>{lbl}</button>
              ))}
            </div>

            {/* Tab panels — row 2, scrolls internally */}
            <div className="overflow-y-auto space-y-4 min-h-0">
            {/* ---- Move tab ---- */}
            {tab === 'jog' && (
              <Card title="Move to point" icon="↗" accent="#38bdf8">
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
                <Card title="Circle" icon="○" accent="#38bdf8"
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

                <Card title="Square" icon="□" accent="#34d399"
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

                <Card title="Line" icon="／" accent="#fbbf24"
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

                <Card title="Wobbly" icon="∿" accent="#a78bfa"
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
              </>
            )}

            {/* ---- Work Area tab ---- */}
            {tab === 'area' && (
              <Card title="Work area boundaries" icon="⛶" accent="#a78bfa">
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
              <Card title="Calibration" icon="✛" accent="#f472b6">
                <div className="grid grid-cols-2 gap-3">
                  <FieldInline label="Center X" unit="mm" value={calib.cx} onChange={fca('cx') as (v: number) => void} />
                  <FieldInline label="Center Y" unit="mm" value={calib.cy} onChange={fca('cy') as (v: number) => void} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Btn variant="primary" onClick={() => P.enqueue({ type: 'bullseye', ...calib })}>◎ Bullseye</Btn>
                  <Btn variant="primary" onClick={() => P.enqueue({ type: 'grid', ...calib })}>▦ Grid</Btn>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-ink-500">
                  Verify work area maps to physical space, then adjust boundaries under{' '}
                  <span className="text-ink-300">Work Area</span>.
                </p>
              </Card>
            )}

            </div>{/* end tab panels — row 2 */}

            {/* Log — row 3, fills to bottom */}
            <Card title="Log" icon="❯" accent="#34d399" className="flex flex-col min-h-0"
              right={
                <button onClick={() => P.pushLog('sys', '— cleared —')}
                  className="text-[11px] text-ink-500 hover:text-ink-300">clear</button>
              }>
              <div className="flex-1 min-h-0"><LogView log={log} /></div>
            </Card>
          </div>
        </div>
        </div>
      </main>
    </div>
  );
}
