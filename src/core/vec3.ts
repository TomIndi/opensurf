// Minimal 3D vector helpers in Source engine convention (Z-up, units = inches).
// All functions write into `out` and return it, so hot paths can avoid allocation.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function v3clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function v3copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function v3zero(out: Vec3): Vec3 {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  return out;
}

export function v3add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function v3sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function v3scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s (Source's VectorMA). */
export function v3ma(out: Vec3, a: Vec3, s: number, b: Vec3): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function v3lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function v3dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function v3cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function v3lenSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function v3len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** Horizontal (XY) length — the "speed" shown on surf HUDs. */
export function v3len2d(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function v3dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalizes `a` into `out` and returns the ORIGINAL length (like Source's VectorNormalize). */
export function v3normalize(out: Vec3, a: Vec3): number {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (len > 0) {
    const inv = 1 / len;
    out.x = a.x * inv;
    out.y = a.y * inv;
    out.z = a.z * inv;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return len;
}

export function v3eq(a: Vec3, b: Vec3, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
}

export function v3min(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = Math.min(a.x, b.x);
  out.y = Math.min(a.y, b.y);
  out.z = Math.min(a.z, b.z);
  return out;
}

export function v3max(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = Math.max(a.x, b.x);
  out.y = Math.max(a.y, b.y);
  out.z = Math.max(a.z, b.z);
  return out;
}

/** Parses a Source keyvalue vector string like "12 -4.5 100". Missing components are 0. */
export function v3parse(s: string | undefined): Vec3 {
  if (!s) return v3();
  const p = s.trim().split(/\s+/).map(Number);
  return v3(p[0] || 0, p[1] || 0, p[2] || 0);
}

export function v3str(a: Vec3, digits = 2): string {
  return `${a.x.toFixed(digits)} ${a.y.toFixed(digits)} ${a.z.toFixed(digits)}`;
}
