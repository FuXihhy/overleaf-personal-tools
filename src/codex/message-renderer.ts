/** A small, inert Markdown renderer with stable nodes for streamed answers. */
export type MathRenderer = (source: string, display: boolean) => Promise<string>;
export interface MessageRenderOptions {
  renderMath?: MathRenderer;
  isCurrent?: () => boolean;
  /** Called synchronously around DOM changes, including later math hydration. */
  onLayout?: (mutate: () => void) => void;
}

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** MathJax is bundled by this extension. Still reject active SVG constructs. */
export function safeMathSvg(source: string, document: Document): SVGElement | undefined {
  if (!source || source.length > 2_000_000) return undefined;
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.documentElement.localName !== 'svg' || parsed.querySelector('parsererror,script,foreignObject,iframe,image,style,animate,set')) return undefined;
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (/^on/i.test(attribute.name) || /url\s*\(/i.test(attribute.value)) return undefined;
      if (/(?:^|:)href$/i.test(attribute.name) && !attribute.value.startsWith('#')) return undefined;
    }
  }
  return document.importNode(parsed.documentElement, true) as unknown as SVGElement;
}

interface MathSpec { source: string; display: boolean; original: string }
interface MathJob { node: HTMLElement; spec: MathSpec; state: 'queued' | 'running' | 'done' }
interface RenderState {
  target: HTMLElement; options: MessageRenderOptions; revision: number; active: boolean;
  queue: MathJob[]; timer?: ReturnType<typeof setTimeout>; pumping: boolean;
}
const renderStates = new WeakMap<HTMLElement, RenderState>();
const mathSpecs = new WeakMap<Node, MathSpec>();
const mathJobs = new WeakMap<Node, MathJob>();
/** Source belongs to the parsed formula, never to its generated SVG glyphs. */
export function getRenderedMathSource(node: Node): Readonly<MathSpec> | undefined { return mathSpecs.get(node); }
const sameMath = (left?: MathSpec, right?: MathSpec) => !!left && !!right && left.source === right.source && left.display === right.display;
const isLive = (state: RenderState) => state.active && (state.options.isCurrent?.() ?? true);
const withLayout = (state: RenderState, mutate: () => void) => state.options.onLayout ? state.options.onLayout(mutate) : mutate();

/** Preserve text/block identities and already-rendered SVGs as the answer grows. */
function reconcile(parent: Node, desired: Node[]): void {
  for (let i = 0; i < desired.length; i++) {
    const next = desired[i], existing = parent.childNodes[i];
    if (!existing) { parent.appendChild(next); continue; }
    const previousMath = mathSpecs.get(existing), nextMath = mathSpecs.get(next);
    if (sameMath(previousMath, nextMath)) { mathSpecs.set(existing, nextMath!); continue; }
    if (previousMath || nextMath || existing.nodeType !== next.nodeType || existing.nodeName !== next.nodeName) {
      parent.replaceChild(next, existing); continue;
    }
    if (next.nodeType === Node.TEXT_NODE) {
      if (existing.nodeValue !== next.nodeValue) existing.nodeValue = next.nodeValue;
      continue;
    }
    if (existing instanceof Element && next instanceof Element) {
      for (const attribute of [...existing.attributes]) if (!next.hasAttribute(attribute.name)) existing.removeAttribute(attribute.name);
      for (const attribute of next.attributes) if (existing.getAttribute(attribute.name) !== attribute.value) existing.setAttribute(attribute.name, attribute.value);
      reconcile(existing, [...next.childNodes]);
    }
  }
  while (parent.childNodes.length > desired.length) parent.lastChild!.remove();
}

/** Render in small tasks: a long answer must not stop rendering at its 81st formula. */
function pumpMath(state: RenderState): void {
  if (!isLive(state) || state.pumping || state.timer || !state.queue.length) return;
  state.pumping = true;
  const batch: MathJob[] = [];
  while (state.queue.length && batch.length < 6) {
    const job = state.queue.shift()!;
    if (state.target.contains(job.node)) { job.state = 'running'; batch.push(job); }
    else mathJobs.delete(job.node);
  }
  void Promise.all(batch.map(async job => {
    try {
      const svg = await state.options.renderMath?.(job.spec.source, job.spec.display);
      if (!isLive(state) || !state.target.contains(job.node) || !sameMath(mathSpecs.get(job.node), job.spec)) return;
      const safe = svg ? safeMathSvg(svg, state.target.ownerDocument) : undefined;
      if (safe) withLayout(state, () => {
        job.node.replaceChildren(safe); job.node.setAttribute('aria-label', job.spec.source);
      });
    } catch { /* Keep exact, selectable source if this expression is malformed. */ }
    finally {
      job.state = 'done';
      // A caller may dispose a still-mounted view and later resume it. Do not
      // cache a cancelled hydration as if it had produced a finished SVG.
      if (!isLive(state) || !state.target.contains(job.node)) mathJobs.delete(job.node);
    }
  })).finally(() => {
    state.pumping = false;
    if (isLive(state) && state.queue.length) state.timer = setTimeout(() => { state.timer = undefined; pumpMath(state); }, 0);
  });
}

const environmentNames = 'equation\\*?|align\\*?|alignat\\*?|gather\\*?|multline\\*?|eqnarray\\*?|displaymath|aligned|alignedat|gathered|split|cases';
const environmentOpening = new RegExp('^\\\\begin\\{(' + environmentNames + ')\\}');
/** One state per block: each source line is scanned once, even in long prose. */
class MathBoundary {
  private closing?: string;
  private codeTicks?: string;
  get open(): boolean { return this.closing !== undefined; }
  scan(source: string): void {
    for (let i = 0; i < source.length;) {
      if (this.closing) {
        const end = source.indexOf(this.closing, i);
        if (end < 0) return;
        i = end + this.closing.length; this.closing = undefined; continue;
      }
      if (this.codeTicks) {
        const end = source.indexOf(this.codeTicks, i);
        if (end < 0) return;
        i = end + this.codeTicks.length; this.codeTicks = undefined; continue;
      }
      if (source[i] === '`') {
        this.codeTicks = /^`+/.exec(source.slice(i))![0]; i += this.codeTicks.length; continue;
      }
      const token = source.startsWith('\\[', i) ? ['\\[', '\\]'] : source.startsWith('\\(', i) ? ['\\(', '\\)']
        : source.startsWith('$$', i) && source[i - 1] !== '\\' ? ['$$', '$$'] : undefined;
      // Environment names are bounded; avoid allocating the remainder of a
      // potentially very long line at every backslash.
      const environment = source[i] === '\\' ? environmentOpening.exec(source.slice(i, i + 32)) : null;
      const pair = token || (environment ? [environment[0], `\\end{${environment[1]}}`] : undefined);
      if (pair) { this.closing = pair[1]; i += pair[0].length; }
      else i++;
    }
  }
}

function parseMessage(document: Document, text: string): DocumentFragment {
  const math = (parent: Node, source: string, display: boolean, original: string) => {
    // Spans also allow display equations inside list items and paragraphs.
    const node = document.createElement('span');
    node.className = display ? 'opt-codex-math opt-codex-math-display' : 'opt-codex-math';
    node.textContent = original; node.tabIndex = 0; node.setAttribute('role', 'math'); node.setAttribute('aria-label', source.trim());
    mathSpecs.set(node, { source: source.trim(), display, original }); parent.appendChild(node);
  };
  const inline = (parent: Node, source: string, depth = 0) => {
    if (depth > 5) { parent.appendChild(document.createTextNode(source)); return; }
    const tokens = new RegExp('(?<ticks>`+)(?<code>[\\s\\S]*?)\\k<ticks>'
      + '|\\\\\\((?<inline>[\\s\\S]*?)\\\\\\)'
      + '|\\\\\\[(?<display>[\\s\\S]*?)\\\\\\]'
      + '|(?<!\\\\)\\$\\$(?<dollarDisplay>[\\s\\S]*?)(?<!\\\\)\\$\\$'
      + '|(?<![\\\\$])\\$(?!\\$)(?<dollar>[^\\n$]+?)(?<!\\\\)\\$(?!\\$)'
      + '|(?<environment>\\\\begin\\{(?<env>' + environmentNames + ')\\}[\\s\\S]*?\\\\end\\{\\k<env>\\})'
      + '|\\[(?<link>[^\\]\\n]+)\\]\\((?<href>[^\\s)]+)\\)'
      + '|\\*\\*(?<bold>[^*\\n]+)\\*\\*|__(?<boldAlt>[^_\\n]+)__|\\*(?<italic>[^*\\n]+)\\*', 'g');
    let offset = 0;
    for (const match of source.matchAll(tokens)) {
      parent.appendChild(document.createTextNode(source.slice(offset, match.index)));
      const part = match.groups!;
      if (part.ticks) {
        const code = document.createElement('code'); code.textContent = part.code; parent.appendChild(code);
      } else if (part.inline !== undefined || part.dollar !== undefined) {
        math(parent, part.inline ?? part.dollar, false, match[0]);
      } else if (part.display !== undefined || part.dollarDisplay !== undefined || part.environment !== undefined) {
        math(parent, part.display ?? part.dollarDisplay ?? part.environment, true, match[0]);
      } else if (part.link) {
        const href = safeHref(part.href);
        if (href) {
          const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = part.link; parent.appendChild(link);
        } else parent.appendChild(document.createTextNode(match[0]));
      } else {
        const emphasis = document.createElement(part.bold || part.boldAlt ? 'strong' : 'em');
        inline(emphasis, part.bold ?? part.boldAlt ?? part.italic, depth + 1); parent.appendChild(emphasis);
      }
      offset = match.index! + match[0].length;
    }
    parent.appendChild(document.createTextNode(source.slice(offset)));
  };
  const listPattern = /^(\s*)(?:([-+*])|(\d+)\.)\s+(.+)$/;
  const isBlock = (line: string) => /^\s*(?:`{3,}|~{3,}|\\\[|\$\$|\\begin\{|#{1,6}\s|>\s?|[-+*]\s|\d+\.\s)/.test(line);
  const blocks = (parent: Node, source: string, depth = 0) => {
    if (depth > 8) { const p = document.createElement('p'); inline(p, source); parent.appendChild(p); return; }
    const lines = source.split('\n');
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
      if (fence) {
        const code = document.createElement('code'), pre = document.createElement('pre'), body: string[] = []; i++;
        while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        code.textContent = body.join('\n'); if (fence[2]) code.dataset.language = fence[2].slice(0, 40);
        pre.append(code); parent.appendChild(pre); continue;
      }
      if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) { parent.appendChild(document.createElement('hr')); i++; continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        const h = document.createElement('h' + Math.min(heading[1].length + 2, 6)); inline(h, heading[2]); parent.appendChild(h); i++; continue;
      }
      const list = listPattern.exec(line);
      if (list) {
        const indent = list[1].length, ordered = !!list[3];
        const root = document.createElement(ordered ? 'ol' : 'ul');
        if (ordered && Number(list[3]) !== 1) root.setAttribute('start', list[3]);
        while (i < lines.length) {
          const item = listPattern.exec(lines[i]);
          if (!item || item[1].length !== indent || !!item[3] !== ordered) break;
          const body = [item[4]], boundary = new MathBoundary(); boundary.scan(item[4]); i++;
          while (i < lines.length) {
            const next = lines[i], nextItem = listPattern.exec(next);
            if (boundary.open) { const continuation = next.replace(new RegExp(`^ {0,${indent + 2}}`), ''); body.push(continuation); boundary.scan(continuation); i++; continue; }
            if (nextItem && nextItem[1].length <= indent) break;
            if (!next.trim()) {
              let after = i + 1; while (after < lines.length && !lines[after].trim()) after++;
              const following = listPattern.exec(lines[after] || '');
              if (following && following[1].length === indent && !!following[3] === ordered) { i = after; break; }
              if (after >= lines.length || (lines[after].match(/^\s*/)?.[0].length ?? 0) <= indent) { i = after; break; }
            } else if ((next.match(/^\s*/)?.[0].length ?? 0) <= indent && isBlock(next)) break;
            const continuation = next.replace(new RegExp(`^ {0,${indent + 2}}`), ''); body.push(continuation); boundary.scan(continuation); i++;
          }
          const li = document.createElement('li'); blocks(li, body.join('\n'), depth + 1); root.append(li);
        }
        parent.appendChild(root); continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = document.createElement('blockquote'), body: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
        blocks(quote, body.join('\n'), depth + 1); parent.appendChild(quote); continue;
      }
      const p = document.createElement('p'), body = [line], boundary = new MathBoundary(); boundary.scan(line); i++;
      while (i < lines.length && (boundary.open || lines[i].trim() && !isBlock(lines[i]))) { const continuation = lines[i++]; body.push(continuation); boundary.scan(continuation); }
      inline(p, body.join('\n')); parent.appendChild(p);
    }
  };
  const fragment = document.createDocumentFragment(); blocks(fragment, text.replace(/\r\n?/g, '\n')); return fragment;
}

export function renderAssistantMessage(target: HTMLElement, text: string, options: MessageRenderOptions = {}): () => void {
  let state = renderStates.get(target);
  if (!state) {
    state = { target, options, revision: 0, active: true, queue: [], pumping: false };
    renderStates.set(target, state);
  }
  state.options = options; state.active = true;
  const revision = ++state.revision, current = state;
  const fragment = parseMessage(target.ownerDocument, text);
  withLayout(current, () => reconcile(target, [...fragment.childNodes]));
  if (options.renderMath) for (const node of target.querySelectorAll<HTMLElement>('.opt-codex-math')) {
    const spec = mathSpecs.get(node);
    if (!spec || spec.source.length > 12_000 || mathJobs.has(node)) continue;
    const job: MathJob = { node, spec, state: 'queued' }; mathJobs.set(node, job); current.queue.push(job);
  }
  pumpMath(current);
  return () => {
    if (current.revision !== revision) return;
    current.active = false;
    clearTimeout(current.timer); current.timer = undefined;
  };
}
