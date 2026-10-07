// Original line icons (24×24, currentColor). Static trusted markup only.
import { svg } from './dom';

const wrap = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  play: wrap('<path d="M7 4.5v15l12.5-7.5z"/>', true),
  settings: wrap(
    '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  ),
  keyboard: wrap('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>'),
  info: wrap('<circle cx="12" cy="12" r="9.5"/><path d="M12 16.5v-5M12 8h.01"/>'),
  console: wrap('<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9l3 3-3 3M12 15h5"/>'),
  close: wrap('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: wrap('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/>'),
  download: wrap('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>'),
  check: wrap('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  trash: wrap('<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M7 6.5l.8 13h8.4l.8-13"/>'),
  star: wrap('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', true),
  upload: wrap('<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
  cube: wrap('<path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2z"/><path d="M4 7.2l8 4.4 8-4.4M12 11.6v9.6"/>'),
  flag: wrap('<path d="M5 21V4M5 4.5h11l-2 3.5 2 3.5H5"/>'),
  list: wrap('<path d="M8.5 6h12M8.5 12h12M8.5 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  back: wrap('<path d="M15 5l-7 7 7 7"/>'),
  chevronRight: wrap('<path d="M9 5l7 7-7 7"/>'),
  chevronDown: wrap('<path d="M6 9l6 6 6-6"/>'),
  fullscreen: wrap('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  volume: wrap('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  refresh: wrap('<path d="M20 11.5a8 8 0 1 0-2.3 5.6M20 5v6.5h-6.5"/>'),
  warning: wrap('<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>'),
  mouse: wrap('<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6.5v4"/>'),
  monitor: wrap('<rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M8 20.5h8M12 16.5v4"/>'),
  crosshair: wrap('<path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6"/>'),
  hud: wrap('<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M7 16h4M15 8.5h2.5M15 16h2.5"/>'),
  sound: wrap('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'),
  game: wrap('<path d="M3 18.5L11 6l3 4.5 2-2.5 5 10.5z"/>'),
  bind: wrap('<rect x="3" y="7" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="7" width="7.5" height="7.5" rx="1.5"/><path d="M6.75 18h10.5"/>'),
  power: wrap('<path d="M12 3v8.5M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>'),
  resume: wrap('<path d="M7 4.5v15l12.5-7.5z"/>', true),
  restart: wrap('<path d="M4 12.5a8 8 0 1 0 2.3-5.6M4 5v6h6"/>'),
  map: wrap('<path d="M9 4.5L3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>'),
  exit: wrap('<path d="M14.5 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16.5L5.5 12 10 7.5M5.5 12H15"/>'),
  cloud: wrap('<path d="M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 10z"/>'),
  external: wrap('<path d="M14 4.5h5.5V10M19.5 4.5L11 13M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  copy: wrap('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.5"/><path d="M15.5 8.5V5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5h3"/>'),
  stage: wrap('<path d="M4 19h4v-5h4V9.5h4V5h4"/>'),
  timer: wrap('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M9.5 2.5h5"/>'),
  dice: wrap('<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01" stroke-width="2.6"/>'),
  user: wrap('<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>'),
  bot: wrap('<rect x="4.5" y="8" width="15" height="11" rx="2.5"/><path d="M12 4.5V8M9 13h.01M15 13h.01"/>'),
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = 'icon'): SVGSVGElement {
  return svg(ICONS[name], cls);
}

let logoSeq = 0;

/**
 * The SURF logo mark: a stylized surf ramp (triangular prism) with a carving trail. Each call gets unique
 * gradient ids — Chrome doesn't render url(#id) fills whose gradient lives in a display:none subtree.
 */
export function logoMarkSvg(): string {
  const a = `lm${++logoSeq}a`;
  const b = `lm${logoSeq}b`;
  return `<svg viewBox="0 0 64 64" aria-hidden="true" class="logo-mark">
  <defs>
    <linearGradient id="${a}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9be7ff"/><stop offset="1" stop-color="#3d8bff"/></linearGradient>
    <linearGradient id="${b}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a5bb8"/><stop offset="1" stop-color="#132a5c"/></linearGradient>
  </defs>
  <path d="M6 52 L30 10 L40 52 Z" fill="url(#${a})"/>
  <path d="M30 10 L58 52 L40 52 Z" fill="url(#${b})"/>
  <path d="M12 44 C 22 38, 30 30, 36 20" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".9"/>
</svg>`;
}
