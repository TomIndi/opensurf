// CS:GO-like scoreboard (+showscores): server/map header, ranked rows (local player highlighted, replay bots).
import type { ScoreboardData } from '../game/api';
import { clear, h } from './dom';
import { formatTime, formatTimeShort } from './format';
import { icon } from './icons';
import { mapNameEl, tierPill } from './mapui';

export class Scoreboard {
  readonly el: HTMLElement;
  private readonly mapEl: HTMLElement;
  private readonly pillsEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly foot: HTMLElement;
  private visible = false;
  private lastKey = '';

  constructor() {
    this.mapEl = h('div.sb-map');
    this.pillsEl = h('div.sb-head-r');
    this.countEl = h('span');
    this.body = h('tbody');
    this.foot = h('div.sb-foot');
    this.el = h(
      'div.scoreboard.hidden',
      null,
      h('div.sb-head', null, h('div', null, h('div.sb-server', { text: 'SURF · Local server' }), this.mapEl), this.pillsEl),
      h('div.sb-team', null, h('span', { text: 'Surfers' }), this.countEl),
      h(
        'div.sb-scroll',
        null,
        h(
          'table.sb-table',
          null,
          h('thead', null, h('tr', null, h('th', { text: 'Rank' }), h('th', { text: 'Player' }), h('th', { text: 'Style' }), h('th.num', { text: 'Time' }), h('th.num', { text: 'Gap' }))),
          this.body,
        ),
      ),
      this.foot,
    );
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
  }

  render(d: ScoreboardData): void {
    const key = JSON.stringify(d);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.mapEl.replaceChildren(d.mapName ? mapNameEl(d.mapName) : h('span', { text: 'No map' }));
    this.pillsEl.replaceChildren(tierPill(d.tier, true));
    const rows = [...d.rows].sort((a, b) => {
      if (a.time === null && b.time === null) return Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name);
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return a.time - b.time;
    });
    this.countEl.textContent = `${rows.length} ${rows.length === 1 ? 'player' : 'players'}`;
    clear(this.body);
    const best = rows.find((r) => r.time !== null)?.time ?? null;
    if (!rows.length) {
      this.body.appendChild(h('tr', null, h('td.sb-empty', { attrs: { colspan: 5 }, text: 'No players' })));
    }
    for (const r of rows) {
      const tr = h('tr');
      if (r.isLocal) tr.classList.add('local');
      if (r.rank === 1 && r.time !== null) tr.classList.add('r1');
      tr.append(
        h('td.sb-rank', { text: r.time !== null && r.rank > 0 ? `#${r.rank}` : '—' }),
        h(
          'td',
          null,
          h(
            'span.sb-player',
            null,
            h(`span.sb-avatar${r.isBot ? '.bot' : ''}`, null, icon(r.isBot ? 'bot' : 'user')),
            r.name,
            r.isBot ? h('span.sb-tag', { text: 'Replay' }) : null,
            r.isLocal ? h('span.sb-tag', { text: 'You' }) : null,
          ),
        ),
        h('td.muted', { text: r.style ?? 'Normal' }),
        h('td.num.sb-time', { text: r.time !== null ? formatTime(r.time) : '—' }),
        h('td.num.muted', { text: r.time !== null && best !== null && r.time > best ? `+${formatTimeShort(r.time - best)}` : '' }),
      );
      this.body.appendChild(tr);
    }
    const timed = rows.filter((r) => r.time !== null).length;
    this.foot.replaceChildren(
      h('span', null, 'Server record ', h('b', { text: best !== null ? formatTime(best) : 'None' })),
      h('span', null, 'Completions ', h('b', { text: String(timed) })),
      h('span', { attrs: { style: 'margin-left:auto' } }, 'Hold ', h('span.kbd', { text: 'TAB' })),
    );
  }
}
