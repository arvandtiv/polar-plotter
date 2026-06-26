// Per-module parameter persistence (localStorage), with a defaults-merge so a stored
// blob from an older module version still gets new fields' defaults and drops removed
// ones. Same convention as papers.ts / matrices.ts. See docs/v1.3/02-fields-and-registry.md.

import { defaultsOf, type Module, type ParamValues } from "./registry";

const storageKey = (moduleKey: string) => `plotterModule:${moduleKey}`;

/**
 * Defaults define the authoritative key set + types. Stored values override a key
 * only when present AND of the same primitive type (guards against schema drift /
 * corrupt data). Unknown stored keys are ignored.
 */
export function mergeDefaults(defaults: ParamValues, stored: unknown): ParamValues {
  const out: ParamValues = { ...defaults };
  if (stored && typeof stored === "object") {
    const s = stored as Record<string, unknown>;
    for (const key of Object.keys(defaults)) {
      if (key in s && typeof s[key] === typeof defaults[key]) {
        out[key] = s[key] as ParamValues[string];
      }
    }
  }
  return out;
}

export function loadValues(mod: Module): ParamValues {
  const defaults = defaultsOf(mod);
  if (typeof localStorage === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(storageKey(mod.key));
    return mergeDefaults(defaults, raw ? JSON.parse(raw) : null);
  } catch {
    return defaults;
  }
}

export function saveValues(moduleKey: string, values: ParamValues): void {
  try {
    localStorage.setItem(storageKey(moduleKey), JSON.stringify(values));
  } catch {
    /* quota / denied — ignore */
  }
}
