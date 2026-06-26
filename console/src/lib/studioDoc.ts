// Named Studio documents — save/load/rename/delete a whole layer stack, plus JSON
// export/import. The single working stack already auto-persists (plotterStudioLayers);
// this adds a library of named docs (same pattern as papers.ts / matrices.ts).

import type { Layer, LayerGroup } from "./pipeline";
import { getModule } from "./registry";

export interface StudioDoc { name: string; layers: Layer[]; groups: LayerGroup[]; }

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
        groupId: typeof r.groupId === "string" ? r.groupId : undefined,
      });
    }
  }
  return out;
}

/** Keep only well-formed group records. */
export function sanitizeGroups(raw: unknown): LayerGroup[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((g) => {
    if (!g || typeof g !== "object") return [];
    const r = g as Partial<LayerGroup>;
    if (typeof r.id !== "string") return [];
    return [{
      id: r.id,
      name: typeof r.name === "string" ? r.name : "Group",
      tx: typeof r.tx === "number" ? r.tx : 0,
      ty: typeof r.ty === "number" ? r.ty : 0,
      rotateDeg: typeof r.rotateDeg === "number" ? r.rotateDeg : 0,
    }];
  });
}

export function loadDocs(): StudioDoc[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map((d) => ({
        name: String(d?.name ?? "untitled"),
        layers: sanitizeLayers(d?.layers),
        groups: sanitizeGroups(d?.groups),
      }));
    }
  } catch { /* ignore */ }
  return [];
}

export function saveDocs(docs: StudioDoc[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(docs)); } catch { /* ignore */ }
}

/** Serialize a stack + groups for file download. */
export function serializeDoc(name: string, layers: Layer[], groups: LayerGroup[]): string {
  return JSON.stringify({ format: "polar-plotter-studio", version: "1.4", name, layers, groups }, null, 2);
}

/** Parse an imported file: accepts { layers: [...], groups: [...] } or a bare layers array. */
export function parseDocFile(text: string): StudioDoc {
  const o = JSON.parse(text);
  const layers = sanitizeLayers(Array.isArray(o) ? o : o?.layers);
  const groups = sanitizeGroups(o?.groups);
  return { name: (o && typeof o.name === "string") ? o.name : "imported", layers, groups };
}
