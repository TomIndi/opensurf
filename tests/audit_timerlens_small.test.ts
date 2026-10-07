import { afterEach, beforeAll, describe, it } from 'vitest';
import { console_ } from '../src/core/cvars';
import { v3 } from '../src/core/vec3';
import { registerConvars } from '../src/game/convars';
import { loadedGame, makeTestMap, resetGlobals } from './gamecore_helpers';

beforeAll(() => registerConvars());
afterEach(() => {
  for (const c of console_.allCvars()) c.reset();
});
const f = (n: number) => n.toFixed(1);
const hs = (v: { x: number; y: number }) => Math.hypot(v.x, v.y);

describe('audit small', () => {
  it('air exit prespeed', async () => {
    resetGlobals();
    const t = await loadedGame(makeTestMap());
    const g = t.game; const s = g.session!; const ps = s.player;
    g.runTicks(10);
    ps.velocity.x = 600; ps.velocity.z = 250; ps.onGround = false;
    for (let i = 0; i < 60; i++) {
      const before = s.timer.getHud().state;
      g.runTicks(1);
      const st = s.timer.getHud().state;
      if (st !== before) console.log(`air exit: ${before}->${st} at tick ${i}, speed now ${f(hs(ps.velocity))}, x=${f(ps.origin.x)}`);
    }
    // bhop in zone with sideways velocity, check speed stays > 350 inside zone (SurfTimer would cap on jump)
    g.say('/r');
    g.runTicks(5);
    g.executeCommand('+jump');
    ps.velocity.y = 500;
    let maxIn = 0;
    for (let i = 0; i < 30; i++) { g.runTicks(1); if (s.timer.getHud().state === 'startzone') maxIn = Math.max(maxIn, hs(ps.velocity)); }
    g.executeCommand('-jump');
    console.log('max horizontal speed while bhopping inside start zone', f(maxIn));
  });

  it('noclip into start zone, noclip off, walk out', async () => {
    resetGlobals();
    const t = await loadedGame(makeTestMap());
    const g = t.game; const s = g.session!; const ps = s.player;
    g.runTicks(5);
    g.executeCommand('+forward');
    for (let i = 0; i < 100 && s.timer.getHud().state !== 'running'; i++) g.runTicks(1);
    g.runTicks(50);
    g.executeCommand('-forward');
    console.log('A state', s.timer.getHud().state, 'x', f(ps.origin.x));
    g.executeCommand('noclip');
    console.log('B after noclip on', s.timer.getHud().state, s.timer.inPractice);
    g.setViewAngles(0, 180);
    g.executeCommand('+forward');
    for (let i = 0; i < 300 && ps.origin.x > 0; i++) g.runTicks(1);
    g.executeCommand('-forward');
    g.runTicks(5);
    console.log('C in start w/ noclip', s.timer.getHud().state, 'x', f(ps.origin.x), 'z', f(ps.origin.z));
    g.executeCommand('noclip');
    ps.velocity.x = ps.velocity.y = ps.velocity.z = 0;
    { let pst = s.timer.getHud().state; for (let i = 0; i < 50; i++) { g.runTicks(1); const st = s.timer.getHud().state; if (st !== pst) { console.log('  D transition', pst, '->', st, 'tick', i, 'z', f(ps.origin.z)); pst = st; } } }
    console.log('D noclip off in start', s.timer.getHud().state, 'time', f(s.timer.getHud().time), 'practice', s.timer.inPractice, 'z', f(ps.origin.z));
    g.setViewAngles(0, 0);
    g.executeCommand('+forward');
    let pst = s.timer.getHud().state;
    for (let i = 0; i < 200; i++) { g.runTicks(1); const st = s.timer.getHud().state; if (st !== pst) { console.log('  transition', pst, '->', st, 'tick', i, 'x', f(ps.origin.x), 'z', f(ps.origin.z), 'ground', ps.onGround); pst = st; } }
    g.executeCommand('-forward');
    console.log('E after walking out', s.timer.getHud().state, 'time', f(s.timer.getHud().time), 'practice', s.timer.inPractice, 'x', f(ps.origin.x));
    // walk to end
    g.executeCommand('+forward');
    for (let i = 0; i < 800; i++) g.runTicks(1);
    g.executeCommand('-forward');
    console.log('F at end', s.timer.getHud().state, t.ui.texts().slice(-3));
  });

  it('saveloc in start zone then tele', async () => {
    resetGlobals();
    const t = await loadedGame(makeTestMap());
    const g = t.game; const s = g.session!; const ps = s.player;
    g.runTicks(5);
    g.say('/saveloc');
    g.say('/tele');
    g.runTicks(3);
    console.log('after tele in start', s.timer.getHud().state, 'practice', s.timer.inPractice);
    g.executeCommand('+forward');
    for (let i = 0; i < 100; i++) g.runTicks(1);
    console.log('after walking out post-tele', s.timer.getHud().state, 'practice', s.timer.inPractice, f(ps.origin.x));
    for (let i = 0; i < 800; i++) g.runTicks(1);
    g.executeCommand('-forward');
    console.log('end', s.timer.getHud().state, t.ui.texts().slice(-2));
  });
});
