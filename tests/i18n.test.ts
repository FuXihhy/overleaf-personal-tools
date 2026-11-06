// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocale, observeLocale } from '../src/i18n';

const metadata = (code: string) => {
  const meta = document.createElement('meta');
  meta.name = 'ol-i18n'; meta.content = JSON.stringify({ currentLangCode: code });
  document.head.append(meta); return meta;
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { document.head.replaceChildren(); document.documentElement.removeAttribute('lang'); vi.restoreAllMocks(); });

describe('Overleaf UI language', () => {
  it('uses the site metadata over HTML and browser preferences', () => {
    document.documentElement.lang = 'zh-CN';
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    const meta = metadata('en');
    expect(getLocale()).toBe('en');
    document.documentElement.lang = 'en';
    meta.content = JSON.stringify({ currentLangCode: 'zh-CN' });
    expect(getLocale()).toBe('zh');
    meta.content = JSON.stringify({ currentLangCode: 'fr' });
    document.documentElement.lang = 'zh-CN';
    expect(getLocale()).toBe('en');
  });
  it('falls back safely when metadata is missing or malformed', () => {
    expect(getLocale()).toBe('en');
    document.documentElement.lang = 'zh-Hant';
    const meta = metadata('en'); meta.content = '{';
    expect(getLocale()).toBe('zh');
    meta.content = JSON.stringify({ currentLangCode: { bad: true } });
    expect(getLocale()).toBe('zh');
  });
  it('notifies only language changes and cleans up all observers', async () => {
    document.documentElement.lang = 'en';
    const changed = vi.fn(); const stop = observeLocale(changed);
    const meta = metadata('zh-CN'); await flush();
    expect(changed.mock.calls).toEqual([['zh']]);
    document.head.append(document.createElement('style')); await flush();
    expect(changed).toHaveBeenCalledOnce();
    meta.content = JSON.stringify({ currentLangCode: 'en' }); await flush();
    expect(changed.mock.calls).toEqual([['zh'], ['en']]);
    stop(); meta.remove(); document.documentElement.lang = 'zh-CN'; await flush();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
