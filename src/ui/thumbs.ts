// Procedural map "thumbnails": deterministic abstract surf-ramp art generated from the map name (no
// screenshots are shipped). The palette is picked from keywords in the name (ice, desert, space, ...).

/** FNV-1a 32-bit hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Palette {
  id: string;
  skyTop: string;
  skyBottom: string;
  glow: string;
  mountain: string;
  rampLight: string;
  rampDark: string;
  rampEdge: string;
  fog: string;
}

const PALETTES: Record<string, (r: () => number) => Palette> = {
  ice: (r) => {
    const h = 190 + r() * 25;
    return pal('ice', h, [h, 55, 22], [h + 10, 60, 72], [h, 90, 92], [h + 5, 35, 38], [h - 5, 40, 92], [h + 10, 45, 58], [0, 0, 100], [h, 50, 85]);
  },
  desert: (r) => {
    const h = 22 + r() * 18;
    return pal('desert', h, [h + 190, 35, 30], [h + 10, 80, 70], [h + 15, 100, 75], [h, 35, 40], [h + 8, 55, 72], [h - 2, 45, 42], [h + 20, 80, 88], [h + 10, 60, 72]);
  },
  space: (r) => {
    const h = 250 + r() * 50;
    return pal('space', h, [h, 55, 6], [h + 20, 60, 22], [h + 40, 90, 60], [h, 35, 12], [h + 150, 90, 62], [h + 20, 60, 28], [h + 150, 100, 75], [h + 10, 50, 18]);
  },
  fire: (r) => {
    const h = 0 + r() * 20;
    return pal('fire', h, [h + 340, 55, 10], [h + 15, 80, 40], [h + 30, 100, 60], [h, 45, 14], [h + 25, 90, 55], [h, 70, 26], [h + 45, 100, 70], [h + 10, 60, 25]);
  },
  forest: (r) => {
    const h = 95 + r() * 50;
    return pal('forest', h, [h + 70, 40, 30], [h + 50, 45, 72], [h - 40, 90, 80], [h, 30, 28], [h, 40, 60], [h + 10, 45, 30], [h - 30, 70, 82], [h + 40, 30, 70]);
  },
  sunset: (r) => {
    const h = 300 + r() * 50;
    return pal('sunset', h, [h - 60, 55, 22], [h + 40, 85, 62], [h + 60, 100, 72], [h - 40, 35, 26], [h - 120, 60, 68], [h - 100, 50, 34], [h + 60, 100, 80], [h + 20, 60, 50]);
  },
  neon: (r) => {
    const h = r() * 360;
    return pal('neon', h, [h + 200, 50, 8], [h + 220, 55, 24], [h, 100, 60], [h + 200, 40, 14], [h, 85, 58], [h + 20, 70, 26], [h, 100, 78], [h + 210, 40, 18]);
  },
  day: (r) => {
    const h = 200 + r() * 20;
    const rh = r() * 360;
    return pal('day', h, [h + 10, 70, 45], [h - 10, 65, 82], [50, 100, 92], [h + 10, 25, 55], [rh, 55, 72], [rh, 45, 44], [rh, 90, 88], [h, 40, 85]);
  },
};

function hsl(c: [number, number, number]): string {
  return `hsl(${((c[0] % 360) + 360) % 360.0} ${c[1]}% ${c[2]}%)`;
}

function pal(id: string, _h: number, ...c: [number, number, number][]): Palette {
  return {
    id,
    skyTop: hsl(c[0]),
    skyBottom: hsl(c[1]),
    glow: hsl(c[2]),
    mountain: hsl(c[3]),
    rampLight: hsl(c[4]),
    rampDark: hsl(c[5]),
    rampEdge: hsl(c[6]),
    fog: hsl(c[7]),
  };
}

const KEYWORDS: [RegExp, string][] = [
  [/ice|snow|frost|winter|christmas|xmas|glacier|cold|arctic|frozen|crystal/, 'ice'],
  [/mesa|desert|egypt|sand|dune|canyon|sahara|pharaoh|savan/, 'desert'],
  [/space|galax|nyx|star|night|lunar|moon|cosm|omnific|astro|nebula|void|orbit|dark|eclipse|abyss/, 'space'],
  [/lava|hell|fire|inferno|magma|volcan|blood|red|ember|demon/, 'fire'],
  [/forest|grass|jungle|green|zen|kitsune|garden|nature|tree|leaf|bamboo|fruit/, 'forest'],
  [/sunset|dusk|summer|beach|tropic|miami|vapor|dawn|sun/, 'sunset'],
  [/neon|cyber|synth|retro|tron|digital|matrix|future|glow|laser/, 'neon'],
];

export function paletteFor(name: string): Palette {
  const n = name.toLowerCase();
  const r = prng(hashString(n));
  for (const [re, id] of KEYWORDS) if (re.test(n)) return PALETTES[id](r);
  const ids = Object.keys(PALETTES);
  const pick = ids[Math.floor(r() * ids.length)];
  return PALETTES[pick](r);
}

let uid = 0;

/** SVG markup (320×180 viewBox) for a map. Trusted output: the name only seeds the PRNG. */
export function mapThumbSvg(name: string): string {
  const seed = hashString(name.toLowerCase());
  const r = prng(seed ^ 0x5bd1e995);
  const p = paletteFor(name);
  const id = `t${(seed % 1e6).toString(36)}${(uid++).toString(36)}`;
  const W = 320;
  const H = 180;
  const horizon = 92 + r() * 22;
  const vx = 90 + r() * 140;
  const vy = horizon - 4;
  const parts: string[] = [];
  parts.push(`<defs>
<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.skyTop}"/><stop offset="1" stop-color="${p.skyBottom}"/></linearGradient>
<radialGradient id="${id}g" cx="${(vx / W).toFixed(3)}" cy="${(horizon / H).toFixed(3)}" r="0.55"><stop offset="0" stop-color="${p.glow}" stop-opacity=".85"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.fog}" stop-opacity=".0"/><stop offset=".35" stop-color="${p.fog}" stop-opacity=".55"/><stop offset="1" stop-color="${p.skyTop}" stop-opacity=".9"/></linearGradient>
<linearGradient id="${id}v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient>
</defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#${id}s)"/>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#${id}g)"/>`);
  if (p.id === 'space' || p.id === 'neon') {
    for (let i = 0; i < 26; i++) {
      const x = r() * W;
      const y = r() * horizon * 0.9;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.4 + r() * 0.9).toFixed(2)}" fill="#fff" opacity="${(0.3 + r() * 0.6).toFixed(2)}"/>`);
    }
  }
  // distant mountains / floating islands silhouette
  let d = `M0 ${horizon + 10}`;
  for (let x = 0; x <= W; x += 20 + r() * 25) d += ` L${x.toFixed(1)} ${(horizon - 6 - r() * 26).toFixed(1)}`;
  d += ` L${W} ${horizon + 10} Z`;
  parts.push(`<path d="${d}" fill="${p.mountain}" opacity=".55"/>`);
  parts.push(`<rect y="${(horizon - 8).toFixed(1)}" width="${W}" height="${(H - horizon + 8).toFixed(1)}" fill="url(#${id}f)"/>`);

  // ramps: triangular prisms running toward the vanishing point
  const count = 2 + Math.floor(r() * 3);
  const ramps: { svg: string; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const nearX = vx + side * (60 + r() * 120) + (r() - 0.5) * 40;
    const nearY = H + 10 + r() * 40;
    const w = 90 + r() * 110;
    const hgt = w * (0.55 + r() * 0.35);
    const skew = (r() - 0.5) * w * 0.25;
    const k = 0.04 + r() * 0.12; // far end scale
    const L = [nearX - w / 2, nearY];
    const R = [nearX + w / 2, nearY];
    const A = [nearX + skew, nearY - hgt];
    const far = (pt: number[]) => [vx + (pt[0] - vx) * k, vy + (pt[1] - vy) * k];
    const L2 = far(L);
    const R2 = far(R);
    const A2 = far(A);
    const poly = (...pts: number[][]) => pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');
    let s = `<polygon points="${poly(L, A, A2, L2)}" fill="${p.rampLight}"/>`;
    s += `<polygon points="${poly(A, R, R2, A2)}" fill="${p.rampDark}"/>`;
    s += `<polyline points="${poly(A, A2)}" stroke="${p.rampEdge}" stroke-width="1.6" opacity=".9" fill="none"/>`;
    if (i === 0 && r() < 0.8) {
      // carving trail along the lit face
      const t0 = 0.25 + r() * 0.2;
      const lerp = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const p0 = lerp(lerp(L, A, 0.55), lerp(L2, A2, 0.55), 0.05);
      const p1 = lerp(lerp(L, A, 0.35), lerp(L2, A2, 0.35), t0);
      const p2 = lerp(lerp(L, A, 0.6), lerp(L2, A2, 0.6), 0.75);
      s += `<path d="M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} Q${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}" stroke="#fff" stroke-width="1.4" stroke-linecap="round" fill="none" opacity=".75"/>`;
    }
    ramps.push({ svg: s, z: w });
  }
  // bigger (visually nearer) ramps last so they overlap the smaller ones
  ramps.sort((a, b) => a.z - b.z);
  for (const rp of ramps) parts.push(rp.svg);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#${id}v)"/>`);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" class="thumb-svg" aria-hidden="true">${parts.join('')}</svg>`;
}

/**
 * KSF's in-game screenshot of a map: ksf.surf has one for almost every KSF map (926 of the catalog's 932). Loaded
 * from KSF on demand, never re-hosted.
 */
export function mapScreenshotUrl(name: string): string {
  return `https://ksf.surf/images/${encodeURIComponent(name.toLowerCase())}.jpg`;
}

/**
 * Fills `el` with a map's picture: the generated art right away, and KSF's real screenshot fading in over it once
 * it has loaded (lazily: only for pictures on screen). Without a screenshot (or offline) the art stays.
 */
export function setMapArt(el: HTMLElement, name: string): void {
  el.innerHTML = mapThumbSvg(name);
  if (typeof document === 'undefined' || !name) return;
  const img = document.createElement('img');
  img.className = 'thumb-shot';
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());
  img.src = mapScreenshotUrl(name);
  el.appendChild(img);
}
