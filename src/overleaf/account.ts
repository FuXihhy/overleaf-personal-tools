/** The account ID is emitted by Overleaf's layout; no email or cookie is read. */
export function readOverleafAccount(document: Document = globalThis.document): string | undefined {
  let value = document.querySelector<HTMLMetaElement>('meta[name="ol-user_id"]')?.content?.trim();
  if (value?.startsWith('"')) { try { value = JSON.parse(value); } catch { return; } }
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : undefined;
}
