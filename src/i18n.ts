export { translateRuntimeText } from './i18n-runtime';

export type Locale = 'en' | 'zh';

function normalizeLocale(value: string): Locale {
  return /^zh(?:-|$)/i.test(value.trim().replaceAll('_', '-')) ? 'zh' : 'en';
}

/** Follow Overleaf's UI selection, never the browser's preferred language.
 * The site's own i18n bootstrap reads ol-i18n.currentLangCode. An unsupported
 * explicit site language falls back to English rather than a stale HTML hint.
 */
export function getLocale(): Locale {
  if (typeof document === 'undefined') return 'en';
  const metadata = document.querySelector<HTMLMetaElement>('meta[name="ol-i18n"]');
  if (metadata?.content) {
    try {
      const code: unknown = JSON.parse(metadata.content)?.currentLangCode;
      if (typeof code === 'string' && code.trim()) return normalizeLocale(code);
    } catch { /* Incomplete metadata can appear during page setup. */ }
  }
  return normalizeLocale(document.documentElement.lang || 'en');
}

/** Usually a language change reloads Overleaf on its language domain. Also
 * handle in-place metadata changes without observing editor/body mutations.
 */
export function observeLocale(callback: (locale: Locale) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  let locale = getLocale();
  let disposed = false;
  let queued = false;
  let head = document.head;
  const check = () => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      const next = getLocale();
      if (next !== locale) { locale = next; callback(next); }
    });
  };
  const headObserver = new MutationObserver(check);
  const watchHead = () => {
    headObserver.disconnect();
    head = document.head;
    if (head) headObserver.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['name', 'content'] });
  };
  const rootObserver = new MutationObserver(() => {
    if (head !== document.head) watchHead();
    check();
  });
  rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'], childList: true });
  watchHead();
  return () => { disposed = true; rootObserver.disconnect(); headObserver.disconnect(); };
}
