// Small shared map widgets (name with dimmed prefix, KSF tier pill).
import { tierColor } from '../maps/catalog';
import { h } from './dom';
import { splitMapName } from './format';

export function mapNameEl(name: string, cls = 'map-name'): HTMLElement {
  const { prefix, rest } = splitMapName(name);
  return h('span', { class: cls }, prefix ? h('span.prefix', { text: prefix }) : null, rest);
}

export function tierPill(tier: number | null, long = false): HTMLElement {
  const el = h('span.pill.tier', { text: tier ? (long ? `Tier ${tier}` : `T${tier}`) : long ? 'Tier ?' : 'T?' });
  el.style.setProperty('--tier-color', tierColor(tier));
  return el;
}

