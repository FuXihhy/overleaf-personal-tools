import { describe, expect, it } from 'vitest';
import { resolveSourceLocation } from '../src/overleaf/source-location';

const quote = (text: string, from = 0, before = '', after = '') => ({ text, from, to: from + text.length, before, after });

describe('saved source quote locations', () => {
  it('prefers an unchanged exact range even for repeated text', () => {
    expect(resolveSourceLocation('chosen chosen', quote('chosen', 7))).toEqual({ ok: true, from: 7, to: 13 });
  });
  it('relocates a unique exact quote after insertions and deletions', () => {
    expect(resolveSourceLocation('new prefix\nchosen $\\cN$\nend', quote('chosen $\\cN$', 2)))
      .toEqual({ ok: true, from: 11, to: 23 });
    expect(resolveSourceLocation('chosen', quote('chosen', 100)))
      .toEqual({ ok: true, from: 0, to: 6 });
  });
  it('uses adjacent source context to identify the right repeated passage', () => {
    const source = 'new\nfirst: chosen; end\nsecond: chosen; end';
    const from = source.lastIndexOf('chosen');
    expect(resolveSourceLocation(source, quote('chosen', 0, 'second: ', '; end')))
      .toEqual({ ok: true, from, to: from + 6 });
  });
  it('does not require distant context to stay unchanged', () => {
    const adjacent = 'a'.repeat(256);
    const source = 'changed distant text\n' + adjacent + 'chosen end\nother chosen end';
    const from = source.indexOf('chosen');
    expect(resolveSourceLocation(source, quote('chosen', 0, 'old distant text\n' + adjacent, ' end\nother chosen end')))
      .toEqual({ ok: true, from, to: from + 6 });
  });
  it('rejects ambiguous or edited passages instead of guessing by a stale line', () => {
    expect(resolveSourceLocation('first chosen, then chosen', quote('chosen', 0))).toEqual({ ok: false, reason: 'ambiguous' });
    expect(resolveSourceLocation('first chosen, then chosen', quote('chosen', 0, 'old context'))).toEqual({ ok: false, reason: 'ambiguous' });
    expect(resolveSourceLocation('chosen changed', quote('chosen original', 0))).toEqual({ ok: false, reason: 'missing' });
    expect(resolveSourceLocation('x'.repeat(2048), quote('x', 3000))).toEqual({ ok: false, reason: 'ambiguous' });
  });
  it('keeps Unicode and normalized line-break positions in source coordinates', () => {
    const source = 'intro\nchosen 😀\n$\\cN$\nafter';
    const text = 'chosen 😀\n$\\cN$';
    expect(resolveSourceLocation(source, quote(text, 0))).toEqual({ ok: true, from: 6, to: 6 + text.length });
  });
});
