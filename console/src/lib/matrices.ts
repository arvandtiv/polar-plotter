// User-defined affine-matrix presets, persisted in localStorage so they survive
// reloads. The firmware applies an affine warp to the logical (x,y) command space
// (x' = a*x + b*y + tx ; y' = c*x + d*y + ty) but never persists it — startup is
// always identity. These named presets are a console convenience for exploring
// rotation/shear/scale/offset warps; "apply" pushes one to the firmware session.

export interface Matrix {
  name: string;
  a: number; b: number; c: number; d: number; tx: number; ty: number;
}

const MATRICES_KEY = 'plotterMatrices';

// The passthrough warp — also the firmware's startup default.
export const IDENTITY_MATRIX: Matrix = { name: 'Identity', a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

// Seeded defaults if the user has none yet (Identity + a couple of explorers).
const DEFAULT_MATRICES: Matrix[] = [
  { ...IDENTITY_MATRIX },
];

export function loadMatrices(): Matrix[] {
  if (typeof localStorage === 'undefined') return DEFAULT_MATRICES.map((m) => ({ ...m }));
  try {
    const raw = localStorage.getItem(MATRICES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr as Matrix[];
    }
  } catch { /* corrupt → fall back to default */ }
  return DEFAULT_MATRICES.map((m) => ({ ...m }));
}

export function saveMatrices(list: Matrix[]): void {
  try { localStorage.setItem(MATRICES_KEY, JSON.stringify(list)); } catch { /* quota/denied — ignore */ }
}
