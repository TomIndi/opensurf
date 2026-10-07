import { describe, expect, it } from 'vitest';
import {
  CROSSHAIR_CVARS,
  CROSSHAIR_DEFAULTS,
  type CrosshairCtx,
  crosshairGeometry,
  type CrosshairParams,
  crosshairRgb,
  drawCrosshair,
  exportCrosshairConfig,
  parseCrosshairConfig,
  readCrosshairParams,
} from '../src/ui/crosshair';

const P = (o: Partial<CrosshairParams> = {}): CrosshairParams => ({ ...CROSSHAIR_DEFAULTS, ...o });
const rect = (g: ReturnType<typeof crosshairGeometry>, kind: string) => g.rects.find((r) => r.kind === kind)!;

describe('crosshair geometry (CS:GO classic)', () => {
  it('default config at 1920x1080: 11px bars, 1px thick, distance 5', () => {
    const g = crosshairGeometry(P(), 1920, 1080);
    expect(g.cx).toBe(960);
    expect(g.cy).toBe(540);
    expect(g.barLength).toBe(11); // round(5 * 1080/480 = 11.25)
    expect(g.thickness).toBe(1); // max(1, round(0.5 * 2.25 = 1.125))
    expect(g.distance).toBe(5); // 4 + gap 1
    const l = rect(g, 'left');
    const r = rect(g, 'right');
    const t = rect(g, 'top');
    const b = rect(g, 'bottom');
    // left bar ends 5px left of the centre pixel column
    expect(l).toMatchObject({ x0: 944, x1: 955, y0: 540, y1: 541 });
    expect(r).toMatchObject({ x0: 966, x1: 977, y0: 540, y1: 541 });
    expect(t).toMatchObject({ x0: 960, x1: 961, y0: 524, y1: 535 });
    expect(b).toMatchObject({ x0: 960, x1: 961, y0: 546, y1: 557 });
    // symmetric gap around the 1px centre: 5 empty pixels each side
    expect(960 - l.x1).toBe(5);
    expect(r.x0 - 961).toBe(5);
    expect(g.rects.some((x) => x.kind === 'dot')).toBe(false);
  });

  it('scales size and thickness with screen height (YRES) but not the gap', () => {
    const g720 = crosshairGeometry(P({ size: 2, thickness: 1, gap: -2 }), 1280, 720);
    expect(g720.barLength).toBe(3); // 2 * 1.5
    expect(g720.thickness).toBe(2); // round(1.5) = 2
    expect(g720.distance).toBe(2);
    const g4k = crosshairGeometry(P({ size: 2, thickness: 1, gap: -2 }), 3840, 2160);
    expect(g4k.barLength).toBe(9); // 2 * 4.5
    expect(g4k.thickness).toBe(5); // round(4.5) away from zero
    expect(g4k.distance).toBe(2);
  });

  it('even thickness straddles the centre pixel like Source (t/2 floored)', () => {
    const g = crosshairGeometry(P({ thickness: 1, size: 4, gap: 0 }), 1920, 1080);
    expect(g.thickness).toBe(2);
    const l = rect(g, 'left');
    expect(l.y0).toBe(539);
    expect(l.y1).toBe(541);
    expect(l.x1).toBe(960 - 4 - 1); // cx - dist - t/2
    const r = rect(g, 'right');
    expect(r.x0).toBe(l.x1 + 2 * 4 + 2);
  });

  it('gap -5 closes the cross (bars cross the centre)', () => {
    const g = crosshairGeometry(P({ gap: -5 }), 1920, 1080);
    expect(g.distance).toBe(-1);
    const l = rect(g, 'left');
    const r = rect(g, 'right');
    expect(l.x1).toBeGreaterThan(960); // inner end beyond the centre
    expect(r.x0).toBeLessThan(961);
  });

  it('dot, T style, size 0', () => {
    const g = crosshairGeometry(P({ dot: true, tStyle: true }), 1920, 1080);
    expect(rect(g, 'dot')).toMatchObject({ x0: 960, y0: 540, x1: 961, y1: 541 });
    expect(g.rects.some((r) => r.kind === 'top')).toBe(false);
    const g0 = crosshairGeometry(P({ size: 0, dot: true }), 1920, 1080);
    expect(g0.rects.map((r) => r.kind)).toEqual(['dot']);
  });

  it('outline grows the bounds by its thickness; default styles ignore customisation', () => {
    const g = crosshairGeometry(P({ outline: true, outlineThickness: 2 }), 1920, 1080);
    expect(g.outline).toBe(2);
    expect(g.bounds).toEqual({ x0: 944 - 2, y0: 524 - 2, x1: 977 + 2, y1: 557 + 2 });
    const d = crosshairGeometry(P({ style: 0, size: 10, gap: 5, dot: true, outline: true }), 1920, 1080);
    expect(d.barLength).toBe(11);
    expect(d.distance).toBe(5);
    expect(d.outline).toBe(0);
    expect(d.rects.some((r) => r.kind === 'dot')).toBe(false);
  });

  it('alpha / additive', () => {
    expect(crosshairGeometry(P({ alpha: 255 }), 800, 600).alpha).toBe(1);
    expect(crosshairGeometry(P({ alpha: 400 }), 800, 600).alpha).toBe(1);
    const add = crosshairGeometry(P({ useAlpha: false, alpha: 10 }), 800, 600);
    expect(add.additive).toBe(true);
    expect(add.alpha).toBeCloseTo(200 / 255, 6);
  });

  it('colour presets 0-4 and custom 5', () => {
    expect(crosshairRgb(P({ color: 0 }))).toEqual([250, 50, 50]);
    expect(crosshairRgb(P({ color: 1 }))).toEqual([50, 250, 50]);
    expect(crosshairRgb(P({ color: 2 }))).toEqual([250, 250, 50]);
    expect(crosshairRgb(P({ color: 3 }))).toEqual([50, 50, 250]);
    expect(crosshairRgb(P({ color: 4 }))).toEqual([50, 250, 250]);
    expect(crosshairRgb(P({ color: 5, r: 255, g: 0, b: 300 }))).toEqual([255, 0, 255]);
  });
});

describe('drawCrosshair', () => {
  it('draws outline then fill per rect at the offset origin', () => {
    const calls: string[] = [];
    const ctx: CrosshairCtx = {
      fillStyle: '',
      globalAlpha: 1,
      fillRect(x, y, w, h) {
        calls.push(`${this.fillStyle}@${this.globalAlpha.toFixed(3)} ${x},${y} ${w}x${h}`);
      },
    };
    const g = crosshairGeometry(P({ outline: true, outlineThickness: 1, alpha: 255 }), 1920, 1080);
    drawCrosshair(ctx, g, 900, 500);
    expect(calls.length).toBe(8);
    expect(calls[0]).toBe('#000@1.000 43,39 13x3'); // left bar outline: (944-1-900, 540-1-500), (11+2)x(1+2)
    expect(calls[1]).toBe('rgb(50,250,50)@1.000 44,40 11x1');
    expect(ctx.globalAlpha).toBe(1);
  });

  it('skips degenerate rects', () => {
    let n = 0;
    const ctx: CrosshairCtx = { fillStyle: '', globalAlpha: 1, fillRect: () => n++ };
    drawCrosshair(ctx, { ...crosshairGeometry(P({ outline: false }), 100, 100), rects: [{ x0: 5, y0: 5, x1: 5, y1: 9, kind: 'dot' }] });
    expect(n).toBe(0);
  });
});

describe('crosshair config paste', () => {
  it('parses autoexec lines, quotes, semicolons and comments; last assignment wins', () => {
    const text = `// my crosshair
cl_crosshairsize "2"
cl_crosshairgap -3 // tight
cl_crosshairthickness 0.5; cl_crosshairdot 0; CL_CROSSHAIRCOLOR 5
cl_crosshaircolor_r 255
sensitivity 1.8
bind "f" "noclip"
cl_crosshairsize 2.5
viewmodel_fov 68`;
    const r = parseCrosshairConfig(text);
    expect(r.commands).toEqual([
      'cl_crosshairgap "-3"',
      'cl_crosshairthickness "0.5"',
      'cl_crosshairdot "0"',
      'cl_crosshaircolor "5"',
      'cl_crosshaircolor_r "255"',
      'cl_crosshairsize "2.5"',
    ]);
    expect(r.ignored).toEqual(['sensitivity 1.8', 'bind "f" "noclip"', 'viewmodel_fov 68']);
  });

  it('accepts crosshair and cl_crosshair_* names, rejects non-numeric values', () => {
    const r = parseCrosshairConfig('crosshair 1; cl_crosshair_drawoutline 1; cl_crosshair_outlinethickness .5; cl_crosshairstyle classic; cl_crosshairsize');
    expect(r.commands).toEqual(['crosshair "1"', 'cl_crosshair_drawoutline "1"', 'cl_crosshair_outlinethickness "0.5"']);
    expect(r.ignored).toEqual(['cl_crosshairstyle classic', 'cl_crosshairsize']);
  });

  it('round-trips through export', () => {
    const values: Record<string, string> = { ...CROSSHAIR_CVARS, cl_crosshairsize: '2', cl_crosshairgap: '-3' };
    const exported = exportCrosshairConfig((n) => values[n]);
    const back = parseCrosshairConfig(exported);
    const parsed = Object.fromEntries(back.commands.map((c) => /^(\S+) "(.*)"$/.exec(c)!.slice(1)));
    for (const [k, v] of Object.entries(values)) expect(String(parseFloat(parsed[k]))).toBe(String(parseFloat(v)));
  });

  it('readCrosshairParams falls back to defaults for missing/garbage cvars', () => {
    const p = readCrosshairParams((n) => ({ cl_crosshairsize: 'abc', cl_crosshairgap: '-2', crosshair: '0' })[n]);
    expect(p.size).toBe(CROSSHAIR_DEFAULTS.size);
    expect(p.gap).toBe(-2);
    expect(p.enabled).toBe(false);
    expect(p.style).toBe(4);
  });
});
