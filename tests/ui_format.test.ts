import { describe, expect, it } from 'vitest';
import { centis, cmPer360, fmtNum, fmtPos, formatBytes, formatDelta, formatSpeed, formatTime, formatTimeShort, mapTypeName, prettyMapName, splitMapName, tierName } from '../src/ui/format';

describe('formatTime (SurfTimer clock)', () => {
  it('formats mm:ss.cc with leading zeros', () => {
    expect(formatTime(0)).toBe('00:00.00');
    expect(formatTime(47.12)).toBe('00:47.12');
    expect(formatTime(5.05)).toBe('00:05.05');
    expect(formatTime(60)).toBe('01:00.00');
    expect(formatTime(83.45)).toBe('01:23.45');
    expect(formatTime(599.99)).toBe('09:59.99');
    expect(formatTime(3599.99)).toBe('59:59.99');
  });

  it('adds hours only when needed', () => {
    expect(formatTime(3600)).toBe('1:00:00.00');
    expect(formatTime(3723.4)).toBe('1:02:03.40');
    expect(formatTime(36000 + 61.5)).toBe('10:01:01.50');
  });

  it('truncates like a stopwatch and is robust to float noise', () => {
    expect(formatTime(59.999)).toBe('00:59.99');
    expect(formatTime(0.29)).toBe('00:00.29'); // 0.29*100 = 28.999999999999996
    expect(formatTime(1.15)).toBe('00:01.15');
    expect(formatTime(0.1 + 0.2)).toBe('00:00.30');
    expect(centis(0.07)).toBe(7);
  });

  it('clamps invalid input to zero', () => {
    expect(formatTime(-5)).toBe('00:00.00');
    expect(formatTime(Number.NaN)).toBe('00:00.00');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('00:00.00');
  });
});

describe('formatTimeShort / formatDelta', () => {
  it('drops leading zero units', () => {
    expect(formatTimeShort(0.42)).toBe('0.42');
    expect(formatTimeShort(47.12)).toBe('47.12');
    expect(formatTimeShort(62.34)).toBe('1:02.34');
    expect(formatTimeShort(3723.4)).toBe('1:02:03.40');
  });

  it('signs split deltas (negative = faster)', () => {
    expect(formatDelta(-0.42)).toBe('-0.42');
    expect(formatDelta(1.03)).toBe('+1.03');
    expect(formatDelta(62.34)).toBe('+1:02.34');
    expect(formatDelta(-62.34)).toBe('-1:02.34');
    expect(formatDelta(0)).toBe('±0.00');
    expect(formatDelta(0.004)).toBe('±0.00');
    expect(formatDelta(Number.NaN)).toBe('');
  });
});

describe('misc formatting', () => {
  it('speed rounds to whole units', () => {
    expect(formatSpeed(1234.4)).toBe('1234');
    expect(formatSpeed(1234.5)).toBe('1235');
    expect(formatSpeed(-3)).toBe('0');
    expect(formatSpeed(Number.NaN)).toBe('0');
  });

  it('bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(56.3 * 1024 * 1024)).toBe('56.3 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });

  it('splits and prettifies map names', () => {
    expect(splitMapName('surf_utopia_njv')).toEqual({ prefix: 'surf_', rest: 'utopia_njv' });
    expect(splitMapName('bhop_x')).toEqual({ prefix: 'bhop_', rest: 'x' });
    expect(splitMapName('mymap')).toEqual({ prefix: '', rest: 'mymap' });
    expect(prettyMapName('surf_utopia_njv')).toBe('Utopia NJV');
    expect(prettyMapName('surf_summer_ksf')).toBe('Summer KSF');
    expect(prettyMapName('surf_mesa_fixed')).toBe('Mesa Fixed');
    expect(prettyMapName('surf_lt_omnific')).toBe('Lt Omnific');
  });

  it('tier / type names', () => {
    expect(tierName(3)).toBe('Tier 3');
    expect(tierName(null)).toBe('Unknown tier');
    expect(mapTypeName('staged')).toBe('Staged');
    expect(mapTypeName('linear')).toBe('Linear');
    expect(mapTypeName('staged-linear')).toBe('Staged / Linear');
    expect(mapTypeName(null)).toBe('Unknown');
  });

  it('showpos numbers never print -0.00', () => {
    expect(fmtPos(-0.001)).toBe('0.00');
    expect(fmtPos(-12.345)).toBe('-12.35');
    expect(fmtPos(1288.12)).toBe('1288.12');
  });

  it('fmtNum trims trailing zeros', () => {
    expect(fmtNum(2.5)).toBe('2.5');
    expect(fmtNum(0.022, 4)).toBe('0.022');
    expect(fmtNum(100)).toBe('100');
    expect(fmtNum(1 / 3, 3)).toBe('0.333');
    expect(fmtNum(Number.NaN)).toBe('0');
  });

  it('cm/360 uses CS:GO units', () => {
    // 2.5 sens, m_yaw 0.022, 800 dpi -> 360 / 0.055 = 6545.45 counts = 8.18 in = 20.78 cm
    expect(cmPer360(2.5, 0.022, 800)).toBeCloseTo(20.78, 2);
    expect(cmPer360(1, 0.022, 400)).toBeCloseTo((360 / 0.022 / 400) * 2.54, 6);
    expect(cmPer360(0, 0.022, 800)).toBe(Infinity);
  });
});
