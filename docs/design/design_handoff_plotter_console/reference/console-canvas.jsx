// console-canvas.jsx — live position canvas, boundary control, log view
const { useRef: useRefV, useEffect: useEffectV } = React;

// ---- Live position canvas (SVG) ----------------------------------
function PlotterCanvas({ bounds, pen, paths, activePath, moving }) {
  const { left, right, up, down } = bounds;
  const pad = Math.max(20, (left + right) * 0.06);
  const vbX = -left - pad;
  const vbY = -up - pad;
  const vbW = left + right + 2 * pad;
  const vbH = up + down + 2 * pad;
  const py = (y) => -y; // flip Y so +Y is up

  // grid lines every ~50mm
  const gridStep = vbW > 800 ? 100 : 50;
  const gx = [];
  for (let x = Math.ceil(-left / gridStep) * gridStep; x <= right; x += gridStep) gx.push(x);
  const gy = [];
  for (let y = Math.ceil(-down / gridStep) * gridStep; y <= up; y += gridStep) gy.push(y);

  const toPoly = (pts) => pts.map((p) => `${p.x},${py(p.y)}`).join(' ');
  const sw = vbW / 400; // stroke scales with view

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-ink-800 bg-ink-950">
      <svg viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`} className="w-full" style={{ aspectRatio: `${vbW} / ${vbH}`, display: 'block' }} preserveAspectRatio="xMidYMid meet">
        {/* work-area fill */}
        <rect x={-left} y={py(up)} width={left + right} height={up + down} fill="#0e1318" stroke="#2a3845" strokeWidth={sw * 1.5} rx={sw} />
        {/* grid */}
        {gx.map((x) => <line key={'gx' + x} x1={x} y1={py(up)} x2={x} y2={py(-down)} stroke="#172029" strokeWidth={sw * 0.6} />)}
        {gy.map((y) => <line key={'gy' + y} x1={-left} y1={py(y)} x2={right} y2={py(y)} stroke="#172029" strokeWidth={sw * 0.6} />)}
        {/* axes */}
        <line x1={-left} y1={0} x2={right} y2={0} stroke="#2f4150" strokeWidth={sw} />
        <line x1={0} y1={py(up)} x2={0} y2={py(-down)} stroke="#2f4150" strokeWidth={sw} />
        {/* committed paths */}
        {paths.map((pa, i) => (
          <polyline key={i} points={toPoly(pa.points)} fill="none" stroke={pa.color} strokeWidth={sw * 1.4} strokeLinejoin="round" strokeLinecap="round" opacity="0.92" />
        ))}
        {/* active path */}
        {activePath && (
          <polyline points={toPoly(activePath.points)} fill="none" stroke={activePath.color} strokeWidth={sw * 1.8} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {/* origin marker */}
        <circle cx={0} cy={0} r={sw * 3} fill="none" stroke="#3a4c5c" strokeWidth={sw} />
        {/* pen head */}
        <g>
          {moving && <circle cx={pen.x} cy={py(pen.y)} r={sw * 9} fill={pen.down ? '#34d399' : '#38bdf8'} opacity="0.18" />}
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 4.5} fill={pen.down ? '#34d399' : 'none'} stroke={pen.down ? '#34d399' : '#38bdf8'} strokeWidth={sw * 1.6} />
          <circle cx={pen.x} cy={py(pen.y)} r={sw * 1.2} fill={pen.down ? '#0a0d11' : '#38bdf8'} />
        </g>
      </svg>
      {/* corner labels */}
      <div className="pointer-events-none absolute inset-0 font-mono text-[10px] text-ink-600">
        <span className="absolute left-2 top-2">+Y {up}</span>
        <span className="absolute left-2 bottom-2">−Y {down}</span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2">+X {right}</span>
        <span className="absolute left-2 top-1/2 -translate-y-1/2">−X {left}</span>
      </div>
    </div>
  );
}

// ---- 4-direction boundary control --------------------------------
function BoundsControl({ bounds, setBounds, commitBounds, def }) {
  const set = (k, v) => setBounds((b) => ({ ...b, [k]: Math.max(0, v) }));
  const commit = (next) => commitBounds(next);
  const fields = [
    { k: 'up', label: 'Up (+Y)', pos: 'top' },
    { k: 'down', label: 'Down (−Y)', pos: 'bottom' },
    { k: 'left', label: 'Left (−X)', pos: 'left' },
    { k: 'right', label: 'Right (+X)', pos: 'right' },
  ];
  const Box = ({ k, label }) => (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</span>
      <div className="flex items-center rounded-lg border border-ink-700 bg-ink-850 focus-within:border-cyanx/50">
        <input type="number" value={bounds[k]} min={0}
          onChange={(e) => set(k, e.target.value === '' ? 0 : parseFloat(e.target.value))}
          onBlur={(e) => { const n = Math.max(0, parseFloat(e.target.value) || 0); const nb = { ...bounds, [k]: n }; setBounds(nb); commit(nb); }}
          className="min-w-0 w-full bg-transparent px-2 py-1.5 font-mono text-[13px] text-ink-200 outline-none text-center" />
        <span className="pr-2 text-[10px] text-ink-500 font-mono">mm</span>
      </div>
    </div>
  );
  const totalW = bounds.left + bounds.right;
  const totalH = bounds.up + bounds.down;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
      {/* cross layout */}
      <div className="grid grid-cols-3 grid-rows-3 gap-2 items-center">
        <div className="col-start-2 row-start-1"><Box k="up" label="Up (+Y)" /></div>
        <div className="col-start-1 row-start-2"><Box k="left" label="Left (−X)" /></div>
        <div className="col-start-2 row-start-2 flex items-center justify-center">
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-ink-700 bg-ink-950 px-2 py-3">
            <div className="text-center">
              <div className="font-mono text-[11px] text-ink-200">{totalW}×{totalH}</div>
              <div className="text-[9px] uppercase tracking-wider text-ink-600">work area</div>
            </div>
          </div>
        </div>
        <div className="col-start-3 row-start-2"><Box k="right" label="Right (+X)" /></div>
        <div className="col-start-2 row-start-3"><Box k="down" label="Down (−Y)" /></div>
      </div>
    </div>
  );
}

// ---- Log view ----------------------------------------------------
function LogView({ log, onClear }) {
  const ref = useRefV(null);
  useEffectV(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  const color = (kind) => ({
    cmd: 'text-cyanx', ok: 'text-go', err: 'text-stop', warn: 'text-warn', sys: 'text-ink-500',
  }[kind] || 'text-ink-400');
  const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
  return (
    <div className="flex h-full flex-col">
      <div ref={ref} className="flex-1 overflow-y-auto rounded-lg border border-ink-800 bg-ink-950 p-3 font-mono text-[12.5px] leading-relaxed">
        {log.map((l) => (
          <div key={l.id} className={`log-line flex gap-2.5 ${color(l.kind)}`}>
            <span className="shrink-0 text-ink-700 tabular-nums">{fmtTime(l.t)}</span>
            <span className="whitespace-pre-wrap break-all">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { PlotterCanvas, BoundsControl, LogView });
