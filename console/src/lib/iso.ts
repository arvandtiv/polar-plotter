// Isometric / axonometric projection kernel — the one shared piece under the 3D
// wireframe family (tube3d, surface3d, isoForms, wrap3d). Pure math, no deps.
//
// World space: x right, y away-from-viewer (into the page), z UP.
// Screen space: plotter mm, x right, y DOWN (so +z maps to −screenY).
// View: yaw rotates the scene about z (plan rotation), pitch tilts it toward the
// viewer (0° = front view, 90° = straight-down plan). Classic isometric =
// yaw 45°, pitch 35.264°. `persp` > 0 adds weak perspective (mm focal-ish; 0 = ortho).

export interface Vec3 { x: number; y: number; z: number; }
export interface IsoView {
  cosYaw: number; sinYaw: number;
  cosP: number; sinP: number;
  persp: number;
}
export interface Projected { x: number; y: number; depth: number; }

export function makeView(yawDeg: number, pitchDeg: number, persp = 0): IsoView {
  const yw = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  return { cosYaw: Math.cos(yw), sinYaw: Math.sin(yw), cosP: Math.cos(p), sinP: Math.sin(p), persp };
}

/** Project a world point. depth grows AWAY from the viewer (use it for cueing).
 *  Camera sits front-and-ABOVE looking down-forward: view dir d = (0, cosP, −sinP),
 *  screen-up u = (0, sinP, cosP) — so far ground rises on the page and +z is up. */
export function project(v: IsoView, p: Vec3): Projected {
  const x1 = p.x * v.cosYaw - p.y * v.sinYaw;
  const y1 = p.x * v.sinYaw + p.y * v.cosYaw;
  const depth = y1 * v.cosP - p.z * v.sinP;
  let sx = x1;
  let sy = -(y1 * v.sinP) - p.z * v.cosP;   // screen y is DOWN: up-vector component negated
  if (v.persp > 0) {
    const s = v.persp / Math.max(v.persp * 0.2, v.persp + depth);
    sx *= s; sy *= s;
  }
  return { x: sx, y: sy, depth };
}

/** Depth-component of a transformed direction: NEGATIVE = faces the viewer.
 *  Use for backface culling / hide-back on wrapped surfaces. */
export function facingDepth(v: IsoView, n: Vec3): number {
  const y1 = n.x * v.sinYaw + n.y * v.cosYaw;
  return y1 * v.cosP - n.z * v.sinP;
}

// ---- small vector helpers ----------------------------------------------------
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  return l < 1e-12 ? { x: 0, y: 0, z: 1 } : { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Orthonormal frame (N, B) perpendicular to tangent T — ring plane for tubes. */
export function ringFrame(T: Vec3): { N: Vec3; B: Vec3 } {
  const t = norm(T);
  const up: Vec3 = Math.abs(t.z) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const N = norm(cross(t, up));
  const B = norm(cross(t, N));
  return { N, B };
}

/** Deterministic 2-octave value noise on a seeded lattice, in [-1, 1]. */
export function makeValueNoise(seed: number, cells = 16): (u: number, vv: number) => number {
  // xorshift-ish lattice fill from the seed — deterministic across platforms.
  let st = (seed >>> 0) || 1;
  const rnd = () => {
    st ^= st << 13; st >>>= 0; st ^= st >> 17; st ^= st << 5; st >>>= 0;
    return st / 4294967296;
  };
  const n = cells + 2;
  const g: number[] = [];
  for (let i = 0; i < n * n; i++) g.push(rnd() * 2 - 1);
  const lat = (ix: number, iy: number) =>
    g[((iy % n) + n) % n * n + (((ix % n) + n) % n)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const sample = (u: number, vv: number) => {
    const ix = Math.floor(u), iy = Math.floor(vv);
    const fu = smooth(u - ix), fv = smooth(vv - iy);
    const a = lat(ix, iy), b = lat(ix + 1, iy), c = lat(ix, iy + 1), d = lat(ix + 1, iy + 1);
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
  return (u, vv) => 0.7 * sample(u, vv) + 0.3 * sample(u * 2.7 + 11.3, vv * 2.7 + 7.9);
}
