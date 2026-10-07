import { test } from 'vitest';
import { v3 } from '../../src/core/vec3';
import { categorizePosition, defaultMoveVars, playerMove } from '../../src/physics/movement';
import { createPlayerState, newMoveEvents, newUserCmd } from '../../src/physics/playertypes';
import { CONTENTS_LADDER } from '../../src/physics/types';
import { RefWorld, boxBrush, floorBrush } from './movement_world';

test('debug ladder overlap', () => {
  const w = new RefWorld([floorBrush(0), boxBrush(v3(100, -500, 0), v3(104, 500, 400), CONTENTS_LADDER)]);
  const ps = createPlayerState(v3(86, 0, 0.03125));
  categorizePosition(ps, w, defaultMoveVars());
  const ev = newMoveEvents();
  const cmd = newUserCmd();
  cmd.forwardmove = 450;
  for (let i = 0; i < 8; i++) {
    playerMove(ps, cmd, w, defaultMoveVars(), 0.01, ev);
    console.log(i, ps.moveType, JSON.stringify(ps.origin), JSON.stringify(ps.velocity), ps.onGround);
  }
});
