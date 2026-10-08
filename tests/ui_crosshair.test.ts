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
import {
  bytesToShareCode,
  type CrosshairShareData,
  decodeCrosshairShareCode,
  encodeCrosshairShareCode,
  SHARE_CODE_CVARS,
  SHARE_CODE_DEFAULTS,
  shareCodeBytes,
  shareCodeChecksum,
  shareDataFromCvars,
  shareDataToCommands,
} from '../src/ui/crosshaircode';

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

describe('CS:GO crosshair share codes', () => {
  // published example code (csgo-sharecode docs): every field decodes to a sensible value and the checksum holds
  const EXAMPLE = 'CSGO-O4Jsi-V36wY-rTMGK-9w7qF-jQ8WB';

  it('decodes the 25 base-57 characters (last one most significant) into 18 big-endian bytes', () => {
    const b = shareCodeBytes(EXAMPLE)!;
    expect([...b]).toEqual([22, 1, 10, 3, 50, 250, 84, 200, 127, 156, 101, 56, 41, 148, 74, 1, 0, 0]);
    expect(b[0]).toBe(shareCodeChecksum(b));
    expect(bytesToShareCode(b)).toBe(EXAMPLE);
  });

  it('maps the bytes to the cl_crosshair* fields', () => {
    const r = decodeCrosshairShareCode(EXAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      gap: 1,
      outlineThickness: 1.5,
      red: 50,
      green: 250,
      blue: 84,
      alpha: 200,
      splitDistance: 127,
      followRecoil: false,
      fixedGap: -10,
      color: 5,
      outline: false,
      innerSplitAlpha: 0.6,
      outerSplitAlpha: 0.8,
      splitSizeRatio: 0.3,
      thickness: 4.1,
      style: 2,
      dot: true,
      useWeaponGap: false,
      useAlpha: false,
      tStyle: true,
      // 13-bit size: low byte 74 + high bits 1 << 8
      size: 33,
    } satisfies CrosshairShareData);
  });

  it('rejects malformed codes and bad checksums', () => {
    expect(decodeCrosshairShareCode('CSGO-O4Jsi-V36wY-rTMGK-9w7qF')).toEqual({ ok: false, error: 'format' });
    expect(decodeCrosshairShareCode('CSGO-O4Jsi-V36wY-rTMGK-9w7qF-jQ8W0')).toEqual({ ok: false, error: 'format' }); // 0 is not in the alphabet
    expect(decodeCrosshairShareCode('CSGO-WbJbh-4KBUq-eFnwE-sFn6P-o7TjD')).toEqual({ ok: false, error: 'checksum' });
    // one changed character breaks the checksum
    expect(decodeCrosshairShareCode('CSGO-P4Jsi-V36wY-rTMGK-9w7qF-jQ8WB')).toEqual({ ok: false, error: 'checksum' });
    // 25 x '9' overflows 144 bits
    expect(shareCodeBytes('CSGO-99999-99999-99999-99999-99999')).toBeNull();
  });

  it('round-trips encode -> decode for typical and extreme crosshairs', () => {
    const cases: CrosshairShareData[] = [
      { ...SHARE_CODE_DEFAULTS },
      { ...SHARE_CODE_DEFAULTS, gap: -3, size: 2, thickness: 0.6, dot: true, outline: false, color: 4, style: 4, useAlpha: true, alpha: 255 },
      { ...SHARE_CODE_DEFAULTS, gap: -12.8, fixedGap: 12.7, size: 819.1, thickness: 25.5, outlineThickness: 3, splitDistance: 127, followRecoil: true, tStyle: true, useWeaponGap: true, style: 5, color: 5, red: 0, green: 128, blue: 255, innerSplitAlpha: 1.5, outerSplitAlpha: 0, splitSizeRatio: 1 },
    ];
    for (const d of cases) {
      const code = encodeCrosshairShareCode(d);
      expect(code).toMatch(/^CSGO(-[A-HJ-Za-fh-km-z2-9]{5}){5}$/);
      const r = decodeCrosshairShareCode(code);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toEqual(d);
    }
    const ex = decodeCrosshairShareCode(EXAMPLE);
    if (!ex.ok) throw new Error('decode');
    expect(encodeCrosshairShareCode(ex.data)).toBe(EXAMPLE);
  });

  it('expands to cvar commands; pasted text with a code applies them, later lines override', () => {
    const r = decodeCrosshairShareCode(EXAMPLE);
    if (!r.ok) throw new Error('decode');
    const cmds = shareDataToCommands(r.data);
    expect(cmds).toContain('cl_crosshairsize "33"');
    expect(cmds).toContain('cl_crosshairgap "1"');
    expect(cmds).toContain('cl_crosshairusealpha "0"');
    expect(cmds).toContain('cl_crosshair_t "1"');
    expect(cmds).toHaveLength(Object.keys(SHARE_CODE_CVARS).length);

    const p = parseCrosshairConfig(`apply_crosshair_code ${EXAMPLE}\ncl_crosshairsize 2`);
    expect(p.shareCodes).toEqual([EXAMPLE]);
    expect(p.shareCodeErrors).toEqual([]);
    expect(p.commands).toContain('cl_crosshairsize "2"');
    expect(p.commands).toContain('cl_crosshaircolor_b "84"');
    expect(p.commands).toContain('cl_fixedcrosshairgap "-10"');
    expect(parseCrosshairConfig(`  ${EXAMPLE}  `).commands.length).toBe(cmds.length);

    const bad = parseCrosshairConfig('CSGO-WbJbh-4KBUq-eFnwE-sFn6P-o7TjD');
    expect(bad.commands).toEqual([]);
    expect(bad.shareCodeErrors).toEqual([{ code: 'CSGO-WbJbh-4KBUq-eFnwE-sFn6P-o7TjD', error: 'checksum' }]);
  });

  it('exports the current cvars as a share code (CS:GO defaults for cvars missing here)', () => {
    const values: Record<string, string> = { ...CROSSHAIR_CVARS, cl_crosshairsize: '2', cl_crosshairgap: '-3', cl_crosshairdot: '1', cl_crosshair_t: '1' };
    const d = shareDataFromCvars((n) => values[n]);
    expect(d.size).toBe(2);
    expect(d.gap).toBe(-3);
    expect(d.dot).toBe(true);
    expect(d.tStyle).toBe(true);
    expect(d.splitDistance).toBe(SHARE_CODE_DEFAULTS.splitDistance);
    const back = decodeCrosshairShareCode(encodeCrosshairShareCode(d));
    expect(back.ok && back.data).toEqual(d);
  });
});
