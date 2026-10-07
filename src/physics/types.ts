// Collision contracts shared by the collision world, movement code, BSP loader and built-in maps.
// Geometry is Source-style convex brushes: each brush is the intersection of half-spaces
// { p : dot(p, side.plane.normal) <= side.plane.dist }.
import { Vec3, v3 } from '../core/vec3';

// ---- brush contents (bspflags.h values, so BSP brush contents can be used verbatim) ----
export const CONTENTS_EMPTY = 0;
export const CONTENTS_SOLID = 0x1;
export const CONTENTS_WINDOW = 0x2;
export const CONTENTS_AUX = 0x4;
export const CONTENTS_GRATE = 0x8;
export const CONTENTS_SLIME = 0x10;
export const CONTENTS_WATER = 0x20;
export const CONTENTS_BLOCKLOS = 0x40;
export const CONTENTS_OPAQUE = 0x80;
export const CONTENTS_TESTFOGVOLUME = 0x100;
export const CONTENTS_TEAM1 = 0x800;
export const CONTENTS_TEAM2 = 0x1000;
export const CONTENTS_IGNORE_NODRAW_OPAQUE = 0x2000;
export const CONTENTS_MOVEABLE = 0x4000;
export const CONTENTS_AREAPORTAL = 0x8000;
export const CONTENTS_PLAYERCLIP = 0x10000;
export const CONTENTS_MONSTERCLIP = 0x20000;
export const CONTENTS_CURRENT_0 = 0x40000;
export const CONTENTS_ORIGIN = 0x1000000;
export const CONTENTS_MONSTER = 0x2000000;
export const CONTENTS_DEBRIS = 0x4000000;
export const CONTENTS_DETAIL = 0x8000000;
export const CONTENTS_TRANSLUCENT = 0x10000000;
export const CONTENTS_LADDER = 0x20000000;
export const CONTENTS_HITBOX = 0x40000000;
/** Not a real BSP flag: used by this project to mark trigger volumes (never in collision masks). */
export const CONTENTS_TRIGGER_INTERNAL = 0x80000000 | 0;

export const MASK_ALL = 0xffffffff | 0;
export const MASK_SOLID = CONTENTS_SOLID | CONTENTS_MOVEABLE | CONTENTS_WINDOW | CONTENTS_MONSTER | CONTENTS_GRATE;
/** What the player movement collides with (MASK_PLAYERSOLID). */
export const MASK_PLAYERSOLID =
  CONTENTS_SOLID | CONTENTS_MOVEABLE | CONTENTS_PLAYERCLIP | CONTENTS_WINDOW | CONTENTS_MONSTER | CONTENTS_GRATE;
export const MASK_WATER = CONTENTS_WATER | CONTENTS_MOVEABLE | CONTENTS_SLIME;

/** Source's DIST_EPSILON used when clipping traces against brush planes. */
export const DIST_EPSILON = 0.03125;

export interface Plane {
  normal: Vec3;
  dist: number;
}

export interface BrushSide {
  plane: Plane;
  /** Bevel planes are only used for box traces, never for point/ray traces. */
  bevel: boolean;
}

export interface Brush {
  sides: BrushSide[];
  contents: number;
  /** Tight AABB of the brush volume (computed from its windings). */
  mins: Vec3;
  maxs: Vec3;
  /** Owning brush model index: 0 = world, N = "*N" brush entity model. */
  model: number;
}

export interface TraceResult {
  /** 0..1 fraction of the move completed before the hit (1 = no hit). */
  fraction: number;
  endpos: Vec3;
  /** The plane that was hit (valid when fraction < 1). */
  plane: Plane;
  /** The trace started inside a solid. */
  startsolid: boolean;
  /** The trace never left the solid. */
  allsolid: boolean;
  /** Contents of the brush that was hit (0 if none). */
  contents: number;
  /** Brush model index of the hit brush, or -1 if nothing was hit. */
  model: number;
}

export function newTrace(): TraceResult {
  return {
    fraction: 1,
    endpos: v3(),
    plane: { normal: v3(), dist: 0 },
    startsolid: false,
    allsolid: false,
    contents: 0,
    model: -1,
  };
}

/** The read-only collision interface the movement code depends on. */
export interface TraceWorld {
  /**
   * Sweeps the axis-aligned box [mins, maxs] (relative to the origin) from start to end and returns the
   * first collision against brushes whose contents intersect `mask`.
   */
  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number, out?: TraceResult): TraceResult;
  /** OR of the contents of all enabled brushes containing the point, filtered by `mask`. */
  pointContents(p: Vec3, mask?: number): number;
}
