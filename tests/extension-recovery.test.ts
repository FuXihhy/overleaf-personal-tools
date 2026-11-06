// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountExtensionRecoveryNotice, type ExtensionRecoveryNotice } from '../src/extension-recovery';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const shell = '<nav class="ide-rail"><div class="ide-rail-tabs-wrapper"><button id="ide-rail-tabs-tab-workbench">AI assistant</button></div></nav>';
let notice: ExtensionRecoveryNotice | undefined;
beforeEach(() => {
  document.documentElement.lang = 'en'; document.body.innerHTML = shell;
  vi.stubGlobal('chrome', Object.defineProperty({}, 'runtime', { get() { throw new Error('Retired runtime must never be accessed'); } }));
});
afterEach(() => { notice?.destroy(); notice = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('extension update recovery notice', () => {
  it('uses only DOM, fits below native AI, exposes a tooltip, and refreshes only on click', async () => {
    const refresh = vi.fn(); notice = mountExtensionRecoveryNotice({ refresh });
    await flush();
    const button = document.getElementById('opt-extension-recovery')!;
    expect(document.getElementById('ide-rail-tabs-tab-workbench')!.nextElementSibling).toBe(button);
    expect(button.classList.contains('ide-rail-tab-link')).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Extension updated — refresh this page');
    expect(button.querySelector('svg')).not.toBeNull(); expect(button.querySelector('img')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    button.dispatchEvent(new Event('pointerenter'));
    const tooltip = document.getElementById('opt-extension-recovery-tooltip')!;
    expect(tooltip.hidden).toBe(false); expect(tooltip.textContent).toContain('refresh this page');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(tooltip.hidden).toBe(true);
    button.focus(); expect(tooltip.hidden).toBe(false);
    button.click(); expect(refresh).toHaveBeenCalledOnce();
  });

  it('waits for native layout and recovers after the entire body/head are replaced', async () => {
    document.body.replaceChildren(); const refresh = vi.fn(); notice = mountExtensionRecoveryNotice({ refresh });
    expect(document.getElementById('opt-extension-recovery')).toBeNull();
    document.body.innerHTML = shell; await flush();
    expect(document.getElementById('opt-extension-recovery')).not.toBeNull();
    const oldHead = document.head, nextHead = document.createElement('head'); oldHead.replaceWith(nextHead);
    const nextBody = document.createElement('body'); nextBody.innerHTML = shell; document.body.replaceWith(nextBody); await flush();
    expect(document.querySelectorAll('#opt-extension-recovery')).toHaveLength(1);
    expect(document.querySelectorAll('#opt-extension-recovery-tooltip')).toHaveLength(1);
    expect(document.head.querySelectorAll('#opt-extension-recovery-style')).toHaveLength(1);
    expect(mountExtensionRecoveryNotice({ refresh })).toBe(notice);
    expect(refresh).not.toHaveBeenCalled();
    document.getElementById('opt-extension-recovery')!.click(); expect(refresh).toHaveBeenCalledOnce();
  });

  it('follows native locale and completely stops remounting on pagehide', async () => {
    notice = mountExtensionRecoveryNotice({ refresh: vi.fn() });
    document.documentElement.lang = 'zh'; await flush();
    expect(document.getElementById('opt-extension-recovery')!.getAttribute('aria-label')).toBe('扩展已更新，刷新此页恢复');
    window.dispatchEvent(new Event('pagehide'));
    expect(document.querySelector('[id^="opt-extension-recovery"]')).toBeNull();
    document.body.innerHTML = shell; await flush();
    expect(document.getElementById('opt-extension-recovery')).toBeNull();
    expect(document.getElementById('opt-extension-recovery-style')).toBeNull();
  });
});
