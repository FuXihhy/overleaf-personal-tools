/** Exact language sites verified in Overleaf's deployed language menu. */
export const OVERLEAF_ORIGINS = ['https://www.overleaf.com', 'https://cn.overleaf.com'] as const;
export type OverleafOrigin = typeof OVERLEAF_ORIGINS[number];

export function isOverleafOrigin(value: unknown): value is OverleafOrigin {
  return typeof value === 'string' && (OVERLEAF_ORIGINS as readonly string[]).includes(value);
}

/**
 * Allowlisting both language sites does not permit crossing between sessions.
 * In a browser, every supplied transport origin must equal the current page.
 * An explicit origin can be supplied without location only in nonbrowser tests.
 */
export function requireSameOriginOverleaf(
  requested?: string,
  current = typeof location === 'undefined' ? undefined : location.origin,
): OverleafOrigin {
  const origin = requested ?? current;
  if (!isOverleafOrigin(origin)) throw new Error('仅支持 Overleaf 的 www.overleaf.com 和 cn.overleaf.com 网站。');
  if (current !== undefined && current !== origin) throw new Error('Overleaf 请求必须与当前页面同源。');
  return origin;
}
