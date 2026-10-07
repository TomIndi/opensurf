import { describe, expect, it } from 'vitest';
import { CHAT_COLORS, normalizeSegments, parseChatTags, resolveChatColor, segmentsToText } from '../src/ui/chatcolors';

describe('CS:GO chat palette', () => {
  it('has the exact CS:GO colors', () => {
    const expected: Record<string, string> = {
      default: '#FFFFFF',
      red: '#FF4040',
      lightred: '#FF6E6E',
      darkred: '#B32020',
      green: '#40FF40',
      lightgreen: '#BEFF90',
      lime: '#A2FF47',
      olive: '#BFB250',
      blue: '#99CCFF',
      lightblue: '#5E98D9',
      darkblue: '#4B69FF',
      purple: '#B47BFF',
      orchid: '#E64AE6',
      yellow: '#ECE37A',
      gold: '#E4AE39',
      orange: '#F08149',
      grey: '#B0C3D9',
      grey2: '#C6D3E0',
      team: '#99CCFF',
    };
    for (const [k, v] of Object.entries(expected)) expect(CHAT_COLORS[k]).toBe(v);
  });

  it('resolves names case-insensitively, CSS colors, and falls back to white', () => {
    expect(resolveChatColor('LightGreen')).toBe('#BEFF90');
    expect(resolveChatColor(undefined)).toBe('#FFFFFF');
    expect(resolveChatColor('#abc')).toBe('#abc');
    expect(resolveChatColor('#11223344')).toBe('#11223344');
    expect(resolveChatColor('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    expect(resolveChatColor('ff8800')).toBe('#ff8800');
    expect(resolveChatColor('notacolor')).toBe('#FFFFFF');
    expect(resolveChatColor('red; background: url(x)')).toBe('#FFFFFF');
  });
});

describe('chat tag parsing', () => {
  it('splits SourceMod {color} tags', () => {
    expect(parseChatTags('{green}[Surf]{default} You finished in {gold}01:23.45')).toEqual([
      { text: '[Surf]', color: 'green' },
      { text: ' You finished in ', color: 'default' },
      { text: '01:23.45', color: 'gold' },
    ]);
  });

  it('keeps unknown {tags} literally', () => {
    expect(parseChatTags('use {notacolor} braces {}')).toEqual([{ text: 'use {notacolor} braces {}', color: 'default' }]);
  });

  it('understands CS:GO raw color bytes', () => {
    expect(parseChatTags('\x04green\x07red\x10gold')).toEqual([
      { text: 'green', color: 'green' },
      { text: 'red', color: 'red' },
      { text: 'gold', color: 'gold' },
    ]);
  });

  it('treats tab/newline as whitespace', () => {
    expect(parseChatTags('a\nb\tc')).toEqual([{ text: 'a b c', color: 'default' }]);
  });

  it('uses the base color until the first tag', () => {
    expect(parseChatTags('x{red}y', 'team')).toEqual([
      { text: 'x', color: 'team' },
      { text: 'y', color: 'red' },
    ]);
  });
});

describe('normalizeSegments', () => {
  it('drops empty segments and expands inline tags', () => {
    const out = normalizeSegments([{ text: '' }, { text: '[', color: 'grey' }, { text: '{lime}Surf' }, { text: '] hi' }]);
    expect(out).toEqual([
      { text: '[', color: 'grey' },
      { text: 'Surf', color: 'lime' },
      { text: '] hi', color: 'default' },
    ]);
    expect(segmentsToText(out)).toBe('[Surf] hi');
  });

  it('strips stray control characters', () => {
    expect(normalizeSegments([{ text: 'a\x00b\x1fc', color: 'red' }])).toEqual([{ text: 'abc', color: 'red' }]);
  });

  it('ignores malformed input', () => {
    expect(normalizeSegments([null as never, { text: 5 as never }, { text: 'ok' }])).toEqual([{ text: 'ok', color: 'default' }]);
  });
});
