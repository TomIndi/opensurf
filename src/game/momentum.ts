// surf_keep_momentum: teleports keep your speed. Whenever the map or a fail would stop the player at a teleport
// (a trigger_teleport without a landmark - fails and stage transitions alike - a trigger_hurt / crush death, the
// timer's teletostart / checker zones), the horizontal speed they had is given back, pointed the way the
// teleport faces them; vertical speed is dropped. Restarts and teleports the player asks for (!r, !back, !s, !b,
// !tele) still stop them, and seamless map teleports (landmarks) already keep velocity. Runs played with it are
// their own records style ("momentum", see records.ts).
import { Vec3, v3 } from '../core/vec3';

/** Horizontal speed of `v` pointed along `yaw` (degrees), no vertical speed. */
export function momentumVelocity(v: Vec3, yaw: number, out: Vec3 = v3()): Vec3 {
  const speed = Math.sqrt(v.x * v.x + v.y * v.y);
  const r = (yaw * Math.PI) / 180;
  const ok = Number.isFinite(speed) && Number.isFinite(r);
  out.x = ok ? Math.cos(r) * speed : 0;
  out.y = ok ? Math.sin(r) * speed : 0;
  out.z = 0;
  return out;
}
