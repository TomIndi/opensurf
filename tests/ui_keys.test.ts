import { describe, expect, it } from 'vitest';
import { normalizeCommand, keysByCommand, BIND_GROUPS } from '../src/ui/bindseditor';
import { parseBindLine } from '../src/ui/conutil';
import { allKeyNames, codeToKeyName, keyLabel, mouseButtonToKeyName, wheelToKeyName } from '../src/ui/keys';

describe('KeyboardEvent.code -> Source key names', () => {
  it('letters, digits, function keys', () => {
    expect(codeToKeyName('KeyW')).toBe('w');
    expect(codeToKeyName('KeyZ')).toBe('z');
    expect(codeToKeyName('Digit0')).toBe('0');
    expect(codeToKeyName('F1')).toBe('f1');
    expect(codeToKeyName('F12')).toBe('f12');
    expect(codeToKeyName('F13')).toBeNull();
  });

  it('modifiers and specials use the documented names', () => {
    expect(codeToKeyName('Space')).toBe('space');
    expect(codeToKeyName('ControlLeft')).toBe('ctrl');
    expect(codeToKeyName('ControlRight')).toBe('ctrl');
    expect(codeToKeyName('ShiftLeft')).toBe('shift');
    expect(codeToKeyName('AltLeft')).toBe('alt');
    expect(codeToKeyName('Tab')).toBe('tab');
    expect(codeToKeyName('Enter')).toBe('enter');
    expect(codeToKeyName('Escape')).toBe('escape');
    expect(codeToKeyName('Backspace')).toBe('backspace');
    expect(codeToKeyName('ArrowUp')).toBe('uparrow');
    expect(codeToKeyName('ArrowLeft')).toBe('leftarrow');
    expect(codeToKeyName('Backquote')).toBe('`');
    expect(codeToKeyName('Semicolon')).toBe('semicolon');
    expect(codeToKeyName('Numpad5')).toBe('kp_5');
    expect(codeToKeyName('NumpadEnter')).toBe('kp_enter');
    expect(codeToKeyName('')).toBeNull();
    expect(codeToKeyName('LaunchMail')).toBeNull();
  });

  it('mouse buttons and wheel', () => {
    expect(mouseButtonToKeyName(0)).toBe('mouse1');
    expect(mouseButtonToKeyName(2)).toBe('mouse2');
    expect(mouseButtonToKeyName(1)).toBe('mouse3');
    expect(mouseButtonToKeyName(3)).toBe('mouse4');
    expect(mouseButtonToKeyName(4)).toBe('mouse5');
    expect(mouseButtonToKeyName(7)).toBeNull();
    expect(wheelToKeyName(-120)).toBe('mwheelup');
    expect(wheelToKeyName(53)).toBe('mwheeldown');
    expect(wheelToKeyName(0)).toBeNull();
  });

  it('labels', () => {
    expect(keyLabel('space')).toBe('SPACE');
    expect(keyLabel('mwheeldown')).toBe('WHEEL ↓');
    expect(keyLabel('mouse4')).toBe('MOUSE 4');
    expect(keyLabel('kp_end')).toBe('NUMPAD 1');
    expect(keyLabel('w')).toBe('W');
    expect(keyLabel('f2')).toBe('F2');
    expect(keyLabel('`')).toBe('~');
  });

  it('allKeyNames is unique and covers every default bind key', () => {
    const keys = allKeyNames();
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['w', 's', 'a', 'd', 'space', 'mwheeldown', 'mwheelup', 'ctrl', 'shift', 'e', 'tab', '`', 'y', 'u', 'r', 't', 'mouse4', 'mouse5', 'escape', 'f2']) {
      expect(keys).toContain(k);
    }
  });
});

describe('binds parsing helpers', () => {
  it('parses Source bind output', () => {
    expect(parseBindLine('"w" = "+forward"')).toEqual(['w', '+forward']);
    expect(parseBindLine('"MOUSE4" = "say !saveloc"')).toEqual(['mouse4', 'say !saveloc']);
    expect(parseBindLine('w = "+forward"')).toEqual(['w', '+forward']);
    expect(parseBindLine('"`" = "toggleconsole"')).toEqual(['`', 'toggleconsole']);
    expect(parseBindLine('"x" is not bound')).toBeNull();
  });

  it('normalizes commands for comparison', () => {
    expect(normalizeCommand('say "!r"')).toBe('say !r');
    expect(normalizeCommand('  SAY   !r ')).toBe('say !r');
  });

  it('groups keys by command in a friendly order', () => {
    const m = keysByCommand(new Map([
      ['mwheelup', '+jump'],
      ['space', '+jump'],
      ['mwheeldown', '+jump'],
      ['r', 'say "!r"'],
    ]));
    expect(m.get('+jump')).toEqual(['space', 'mwheeldown', 'mwheelup']);
    expect(m.get('say !r')).toEqual(['r']);
  });

  it('keeps default keys first so new keys land in the second slot', () => {
    expect(keysByCommand(new Map([['f', '+forward'], ['w', '+forward']])).get('+forward')).toEqual(['w', 'f']);
    expect(keysByCommand(new Map([['x', '+use'], ['b', '+use']])).get('+use')).toEqual(['b', 'x']);
  });

  it('every bind action is a documented command', () => {
    const cmds = BIND_GROUPS.flatMap((g) => g.items.map((i) => i.command));
    expect(cmds).toContain('+forward');
    expect(cmds).toContain('say !r');
    expect(cmds).toContain('messagemode');
    expect(new Set(cmds).size).toBe(cmds.length);
  });
});
