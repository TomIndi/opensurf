# Contract changes log

Additive changes to shared contract files. Format: `- [owner] file: change — reason`.
- [bsp-core] src/bsp/types.ts: added optional `BspFile.facesLump?: number` (LUMP_FACES or LUMP_FACES_HDR) — HDR-only maps have no LDR face lump; their faces' lightOfs then index `lightingHDR`, and the renderer needs to know which.
- [bsp-core] src/bsp/types.ts: added optional `BspFile.warnings?: string[]` — parse/validation problems (bad lump sizes, out-of-range indices, untested versions) for the loader to surface in `LoadedMap.warnings`.
- [materials] src/map/types.ts: added optional `MaterialDef.textureTransform`, `frames`/`frameRate`, `image2`/`fallbackColor2`/`textureTransform2`, `detail` (+ new `MaterialDetail` interface) — needed for in-game fidelity: $basetexturetransform scaling, AnimatedTexture proxies, WorldVertexTransition displacement blends ($basetexture2 by RenderBatch.alphas) and $detail textures. All optional; renderers that ignore them still get a correct base image.
