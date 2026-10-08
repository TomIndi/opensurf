import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { console_, ConsoleLine, cvar, execute, loadArchivedConfig } from '../src/core/cvars';
import {
  BindTable,
  DEFAULT_BINDS,
  KEY_NAMES,
  binds,
  codeToKeyName,
  configSavePending,
  execConfigText,
  keyNameToCodes,
  loadSavedConfig,
  mouseButtonToKeyName,
  normalizeKeyName,
  registerBindCommands,
  wheelToKeyName,
  writeConfig,
} from '../src/game/binds';
import { registerConvars } from '../src/game/convars';
import { queryBinds } from '../src/ui/conutil';
import * as uiKeys from '../src/ui/keys';
import { MemStore } from './gamecore_helpers';

const store = new MemStore();
const g = globalThis as { localStorage?: unknown };
const hadStorage = 'localStorage' in g;
const oldStorage = g.localStorage;

beforeAll(() => {
  g.localStorage = store;
  registerConvars();
  registerBindCommands();
});
afterAll(() => {
  if (hadStorage) g.localStorage = oldStorage;
  else delete g.localStorage;
});
beforeEach(() => {
  binds.resetToDefaults();
  writeConfig(); // flushes a save left pending by the previous test
  store.m.clear();
});
afterEach(() => {
  vi.useRealTimers();
  for (const c of console_.allCvars()) c.reset();
});

function capture(fn: () => void): string[] {
  const out: ConsoleLine[] = [];
  const off = console_.onOutput((l) => out.push(l));
  try {
    fn();
  } finally {
    off();
  }
  return out.map((l) => l.text);
}

describe('key names', () => {
  it('maps KeyboardEvent.code to Source key names', () => {
    const cases: Record<string, string> = {
      KeyA: 'a',
      KeyW: 'w',
      KeyZ: 'z',
      Digit0: '0',
      Digit9: '9',
      F1: 'f1',
      F12: 'f12',
      Space: 'space',
      ControlLeft: 'ctrl',
      ControlRight: 'ctrl',
      ShiftLeft: 'shift',
      ShiftRight: 'shift',
      AltLeft: 'alt',
      AltRight: 'alt',
      Tab: 'tab',
      Enter: 'enter',
      Escape: 'escape',
      Backspace: 'backspace',
      Delete: 'del',
      Insert: 'ins',
      Home: 'home',
      End: 'end',
      PageUp: 'pgup',
      PageDown: 'pgdn',
      ArrowUp: 'uparrow',
      ArrowDown: 'downarrow',
      ArrowLeft: 'leftarrow',
      ArrowRight: 'rightarrow',
      Semicolon: 'semicolon',
      Quote: "'",
      Backquote: '`',
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backslash: '\\',
      BracketLeft: '[',
      BracketRight: ']',
      Minus: '-',
      Equal: '=',
      CapsLock: 'capslock',
      Numpad0: 'kp_ins',
      Numpad1: 'kp_end',
      Numpad5: 'kp_5',
      Numpad8: 'kp_uparrow',
      NumpadEnter: 'kp_enter',
      NumpadAdd: 'kp_plus',
      NumpadSubtract: 'kp_minus',
      NumpadMultiply: 'kp_multiply',
      NumpadDivide: 'kp_slash',
      NumpadDecimal: 'kp_del',
    };
    for (const [code, name] of Object.entries(cases)) expect(codeToKeyName(code), code).toBe(name);
    expect(codeToKeyName('F13')).toBeNull();
    expect(codeToKeyName('')).toBeNull();
    expect(codeToKeyName('Unidentified')).toBeNull();
  });

  it('agrees with the UI binds editor mapping', () => {
    const codes = ['KeyQ', 'Digit3', 'F7', 'Space', 'ControlRight', 'ShiftLeft', 'AltRight', 'MetaLeft', 'Tab', 'Enter', 'Escape', 'Backquote', 'Semicolon', 'Quote', 'Numpad3', 'NumpadEnter', 'ArrowLeft', 'PageDown', 'IntlBackslash', 'CapsLock'];
    for (const c of codes) expect(codeToKeyName(c), c).toBe(uiKeys.codeToKeyName(c));
    for (let b = 0; b < 5; b++) expect(mouseButtonToKeyName(b)).toBe(uiKeys.mouseButtonToKeyName(b));
    for (const k of uiKeys.allKeyNames()) expect(normalizeKeyName(k), k).toBe(k);
  });

  it('round-trips every keyboard key through its codes', () => {
    for (const k of KEY_NAMES) {
      if (k.startsWith('mouse') || k.startsWith('mwheel')) continue;
      const codes = keyNameToCodes(k);
      expect(codes.length, k).toBeGreaterThan(0);
      for (const c of codes) expect(codeToKeyName(c), `${k} ${c}`).toBe(k);
    }
    expect(keyNameToCodes('ctrl').sort()).toEqual(['ControlLeft', 'ControlRight']);
    expect(keyNameToCodes('nonsense')).toEqual([]);
  });

  it('maps mouse buttons and the wheel', () => {
    expect(mouseButtonToKeyName(0)).toBe('mouse1');
    expect(mouseButtonToKeyName(2)).toBe('mouse2');
    expect(mouseButtonToKeyName(1)).toBe('mouse3');
    expect(mouseButtonToKeyName(3)).toBe('mouse4');
    expect(mouseButtonToKeyName(4)).toBe('mouse5');
    expect(mouseButtonToKeyName(7)).toBeNull();
    expect(wheelToKeyName(-120)).toBe('mwheelup');
    expect(wheelToKeyName(3)).toBe('mwheeldown');
    expect(wheelToKeyName(0)).toBeNull();
  });

  it('normalizes Source spellings case-insensitively', () => {
    expect(normalizeKeyName('W')).toBe('w');
    expect(normalizeKeyName('MOUSE4')).toBe('mouse4');
    expect(normalizeKeyName('MWHEELDOWN')).toBe('mwheeldown');
    expect(normalizeKeyName('RSHIFT')).toBe('shift');
    expect(normalizeKeyName('rctrl')).toBe('ctrl');
    expect(normalizeKeyName('RALT')).toBe('alt');
    expect(normalizeKeyName('SEMICOLON')).toBe('semicolon');
    expect(normalizeKeyName(';')).toBe('semicolon');
    expect(normalizeKeyName('KP_ENTER')).toBe('kp_enter');
    expect(normalizeKeyName('UPARROW')).toBe('uparrow');
    expect(normalizeKeyName('F10')).toBe('f10');
    expect(normalizeKeyName('`')).toBe('`');
    expect(normalizeKeyName('blah')).toBeNull();
    expect(normalizeKeyName('')).toBeNull();
  });
});

describe('bind table', () => {
  it('has the CS:GO + surf defaults', () => {
    const t = new BindTable();
    const expected: Record<string, string> = {
      w: '+forward',
      s: '+back',
      a: '+moveleft',
      d: '+moveright',
      space: '+jump',
      mwheeldown: '+jump',
      mwheelup: '+jump',
      ctrl: '+duck',
      shift: '+speed',
      e: '+use',
      tab: '+showscores',
      '`': 'toggleconsole',
      y: 'messagemode',
      u: 'messagemode2',
      r: 'say !r',
      t: 'say !back',
      g: 'say !undo',
      mouse4: 'say !saveloc',
      mouse5: 'say !tele',
      f2: 'say !prac',
      escape: 'cancelselect',
    };
    for (const [k, v] of Object.entries(expected)) expect(t.get(k), k).toBe(v);
    expect(t.size).toBe(Object.keys(expected).length);
    expect(Object.keys(DEFAULT_BINDS).sort()).toEqual(Object.keys(expected).sort());
  });

  it('sets, deletes, lists in key order and finds keys by command', () => {
    const t = new BindTable({});
    expect(t.set('MOUSE1', '+attack')).toBe(true);
    expect(t.set('bogus', 'x')).toBe(false);
    t.set('b', '+jump');
    t.set('space', '+jump');
    expect(t.entries()).toEqual([
      ['b', '+jump'],
      ['space', '+jump'],
      ['mouse1', '+attack'],
    ]);
    expect(t.keysFor('+JUMP')).toEqual(['b', 'space']);
    const v = t.version;
    t.set('b', '+jump');
    expect(t.version).toBe(v); // no-op
    t.set('b', '');
    expect(t.get('b')).toBeUndefined();
    expect(t.delete('b')).toBe(false);
    t.clear();
    expect(t.size).toBe(0);
  });
});

describe('bind commands', () => {
  it('bind / query / unbind like Source', () => {
    execute('bind k +duck');
    expect(binds.get('k')).toBe('+duck');
    execute('bind "j" "say hello; echo hi"');
    expect(binds.get('j')).toBe('say hello; echo hi');
    execute('bind x say hello world');
    expect(binds.get('x')).toBe('say hello world');
    expect(capture(() => execute('bind w'))).toEqual(['"w" = "+forward"']);
    expect(capture(() => execute('bind l'))).toEqual(['"l" is not bound']);
    expect(capture(() => execute('bind nokey +jump'))[0]).toContain("isn't a valid key");
    expect(capture(() => execute('bind'))[0]).toContain('bind <key> [command]');
    execute('bind RSHIFT +speed');
    expect(binds.get('shift')).toBe('+speed');
    execute('unbind k');
    expect(binds.get('k')).toBeUndefined();
    expect(capture(() => execute('unbind zz'))[0]).toContain("isn't a valid key");
  });

  it('unbindall / binddefaults / key_listboundkeys / key_findbinding', () => {
    execute('unbindall');
    expect(binds.size).toBe(0);
    expect(capture(() => execute('key_listboundkeys'))).toEqual([]);
    execute('binddefaults');
    expect(binds.get('w')).toBe('+forward');
    const list = capture(() => execute('key_listboundkeys'));
    expect(list).toContain('"w" = "+forward"');
    expect(list).toContain('"mwheeldown" = "+jump"');
    expect(list).toHaveLength(Object.keys(DEFAULT_BINDS).length);
    expect(capture(() => execute('key_findbinding jump')).sort()).toEqual(['"mwheeldown" = "+jump"', '"mwheelup" = "+jump"', '"space" = "+jump"']);
  });

  it('works with the UI binds editor query (queryBinds)', () => {
    execute('bind k "say !noclip"');
    const m = queryBinds(['w', 'k', 'l', 'mouse5', '`']);
    expect(m.get('w')).toBe('+forward');
    expect(m.get('k')).toBe('say !noclip');
    expect(m.get('mouse5')).toBe('say !tele');
    expect(m.get('`')).toBe('toggleconsole');
    expect(m.has('l')).toBe(false);
  });
});

describe('config persistence', () => {
  it('writes archived cvars + the complete bind table, and restores it exactly', () => {
    cvar('sensitivity').set(1.5);
    cvar('sv_airaccelerate').set(1000); // not archived
    execute('bind k "say hi; echo there"');
    execute('unbind mwheelup');
    writeConfig();
    const text = loadArchivedConfig()!;
    expect(text).toContain('sensitivity "1.5"');
    expect(text).not.toContain('sv_airaccelerate');
    expect(text).toContain('unbindall');
    expect(text).toContain('bind "k" "say hi; echo there"');
    expect(text).toContain('bind "w" "+forward"');
    expect(text).not.toContain('mwheelup');
    expect(text.indexOf('unbindall')).toBeLessThan(text.indexOf('bind "w"'));

    // fresh start: defaults, then the saved config
    binds.resetToDefaults();
    cvar('sensitivity').reset();
    expect(loadSavedConfig()).toBe(true);
    expect(cvar('sensitivity').value).toBe('1.5');
    expect(binds.get('k')).toBe('say hi; echo there');
    expect(binds.get('mwheelup')).toBeUndefined();
    expect(binds.get('mwheeldown')).toBe('+jump');
  });

  it('binds a default added later (G = !undo) on top of a config saved before it, unless the config uses the key', () => {
    // saved by an older version: unbindall + its binds, no bind_defaults_version line, no g
    store.m.set('surf.config.v1', 'sensitivity "2"\nunbindall\nbind "w" "+forward"\nbind "r" "say !r"');
    binds.resetToDefaults();
    expect(loadSavedConfig()).toBe(true);
    expect(binds.get('g')).toBe('say !undo');
    expect(binds.get('t')).toBeUndefined(); // (an older default the config doesn't have stays unbound)
    expect(binds.get('r')).toBe('say !r');
    // an older config that binds g to something else keeps it
    store.m.set('surf.config.v1', 'unbindall\nbind "g" "+use"');
    binds.resetToDefaults();
    loadSavedConfig();
    expect(binds.get('g')).toBe('+use');
    // saved by this version: the key the player unbound stays unbound
    execute('unbind g');
    writeConfig();
    expect(loadArchivedConfig()).toContain('bind_defaults_version 2');
    binds.resetToDefaults();
    loadSavedConfig();
    expect(binds.get('g')).toBeUndefined();
    expect(binds.size).toBe(0);
  });

  it('skips unknown commands in a config silently', () => {
    const out = capture(() => {
      const n = execConfigText('some_removed_cvar "1"\nbind "k" "+jump"\n\n// comment\nfov_desired "100"');
      expect(n).toBe(2);
    });
    expect(out).toEqual([]);
    expect(binds.get('k')).toBe('+jump');
    expect(cvar('fov_desired').num).toBe(100);
  });

  it('auto-saves (debounced) after binds and archived cvars change', () => {
    vi.useFakeTimers();
    execute('bind k +jump');
    expect(configSavePending()).toBe(true);
    expect(loadArchivedConfig()).toBeNull();
    vi.advanceTimersByTime(600);
    expect(configSavePending()).toBe(false);
    expect(loadArchivedConfig()).toContain('bind "k" "+jump"');
    store.m.clear();
    cvar('fov_desired').set(105);
    expect(configSavePending()).toBe(true);
    vi.advanceTimersByTime(600);
    expect(loadArchivedConfig()).toContain('fov_desired "105"');
    store.m.clear();
    cvar('sv_gravity').set(500); // not archived: no save
    expect(configSavePending()).toBe(false);
  });

  it('does not re-save while the config itself is executing', () => {
    vi.useFakeTimers();
    execConfigText('bind "k" "+jump"\nsensitivity "2"');
    expect(configSavePending()).toBe(false);
  });

  it('host_writeconfig saves immediately', () => {
    execute('bind k +duck');
    execute('host_writeconfig');
    expect(loadArchivedConfig()).toContain('bind "k" "+duck"');
    expect(configSavePending()).toBe(false);
  });
});
