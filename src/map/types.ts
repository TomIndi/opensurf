// The unified in-memory map representation. Both the BSP loader (real surf maps) and the
// built-in map generator produce a LoadedMap; the game, renderer and physics only consume this.
import { QAngle } from '../core/angles';
import { Vec3 } from '../core/vec3';
import type { CollisionWorld } from '../physics/collision';
import { Brush } from '../physics/types';

// ---------------------------------------------------------------- entities

/** One entity I/O connection, e.g. OnStartTouch -> "!activator,AddOutput,basevelocity 0 0 800,0,-1". */
export interface EntityOutput {
  /** Output name, lower-case (e.g. "onstarttouch", "ontrigger", "onendtouch"). */
  event: string;
  /** Target entity name or special name (!activator, !self, !player, !caller), as written. */
  target: string;
  /** Input name as written (case preserved), e.g. "AddOutput". */
  input: string;
  param: string;
  /** Delay in seconds. */
  delay: number;
  /** -1 = unlimited. */
  timesToFire: number;
}

export interface MapEntity {
  /** Index in the entity lump. */
  index: number;
  classname: string;
  targetname: string;
  /** Keyvalues with lower-case keys (last occurrence wins). Outputs are NOT stored here. */
  kv: Record<string, string>;
  outputs: EntityOutput[];
  origin: Vec3;
  angles: QAngle;
  /** Brush model index when kv.model is "*N", otherwise -1. */
  model: number;
}

// ---------------------------------------------------------------- rendering data

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA8, sRGB-encoded color, straight alpha. Level 0 only; the renderer generates mips. */
  data: Uint8Array;
  hasAlpha: boolean;
  /**
   * Optional (materials built with `compressedTextures`): the texture's original DXT mip chain, for renderers
   * with S3TC support (WEBGL_compressed_texture_s3tc[_srgb]). When present, `data`/`width`/`height` may be a
   * reduced-size RGBA fallback of the same texture.
   */
  compressed?: CompressedImage;
}

/** Block-compressed texture data as stored in the VTF (sRGB colour). */
export interface CompressedImage {
  /** 'dxt1' = BC1 (decode as RGBA: 3-colour blocks punch through like Direct3D), 'dxt3' = BC2, 'dxt5' = BC3. */
  format: 'dxt1' | 'dxt3' | 'dxt5';
  width: number;
  height: number;
  /** Mip levels, largest first, as stored (the chain may stop before 1x1). */
  mips: { width: number; height: number; data: Uint8Array }[];
}

export interface MaterialDef {
  /** Normalized material name: lower-case, forward slashes, no "materials/" prefix, no ".vmt". */
  name: string;
  /** VMT shader name lower-cased ("lightmappedgeneric", "unlitgeneric", "water", ...) or "" if unknown. */
  shader: string;
  /** Decoded base texture, or null when the texture isn't available (not packed in the map). */
  image: DecodedImage | null;
  /** sRGB 0..1 color to use when `image` is null (from texdata reflectivity / material name heuristics). */
  fallbackColor: [number, number, number];
  /** Texture size from texdata (used to normalize texture coordinates). */
  width: number;
  height: number;
  translucent: boolean;
  additive: boolean;
  alphaTest: boolean;
  alphaTestRef: number;
  /** $alpha multiplier (1 = opaque). */
  alpha: number;
  noCull: boolean;
  /** Unlit / self-illuminated: ignore lightmaps. */
  unlit: boolean;
  isWater: boolean;
  /** Water fog color (sRGB 0..1) for water materials. */
  waterFogColor: [number, number, number] | null;
  isSky: boolean;
  /** Tool textures (clip, trigger, nodraw, skip, hint...). Never rendered. */
  isTool: boolean;
  /** Texture scroll proxy rate in texture units per second, if any. */
  scroll: [number, number] | null;
  /** For built-in maps: optional procedural pattern id understood by the renderer (e.g. "grid"). */
  pattern?: string;
  /**
   * Optional ($basetexturetransform): UV transform as a 2x3 matrix [a, b, c, d, e, f] applied to the normalized
   * texture coordinates before `scroll`: u' = a·u + b·v + c, v' = d·u + e·v + f.
   */
  textureTransform?: [number, number, number, number, number, number];
  /** Optional (AnimatedTexture proxy on $basetexture): every frame (frames[0] === image) and frames per second. */
  frames?: DecodedImage[];
  frameRate?: number;
  /**
   * Optional (WorldVertexTransition, $basetexture2): second texture blended on displacements by
   * RenderBatch.alphas (alpha 0 = image, 1 = image2), its sRGB fallback colour and its own UV transform.
   */
  image2?: DecodedImage | null;
  fallbackColor2?: [number, number, number];
  textureTransform2?: [number, number, number, number, number, number];
  /** Optional ($detail): detail texture tiled `scale` times per base texture repeat. */
  detail?: MaterialDetail;
  /** Optional ($envmap): specular cubemap reflection parameters. */
  envmap?: MaterialEnvmap;
  /** Optional (water $fogstart / $fogend): distances in units over which the water fog builds up. */
  waterFogRange?: [number, number];
}

/**
 * Cubemap reflection ($envmap). Final reflection ≈ cubemap(reflect(view, normal)) · tint · mask, with
 * $envmapcontrast (0 = linear, 1 = squared) and $envmapsaturation (1 = full colour) applied to the sample.
 */
export interface MaterialEnvmap {
  /**
   * "env_cubemap" (use the nearest MapRenderData.cubemaps entry) or a baked cubemap texture name such as
   * "maps/<map>/c0_0_0" (vbsp patches every material instance with its nearest cubemap).
   */
  cubemap: string;
  /** $envmaptint (default [1, 1, 1]). */
  tint: [number, number, number];
  /** Reflection mask: base texture alpha, normal map alpha, a separate $envmapmask texture, or none. */
  mask: 'none' | 'basealpha' | 'normalalpha' | 'texture';
  /** For mask 'texture' (and 'normalalpha' when the normal map is packed): the mask, in the red channel. */
  maskImage?: DecodedImage | null;
  contrast: number;
  saturation: number;
  /** $fresnelreflection: 1 = no fresnel falloff, 0 = full fresnel. */
  fresnel: number;
}

/** A baked env_cubemap (LUMP_CUBEMAPS sample + its texture from the pakfile). */
export interface CubemapDef {
  origin: Vec3;
  /** Requested size (0 = default). */
  size: number;
  /** Texture name "maps/<map>/c<x>_<y>_<z>". */
  texture: string;
  /** Faces in VTF order: rt, lf, bk, ft, up, dn (null when the cubemap isn't packed). */
  faces: DecodedImage[] | null;
}

/**
 * Detail texture ($detail). blendMode follows $detailblendmode: 0 = mod2x (base · detail · 2, the common case),
 * 1 = additive, 2 = alpha-blended over the base, others as in Source. blendFactor lerps the effect (0 = none).
 */
export interface MaterialDetail {
  image: DecodedImage;
  scale: [number, number];
  blendFactor: number;
  blendMode: number;
}

/** A batch of triangles sharing one material and one brush model. */
export interface RenderBatch {
  /** Brush model index (0 = world). Brush entities can be hidden/shown/alpha'd at runtime per model. */
  model: number;
  /** Key into MapRenderData.materials. */
  material: string;
  positions: Float32Array; // xyz
  normals: Float32Array; // xyz
  /** Texture coordinates, already divided by the texture width/height (repeat-wrapped). */
  uvs: Float32Array;
  /** Lightmap atlas coordinates in 0..1, or null if the batch is not lightmapped. */
  lightmapUVs: Float32Array | null;
  /** Optional per-vertex 0..1 alpha (displacement blend factor). */
  alphas: Float32Array | null;
  indices: Uint32Array;
  /** OR of the texinfo SURF_* flags of the faces in this batch. */
  surfFlags: number;
  /** BSP area the faces belong to (for 3D skybox separation); -1 if unknown. */
  area: number;
  isDisplacement: boolean;
  mins: Vec3;
  maxs: Vec3;
}

export interface LightmapAtlas {
  width: number;
  height: number;
  /** RGBA float32 linear light (A = 1). Value 1.0 = "fully lit" (multiply albedo by this). */
  data: Float32Array;
}

export interface SkyDef {
  /** worldspawn skyname, e.g. "sky_dustbowl_01". */
  name: string;
  /** Six decoded faces when available (from the pakfile), keyed by Source suffix. */
  faces: { rt: DecodedImage; lf: DecodedImage; bk: DecodedImage; ft: DecodedImage; up: DecodedImage; dn: DecodedImage } | null;
}

export interface FogDef {
  enabled: boolean;
  /** sRGB 0..1 */
  color: [number, number, number];
  start: number;
  end: number;
  maxDensity: number;
}

export interface Sky3D {
  /** sky_camera origin. */
  origin: Vec3;
  /** sky_camera scale (usually 16). */
  scale: number;
  /** BSP area containing the sky_camera; batches with this area form the 3D skybox. */
  area: number;
  fog: FogDef | null;
}

export interface MapRenderData {
  batches: RenderBatch[];
  /** Null for maps without baked lighting (built-in maps): the renderer then uses its own shading. */
  lightmap: LightmapAtlas | null;
  materials: Map<string, MaterialDef>;
  sky: SkyDef;
  sky3d: Sky3D | null;
  fog: FogDef | null;
  /** Static props, when the map packs the models (optional, may be empty). */
  props?: RenderProp[];
  /** Optional: baked env_cubemaps for $envmap reflections (see MaterialEnvmap). */
  cubemaps?: CubemapDef[];
}

export interface RenderProp {
  model: string;
  origin: Vec3;
  angles: QAngle;
  /** Triangles in model space, already decoded. */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  material: string;
}

// ---------------------------------------------------------------- zones / timer

export type ZoneType =
  | 'start'
  | 'end'
  | 'stage'
  | 'checkpoint'
  | 'stop'
  | 'speedstart'
  | 'teletostart'
  | 'validator'
  | 'checker'
  | 'antijump'
  | 'antiduck'
  | 'maxspeed';

export interface ZoneDef {
  type: ZoneType;
  /** 0 = main course, N >= 1 = bonus N. */
  group: number;
  /** Stage number for 'stage' zones (2..N: stage 1 begins at the start zone); checkpoint number for 'checkpoint'. */
  index: number;
  mins: Vec3;
  maxs: Vec3;
  /** Prespeed cap when leaving a start zone (u/s). 0 = no cap. */
  prespeed?: number;
  /** Optional teleport destination when (re)starting at this zone (stage/bonus restarts). */
  spawn?: { origin: Vec3; angles: QAngle };
}

export type ZoneSource = 'user' | 'preset' | 'momentum' | 'builtin' | 'heuristic' | 'none';

// ---------------------------------------------------------------- the loaded map

export interface BrushModelInfo {
  /** Model index (0 = world). */
  index: number;
  mins: Vec3;
  maxs: Vec3;
  origin: Vec3;
  /** Brushes belonging to this model (all contents, including trigger brushes). */
  brushes: Brush[];
}

export interface SpawnPoint {
  origin: Vec3;
  angles: QAngle;
}

export interface LoadedMap {
  /** Map name without extension, e.g. "surf_utopia_njv". */
  name: string;
  source: 'bsp' | 'builtin';
  /** BSP version (19/20/21) for real maps. */
  version?: number;
  entities: MapEntity[];
  /** Index = brush model number. */
  models: BrushModelInfo[];
  /** World + solid brush entities. Triggers are NOT in here (see game/entities). */
  collision: CollisionWorld;
  render: MapRenderData;
  spawns: SpawnPoint[];
  /** Zones shipped with the map (built-in maps, Momentum trigger entities). The game merges presets/user zones. */
  zones: ZoneDef[];
  zoneSource: ZoneSource;
  worldMins: Vec3;
  worldMaxs: Vec3;
  /** Non-fatal problems found while loading (shown in the console). */
  warnings: string[];
}
