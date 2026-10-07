// Surf tips shown on the loading screen.

export const SURF_TIPS: string[] = [
  'Hold the strafe key toward the ramp (A on a left ramp, D on a right ramp) and never press W while surfing.',
  'Gain speed in the air by turning your mouse smoothly in the same direction you strafe.',
  'Land on ramps as high as possible and keep your crosshair slightly above the horizon to carry speed.',
  'Press R (or type !r) to restart the map. T (!back) restarts only the current stage.',
  'Use !saveloc (Mouse4) and !tele (Mouse5) to practise a hard section — the timer switches to practice mode.',
  'Type !s 3 to jump to stage 3 on staged maps, and !b 1 for bonus 1.',
  'Your CS:GO sensitivity carries over: sensitivity and m_yaw use exactly the same units.',
  'Paste your CS:GO crosshair config in Settings → Crosshair, or type the cl_crosshair* commands in the console.',
  'The developer console opens with the ` key — bind, alias, cvarlist and find all work.',
  'Watch your PB replay with !replay, or race your ghost (!ghost toggles it).',
  'Hitting the end of a ramp too low? Look further ahead and start your turn earlier.',
  'Tickrate changes how ramps feel: 100 tick is the CS:GO surf default — other presets are in Settings → Game.',
  'Rampbugs (losing all speed on a ramp) are fixed by default, like on modern surf servers.',
  'Boosters (trigger_push) add speed on top of yours — don’t strafe against them.',
  'Hold DUCK on low ceilings and tight ramps to shrink your hitbox from 72 to 54 units.',
  'Drop your own .bsp, .bsp.bz2, .rar or .zip anywhere on the menu to play any Source surf map.',
  'Maps without timer zones can be zoned in-game: type !zones.',
  'cl_showpos 1 shows your position, angles and velocity like in Source.',
  'Tier 1–2 maps are perfect for learning. Try surf_beginner, surf_utopia_njv or surf_kitsune first.',
  'The speedometer turns green while you gain speed and red while you lose it.',
];

/** Deterministic-but-shuffled tip order (avoids repeating the same tip every load). */
export function tipOrder(seed: number, n = SURF_TIPS.length): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let s = (seed >>> 0) || 1;
  for (let i = n - 1; i > 0; i--) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}
