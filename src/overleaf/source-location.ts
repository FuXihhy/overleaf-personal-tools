import type { CodexSelection } from '../codex/types';

type SourceQuote = Pick<CodexSelection, 'text' | 'from' | 'to' | 'before' | 'after'>;
export type SourceLocation = { ok: true; from: number; to: number }
  | { ok: false; reason: 'missing' | 'ambiguous' };

/** Resolve a saved quote against current source without guessing by line number. */
export function resolveSourceLocation(source: string, quote: SourceQuote): SourceLocation {
  if (!quote.text) return { ok: false, reason: 'missing' };
  if (Number.isSafeInteger(quote.from) && quote.from >= 0 && quote.to <= source.length
    && quote.to - quote.from === quote.text.length && source.slice(quote.from, quote.to) === quote.text) {
    return { ok: true, from: quote.from, to: quote.to };
  }

  const matches: number[] = [];
  for (let from = source.indexOf(quote.text); from !== -1; from = source.indexOf(quote.text, from + 1)) {
    matches.push(from);
    // Pathological short quotes must not turn a click into an unbounded scan.
    if (matches.length > 1024) return { ok: false, reason: 'ambiguous' };
  }
  if (!matches.length) return { ok: false, reason: 'missing' };
  if (matches.length === 1) return { ok: true, from: matches[0], to: matches[0] + quote.text.length };

  // Use adjacent context, rather than the entire document excerpt: edits far
  // away from the quoted passage should not invalidate an otherwise exact hit.
  const before = quote.before.slice(-256), after = quote.after.slice(0, 256);
  if (!before && !after) return { ok: false, reason: 'ambiguous' };
  const anchored = matches.filter(from => (!before || source.slice(Math.max(0, from - before.length), from) === before)
    && (!after || source.slice(from + quote.text.length, from + quote.text.length + after.length) === after));
  if (anchored.length !== 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, from: anchored[0], to: anchored[0] + quote.text.length };
}
