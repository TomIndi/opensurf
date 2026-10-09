// Stencil roles of the scene framebuffer: which samples still show the sky after the opaque world.
//
// When the sky is expensive (a 3D skybox, or the procedural 2D sky) it is drawn after the opaque world and only
// where the world left the sky showing, like Source draws its skybox after the world: the stencil is cleared to
// STENCIL_SKY every frame, sky faces (depth-only masks) write STENCIL_SKY where they are the nearest surface, every
// other surface of the main view writes 0 where it passes the depth test, and the sky draws only on STENCIL_SKY
// samples. GPUs reject the covered samples before shading (early stencil), so the 3D skybox's layers of
// alpha-tested surfaces, or the procedural sky's clouds, cost only the pixels where the sky is actually seen.
// A cube-map 2D sky is drawn first without a stencil (see renderer.ts): materials keep their role, with the
// stencil test turned off (enableStencilRole).
import {
  AlwaysStencilFunc,
  EqualStencilFunc,
  GreaterEqualDepth,
  KeepStencilOp,
  type Material,
  ReplaceStencilOp,
} from 'three';

/** Stencil value of samples that show the sky (the per-frame clear value). */
export const STENCIL_SKY = 1;

export type StencilRole = 'occluder' | 'skyMask' | 'skyOnly';

/** Sets a material's stencil state for its role (idempotent; cheap: state only, no recompile). */
export function setStencilRole(m: Material, role: StencilRole): Material {
  m.stencilWrite = true; // three.js: enables the stencil test for this material
  m.stencilFuncMask = 0xff;
  m.stencilFail = KeepStencilOp;
  m.stencilZFail = KeepStencilOp;
  if (role === 'skyOnly') {
    m.stencilFunc = EqualStencilFunc;
    m.stencilRef = STENCIL_SKY;
    m.stencilWriteMask = 0;
    m.stencilZPass = KeepStencilOp;
  } else {
    m.stencilFunc = AlwaysStencilFunc;
    m.stencilRef = role === 'skyMask' ? STENCIL_SKY : 0;
    m.stencilWriteMask = 0xff;
    m.stencilZPass = ReplaceStencilOp;
  }
  m.userData.stencilRole = role;
  return m;
}

/**
 * Turns a role's stencil test on or off (the scene target has a stencil or not); materials without a role keep
 * theirs off. State only: no recompile.
 */
export function enableStencilRole(m: Material, on: boolean): void {
  if (m.userData.stencilRole !== undefined) m.stencilWrite = on;
}

/** The role a material was given (undefined = none yet). */
export function stencilRole(m: Material): StencilRole | undefined {
  return m.userData.stencilRole as StencilRole | undefined;
}

/**
 * Depth function for a full-screen quad at the far plane that must pass everywhere (it resets the depth of sky
 * samples to the cleared value): "greater or equal" toward the far plane in both depth modes. With a reversed
 * depth buffer three.js turns it into LEQUAL (far = 0, so 0 <= anything); with the standard one it stays GEQUAL
 * (far = 1). Not AlwaysDepth: three r186 maps that to NEVER under reversed depth.
 */
export const FAR_QUAD_DEPTH_FUNC = GreaterEqualDepth;
