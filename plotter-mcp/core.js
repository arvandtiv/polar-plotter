// src/lib/registry.ts
var _registry = /* @__PURE__ */ new Map();
function register(mod) {
  if (_registry.has(mod.key)) {
    console.warn(`[registry] module "${mod.key}" re-registered`);
  }
  _registry.set(mod.key, mod);
}
function getModule(key) {
  return _registry.get(key);
}
function listModules(kind) {
  const all = [..._registry.values()];
  return kind ? all.filter((m) => m.kind === kind) : all;
}
function defaultsOf(mod) {
  const values = {};
  for (const section of mod.sections) {
    for (const field of section.fields) values[field.key] = field.default;
  }
  return values;
}
function num(values, key, fallback = 0) {
  const v = Number(values[key]);
  return Number.isFinite(v) ? v : fallback;
}

// src/lib/frame.ts
function clonePath(path) {
  return { ...path, points: path.points.map((p) => ({ x: p.x, y: p.y })) };
}
function rectPath(cx, cy, w, h) {
  const hx = w / 2, hy = h / 2;
  return {
    closed: true,
    points: [
      { x: cx - hx, y: cy - hy },
      { x: cx + hx, y: cy - hy },
      { x: cx + hx, y: cy + hy },
      { x: cx - hx, y: cy + hy }
    ]
  };
}

// src/lib/modules/box.ts
var boxModule = {
  key: "box",
  label: "Box",
  kind: "make",
  group: "Shapes",
  description: "An axis-aligned rectangle.",
  sections: [
    {
      title: "Size",
      fields: [
        { key: "width", label: "Width", type: "range", min: 1, max: 600, step: 1, unit: "mm", default: 100 },
        { key: "height", label: "Height", type: "range", min: 1, max: 600, step: 1, unit: "mm", default: 100 }
      ]
    },
    {
      title: "Position",
      fields: [
        { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
        { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
      ]
    }
  ],
  generate(params) {
    const w = num(params, "width", 100);
    const h = num(params, "height", 100);
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    return { widthMm: w, heightMm: h, paths: [rectPath(cx, cy, w, h)], meta: { title: "Box" } };
  }
};
register(boxModule);

// src/lib/modules/circle.ts
var CHORD_ERR_MM = 0.2;
function arcSegments(radiusMm, maxErrMm) {
  if (radiusMm <= 0 || maxErrMm <= 0) return 32;
  let ratio = 1 - maxErrMm / radiusMm;
  ratio = Math.max(-1, Math.min(1, ratio));
  const a = 2 * Math.acos(ratio);
  const n = a > 1e-6 ? Math.ceil(2 * Math.PI / a) : 720;
  return Math.max(32, Math.min(720, n));
}
var circleModule = {
  key: "circle",
  label: "Circle",
  kind: "make",
  group: "Shapes",
  description: "A circle approximated by an adaptive polygon.",
  sections: [
    { title: "Size", fields: [
      { key: "r", label: "Radius", type: "range", min: 1, max: 300, step: 1, unit: "mm", default: 50 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "\xD7", default: 1 }
    ] }
  ],
  generate(params) {
    const r2 = num(params, "r", 50);
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const n = arcSegments(r2, CHORD_ERR_MM);
    const points = [];
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * i / n;
      points.push({ x: cx + r2 * Math.cos(a), y: cy + r2 * Math.sin(a) });
    }
    const path = { points, closed: true, cycles };
    return { widthMm: 2 * r2, heightMm: 2 * r2, paths: [path], meta: { title: "Circle", noSimplify: true } };
  }
};
register(circleModule);

// src/lib/geom.ts
var dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
function bounds(points) {
  if (!points.length) return null;
  let x0 = points[0].x, y0 = points[0].y, x1 = x0, y1 = y0;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}
function resample(points, spacingMm) {
  if (points.length < 2 || spacingMm <= 0) return points.map((p) => ({ ...p }));
  const out = [{ ...points[0] }];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    let a = out[out.length - 1];
    const b = points[i];
    let segLen = dist(a, b);
    while (acc + segLen >= spacingMm) {
      const t = (spacingMm - acc) / segLen;
      const np = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(np);
      a = np;
      segLen = dist(a, b);
      acc = 0;
    }
    acc += segLen;
  }
  const last = points[points.length - 1];
  if (dist(out[out.length - 1], last) > 1e-9) out.push({ ...last });
  return out;
}
function rotate(points, angleRad, cx = 0, cy = 0) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return points.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}
function clipSegmentToRect(a, b, rect) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.x0, rect.x1 - a.x, a.y - rect.y0, rect.y1 - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r2 = q[i] / p[i];
      if (p[i] < 0) {
        if (r2 > t1) return null;
        if (r2 > t0) t0 = r2;
      } else {
        if (r2 < t0) return null;
        if (r2 < t1) t1 = r2;
      }
    }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}
function sampleBezier(p0, p1, p2, p3, n) {
  const out = [];
  const steps = Math.max(1, Math.floor(n));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    });
  }
  return out;
}
function pointLineDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}
function simplifyRDP(points, tol) {
  if (points.length < 3 || tol <= 0) return points.map((p) => ({ ...p }));
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointLineDistance(points[i], points[lo], points[hi]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > tol) {
      keep[idx] = true;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}
function seededRandom(seed) {
  let a = seed >>> 0;
  return function() {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// src/lib/modules/square.ts
var squareModule = {
  key: "square",
  label: "Square",
  kind: "make",
  group: "Shapes",
  description: "A square with optional rotation.",
  sections: [
    { title: "Size", fields: [
      { key: "size", label: "Size", type: "range", min: 1, max: 600, step: 1, unit: "mm", default: 100 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "rotation", label: "Rotation", type: "range", min: -180, max: 180, step: 1, unit: "\xB0", default: 0 }
    ] },
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "\xD7", default: 1 }
    ] }
  ],
  generate(params) {
    const s = num(params, "size", 100);
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const rot = num(params, "rotation", 0) * Math.PI / 180;
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const h = s / 2;
    let pts = [
      { x: cx - h, y: cy - h },
      { x: cx + h, y: cy - h },
      { x: cx + h, y: cy + h },
      { x: cx - h, y: cy + h }
    ];
    if (rot) pts = rotate(pts, rot, cx, cy);
    const path = { points: pts, closed: true, cycles };
    return { widthMm: s, heightMm: s, paths: [path], meta: { title: "Square" } };
  }
};
register(squareModule);

// src/lib/modules/wobbly.ts
var wobblyModule = {
  key: "wobbly",
  label: "Wobbly",
  kind: "make",
  group: "Lines & Patterns",
  description: "A closed random curve built from radial harmonics.",
  sections: [
    { title: "Shape", fields: [
      { key: "r", label: "Radius", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 60 },
      { key: "wobble", label: "Wobble", type: "range", min: 0, max: 1, step: 0.01, default: 0.4 },
      { key: "harmonics", label: "Harmonics", type: "range", min: 1, max: 8, step: 1, default: 3 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "\xD7", default: 1 }
    ] }
  ],
  generate(params) {
    const r2 = num(params, "r", 60);
    const wobble = num(params, "wobble", 0.4);
    const harmonics = Math.max(1, Math.min(8, Math.round(num(params, "harmonics", 3))));
    const seed = Math.round(num(params, "seed", 42));
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const rng = seededRandom(seed);
    const amp = [];
    const phase = [];
    for (let h = 0; h < harmonics; h++) {
      amp.push(wobble * r2 / (h + 1) * rng());
      phase.push(rng() * 2 * Math.PI);
    }
    const n = Math.max(120, Math.min(512, harmonics * 48));
    const minR = r2 * 0.05;
    const points = [];
    for (let i = 0; i < n; i++) {
      const theta = 2 * Math.PI * i / n;
      let rr = r2;
      for (let h = 0; h < harmonics; h++) rr += amp[h] * Math.sin((h + 1) * theta + phase[h]);
      if (rr < minR) rr = minR;
      points.push({ x: cx + rr * Math.cos(theta), y: cy + rr * Math.sin(theta) });
    }
    const path = { points, closed: true, cycles };
    return { widthMm: 2 * r2, heightMm: 2 * r2, paths: [path], meta: { title: "Wobbly" } };
  }
};
register(wobblyModule);

// src/lib/modules/ruledLines.ts
function clampGap(offs, minGap) {
  if (minGap <= 0) return offs;
  const out = [];
  let last = -Infinity;
  for (const o of offs) {
    if (o - last >= minGap) {
      out.push(o);
      last = o;
    }
  }
  return out;
}
function bandOffsets(omin, omax, s, gradient, stops, minGap) {
  const span = omax - omin;
  if (span <= 0) return [omin];
  if (stops.length >= 2) {
    const dens = (u) => {
      const x = u * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(x));
      const f = x - i;
      return Math.max(0, stops[i] * (1 - f) + stops[i + 1] * f);
    };
    const M = 400;
    const cdf = new Array(M + 1);
    cdf[0] = 0;
    for (let i = 1; i <= M; i++) cdf[i] = cdf[i - 1] + 0.5 * (dens((i - 1) / M) + dens(i / M)) / M;
    const total = cdf[M];
    if (total > 1e-9) {
      const N = Math.max(1, Math.round(span / s));
      const offs2 = [];
      let j = 0;
      for (let k = 0; k <= N; k++) {
        const target = k / N * total;
        while (j < M && cdf[j + 1] < target) j++;
        const segLen = cdf[j + 1] - cdf[j];
        const f = segLen > 1e-12 ? (target - cdf[j]) / segLen : 0;
        offs2.push(omin + span * ((j + f) / M));
      }
      return clampGap(offs2, minGap);
    }
  }
  const offs = [];
  if (gradient > 0) {
    const N = Math.max(1, Math.round(span / s)), p = 1 + 2 * gradient;
    for (let k = 0; k <= N; k++) offs.push(omin + span * Math.pow(k / N, p));
  } else {
    for (let o = Math.ceil(omin / s) * s; o <= omax + 1e-9; o += s) offs.push(o);
  }
  return clampGap(offs, minGap);
}
function arcSnake(a, b, jitter, rng) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return [a, b];
  const per = 35 + rng() * 40;
  const n = Math.max(1, Math.round(len / per));
  const chord = len / n;
  let x = 0, y = 0, h = 0;
  const pts = [{ x: 0, y: 0 }];
  let sign = rng() < 0.5 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const sag = Math.min(jitter * (0.5 + rng()), chord * 0.45);
    const theta = 4 * Math.atan(2 * sag / chord) * sign;
    if (Math.abs(theta) < 1e-4) {
      x += Math.cos(h) * chord;
      y += Math.sin(h) * chord;
      pts.push({ x, y });
    } else {
      const R = chord / (2 * Math.sin(Math.abs(theta) / 2));
      const cxA = x + (theta > 0 ? R : -R) * -Math.sin(h);
      const cyA = y + (theta > 0 ? R : -R) * Math.cos(h);
      const phi0 = Math.atan2(y - cyA, x - cxA);
      const steps = Math.min(200, Math.max(6, Math.ceil(R * Math.abs(theta) / 2)));
      for (let k = 1; k <= steps; k++) {
        const phi = phi0 + theta * (k / steps);
        pts.push({ x: cxA + R * Math.cos(phi), y: cyA + R * Math.sin(phi) });
      }
      x = pts[pts.length - 1].x;
      y = pts[pts.length - 1].y;
      h += theta;
    }
    sign = -sign;
  }
  const ex = x, ey = y;
  const elen = Math.hypot(ex, ey);
  if (elen < 1e-6) return [a, b];
  const rot = Math.atan2(b.y - a.y, b.x - a.x) - Math.atan2(ey, ex);
  const sc = len / elen;
  const cr = Math.cos(rot) * sc, sr = Math.sin(rot) * sc;
  return pts.map((p) => ({ x: a.x + p.x * cr - p.y * sr, y: a.y + p.x * sr + p.y * cr }));
}
function ruledDir(rect, theta, spacing, jitter, rng, gradient = 0, stops = [], minGap = 0, style = "arc") {
  const s = Math.max(0.5, spacing);
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  const dx = Math.cos(theta), dy = Math.sin(theta);
  const nx = -Math.sin(theta), ny = Math.cos(theta);
  let omin = Infinity, omax = -Infinity;
  for (const [x, y] of [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]) {
    const o = (x - cx) * nx + (y - cy) * ny;
    if (o < omin) omin = o;
    if (o > omax) omax = o;
  }
  const offsets = bandOffsets(omin, omax, s, gradient, stops, minGap);
  const L = rect.x1 - rect.x0 + (rect.y1 - rect.y0) + 10;
  const out = [];
  for (const o of offsets) {
    const bx = cx + o * nx, by = cy + o * ny;
    const seg = clipSegmentToRect({ x: bx - L * dx, y: by - L * dy }, { x: bx + L * dx, y: by + L * dy }, rect);
    if (!seg) continue;
    if (jitter <= 0) {
      out.push({ points: [seg[0], seg[1]] });
      continue;
    }
    if (style === "arc") {
      out.push({ points: arcSnake(seg[0], seg[1], jitter, rng) });
      continue;
    }
    const [a, b] = seg;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.round(len / 5));
    const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
    const k1 = 1 + Math.floor(rng() * 2), k2 = 2 + Math.floor(rng() * 3);
    const amp = jitter * (0.7 + 0.6 * rng());
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const env = Math.sin(Math.PI * t);
      const off = amp * env * (0.6 * Math.sin(t * k1 * 2 * Math.PI + p1) + 0.4 * Math.sin(t * k2 * 2 * Math.PI + p2));
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
    }
    out.push({ points: pts });
  }
  return out;
}
var ruledLinesModule = {
  key: "ruledLines",
  label: "Ruled lines",
  kind: "make",
  group: "Lines & Patterns",
  description: "Straight parallel lines filling a rectangle, in any mix of the four LeWitt directions (\u2502 \u2500 \u2571 \u2572), superimposed.",
  sections: [
    { title: "Region", fields: [
      { key: "w", label: "Width", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 150 },
      { key: "h", label: "Height", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 150 },
      { key: "spacing", label: "Line spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 12 }
    ] },
    { title: "Directions", fields: [
      { key: "vertical", label: "Vertical \u2502", type: "toggle", default: true },
      { key: "horizontal", label: "Horizontal \u2500", type: "toggle", default: true },
      { key: "diagRight", label: "Diagonal \u2571", type: "toggle", default: false },
      { key: "diagLeft", label: "Diagonal \u2572", type: "toggle", default: false }
    ] },
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 20, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterStyle", label: "Deviation", type: "select", default: "arc", options: [
        { value: "arc", label: "Arcs (smooth bows)" },
        { value: "wave", label: "Waves (hand wobble)" }
      ] },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Density ramp", fields: [
      { key: "gradient", label: "Gradient", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "densityStops", label: "Density stops", type: "text", placeholder: "e.g. 1,0.2,1  (overrides gradient)", default: "" },
      { key: "minGap", label: "Min line gap", type: "range", min: 0, max: 20, step: 0.5, unit: "mm", default: 0 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const w = num(params, "w", 150), h = num(params, "h", 150);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const spacing = num(params, "spacing", 12);
    const jitter = num(params, "jitter", 0);
    const gradient = num(params, "gradient", 0);
    const minGap = num(params, "minGap", 0);
    const stops = String(params.densityStops ?? "").split(/[,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
    const style = String(params.jitterStyle ?? "arc");
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const paths = [];
    if (params.horizontal !== false) paths.push(...ruledDir(rect, 0, spacing, jitter, rng, gradient, stops, minGap, style));
    if (params.vertical !== false) paths.push(...ruledDir(rect, Math.PI / 2, spacing, jitter, rng, gradient, stops, minGap, style));
    if (params.diagRight) paths.push(...ruledDir(rect, -Math.PI / 4, spacing, jitter, rng, gradient, stops, minGap, style));
    if (params.diagLeft) paths.push(...ruledDir(rect, Math.PI / 4, spacing, jitter, rng, gradient, stops, minGap, style));
    return { widthMm: w, heightMm: h, paths, meta: { title: "Ruled lines" } };
  }
};
register(ruledLinesModule);

// src/lib/modules/connectDots.ts
function pointsFor(preset, h, cx, cy, count, seed) {
  const C = [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
  const M = [{ x: cx, y: cy - h }, { x: cx + h, y: cy }, { x: cx, y: cy + h }, { x: cx - h, y: cy }];
  const center = { x: cx, y: cy };
  switch (preset) {
    case "corners":
      return C;
    case "cornersCenter":
      return [...C, center];
    case "cornersMid":
      return [...C, ...M];
    case "cornersMidCenter":
      return [...C, ...M, center];
    case "perimeter": {
      const n = Math.max(3, Math.round(count));
      const side = 2 * h, total = 4 * side, out = [];
      for (let k = 0; k < n; k++) {
        let d = k * total / n;
        if (d < side) out.push({ x: cx - h + d, y: cy - h });
        else if (d < 2 * side) {
          d -= side;
          out.push({ x: cx + h, y: cy - h + d });
        } else if (d < 3 * side) {
          d -= 2 * side;
          out.push({ x: cx + h - d, y: cy + h });
        } else {
          d -= 3 * side;
          out.push({ x: cx - h, y: cy + h - d });
        }
      }
      return out;
    }
    case "grid": {
      const m = Math.max(2, Math.round(count)), out = [];
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++)
        out.push({ x: cx - h + 2 * h * i / (m - 1), y: cy - h + 2 * h * j / (m - 1) });
      return out;
    }
    case "random": {
      const n = Math.max(3, Math.round(count)), rng = seededRandom(seed), out = [];
      for (let k = 0; k < n; k++) out.push({ x: cx - h + rng() * 2 * h, y: cy - h + rng() * 2 * h });
      return out;
    }
    default:
      return C;
  }
}
function joinLine(a, b, jitter, rng) {
  if (jitter <= 0) return { points: [a, b] };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { points: [a, b] };
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const steps = Math.max(2, Math.round(len / 8));
  const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
  const k1 = 1 + Math.floor(rng() * 2), k2 = 2 + Math.floor(rng() * 2);
  const amp = jitter * (0.7 + 0.6 * rng());
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, env = Math.sin(Math.PI * t);
    const off = amp * env * (0.6 * Math.sin(t * k1 * 2 * Math.PI + p1) + 0.4 * Math.sin(t * k2 * 2 * Math.PI + p2));
    pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
  }
  return { points: pts };
}
var connectDotsModule = {
  key: "connectDots",
  label: "Connect dots",
  kind: "make",
  group: "Lines & Patterns",
  description: "Places architectural points (corners / midpoints / perimeter / grid / random) and joins every pair with a straight (or hand-drawn) line \u2014 a complete-graph web.",
  sections: [
    { title: "Points", fields: [
      { key: "preset", label: "Point set", type: "select", default: "cornersMidCenter", options: [
        { value: "corners", label: "4 corners" },
        { value: "cornersCenter", label: "Corners + center" },
        { value: "cornersMid", label: "Corners + edge midpoints" },
        { value: "cornersMidCenter", label: "Corners + midpoints + center" },
        { value: "perimeter", label: "Perimeter (count)" },
        { value: "grid", label: "Grid (count \xD7 count)" },
        { value: "random", label: "Random (count)" }
      ] },
      { key: "count", label: "Count", type: "range", min: 3, max: 24, step: 1, default: 12 },
      { key: "pointSeed", label: "Point seed", type: "range", min: 0, max: 9999, step: 1, default: 3 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 260 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 260), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const pts = pointsFor(
      String(params.preset ?? "cornersMidCenter"),
      h,
      cx,
      cy,
      num(params, "count", 12),
      Math.round(num(params, "pointSeed", 3))
    );
    const jitter = num(params, "jitter", 0);
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const paths = [];
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        paths.push(joinLine(pts[i], pts[j], jitter, rng));
    return { widthMm: size, heightMm: size, paths, meta: { title: "Connect dots" } };
  }
};
register(connectDotsModule);

// src/lib/modules/strokeField.ts
function curve(a, b, jitter, rng) {
  if (jitter <= 0) return { points: [a, b] };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { points: [a, b] };
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const steps = Math.max(2, Math.round(len / 8));
  const p1 = rng() * 2 * Math.PI, amp = jitter * (0.6 + 0.5 * rng());
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, off = amp * Math.sin(Math.PI * t) * Math.sin(t * 2 * Math.PI + p1);
    pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
  }
  return { points: pts };
}
var strokeFieldModule = {
  key: "strokeField",
  label: "Stroke field",
  kind: "make",
  group: "Lines & Patterns",
  description: "A field of many short strokes covering the wall evenly (jittered grid), oriented randomly, by a smooth flow field, or aligned. Optionally hand-drawn.",
  sections: [
    { title: "Field", fields: [
      { key: "count", label: "Strokes", type: "range", min: 50, max: 2e3, step: 10, default: 600 },
      { key: "length", label: "Stroke length", type: "range", min: 5, max: 120, step: 1, unit: "mm", default: 40 },
      { key: "lengthVar", label: "Length variation", type: "range", min: 0, max: 1, step: 0.05, default: 0.4 },
      { key: "spread", label: "Position jitter", type: "range", min: 0, max: 1, step: 0.05, default: 0.7 }
    ] },
    { title: "Orientation", fields: [
      { key: "orient", label: "Mode", type: "select", default: "flow", options: [
        { value: "random", label: "Random" },
        { value: "flow", label: "Flow field" },
        { value: "aligned", label: "Aligned" }
      ] },
      { key: "angleDeg", label: "Angle / base", type: "range", min: 0, max: 180, step: 1, unit: "\xB0", default: 0 },
      { key: "flowScale", label: "Flow scale", type: "range", min: 0.2, max: 4, step: 0.1, default: 1.2 },
      { key: "flowSeed", label: "Flow / pos seed", type: "range", min: 0, max: 9999, step: 1, default: 5 }
    ] },
    { title: "Hand-drawn", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 12, step: 0.5, unit: "mm", default: 0 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 290 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const count = Math.round(num(params, "count", 600));
    const len = num(params, "length", 40), lvar = num(params, "lengthVar", 0.4), spread = num(params, "spread", 0.7);
    const orient = String(params.orient ?? "flow");
    const base = num(params, "angleDeg", 0) * Math.PI / 180;
    const fScale = num(params, "flowScale", 1.2) / 100;
    const jitter = num(params, "jitter", 0);
    const size = num(params, "size", 290), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const rng = seededRandom(Math.round(num(params, "flowSeed", 5)));
    const fp1 = rng() * 6.28, fp2 = rng() * 6.28, fk = 1 + rng();
    const n = Math.max(2, Math.round(Math.sqrt(count)));
    const pitch = size / n;
    const paths = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const px = cx - h + pitch * (i + 0.5) + (rng() - 0.5) * pitch * spread;
        const py = cy - h + pitch * (j + 0.5) + (rng() - 0.5) * pitch * spread;
        let ang;
        if (orient === "aligned") ang = base + (rng() - 0.5) * 0.25;
        else if (orient === "flow")
          ang = base + 1.4 * Math.sin(px * fScale * fk + py * fScale + fp1) + 0.8 * Math.sin(py * fScale * 1.7 - px * fScale + fp2);
        else ang = rng() * Math.PI;
        const L = len * (1 + lvar * (rng() * 2 - 1));
        const dx = Math.cos(ang) * L / 2, dy = Math.sin(ang) * L / 2;
        paths.push(curve({ x: px - dx, y: py - dy }, { x: px + dx, y: py + dy }, jitter, rng));
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Stroke field" } };
  }
};
register(strokeFieldModule);

// src/lib/modules/arcs.ts
var inside = (p, r2) => p.x >= r2.x0 && p.x <= r2.x1 && p.y >= r2.y0 && p.y <= r2.y1;
function centresFor(preset, h, cx, cy) {
  const C = [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
  const M = [{ x: cx, y: cy - h }, { x: cx + h, y: cy }, { x: cx, y: cy + h }, { x: cx - h, y: cy }];
  switch (preset) {
    case "corners":
      return C;
    case "midpoints":
      return M;
    case "cornersMid":
      return [...C, ...M];
    case "center":
      return [{ x: cx, y: cy }];
    default:
      return C;
  }
}
function arcRuns(c, R, rect, jitter, rng) {
  const steps = Math.max(48, Math.round(R * 0.9));
  const p1 = rng() * 6.28, p2 = rng() * 6.28, k1 = 2 + Math.floor(rng() * 2), k2 = 3 + Math.floor(rng() * 3);
  const runs = [];
  let cur = [];
  for (let i = 0; i <= steps; i++) {
    const a = 2 * Math.PI * i / steps;
    const rr = R + (jitter > 0 ? jitter * (0.6 * Math.sin(a * k1 + p1) + 0.4 * Math.sin(a * k2 + p2)) : 0);
    const p = { x: c.x + rr * Math.cos(a), y: c.y + rr * Math.sin(a) };
    if (inside(p, rect)) cur.push(p);
    else {
      if (cur.length > 1) runs.push({ points: cur });
      cur = [];
    }
  }
  if (cur.length > 1) runs.push({ points: cur });
  return runs;
}
var arcsModule = {
  key: "arcs",
  label: "Arcs",
  kind: "make",
  group: "Lines & Patterns",
  description: "Concentric arcs swung from chosen centres (corners / edge midpoints / centre), clipped to the frame. Optionally hand-drawn.",
  sections: [
    { title: "Arcs", fields: [
      { key: "centres", label: "Swung from", type: "select", default: "corners", options: [
        { value: "corners", label: "Four corners" },
        { value: "midpoints", label: "Edge midpoints" },
        { value: "cornersMid", label: "Corners + midpoints" },
        { value: "center", label: "Centre" }
      ] },
      { key: "count", label: "Arcs per centre", type: "range", min: 1, max: 40, step: 1, default: 12 },
      { key: "maxR", label: "Max radius", type: "range", min: 20, max: 500, step: 5, unit: "mm", default: 300 }
    ] },
    { title: "Hand-drawn", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Break symmetry", fields: [
      { key: "centreJitter", label: "Centre offset", type: "range", min: 0, max: 200, step: 1, unit: "mm", default: 0 },
      { key: "countJitter", label: "Count spread", type: "range", min: 0, max: 20, step: 1, default: 0 },
      { key: "radiusJitter", label: "Spacing irregularity", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "inset", label: "Centre inset", type: "range", min: 0, max: 150, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const rect = { x0: cx - h, y0: cy - h, x1: cx + h, y1: cy + h };
    let centres = centresFor(String(params.centres ?? "corners"), h, cx, cy);
    const inset = num(params, "inset", 0);
    if (inset > 0)
      centres = centres.map((c) => {
        const dx = cx - c.x, dy = cy - c.y, d = Math.hypot(dx, dy);
        return d < 1e-6 ? c : { x: c.x + dx / d * Math.min(inset, d), y: c.y + dy / d * Math.min(inset, d) };
      });
    const count = Math.max(1, Math.round(num(params, "count", 12)));
    const maxR = num(params, "maxR", 300);
    const jitter = num(params, "jitter", 0);
    const seed = Math.round(num(params, "jitterSeed", 7));
    const rng = seededRandom(seed);
    const centreJitter = num(params, "centreJitter", 0);
    const countJitter = num(params, "countJitter", 0);
    const radiusJitter = num(params, "radiusJitter", 0);
    const arng = seededRandom(seed + 1e3);
    if (centreJitter > 0)
      centres = centres.map((c) => ({
        x: c.x + (arng() * 2 - 1) * centreJitter,
        y: c.y + (arng() * 2 - 1) * centreJitter
      }));
    const paths = [];
    for (const c of centres) {
      const n = countJitter > 0 ? Math.max(1, Math.round(count + (arng() * 2 - 1) * countJitter)) : count;
      for (let k = 1; k <= n; k++) {
        const frac = radiusJitter > 0 ? Math.min(1, Math.max(0.02, k / n + (arng() * 2 - 1) * radiusJitter / n)) : k / n;
        paths.push(...arcRuns(c, frac * maxR, rect, jitter, rng));
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Arcs" } };
  }
};
register(arcsModule);

// src/lib/modules/locatedFigures.ts
function anchorsFor(preset, h, cx, cy) {
  const C = [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
  const M = [{ x: cx, y: cy - h }, { x: cx + h, y: cy }, { x: cx, y: cy + h }, { x: cx - h, y: cy }];
  const center = { x: cx, y: cy };
  switch (preset) {
    case "corners":
      return C;
    case "cornersMid":
      return [...C, ...M];
    case "cornersMidCenter":
      return [...C, ...M, center];
    default:
      return [...C, ...M, center];
  }
}
function joinLine2(a, b, jitter, rng) {
  if (jitter <= 0) return { points: [a, b] };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return { points: [a, b] };
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const steps = Math.max(2, Math.round(len / 8));
  const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
  const k1 = 1 + Math.floor(rng() * 2), k2 = 2 + Math.floor(rng() * 2);
  const amp = jitter * (0.7 + 0.6 * rng());
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, env = Math.sin(Math.PI * t);
    const off = amp * env * (0.6 * Math.sin(t * k1 * 2 * Math.PI + p1) + 0.4 * Math.sin(t * k2 * 2 * Math.PI + p2));
    pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
  }
  return { points: pts };
}
function figureVerts(kind, fx, fy, w, hgt, topRatio, ang, shear, skew, rng) {
  const hy = hgt / 2, bw = w / 2;
  let base;
  if (kind === "parallelogram") {
    const k = shear;
    base = [{ x: -bw - k * hy, y: -hy }, { x: bw - k * hy, y: -hy }, { x: bw + k * hy, y: hy }, { x: -bw + k * hy, y: hy }];
  } else if (kind === "irregular") {
    const n = 5 + Math.floor(rng() * 4);
    const angles = [];
    for (let i = 0; i < n; i++) angles.push(2 * Math.PI * i / n + (rng() * 2 - 1) * (Math.PI / n) * 0.85);
    angles.sort((a, b) => a - b);
    base = angles.map((a) => {
      const r2 = bw * (0.45 + rng() * 0.8);
      return { x: r2 * Math.cos(a), y: r2 * Math.sin(a) };
    });
  } else {
    const tw = w * topRatio / 2;
    base = [{ x: -tw, y: -hy }, { x: tw, y: -hy }, { x: bw, y: hy }, { x: -bw, y: hy }];
  }
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return base.map((p) => ({
    x: fx + (p.x * ca - p.y * sa) + (rng() * 2 - 1) * skew,
    y: fy + (p.x * sa + p.y * ca) + (rng() * 2 - 1) * skew
  }));
}
var locatedFiguresModule = {
  key: "locatedFigures",
  label: "Located figures",
  kind: "make",
  group: "Lines & Patterns",
  description: "Irregular trapezoids placed asymmetrically, each fixed by a hand-drawn 'location web' of not-straight lines to the nearest architectural anchor points. Density-capped so no corner saturates.",
  sections: [
    { title: "Figures", fields: [
      { key: "figure", label: "Figure", type: "select", default: "trapezoid", options: [
        { value: "trapezoid", label: "Trapezoid" },
        { value: "parallelogram", label: "Parallelogram" },
        { value: "irregular", label: "Irregular polygon" }
      ] },
      { key: "count", label: "Figures", type: "range", min: 1, max: 12, step: 1, default: 4 },
      { key: "sizeMin", label: "Min size", type: "range", min: 20, max: 150, step: 1, unit: "mm", default: 45 },
      { key: "sizeMax", label: "Max size", type: "range", min: 30, max: 220, step: 1, unit: "mm", default: 95 },
      { key: "shear", label: "Shear (parallelogram)", type: "range", min: 0, max: 1.5, step: 0.05, default: 0.6 },
      { key: "rotMax", label: "Orientation spread", type: "range", min: 0, max: 1.2, step: 0.05, unit: "rad", default: 0.5 },
      { key: "skew", label: "Vertex skew", type: "range", min: 0, max: 30, step: 1, unit: "mm", default: 6 },
      { key: "cluster", label: "Cluster", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "figSeed", label: "Placement seed", type: "range", min: 0, max: 9999, step: 1, default: 5 }
    ] },
    { title: "Location web", fields: [
      { key: "anchors", label: "Anchor points", type: "select", default: "cornersMidCenter", options: [
        { value: "corners", label: "4 corners" },
        { value: "cornersMid", label: "Corners + midpoints" },
        { value: "cornersMidCenter", label: "Corners + midpoints + center" }
      ] },
      { key: "anchorsPerFigure", label: "Anchors per figure", type: "range", min: 1, max: 9, step: 1, default: 3 },
      { key: "vertsPerAnchor", label: "Verts per anchor", type: "range", min: 1, max: 4, step: 1, default: 2 }
    ] },
    { title: "Hand-drawn (not straight)", fields: [
      { key: "jitter", label: "Jitter", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 0 },
      { key: "jitterSeed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 280 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 280), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const kind = String(params.figure ?? "trapezoid");
    const count = Math.max(1, Math.round(num(params, "count", 4)));
    const sizeMin = num(params, "sizeMin", 45), sizeMax = Math.max(sizeMin + 1, num(params, "sizeMax", 95));
    const shear = num(params, "shear", 0.6), rotMax = num(params, "rotMax", 0.5);
    const skew = num(params, "skew", 6);
    const anchors = anchorsFor(String(params.anchors ?? "cornersMidCenter"), h, cx, cy);
    const anchorsPerFigure = Math.max(1, Math.round(num(params, "anchorsPerFigure", 3)));
    const vertsPerAnchor = Math.max(1, Math.round(num(params, "vertsPerAnchor", 2)));
    const jitter = num(params, "jitter", 0);
    const frng = seededRandom(Math.round(num(params, "figSeed", 5)));
    const rng = seededRandom(Math.round(num(params, "jitterSeed", 7)));
    const margin = Math.min(h * 0.7, sizeMax * 0.6);
    const cluster = num(params, "cluster", 0);
    let ccx = cx, ccy = cy, pr = h - margin;
    if (cluster > 0) {
      const oang = frng() * 2 * Math.PI, offR = (h - margin) * 0.55 * cluster;
      ccx = cx + Math.cos(oang) * offR;
      ccy = cy + Math.sin(oang) * offR;
      pr = (h - margin) * (1 - 0.55 * cluster);
    }
    const figs = [];
    for (let i = 0; i < count; i++) {
      const w = sizeMin + frng() * (sizeMax - sizeMin);
      const hgt = (sizeMin + frng() * (sizeMax - sizeMin)) * 0.75;
      const topRatio = 0.35 + frng() * 0.55;
      const ang = (frng() * 2 - 1) * rotMax;
      const fx = ccx - pr + frng() * (2 * pr);
      const fy = ccy - pr + frng() * (2 * pr);
      figs.push({ c: { x: fx, y: fy }, verts: figureVerts(kind, fx, fy, w, hgt, topRatio, ang, shear, skew, frng) });
    }
    const paths = [];
    for (const f of figs)
      for (let k = 0; k < f.verts.length; k++) paths.push(joinLine2(f.verts[k], f.verts[(k + 1) % f.verts.length], jitter, rng));
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    for (const f of figs) {
      const near = [...anchors].sort((a, b) => d2(a, f.c) - d2(b, f.c)).slice(0, anchorsPerFigure);
      for (const a of near) {
        const vs = [...f.verts].sort((p, q) => d2(a, p) - d2(a, q)).slice(0, vertsPerAnchor);
        for (const v of vs) paths.push(joinLine2(a, v, jitter, rng));
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Located figures" } };
  }
};
register(locatedFiguresModule);

// src/lib/modules/scribble.ts
function toneFn(form, x, y, cx, cy, h, archH, sigma) {
  const u = (x - (cx - h)) / (2 * h);
  if (form === "gradientV") return Math.min(1, Math.max(0, (y - (cy - h)) / (2 * h)));
  if (form === "band") {
    const d2 = (y - cy) / sigma;
    return Math.exp(-0.5 * d2 * d2);
  }
  const archY = cy - archH * h * (1 - Math.pow(2 * u - 1, 2));
  const d = (y - archY) / sigma;
  return Math.exp(-0.5 * d * d);
}
function shadeArch(cx, cy, h, archH, thick, crownBoost, coils, loopR, jitter, passPhase, rng) {
  const left = cx - h, span = 2 * h;
  const steps = Math.max(200, Math.round(coils * 14));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bell = 1 - Math.pow(2 * t - 1, 2);
    const x0 = left + t * span;
    const yC = cy - archH * h * bell;
    const halfT = 0.5 * thick * (0.3 + 0.7 * bell) * (1 + crownBoost * bell);
    const phase = t * coils * 2 * Math.PI + passPhase;
    const off = halfT * Math.sin(phase);
    const lx = loopR * Math.cos(phase * 1.9), ly = loopR * Math.sin(phase * 1.9);
    pts.push({ x: x0 + lx + (rng() * 2 - 1) * jitter, y: yC + off + ly + (rng() * 2 - 1) * jitter });
  }
  return pts;
}
function squiggle(px, py, size, loops, jitter, rng) {
  const steps = Math.max(4, Math.round(loops));
  const stepLen = size / 3.2;
  let x = px, y = py, th = rng() * 2 * Math.PI;
  const pts = [{ x, y }];
  for (let i = 0; i < steps; i++) {
    th += (rng() * 2 - 1) * 1.15;
    x += Math.cos(th) * stepLen + (rng() * 2 - 1) * jitter * 0.3;
    y += Math.sin(th) * stepLen + (rng() * 2 - 1) * jitter * 0.3;
    pts.push({ x, y });
  }
  return pts;
}
var scribbleModule = {
  key: "scribble",
  label: "Scribble",
  kind: "make",
  group: "Lines & Patterns",
  description: "Hand-made looping scribble marks whose density forms a tonal shape (e.g. an inverted curve). Open, gestural, never mechanical.",
  sections: [
    { title: "Form", fields: [
      { key: "form", label: "Tonal form", type: "select", default: "invertedCurveH", options: [
        { value: "invertedCurveH", label: "Inverted curve (horizontal)" },
        { value: "band", label: "Horizontal band" },
        { value: "gradientV", label: "Vertical gradient" }
      ] },
      { key: "archH", label: "Arch height", type: "range", min: 0, max: 0.9, step: 0.05, default: 0.45 },
      { key: "sigma", label: "Band width", type: "range", min: 10, max: 160, step: 1, unit: "mm", default: 55 }
    ] },
    { title: "Technique", fields: [
      { key: "mode", label: "Mode", type: "select", default: "marks", options: [
        { value: "marks", label: "Scattered marks" },
        { value: "shade", label: "Continuous shading (form)" }
      ] }
    ] },
    { title: "Scattered marks", fields: [
      { key: "marks", label: "Marks", type: "range", min: 20, max: 900, step: 10, default: 260 },
      { key: "markSize", label: "Mark size", type: "range", min: 4, max: 60, step: 1, unit: "mm", default: 16 },
      { key: "loops", label: "Loopiness", type: "range", min: 4, max: 24, step: 1, default: 10 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 12, step: 0.5, unit: "mm", default: 3 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Continuous shading", fields: [
      { key: "thick", label: "Ribbon thickness", type: "range", min: 10, max: 220, step: 2, unit: "mm", default: 90 },
      { key: "crownBoost", label: "Crown swell", type: "range", min: 0, max: 2, step: 0.1, default: 0.6 },
      { key: "coils", label: "Coils", type: "range", min: 20, max: 240, step: 2, default: 90 },
      { key: "loopR", label: "Loop size", type: "range", min: 0, max: 16, step: 0.5, unit: "mm", default: 4 },
      { key: "passes", label: "Passes", type: "range", min: 1, max: 4, step: 1, default: 2 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const form = String(params.form ?? "invertedCurveH");
    const mode = String(params.mode ?? "marks");
    const archH = num(params, "archH", 0.45), sigma = num(params, "sigma", 55);
    const marks = Math.max(1, Math.round(num(params, "marks", 260)));
    const markSize = num(params, "markSize", 16);
    const loops = num(params, "loops", 10);
    const jitter = num(params, "jitter", 3);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const paths = [];
    if (mode === "shade") {
      const thick = num(params, "thick", 90), crownBoost = num(params, "crownBoost", 0.6);
      const coils = num(params, "coils", 90), loopR = num(params, "loopR", 4);
      const passes = Math.max(1, Math.round(num(params, "passes", 2)));
      for (let p = 0; p < passes; p++)
        paths.push({ points: shadeArch(cx, cy, h, archH, thick, crownBoost, coils, loopR, jitter, p * Math.PI / passes, rng) });
      return { widthMm: size, heightMm: size, paths, meta: { title: "Scribble" } };
    }
    let placed = 0, attempts = 0, maxAttempts = marks * 40;
    while (placed < marks && attempts < maxAttempts) {
      attempts++;
      const px = cx - h + rng() * 2 * h;
      const py = cy - h + rng() * 2 * h;
      if (rng() > toneFn(form, px, py, cx, cy, h, archH, sigma)) continue;
      paths.push({ points: squiggle(px, py, markSize, loops, jitter, rng) });
      placed++;
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Scribble" } };
  }
};
register(scribbleModule);

// src/lib/modules/curvyDivide.ts
var curvyDivideModule = {
  key: "curvyDivide",
  label: "Curvy divide",
  kind: "make",
  group: "Lines & Patterns",
  description: "A wall split corner-to-corner by a curvy line; each side filled with open hand-drawn grain running a contrasting direction.",
  sections: [
    { title: "Divide", fields: [
      { key: "curviness", label: "Curviness", type: "range", min: 0, max: 120, step: 2, unit: "mm", default: 40 },
      { key: "freq", label: "Waves", type: "range", min: 0.5, max: 5, step: 0.1, default: 1.6 }
    ] },
    { title: "Grain", fields: [
      { key: "leftAngle", label: "Left angle", type: "range", min: 0, max: 180, step: 1, unit: "deg", default: 35 },
      { key: "rightAngle", label: "Right angle", type: "range", min: 0, max: 180, step: 1, unit: "deg", default: 125 },
      { key: "spacing", label: "Grain spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 16 },
      { key: "swirl", label: "Flow swirl", type: "range", min: 0, max: 1.4, step: 0.05, unit: "rad", default: 0.6 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 14, step: 0.5, unit: "mm", default: 4 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const curviness = num(params, "curviness", 40), freq = num(params, "freq", 1.6);
    const spacing = Math.max(1, num(params, "spacing", 16));
    const swirl = num(params, "swirl", 0.6);
    const jitter = num(params, "jitter", 4);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const leftRad = num(params, "leftAngle", 35) * Math.PI / 180;
    const rightRad = num(params, "rightAngle", 125) * Math.PI / 180;
    const A = { x: cx - h, y: cy - h }, B = { x: cx + h, y: cy + h };
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
    const px = -uy, py = ux;
    const ph1 = rng() * 6.28, ph2 = rng() * 6.28;
    const curveOffset = (t) => curviness * (0.7 * Math.sin(t * freq * 2 * Math.PI + ph1) + 0.3 * Math.sin(t * freq * 2.3 * 2 * Math.PI + ph2));
    const sideOf = (x, y) => {
      const rx = x - A.x, ry = y - A.y;
      const t = (rx * ux + ry * uy) / L;
      const off = rx * px + ry * py;
      return off - curveOffset(t);
    };
    const inFrame = (x, y) => x >= cx - h && x <= cx + h && y >= cy - h && y <= cy + h;
    const sw1 = rng() * 6.28, sw2 = rng() * 6.28;
    const flowAngle = (x, y, base) => base + swirl * (Math.sin(x * 0.011 + sw1) * Math.cos(y * 0.012 - sw2) + 0.5 * Math.sin((x + y) * 7e-3 + sw1));
    const grain = (theta, sign) => {
      const out = [];
      const ds = 4, half = Math.round(2.4 * h / ds);
      for (let gx = cx - h; gx <= cx + h; gx += spacing)
        for (let gy = cy - h; gy <= cy + h; gy += spacing) {
          if (Math.sign(sideOf(gx, gy)) !== sign) continue;
          if (rng() > 0.92) continue;
          const seg = [];
          for (const dir of [1, -1]) {
            let x = gx, y = gy;
            const pts = [];
            for (let i = 0; i < half; i++) {
              const a = flowAngle(x, y, theta);
              x += dir * Math.cos(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
              y += dir * Math.sin(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
              if (!inFrame(x, y) || Math.sign(sideOf(x, y)) !== sign) break;
              pts.push({ x, y });
            }
            if (dir === 1) seg.push(...pts.reverse(), { x: gx, y: gy });
            else seg.push(...pts);
          }
          if (seg.length > 2) out.push({ points: seg });
        }
      return out;
    };
    const paths = [];
    paths.push(...grain(leftRad, -1));
    paths.push(...grain(rightRad, 1));
    for (let pass = 0; pass < 2; pass++) {
      const bpts = [];
      const jb = pass === 0 ? 0 : 1.2;
      for (let i = 0; i <= 260; i++) {
        const t = i / 260, base = { x: A.x + t * (B.x - A.x), y: A.y + t * (B.y - A.y) };
        const off = curveOffset(t) + (rng() * 2 - 1) * jb;
        bpts.push({ x: base.x + px * off, y: base.y + py * off });
      }
      paths.push({ points: bpts });
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Curvy divide" } };
  }
};
register(curvyDivideModule);

// src/lib/modules/whirls.ts
function whirl(ox, oy, r0, maxR, turns, dir, phase, squash, rot, jitter, rng) {
  const total = turns * 2 * Math.PI;
  const k = Math.log(maxR / r0) / total;
  const steps = Math.max(48, Math.round(total / 0.11));
  const wob1 = rng() * 6.28, breath = 0.04 + rng() * 0.05;
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const th = total * i / steps;
    const r2 = r0 * Math.exp(k * th) * (1 + breath * Math.sin(th * 2.5 + wob1));
    const ang = dir * th + phase;
    const x = r2 * Math.cos(ang), y = r2 * Math.sin(ang) * squash;
    const rx = x * ca - y * sa, ry = x * sa + y * ca;
    pts.push({ x: ox + rx + (rng() * 2 - 1) * jitter, y: oy + ry + (rng() * 2 - 1) * jitter });
  }
  return pts;
}
var whirlsModule = {
  key: "whirls",
  label: "Whirls",
  kind: "make",
  group: "Lines & Patterns",
  description: "Bold organic spiralling whirls of varied size/direction + small twirl flourishes, composed asymmetrically with open space.",
  sections: [
    { title: "Whirls", fields: [
      { key: "count", label: "Whirls", type: "range", min: 1, max: 10, step: 1, default: 3 },
      { key: "maxR", label: "Max radius", type: "range", min: 20, max: 160, step: 2, unit: "mm", default: 100 },
      { key: "turns", label: "Turns", type: "range", min: 1, max: 6, step: 0.25, default: 3.2 },
      { key: "squash", label: "Squash", type: "range", min: 0.4, max: 1, step: 0.05, default: 0.85 }
    ] },
    { title: "Twirls", fields: [
      { key: "twirls", label: "Twirls", type: "range", min: 0, max: 16, step: 1, default: 4 }
    ] },
    { title: "Hand", fields: [
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 10, step: 0.5, unit: "mm", default: 2 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const count = Math.max(1, Math.round(num(params, "count", 3)));
    const maxR = num(params, "maxR", 100), turns = num(params, "turns", 3.2);
    const squash = num(params, "squash", 0.85);
    const twirls = Math.max(0, Math.round(num(params, "twirls", 4)));
    const jitter = num(params, "jitter", 2);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const paths = [];
    const place = (rmax, trn) => {
      const R = rmax * (0.5 + 0.5 * rng());
      const m = Math.min(h * 0.85, R * 0.7);
      const ox = cx - h + m + rng() * (2 * (h - m));
      const oy = cy - h + m + rng() * (2 * (h - m));
      const dir = rng() < 0.5 ? 1 : -1;
      const t = trn * (0.6 + 0.5 * rng());
      paths.push({ points: whirl(ox, oy, 2, Math.max(6, R), t, dir, rng() * 6.28, squash + (rng() * 2 - 1) * 0.12, rng() * 6.28, jitter, rng) });
    };
    for (let i = 0; i < count; i++) place(maxR, turns);
    for (let i = 0; i < twirls; i++) place(maxR * 0.22, 1.6 + rng() * 1.4);
    return { widthMm: size, heightMm: size, paths, meta: { title: "Whirls" } };
  }
};
register(whirlsModule);

// src/lib/modules/flowWhirls.ts
var flowWhirlsModule = {
  key: "flowWhirls",
  label: "Flow whirls",
  kind: "make",
  group: "Lines & Patterns",
  description: "The wall filled with flowing streamlines through a vortex field \u2014 swirling whirls and twirling currents. Full-field, dynamic, hand-made.",
  sections: [
    { title: "Field", fields: [
      { key: "vortices", label: "Whirl centres", type: "range", min: 1, max: 10, step: 1, default: 4 },
      { key: "strength", label: "Swirl strength", type: "range", min: 20, max: 200, step: 5, default: 90 },
      { key: "spiralIn", label: "Spiral in/out", type: "range", min: -0.8, max: 0.8, step: 0.05, default: 0.25 },
      { key: "drift", label: "Base drift", type: "range", min: 0, max: 60, step: 1, default: 18 }
    ] },
    { title: "Streamlines", fields: [
      { key: "spacing", label: "Line spacing", type: "range", min: 0.5, max: 30, step: 0.5, unit: "mm", default: 15 },
      { key: "reach", label: "Line length", type: "range", min: 40, max: 400, step: 10, unit: "mm", default: 150 },
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 8, step: 0.5, unit: "mm", default: 1.5 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Growth & decrease (breathing)", fields: [
      { key: "growth", label: "Breathe amount", type: "range", min: 0, max: 1, step: 0.05, default: 0 },
      { key: "growthAxis", label: "Breathe axis", type: "range", min: 0, max: 180, step: 5, unit: "deg", default: 90 },
      { key: "growthPeak", label: "Crest position", type: "range", min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: "growthWidth", label: "Crest breadth", type: "range", min: 0.1, max: 0.8, step: 0.05, default: 0.32 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const nV = Math.max(1, Math.round(num(params, "vortices", 4)));
    const strength = num(params, "strength", 90), spiralIn = num(params, "spiralIn", 0.25);
    const drift = num(params, "drift", 18);
    const spacing = Math.max(3, num(params, "spacing", 15));
    const reach = num(params, "reach", 150);
    const jitter = num(params, "jitter", 1.5);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const vs = [];
    for (let i = 0; i < nV; i++)
      vs.push({
        x: cx - h * 0.75 + rng() * 1.5 * h,
        y: cy - h * 0.75 + rng() * 1.5 * h,
        s: rng() < 0.5 ? 1 : -1,
        k: strength * (0.6 + 0.8 * rng())
      });
    const driftAng = rng() * 6.28;
    const core = 14;
    const vecAngle = (x, y) => {
      let vx = drift * Math.cos(driftAng), vy = drift * Math.sin(driftAng);
      for (const v of vs) {
        const dx = x - v.x, dy = y - v.y, d = Math.hypot(dx, dy) + core, f = v.k / d;
        vx += (-dy / d * v.s + -dx / d * spiralIn) * f;
        vy += (dx / d * v.s + -dy / d * spiralIn) * f;
      }
      return Math.atan2(vy, vx);
    };
    const inFrame = (x, y) => x >= cx - h && x <= cx + h && y >= cy - h && y <= cy + h;
    const ds = 4, half = Math.max(6, Math.round(reach / 2 / ds));
    const growth = num(params, "growth", 0);
    const gAxis = num(params, "growthAxis", 90) * Math.PI / 180, gax = Math.cos(gAxis), gay = Math.sin(gAxis);
    const gPeak = num(params, "growthPeak", 0.5), gWidth = num(params, "growthWidth", 0.32);
    const envAt = (x, y) => {
      if (growth <= 0) return 1;
      const u = ((x - (cx - h)) * gax + (y - (cy - h)) * gay) / (2 * h);
      const e = Math.exp(-0.5 * ((u - gPeak) / gWidth) ** 2);
      return 1 - growth + growth * e;
    };
    const paths = [];
    for (let gx = cx - h; gx <= cx + h; gx += spacing)
      for (let gy = cy - h; gy <= cy + h; gy += spacing) {
        const e = envAt(gx, gy);
        if (rng() > 0.9 * e) continue;
        const hi = Math.max(4, Math.round(half * e));
        const seg = [];
        for (const dir of [1, -1]) {
          let x = gx, y = gy;
          const pts = [];
          for (let i = 0; i < hi; i++) {
            const a = vecAngle(x, y);
            x += dir * Math.cos(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
            y += dir * Math.sin(a) * ds + (rng() * 2 - 1) * jitter * 0.05;
            if (!inFrame(x, y)) break;
            pts.push({ x, y });
          }
          if (dir === 1) seg.push(...pts.reverse(), { x: gx, y: gy });
          else seg.push(...pts);
        }
        if (seg.length > 3) paths.push({ points: seg });
      }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Flow whirls" } };
  }
};
register(flowWhirlsModule);

// src/lib/modules/growthField.ts
function stroke(mx, my, s, th, curve2, jitter, rng) {
  const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
  const n = Math.max(4, Math.round(s / 3));
  const bowPhase = rng() * 6.28, bowAmt = curve2 * s * (0.7 + 0.5 * rng());
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n - 0.5;
    const along = t * s;
    const bow = bowAmt * Math.cos(Math.PI * t + bowPhase * 0) * (0.25 - t * t) * 4;
    pts.push({
      x: mx + dx * along + nx * bow + (rng() * 2 - 1) * jitter,
      y: my + dy * along + ny * bow + (rng() * 2 - 1) * jitter
    });
  }
  return pts;
}
var growthFieldModule = {
  key: "growthField",
  label: "Growth field",
  kind: "make",
  group: "Lines & Patterns",
  description: "A field of organic curved strokes whose size breathes (grows then shrinks) along an axis \u2014 Klee's growth-and-decrease as a living tonal wave.",
  sections: [
    { title: "Growth", fields: [
      { key: "axisAngle", label: "Growth axis", type: "range", min: 0, max: 180, step: 5, unit: "deg", default: 90 },
      { key: "peak", label: "Crest position", type: "range", min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: "width", label: "Crest breadth", type: "range", min: 0.1, max: 0.8, step: 0.05, default: 0.32 },
      { key: "radial", label: "Radial", type: "toggle", default: false }
    ] },
    { title: "Strokes", fields: [
      { key: "spacing", label: "Spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 18 },
      { key: "sizeMin", label: "Min size", type: "range", min: 2, max: 40, step: 1, unit: "mm", default: 6 },
      { key: "sizeMax", label: "Max size", type: "range", min: 10, max: 80, step: 1, unit: "mm", default: 34 },
      { key: "curve", label: "Stroke curve", type: "range", min: 0, max: 0.6, step: 0.02, default: 0.28 },
      { key: "flowVary", label: "Orientation vary", type: "range", min: 0, max: 1.4, step: 0.05, unit: "rad", default: 0.4 }
    ] },
    { title: "Hand", fields: [
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 6, step: 0.5, unit: "mm", default: 1.2 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const axis = num(params, "axisAngle", 90) * Math.PI / 180;
    const peak = num(params, "peak", 0.5), width = num(params, "width", 0.32);
    const radial = params.radial === true;
    const spacing = Math.max(4, num(params, "spacing", 18));
    const sizeMin = num(params, "sizeMin", 6), sizeMax = Math.max(sizeMin + 1, num(params, "sizeMax", 34));
    const curve2 = num(params, "curve", 0.28), flowVary = num(params, "flowVary", 0.4);
    const jitter = num(params, "jitter", 1.2);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const ax = Math.cos(axis), ay = Math.sin(axis);
    const env = (x, y) => {
      let u;
      if (radial) u = Math.min(1, Math.hypot(x - cx, y - cy) / h);
      else u = ((x - (cx - h)) * ax + (y - (cy - h)) * ay) / (2 * h);
      return Math.exp(-0.5 * ((u - peak) / width) ** 2);
    };
    const paths = [];
    const baseTh = axis + Math.PI / 2;
    for (let gx = cx - h; gx <= cx + h; gx += spacing)
      for (let gy = cy - h; gy <= cy + h; gy += spacing) {
        const jx = gx + (rng() * 2 - 1) * spacing * 0.35, jy = gy + (rng() * 2 - 1) * spacing * 0.35;
        if (jx < cx - h || jx > cx + h || jy < cy - h || jy > cy + h) continue;
        const s = sizeMin + (sizeMax - sizeMin) * env(jx, jy);
        const th = baseTh + (rng() * 2 - 1) * flowVary;
        paths.push({ points: stroke(jx, jy, s, th, curve2, jitter, rng) });
      }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Growth field" } };
  }
};
register(growthFieldModule);

// src/lib/modules/branching.ts
var branchingModule = {
  key: "branching",
  label: "Branching",
  kind: "make",
  group: "Lines & Patterns",
  description: "Organic dendritic growth (tree / coral / delta / veins) that fills the wall \u2014 irregular splits, hand-drawn curved branches, shrinking length.",
  sections: [
    { title: "Growth", fields: [
      { key: "origin", label: "Grows from", type: "select", default: "bottom", options: [
        { value: "bottom", label: "Bottom (up)" },
        { value: "top", label: "Top (down)" },
        { value: "left", label: "Left (right)" },
        { value: "center", label: "Centre (radial)" }
      ] },
      { key: "roots", label: "Roots / seeds", type: "range", min: 1, max: 12, step: 1, default: 3 },
      { key: "depth", label: "Generations", type: "range", min: 3, max: 10, step: 1, default: 7 },
      { key: "initLen", label: "First length", type: "range", min: 20, max: 140, step: 2, unit: "mm", default: 66 },
      { key: "decay", label: "Length decay", type: "range", min: 0.5, max: 0.92, step: 0.02, default: 0.72 }
    ] },
    { title: "Split", fields: [
      { key: "spread", label: "Branch spread", type: "range", min: 0.1, max: 1.4, step: 0.05, unit: "rad", default: 0.6 },
      { key: "tropism", label: "Grow-direction pull", type: "range", min: 0, max: 0.6, step: 0.05, default: 0.15 },
      { key: "curve", label: "Branch curve", type: "range", min: 0, max: 0.8, step: 0.05, default: 0.25 },
      { key: "coreR", label: "Core scatter (radial)", type: "range", min: 0, max: 80, step: 1, unit: "mm", default: 0 },
      { key: "flow", label: "Organic flow", type: "range", min: 0, max: 0.8, step: 0.05, default: 0 }
    ] },
    { title: "Hand", fields: [
      { key: "jitter", label: "Hand jitter", type: "range", min: 0, max: 6, step: 0.5, unit: "mm", default: 1.2 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 7 }
    ] },
    { title: "Frame", fields: [
      { key: "size", label: "Size", type: "range", min: 20, max: 300, step: 1, unit: "mm", default: 300 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "edgeAvoid", label: "Keep inside frame", type: "range", min: 0, max: 1, step: 0.05, default: 0 }
    ] }
  ],
  generate(params) {
    const size = num(params, "size", 300), h = size / 2;
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const origin = String(params.origin ?? "bottom");
    const roots = Math.max(1, Math.round(num(params, "roots", 3)));
    const depth = Math.max(1, Math.round(num(params, "depth", 7)));
    const initLen = num(params, "initLen", 66), decay = num(params, "decay", 0.72);
    const spread = num(params, "spread", 0.6), tropism = num(params, "tropism", 0.15);
    const curve2 = num(params, "curve", 0.25), jitter = num(params, "jitter", 1.2);
    const coreR = num(params, "coreR", 0);
    const flow = num(params, "flow", 0);
    const edgeAvoid = num(params, "edgeAvoid", 0);
    const rng = seededRandom(Math.round(num(params, "seed", 7)));
    const curl = (x, y) => flow * (Math.sin((x - cx) * 0.02 + (y - cy) * 0.013 + 1.3) + 0.6 * Math.sin((y - cy) * 0.028 - (x - cx) * 0.021 + 4.1));
    const margin = h * 0.4;
    const steerInward = (x, y, ang) => {
      if (edgeAvoid <= 0) return ang;
      const md = Math.min(x - (cx - h), cx + h - x, y - (cy - h), cy + h - y);
      if (md >= margin) return ang;
      const toC = Math.atan2(cy - y, cx - x);
      const w = Math.min(0.95, edgeAvoid * Math.max(0, Math.min(1.4, 1 - md / margin)));
      return ang + w * Math.atan2(Math.sin(toC - ang), Math.cos(toC - ang));
    };
    const segment = (x, y, ang, len) => {
      const steps = Math.max(3, Math.round(len / 6));
      const drift = curve2 * (rng() * 2 - 1);
      let a = ang, px = x, py = y;
      const pts = [{ x, y }];
      for (let i = 1; i <= steps; i++) {
        a += drift / steps + curl(px, py) / steps;
        px += Math.cos(a) * (len / steps) + (rng() * 2 - 1) * jitter * 0.25;
        py += Math.sin(a) * (len / steps) + (rng() * 2 - 1) * jitter * 0.25;
        pts.push({ x: px, y: py });
      }
      return { pts, ex: px, ey: py, ea: a };
    };
    const stack = [];
    const growDir = { bottom: -Math.PI / 2, top: Math.PI / 2, left: 0, center: 0 };
    for (let i = 0; i < roots; i++) {
      let x = cx, y = cy, ang = growDir[origin] ?? -Math.PI / 2;
      const f = roots === 1 ? 0.5 : (i + 0.5) / roots;
      if (origin === "bottom") {
        x = cx - h + f * 2 * h;
        y = cy + h;
      } else if (origin === "top") {
        x = cx - h + f * 2 * h;
        y = cy - h;
      } else if (origin === "left") {
        x = cx - h;
        y = cy - h + f * 2 * h;
      } else {
        const rr = Math.sqrt(rng()) * coreR;
        const th = rng() * 2 * Math.PI;
        x = cx + Math.cos(th) * rr;
        y = cy + Math.sin(th) * rr;
        ang = coreR > 1e-3 ? th + (rng() * 2 - 1) * 0.5 : f * 2 * Math.PI;
      }
      stack.push({ x, y, ang: ang + (rng() * 2 - 1) * 0.2, len: initLen, gen: 0 });
    }
    const gd = growDir[origin] ?? -Math.PI / 2;
    const paths = [];
    let guard = 0;
    while (stack.length && guard++ < 2e5) {
      const nd = stack.pop();
      if (nd.gen > depth || nd.len < 5) continue;
      const seg = segment(nd.x, nd.y, nd.ang, nd.len);
      paths.push({ points: seg.pts });
      const nch = rng() < 0.55 ? 2 : 3;
      for (let k = 0; k < nch; k++) {
        const base = seg.ea + spread * ((k + 0.5) / nch * 2 - 1) + (rng() * 2 - 1) * 0.28;
        const pulled = origin === "center" ? base : base + tropism * Math.atan2(Math.sin(gd - base), Math.cos(gd - base));
        const steered = steerInward(seg.ex, seg.ey, pulled);
        stack.push({ x: seg.ex, y: seg.ey, ang: steered, len: nd.len * decay * (0.8 + 0.4 * rng()), gen: nd.gen + 1 });
      }
    }
    return { widthMm: size, heightMm: size, paths, meta: { title: "Branching" } };
  }
};
register(branchingModule);

// src/lib/modules/spirograph.ts
function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}
var spirographModule = {
  key: "spirograph",
  label: "Spirograph",
  kind: "make",
  group: "Lines & Patterns",
  description: "A hypotrochoid / epitrochoid roulette curve (the classic gear toy).",
  sections: [
    { title: "Gears", fields: [
      { key: "R", label: "Fixed radius", type: "range", min: 10, max: 200, step: 1, unit: "mm", default: 80 },
      { key: "r", label: "Rolling radius", type: "range", min: 3, max: 150, step: 1, unit: "mm", default: 30 },
      { key: "d", label: "Pen offset", type: "range", min: 0, max: 150, step: 1, unit: "mm", default: 50 },
      {
        key: "type",
        label: "Type",
        type: "select",
        default: "hypo",
        options: [{ value: "hypo", label: "Hypotrochoid" }, { value: "epi", label: "Epitrochoid" }]
      }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "\xD7", default: 1 }
    ] }
  ],
  generate(params) {
    const R = num(params, "R", 80);
    const r2 = Math.max(1, num(params, "r", 30));
    const d = num(params, "d", 50);
    const epi = String(params.type ?? "hypo") === "epi";
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const turns = Math.max(1, Math.min(200, Math.round(r2) / gcd(R, r2)));
    const n = Math.max(200, Math.min(6e3, Math.round(turns * 180)));
    const base = epi ? R + r2 : R - r2;
    const k = base / r2;
    const points = [];
    for (let i = 0; i <= n; i++) {
      const t = 2 * Math.PI * turns * (i / n);
      const x = base * Math.cos(t) + (epi ? -1 : 1) * d * Math.cos(k * t);
      const y = base * Math.sin(t) - d * Math.sin(k * t);
      points.push({ x: cx + x, y: cy + y });
    }
    const path = { points, closed: false, cycles };
    const span = Math.abs(base) + d;
    return { widthMm: 2 * span, heightMm: 2 * span, paths: [path], meta: { title: "Spirograph" } };
  }
};
register(spirographModule);

// src/lib/modules/orbital-weave.ts
var orbitalWeaveModule = {
  key: "orbitalWeave",
  label: "Orbital Weave",
  kind: "make",
  group: "Lines & Patterns",
  description: "A continuous orbiting trace that folds into airy woven knots.",
  sections: [
    { title: "Orbit", fields: [
      { key: "orbitRadius", label: "Orbit radius", type: "range", min: 0, max: 250, step: 1, unit: "mm", default: 50 },
      { key: "orbitTurns", label: "Orbit turns", type: "range", min: 1, max: 24, step: 1, default: 1 }
    ] },
    { title: "Loop", fields: [
      { key: "majorRadius", label: "Loop major", type: "range", min: 0, max: 200, step: 1, unit: "mm", default: 24 },
      { key: "minorRadius", label: "Loop minor", type: "range", min: 0, max: 200, step: 1, unit: "mm", default: 24 },
      { key: "traceTurns", label: "Trace turns", type: "range", min: 1, max: 400, step: 1, default: 13 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "\xD7", default: 1 }
    ] }
  ],
  generate(params) {
    const orbitR = num(params, "orbitRadius", 50);
    const orbitTurns = Math.max(1, Math.round(num(params, "orbitTurns", 1)));
    const majorR = num(params, "majorRadius", 24);
    const minorR = num(params, "minorRadius", 24);
    const traceTurns = Math.max(1, Math.round(num(params, "traceTurns", 13)));
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const n = Math.max(240, Math.min(8e3, traceTurns * 120));
    const points = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const phi = 2 * Math.PI * orbitTurns * s;
      const theta = 2 * Math.PI * traceTurns * s;
      const x = orbitR * Math.cos(phi) + majorR * Math.cos(theta);
      const y = orbitR * Math.sin(phi) + minorR * Math.sin(theta);
      points.push({ x: cx + x, y: cy + y });
    }
    const path = { points, closed: false, cycles };
    const span = orbitR + Math.max(majorR, minorR);
    return { widthMm: 2 * span, heightMm: 2 * span, paths: [path], meta: { title: "Orbital Weave" } };
  }
};
register(orbitalWeaveModule);

// src/lib/modules/random-walker.ts
var randomWalkerModule = {
  key: "randomWalker",
  label: "Random Walker",
  kind: "make",
  group: "Lines & Patterns",
  description: "Agents drift with accumulating velocity, each tracing a line until they leave the canvas. Pipe mode draws growing circles along the invisible walk instead of the line.",
  sections: [
    { title: "Pipe", fields: [
      { key: "mode", label: "Draw as", type: "select", default: "walk", options: [
        { value: "walk", label: "Line (classic walk)" },
        { value: "pipe", label: "Pipe (circles along path)" }
      ] },
      { key: "rMin", label: "Start radius (min r)", type: "range", min: 0.5, max: 30, step: 0.5, unit: "mm", default: 1 },
      { key: "rMax", label: "End radius (max r)", type: "range", min: 0.5, max: 60, step: 0.5, unit: "mm", default: 8 },
      { key: "pipeSpacing", label: "Circle spacing", type: "range", min: 0.5, max: 40, step: 0.5, unit: "mm", default: 6 },
      { key: "pipeJitter", label: "Hand jitter", type: "range", min: 0, max: 4, step: 0.1, unit: "mm", default: 0.8 }
    ] },
    { title: "Walkers", fields: [
      { key: "count", label: "Walkers", type: "range", min: 1, max: 500, step: 1, default: 20 },
      { key: "steps", label: "Max steps", type: "range", min: 100, max: 1e4, step: 100, default: 2e3 },
      { key: "flowAngle", label: "Flow direction", type: "range", min: 0, max: 360, step: 1, unit: "\xB0", default: 90 },
      { key: "velStep", label: "Divergence \u0394", type: "range", min: 0.1, max: 5, step: 0.1, unit: "mm", default: 0.5 },
      { key: "maxVel", label: "Max speed", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 4 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 }
    ] },
    { title: "Start line", fields: [
      { key: "x1", label: "X1", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "y1", label: "Y1", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "x2", label: "X2", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "y2", label: "Y2", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Ink", fields: [
      { key: "cycles", label: "Retrace", type: "range", min: 1, max: 5, step: 1, unit: "\xD7", default: 1 }
    ] }
  ],
  generate(params, ctx) {
    const count = Math.max(1, Math.round(num(params, "count", 20)));
    const steps = Math.max(100, Math.round(num(params, "steps", 2e3)));
    const flowAngle = num(params, "flowAngle", 90) * (Math.PI / 180);
    const velStep = num(params, "velStep", 0.5);
    const maxVel = Math.max(velStep, num(params, "maxVel", 4));
    const seed = Math.round(num(params, "seed", 42));
    const x1 = num(params, "x1", 0);
    const y1 = num(params, "y1", 0);
    const x2 = num(params, "x2", 0);
    const y2 = num(params, "y2", 0);
    const cycles = Math.max(1, Math.round(num(params, "cycles", 1)));
    const mode = String(params.mode ?? "walk");
    const rMin = Math.max(0.1, num(params, "rMin", 1));
    const rMax = Math.max(0.1, num(params, "rMax", 8));
    const pipeSpacing = Math.max(0.5, num(params, "pipeSpacing", 6));
    const pipeJitter = Math.max(0, num(params, "pipeJitter", 0.8));
    const rng = seededRandom(seed);
    const wobblyCircle = (cx, cy, r2) => {
      const n = Math.min(96, Math.max(12, Math.round(2 * Math.PI * r2 / 1.5)));
      const p1 = rng() * 2 * Math.PI, p2 = rng() * 2 * Math.PI;
      const k1 = 2 + Math.floor(rng() * 2), k2 = 3 + Math.floor(rng() * 3);
      const amp = pipeJitter * (0.7 + 0.6 * rng());
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = i / n * 2 * Math.PI;
        const rr = r2 + amp * (0.6 * Math.sin(a * k1 + p1) + 0.4 * Math.sin(a * k2 + p2));
        pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
      }
      return pts;
    };
    const emitPipe = (spine, out) => {
      let total = 0;
      for (let i = 1; i < spine.length; i++)
        total += Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y);
      if (total < 1e-6) return;
      let seg = 0;
      let segStart = 0;
      let segLen = Math.hypot(spine[1].x - spine[0].x, spine[1].y - spine[0].y);
      for (let d = 0; d <= total; d += pipeSpacing) {
        while (d > segStart + segLen && seg < spine.length - 2) {
          segStart += segLen;
          seg++;
          segLen = Math.hypot(spine[seg + 1].x - spine[seg].x, spine[seg + 1].y - spine[seg].y);
        }
        const f = segLen > 1e-9 ? (d - segStart) / segLen : 0;
        const cx = spine[seg].x + (spine[seg + 1].x - spine[seg].x) * f;
        const cy = spine[seg].y + (spine[seg + 1].y - spine[seg].y) * f;
        const r2 = rMin + (rMax - rMin) * (d / total);
        out.push({ points: wobblyCircle(cx, cy, r2), closed: true, cycles });
      }
    };
    const vx0 = maxVel * Math.cos(flowAngle);
    const vy0 = maxVel * Math.sin(flowAngle);
    const { left, right, up, down } = ctx.bounds;
    const xMin = -left, xMax = right;
    const yMin = -up, yMax = down;
    const w = xMax - xMin, h = yMax - yMin;
    const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
    const paths = [];
    for (let wi = 0; wi < count; wi++) {
      const t = rng();
      let x = x1 + t * (x2 - x1);
      let y = y1 + t * (y2 - y1);
      let vx = vx0, vy = vy0;
      const pts = [{ x, y }];
      for (let s = 0; s < steps; s++) {
        vx = clamp(vx + (rng() - 0.5) * 2 * velStep, -maxVel, maxVel);
        vy = clamp(vy + (rng() - 0.5) * 2 * velStep, -maxVel, maxVel);
        x += vx;
        y += vy;
        if (x < xMin || x > xMax || y < yMin || y > yMax) break;
        pts.push({ x, y });
      }
      if (pts.length > 1) {
        if (mode === "pipe") emitPipe(pts, paths);
        else paths.push({ points: pts, closed: false, cycles });
      }
    }
    return { widthMm: w, heightMm: h, paths, meta: { title: mode === "pipe" ? "Random Walker \u2014 pipe" : "Random Walker" } };
  }
};
register(randomWalkerModule);

// src/lib/modules/noised-hatches.ts
function _hash(ix, iy, iz, seed) {
  let h = ix * 374761393 + iy * 668265263 + iz * 2246822519 + seed * 1013904223 | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function _fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function _lerp(a, b, t) {
  return a + t * (b - a);
}
function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = _fade(x - ix), fy = _fade(y - iy), fz = _fade(z - iz);
  const v = (dx, dy, dz) => _hash(ix + dx, iy + dy, iz + dz, seed);
  return _lerp(
    _lerp(_lerp(v(0, 0, 0), v(1, 0, 0), fx), _lerp(v(0, 1, 0), v(1, 1, 0), fx), fy),
    _lerp(_lerp(v(0, 0, 1), v(1, 0, 1), fx), _lerp(v(0, 1, 1), v(1, 1, 1), fx), fy),
    fz
  );
}
var noisedHatchesModule = {
  key: "noisedHatches",
  label: "Noised Hatches",
  kind: "make",
  group: "Lines & Patterns",
  description: "Grid of hatch cells shaped by a noise-driven blob. Cells inside the blob use one angle, outside use the perpendicular.",
  sections: [
    { title: "Grid", fields: [
      { key: "gridN", label: "Grid density", type: "range", min: 5, max: 80, step: 1, default: 30 },
      { key: "angleDeg", label: "Hatch angle", type: "range", min: 0, max: 180, step: 1, unit: "\xB0", default: 45 }
    ] },
    { title: "Blob", fields: [
      { key: "blobRadius", label: "Blob radius", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 80 },
      { key: "noiseScale", label: "Noise scale", type: "range", min: 0.02, max: 1, step: 0.01, default: 0.15 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 }
    ] },
    { title: "Canvas", fields: [
      { key: "w", label: "Width", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "h", label: "Height", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const gridN = Math.max(5, Math.round(num(params, "gridN", 30)));
    const angleDeg = num(params, "angleDeg", 45);
    const blobRadius = num(params, "blobRadius", 80);
    const noiseScale = num(params, "noiseScale", 0.15);
    const seed = Math.round(num(params, "seed", 42));
    const w = num(params, "w", 200);
    const h = num(params, "h", 200);
    const cx0 = num(params, "cx", 0);
    const cy0 = num(params, "cy", 0);
    const xMin = cx0 - w / 2, xMax = cx0 + w / 2;
    const yMin = cy0 - h / 2, yMax = cy0 + h / 2;
    const cellW = w / gridN, cellH = h / gridN;
    const angleRad = angleDeg * Math.PI / 180;
    const perpRad = angleRad + Math.PI / 2;
    const xb = xMin + w * noise3(100, 0, 0, seed);
    const yb = yMin + h * noise3(200, 0, 0, seed ^ 3735928559);
    const paths = [];
    for (let col = 0; col < gridN; col++) {
      for (let row = 0; row < gridN; row++) {
        const r2 = 2 * blobRadius * noise3(col * noiseScale, row * noiseScale, 0, seed);
        const lx = xMin + col * cellW;
        const ty = yMin + row * cellH;
        const ccx = lx + cellW / 2;
        const ccy = ty + cellH / 2;
        const d = Math.hypot(ccx - xb, ccy - yb);
        const a = d < r2 ? angleRad : perpRad;
        const cosA = Math.cos(a), sinA = Math.sin(a);
        const hx = cellW / 2 / (Math.abs(cosA) || 1e-10);
        const hy = cellH / 2 / (Math.abs(sinA) || 1e-10);
        const hl = Math.min(hx, hy);
        paths.push({ points: [
          { x: ccx - hl * cosA, y: ccy - hl * sinA },
          { x: ccx + hl * cosA, y: ccy + hl * sinA }
        ] });
      }
    }
    return { widthMm: w, heightMm: h, paths, meta: { title: "Noised Hatches" } };
  }
};
register(noisedHatchesModule);

// src/lib/modules/noise-orbit.ts
function _hash2(ix, iy, iz, seed) {
  let h = ix * 374761393 + iy * 668265263 + iz * 2246822519 + seed * 1013904223 | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 4294967296;
}
function _fade2(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function _lerp2(a, b, t) {
  return a + t * (b - a);
}
function noise32(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = _fade2(x - ix), fy = _fade2(y - iy), fz = _fade2(z - iz);
  const v = (dx, dy, dz) => _hash2(ix + dx, iy + dy, iz + dz, seed);
  return _lerp2(
    _lerp2(_lerp2(v(0, 0, 0), v(1, 0, 0), fx), _lerp2(v(0, 1, 0), v(1, 1, 0), fx), fy),
    _lerp2(_lerp2(v(0, 0, 1), v(1, 0, 1), fx), _lerp2(v(0, 1, 1), v(1, 1, 1), fx), fy),
    fz
  );
}
function chaikin(pts, iterations) {
  let p = pts;
  for (let i = 0; i < iterations; i++) {
    const next = [];
    const n = p.length;
    for (let k = 0; k < n; k++) {
      const a = p[k], b = p[(k + 1) % n];
      next.push(
        { x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y },
        { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y }
      );
    }
    p = next;
  }
  return p;
}
var noiseOrbitModule = {
  key: "noiseOrbit",
  label: "Noise Orbit",
  kind: "make",
  group: "Lines & Patterns",
  description: "Concentric rings distorted by a noise field and smoothed with Chaikin's algorithm. Layers stack different noise slices.",
  sections: [
    { title: "Rings", fields: [
      { key: "numCircles", label: "Rings", type: "range", min: 2, max: 80, step: 1, default: 30 },
      { key: "minRadius", label: "Inner radius", type: "range", min: 1, max: 300, step: 1, unit: "mm", default: 10 },
      { key: "maxRadius", label: "Outer radius", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 100 },
      { key: "numSides", label: "Sides", type: "range", min: 6, max: 60, step: 1, default: 20 },
      { key: "chaikin", label: "Smoothing", type: "range", min: 0, max: 6, step: 1, unit: "\xD7", default: 4 }
    ] },
    { title: "Noise", fields: [
      { key: "nudge", label: "Nudge", type: "range", min: 0, max: 100, step: 0.5, unit: "mm", default: 15 },
      { key: "layers", label: "Layers", type: "range", min: 1, max: 12, step: 1, default: 5 },
      { key: "layerStep", label: "Layer depth", type: "range", min: 0.1, max: 6, step: 0.1, default: 1.5 },
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const numCircles = Math.max(2, Math.round(num(params, "numCircles", 30)));
    const minRadius = num(params, "minRadius", 10);
    const maxRadius = Math.max(minRadius + 1, num(params, "maxRadius", 100));
    const numSides = Math.max(6, Math.round(num(params, "numSides", 20)));
    const chaikinN = Math.round(num(params, "chaikin", 4));
    const nudgeMm = num(params, "nudge", 15);
    const layers = Math.max(1, Math.round(num(params, "layers", 5)));
    const layerStep = num(params, "layerStep", 1.5);
    const seed = Math.round(num(params, "seed", 42));
    const cx0 = num(params, "cx", 0);
    const cy0 = num(params, "cy", 0);
    const scale = 2 * maxRadius;
    const nudgeN = nudgeMm / scale;
    const paths = [];
    for (let li = 0; li < layers; li++) {
      const z = li * layerStep;
      const z2 = li * layerStep * 2.5;
      for (let ci = 0; ci < numCircles; ci++) {
        const r2 = minRadius + (maxRadius - minRadius) * (ci / Math.max(1, numCircles - 1));
        const rN = r2 / scale;
        const raw = [];
        for (let si = 0; si < numSides; si++) {
          const theta = 2 * Math.PI * si / numSides;
          const xN = 0.5 + rN * Math.cos(theta);
          const yN = 0.5 + rN * Math.sin(theta);
          const d = Math.hypot(xN - 0.5, yN - 0.5);
          const noiseX = (xN + 0.31) * d * 2 + z2;
          const noiseY = (yN - 1.73) * d * 2 + z2;
          const nv = noise32(noiseX, noiseY, z, seed);
          const angle = nv * Math.PI * 3;
          const nx = xN + nudgeN * Math.cos(angle);
          const ny = yN + nudgeN * Math.sin(angle);
          raw.push({ x: cx0 + (nx - 0.5) * scale, y: cy0 + (ny - 0.5) * scale });
        }
        const pts = chaikinN > 0 ? chaikin(raw, chaikinN) : raw;
        paths.push({ points: [...pts, pts[0]], closed: false });
      }
    }
    return { widthMm: scale, heightMm: scale, paths, meta: { title: "Noise Orbit" } };
  }
};
register(noiseOrbitModule);

// src/lib/modules/sheets.ts
var sheetsModule = {
  key: "sheets",
  label: "Sheets",
  kind: "make",
  group: "Lines & Patterns",
  description: "Randomly displaced grid columns, smoothly interpolated \u2014 produces flowing curtain-like lines.",
  sections: [
    { title: "Grid", fields: [
      { key: "cols", label: "Columns", type: "range", min: 2, max: 60, step: 1, default: 25 },
      { key: "rows", label: "Rows", type: "range", min: 2, max: 60, step: 1, default: 20 },
      { key: "xJitter", label: "X jitter", type: "range", min: 0, max: 50, step: 0.5, unit: "mm", default: 8 },
      { key: "yJitter", label: "Y jitter", type: "range", min: 0, max: 50, step: 0.5, unit: "mm", default: 5 }
    ] },
    { title: "Interpolation", fields: [
      { key: "interpSteps", label: "Steps between cols", type: "range", min: 0, max: 30, step: 1, default: 9 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] },
    { title: "Seed", fields: [
      { key: "seed", label: "Seed", type: "range", min: 0, max: 9999, step: 1, default: 42 }
    ] }
  ],
  generate(params, ctx) {
    const cols = Math.max(2, Math.round(num(params, "cols", 25)));
    const rows = Math.max(2, Math.round(num(params, "rows", 20)));
    const xJitter = num(params, "xJitter", 8);
    const yJitter = num(params, "yJitter", 5);
    const interpSteps = Math.max(0, Math.round(num(params, "interpSteps", 9)));
    const cx = num(params, "cx", 0);
    const cy = num(params, "cy", 0);
    const seed = Math.round(num(params, "seed", 42));
    const rng = seededRandom(seed);
    const { left, right, up, down } = ctx.bounds;
    const xMin = -left, xMax = right;
    const yMin = -up, yMax = down;
    const w = xMax - xMin, h = yMax - yMin;
    const cellW = w / (cols - 1);
    const cellH = h / (rows - 1);
    const grid = [];
    for (let col = 0; col < cols; col++) {
      const column = [];
      for (let row = 0; row < rows; row++) {
        column.push({
          x: xMin + col * cellW + (rng() - 0.5) * 2 * xJitter + cx,
          y: yMin + row * cellH + (rng() - 0.5) * 2 * yJitter + cy
        });
      }
      grid.push(column);
    }
    const paths = [];
    const addColumn = (pts) => {
      if (pts.length > 1) paths.push({ points: pts, closed: false });
    };
    for (let col = 0; col < cols - 1; col++) {
      const colA = grid[col];
      const colB = grid[col + 1];
      addColumn(colA.map((p) => ({ ...p })));
      for (let step = 1; step <= interpSteps; step++) {
        const t = step / (interpSteps + 1);
        addColumn(
          colA.map((a, row) => ({
            x: a.x + t * (colB[row].x - a.x),
            y: a.y + t * (colB[row].y - a.y)
          }))
        );
      }
    }
    addColumn(grid[cols - 1].map((p) => ({ ...p })));
    return { widthMm: w, heightMm: h, paths, meta: { title: "Sheets" } };
  }
};
register(sheetsModule);

// src/lib/modules/moire-curtain.ts
function grating(angleDeg, spacing, cx, cy, rect) {
  const th = angleDeg * Math.PI / 180;
  const dir = { x: Math.cos(th), y: Math.sin(th) };
  const nrm = { x: -Math.sin(th), y: Math.cos(th) };
  const diag = Math.hypot(rect.x1 - rect.x0, rect.y1 - rect.y0);
  const K = Math.ceil(diag / 2 / spacing) + 1;
  const paths = [];
  for (let k = -K; k <= K; k++) {
    const o = k * spacing;
    const px = cx + nrm.x * o, py = cy + nrm.y * o;
    const a = { x: px - dir.x * diag, y: py - dir.y * diag };
    const b = { x: px + dir.x * diag, y: py + dir.y * diag };
    const seg = clipSegmentToRect(a, b, rect);
    if (seg) paths.push({ points: [seg[0], seg[1]] });
  }
  return paths;
}
var moireCurtainModule = {
  key: "moireCurtain",
  label: "Moir\xE9 Curtain",
  kind: "make",
  group: "Lines & Patterns",
  description: "Two line gratings at a small angle offset \u2014 their overlap shimmers.",
  sections: [
    { title: "Field", fields: [
      { key: "w", label: "Width", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "h", label: "Height", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "spacing", label: "Line spacing", type: "range", min: 0.5, max: 30, step: 0.5, unit: "mm", default: 4 }
    ] },
    { title: "Gratings", fields: [
      { key: "angle", label: "Base angle", type: "range", min: -90, max: 90, step: 1, unit: "\xB0", default: 90 },
      { key: "offsetAngle", label: "Angle offset", type: "range", min: 0, max: 45, step: 0.5, unit: "\xB0", default: 6 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const w = num(params, "w", 200), h = num(params, "h", 200);
    const spacing = Math.max(0.5, num(params, "spacing", 4));
    const angle = num(params, "angle", 90);
    const offset = num(params, "offsetAngle", 6);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const rect = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
    const paths = [
      ...grating(angle, spacing, cx, cy, rect),
      ...grating(angle + offset, spacing, cx, cy, rect)
    ];
    return { widthMm: w, heightMm: h, paths, meta: { title: "Moir\xE9 Curtain" } };
  }
};
register(moireCurtainModule);

// src/lib/modules/pattern-maker.ts
function baseShape(kind, size) {
  const h = size / 2;
  if (kind === "circle") {
    const pts = [];
    for (let i = 0; i < 32; i++) {
      const a = 2 * Math.PI * i / 32;
      pts.push({ x: h * Math.cos(a), y: h * Math.sin(a) });
    }
    return pts;
  }
  if (kind === "triangle") {
    return [0, 1, 2].map((i) => {
      const a = -Math.PI / 2 + 2 * Math.PI * i / 3;
      return { x: h * Math.cos(a), y: h * Math.sin(a) };
    });
  }
  return [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
}
var patternMakerModule = {
  key: "patternMaker",
  label: "Pattern Maker",
  kind: "make",
  group: "Lines & Patterns",
  description: "A base shape tiled across a grid, rotating a little more each cell.",
  sections: [
    { title: "Shape", fields: [
      {
        key: "shape",
        label: "Shape",
        type: "select",
        default: "square",
        options: [{ value: "square", label: "Square" }, { value: "circle", label: "Circle" }, { value: "triangle", label: "Triangle" }]
      },
      { key: "fillRatio", label: "Cell fill", type: "range", min: 0.1, max: 1, step: 0.05, default: 0.8 },
      { key: "rotateStep", label: "Rotate / cell", type: "range", min: -45, max: 45, step: 1, unit: "\xB0", default: 7 }
    ] },
    { title: "Grid", fields: [
      { key: "cols", label: "Columns", type: "range", min: 1, max: 30, step: 1, default: 8 },
      { key: "rows", label: "Rows", type: "range", min: 1, max: 30, step: 1, default: 8 },
      { key: "cell", label: "Cell size", type: "range", min: 4, max: 80, step: 1, unit: "mm", default: 24 }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params) {
    const shape = String(params.shape ?? "square");
    const fillRatio = num(params, "fillRatio", 0.8);
    const rotateStep = num(params, "rotateStep", 7);
    const cols = Math.max(1, Math.round(num(params, "cols", 8)));
    const rows = Math.max(1, Math.round(num(params, "rows", 8)));
    const cell = num(params, "cell", 24);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const startX = cx - (cols - 1) * cell / 2;
    const startY = cy - (rows - 1) * cell / 2;
    const size = cell * fillRatio;
    const paths = [];
    for (let r2 = 0; r2 < rows; r2++) {
      for (let c = 0; c < cols; c++) {
        const idx = r2 * cols + c;
        const ox = startX + c * cell, oy = startY + r2 * cell;
        let pts = baseShape(shape, size);
        const rot = idx * rotateStep * Math.PI / 180;
        if (rot) pts = rotate(pts, rot);
        pts = pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
        paths.push({ points: pts, closed: true });
      }
    }
    return { widthMm: cols * cell, heightMm: rows * cell, paths, meta: { title: "Pattern Maker" } };
  }
};
register(patternMakerModule);

// src/lib/clip.ts
function pointInPolygon(p, poly) {
  let inside2 = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
      inside2 = !inside2;
    }
  }
  return inside2;
}
function segCrossT(p, q, a, b) {
  const rx = q.x - p.x, ry = q.y - p.y;
  const sx = b.x - a.x, sy = b.y - a.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / denom;
  const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}
function clipPolylineToPolygon(points, poly, keepInside) {
  if (points.length < 2 || poly.length < 3) return [];
  const out = [];
  let cur = [];
  const at = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const ts = [];
    for (let j = 0, k = poly.length - 1; j < poly.length; k = j++) {
      const t = segCrossT(a, b, poly[k], poly[j]);
      if (t !== null && t > 1e-9 && t < 1 - 1e-9) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    const cuts = [0, ...ts, 1];
    for (let c = 0; c < cuts.length - 1; c++) {
      const t0 = cuts[c], t1 = cuts[c + 1];
      const keep = pointInPolygon(at(a, b, (t0 + t1) / 2), poly) === keepInside;
      if (keep) {
        if (cur.length === 0) cur.push(at(a, b, t0));
        cur.push(at(a, b, t1));
      } else if (cur.length >= 2) {
        out.push(cur);
        cur = [];
      } else {
        cur = [];
      }
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

// src/lib/modules/mask.ts
function maskPolygon(shape, size, sides, rotDeg, cx, cy) {
  let pts;
  if (shape === "square") {
    pts = [{ x: -size, y: -size }, { x: size, y: -size }, { x: size, y: size }, { x: -size, y: size }];
  } else {
    const n = shape === "circle" ? 64 : Math.max(3, Math.round(sides));
    pts = [];
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * i / n;
      pts.push({ x: size * Math.cos(a), y: size * Math.sin(a) });
    }
  }
  const rot = rotDeg * Math.PI / 180;
  if (rot) pts = rotate(pts, rot);
  return pts.map((p) => ({ x: p.x + cx, y: p.y + cy }));
}
var maskModule = {
  key: "mask",
  label: "Shape Mask",
  kind: "modify",
  group: "Modifiers",
  description: "Keeps the geometry below only inside (or outside) a shape region.",
  sections: [
    { title: "Mask", fields: [
      {
        key: "shape",
        label: "Shape",
        type: "select",
        default: "circle",
        options: [{ value: "circle", label: "Circle" }, { value: "square", label: "Square" }, { value: "polygon", label: "Polygon" }]
      },
      {
        key: "mode",
        label: "Keep",
        type: "select",
        default: "inside",
        options: [{ value: "inside", label: "Inside" }, { value: "outside", label: "Outside" }]
      },
      { key: "size", label: "Size", type: "range", min: 5, max: 300, step: 1, unit: "mm", default: 80 },
      { key: "sides", label: "Polygon sides", type: "range", min: 3, max: 12, step: 1, default: 6 },
      { key: "rotation", label: "Rotation", type: "range", min: -180, max: 180, step: 1, unit: "\xB0", default: 0 },
      { key: "showMask", label: "Draw mask outline", type: "toggle", default: false }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const keepInside = String(params.mode ?? "inside") !== "outside";
    const poly = maskPolygon(
      String(params.shape ?? "circle"),
      num(params, "size", 80),
      num(params, "sides", 6),
      num(params, "rotation", 0),
      num(params, "cx", 0),
      num(params, "cy", 0)
    );
    const out = [];
    for (const path of lower.paths) {
      const pts = path.closed && path.points.length > 2 ? [...path.points, path.points[0]] : path.points;
      for (const piece of clipPolylineToPolygon(pts, poly, keepInside)) {
        out.push({ points: piece, cycles: path.cycles, stroke: path.stroke });
      }
    }
    if (params.showMask === true) out.push({ points: poly, closed: true });
    return { ...lower, paths: out, meta: { title: "Shape Mask" } };
  }
};
register(maskModule);

// src/lib/modules/fill.ts
function hatchPolygon(poly, spacing, angleDeg) {
  const b = bounds(poly);
  if (!b) return [];
  const th = angleDeg * Math.PI / 180;
  const dir = { x: Math.cos(th), y: Math.sin(th) };
  const nrm = { x: -Math.sin(th), y: Math.cos(th) };
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const diag = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
  const K = Math.ceil(diag / 2 / spacing) + 1;
  const out = [];
  for (let k = -K; k <= K; k++) {
    const o = k * spacing;
    const px = cx + nrm.x * o, py = cy + nrm.y * o;
    const a = { x: px - dir.x * diag, y: py - dir.y * diag };
    const c = { x: px + dir.x * diag, y: py + dir.y * diag };
    for (const piece of clipPolylineToPolygon([a, c], poly, true)) out.push({ points: piece });
  }
  return out;
}
function concentricRings(poly, spacing) {
  const b = bounds(poly);
  if (!b) return [];
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  const radius = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2;
  const step = Math.min(0.5, Math.max(0.02, spacing / Math.max(1, radius)));
  const out = [];
  for (let s = 1 - step; s > 0.02; s -= step) {
    out.push({ points: poly.map((p) => ({ x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s })), closed: true });
  }
  return out;
}
var fillModule = {
  key: "fill",
  label: "Fill",
  kind: "modify",
  group: "Modifiers",
  description: "Hatches or concentrically fills every closed shape in the layers below.",
  sections: [
    { title: "Fill", fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        default: "hatch",
        options: [{ value: "hatch", label: "Hatch" }, { value: "concentric", label: "Concentric" }]
      },
      { key: "spacing", label: "Spacing", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 3 },
      { key: "angle", label: "Hatch angle", type: "range", min: -90, max: 90, step: 1, unit: "\xB0", default: 45 },
      { key: "keepOutline", label: "Keep outlines", type: "toggle", default: true }
    ] }
  ],
  generate(params, ctx) {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const mode = String(params.mode ?? "hatch");
    const spacing = Math.max(0.5, num(params, "spacing", 3));
    const angle = num(params, "angle", 45);
    const keepOutline = params.keepOutline !== false;
    const out = keepOutline ? [...lower.paths] : lower.paths.filter((p) => !p.closed);
    for (const path of lower.paths) {
      if (!path.closed || path.points.length < 3) continue;
      out.push(...mode === "concentric" ? concentricRings(path.points, spacing) : hatchPolygon(path.points, spacing, angle));
    }
    return { ...lower, paths: out, meta: { title: "Fill" } };
  }
};
register(fillModule);

// src/lib/modules/warp.ts
var warpModule = {
  key: "warp",
  label: "Warp / Ripple",
  kind: "modify",
  group: "Modifiers",
  description: "Displaces the geometry below with a water warp or droplet ripples.",
  sections: [
    { title: "Ripple", fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        default: "water",
        options: [{ value: "water", label: "Water" }, { value: "droplet", label: "Droplet" }]
      },
      { key: "amplitude", label: "Amplitude", type: "range", min: 0, max: 40, step: 0.5, unit: "mm", default: 8 },
      { key: "wavelength", label: "Wavelength", type: "range", min: 5, max: 200, step: 1, unit: "mm", default: 60 },
      { key: "falloff", label: "Falloff", type: "range", min: 0, max: 0.05, step: 1e-3, default: 0.01 },
      { key: "resample", label: "Resample", type: "toggle", default: true }
    ] },
    { title: "Center", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const lower = ctx.lowerFrame ?? { widthMm: 0, heightMm: 0, paths: [] };
    const droplet = String(params.mode ?? "water") === "droplet";
    const amp = num(params, "amplitude", 8);
    const wl = Math.max(1, num(params, "wavelength", 60));
    const falloff = num(params, "falloff", 0.01);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const doResample = params.resample !== false;
    const k = 2 * Math.PI / wl;
    const displace = (p) => {
      if (droplet) {
        const dx = p.x - cx, dy = p.y - cy;
        const r2 = Math.hypot(dx, dy);
        if (r2 < 1e-6) return { ...p };
        const d = amp * Math.sin(k * r2) * Math.exp(-falloff * r2);
        return { x: p.x + dx / r2 * d, y: p.y + dy / r2 * d };
      }
      return { x: p.x + amp * Math.sin(k * (p.y - cy)), y: p.y + amp * Math.sin(k * (p.x - cx)) };
    };
    const spacing = Math.max(1, wl / 8);
    const paths = lower.paths.map((path) => {
      const src = doResample && path.points.length > 1 ? resample(path.points, spacing) : path.points;
      return { ...path, points: src.map(displace) };
    });
    return { ...lower, paths, meta: { title: "Warp / Ripple" } };
  }
};
register(warpModule);

// src/lib/strokefont.ts
var GRID_H = 7;
var ADVANCE = 5;
var GLYPHS = {
  "A": "0,6 2,0 4,6|1,4 3,4",
  "B": "0,0 0,6|0,0 3,0 4,1 4,2 3,3 0,3|0,3 3,3 4,4 4,5 3,6 0,6",
  "C": "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5",
  "D": "0,0 0,6|0,0 3,0 4,1 4,5 3,6 0,6",
  "E": "4,0 0,0 0,6 4,6|0,3 3,3",
  "F": "4,0 0,0 0,6|0,3 3,3",
  "G": "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3 2,3",
  "H": "0,0 0,6|4,0 4,6|0,3 4,3",
  "I": "1,0 3,0|2,0 2,6|1,6 3,6",
  "J": "3,0 3,5 2,6 1,6 0,5",
  "K": "0,0 0,6|4,0 0,3 4,6",
  "L": "0,0 0,6 4,6",
  "M": "0,6 0,0 2,3 4,0 4,6",
  "N": "0,6 0,0 4,6 4,0",
  "O": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0",
  "P": "0,6 0,0 3,0 4,1 4,2 3,3 0,3",
  "Q": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2,4 4,6",
  "R": "0,6 0,0 3,0 4,1 4,2 3,3 0,3|2,3 4,6",
  "S": "4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5",
  "T": "0,0 4,0|2,0 2,6",
  "U": "0,0 0,5 1,6 3,6 4,5 4,0",
  "V": "0,0 2,6 4,0",
  "W": "0,0 1,6 2,3 3,6 4,0",
  "X": "0,0 4,6|4,0 0,6",
  "Y": "0,0 2,3 4,0|2,3 2,6",
  "Z": "0,0 4,0 0,6 4,6",
  "0": "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|0,5 4,1",
  "1": "1,1 2,0 2,6|1,6 3,6",
  "2": "0,1 1,0 3,0 4,1 4,2 0,6 4,6",
  "3": "0,0 4,0 2,3|2,3 4,4 4,5 3,6 1,6 0,5",
  "4": "3,6 3,0 0,4 4,4",
  "5": "4,0 1,0 0,3 3,3 4,4 4,5 3,6 1,6 0,5",
  "6": "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 0,3",
  "7": "0,0 4,0 1,6",
  "8": "1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3 1,3|1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3",
  "9": "0,5 1,6 3,6 4,5 4,1 3,0 1,0 0,1 0,2 1,3 4,3",
  ".": "2,5 2,6",
  ",": "2,5 2,6 1,7",
  "-": "1,3 3,3",
  "+": "2,2 2,5|0.5,3.5 3.5,3.5",
  "/": "4,0 0,6",
  "!": "2,0 2,4|2,5 2,6",
  "?": "0,1 1,0 3,0 4,1 4,2 2,4 2,4|2,5 2,6",
  ":": "2,2 2,3|2,4 2,5",
  " ": ""
};
function parseGlyph(spec) {
  if (!spec) return [];
  return spec.split("|").map((stroke2) => stroke2.trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return { x, y };
  }));
}
var STROKE_FONTS = [
  { value: "sans", label: "Built-in Sans" },
  { value: "bold", label: "Built-in Bold" }
];
var BOLD_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]];
function strokeFontDriver(name = "sans") {
  const bold = name === "bold";
  return {
    measureRun(text, size, ls) {
      if (!text) return 0;
      const scale = size / GRID_H;
      let w = 0;
      for (let i = 0; i < text.length; i++) w += ADVANCE * scale + ls;
      return Math.max(0, w - ls);
    },
    renderRun(text, size, ls) {
      const scale = size / GRID_H;
      const o = bold ? 0.05 * size : 0;
      const out = [];
      let cursor = 0;
      for (const raw of text) {
        const ch = raw.toUpperCase();
        const spec = ch in GLYPHS ? GLYPHS[ch] : GLYPHS[" "];
        for (const stroke2 of parseGlyph(spec)) {
          const base = stroke2.map((p) => ({ x: cursor + p.x * scale, y: p.y * scale }));
          if (!bold) out.push(base);
          else for (const [dx, dy] of BOLD_OFFSETS) out.push(base.map((p) => ({ x: p.x + dx * o, y: p.y + dy * o })));
        }
        cursor += ADVANCE * scale + ls;
      }
      return out;
    }
  };
}

// src/lib/textbox.ts
function wrapLines(text, driver, size, ls, boxW) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const trial = line === "" ? word : line + " " + word;
      if (line !== "" && driver.measureRun(trial, size, ls) > boxW) {
        out.push(line);
        line = word;
      } else line = trial;
    }
    out.push(line);
  }
  return out;
}
function fitsBox(text, driver, size, opts) {
  const lines = wrapLines(text, driver, size, opts.letterSpacing, opts.boxW);
  if (lines.length * opts.lineHeight * size > opts.boxH + 1e-6) return false;
  for (const line of lines) if (driver.measureRun(line, size, opts.letterSpacing) > opts.boxW + 1e-6) return false;
  return true;
}
function layoutTextBox(text, driver, opts) {
  let size = opts.size;
  if (opts.autoFit && size > 0 && opts.boxW > 0 && opts.boxH > 0 && !fitsBox(text, driver, size, opts)) {
    let lo = 0, hi = size;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fitsBox(text, driver, mid, opts)) lo = mid;
      else hi = mid;
    }
    size = lo;
  }
  const ls = opts.letterSpacing;
  const lines = wrapLines(text, driver, size, ls, opts.boxW);
  const lineH = opts.lineHeight * size;
  const totalH = lines.length * lineH;
  const startY = opts.vAlign === "top" ? 0 : opts.vAlign === "bottom" ? opts.boxH - totalH : (opts.boxH - totalH) / 2;
  const strokes = [];
  lines.forEach((line, i) => {
    if (line === "") return;
    const w = driver.measureRun(line, size, ls);
    const xoff = opts.align === "left" ? 0 : opts.align === "right" ? opts.boxW - w : (opts.boxW - w) / 2;
    const yoff = startY + i * lineH;
    for (const s of driver.renderRun(line, size, ls)) strokes.push(s.map((p) => ({ x: p.x + xoff, y: p.y + yoff })));
  });
  return { strokes, size, lines };
}
function opentypeFontDriver(font) {
  const ascent = (size) => font.ascender / font.unitsPerEm * size;
  return {
    measureRun(text, size, ls) {
      if (!text) return 0;
      let w = 0;
      for (const ch of text) w += font.getAdvanceWidth(ch, size) + ls;
      return Math.max(0, w - ls);
    },
    renderRun(text, size, ls) {
      const out = [];
      const yBase = ascent(size);
      const n = Math.max(4, Math.round(size / 2));
      let cursor = 0;
      for (const ch of text) {
        const { commands } = font.getPath(ch, cursor, yBase, size);
        let poly = [];
        let start = null;
        let prev = null;
        const flush = () => {
          if (poly.length > 1) out.push(poly);
          poly = [];
        };
        for (const c of commands) {
          switch (c.type) {
            case "M":
              flush();
              start = { x: c.x, y: c.y };
              poly = [start];
              prev = start;
              break;
            case "L": {
              const p = { x: c.x, y: c.y };
              poly.push(p);
              prev = p;
              break;
            }
            case "Q": {
              const p0 = prev ?? { x: c.x, y: c.y };
              const p3 = { x: c.x, y: c.y };
              const c1 = { x: p0.x + 2 / 3 * (c.x1 - p0.x), y: p0.y + 2 / 3 * (c.y1 - p0.y) };
              const c2 = { x: p3.x + 2 / 3 * (c.x1 - p3.x), y: p3.y + 2 / 3 * (c.y1 - p3.y) };
              const seg = sampleBezier(p0, c1, c2, p3, n);
              for (let i = 1; i < seg.length; i++) poly.push(seg[i]);
              prev = p3;
              break;
            }
            case "C": {
              const p0 = prev ?? { x: c.x, y: c.y };
              const p3 = { x: c.x, y: c.y };
              const seg = sampleBezier(p0, { x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, p3, n);
              for (let i = 1; i < seg.length; i++) poly.push(seg[i]);
              prev = p3;
              break;
            }
            case "Z":
              if (start) poly.push({ ...start });
              flush();
              prev = start;
              break;
          }
        }
        flush();
        cursor += font.getAdvanceWidth(ch, size) + ls;
      }
      return out;
    }
  };
}

// src/lib/modules/text.ts
var textModule = {
  key: "text",
  label: "Text",
  kind: "make",
  group: "Shapes & Imports",
  description: "Box text: word-wraps inside a width\xD7height box, auto-shrinks to fit. Built-in Sans/Bold or an uploaded TTF/OTF font.",
  sections: [
    { title: "Text", fields: [
      { key: "text", label: "Text", type: "text", default: "The quick brown fox jumps over the lazy dog", placeholder: "type here\u2026" },
      { key: "font", label: "Font", type: "select", default: "sans", options: [
        ...STROKE_FONTS,
        { value: "custom", label: "Upload TTF/OTF\u2026" }
      ] },
      { key: "size", label: "Max size", type: "range", min: 4, max: 120, step: 1, unit: "mm", default: 28 },
      { key: "letterSpacing", label: "Letter spacing", type: "range", min: -5, max: 20, step: 0.5, unit: "mm", default: 1 },
      { key: "lineHeight", label: "Line height", type: "range", min: 0.8, max: 3, step: 0.05, unit: "\xD7", default: 1.3 },
      { key: "align", label: "Align", type: "select", default: "left", options: [
        { value: "left", label: "Left" },
        { value: "center", label: "Center" },
        { value: "right", label: "Right" }
      ] }
    ] },
    { title: "Box", fields: [
      { key: "boxW", label: "Box width", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 160 },
      { key: "boxH", label: "Box height", type: "range", min: 10, max: 600, step: 1, unit: "mm", default: 100 },
      { key: "vAlign", label: "Vertical align", type: "select", default: "top", options: [
        { value: "top", label: "Top" },
        { value: "middle", label: "Middle" },
        { value: "bottom", label: "Bottom" }
      ] },
      { key: "autoFit", label: "Shrink to fit", type: "toggle", default: true },
      { key: "showBorder", label: "Draw box border", type: "toggle", default: false }
    ] },
    { title: "Position", fields: [
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const text = String(params.text ?? "");
    const fontSel = String(params.font ?? "sans");
    const boxW = num(params, "boxW", 160), boxH = num(params, "boxH", 100);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const driver = fontSel === "custom" && ctx.font ? opentypeFontDriver(ctx.font) : strokeFontDriver(fontSel === "bold" ? "bold" : "sans");
    const { strokes } = layoutTextBox(text, driver, {
      boxW,
      boxH,
      size: num(params, "size", 28),
      letterSpacing: num(params, "letterSpacing", 1),
      lineHeight: num(params, "lineHeight", 1.3),
      align: String(params.align ?? "left"),
      vAlign: String(params.vAlign ?? "top"),
      autoFit: params.autoFit !== false
    });
    const ox = cx - boxW / 2, oy = cy - boxH / 2;
    const paths = strokes.map((s) => ({ points: s.map((p) => ({ x: p.x + ox, y: p.y + oy })) }));
    if (params.showBorder) paths.push(rectPath(cx, cy, boxW, boxH));
    return { widthMm: boxW, heightMm: boxH, paths, meta: { title: "Text" } };
  }
};
register(textModule);

// src/lib/modules/image-linework.ts
function isoContours(gray, w, h, level) {
  const segs = [];
  const lerp = (va, vb) => Math.abs(vb - va) < 1e-9 ? 0.5 : (level - va) / (vb - va);
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = gray[y * w + x], tr = gray[y * w + x + 1];
      const br = gray[(y + 1) * w + x + 1], bl = gray[(y + 1) * w + x];
      const idx = (tl < level ? 1 : 0) | (tr < level ? 2 : 0) | (br < level ? 4 : 0) | (bl < level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = { x: x + lerp(tl, tr), y };
      const R = { x: x + 1, y: y + lerp(tr, br) };
      const B = { x: x + lerp(bl, br), y: y + 1 };
      const L = { x, y: y + lerp(tl, bl) };
      switch (idx) {
        case 1:
        case 14:
          segs.push([L, T]);
          break;
        case 2:
        case 13:
          segs.push([T, R]);
          break;
        case 3:
        case 12:
          segs.push([L, R]);
          break;
        case 4:
        case 11:
          segs.push([R, B]);
          break;
        case 6:
        case 9:
          segs.push([T, B]);
          break;
        case 7:
        case 8:
          segs.push([L, B]);
          break;
        case 5:
          segs.push([L, T]);
          segs.push([R, B]);
          break;
        // saddle
        case 10:
          segs.push([T, R]);
          segs.push([L, B]);
          break;
      }
    }
  }
  return segs;
}
var imageLineworkModule = {
  key: "imageLinework",
  label: "Image Linework",
  kind: "make",
  group: "Image",
  description: "Brightness iso-contours of a source image (load one in the Studio).",
  sections: [
    { title: "Contours", fields: [
      { key: "levels", label: "Levels", type: "range", min: 1, max: 24, step: 1, default: 8 },
      { key: "invert", label: "Invert", type: "toggle", default: false }
    ] },
    { title: "Placement", fields: [
      { key: "plotSize", label: "Plot size", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const img = ctx.image;
    if (!img || img.width < 2 || img.height < 2) {
      return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Image Linework (load an image)" } };
    }
    const levels = Math.max(1, Math.round(num(params, "levels", 8)));
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const g = invert ? img.gray.map((v) => 1 - v) : img.gray;
    const s = Math.min(plot / img.width, plot / img.height);
    const offX = cx - img.width * s / 2, offY = cy - img.height * s / 2;
    const map = (p) => ({ x: p.x * s + offX, y: p.y * s + offY });
    const paths = [];
    for (let i = 1; i <= levels; i++) {
      const level = i / (levels + 1);
      for (const [a, b] of isoContours(g, img.width, img.height, level)) paths.push({ points: [map(a), map(b)] });
    }
    return { widthMm: img.width * s, heightMm: img.height * s, paths, meta: { title: "Image Linework" } };
  }
};
register(imageLineworkModule);

// src/lib/image.ts
function sampleGray(img, x, y) {
  const { width: w, height: h, gray } = img;
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0, fy = cy - y0;
  const a = gray[y0 * w + x0], b = gray[y0 * w + x1], c = gray[y1 * w + x0], d = gray[y1 * w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
function imageFit(img, plotSize, cx, cy) {
  const s = Math.min(plotSize / img.width, plotSize / img.height);
  return { s, offX: cx - img.width * s / 2, offY: cy - img.height * s / 2, plotW: img.width * s, plotH: img.height * s };
}

// src/lib/modules/image-halftone.ts
var imageHalftoneModule = {
  key: "imageHalftone",
  label: "Image Halftone",
  kind: "make",
  group: "Image",
  description: "A grid of dots sized by the image's darkness (load an image in the Studio).",
  sections: [
    { title: "Halftone", fields: [
      { key: "spacing", label: "Dot spacing", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 4 },
      { key: "maxDot", label: "Max dot", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 4 },
      { key: "invert", label: "Invert", type: "toggle", default: false }
    ] },
    { title: "Placement", fields: [
      { key: "plotSize", label: "Plot size", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const img = ctx.image;
    if (!img || img.width < 2) return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Image Halftone (load an image)" } };
    const spacing = Math.max(1, num(params, "spacing", 4));
    const maxDot = num(params, "maxDot", 4);
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const { s, offX, offY, plotW, plotH } = imageFit(img, plot, cx, cy);
    const paths = [];
    for (let my = offY + spacing / 2; my < offY + plotH; my += spacing) {
      for (let mx = offX + spacing / 2; mx < offX + plotW; mx += spacing) {
        let v = sampleGray(img, (mx - offX) / s, (my - offY) / s);
        if (invert) v = 1 - v;
        const r2 = (1 - v) * maxDot / 2;
        if (r2 < 0.3) continue;
        const n = 12, pts = [];
        for (let i = 0; i < n; i++) {
          const a = 2 * Math.PI * i / n;
          pts.push({ x: mx + r2 * Math.cos(a), y: my + r2 * Math.sin(a) });
        }
        paths.push({ points: pts, closed: true });
      }
    }
    return { widthMm: plotW, heightMm: plotH, paths, meta: { title: "Image Halftone" } };
  }
};
register(imageHalftoneModule);

// src/lib/modules/image-squiggle.ts
var imageSquiggleModule = {
  key: "imageSquiggle",
  label: "Image Squiggle",
  kind: "make",
  group: "Image",
  description: "Wavy scanlines whose amplitude tracks darkness (load an image in the Studio).",
  sections: [
    { title: "Squiggle", fields: [
      { key: "rowSpacing", label: "Row spacing", type: "range", min: 0.5, max: 20, step: 0.5, unit: "mm", default: 4 },
      { key: "wavelength", label: "Wavelength", type: "range", min: 1, max: 30, step: 0.5, unit: "mm", default: 6 },
      { key: "maxAmp", label: "Max amplitude", type: "range", min: 0.5, max: 15, step: 0.5, unit: "mm", default: 2.5 },
      { key: "invert", label: "Invert", type: "toggle", default: false }
    ] },
    { title: "Placement", fields: [
      { key: "plotSize", label: "Plot size", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const img = ctx.image;
    if (!img || img.width < 2) return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Image Squiggle (load an image)" } };
    const rowSpacing = Math.max(1, num(params, "rowSpacing", 4));
    const wl = Math.max(1, num(params, "wavelength", 6));
    const maxAmp = num(params, "maxAmp", 2.5);
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const { s, offX, offY, plotW, plotH } = imageFit(img, plot, cx, cy);
    const stepX = Math.max(0.5, wl / 12);
    const k = 2 * Math.PI / wl;
    const paths = [];
    for (let my = offY + rowSpacing / 2; my < offY + plotH; my += rowSpacing) {
      const row = [];
      for (let mx = offX; mx <= offX + plotW; mx += stepX) {
        let v = sampleGray(img, (mx - offX) / s, (my - offY) / s);
        if (invert) v = 1 - v;
        const amp = (1 - v) * maxAmp;
        row.push({ x: mx, y: my + amp * Math.sin(k * mx) });
      }
      if (row.length > 1) paths.push({ points: row });
    }
    return { widthMm: plotW, heightMm: plotH, paths, meta: { title: "Image Squiggle" } };
  }
};
register(imageSquiggleModule);

// src/lib/modules/image-surface.ts
var imageSurfaceModule = {
  key: "imageSurface",
  label: "Depth Map",
  kind: "make",
  group: "Image",
  description: "An image as stacked ridgelines \u2014 brightness becomes height, sheared into a 3D look.",
  sections: [
    { title: "Surface", fields: [
      { key: "rows", label: "Rows", type: "range", min: 5, max: 160, step: 1, default: 60 },
      { key: "height", label: "Height", type: "range", min: 0, max: 80, step: 1, unit: "mm", default: 22 },
      { key: "shear", label: "3D shear", type: "range", min: -1, max: 1, step: 0.02, default: 0.4 },
      { key: "invert", label: "Invert", type: "toggle", default: false }
    ] },
    { title: "Placement", fields: [
      { key: "plotSize", label: "Plot size", type: "range", min: 20, max: 600, step: 1, unit: "mm", default: 200 },
      { key: "cx", label: "Center X", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 },
      { key: "cy", label: "Center Y", type: "range", min: -300, max: 300, step: 1, unit: "mm", default: 0 }
    ] }
  ],
  generate(params, ctx) {
    const img = ctx.image;
    if (!img || img.width < 2 || img.height < 2) {
      return { widthMm: 1, heightMm: 1, paths: [], meta: { title: "Depth Map (load an image)" } };
    }
    const rows = Math.max(2, Math.round(num(params, "rows", 60)));
    const height = num(params, "height", 22);
    const shear = num(params, "shear", 0.4);
    const invert = params.invert === true;
    const plot = num(params, "plotSize", 200);
    const cx = num(params, "cx", 0), cy = num(params, "cy", 0);
    const { s, offX, offY, plotW, plotH } = imageFit(img, plot, cx, cy);
    const cols = Math.min(img.width, 240);
    const rowStep = plotH / (rows - 1);
    const shearX = shear * rowStep;
    const paths = [];
    for (let ri = 0; ri < rows; ri++) {
      const gy = ri / (rows - 1) * (img.height - 1);
      const baseY = offY + ri * rowStep;
      const xShift = ri * shearX;
      const row = [];
      for (let ci = 0; ci < cols; ci++) {
        const gx = ci / (cols - 1) * (img.width - 1);
        let v = sampleGray(img, gx, gy);
        if (invert) v = 1 - v;
        const lift = v * height;
        row.push({ x: offX + ci / (cols - 1) * plotW + xShift, y: baseY - lift });
      }
      paths.push({ points: row });
    }
    void s;
    return { widthMm: plotW + (rows - 1) * Math.abs(shearX), heightMm: plotH + height, paths, meta: { title: "Depth Map" } };
  }
};
register(imageSurfaceModule);

// src/lib/arcfit.ts
var MIN_ARC_PTS = 4;
var MAX_ARC_R = 1e5;
function circleFrom3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}
var cross = (ox, oy, p, q) => (p.x - ox) * (q.y - oy) - (p.y - oy) * (q.x - ox);
function fitArcs(points, tol) {
  const n = points.length;
  if (n < MIN_ARC_PTS || tol <= 0) return [{ kind: "line", points: points.slice() }];
  const prims = [];
  let lineStart = 0;
  let i = 0;
  const flushLine = (endIdx) => {
    if (endIdx - lineStart >= 1) prims.push({ kind: "line", points: points.slice(lineStart, endIdx + 1) });
  };
  while (i < n - 1) {
    let best = -1, bestC = null;
    for (let j = i + MIN_ARC_PTS - 1; j < n; j++) {
      const c = circleFrom3(points[i], points[i + j >> 1], points[j]);
      if (!c || c.r > MAX_ARC_R) break;
      let ok = true;
      for (let k = i; k <= j && ok; k++) if (Math.abs(Math.hypot(points[k].x - c.cx, points[k].y - c.cy) - c.r) > tol) ok = false;
      for (let k = i; k < j && ok; k++) {
        const mx = (points[k].x + points[k + 1].x) / 2, my = (points[k].y + points[k + 1].y) / 2;
        if (Math.abs(Math.hypot(mx - c.cx, my - c.cy) - c.r) > tol) ok = false;
      }
      if (ok) {
        let sign = 0;
        for (let k = i + 1; k <= j && ok; k++) {
          const s = Math.sign(cross(c.cx, c.cy, points[k - 1], points[k]));
          if (s !== 0) {
            if (sign === 0) sign = s;
            else if (s !== sign) ok = false;
          }
        }
      }
      if (!ok) break;
      best = j;
      bestC = c;
    }
    if (best >= 0 && bestC && best - i >= MIN_ARC_PTS - 1) {
      flushLine(i);
      let turn = 0;
      for (let k = i + 1; k <= best; k++) turn += cross(bestC.cx, bestC.cy, points[k - 1], points[k]);
      prims.push({
        kind: "arc",
        cx: bestC.cx,
        cy: bestC.cy,
        r: bestC.r,
        a0: Math.atan2(points[i].y - bestC.cy, points[i].x - bestC.cx),
        a1: Math.atan2(points[best].y - bestC.cy, points[best].x - bestC.cx),
        cw: turn < 0
      });
      i = best;
      lineStart = best;
    } else {
      i++;
    }
  }
  flushLine(n - 1);
  return prims;
}

// src/lib/compile.ts
var r = (n) => Math.round(n * 100) / 100;
var r4 = (n) => Math.round(n * 1e4) / 1e4;
function boundsRect(b) {
  return [
    { x: -b.left, y: -b.up },
    { x: b.right, y: -b.up },
    { x: b.right, y: b.down },
    { x: -b.left, y: b.down }
  ];
}
function emitArcPath(path, tol, out) {
  const pts = path.points;
  if (pts.length === 0) return;
  const cycles = path.cycles && path.cycles > 0 ? Math.round(path.cycles) : 1;
  const ring = path.closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  out.push(`goto?x=${r(ring[0].x)}&y=${r(ring[0].y)}`);
  if (ring.length === 1) return;
  out.push("pen?pos=down");
  for (const prim of fitArcs(ring, tol)) {
    if (prim.kind === "arc") {
      out.push(`arc?cx=${r(prim.cx)}&cy=${r(prim.cy)}&r=${r(prim.r)}&a0=${r4(prim.a0)}&a1=${r4(prim.a1)}&cw=${prim.cw ? 1 : 0}&cycles=${cycles}&lift=0`);
    } else {
      for (let i = 1; i < prim.points.length; i++) {
        const a = prim.points[i - 1], b = prim.points[i];
        out.push(`line?x0=${r(a.x)}&y0=${r(a.y)}&x1=${r(b.x)}&y1=${r(b.y)}&cycles=${cycles}&lift=0`);
      }
    }
  }
  out.push("pen?pos=up");
}
function emitPath(path, out) {
  const pts = path.points;
  if (pts.length === 0) return;
  const cycles = path.cycles && path.cycles > 0 ? Math.round(path.cycles) : 1;
  out.push(`goto?x=${r(pts[0].x)}&y=${r(pts[0].y)}`);
  if (pts.length === 1) return;
  out.push("pen?pos=down");
  const seg = (a, b) => out.push(`line?x0=${r(a.x)}&y0=${r(a.y)}&x1=${r(b.x)}&y1=${r(b.y)}&cycles=${cycles}&lift=0`);
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
  if (path.closed && pts.length > 2) seg(pts[pts.length - 1], pts[0]);
  out.push("pen?pos=up");
}
function compile(frame, opts = {}) {
  const out = ["pen?pos=up"];
  const tol = opts.arcTol ?? 0;
  const rect = opts.clipBounds ? boundsRect(opts.clipBounds) : null;
  for (const path of frame.paths) {
    if (rect) {
      const ring = path.closed && path.points.length > 2 ? [...path.points, path.points[0]] : path.points;
      const segments = clipPolylineToPolygon(ring, rect, true);
      for (const pts of segments) {
        if (pts.length < 2) continue;
        const cp = { ...path, points: pts, closed: false };
        if (tol > 0) emitArcPath(cp, tol, out);
        else emitPath(cp, out);
      }
    } else {
      if (tol > 0) emitArcPath(path, tol, out);
      else emitPath(path, out);
    }
  }
  return out;
}

// src/lib/pipeline.ts
function emptyFrame(bounds2) {
  return { widthMm: bounds2.left + bounds2.right, heightMm: bounds2.up + bounds2.down, paths: [] };
}
function mergeFrames(a, b) {
  return {
    widthMm: Math.max(a.widthMm, b.widthMm),
    heightMm: Math.max(a.heightMm, b.heightMm),
    paths: [...a.paths, ...b.paths],
    meta: b.meta ?? a.meta
  };
}
function applyGroupTransform(frame, g) {
  if (g.tx === 0 && g.ty === 0 && g.rotateDeg === 0) return frame;
  const rad = g.rotateDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    ...frame,
    paths: frame.paths.map((path) => ({
      ...path,
      points: path.points.map((p) => ({
        x: p.x * cos - p.y * sin + g.tx,
        y: p.x * sin + p.y * cos + g.ty
      }))
    }))
  };
}
function evaluate(layers, bounds2, groups = [], image, font) {
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  let acc = emptyFrame(bounds2);
  for (const layer of layers) {
    const mod = getModule(layer.moduleKey);
    if (!mod) continue;
    let out = mod.generate(layer.params, { bounds: bounds2, lowerFrame: acc, image, font });
    if (mod.kind === "make" && layer.groupId) {
      const g = groupMap.get(layer.groupId);
      if (g) out = applyGroupTransform(out, g);
    }
    acc = mod.kind === "modify" ? out : mergeFrames(acc, out);
  }
  return acc;
}

// src/lib/toolpath.ts
function simplifyFrame(frame, tol = 0.2) {
  if (tol <= 0) return frame;
  const paths = frame.paths.map((p) => p.points.length > 2 ? { ...p, points: simplifyRDP(p.points, tol) } : clonePath(p));
  return { ...frame, paths };
}
var ORIGIN = { x: 0, y: 0 };
function optimizeOrder(frame, start = ORIGIN) {
  const remaining = frame.paths.filter((p) => p.points.length > 0).map(clonePath);
  const ordered = [];
  let cur = start;
  while (remaining.length) {
    let best = 0, bestD = Infinity, bestRev = false;
    for (let k = 0; k < remaining.length; k++) {
      const pts = remaining[k].points;
      const ds = dist(cur, pts[0]);
      const de = dist(cur, pts[pts.length - 1]);
      if (ds < bestD) {
        bestD = ds;
        best = k;
        bestRev = false;
      }
      if (de < bestD) {
        bestD = de;
        best = k;
        bestRev = true;
      }
    }
    const chosen = remaining.splice(best, 1)[0];
    if (bestRev) chosen.points.reverse();
    ordered.push(chosen);
    cur = chosen.points[chosen.points.length - 1];
  }
  return { ...frame, paths: ordered };
}

// src/lib/runPipeline.ts
function clipBounds(b) {
  return { left: b.left, right: b.right, up: b.up, down: b.down };
}
function compileFrame(frame, bounds2, opts = {}) {
  const tol = opts.simplifyTol ?? 0.2;
  const skipSimplify = frame.meta?.noSimplify || tol <= 0;
  const opt = optimizeOrder(skipSimplify ? frame : simplifyFrame(frame, tol));
  return compile(opt, { clipBounds: clipBounds(bounds2), arcTol: opts.arcTol });
}
function buildGeneratorFrame(spec, bounds2, paramsOverride) {
  const mod = getModule(spec.key);
  if (!mod) throw new Error(`Unknown generator: "${spec.key}"`);
  let frame = mod.generate(paramsOverride ?? spec.params, { bounds: bounds2 });
  if (spec.warp) {
    const warpMod = getModule("warp");
    if (warpMod) {
      frame = warpMod.generate(
        { mode: spec.warp.mode, ...spec.warp.params },
        { bounds: bounds2, lowerFrame: frame }
      );
    }
  }
  return frame;
}
function expandGenerator(spec, bounds2, opts = {}) {
  return compileFrame(buildGeneratorFrame(spec, bounds2), bounds2, opts);
}
function frameFitsBounds(frame, bounds2, tolMm = 0, ellipse = false) {
  const xMin = -bounds2.left - tolMm, xMax = bounds2.right + tolMm;
  const yMin = -bounds2.up - tolMm, yMax = bounds2.down + tolMm;
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  const rx = (xMax - xMin) / 2, ry = (yMax - yMin) / 2;
  for (const path of frame.paths) {
    for (const p of path.points) {
      if (ellipse) {
        if (rx <= 0 || ry <= 0) return false;
        const nx = (p.x - cx) / rx, ny = (p.y - cy) / ry;
        if (nx * nx + ny * ny > 1) return false;
      } else if (p.x < xMin || p.x > xMax || p.y < yMin || p.y > yMax) {
        return false;
      }
    }
  }
  return true;
}
function expandGeneratorFitted(spec, bounds2, o = {}) {
  const mod = getModule(spec.key);
  if (!mod) throw new Error(`Unknown generator: "${spec.key}"`);
  const hasSeed = mod.sections.some((s) => s.fields.some((f) => f.key === "seed"));
  const tol = o.fitTolMm ?? 0;
  if (!o.fit || !hasSeed) {
    const frame = buildGeneratorFrame(spec, bounds2);
    return {
      queries: compileFrame(frame, bounds2, o),
      fit: frameFitsBounds(frame, bounds2, tol, o.ellipse),
      seed: hasSeed ? Math.round(Number(spec.params.seed ?? 0)) : null,
      attempts: 1,
      hasSeed
    };
  }
  const maxSeeds = Math.max(1, Math.floor(o.maxSeeds ?? 2e3));
  const base = Number.isFinite(o.baseSeed) ? Number(o.baseSeed) : Math.round(Number(spec.params.seed ?? 0));
  let lastFrame = null;
  let lastSeed = base;
  for (let k = 0; k < maxSeeds; k++) {
    const seed = ((base + k) % 1e4 + 1e4) % 1e4;
    const frame = buildGeneratorFrame(spec, bounds2, { ...spec.params, seed });
    if (frameFitsBounds(frame, bounds2, tol, o.ellipse)) {
      return { queries: compileFrame(frame, bounds2, o), fit: true, seed, attempts: k + 1, hasSeed };
    }
    lastFrame = frame;
    lastSeed = seed;
  }
  return {
    queries: compileFrame(lastFrame, bounds2, o),
    fit: false,
    seed: lastSeed,
    attempts: maxSeeds,
    hasSeed
  };
}
function runLayerStack(layers, bounds2, groups = [], image, opts = {}) {
  const frame = evaluate(layers, bounds2, groups, image);
  return compileFrame(frame, bounds2, opts);
}
function boundsFromFirmware(b) {
  return {
    left: -(b.xn ?? 0),
    right: b.xp ?? 0,
    up: -(b.yn ?? 0),
    down: b.yp ?? 0
  };
}

// src/lib/gridScript.ts
var rn = (n) => Math.round(n * 100) / 100;
function firmwareWorkAreaFromPlotter(b) {
  return { xn: -b.left, xp: b.right, yn: -b.up, yp: b.down };
}
function normalizeMetadataWorkArea(wa) {
  const xn = Number(wa.x_min ?? wa.xn);
  const xp = Number(wa.x_max ?? wa.xp);
  let yn = Number(wa.y_min ?? wa.yn);
  let yp = Number(wa.y_max ?? wa.yp);
  if (yn < 0 && yp > 0 && -yn > yp) {
    return { xn, xp, yn: -yp, yp: -yn };
  }
  return { xn, xp, yn, yp };
}
function gridCtxFromPlotterBounds(b, grid) {
  const wa = firmwareWorkAreaFromPlotter(b);
  return {
    cols: grid.cols,
    rows: grid.rows,
    padding_mm: Number(grid.padding_mm ?? 5),
    full_xn: wa.xn,
    full_xp: wa.xp,
    full_yn: wa.yn,
    full_yp: wa.yp
  };
}
function gridCtxFromMetadata(doc) {
  const meta = doc?.metadata;
  if (!meta?.work_area || !meta?.grid) return null;
  const wa = meta.work_area;
  const grid = meta.grid;
  const { xn, xp, yn, yp } = normalizeMetadataWorkArea(wa);
  const cols = Number(grid.cols);
  const rows = Number(grid.rows);
  if (![xn, xp, yn, yp, cols, rows].every(isFinite) || cols < 1 || rows < 1) return null;
  return {
    cols,
    rows,
    padding_mm: Number(grid.padding_mm ?? 5),
    full_xn: xn,
    full_xp: xp,
    full_yn: yn,
    full_yp: yp
  };
}
function computeCell(gc, col, row) {
  if (col >= gc.cols) throw new Error(`grid_select: col ${col} \u2265 cols ${gc.cols}`);
  if (row >= gc.rows) throw new Error(`grid_select: row ${row} \u2265 rows ${gc.rows}`);
  const cellW = (gc.full_xp - gc.full_xn - (gc.cols - 1) * gc.padding_mm) / gc.cols;
  const cellH = (gc.full_yp - gc.full_yn - (gc.rows - 1) * gc.padding_mm) / gc.rows;
  if (cellW <= 0 || cellH <= 0) throw new Error("grid_select: padding_mm too large for this work area");
  const lx = gc.full_xn + col * (cellW + gc.padding_mm);
  const ty = gc.full_yn + row * (cellH + gc.padding_mm);
  const cx = rn(lx + cellW / 2);
  const cy = rn(ty + cellH / 2);
  return {
    cellW: rn(cellW),
    cellH: rn(cellH),
    cx,
    cy,
    boundsQuery: `bounds?xn=${rn(-cellW / 2)}&xp=${rn(cellW / 2)}&yn=${rn(-cellH / 2)}&yp=${rn(cellH / 2)}&shape=0`,
    matrixQuery: `matrix?a=1&b=0&c=0&d=1&tx=${cx}&ty=${cy}`
  };
}
function resolveGridCtx(cmd, ctx) {
  const n = (k) => Number(cmd[k]);
  const hasShape = isFinite(n("cols")) && isFinite(n("rows"));
  if (!ctx) {
    if (!isFinite(n("full_xn"))) return null;
    return {
      cols: hasShape ? n("cols") : 1,
      rows: hasShape ? n("rows") : 1,
      padding_mm: isFinite(n("padding_mm")) ? n("padding_mm") : 5,
      full_xn: n("full_xn"),
      full_xp: n("full_xp"),
      full_yn: n("full_yn"),
      full_yp: n("full_yp")
    };
  }
  return {
    cols: hasShape ? n("cols") : ctx.cols,
    rows: hasShape ? n("rows") : ctx.rows,
    padding_mm: isFinite(n("padding_mm")) ? n("padding_mm") : ctx.padding_mm,
    full_xn: ctx.full_xn,
    full_xp: ctx.full_xp,
    // ← live machine bounds win over inline
    full_yn: ctx.full_yn,
    full_yp: ctx.full_yp
  };
}
function isIdentityMatrix(m, eps = 1e-3) {
  if (!m || typeof m !== "object") return null;
  const o = m;
  const vals = [o.a, o.b, o.c, o.d, o.tx, o.ty].map(Number);
  if (!vals.every(isFinite)) return null;
  const [a, b, c, d, tx, ty] = vals;
  return Math.abs(a - 1) < eps && Math.abs(b) < eps && Math.abs(c) < eps && Math.abs(d - 1) < eps && Math.abs(tx) < eps && Math.abs(ty) < eps;
}
function gridClearQueries(gc) {
  return {
    boundsQuery: `bounds?xn=${gc.full_xn}&xp=${gc.full_xp}&yn=${gc.full_yn}&yp=${gc.full_yp}&shape=0`,
    matrixQuery: "matrix?a=1&b=0&c=0&d=1&tx=0&ty=0"
  };
}
function hydrateGridCommands(commands, gc) {
  if (!gc) return commands;
  return commands.map((cmd) => {
    if (cmd.type === "grid_select") {
      return {
        ...gc,
        ...cmd,
        type: "grid_select"
      };
    }
    if (cmd.type === "grid_clear" && !isFinite(Number(cmd.full_xn))) {
      return {
        ...gc,
        ...cmd,
        full_xn: gc.full_xn,
        full_xp: gc.full_xp,
        full_yn: gc.full_yn,
        full_yp: gc.full_yp,
        type: "grid_clear"
      };
    }
    return cmd;
  });
}

// src/lib/mcp-core.ts
function listGenerators() {
  return listModules("make").map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description ?? "",
    paramKeys: m.sections.flatMap((s) => s.fields.map((f) => f.key))
  }));
}
function pathsToFrame(paths, bounds2) {
  return {
    widthMm: bounds2.left + bounds2.right,
    heightMm: bounds2.up + bounds2.down,
    paths: paths.map((p) => {
      const path = { points: p.points };
      if (p.closed !== void 0) path.closed = p.closed;
      if (p.cycles !== void 0) path.cycles = p.cycles;
      return path;
    })
  };
}
function compilePaths(paths, bounds2, opts = {}) {
  return compileFrame(pathsToFrame(paths, bounds2), bounds2, opts);
}
function compilePathsWithWarp(paths, bounds2, warp, opts = {}) {
  let frame = pathsToFrame(paths, bounds2);
  if (warp && warp.mode !== "none") {
    const warpMod = getModule("warp");
    if (warpMod) {
      frame = warpMod.generate(
        { mode: warp.mode, ...warp.params },
        { bounds: bounds2, lowerFrame: frame }
      );
    }
  }
  return compileFrame(frame, bounds2, opts);
}
export {
  boundsFromFirmware,
  compile,
  compileFrame,
  compilePaths,
  compilePathsWithWarp,
  computeCell,
  defaultsOf,
  expandGenerator,
  expandGeneratorFitted,
  firmwareWorkAreaFromPlotter,
  frameFitsBounds,
  getModule,
  gridClearQueries,
  gridCtxFromMetadata,
  gridCtxFromPlotterBounds,
  hydrateGridCommands,
  isIdentityMatrix,
  listGenerators,
  listModules,
  normalizeMetadataWorkArea,
  resolveGridCtx,
  runLayerStack
};
