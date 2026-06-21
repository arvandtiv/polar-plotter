// v1.3 module registry — the contract shared by "Make" (generators) and "Modify"
// (modifiers). A module declares its parameters as data (`sections`/`fields`, rendered
// by ParamPanel) and a pure `generate(params, ctx)` returning a Frame.
// See docs/v1.3/02-fields-and-registry.md.

import type { Frame } from "./frame";

export interface FieldBase {
  key: string;
  label: string;
  unit?: string;
  default: number | string | boolean;
}
export type Field =
  | (FieldBase & { type: "range"; min: number; max: number; step: number })
  | (FieldBase & { type: "number"; min?: number; max?: number; step?: number })
  | (FieldBase & { type: "select"; options: { value: string; label: string }[] })
  | (FieldBase & { type: "toggle" })
  | (FieldBase & { type: "color" })
  | (FieldBase & { type: "text"; placeholder?: string });

export interface Section { title: string; fields: Field[]; }

export interface GenCtx {
  /** Active work-area extents (mm from origin). */
  bounds: { left: number; right: number; up: number; down: number };
  /** For modifiers: the composited frame of every layer below this one. */
  lowerFrame?: Frame;
}

export type ParamValues = Record<string, number | string | boolean>;

export interface Module {
  key: string;
  label: string;
  kind: "make" | "modify";
  group?: string;                 // menu grouping
  description?: string;
  sections: Section[];
  generate(params: ParamValues, ctx: GenCtx): Frame;
}

const _registry = new Map<string, Module>();

export function register(mod: Module): void {
  if (_registry.has(mod.key)) {
    // last registration wins, but warn — usually a double-import bug
    console.warn(`[registry] module "${mod.key}" re-registered`);
  }
  _registry.set(mod.key, mod);
}

export function getModule(key: string): Module | undefined {
  return _registry.get(key);
}

export function listModules(kind?: "make" | "modify"): Module[] {
  const all = [..._registry.values()];
  return kind ? all.filter((m) => m.kind === kind) : all;
}

/** Fold every field's `default` into the initial values object for a module. */
export function defaultsOf(mod: Module): ParamValues {
  const values: ParamValues = {};
  for (const section of mod.sections) {
    for (const field of section.fields) values[field.key] = field.default;
  }
  return values;
}

/** Coerce a field value to a number (for range/number fields). */
export function num(values: ParamValues, key: string, fallback = 0): number {
  const v = Number(values[key]);
  return Number.isFinite(v) ? v : fallback;
}
