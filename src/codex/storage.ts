import { DEFAULT_CODEX_SETTINGS, record, validateCodexSettings, type CodexSettings, type CodexMessage } from './types';
import { retryRuntimeRead } from '../runtime-connection';

export const codexStorageKey = (projectId: string, accountId?: string, providerId?: string) => `codex:${accountId || 'unidentified'}:${projectId}${providerId ? `:api:${providerId}` : ''}`;
export type CodexPanelPosition = 'left' | 'right';
export type CodexBusyMessageBehavior = 'queue' | 'steer';
export interface CodexDefaults {
  settings: Omit<CodexSettings, 'instructions'>;
  panelPosition: CodexPanelPosition;
  busyMessageBehavior: CodexBusyMessageBehavior;
  clickToCopy: boolean;
  copyToast: boolean;
}
const codexDefaultsKey = (accountId: string) => `codex-defaults:${accountId}`;

// Defaults are scoped to the Overleaf account in this browser. A project's
// explicit value always wins, including false and the built-in defaults.
async function loadPreference(projectId: string, accountId: string | undefined, suffix: string, defaultName: keyof CodexDefaults): Promise<unknown> {
  const key = codexStorageKey(projectId, accountId) + suffix;
  const data = await chrome.storage.local.get(key);
  if (data[key] !== undefined || !accountId) return data[key];
  const defaultsKey = codexDefaultsKey(accountId);
  const defaults = await chrome.storage.local.get(defaultsKey);
  return record(defaults[defaultsKey])?.[defaultName];
}

export async function saveCodexDefaults(accountId: string | undefined, preferences: CodexDefaults): Promise<void> {
  if (!accountId) throw new Error('An Overleaf account is required to save assistant defaults.');
  // Document-specific instructions, credentials and conversation identifiers
  // must not be copied to another project by Set as default.
  const { instructions: _instructions, ...settings } = validateCodexSettings(preferences.settings);
  const defaults: CodexDefaults = {
    settings,
    panelPosition: preferences.panelPosition === 'right' ? 'right' : 'left',
    busyMessageBehavior: preferences.busyMessageBehavior === 'steer' ? 'steer' : 'queue',
    clickToCopy: preferences.clickToCopy === true,
    copyToast: preferences.copyToast === true,
  };
  await chrome.storage.local.set({ [codexDefaultsKey(accountId)]: defaults });
}

export async function loadCodexPanelPosition(projectId: string, accountId?: string): Promise<CodexPanelPosition> {
  return await loadPreference(projectId, accountId, ':position', 'panelPosition') === 'right' ? 'right' : 'left';
}
export async function saveCodexPanelPosition(projectId: string, accountId: string | undefined, position: CodexPanelPosition): Promise<void> {
  await chrome.storage.local.set({ [codexStorageKey(projectId, accountId) + ':position']: position === 'right' ? 'right' : 'left' });
}
// This affects only how the composer sends a follow-up. Keep it separate from
// native model settings, including settings already captured in queued prompts.
export async function loadCodexBusyMessageBehavior(projectId: string, accountId?: string): Promise<CodexBusyMessageBehavior> {
  return await loadPreference(projectId, accountId, ':busy-message-behavior', 'busyMessageBehavior') === 'steer' ? 'steer' : 'queue';
}
export async function saveCodexBusyMessageBehavior(projectId: string, accountId: string | undefined, behavior: CodexBusyMessageBehavior): Promise<void> {
  await chrome.storage.local.set({ [codexStorageKey(projectId, accountId) + ':busy-message-behavior']: behavior === 'steer' ? 'steer' : 'queue' });
}
// Browser-only interaction preference; never part of model instructions or
// the native Codex settings payload. Unset values stay opt-in unless the user
// explicitly includes this preference in their account's saved defaults.
export async function loadCodexClickToCopy(projectId: string, accountId?: string): Promise<boolean> {
  return await loadPreference(projectId, accountId, ':click-to-copy', 'clickToCopy') === true;
}
export async function saveCodexClickToCopy(projectId: string, accountId: string | undefined, enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [codexStorageKey(projectId, accountId) + ':click-to-copy']: enabled === true });
}
export async function loadCodexCopyToast(projectId: string, accountId?: string): Promise<boolean> {
  return await loadPreference(projectId, accountId, ':copy-toast', 'copyToast') === true;
}
export async function saveCodexCopyToast(projectId: string, accountId: string | undefined, enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [codexStorageKey(projectId, accountId) + ':copy-toast']: enabled === true });
}
export async function loadCodexSettings(projectId: string, accountId?: string): Promise<CodexSettings> {
  const key = codexStorageKey(projectId, accountId) + ':settings';
  const data = await chrome.storage.local.get(key);
  if (data[key] !== undefined && data[key] !== null) return validateCodexSettings(data[key]);
  if (!accountId) return { ...DEFAULT_CODEX_SETTINGS };
  const defaultsKey = codexDefaultsKey(accountId);
  const defaults = await chrome.storage.local.get(defaultsKey);
  const settings = validateCodexSettings(record(defaults[defaultsKey])?.settings);
  // Also enforce the project-only boundary when reading modified/legacy data.
  return { ...settings, instructions: '' };
}
export async function saveCodexSettings(projectId: string, accountId: string | undefined, settings: CodexSettings): Promise<void> {
  await chrome.storage.local.set({ [codexStorageKey(projectId, accountId) + ':settings']: validateCodexSettings(settings) });
}
// Bounded display history stays in this browser profile (never Chrome sync).
// Codex owns the full conversation. Account identity is required for persistence.
export async function loadCodexMessages(projectId: string, accountId?: string, providerId?: string): Promise<CodexMessage[]> {
  if (!accountId) return [];
  // The worker validates the sender's project before accessing history.
  const data = await retryRuntimeRead(() => chrome.runtime.sendMessage({ type: 'opt:codex-history', projectId, accountId, ...(providerId ? {providerId} : {}), action: 'read' }));
  return Array.isArray(data?.messages) ? data.messages : [];
}
export async function saveCodexMessages(projectId: string, accountId: string | undefined, messages: CodexMessage[], providerId?: string): Promise<void> {
  if (!accountId) return;
  const budget = 350_000, messageLimit = 60;
  const size = (message: CodexMessage) => message.text.length + (message.selection ? JSON.stringify(message.selection).length : 0) + (message.answerQuote ? JSON.stringify(message.answerQuote).length : 0);
  const turns: CodexMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push([message]);
    else turns.at(-1)?.push(message);
  }
  const retained: CodexMessage[] = []; let length = 0;
  for (const turn of turns.reverse()) {
    let candidate = turn, turnSize = turn.reduce((sum, message) => sum + size(message), 0);
    if (!retained.length && (turnSize > budget || turn.length > messageLimit)) {
      // Keep the question and its exact quote. Only the display copy of the
      // answer is excerpted; Codex retains its own complete conversation.
      const question = turn[0], answers = turn.slice(1).slice(-(messageLimit - 1));
      const marker = '\n\n[Display history excerpt / 面板历史节选：此回答超出保存上限，后续内容未保存。]';
      let remaining = budget - size(question);
      if (remaining < answers.length * marker.length) throw new Error('The quoted question exceeds the display-history budget.');
      candidate = [question];
      for (let i = 0; i < answers.length; i++) {
        const answer = answers[i], available = remaining - (answers.length - i - 1) * marker.length;
        let text = answer.text;
        if (text.length > available) {
          let end = available - marker.length;
          if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          text = text.slice(0, end) + marker;
        }
        const excerpt: CodexMessage = { role: 'assistant', text };
        candidate.push(excerpt); remaining -= size(excerpt);
      }
      turnSize = candidate.reduce((sum, message) => sum + size(message), 0);
    }
    if (retained.length + candidate.length > messageLimit || length + turnSize > budget) break;
    retained.unshift(...candidate); length += turnSize;
  }
  // A malformed legacy transcript without a question must not erase a saved
  // conversation. An explicit empty transcript still implements New chat.
  if (messages.length && !retained.length) return;
  await chrome.runtime.sendMessage({ type: 'opt:codex-history', projectId, accountId, ...(providerId ? {providerId} : {}), action: 'write', messages: retained });
}
