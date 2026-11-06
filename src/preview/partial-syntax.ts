import type ParseOptions from 'mathjax-full/js/input/tex/ParseOptions.js';
import { OpenItem, SubsupItem } from 'mathjax-full/js/input/tex/base/BaseItems.js';
import type { CheckType, StackItem, StackItemClass } from 'mathjax-full/js/input/tex/StackItem.js';
import TexError from 'mathjax-full/js/input/tex/TexError.js';

const STATE = 'personal-partial-syntax';
const OPEN_GROUP = 'personal-incomplete-group';
const RED = '#c62828';
interface RecoveryState { diagnostics: string[]; count: number }

function report(options: ParseOptions, message: string): void {
  const state = options.packageData.get(STATE) as RecoveryState;
  // Recovery never reparses source or resets MathJax's macro/buffer counters.
  // Bound malformed structures too, independently of the input length limit.
  if (++state.count > 64) throw new TexError('PersonalSyntaxLimit', '未完成的公式结构超过预览限制');
  state.diagnostics.push(message);
}

class PartialSubsupItem extends SubsupItem {
  checkItem(item: StackItem): CheckType | null {
    const unfinishedGroup = item.isKind('mml') && item.First.getProperty(OPEN_GROUP);
    // These boundaries cannot be a script argument. Replay them so enclosing
    // groups, fractions, matrices and following content keep their own layout.
    const boundary = ['stop', 'close', 'right', 'end', 'cell'].includes(item.kind);
    if (!boundary && !unfinishedGroup) return super.checkItem(item);

    const position = Number(this.getProperty('position'));
    const marker = position === 1 ? '_' : '^';
    report(this.factory.configuration, `未完成的${position === 1 ? '下' : '上'}标：${marker}`);
    const top = this.First;
    const bare = !top.childNodes[1] && !top.childNodes[2] && !this.getProperty('primes');
    // Let MathJax finish the existing script node, including primes/operator
    // limits. Only the newly missing argument is empty; the literal marker
    // below makes the incomplete input visible rather than silently fixing it.
    const completed = super.checkItem(this.factory.create('mml', this.create('node', 'mrow', [])))!;
    const base = bare ? top.childNodes[0] : (completed[0][0] as StackItem).First;
    const children = [base, this.create('token', 'mtext', {}, marker)];
    if (unfinishedGroup) children.push(item.First);
    const fragment = this.create('node', 'mrow', children, { mathcolor: RED });
    return [[this.factory.create('mml', fragment), ...(boundary ? [item] : [])], true];
  }
}

class PartialOpenItem extends OpenItem {
  checkItem(item: StackItem): CheckType {
    if (!item.isKind('stop')) return super.checkItem(item);
    report(this.factory.configuration, '未完成的分组：缺少右花括号');
    // Keep the opening brace visible. No closing brace or argument is guessed.
    const fragment = this.create('node', 'mrow', [
      this.create('token', 'mtext', {}, '{'), this.toMml(),
    ], { mathcolor: RED });
    fragment.setProperty(OPEN_GROUP, true);
    return [[this.factory.create('mml', fragment), item], true];
  }
}

/** Per-renderer overrides: strict renders and Overleaf's MathJax stay untouched. */
export function enablePartialSyntax(options: ParseOptions, diagnostics: string[]): void {
  options.packageData.set(STATE, { diagnostics, count: 0 } satisfies RecoveryState);
  // MathJax's generic FactoryNodeClass declares a broader factory constructor
  // than its own BaseItem subclasses. This factory always passes StackItemFactory.
  options.itemFactory.setNodeClass('subsup', PartialSubsupItem as unknown as StackItemClass);
  options.itemFactory.setNodeClass('open', PartialOpenItem as unknown as StackItemClass);
}
