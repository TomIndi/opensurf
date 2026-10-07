// The 2D skybox: a camera-centred cube drawn first (no depth test/write), sampling a cube map built from the
// map's six sky faces (see skymath.ts for Source's face orientations), or a procedural sky (gradient, sun,
// soft clouds, stars at night) for skies the map doesn't pack. Also derives the sun direction and the
// synthetic lighting used by maps without lightmaps.
import { BackSide, BoxGeometry, GLSL3, Mesh, ShaderMaterial, Vector3, Vector4 } from 'three';
import { angleVectors } from '../core/angles';
import type { Vec3 } from '../core/vec3';
import { isProceduralImage, stockSkyPalette } from '../bsp/materials';
import type { FogDef, LoadedMap, SkyDef } from '../map/types';
import { SKY_FRAGMENT, SKY_VERTEX } from './shaders';
import { buildGlCubeFaces, findSkySun, skyBandColor } from './skymath';
import type { TextureCache } from './textures';
import { SharedUniforms, U, srgbToLinearVec } from './worldmaterials';

export type SkyKind = 'night' | 'dusk' | 'overcast' | 'desert' | 'day';

/** Sky mood from a sky name (stock CS:S/HL2 names and built-in map names). */
export function skyKind(name: string): SkyKind {
  const n = (name ?? '').toLowerCase();
  if (/night|borealis|black|dark|space|star|nebula|moon|midnight|neon/.test(n)) return 'night';
  if (/dusk|sunset|sunrise|evening|twilight|dawn|sundown|day01_06|day01_08|day02_09/.test(n)) return 'dusk';
  if (/overcast|cloudy|c17|rain|storm|fog|mist|grey|gray|militia|cobble|nuke|day02|tides|train/.test(n)) return 'overcast';
  if (/dust|desert|sand|wasteland|aztec|dune|mirage|inferno/.test(n)) return 'desert';
  return 'day';
}

export interface ProceduralSkyParams {
  zenith: [number, number, number];
  horizon: [number, number, number];
  ground: [number, number, number];
  /** Linear sun (or moon) colour. */
  sunColor: [number, number, number];
  /** Default sun elevation (degrees) and yaw when the map has no light_environment. */
  sunElevation: number;
  sunYaw: number;
  /** cos(angular radius) of the sun disc. */
  sunDisc: number;
  cloudCover: number;
  cloudColor: [number, number, number];
  stars: number;
}

/** Parameters of the procedural sky for a sky name (palette shared with the materials' stand-in skies). */
export function proceduralSkyParams(name: string): ProceduralSkyParams {
  const pal = stockSkyPalette(name);
  const kind = skyKind(name);
  const base = { zenith: pal.zenith, horizon: pal.horizon, ground: pal.ground };
  switch (kind) {
    case 'night':
      return {
        ...base,
        zenith: [0.012, 0.016, 0.05],
        horizon: [0.06, 0.07, 0.16],
        ground: [0.02, 0.02, 0.035],
        sunColor: [0.35, 0.42, 0.6],
        sunElevation: 38,
        sunYaw: 210,
        sunDisc: 0.99996,
        cloudCover: 0.22,
        cloudColor: [0.09, 0.1, 0.16],
        stars: 1,
      };
    case 'dusk':
      return { ...base, sunColor: [1.4, 0.72, 0.38], sunElevation: 7, sunYaw: 200, sunDisc: 0.99992, cloudCover: 0.42, cloudColor: [0.95, 0.62, 0.5], stars: 0.15 };
    case 'overcast':
      return { ...base, sunColor: [0.35, 0.35, 0.36], sunElevation: 50, sunYaw: 120, sunDisc: 1.1, cloudCover: 0.92, cloudColor: [0.78, 0.8, 0.83], stars: 0 };
    case 'desert':
      return { ...base, sunColor: [1.25, 1.1, 0.88], sunElevation: 52, sunYaw: 135, sunDisc: 0.99993, cloudCover: 0.18, cloudColor: [1, 0.98, 0.95], stars: 0 };
    default:
      return { ...base, sunColor: [1.2, 1.12, 1.0], sunElevation: 48, sunYaw: 135, sunDisc: 0.99993, cloudCover: 0.42, cloudColor: [1, 1, 1], stars: 0 };
  }
}

/**
 * Direction toward the sun from the map's light_environment: its yaw is the direction the sunlight travels
 * and its pitch (the "pitch" key, negative = downward) the light's downward angle, so the sun sits opposite
 * at elevation -pitch. Null without a light_environment.
 */
export function lightEnvSunDir(map: LoadedMap): Vec3 | null {
  const le = map.entities?.find((e) => e.classname?.toLowerCase() === 'light_environment');
  if (!le) return null;
  const pitch = Number.isFinite(le.angles?.pitch) ? le.angles.pitch : -45;
  const yaw = Number.isFinite(le.angles?.yaw) ? le.angles.yaw : 0;
  const travel = { x: 0, y: 0, z: 0 };
  angleVectors({ pitch: -pitch, yaw, roll: 0 }, travel);
  const d = { x: -travel.x, y: -travel.y, z: -travel.z };
  if (d.z < -0.2) d.z = -d.z; // a sun below the horizon would only confuse the sky/water: mirror it up
  const l = Math.hypot(d.x, d.y, d.z) || 1;
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

/** light_environment colours (linear), or null. */
export function lightEnvColors(map: LoadedMap): { sun: [number, number, number]; ambient: [number, number, number] } | null {
  const le = map.entities?.find((e) => e.classname?.toLowerCase() === 'light_environment');
  if (!le) return null;
  const parse = (s: string | undefined, def: number[]): [number, number, number] => {
    const p = (s ?? '').trim().split(/\s+/).map(Number);
    const ok = p.length >= 3 && p.slice(0, 3).every((x) => Number.isFinite(x));
    const c = ok ? p : def;
    const k = ok && p.length >= 4 && Number.isFinite(p[3]) ? Math.min(2, Math.max(0.2, p[3] / 300)) : 1;
    return [Math.pow(c[0] / 255, 2.2) * k, Math.pow(c[1] / 255, 2.2) * k, Math.pow(c[2] / 255, 2.2) * k];
  };
  return { sun: parse(le.kv._light, [255, 255, 255, 200]), ambient: parse(le.kv._ambient, [128, 128, 128, 100]) };
}

/** The skybox mesh + the sky-related shared uniforms. */
export class SkyBox {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  procedural = true;
  name = '';

  constructor(private readonly shared: SharedUniforms) {
    const geo = new BoxGeometry(2, 2, 2);
    this.material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        uSkyBrightness: { value: 1 },
        uSkyFog: { value: new Vector4(0, 0, 0, 0) },
        skyCube: shared.skyCube,
        uSkyProcedural: shared.uSkyProcedural,
        uSkyZenith: shared.uSkyZenith,
        uSkyHorizon: shared.uSkyHorizon,
        uSkyGround: shared.uSkyGround,
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uSunDisc: shared.uSunDisc,
        uCloudCover: shared.uCloudCover,
        uCloudColor: shared.uCloudColor,
        uStars: shared.uStars,
        uHazeColor: shared.uHazeColor,
        uHaze: shared.uHaze,
        uTime: shared.uTime,
      },
      side: BackSide,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'skybox';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  get brightness(): U<number> {
    return this.material.uniforms.uSkyBrightness as U<number>;
  }

  /** Fades the sky to a colour (linear rgb, amount 0..1): the view from inside a water volume. */
  setOverlayFog(rgb: Vector3 | null, amount: number): void {
    const v = (this.material.uniforms.uSkyFog as U<Vector4>).value;
    if (rgb) v.set(rgb.x, rgb.y, rgb.z, Math.max(0, Math.min(1, amount)));
    else v.w = 0;
  }

  /**
   * Sets up the sky for a map: cube map from real sky faces, else the procedural sky. Also fills the sun /
   * ambient uniforms (used by water glints, envmap fallbacks and maps without lightmaps).
   */
  setMap(map: LoadedMap, textures: TextureCache): void {
    const sky: SkyDef = map.render?.sky ?? { name: '', faces: null };
    const s = this.shared;
    this.name = sky.name ?? '';
    const faces = sky.faces;
    const real = !!faces && !isProceduralImage(faces.up) && !isProceduralImage(faces.rt);
    const params = proceduralSkyParams(sky.name || map.name);
    let sun: Vec3 | null = lightEnvSunDir(map);
    if (real && faces) {
      const cube = buildGlCubeFaces(faces);
      s.skyCube.value = textures.cube(cube.data, cube.size, true);
      s.uSkyProcedural.value = 0;
      this.procedural = false;
      if (!sun) sun = findSkySun(faces);
      // colours for water / envmap fallbacks and ambient: averaged from the real sky
      const hor = skyBandColor(faces, 0.0, 0.25);
      const zen = skyBandColor(faces, 0.6, 1.0);
      const gnd = skyBandColor(faces, -1.0, -0.4);
      srgbToLinearVec(zen, s.uSkyZenith.value);
      srgbToLinearVec(hor, s.uSkyHorizon.value);
      srgbToLinearVec(gnd, s.uSkyGround.value);
    } else {
      s.skyCube.value = null;
      s.uSkyProcedural.value = 1;
      this.procedural = true;
      srgbToLinearVec(params.zenith, s.uSkyZenith.value);
      srgbToLinearVec(params.horizon, s.uSkyHorizon.value);
      srgbToLinearVec(params.ground, s.uSkyGround.value);
    }
    if (!sun) {
      const e = (params.sunElevation * Math.PI) / 180;
      const y = (params.sunYaw * Math.PI) / 180;
      sun = { x: Math.cos(e) * Math.cos(y), y: Math.cos(e) * Math.sin(y), z: Math.sin(e) };
    }
    s.uSunDir.value.set(sun.x, sun.y, sun.z).normalize();
    s.uSunColor.value.set(params.sunColor[0], params.sunColor[1], params.sunColor[2]);
    s.uSunDisc.value = params.sunDisc;
    s.uCloudCover.value = params.cloudCover;
    srgbToLinearVec(params.cloudColor, s.uCloudColor.value);
    s.uStars.value = params.stars;
    this.setFog(map.render?.fog ?? null, true);
    this.setAmbient(map, params);
  }

  /** The procedural sky's horizon haze follows the map fog so geometry fades into the sky. */
  setFog(fog: FogDef | null, enabled: boolean): void {
    const s = this.shared;
    if (fog && fog.enabled && enabled && this.procedural) {
      srgbToLinearVec(fog.color, s.uHazeColor.value);
      s.uHaze.value = Math.min(0.85, Math.max(0.25, fog.maxDensity));
    } else {
      s.uHaze.value = 0;
    }
  }

  private setAmbient(map: LoadedMap, params: ProceduralSkyParams): void {
    const s = this.shared;
    const kind = skyKind(map.render?.sky?.name || map.name);
    const le = lightEnvColors(map);
    const zen = s.uSkyZenith.value;
    const hor = s.uSkyHorizon.value;
    const gnd = s.uSkyGround.value;
    // Synthetic lighting for maps without lightmaps: a sky-tinted ambient that keeps faces readable.
    const amb = new Vector3().copy(zen).multiplyScalar(0.35).add(new Vector3().copy(hor).multiplyScalar(0.35));
    const lum = amb.x * 0.2126 + amb.y * 0.7152 + amb.z * 0.0722;
    const target = kind === 'night' ? 0.24 : kind === 'dusk' ? 0.36 : 0.42;
    amb.multiplyScalar(target / Math.max(lum, 1e-3));
    s.uAmbSky.value.copy(amb);
    s.uAmbGround.value.copy(gnd).multiplyScalar(0.25).add(new Vector3().copy(amb).multiplyScalar(0.45));
    const sunK = kind === 'night' ? 0.4 : kind === 'overcast' ? 0.3 : 0.55;
    const sc = le ? le.sun : params.sunColor;
    s.uSunLight.value.set(sc[0], sc[1], sc[2]).multiplyScalar(sunK);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
