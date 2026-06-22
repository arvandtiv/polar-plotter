// Named Studio documents — save/load/rename/delete a whole layer stack, plus JSON
// export/import. The single working stack already auto-persists (plotterStudioLayers);
// this adds a library of named docs (same pattern as papers.ts / matrices.ts).

import type { Layer } from "./pipeline";
import { getModule } from "./registry";

export interface StudioDoc { name: string; layers: Layer[]; }

const KEY = "plotterStudioDocs";

/** Keep only well-formed layers whose module is still registered. */
export function sanitizeLayers(raw: unknown): Layer[] {
  if (!Array.isArray(raw)) return [];
  const out: Layer[] = [];
  for (const l of raw) {
    if (l && typeof l === "object" && typeof (l as Layer).moduleKey === "string" && getModule((l as Layer).moduleKey)) {
      const r = l as Partial<Layer>;
      out.push({
        id: typeof r.id === "string" ? r.id : `L${Math.random().toString(36).slice(2)}`,
        moduleKey: r.moduleKey as string,
        params: (r.params && typeof r.params === "object") ? r.params : {},
      });
    }
  }
  return out;
}

export function loadDocs(): StudioDoc[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((d) => ({ name: String(d?.name ?? "untitled"), layers: sanitizeLayers(d?.layers) }));
    }
  } catch { /* ignore */ }
  return [];
}

export function saveDocs(docs: StudioDoc[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(docs)); } catch { /* ignore */ }
}

/** Serialize a stack for file download. */
export function serializeDoc(name: string, layers: Layer[]): string {
  return JSON.stringify({ format: "polar-plotter-studio", version: "1.3", name, layers }, null, 2);
}

/** Parse an imported file: accepts { layers: [...] } or a bare [...] array. */
export function parseDocFile(text: string): StudioDoc {
  const o = JSON.parse(text);
  const layers = sanitizeLayers(Array.isArray(o) ? o : o?.layers);
  return { name: (o && typeof o.name === "string") ? o.name : "imported", layers };
}
