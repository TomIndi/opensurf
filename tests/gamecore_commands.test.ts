import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { console_, ConsoleLine, cvar, execute, tokenizeCommandLine } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { configExtraLines } from '../src/game/binds';
import {
  CHAT_PREFIX,
  aliasList,
  chatCommandNames,
  chatLine,
  editDistance,
  getposText,
  mapInfoSegments,
  zoneSummary,
} from '../src/game/commands';
import { registerConvars } from '../src/game/convars';
import { MOVETYPE_NOCLIP, MOVETYPE_WALK } from '../src/physics/playertypes';
import { TestGame, loadedGame, makeGame, makeTestMap, resetGlobals } from './gamecore_helpers';

let t: TestGame;

beforeEach(async () => {
  registerConvars();
  resetGlobals();
  t = await loadedGame();
  t.ui.chats.length = 0;
});
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
  t.game.disconnect();
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

const texts = () => t.ui.texts();

describe('console parsing', () => {
  it('tokenizes like Source (quotes, ;, comments)', () => {
    expect(tokenizeCommandLine('bind "r" "say !r"; echo hi // comment')).toEqual([
      ['bind', 'r', 'say !r'],
      ['echo', 'hi'],
    ]);
    expect(tokenizeCommandLine('alias +jt "+jump; +duck"')).toEqual([['alias', '+jt', '+jump; +duck']]);
    expect(tokenizeCommandLine('say ""')).toEqual([['say', '']]);
  });
});

describe('aliases', () => {
  it('define, run, list, persist and remove', () => {
    execute('alias fastfov "fov_desired 120; cl_showpos 1"');
    execute('fastfov');
    expect(cvar('fov_desired').num).toBe(120);
    expect(cvar('cl_showpos').num).toBe(1);
    expect(aliasList()).toContainEqual(['fastfov', 'fov_desired 120; cl_showpos 1']);
    expect(capture(() => execute('alias'))).toContain('fastfov : fov_desired 120; cl_showpos 1');
    expect(configExtraLines()).toContain('alias "fastfov" "fov_desired 120; cl_showpos 1"');
    execute('unalias fastfov');
    expect(aliasList().find(([k]) => k === 'fastfov')).toBeUndefined();
    expect(capture(() => execute('unalias nothere'))[0]).toContain('not an alias');
  });

  it('refuses to shadow commands and cvars', () => {
    expect(capture(() => execute('alias noclip "echo no"'))[0]).toContain("Can't alias");
    expect(capture(() => execute('alias fov_desired "echo no"'))[0]).toContain("Can't alias");
  });

  it('+/- alias pairs work from binds (jumpthrow style)', () => {
    execute('alias +jd "+jump; +duck"; alias -jd "-jump; -duck"; bind k +jd');
    t.game.dispatcher.keyDown('k');
    expect(t.game.input.isDown('jump') && t.game.input.isDown('duck')).toBe(true);
    t.game.dispatcher.keyUp('k');
    expect(t.game.input.isDown('jump') || t.game.input.isDown('duck')).toBe(false);
    execute('unbind k; unalias +jd; unalias -jd');
  });
});

describe('cvar commands', () => {
  it('toggle flips 0/1 and cycles through values', () => {
    execute('toggle cl_showpos');
    expect(cvar('cl_showpos').num).toBe(1);
    execute('toggle cl_showpos');
    expect(cvar('cl_showpos').num).toBe(0);
    execute('toggle fov_desired 90 100 110');
    expect(cvar('fov_desired').num).toBe(100);
    execute('toggle fov_desired 90 100 110');
    execute('toggle fov_desired 90 100 110');
    expect(cvar('fov_desired').num).toBe(90);
    cvar('fov_desired').set(95);
    execute('toggle fov_desired 90 100 110');
    expect(cvar('fov_desired').num).toBe(90); // not in the list: first value
    expect(capture(() => execute('toggle nosuchcvar'))[0]).toContain('unknown cvar');
    expect(capture(() => execute('toggle mat_wireframe'))[0]).toContain('cheat');
    expect(cvar('mat_wireframe').num).toBe(0);
  });

  it('incrementvar adds and wraps', () => {
    execute('incrementvar fov_desired 80 110 10');
    expect(cvar('fov_desired').num).toBe(100);
    execute('incrementvar fov_desired 80 110 10');
    execute('incrementvar fov_desired 80 110 10');
    expect(cvar('fov_desired').num).toBe(80); // 120 > 110 wraps to min
    execute('incrementvar fov_desired 80 110 -10');
    expect(cvar('fov_desired').num).toBe(110); // below min wraps to max
    execute('incrementvar sensitivity 0.5 3 0.1');
    expect(cvar('sensitivity').value).toBe('2.6');
    expect(capture(() => execute('incrementvar fov_desired 1'))[0]).toContain('Usage');
  });

  it('cvarlist / find / help / differences', () => {
    const list = capture(() => execute('cvarlist sv_air'));
    expect(list.join('\n')).toContain('sv_airaccelerate');
    expect(list.join('\n')).toContain('sv_air_max_wishspeed');
    expect(list[list.length - 1]).toMatch(/2 total convars\/concommands/);
    const found = capture(() => execute('find crosshairgap')).join('\n');
    expect(found).toContain('"cl_crosshairgap" = "1"');
    const help = capture(() => execute('help sv_airaccelerate')).join('\n');
    expect(help).toContain('"sv_airaccelerate" = "150" ( def. "150" )');
    expect(help).toContain('rep');
    expect(capture(() => execute('help bind')).join('\n')).toContain('attach a command to a key');
    expect(capture(() => execute('help nope'))[0]).toContain('no cvar or command');
    cvar('fov_desired').set(105);
    const diff = capture(() => execute('differences'));
    expect(diff).toContain('"fov_desired" = "105" ( def. "90" )');
  });

  it('echo and clear', () => {
    expect(capture(() => execute('echo hello   world'))).toEqual(['hello world']);
    execute('clear');
    expect(console_.history.length).toBe(0);
  });
});

describe('player console commands', () => {
  it('getpos prints the eye position (CS:GO) and round-trips through setpos', () => {
    const s = t.game.session!;
    t.game.teleportPlayer(v3(100.5, -200.25, 300), { pitch: 12.5, yaw: 45, roll: 0 }, null);
    const line = capture(() => execute('getpos'))[0];
    expect(line).toBe('setpos 100.500000 -200.250000 364.000000;setang 12.500000 45.000000 0.000000');
    t.game.teleportPlayer(v3(0, 0, 0), null, null);
    execute(line);
    expect(s.player.origin.x).toBeCloseTo(100.5, 6);
    expect(s.player.origin.y).toBeCloseTo(-200.25, 6);
    expect(s.player.origin.z).toBeCloseTo(300, 6); // feet where they were, not 64 units higher
    expect(t.game.getViewAngles().yaw).toBeCloseTo(45, 6);
    expect(s.timer.inPractice).toBe(true); // setpos is practice
    // the _exact variants use the origin
    const exact = capture(() => execute('getpos_exact'))[0];
    expect(exact).toBe('setpos_exact 100.500000 -200.250000 300.000000;setang_exact 12.500000 45.000000 0.000000');
    t.game.teleportPlayer(v3(0, 0, 0), null, null);
    execute(exact);
    expect(s.player.origin.z).toBeCloseTo(300, 6);
    // setpos without z keeps the height
    execute('setpos 10 20');
    expect(s.player.origin).toMatchObject({ x: 10, y: 20 });
    expect(s.player.origin.z).toBeCloseTo(300, 6);
    expect(getposText(v3(-0, 1, 2), { pitch: 0, yaw: 0, roll: 0 })).toBe('setpos 0.000000 1.000000 2.000000;setang 0.000000 0.000000 0.000000');
  });

  it('setpos validates its arguments', () => {
    expect(capture(() => execute('setpos 1'))[0]).toContain('Usage');
    expect(capture(() => execute('setpos a b c'))[0]).toContain('Usage');
    expect(capture(() => execute('setang 1'))[0]).toContain('Usage');
  });

  it('noclip toggles with Source messages; kill respawns at the start', () => {
    const s = t.game.session!;
    const on = capture(() => execute('noclip'));
    expect(on[on.length - 1]).toBe('noclip ON');
    expect(on.join('\n')).toContain('Practice mode'); // the timer's chat line is mirrored to the console
    expect(s.player.moveType).toBe(MOVETYPE_NOCLIP);
    expect(capture(() => execute('noclip'))).toEqual(['noclip OFF']);
    expect(s.player.moveType).toBe(MOVETYPE_WALK);
    t.game.teleportPlayer(v3(900, 0, 0), null, null);
    execute('kill');
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1);
    expect(s.timer.getHud().state).toBe('startzone');
  });

  it('status and version', () => {
    const st = capture(() => execute('status')).join('\n');
    expect(st).toContain('map     : surf_gamecore_test');
    expect(st).toContain('players : 1 humans');
    expect(capture(() => execute('version'))[0]).toContain('SURF');
  });

  it('pasted CS:GO binds to weapon commands are silently ignored', () => {
    expect(capture(() => execute('slot1; lastinv; +lookatweapon; -lookatweapon; drop'))).toEqual([]);
  });

  it('map / retry / disconnect / quit', async () => {
    const first = t.game.session;
    execute('retry');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.game.session).not.toBe(first);
    execute('disconnect');
    expect(t.game.state).toBe('menu');
    execute('map test');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.game.state).toBe('playing');
    expect(capture(() => execute('quit')).join('\n')).toContain('Close the browser tab');
    expect(t.game.state).toBe('menu');
  });

  it('UI commands call the UI; cancelselect toggles the pause menu', () => {
    execute('toggleconsole');
    expect(t.ui.consoleToggles).toBe(1);
    execute('messagemode; messagemode2');
    expect(t.ui.chatOpens).toEqual([false, true]);
    execute('cancelselect');
    expect(t.game.state).toBe('paused');
    execute('cancelselect');
    expect(t.game.state).toBe('playing');
  });

  it('ent_fire is a cheat', () => {
    expect(capture(() => execute('ent_fire x enable'))[0]).toContain('cheat');
  });
});

describe('chat', () => {
  it('plain chat shows "Player : text"', () => {
    t.game.say('hello there');
    expect(t.ui.chats[0]).toEqual(chatLine('hello there', false));
    expect(texts()[0]).toBe('Player : hello there');
    cvar('name').set('KSF Pro');
    execute('say_team gg');
    expect(texts()[1]).toBe('(Counter-Terrorist) KSF Pro : gg');
    t.game.say('   ');
    expect(t.ui.chats).toHaveLength(2);
  });

  it('!cmd is echoed and runs; /cmd runs silently', () => {
    const s = t.game.session!;
    t.game.teleportPlayer(v3(800, 0, 0), null, null);
    t.game.say('!r');
    expect(texts()).toEqual(['Player : !r']);
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1);
    t.game.teleportPlayer(v3(800, 0, 0), null, null);
    t.game.say('/restart');
    expect(texts()).toEqual(['Player : !r']);
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1);
    execute('say !R');
    expect(texts()).toEqual(['Player : !r', 'Player : !R']);
  });

  it('unknown !commands are chat plus a hint (with a suggestion)', () => {
    t.game.say('!fob 100');
    expect(texts()[0]).toBe('Player : !fob 100');
    expect(texts()[1]).toContain('Unknown command !fob');
    expect(texts()[1]).toContain('!fov');
    t.game.say('/xyzzy');
    expect(texts()[2]).toBe('Player : /xyzzy');
    expect(texts()[3]).toContain('Unknown command /xyzzy');
    expect(texts()[3]).not.toContain('Did you mean');
    t.game.say('! hello');
    expect(texts()[4]).toBe('Player : ! hello');
    expect(texts()).toHaveLength(5);
  });

  it('replies carry the [Surf] prefix', () => {
    t.game.say('/mi');
    expect(t.ui.chats[0].slice(0, 3)).toEqual([...CHAT_PREFIX]);
    expect(texts()[0]).toMatch(/^\[Surf\] surf_gamecore_test \| Tier 2 \| Linear \| Zones: built-in$/);
  });

  it('commands need a map', () => {
    t.game.disconnect();
    t.ui.chats.length = 0;
    t.game.say('/r');
    expect(texts()[0]).toContain('No map loaded');
    t.game.say('/fov 100'); // client settings work anywhere
    expect(cvar('fov_desired').num).toBe(100);
  });

  it('sm_<cmd> console commands mirror the chat commands', () => {
    const s = t.game.session!;
    t.game.teleportPlayer(v3(800, 0, 0), null, null);
    execute('sm_r');
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1);
    expect(console_.hasCommand('sm_saveloc')).toBe(true);
    expect(chatCommandNames()).toEqual(expect.arrayContaining(['r', 'restart', 's', 'stage', 'b', 'bonus', 'back', 'stuck', 'saveloc', 'cp', 'tele', 'tp', 'prac', 'practice', 'noclip', 'pb', 'top', 'mi', 'tier', 'replay', 'ghost', 'hide', 'showkeys', 'speed', 'zones', 'end', 'help', 'commands', 'fov', 'sens']));
  });
});

describe('surf chat commands', () => {
  it('!saveloc / !tele restore position, view, velocity in practice mode', () => {
    const s = t.game.session!;
    t.game.teleportPlayer(v3(300, 200, 0), { pitch: 5, yaw: 33, roll: 0 }, v3(10, 20, 0));
    t.game.say('/saveloc');
    expect(t.ui.lastText()).toContain('Saved location #1');
    t.game.teleportPlayer(v3(-500, -500, 0), { pitch: 0, yaw: 0, roll: 0 }, v3());
    t.game.say('/tele');
    expect(s.player.origin.x).toBeCloseTo(300, 3);
    expect(s.player.origin.y).toBeCloseTo(200, 3);
    expect(s.player.velocity.x).toBe(10);
    expect(s.player.velocity.y).toBe(20);
    expect(t.game.getViewAngles().yaw).toBeCloseTo(33, 6);
    expect(s.timer.inPractice).toBe(true);
    // several locations, by number, prev/next
    t.game.teleportPlayer(v3(400, 0, 0), null, v3());
    t.game.say('/cp');
    t.game.say('/tp 1');
    expect(s.player.origin.x).toBeCloseTo(300, 3);
    t.game.say('/telenext');
    expect(s.player.origin.x).toBeCloseTo(400, 3);
    t.game.say('/teleprev');
    expect(s.player.origin.x).toBeCloseTo(300, 3);
    t.game.say('/tele 9');
    expect(t.ui.lastText()).toContain("doesn't exist");
  });

  it('!tele without savelocs explains; !prac falls back to practice mode', () => {
    const s = t.game.session!;
    t.game.say('/tele');
    expect(t.ui.lastText()).toContain('No saved locations');
    t.game.say('/prac');
    expect(s.timer.inPractice).toBe(true);
    t.game.say('/prac');
    expect(t.ui.lastText()).toContain('Already in practice mode');
    t.game.say('/saveloc');
    t.game.teleportPlayer(v3(-700, 0, 0), null, null);
    t.game.say('/practice');
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1); // teleported to the saveloc
  });

  it('!tele restores the duck state and leaves noclip', () => {
    const s = t.game.session!;
    s.player.ducked = true;
    t.game.say('/saveloc');
    s.player.ducked = false;
    t.game.say('/noclip');
    expect(s.player.moveType).toBe(MOVETYPE_NOCLIP);
    t.game.say('/tele');
    expect(s.player.moveType).toBe(MOVETYPE_WALK);
    expect(s.player.ducked).toBe(true);
  });

  it('!noclip toggles and announces', () => {
    const s = t.game.session!;
    t.game.say('/noclip');
    expect(s.player.moveType).toBe(MOVETYPE_NOCLIP);
    expect(texts().join('\n')).toContain('Noclip enabled');
    t.game.say('/nc');
    expect(s.player.moveType).toBe(MOVETYPE_WALK);
  });

  it('!s / !b on a linear map without bonus', () => {
    const s = t.game.session!;
    t.game.teleportPlayer(v3(900, 0, 0), null, null);
    t.game.say('/s');
    expect(Math.abs(s.player.origin.x)).toBeLessThan(1); // linear: !s restarts
    t.game.say('/s 3');
    expect(t.ui.lastText()).toContain('no stages');
    t.game.say('/s x');
    expect(t.ui.lastText()).toContain('Usage');
    t.game.say('/b');
    expect(t.ui.lastText()).toContain("Bonus 1 doesn't exist");
  });

  it('!end teleports to the end zone (practice)', () => {
    const s = t.game.session!;
    t.game.say('/end');
    expect(s.player.origin.x).toBeGreaterThan(1400);
    expect(s.timer.inPractice).toBe(true);
  });

  it('!pb / !top before and after a run', () => {
    t.game.say('/pb');
    expect(t.ui.lastText()).toContain("haven't finished");
    t.game.say('/top');
    expect(t.ui.lastText()).toContain('No times');
    t.game.executeCommand('+forward');
    t.game.runTicks(800);
    t.game.executeCommand('-forward');
    t.game.say('/pb');
    expect(t.ui.lastText()).toMatch(/Your PB on surf_gamecore_test: 00:0\d\.\d{3} \(1 completion/);
    t.game.say('/top');
    expect(t.ui.lastText()).toMatch(/^#1 00:0\d\.\d{3}/);
  });

  it('client toggles: !ghost !hide !showkeys !speed !fov !sens', () => {
    t.game.say('/ghost');
    expect(cvar('surf_ghost').num).toBe(0);
    expect(t.ui.lastText()).toContain('Ghost disabled');
    t.game.say('/hide');
    expect(cvar('surf_hide').num).toBe(1);
    t.game.say('/showkeys');
    expect(cvar('surf_showkeys').num).toBe(0);
    t.game.say('/speed');
    expect(cvar('surf_hud_speed').num).toBe(0);
    t.game.say('/fov 110');
    expect(cvar('fov_desired').num).toBe(110);
    t.game.say('/fov 500');
    expect(cvar('fov_desired').num).toBe(130);
    t.game.say('/fov');
    expect(t.ui.lastText()).toContain('FOV: 130');
    t.game.say('/sens 1.25');
    expect(cvar('sensitivity').value).toBe('1.25');
    t.game.say('/sens abc');
    expect(t.ui.lastText()).toContain('Sensitivity: 1.25');
  });

  it('!help lists commands; !zones turns the editor on and explains it', () => {
    t.game.say('!help');
    const all = texts().join('\n');
    expect(all).toContain('!saveloc');
    expect(all).toContain('!replay');
    t.ui.chats.length = 0;
    t.game.say('/zones');
    expect(texts().join('\n')).toContain('zone_add');
    expect(t.game.session!.zoneEditor.active).toBe(true);
  });

  it('!replay without a PB explains', () => {
    t.game.say('/replay');
    expect(t.ui.lastText()).toContain('No replay');
    expect(t.game.spectating).toBe(false);
  });
});

describe('map info helpers', () => {
  it('summarizes zones', () => {
    const z = (type: 'start' | 'end' | 'stage' | 'checkpoint', group: number, index: number) => ({ type, group, index, mins: v3(), maxs: v3(1, 1, 1) });
    const sum = zoneSummary([z('start', 0, 0), z('stage', 0, 2), z('stage', 0, 5), z('end', 0, 0), z('start', 1, 0), z('start', 2, 0), z('checkpoint', 0, 1)]);
    expect(sum).toEqual({ stages: 5, checkpoints: 1, bonuses: [1, 2], hasEnd: true });
    const map = makeTestMap({ name: 'surf_x' });
    const text = mapInfoSegments(map, 4, [z('start', 0, 0), z('stage', 0, 3), z('start', 1, 0)], 'preset').map((s) => s.text).join('');
    expect(text).toBe('surf_x | Tier 4 | Staged (3 stages) | 1 bonus | Zones: SurfTimer');
  });

  it('edit distance', () => {
    expect(editDistance('fob', 'fov')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('tele', 'tele')).toBe(0);
  });

  it('welcome message warns about missing zones', async () => {
    const g = makeGame(makeTestMap({ zones: [] }));
    await g.game.loadBuiltinMap('test');
    const all = g.ui.texts().join('\n');
    expect(all).toContain('Welcome to');
    // the heuristic gives a start zone around the spawn but no end
    expect(all).toMatch(/no timer zones|No end zone/);
    g.game.disconnect();
  });
});
