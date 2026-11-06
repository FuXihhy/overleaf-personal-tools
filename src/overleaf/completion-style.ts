import type { CommandEntry } from '../core/types';

/** Mark only our command/source pairs; native suggestions keep their own layout. */
export function styleCompletionSources(document: Document, commands: readonly CommandEntry[]): void {
  const sources = new Map(commands.map(command => ['\\' + command.name, command.source]));
  const interfaceFont = document.defaultView?.getComputedStyle(document.body).fontFamily;
  for (const row of document.querySelectorAll<HTMLElement>('.cm-tooltip-autocomplete [role="option"]')) {
    const label = row.querySelector('.cm-completionLabel')?.textContent;
    const detail = row.querySelector<HTMLElement>('.cm-completionDetail');
    const owned = !!label && !!detail && sources.get(label) === detail.textContent;
    row.toggleAttribute('data-opt-completion', owned);
    if (owned) {
      detail!.title = detail!.textContent || '';
      if (interfaceFont) row.style.setProperty('--opt-interface-font',interfaceFont);
    } else row.style.removeProperty('--opt-interface-font');
  }
}

export function completionListChanged(records: MutationRecord[]): boolean {
  return records.some(record => {
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest('.cm-tooltip-autocomplete')) return true;
    return [...record.addedNodes].some(node => node instanceof Element &&
      (node.matches('.cm-tooltip-autocomplete') || node.querySelector('.cm-tooltip-autocomplete')));
  });
}

export const completionSourceStyles = `
  .cm-tooltip-autocomplete li[data-opt-completion]{display:flex!important;align-items:center;gap:0}
  .cm-tooltip-autocomplete li[data-opt-completion] .cm-completionLabel{flex:0 0 auto}
  .cm-tooltip-autocomplete li[data-opt-completion] .cm-completionDetail{
    flex:1 1 auto;min-width:0;max-width:18em;margin:0 12px;
    font-family:var(--font-sans,var(--bs-body-font-family,var(--opt-interface-font,inherit)))!important;
    font-size:var(--font-size-01,.75rem)!important;font-style:normal!important;
    font-weight:400!important;line-height:1.4;color:var(--bs-gray-600,#8a9099);
    opacity:.75;text-align:center;align-self:center;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis
  }
`;
