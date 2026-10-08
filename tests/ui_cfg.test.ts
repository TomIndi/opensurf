import { describe, expect, it } from 'vitest';
import {
  CFG_KEY_PREFIX,
  cfgImportProblem,
  cfgNameForImport,
  cfgStorageKey,
  type CfgStorage,
  countCfgCommands,
  deleteCfg,
  listCfgs,
  loadCfg,
  MAX_CFG_BYTES,
  normalizeCfgName,
  saveCfg,
} from '../src/ui/cfgfiles';

class MemStore implements CfgStorage {
  readonly m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe('config files (.cfg import / exec storage)', () => {
  it('normalizes names like exec resolves them', () => {
    expect(normalizeCfgName('autoexec.cfg')).toBe('autoexec');
    expect(normalizeCfgName('C:\\Steam\\csgo\\cfg\\AutoExec.CFG')).toBe('autoexec');
    expect(normalizeCfgName('/home/me/cfg/surf practice.cfg')).toBe('surf_practice');
    expect(normalizeCfgName('crosshair.cfg.txt')).toBe('crosshair');
    expect(normalizeCfgName('  ')).toBeNull();
    expect(normalizeCfgName('.cfg')).toBeNull();
    expect(cfgNameForImport('config.cfg')).toBe('csgo_config');
    expect(cfgNameForImport('autoexec.cfg')).toBe('autoexec');
    expect(cfgNameForImport('???')).toBe('imported');
    expect(cfgStorageKey('AutoExec.cfg')).toBe(`${CFG_KEY_PREFIX}autoexec`);
    expect(CFG_KEY_PREFIX).toBe('surf.cfg.');
  });

  it('counts commands without blank lines and comments', () => {
    const text = '// my autoexec\r\nsensitivity 1.8\n\n   // binds\nbind "mouse4" "say !saveloc" // cp\ncl_crosshairsize 2; cl_crosshairgap -3\n';
    expect(countCfgCommands(text)).toBe(3);
    expect(cfgImportProblem(text)).toBeNull();
    expect(cfgImportProblem('// nothing\n\n')).toMatch(/no commands/);
    expect(cfgImportProblem('x'.repeat(MAX_CFG_BYTES + 1))).toMatch(/too large/);
    expect(cfgImportProblem('BSP\x00\x01\x02 binary')).toMatch(/not a text/);
  });

  it('saves, lists (autoexec first), loads and deletes under surf.cfg.<name>', () => {
    const s = new MemStore();
    s.setItem('surf.ui.other', 'x');
    expect(saveCfg('practice.cfg', 'sv_cheats 1\r\nnoclip\r\n', s)).toBe(true);
    expect(saveCfg('AutoExec', 'fps_max 0', s)).toBe(true);
    expect(saveCfg('', 'x', s)).toBe(false);
    expect(s.getItem('surf.cfg.autoexec')).toBe('fps_max 0');
    expect(loadCfg('practice', s)).toBe('sv_cheats 1\nnoclip\n');
    expect(listCfgs(s)).toEqual([
      { name: 'autoexec', size: 9, commands: 1 },
      { name: 'practice', size: 19, commands: 2 },
    ]);
    deleteCfg('practice.cfg', s);
    expect(listCfgs(s).map((c) => c.name)).toEqual(['autoexec']);
    expect(loadCfg('practice', s)).toBeNull();
    expect(listCfgs(null)).toEqual([]);
  });
});
