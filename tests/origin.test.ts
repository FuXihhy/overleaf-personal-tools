import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isOverleafOrigin, OVERLEAF_ORIGINS, requireSameOriginOverleaf } from '../src/overleaf/origin';

describe('exact Overleaf language origin boundary', () => {
  it('allows only the canonical HTTPS English and Chinese origins', () => {
    for (const origin of OVERLEAF_ORIGINS) expect(isOverleafOrigin(origin)).toBe(true);
    for (const origin of [undefined, 'https://overleaf.com', 'https://fr.overleaf.com', 'https://cn.overleaf.com:8443', 'https://cn.overleaf.com/', 'https://cn.overleaf.com@evil.test', 'https://cn.overleaf.com.evil.test', 'https://cn.overleaf.com.', 'http://cn.overleaf.com', 'https://user@cn.overleaf.com']) {
      expect(isOverleafOrigin(origin)).toBe(false);
    }
  });
  it('requires the request origin to match the current page even when both are allowed', () => {
    expect(requireSameOriginOverleaf(undefined, OVERLEAF_ORIGINS[1])).toBe(OVERLEAF_ORIGINS[1]);
    expect(requireSameOriginOverleaf(OVERLEAF_ORIGINS[0], OVERLEAF_ORIGINS[0])).toBe(OVERLEAF_ORIGINS[0]);
    expect(() => requireSameOriginOverleaf(OVERLEAF_ORIGINS[0], OVERLEAF_ORIGINS[1])).toThrow('同源');
    expect(() => requireSameOriginOverleaf(OVERLEAF_ORIGINS[1], OVERLEAF_ORIGINS[0])).toThrow('同源');
    expect(() => requireSameOriginOverleaf(OVERLEAF_ORIGINS[0], 'https://example.com')).toThrow('同源');
  });
  it('keeps manifest script and resource access confined to the same exact hosts', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const projects = OVERLEAF_ORIGINS.map(origin => `${origin}/project/*`);
    for (const script of manifest.content_scripts) expect(script.matches).toEqual(projects);
    for (const resources of manifest.web_accessible_resources) expect(resources.matches).toEqual(OVERLEAF_ORIGINS.map(origin => `${origin}/*`));
  });
});
