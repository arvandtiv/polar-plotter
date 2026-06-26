# v1.3 Architecture — the Frame pipeline

This is the target design. It is additive: today's Draw/Script/G-code tabs keep
working while we route them through the new pipeline one at a time.

## 1. The Frame (geometry IR)

The universal currency. Pure data, mm units, origin = plotter origin (centre, Y-down
to match firmware logical coords — the digester's placement step already converts into
this frame).

```ts
// console/src/lib/frame.ts
export interface Pt { x: number; y: number; }

export interface Path {
  points: Pt[];
  closed?: boolean;        // last→first is drawn
  // presentation only (preview); the firmware ignores these:
  stroke?: string;
  cycles?: number;         // retrace count, maps to firmware `cycles`
}

export interface Frame {
  widthMm: number;
  heightMm: number;
  paths: Path[];
  meta?: { title?: string; anchor?: Pt };
}
```

Why mm + this shape: it is exactly what `line`/`goto` consume after kinematics, what
the G-code digester already produces internally, and what a `<canvas>` preview needs.

## 2. The module registry

A generator/modifier is a pure object. The Make menu lists `kind:"make"`, the Modify
menu lists `kind:"modify"`.

```ts
// console/src/lib/registry.ts
export interface FieldBase {
  key: string; label: string; unit?: string;
  default: number | string | boolean;
}
export type Field =
  | (FieldBase & { type: "range"; min: number; max: number; step: number })
  | (FieldBase & { type: "number"; min?: number; max?: number; step?: number })
  | (FieldBase & { type: "select"; options: { value: string; label: string }[] })
  | (FieldBase & { type: "toggle" })
  | (FieldBase & { type: "color" });

export interface Section { title: string; fields: Field[]; }

export interface GenCtx {
  bounds: { left: number; right: number; up: number; down: number };
  lowerFrame?: Frame;      // present for modifiers: the composited layers beneath
}

export interface Module {
  key: string;
  label: string;
  kind: "make" | "modify";
  group?: string;          // menu grouping ("Lines & Patterns", "Modifiers"…)
  sections: Section[];     // declarative UI
  generate(params: Record<string, any>, ctx: GenCtx): Frame;
}

export const registry = new Map<string, Module>();
export const register = (m: Module) => registry.set(m.key, m);
export const defaultsOf = (m: Module): Record<string, any> => /* fold field.default */;
```

Key property: `generate` is **pure** → unit-testable with `npx tsx`, no DOM. Same
contract for make and modify; a modifier just reads `ctx.lowerFrame`.

## 3. Auto-generated parameter panel

One React component renders any module's `sections` and owns the values:

```tsx
<ParamPanel sections={mod.sections} values={values} onChange={setValues} />
```

`type` → control: `range`→slider, `select`→dropdown, `color`→swatch, `toggle`→switch.
This deletes most of the bespoke control code in `App.tsx`. Values persist per-module
in localStorage (same pattern as papers/matrices).

## 4. The compile pipeline (Frame → firmware)

```
Frame ──▶ toolpath optimize ──▶ compile to queries ──▶ streamQueries()
          (reorder + simplify)   (pen/goto/line lift=0)
```

- **Optimize** (`lib/toolpath.ts`): nearest-neighbour path ordering (+ allow reversing
  a path) to cut pen-up travel; RDP simplify + collinear filter to drop redundant
  points; optional arc detection. Pure, host-tested. Applies to *all* output.
- **Compile** (`lib/compile.ts`): walk ordered paths → `pen up` + `goto start`, then
  `pen down`, then `line …&lift=0` per segment (reusing the v1.2 continuous-draw fix),
  `pen up` at the end. Returns `string[]` queries — exactly what `streamQueries` eats.

So the existing **Draw shapes**, the **G-code digester**, and **new generators** all
converge on `Frame → optimize → compile → streamQueries`. The digester's bespoke emit
loop is replaced by `compile(frameFromGcode)`.

## 5. The modifier stack ("Sequence")

A document is an ordered list of layers:

```ts
interface Layer { id: string; moduleKey: string; params: Record<string, any>; }
```

Evaluation (bottom → top): each layer calls `module.generate(params, { bounds,
lowerFrame })` where `lowerFrame` is the composite of everything beneath. A **make**
ignores `lowerFrame` and adds its paths; a **modify** transforms/masks/fills the
`lowerFrame`. The top frame is what gets compiled and streamed. This is the reference
app's most powerful idea and it falls out naturally once the Frame exists.

## 6. Where it lives

```
console/src/lib/
  frame.ts        Frame/Path/Pt types + helpers
  registry.ts     Module/Field types + registry
  geom.ts         geometry toolkit (§03 doc)
  toolpath.ts     optimize: order + simplify (§04 doc)
  compile.ts      Frame → query strings
  pipeline.ts     layer stack evaluation (§05 doc)
  modules/        our generators & modifiers (clean-room)
console/src/components/
  ParamPanel.tsx  schema-driven controls
  StudioTab.tsx   picker + panel + preview + run
console/test/
  *.test.ts       pure unit tests (npx tsx)
```

Firmware: unchanged for the core plan. Optional later adds (each isolated, flagged in
the roadmap): an `arc`/G2-G3 primitive so fitted arcs stream as one job; a Frame→G-code
*export* for other machines.
