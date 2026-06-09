// console-app.jsx — composition
const { useState: useStateA } = React;

function App() {
  const P = usePlotter();
  const { pen, moving, connected, motion, bounds, paths, activePath, queue, log } = P;

  // local form state for one-shot draw commands
  const [goto, setGoto] = useStateA({ x: 0, y: 0 });
  const [circle, setCircle] = useStateA({ cx: -120, cy: -80, r: 75, cycles: 2, fill: true, angle: 135, spacing: 2 });
  const [square, setSquare] = useStateA({ cx: 0, cy: 0, sz: 100, cycles: 1, fill: false, angle: 0, spacing: 3 });
  const [line, setLine] = useStateA({ x0: 0, y0: 0, x1: 100, y1: 0, cycles: 1 });
  const [calib, setCalib] = useStateA({ cx: 0, cy: 0 });
  const [tab, setTab] = useStateA('draw');

  const f = (obj, set) => (k) => (v) => set({ ...obj, [k]: v });

  return (
    <div className="min-h-screen bg-ink-950 text-ink-300">
      {/* ---- top bar ---- */}
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-cyanx">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            </div>
            <div>
              <h1 className="text-[15px] font-bold tracking-tight text-ink-100">Polar Plotter</h1>
              <p className="hidden font-mono text-[11px] text-ink-500 sm:block">console · v2.4</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <StatusChip connected={connected} onReconnect={P.toggleConn} />
            <StopButton onClick={P.stop} moving={moving} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 sm:py-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">

          {/* ============ LEFT: machine state ============ */}
          <div className="space-y-4">
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
                <Btn variant="primary" onClick={() => P.enqueue({ type: 'home' })}>⌂ Home</Btn>
                <Btn onClick={() => P.enqueue({ type: 'sethome' })}>Set Home</Btn>
                <Btn variant={pen.down ? 'default' : 'go'} onClick={() => P.enqueue({ type: 'pen', pos: 'up' })}>Pen Up</Btn>
                <Btn variant={pen.down ? 'go' : 'default'} onClick={() => P.enqueue({ type: 'pen', pos: 'down' })}>Pen Down</Btn>
                <Btn variant="ghost" onClick={P.clearPaths} className="ml-auto">Clear canvas</Btn>
              </div>
            </Card>

            {/* Motion config */}
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

          {/* ============ RIGHT: controls ============ */}
          <div className="space-y-4">
            {/* Tabs */}
            <div className="flex gap-1 rounded-xl border border-ink-750 bg-ink-900/70 p-1">
              {[['draw', 'Draw'], ['jog', 'Move'], ['area', 'Work Area'], ['calib', 'Calibrate']].map(([id, lbl]) => (
                <button key={id} onClick={() => setTab(id)}
                  className={`flex-1 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors ${tab === id ? 'bg-ink-800 text-cyanx' : 'text-ink-500 hover:text-ink-300'}`}>{lbl}</button>
              ))}
            </div>

            {tab === 'jog' && (
              <Card title="Move to point" icon="↗" accent="#38bdf8">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <FieldInline label="X" unit="mm" value={goto.x} onChange={f(goto, setGoto)('x')} />
                  <FieldInline label="Y" unit="mm" value={goto.y} onChange={f(goto, setGoto)('y')} />
                  <Btn variant="primary" className="col-span-2 sm:col-span-1" onClick={() => P.enqueue({ type: 'goto', ...goto })}>Go →</Btn>
                </div>
                <div className="mt-4">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">Jog</p>
                  <JogPad onJog={(dx, dy) => { const nx = pen.x + dx, ny = pen.y + dy; setGoto({ x: nx, y: ny }); P.enqueue({ type: 'goto', x: nx, y: ny }); }} />
                </div>
              </Card>
            )}

            {tab === 'draw' && (
              <>
                <Card title="Circle" icon="○" accent="#38bdf8" right={<Btn variant="go" onClick={() => P.enqueue({ type: 'circle', ...circle })}>Draw ○</Btn>}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <FieldInline label="Center X" unit="mm" value={circle.cx} onChange={f(circle, setCircle)('cx')} />
                    <FieldInline label="Center Y" unit="mm" value={circle.cy} onChange={f(circle, setCircle)('cy')} />
                    <FieldInline label="Radius" unit="mm" value={circle.r} onChange={f(circle, setCircle)('r')} min={1} />
                    <FieldInline label="Cycles" value={circle.cycles} onChange={f(circle, setCircle)('cycles')} min={1} />
                    <FieldInline label="Angle" unit="°" value={circle.angle} onChange={f(circle, setCircle)('angle')} />
                    <FieldInline label="Fill spacing" unit="mm" value={circle.spacing} onChange={f(circle, setCircle)('spacing')} min={0.5} step={0.5} />
                  </div>
                  <div className="mt-3"><Toggle checked={circle.fill} onChange={f(circle, setCircle)('fill')} label="Fill (spiral inward)" /></div>
                </Card>

                <Card title="Square" icon="□" accent="#34d399" right={<Btn variant="go" onClick={() => P.enqueue({ type: 'square', ...square })}>Draw □</Btn>}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <FieldInline label="Center X" unit="mm" value={square.cx} onChange={f(square, setSquare)('cx')} />
                    <FieldInline label="Center Y" unit="mm" value={square.cy} onChange={f(square, setSquare)('cy')} />
                    <FieldInline label="Size" unit="mm" value={square.sz} onChange={f(square, setSquare)('sz')} min={1} />
                    <FieldInline label="Cycles" value={square.cycles} onChange={f(square, setSquare)('cycles')} min={1} />
                    <FieldInline label="Angle" unit="°" value={square.angle} onChange={f(square, setSquare)('angle')} />
                    <FieldInline label="Fill spacing" unit="mm" value={square.spacing} onChange={f(square, setSquare)('spacing')} min={0.5} step={0.5} />
                  </div>
                  <div className="mt-3"><Toggle checked={square.fill} onChange={f(square, setSquare)('fill')} label="Fill (concentric)" /></div>
                </Card>

                <Card title="Line" icon="／" accent="#fbbf24" right={<Btn variant="go" onClick={() => P.enqueue({ type: 'line', ...line })}>Draw ／</Btn>}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <FieldInline label="X0" unit="mm" value={line.x0} onChange={f(line, setLine)('x0')} />
                    <FieldInline label="Y0" unit="mm" value={line.y0} onChange={f(line, setLine)('y0')} />
                    <FieldInline label="X1" unit="mm" value={line.x1} onChange={f(line, setLine)('x1')} />
                    <FieldInline label="Y1" unit="mm" value={line.y1} onChange={f(line, setLine)('y1')} />
                  </div>
                  <div className="mt-3 w-28"><FieldInline label="Cycles" value={line.cycles} onChange={f(line, setLine)('cycles')} min={1} /></div>
                </Card>
              </>
            )}

            {tab === 'area' && (
              <Card title="Work area boundaries" icon="⛶" accent="#a78bfa">
                <p className="mb-4 text-[12px] leading-relaxed text-ink-400">Distance from origin <span className="font-mono text-ink-300">(0,0)</span> to each edge. The canvas updates live.</p>
                <BoundsControl bounds={bounds} setBounds={P.setBounds} commitBounds={P.commitBounds} def={DEFAULTS.bounds} />
                <div className="mt-4 flex gap-2">
                  <Btn variant="ghost" onClick={() => { P.setBounds(DEFAULTS.bounds); P.commitBounds(DEFAULTS.bounds); }}>Reset to default</Btn>
                </div>
              </Card>
            )}

            {tab === 'calib' && (
              <Card title="Calibration" icon="✛" accent="#f472b6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr]">
                  <FieldInline label="Center X" unit="mm" value={calib.cx} onChange={f(calib, setCalib)('cx')} />
                  <FieldInline label="Center Y" unit="mm" value={calib.cy} onChange={f(calib, setCalib)('cy')} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Btn variant="primary" onClick={() => P.enqueue({ type: 'bullseye', ...calib })}>◎ Bullseye</Btn>
                  <Btn variant="primary" onClick={() => P.enqueue({ type: 'grid', ...calib })}>▦ Grid</Btn>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-ink-500">Use these targets to verify the work area maps correctly to physical space, then adjust boundaries under <span className="text-ink-300">Work Area</span>.</p>
              </Card>
            )}

            {/* Log */}
            <Card title="Log" icon="❯" accent="#34d399" className="min-h-[280px]" right={
              <button onClick={() => P.pushLog('sys', '— cleared —')} className="text-[11px] text-ink-500 hover:text-ink-300">clear</button>
            }>
              <div className="h-[260px]"><LogView log={log} /></div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

function Readout({ label, value, unit }) {
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{label}</div>
      <div className="font-mono text-[16px] text-ink-100">{value}<span className="ml-1 text-[10px] text-ink-500">{unit}</span></div>
    </div>
  );
}

function JogPad({ onJog }) {
  const [stepv, setStep] = useStateA(10);
  const steps = [1, 10, 50];
  const Arrow = ({ dx, dy, char, cls }) => (
    <button onClick={() => onJog(dx * stepv, dy * stepv)} className={`flex items-center justify-center rounded-lg border border-ink-700 bg-ink-850 text-ink-300 hover:bg-ink-800 hover:text-cyanx transition-colors h-11 ${cls}`}>{char}</button>
  );
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="grid grid-cols-3 grid-rows-3 gap-1.5 w-[150px]">
        <Arrow dx={0} dy={1} char="↑" cls="col-start-2 row-start-1" />
        <Arrow dx={-1} dy={0} char="←" cls="col-start-1 row-start-2" />
        <div className="col-start-2 row-start-2 flex items-center justify-center font-mono text-[10px] text-ink-600">{stepv}mm</div>
        <Arrow dx={1} dy={0} char="→" cls="col-start-3 row-start-2" />
        <Arrow dx={0} dy={-1} char="↓" cls="col-start-2 row-start-3" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">Step</span>
        <div className="flex gap-1">
          {steps.map((s) => (
            <button key={s} onClick={() => setStep(s)} className={`rounded-md px-2.5 py-1.5 text-[12px] font-mono transition-colors ${stepv === s ? 'bg-cyanx/20 text-cyanx border border-cyanx/40' : 'bg-ink-850 text-ink-400 border border-ink-700 hover:text-ink-200'}`}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
