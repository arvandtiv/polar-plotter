# 02 — Declarative fields + module registry

*Reference for technique only: `reference/lineandform/modules/index.js` (manifest),
`core/module-loader.js` (loader), `modules/orbital-weave.js` (a module's
`defaults`/`sections`/`generate`). We build our own TS version.*

## Why
Today every shape's UI is hand-coded in `App.tsx` and every shape is a separate
firmware path. A module that **declares** its parameters lets one component render the
panel and one pipeline run the geometry. Adding a generator becomes "one pure file."

## The field schema
A field is data, not JSX. Minimum set we need (extend later):

```ts
type Field =
  | { type:"range";  key; label; unit?; default:number; min:number; max:number; step:number }
  | { type:"number"; key; label; unit?; default:number; min?:number; max?:number; step?:number }
  | { type:"select"; key; label; default:string; options:{value:string;label:string}[] }
  | { type:"toggle"; key; label; default:boolean }
  | { type:"color";  key; label; default:string };

interface Section { title:string; fields:Field[]; }
```

Nice-to-haves to copy from the reference later: `resetValue` (separate from default),
`sliderMin/sliderMax` (clamp UI range wider than valid range), and `previewGuide`
(tooltip explaining the param). Add them only when needed.

## The module
```ts
interface Module {
  key:string; label:string; kind:"make"|"modify"; group?:string;
  sections:Section[];
  generate(params:Record<string,any>, ctx:GenCtx):Frame;
}
```
`generate` is pure. `defaultsOf(module)` folds every field's `default` into the initial
values object. The Make/Modify menus are just `[...registry.values()].filter(kind)`.

## ParamPanel
```tsx
function ParamPanel({ sections, values, onChange }) {
  // for each section → header; for each field → switch(field.type) → control
  // range → <ParamSlider>, select → <select>, color → <input type=color>,
  // toggle → switch, number → <FieldInline>
}
```
Reuse the existing `ParamSlider`, `FieldInline`, `FillPicker`, `GcodeSelect` styles so
it looks native immediately. Persist `values` per module key in localStorage (same
helper shape as `papers.ts`/`matrices.ts`).

## Build order (Days 3–5)
1. `registry.ts` types + `register`/`defaultsOf`.
2. One module (`box.ts`) to exercise it.
3. `ParamPanel.tsx` rendering `box.sections`.
4. `StudioTab.tsx` wiring picker → panel → `compile` → `streamQueries`.

## Tests
- `defaultsOf` returns every key with its default.
- `box.generate({...})` Frame bbox equals the requested size at the requested centre.
