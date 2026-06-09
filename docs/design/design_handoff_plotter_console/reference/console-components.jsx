// console-components.jsx — reusable UI controls
const { useState: useStateC, useRef: useRefC } = React;

// Section card -----------------------------------------------------
function Card({ title, icon, accent = '#38bdf8', right, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-ink-750 bg-ink-900/70 ${className}`}>
      {title && (
        <header className="flex items-center justify-between px-4 py-2.5 border-b border-ink-800">
          <div className="flex items-center gap-2">
            {icon && <span style={{ color: accent }} className="text-[13px]">{icon}</span>}
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">{title}</h2>
          </div>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

// Generic button ---------------------------------------------------
function Btn({ children, onClick, variant = 'default', disabled, className = '', title }) {
  const styles = {
    default: 'bg-ink-800 hover:bg-ink-750 border-ink-700 text-ink-300',
    primary: 'bg-cyanx/15 hover:bg-cyanx/25 border-cyanx/40 text-cyanx',
    go: 'bg-go/15 hover:bg-go/25 border-go/40 text-go',
    ghost: 'bg-transparent hover:bg-ink-800 border-ink-750 text-ink-400',
    danger: 'bg-stop/15 hover:bg-stop/25 border-stop/40 text-stop',
  };
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={`px-3 py-1.5 rounded-lg border text-[13px] font-medium transition-colors active:scale-[.97] disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >{children}</button>
  );
}

// Big STOP ---------------------------------------------------------
function StopButton({ onClick, moving }) {
  return (
    <button
      onClick={onClick}
      className="group relative flex items-center gap-2.5 px-5 py-2.5 rounded-xl border-2 border-stop/60 bg-stop/15 hover:bg-stop/25 text-stop font-bold tracking-wide transition-all active:scale-95"
    >
      {moving && <span className="absolute left-4 h-3 w-3 rounded-full bg-stop blink" />}
      <span className={`inline-block h-3 w-3 ${moving ? 'opacity-0' : ''} bg-stop`} style={{ borderRadius: 2 }} />
      <span className="text-[15px]">STOP</span>
    </button>
  );
}

// Connection chip --------------------------------------------------
function StatusChip({ connected, onReconnect }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-ink-750 bg-ink-850 pl-3 pr-2 py-1.5">
      <span className="relative flex h-2.5 w-2.5">
        {connected && <span className="absolute inline-flex h-full w-full rounded-full bg-go opacity-60" style={{ animation: 'pulse-ring 1.8s ease-out infinite' }} />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${connected ? 'bg-go' : 'bg-stop'}`} />
      </span>
      <span className={`whitespace-nowrap font-mono text-[12px] ${connected ? 'text-go' : 'text-stop'}`}>
        {connected ? 'LINK UP' : 'LINK DOWN'}
      </span>
      <button
        onClick={onReconnect}
        className="ml-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-400 hover:text-ink-300 hover:bg-ink-800 transition-colors"
        title={connected ? 'Simulate disconnect' : 'Reconnect'}
      >{connected ? 'drop' : 'reconnect'}</button>
    </div>
  );
}

// Stepper number field ---------------------------------------------
function NumField({ label, value, onChange, unit, step = 1, min = -100000, max = 100000, w = 'w-full' }) {
  const commit = (v) => {
    let n = parseFloat(v);
    if (isNaN(n)) n = 0;
    n = Math.min(max, Math.max(min, n));
    onChange(n);
  };
  return (
    <label className="flex flex-col gap-1">
      {label && <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</span>}
      <div className={`flex items-center rounded-lg border border-ink-700 bg-ink-850 focus-within:border-cyanx/50 transition-colors ${w}`}>
        <button onClick={() => commit(value - step)} className="px-2 py-1.5 text-ink-500 hover:text-cyanx text-[15px] leading-none select-none">−</button>
        <input
          type="number" value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : parseFloat(e.target.value))}
          onBlur={(e) => commit(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-center font-mono text-[13px] text-ink-200 outline-none py-1.5"
        />
        {unit && <span className="pr-1 text-[10px] text-ink-500 font-mono">{unit}</span>}
        <button onClick={() => commit((parseFloat(value) || 0) + step)} className="px-2 py-1.5 text-ink-500 hover:text-cyanx text-[15px] leading-none select-none">+</button>
      </div>
    </label>
  );
}

// Slider + numeric readout combo (motion params) -------------------
function ParamSlider({ label, value, onInput, onCommit, min, max, step, unit, def, accent = '#38bdf8', fmt }) {
  const pct = ((value - min) / (max - min)) * 100;
  const display = fmt ? fmt(value) : value;
  const isDefault = value === def;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-ink-300">{label}</span>
        <div className="flex items-center gap-2">
          <input
            type="number" value={value}
            onChange={(e) => onInput(e.target.value === '' ? min : Math.min(max, Math.max(min, parseFloat(e.target.value) || min)))}
            onBlur={(e) => onCommit(Math.min(max, Math.max(min, parseFloat(e.target.value) || min)))}
            className="w-24 rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-right font-mono text-[13px] text-ink-100 outline-none focus:border-cyanx/50"
          />
          <span className="w-14 font-mono text-[10px] text-ink-500">{unit}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onInput(parseFloat(e.target.value))}
          onMouseUp={(e) => onCommit(parseFloat(e.target.value))}
          onTouchEnd={(e) => onCommit(parseFloat(e.target.value))}
          className="flex-1"
          style={{ '--thumb': accent, '--track': `linear-gradient(90deg, ${accent} ${pct}%, #2a3845 ${pct}%)` }}
        />
        <button
          onClick={() => { onInput(def); onCommit(def); }}
          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-mono transition-colors ${isDefault ? 'text-ink-600' : 'text-ink-400 hover:text-cyanx hover:bg-ink-800'}`}
          title={`Reset to default (${def})`}
        >⟲ {def}</button>
      </div>
    </div>
  );
}

// Toggle / checkbox ------------------------------------------------
function Toggle({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 select-none group"
    >
      <span className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-cyanx/70' : 'bg-ink-700'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className="text-[12px] text-ink-300 group-hover:text-ink-200">{label}</span>
    </button>
  );
}

// Small inline labeled input (for shape fields) --------------------
function FieldInline({ label, value, onChange, unit, step = 1, min = -100000, max = 100000 }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</span>
      <div className="flex items-center rounded-lg border border-ink-700 bg-ink-850 focus-within:border-cyanx/50 transition-colors">
        <input
          type="number" value={value}
          onChange={(e) => onChange(e.target.value === '' ? '' : parseFloat(e.target.value))}
          onBlur={(e) => { let n = parseFloat(e.target.value); if (isNaN(n)) n = 0; onChange(Math.min(max, Math.max(min, n))); }}
          className="min-w-0 w-full bg-transparent px-2 py-1.5 font-mono text-[13px] text-ink-200 outline-none"
        />
        {unit && <span className="pr-2 text-[10px] text-ink-500 font-mono">{unit}</span>}
      </div>
    </div>
  );
}

Object.assign(window, { Card, Btn, StopButton, StatusChip, NumField, ParamSlider, Toggle, FieldInline });
