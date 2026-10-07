// Tiny DOM helpers for the plain-TS UI (no framework).

export type Child = Node | string | number | null | undefined | false | Child[];

export interface HProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration> | Record<string, string>;
  dataset?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
}

/**
 * h('div.panel.dark', { text: 'hi' }, child, ...) — tag with optional dot-separated classes and #id.
 */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}.${string}` | `${K}#${string}`, props?: HProps | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(spec: string, props?: HProps | null, ...children: Child[]): HTMLElement;
export function h(spec: string, props?: HProps | null, ...children: Child[]): HTMLElement {
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(spec);
  const tag = m ? m[1] : 'div';
  const el = document.createElement(tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (props) {
    if (props.class) for (const c of props.class.split(/\s+/)) if (c) el.classList.add(c);
    if (props.text !== undefined) el.textContent = props.text;
    if (props.title) el.title = props.title;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === undefined || v === false) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.style) Object.assign(el.style, props.style);
    if (props.dataset) Object.assign(el.dataset, props.dataset);
    if (props.on) {
      for (const [ev, fn] of Object.entries(props.on)) if (fn) el.addEventListener(ev, fn as EventListener);
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (typeof c === 'string' || typeof c === 'number') parent.appendChild(document.createTextNode(String(c)));
    else parent.appendChild(c);
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Creates an element from trusted, static SVG markup (icons). */
export function svg(markup: string, cls?: string): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const s = t.content.firstElementChild as SVGSVGElement;
  if (cls) s.classList.add(...cls.split(' '));
  return s;
}

/**
 * A text slot that only touches the DOM when its value changes (HUD hot path).
 * Uses a Text node so updates don't rebuild child lists.
 */
export class TextSlot {
  readonly node: Text;
  private value = '';
  constructor(parent: Node, initial = '') {
    this.node = document.createTextNode(initial);
    this.value = initial;
    parent.appendChild(this.node);
  }
  set(v: string): void {
    if (v !== this.value) {
      this.value = v;
      this.node.data = v;
    }
  }
  get(): string {
    return this.value;
  }
}

/** Toggles a class only if the state changed (cheap per-frame use). */
export class ClassToggle {
  private state: boolean | null = null;
  constructor(
    private readonly el: Element,
    private readonly cls: string,
  ) {}
  set(on: boolean): void {
    if (on !== this.state) {
      this.state = on;
      this.el.classList.toggle(this.cls, on);
    }
  }
}

/** Sets a class from a group (e.g. state-running / state-finished) only when it changes. */
export class ClassSwitch {
  private current = '';
  constructor(private readonly el: Element) {}
  set(cls: string): void {
    if (cls === this.current) return;
    if (this.current) this.el.classList.remove(this.current);
    if (cls) this.el.classList.add(cls);
    this.current = cls;
  }
}

export function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return !el.readOnly && !el.disabled && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(t);
  }
  if (el instanceof HTMLSelectElement) return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
