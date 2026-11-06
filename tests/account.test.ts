// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readOverleafAccount } from '../src/overleaf/account';
afterEach(() => { document.head.replaceChildren(); });
describe('Overleaf account identity', () => {
  it('uses the logged-in account marker and normalizes its ID', () => {
    document.head.innerHTML='<meta name="ol-user_id" content="ABCDEF0123456789ABCDEF01"><meta name="ol-usersEmail" content="ignored">';
    expect(readOverleafAccount()).toBe('abcdef0123456789abcdef01');
  });
  it('accepts the JSON-encoded layout value', () => {
    const meta=document.createElement('meta');meta.name='ol-user_id';meta.content=JSON.stringify('abcdef0123456789abcdef01');document.head.append(meta);
    expect(readOverleafAccount()).toBe('abcdef0123456789abcdef01');
  });
  it('does not infer an account from email or absent/malformed values', () => {
    expect(readOverleafAccount()).toBeUndefined();
    document.head.innerHTML='<meta name="ol-user_id" content="not-an-account"><meta name="ol-usersEmail" content="ignored">';
    expect(readOverleafAccount()).toBeUndefined();
  });
});
