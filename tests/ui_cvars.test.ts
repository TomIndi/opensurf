import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { console_, FCVAR_CHEAT, FCVAR_HIDDEN, registerCommand, registerCvar } from '../src/core/cvars';
import { isSilent, queryBinds, runSilently } from '../src/ui/conutil';
import { customPhysicsActive, ensureUiCvars, persistConfigNow, PHYSICS_CVARS, setCvar, UI_CVARS } from '../src/ui/cvardefs';
import { suggestionsFor } from '../src/ui/devconsole';
import { HUD_COLOR_NAMES, HUD_COLORS } from '../src/ui/hud';

describe('UI cvar definitions match docs/ARCHITECTURE.md', () => {
  it('every documented convar is defined with the documented default', () => {
    const doc = readFileSync(join(__dirname, '../docs/ARCHITECTURE.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## Convars'), doc.indexOf('## Commands'));
    // ck_* are SurfTimer's own server cvars quoted for reference, not ours
    const pairs = [...section.matchAll(/`([a-z_0-9]+) ([-\d.]+)`/g)].map((m) => [m[1], m[2]] as const).filter(([n]) => !n.startsWith('ck_'));
    expect(pairs.length).toBeGreaterThan(60);
    const defs = new Map(UI_CVARS.map((d) => [d.name, d.def]));
    for (const [name, def] of pairs) {
      expect(defs.has(name), `${name} missing from UI_CVARS`).toBe(true);
      expect(parseFloat(defs.get(name)!)).toBe(parseFloat(def));
    }
    expect(new Set(UI_CVARS.map((d) => d.name)).size).toBe(UI_CVARS.length);
  });

  it('ensureUiCvars registers missing cvars but never replaces the game’s', () => {
    const fromGame = registerCvar({ name: 'sensitivity', default: '3', help: 'game-core' });
    ensureUiCvars();
    expect(console_.getCvar('sensitivity')).toBe(fromGame);
    expect(console_.getCvar('sensitivity')!.defaultValue).toBe('3');
    expect(console_.getCvar('surf_showkeys')!.value).toBe('1');
    expect(console_.getCvar('cl_crosshairgap')!.value).toBe('1');
    expect(console_.getCvar('hud_scaling')!.value).toBe('0.85');
  });

  it('setCvar honours FCVAR_CHEAT like the console', () => {
    ensureUiCvars();
    const wire = console_.getCvar('mat_wireframe')!;
    expect(wire.flags & FCVAR_CHEAT).toBeTruthy();
    console_.getCvar('sv_cheats')!.set('0');
    expect(setCvar('mat_wireframe', 1)).toBe('cheat');
    expect(wire.value).toBe('0');
    console_.getCvar('sv_cheats')!.set('1');
    expect(setCvar('mat_wireframe', 1)).toBe('ok');
    expect(wire.value).toBe('1');
    console_.getCvar('sv_cheats')!.set('0');
    expect(setCvar('no_such_cvar', 1)).toBe('unknown');
  });

  it('detects custom physics', () => {
    ensureUiCvars();
    expect(customPhysicsActive()).toBe(false);
    console_.getCvar('sv_airaccelerate')!.set('1000');
    expect(customPhysicsActive()).toBe(true);
    console_.getCvar('sv_airaccelerate')!.reset();
    console_.getCvar('sv_jump_impulse')!.set('301.993377');
    expect(customPhysicsActive()).toBe(false);
    expect(PHYSICS_CVARS.every((d) => console_.getCvar(d.name))).toBe(true);
  });

  it('cl_hud_color palette covers the cvar range', () => {
    expect(HUD_COLORS.length).toBe(11);
    expect(HUD_COLOR_NAMES.length).toBe(HUD_COLORS.length);
  });
});

describe('console helpers', () => {
  it('runSilently captures output and removes it from history', () => {
    console_.print('visible line');
    const before = console_.history.length;
    let seenSilent = false;
    const lines = runSilently(() => {
      seenSilent = isSilent();
      console_.print('hidden 1');
      console_.print('hidden 2', 'warn');
    });
    expect(seenSilent).toBe(true);
    expect(isSilent()).toBe(false);
    expect(lines.map((l) => l.text)).toEqual(['hidden 1', 'hidden 2']);
    expect(console_.history.length).toBe(before);
    expect(console_.history.at(-1)!.text).toBe('visible line');
  });

  it('runSilently restores state when the callback throws', () => {
    expect(() =>
      runSilently(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(isSilent()).toBe(false);
  });

  it('queryBinds reads Source-style `bind <key>` output', () => {
    const table = new Map([
      ['w', '+forward'],
      ['mouse4', 'say !saveloc'],
      [';', 'echo semi'],
    ]);
    registerCommand({
      name: 'bind',
      handler: (args) => {
        const k = args[0].toLowerCase();
        const v = table.get(k);
        console_.print(v === undefined ? `"${k}" is not bound` : `"${k}" = "${v}"`);
      },
    });
    const n = console_.history.length;
    const got = queryBinds(['w', 'a', 'mouse4', ';']);
    expect([...got]).toEqual([
      ['w', '+forward'],
      ['mouse4', 'say !saveloc'],
      [';', 'echo semi'],
    ]);
    expect(console_.history.length).toBe(n); // nothing leaked into the console
  });

  it('persistConfigNow runs host_writeconfig silently when available', () => {
    let calls = 0;
    registerCommand({
      name: 'host_writeconfig',
      handler: () => {
        calls++;
        console_.print('Wrote config.cfg');
      },
    });
    const n = console_.history.length;
    persistConfigNow();
    expect(calls).toBe(1);
    expect(console_.history.length).toBe(n);
  });

  it('autocomplete suggestions carry cvar values and hide FCVAR_HIDDEN', () => {
    registerCvar({ name: 'zz_test_alpha', default: '42', help: 'test cvar' });
    registerCvar({ name: 'zz_test_hidden', default: '1', flags: FCVAR_HIDDEN });
    registerCommand({ name: 'zz_test_cmd', help: 'a command', handler: () => undefined });
    const s = suggestionsFor('zz_test');
    expect(s.map((x) => x.text)).toEqual(['zz_test_alpha', 'zz_test_cmd']);
    expect(s[0]).toEqual({ text: 'zz_test_alpha', value: '42', help: 'test cvar' });
    expect(s[1]).toEqual({ text: 'zz_test_cmd', value: null, help: 'a command' });
    expect(suggestionsFor('   ')).toEqual([]);
    expect(suggestionsFor('zz', 1).length).toBe(1);
  });
});
