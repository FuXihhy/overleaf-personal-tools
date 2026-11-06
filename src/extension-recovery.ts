import { getLocale, observeLocale } from './i18n';

const BUTTON_ID = 'opt-extension-recovery';
const TOOLTIP_ID = 'opt-extension-recovery-tooltip';
const STYLE_ID = 'opt-extension-recovery-style';
export interface ExtensionRecoveryNotice { destroy(): void }
export interface ExtensionRecoveryOptions { refresh?(): void }
let current: ExtensionRecoveryNotice | undefined;

/** This notice belongs to a retired content script. It must use only DOM APIs:
 * looking up another extension asset or sending a message can throw again. */
export function mountExtensionRecoveryNotice(options: ExtensionRecoveryOptions = {}): ExtensionRecoveryNotice {
  if (current) return current;
  let destroyed = false, queued = false;
  const button = document.createElement('button'); button.id = BUTTON_ID; button.type = 'button'; button.className = 'ide-rail-tab-link nav-link';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 6.66M20 4v7h-7"/></svg><span class="opt-recovery-indicator" aria-hidden="true"></span>';
  const tooltip = document.createElement('div'); tooltip.id = TOOLTIP_ID;
  // Chrome 145+ supplies native interest invokers. The DOM-only fallback also
  // keeps recovery usable in embedded/test DOMs without requesting retired assets.
  const nativeInterest = 'interestForElement' in HTMLButtonElement.prototype;
  tooltip.setAttribute('popover', 'hint');
  if ('popover' in tooltip && tooltip.popover !== 'hint') tooltip.setAttribute('popover', 'auto');
  if (nativeInterest) button.setAttribute('interestfor', TOOLTIP_ID);
  else { tooltip.hidden = true; tooltip.setAttribute('popover', 'manual'); tooltip.setAttribute('role', 'tooltip'); }
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let positionFrame: number | undefined;
  const style = document.createElement('style'); style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID}{position:relative;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-sizing:border-box;border:0;background:transparent;color:var(--ide-rail-color,inherit);font:inherit;cursor:pointer;border-radius:6px;box-shadow:none;--interest-delay-start:.25s;interest-delay-start:var(--interest-delay-start);--interest-delay-end:.15s;interest-delay-end:var(--interest-delay-end)}
    #${BUTTON_ID}:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
    #${BUTTON_ID}:active{background:color-mix(in srgb,currentColor 15%,transparent)}
    #${BUTTON_ID}:focus-visible{outline:2px solid var(--link-color,#8bb3e5);outline-offset:-2px}
    #${BUTTON_ID} svg{display:block;width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}
    #${BUTTON_ID} .opt-recovery-indicator{position:absolute;right:4px;top:4px;width:4px;height:4px;border-radius:50%;background:#83c99b;pointer-events:none}
    #${TOOLTIP_ID}{position:fixed;inset:auto;margin:0;z-index:10040;max-width:min(260px,calc(100vw - 16px));box-sizing:border-box;padding:6px 9px;border:1px solid #ffffff12;border-radius:5px;background:#111820;color:#fff;box-shadow:0 2px 8px #0003;font:inherit;font-size:12px;font-weight:400;line-height:18px;overflow-wrap:anywhere}
    #${TOOLTIP_ID}[hidden]{display:none!important}
    @media(forced-colors:active){#${BUTTON_ID} .opt-recovery-indicator{background:Highlight}#${TOOLTIP_ID}{border-color:CanvasText;background:Canvas;color:CanvasText}}
  `;
  function updateLabel() {
    const label = getLocale() === 'zh' ? '扩展已更新，刷新此页恢复' : 'Extension updated — refresh this page';
    button.setAttribute('aria-label', label); tooltip.textContent = label;
  }
  function hideTooltip() {
    clearTimeout(hideTimer);
    if (positionFrame !== undefined) cancelAnimationFrame(positionFrame);
    positionFrame = undefined;
    tooltip.hidePopover?.();
    if (!nativeInterest) { tooltip.hidden = true; button.removeAttribute('aria-describedby'); }
  }
  function positionTooltip() {
    positionFrame = undefined;
    if (destroyed || !button.isConnected) return;
    const rect = button.getBoundingClientRect();
    tooltip.style.fontFamily = getComputedStyle(button).fontFamily;
    tooltip.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - tooltip.offsetWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(rect.top + (rect.height - tooltip.offsetHeight) / 2, window.innerHeight - tooltip.offsetHeight - 8))}px`;
  }
  function showTooltip() {
    clearTimeout(hideTimer);
    if (destroyed || !button.isConnected || nativeInterest) return;
    tooltip.hidden = false; button.setAttribute('aria-describedby', TOOLTIP_ID);
    tooltip.showPopover?.(); positionTooltip();
  }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hideTooltip, 150); }
  tooltip.addEventListener('beforetoggle', event => {
    if ((event as ToggleEvent).newState === 'open') {
      positionTooltip(); positionFrame = requestAnimationFrame(positionTooltip);
    }
  });
  function mount() {
    queued = false; if (destroyed) return;
    const wrapper = document.querySelector<HTMLElement>('nav.ide-rail .ide-rail-tabs-wrapper');
    if (!wrapper) return;
    if (!style.isConnected) document.head?.append(style);
    if (tooltip.parentElement !== document.body) document.body?.append(tooltip);
    const ai = wrapper.querySelector('#ide-rail-tabs-tab-workbench');
    if (ai) { if (ai.nextElementSibling !== button) ai.after(button); }
    else if (button.parentElement !== wrapper) wrapper.append(button);
  }
  function queueMount() { if (!destroyed && !queued) { queued = true; queueMicrotask(mount); } }
  const observer = new MutationObserver(queueMount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const stopLocale = observeLocale(updateLabel);
  function destroy() {
    if (destroyed) return; destroyed = true; hideTooltip(); observer.disconnect(); stopLocale();
    window.removeEventListener('pagehide', destroy); window.removeEventListener('resize', hideTooltip); document.removeEventListener('scroll', hideTooltip, true);
    button.remove(); tooltip.remove(); style.remove(); current = undefined;
  }
  button.addEventListener('click', () => { hideTooltip(); (options.refresh ?? (() => window.location.reload()))(); });
  button.addEventListener('pointerenter', showTooltip); button.addEventListener('focus', showTooltip);
  if (!nativeInterest) {
    button.addEventListener('pointerleave', scheduleHide); button.addEventListener('blur', scheduleHide);
    tooltip.addEventListener('pointerenter', () => clearTimeout(hideTimer)); tooltip.addEventListener('pointerleave', scheduleHide);
  }
  button.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); });
  window.addEventListener('pagehide', destroy, { once: true }); window.addEventListener('resize', hideTooltip); document.addEventListener('scroll', hideTooltip, true);
  current = { destroy }; updateLabel(); mount(); return current;
}
