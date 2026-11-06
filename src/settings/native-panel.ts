import type { ProjectFile, ProjectIndex, Settings } from '../core/types';
import { getPreviewSources } from '../core/preview-sources';
import { getLocale, observeLocale, translateRuntimeText } from '../i18n';
import { panelText, type PanelMessageKey } from './messages';
import { createExtensionContext, type ExtensionContext } from '../extension-context';
import { API_BUDGET_LIMITS, type APIProfile } from '../codex/types';
import type { CodexBusyMessageBehavior } from '../codex/storage';

export interface CodexPanelSettings {
  cacheMode?: 'normal' | 'on-demand' | 'persistent';
  providerId?: string;
  apiModel?: string;
  apiMaxReadRounds?: number;
  apiMaxToolCalls?: number;
  apiTimeoutSeconds?: number;
  enabled: boolean;
  model: string;
  effort: string;
  instructions: string;
  contextMode: 'selection' | 'project';
}
export interface PanelModel {
  settings: Settings;
  files: ProjectFile[];
  index: ProjectIndex;
  status: string;
  busy: boolean;
  editorReady: boolean;
  localStatus?: string;
  rootPath?: string;
  rootCandidates?: string[];
  codex?: CodexPanelSettings;
  codexStatus?: string;
  codexModels?: Array<{ id: string; displayName: string; efforts?: string[] }>;
  codexModelsLoading?: boolean;
  codexModelsError?: string;
  codexProviders?: APIProfile[];
  codexProvidersError?: string;
  codexBusy?: boolean;
  codexPanelPosition?: 'left' | 'right';
  codexClickToCopy?: boolean;
  codexCopyToast?: boolean;
  codexBusyMessageBehavior?: CodexBusyMessageBehavior;
}
export interface PanelActions {
  save(settings: Settings): Promise<void>;
  defaults(settings: Settings): Promise<void>;
  refresh(): Promise<void>;
  reconnectEditor?(): Promise<void>;
  createCloudProject?(): Promise<void>;
  checkLocal?(): Promise<void>;
  saveCodex?(settings: CodexPanelSettings): Promise<void>;
  defaultsCodex?(): Promise<void>;
  checkCodex?(): Promise<void>;
  onSyncProjectCache?(): Promise<string>;
  inspectProjectCache?(): Promise<string>;
  clearProjectCache?(): Promise<string>;
  openProjectCache?(): Promise<string>;
  manageCodexProviders?(): Promise<void>;
  refreshCodexProviders?(): Promise<void>;
  openCodex?(): Promise<void>;
  setCodexPosition?(position: 'left' | 'right'): Promise<void>;
  setCodexClickToCopy?(enabled: boolean): Promise<void>;
  setCodexCopyToast?(enabled: boolean): Promise<void>;
  setCodexBusyMessageBehavior?(behavior: CodexBusyMessageBehavior): Promise<void>;
}

const TAB = 'opt-settings-tab';
const PANEL = 'opt-settings-panel';
const CHILDREN = 'opt-settings-children';
const PREVIEW_TAB = 'opt-settings-preview-tab';
const CODEX_TAB = 'opt-settings-codex-tab';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

/** Mounts exclusively inside the known native settings dialog. No fallback UI is created. */
export function mountNativeSettings(getModel: () => PanelModel, actions: PanelActions, context: ExtensionContext = createExtensionContext()) {
  let locale = getLocale();
  const t = (key: PanelMessageKey, params?: Record<string, string | number>) => panelText(locale, key, params);
  let currentDialog: HTMLElement | null = null;
  let panel: HTMLElement | null = null;
  let statusNode: HTMLElement | null = null;
  let detailsNode: HTMLElement | null = null;
  let localStatusNode: HTMLElement | null = null;
  let updateRootControls: (() => void) | undefined;
  let updatePreviewSources: (() => void) | undefined;
  let active = false;
  let destroyed = false;
  let tabNode: HTMLButtonElement | null = null;
  let childrenNode: HTMLElement | null = null;
  let activeSection: 'preview' | 'codex' = 'preview';
  let observer: MutationObserver | undefined;
  let stopObservingLocale = () => {};
  let removeNavListener: (()=>void) | undefined;
  let draft: Settings;
  let pendingSave: Settings | undefined;
  let saveTask: Promise<void> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveError = '';
  let codexDraft: CodexPanelSettings | undefined;
  let updateCodexModels: (() => void) | undefined;
  let updateCodexCopyPreferences: (() => void) | undefined;
  let pendingCodexSave: CodexPanelSettings | undefined;
  let codexSaveTask: Promise<void> | undefined;
  let codexSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let codexSaveError = '';
  let codexDefaultsError = '';
  let codexSyncStatus = '';
  const codexPreferenceWrites = new Set<Promise<void>>();
  const pendingActions = new Set<string>();
  let reconnectStatus: 'reconnectEditorPending' | 'reconnectEditorSuccess' | 'reconnectEditorFailure' | 'reconnectEditorNoEditor' | undefined;
  let codexOpenError = '';
  let codexOpenLoading = false;
  let savedNative: { el: HTMLElement; selected: string | null; tabIndex: string | null }[] = [];

  const style = element('style');
  style.textContent = `
  .opt-settings-active .ide-settings-tab-content > [role=tabpanel]:not(#${PANEL}){display:none!important}
  .opt-settings-active .ide-settings-tab-nav > [role=tab]{background:transparent;color:inherit;font-weight:400}
  #${TAB}{gap:4px;display:flex;align-items:center;width:100%}
  #${TAB} .opt-tab-label{white-space:nowrap}
  #${TAB} .opt-tab-chevron{width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);margin-left:auto;margin-right:4px;opacity:.7}
  #${TAB}[aria-expanded=true] .opt-tab-chevron{transform:rotate(45deg)}
  #${CHILDREN}{display:flex;flex-direction:column;gap:0;width:100%}
  #${CHILDREN}[hidden]{display:none!important}
  #${CHILDREN} .opt-settings-child{padding-left:36px;width:100%;text-align:left;white-space:normal}
  #${TAB} .opt-tab-avatar{position:relative;width:20px;height:20px;border-radius:50%;overflow:hidden;flex:none}
  #${TAB} .opt-tab-avatar img{position:absolute;width:36px;height:36px;max-width:none;left:50%;transform:translateX(-50%);top:0}
  #${PANEL}{padding:0;min-width:0}
  #${PANEL} .opt-stack{display:flex;flex-direction:column;gap:12px;min-width:0;font-size:14px;line-height:21px}
  #${PANEL} .opt-stack > button{align-self:flex-start}
  #${PANEL} .opt-select-wide{width:160px;max-width:100%}
  #${PANEL} .opt-disabled-setting{opacity:.5;filter:grayscale(1)}
  #${PANEL} .opt-codex-select{max-width:240px;width:100%}
  #${PANEL} .opt-api-budget{display:flex;flex-direction:column;gap:12px;min-width:0}
  #${PANEL} .opt-budget-control{max-width:160px;min-width:0}
  #${PANEL} .opt-budget-control input[aria-invalid=true]{border-color:var(--bs-danger,#b92c28)}
  #${PANEL} .opt-budget-error{font-size:14px;line-height:21px;color:var(--bs-danger,#b92c28);margin:4px 0 0}
  #${PANEL} .opt-codex-instructions{width:100%;min-height:100px;resize:vertical}
  #${PANEL} .opt-codex-instructions-row{display:flex;flex-direction:column;align-items:stretch;gap:8px}
  #${PANEL} .opt-codex-instructions-row .ide-setting-input{width:100%}
  #${PANEL} .opt-actions{display:flex;gap:8px;flex-wrap:wrap;padding:0 4px}
  #${PANEL} .opt-actions > .btn{border-radius:var(--bs-btn-border-radius,var(--ds-border-radius-full,9999px))}
  #${PANEL} .opt-support{display:grid;grid-template-columns:minmax(0,1fr) max-content;column-gap:12px;padding:0 4px;container-type:inline-size}
  #${PANEL} #opt-support-details{display:grid;grid-template-columns:subgrid;grid-column:1/-1;grid-row:1;padding:0;min-width:0}
  #${PANEL} #opt-support-details > summary{grid-column:1;min-block-size:28px;align-content:center}
  #${PANEL} #opt-support-details::details-content{grid-column:1/-1}
  #${PANEL} .opt-support > .opt-actions{grid-column:2;grid-row:1;align-self:start;padding:0;max-width:100%}
  #${PANEL} .opt-support > .opt-actions > .btn{white-space:normal;max-width:100%}
  #${PANEL} .opt-support [data-opt-action=reconnect-editor][aria-disabled=true]{opacity:.65;cursor:wait}
  #${PANEL} .opt-editor-connection-status{grid-column:1/-1;grid-row:2;padding:0;min-block-size:21px;margin-block-start:4px;color:var(--content-secondary,var(--bs-secondary-color,#6b7280))}
  @container (width < 36rem){
    #${PANEL} #opt-support-details > summary{grid-column:1/-1}
    #${PANEL} .opt-support > .opt-actions{grid-column:1/-1;grid-row:2;justify-self:start;margin-top:8px}
    #${PANEL} .opt-editor-connection-status{grid-row:3}
  }
  #${PANEL} .opt-note{margin:0;padding:0 4px;font-size:14px;line-height:21px;opacity:.8;overflow-wrap:anywhere}
  #${PANEL} .opt-key-note{opacity:1}
  #${PANEL} .opt-usage-content{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  #${PANEL} .opt-usage-content p{margin:0}
  #${PANEL} .opt-status{font-size:14px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere;padding:0 4px}
  #${PANEL} details{font-size:14px;line-height:21px;padding:0 4px}
  #${PANEL} summary{cursor:pointer}
  #${PANEL} .opt-file-picker{display:flex;flex-direction:column;gap:8px;min-width:0;padding:0 4px;font-size:14px;line-height:21px}
  #${PANEL} .opt-file-picker details{padding:0}
  #${PANEL} .opt-picker-controls{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  #${PANEL} .opt-file-list{max-height:180px;overflow:auto;min-width:0}
  #${PANEL} .opt-file-list label{display:flex;gap:8px;align-items:center;padding:4px 2px;font-size:14px;line-height:21px;min-width:0}
  #${PANEL} .opt-file-list input{flex:none;margin:0}
  #${PANEL} .opt-file-list label span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #${PANEL} .opt-selected-files{display:flex;gap:6px;flex-wrap:wrap;min-width:0}
  #${PANEL} .opt-selected-file{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--bs-border-color,#d9d9d9);border-radius:4px;padding:2px 6px}
  #${PANEL} .opt-selected-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #${PANEL} .opt-remove-file{border:0;background:transparent;color:inherit;font:inherit;line-height:20px;padding:0 2px;flex:none}
  #${PANEL} .opt-picker-empty{opacity:.8}
  #${PANEL} .opt-advanced-content{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  #${PANEL} .opt-advanced-content button{align-self:flex-start}
  #${PANEL} .opt-preview-sources-content{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  #${PANEL} .opt-preview-sources-content > button{align-self:flex-start}
  #${PANEL} .opt-preview-source-list{max-height:240px;overflow:auto;min-width:0}
  #${PANEL} .opt-preview-source-row{display:flex;gap:8px;align-items:center;padding:4px 0;min-width:0}
  #${PANEL} .opt-preview-source-priority{min-width:2ch;text-align:right;opacity:.7}
  #${PANEL} .opt-preview-source-label{display:flex;gap:8px;align-items:center;flex:1;min-width:0;margin:0;font:inherit}
  #${PANEL} .opt-preview-source-label input{flex:none;margin:0}
  #${PANEL} .opt-preview-source-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #${PANEL} .opt-preview-source-kind{opacity:.7;flex:none}
  #${PANEL} .opt-preview-source-order{display:flex;gap:4px;flex:none}
  #${PANEL} .opt-preview-source-order button{padding:1px 6px;min-width:28px;font:inherit}
  #${PANEL} li{margin:5px 0;overflow-wrap:anywhere}
  #${PANEL} [hidden]{display:none!important}
  `;
  document.head.append(style);

  function copySettings(settings: Settings): Settings {
    return {...settings, extraFiles:[...settings.extraFiles], previewSources:settings.previewSources?.map(source=>({...source}))};
  }

  function scheduleSave(debounce = false) {
    if (!available()) return;
    pendingSave = copySettings(draft);
    saveError = '';
    clearTimeout(saveTimer);
    if (debounce) saveTimer = setTimeout(() => { void flushSave(); }, 350);
    else void flushSave();
    update();
  }

  async function flushSave(): Promise<void> {
    clearTimeout(saveTimer);saveTimer=undefined;
    if (saveTask) return saveTask;
    if (!pendingSave || !available()) return;
    saveTask = (async () => {
      await Promise.resolve();
      // Serialize writes and coalesce queued edits. In particular, an older
      // snapshot must never finish after and overwrite a newer preference.
      while (pendingSave && available()) {
        const snapshot=pendingSave;pendingSave=undefined;
        try { await actions.save(snapshot);saveError=''; }
        catch(error) {
          saveError=error instanceof Error?error.message:String(error);
          pendingSave ??= snapshot;
          break;
        }
      }
    })();
    try { await saveTask; }
    finally { saveTask=undefined;if(available())update(); }
  }

  async function withSavedSettings(action: () => Promise<void>) {
    await flushSave();
    if (!available()) return;
    if (saveError) throw new Error(t('saveFailed',{error:saveError}));
    await action();
  }

  function scheduleCodexSave(debounce = false) {
    if (!actions.saveCodex || !codexDraft || !available()) return;
    pendingCodexSave = {...codexDraft};
    codexSaveError = '';
    codexSyncStatus = '';
    clearTimeout(codexSaveTimer);
    if (debounce) codexSaveTimer = setTimeout(() => { void flushCodexSave(); }, 350);
    else void flushCodexSave();
    update();
  }

  async function flushCodexSave(): Promise<void> {
    clearTimeout(codexSaveTimer);codexSaveTimer=undefined;
    if (codexSaveTask) return codexSaveTask;
    if (!pendingCodexSave || !actions.saveCodex || !available()) return;
    // One writer: quick subsequent changes replace the queued snapshot, never
    // race an older storage write or rebuild a focused text field.
    codexSaveTask = (async () => {
      await Promise.resolve();
      while (pendingCodexSave && available()) {
        const snapshot = pendingCodexSave;pendingCodexSave=undefined;
        try { await actions.saveCodex!(snapshot);codexSaveError=''; }
        catch (error) {
          codexSaveError = error instanceof Error ? error.message : String(error);
          // Keep the latest unsaved draft for a later edit or explicit retry.
          pendingCodexSave ??= snapshot;
          break;
        }
      }
    })();
    try { await codexSaveTask; }
    finally { codexSaveTask=undefined;if(available())update(); }
  }

  async function saveCodexPreference(action: () => Promise<void> | undefined) {
    const task = action() ?? Promise.resolve();
    codexPreferenceWrites.add(task);updateActionButtons();
    try { await task; }
    finally { codexPreferenceWrites.delete(task);updateActionButtons(); }
  }

  function closePanel() {
    void flushSave();
    void flushCodexSave();
    active = false;
    currentDialog?.classList.remove('opt-settings-active');
    if (panel) { panel.hidden = true; panel.classList.remove('active'); }
    for (const tab of childrenNode?.querySelectorAll<HTMLElement>('[role=tab]') ?? []) {
      tab.setAttribute('aria-selected','false');tab.classList.remove('active');tab.tabIndex=-1;
    }
    for (const {el,selected,tabIndex} of savedNative) {
      if (selected === null) el.removeAttribute('aria-selected'); else el.setAttribute('aria-selected',selected);
      if (tabIndex === null) el.removeAttribute('tabindex'); else el.setAttribute('tabindex',tabIndex);
    }
    savedNative = [];
  }

  function row(title: string, description: string, control: HTMLElement) {
    const row = element('div','ide-setting');
    const copy = element('div');
    const label = element('label','ide-setting-title',title);
    const inputId = control.id || control.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')?.id;
    if (inputId) label.htmlFor = inputId;
    copy.append(label, element('div','ide-setting-description',description));
    const input = element('div','ide-setting-input'); input.append(control);
    row.append(copy,input);
    return row;
  }

  function usageNotes(id: string, ...notes: string[]) {
    const details = element('details', 'opt-usage');
    details.id = id;
    details.append(element('summary', '', t('usage')));
    const content = element('div', 'opt-usage-content');
    for (const note of notes) content.append(element('p', '', note));
    details.append(content);
    return details;
  }

  function actionButton(label: string, name: string, action: () => Promise<void>, primary = false) {
    const button = element('button', `btn btn-sm ${primary ? 'btn-primary' : 'btn-secondary'}`, label);
    button.type = 'button';
    button.dataset.optAction = name;
    button.onclick = async () => {
      if (!available() || button.disabled || pendingActions.has(name) || (name==='reconnect-editor' ? false : name.startsWith('codex-') ? getModel().codexBusy : getModel().busy)) return;
      if(name.startsWith('codex-'))codexSyncStatus='';
      const errorNode = statusNode;
      pendingActions.add(name);
      update();
      try { await action(); }
      catch (error) { if (available() && errorNode?.isConnected) errorNode.textContent = translateRuntimeText(error instanceof Error ? error.message : String(error), locale); }
      finally { pendingActions.delete(name); updateActionButtons(); }
    };
    return button;
  }

  function updateActionButtons() {
    if (!available()) return;
    const model = getModel();
    for (const button of panel?.querySelectorAll<HTMLButtonElement>('button[data-opt-action]') || []) {
      const name = button.dataset.optAction!;
      if(name==='reconnect-editor') {
        // Reconnecting is independent of indexing/compiling. Keep the focused
        // control in the tab order while coalescing repeat clicks in its handler.
        button.disabled=!actions.reconnectEditor;
        button.setAttribute('aria-disabled',String(!actions.reconnectEditor || pendingActions.has(name)));
        button.setAttribute('aria-busy',String(pendingActions.has(name)));
        continue;
      }
      const actionAvailable = name === 'check-local' ? !!actions.checkLocal
        : name === 'create-cloud' ? !!actions.createCloudProject
        : name === 'codex-defaults' ? !!actions.defaultsCodex && !codexPreferenceWrites.size
        : name === 'codex-check' ? !!actions.checkCodex
        : name === 'codex-sync-project' ? !!actions.onSyncProjectCache && !pendingCodexSave && !codexSaveTask
          && (model.codex ?? codexDraft)?.enabled === true && (model.codex ?? codexDraft)?.contextMode === 'project'
        : name === 'codex-manage-providers' ? !!actions.manageCodexProviders
        : name === 'codex-refresh-providers' ? !!actions.refreshCodexProviders : true;
      button.disabled = (name.startsWith('codex-') ? !!model.codexBusy : model.busy) || pendingActions.has(name) || !actionAvailable;
      if(name==='codex-sync-project')button.setAttribute('aria-busy',String(pendingActions.has(name)));
    }
    const reconnectNote=panel?.querySelector<HTMLElement>('#opt-editor-connection-status');
    const reconnectText=reconnectStatus?t(reconnectStatus):'';
    if(reconnectNote && reconnectNote.textContent!==reconnectText)reconnectNote.textContent=reconnectText;
  }

  function focusKey(node: HTMLElement) {
    if (node.id) return 'id:'+node.id;
    if (node.dataset.optFocus) return node.dataset.optFocus;
    if (node.dataset.optAction) return 'action:'+node.dataset.optAction;
    if (node.tagName === 'SUMMARY' && node.parentElement?.id) return 'summary:'+node.parentElement.id;
    return undefined;
  }

  function captureUiState() {
    if (!panel) return undefined;
    const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? document.activeElement : undefined;
    const selection = (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && focused.selectionStart !== null
      ? {start:focused.selectionStart,end:focused.selectionEnd!,direction:focused.selectionDirection || 'none'} : undefined;
    const scrollNodes = [...panel.querySelectorAll<HTMLElement>('[id]'),panel];
    for (let ancestor=panel.parentElement; ancestor; ancestor=ancestor.parentElement) scrollNodes.push(ancestor);
    return {
      details: [...panel.querySelectorAll<HTMLDetailsElement>('details[id]')].map(node=>({id:node.id,open:node.open})),
      textInputs: [...panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type=text],input[type=search],input[type=number],textarea')].map(node=>({id:node.id,value:node.value,invalid:node.getAttribute('aria-invalid')})),
      focus: focused && focusKey(focused), selection,
      scroll: scrollNodes.map(node=>({node,id:node.id,top:node.scrollTop,left:node.scrollLeft})),
    };
  }

  function restoreUiState(state: ReturnType<typeof captureUiState>) {
    if (!panel || !state) return;
    for (const {id,open} of state.details) {
      const node=document.getElementById(id);
      if(node instanceof HTMLDetailsElement)node.open=open;
    }
    for (const {id,value,invalid} of state.textInputs) {
      const node=document.getElementById(id);
      if(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        node.value=value;
        if(node instanceof HTMLInputElement && node.type==='search')node.dispatchEvent(new Event('input'));
        if(node instanceof HTMLInputElement && node.type==='number' && invalid!==null){
          node.setAttribute('aria-invalid',invalid);node.dispatchEvent(new Event('input'));
        }
      }
    }
    if(state.focus) {
      const focused=[...panel.querySelectorAll<HTMLElement>('*')].find(node=>focusKey(node)===state.focus);
      focused?.focus({preventScroll:true});
      if((focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && state.selection) {
        focused.setSelectionRange(state.selection.start,state.selection.end,state.selection.direction as 'forward'|'backward'|'none');
      }
    }
    for (const saved of state.scroll) {
      const node=saved.node.isConnected?saved.node:saved.id?document.getElementById(saved.id):null;
      if(node){node.scrollTop=saved.top;node.scrollLeft=saved.left;}
    }
  }

  function renderForm(preserveDraft = false) {
    if (!available()) return;
    if (!panel) return;
    const uiState=preserveDraft?captureUiState():undefined;
    locale=getLocale();
    if(activeSection==='codex') { renderCodexForm(preserveDraft);restoreUiState(uiState);return; }
    const model = getModel();
    draft = (preserveDraft || pendingSave || saveTask) && draft ? {
      ...draft, extraFiles: [...draft.extraFiles], previewSources: draft.previewSources?.map(source=>({...source})),
      cloudProjectId: model.settings.cloudProjectId,
      cloudProjectName: model.settings.cloudProjectName,
      cloudCompiler: model.settings.cloudCompiler,
      cloudTexLiveVersion: model.settings.cloudTexLiveVersion,
    } : {...model.settings, extraFiles:[...model.settings.extraFiles], previewSources:model.settings.previewSources?.map(source=>({...source}))};
    panel.replaceChildren();
    updateCodexModels=undefined;updateCodexCopyPreferences=undefined;
    const section = element('div','ide-settings-section');
    for (const [key,title,description] of [
      ['completion',t('completionTitle'),t('completionDescription')],
      ['preview',t('previewTitle'),t('previewDescription')],
    ] as const) {
      const input = element('input','form-check-input'); input.type='checkbox'; input.id='opt-'+key; input.checked=draft[key];
      input.onchange=()=>{draft[key]=input.checked;scheduleSave();};
      const toggle = element('div','form-switch'); toggle.append(input);
      section.append(row(title,description,toggle));
    }
    const engine=element('select','ide-dropdown-setting form-select form-select-sm');engine.id='opt-preview-engine';
    engine.append(new Option(t('mathjax'),'mathjax'),new Option(t('tex'),'tex'));
    engine.value=draft.previewEngine;
    const engineRow=row(t('engineTitle'),'',engine);
    const mathjaxNote=element('span','',t('mathjaxDescription'));mathjaxNote.id='opt-mathjax-note';
    const texNote=element('span','',t('texDescription'));texNote.id='opt-tex-note';
    engineRow.querySelector('.ide-setting-description')!.append(mathjaxNote,texNote);
    section.append(engineRow);
    const sourceDetails=element('details');sourceDetails.id='opt-preview-sources';
    sourceDetails.append(element('summary','',t('previewSources')));
    const sourceContent=element('div','opt-preview-sources-content');
    const sourceDescription=element('div','ide-setting-description',t('previewSourcesDescription'));sourceDescription.id='opt-preview-sources-description';
    const resetSources=element('button','btn btn-secondary btn-sm',t('previewSourcesReset'));resetSources.type='button';resetSources.id='opt-reset-preview-sources';
    resetSources.onclick=()=>{draft.previewSources=undefined;updatePreviewSources?.();scheduleSave();};
    const sourceList=element('div','opt-preview-source-list');sourceList.id='opt-preview-source-list';sourceList.setAttribute('role','list');sourceList.setAttribute('aria-describedby',sourceDescription.id);
    let sourceFingerprint='';
    updatePreviewSources=()=>{
      resetSources.disabled=!draft.previewSources?.length;
      const sources=getPreviewSources(getModel().index,draft);
      const fingerprint=JSON.stringify(sources);
      if(fingerprint===sourceFingerprint)return;
      sourceFingerprint=fingerprint;
      const focused=document.activeElement instanceof HTMLElement && sourceList.contains(document.activeElement)?document.activeElement:undefined;
      const focusedKey=focused&&focusKey(focused);
      const focusedSource=focused?.closest<HTMLElement>('[data-preview-source]')?.dataset.previewSource;
      const scrollTop=sourceList.scrollTop;
      sourceList.replaceChildren();
      if(!sources.length)sourceList.append(element('div','ide-setting-description',t('previewSourcesEmpty')));
      sources.forEach((source,index)=>{
        const sourceRow=element('div','opt-preview-source-row');sourceRow.setAttribute('role','listitem');sourceRow.dataset.previewSource=source.id;
        const priority=element('span','opt-preview-source-priority',String(index+1));priority.setAttribute('aria-label',t('previewSourcePriority',{number:index+1,count:sources.length}));
        const label=element('label','opt-preview-source-label');
        const checkbox=element('input','form-check-input');checkbox.type='checkbox';checkbox.checked=source.enabled;checkbox.dataset.optFocus='preview-source:'+source.id;
        checkbox.setAttribute('aria-label',t('previewSourceEnabled',{name:source.name}));
        checkbox.onchange=()=>{
          draft.previewSources=getPreviewSources(getModel().index,draft).map(item=>({id:item.id,enabled:item.id===source.id?checkbox.checked:item.enabled}));
          updatePreviewSources?.();
          scheduleSave();
        };
        const name=element('span','opt-preview-source-name',source.name);name.title=source.path||source.name;
        const kind=element('span','opt-preview-source-kind',t(source.kind==='package'?'previewSourcePackage':'previewSourceFile'));
        label.append(checkbox,name,kind);
        const order=element('div','opt-preview-source-order');
        for(const direction of [-1,1] as const){
          const move=element('button','btn btn-secondary btn-sm',direction===-1?'↑':'↓');move.type='button';
          move.dataset.optFocus=`preview-source-${direction===-1?'up':'down'}:${source.id}`;
          const description=t(direction===-1?'previewSourceLower':'previewSourceHigher',{name:source.name});
          move.setAttribute('aria-label',description);move.title=description;move.disabled=direction===-1?index===0:index===sources.length-1;
          move.onclick=()=>{
            const preferences=getPreviewSources(getModel().index,draft).map(item=>({id:item.id,enabled:item.enabled}));
            const from=preferences.findIndex(item=>item.id===source.id);const to=from+direction;
            if(from<0||to<0||to>=preferences.length)return;
            [preferences[from],preferences[to]]=[preferences[to],preferences[from]];
            draft.previewSources=preferences;updatePreviewSources?.();scheduleSave();
          };
          order.append(move);
        }
        sourceRow.append(priority,label,order);sourceList.append(sourceRow);
      });
      if(focusedKey){
        const replacement=[...sourceList.querySelectorAll<HTMLElement>('[data-opt-focus]')].find(node=>focusKey(node)===focusedKey);
        if(replacement instanceof HTMLButtonElement && replacement.disabled){
          [...sourceList.querySelectorAll<HTMLInputElement>('input')].find(node=>node.closest<HTMLElement>('[data-preview-source]')?.dataset.previewSource===focusedSource)?.focus({preventScroll:true});
        }else replacement?.focus({preventScroll:true});
      }
      sourceList.scrollTop=scrollTop;
    };
    sourceContent.append(sourceDescription,sourceList,resetSources);sourceDetails.append(sourceContent);section.append(sourceDetails);
    const tex=element('div','opt-stack');tex.id='opt-tex-settings';
    const backend=element('select','ide-dropdown-setting form-select form-select-sm');backend.id='opt-tex-backend';
    backend.append(new Option(t('overleaf'),'overleaf'),new Option(t('local'),'local'));
    backend.value=draft.texBackend;
    tex.append(row(t('backendTitle'),t('backendDescription'),backend));
    const local=element('div','opt-stack');local.id='opt-local-settings';
    const compiler=element('select','ide-dropdown-setting form-select form-select-sm');compiler.id='opt-tex-compiler';
    compiler.append(new Option(t('pdflatex'),'pdflatex'),new Option(t('xelatex'),'xelatex'),new Option(t('lualatex'),'lualatex'));
    compiler.value=draft.texCompiler;compiler.onchange=()=>{draft.texCompiler=compiler.value as Settings['texCompiler'];scheduleSave();};
    local.append(row(t('compilerTitle'),t('compilerDescription'),compiler));
    local.append(element('p','opt-note',t('localSetup')));
    const checkLocal=actionButton(t('checkLocal'),'check-local',async()=>{
      if(!actions.checkLocal)return;
      try{await actions.checkLocal();update();}
      catch(error){if(localStatusNode)localStatusNode.textContent=translateRuntimeText(error instanceof Error?error.message:String(error),locale);}
    });checkLocal.id='opt-check-local';
    local.append(checkLocal);
    localStatusNode=element('div','opt-status');localStatusNode.id='opt-local-status';localStatusNode.setAttribute('role','status');local.append(localStatusNode);
    local.append(usageNotes('opt-local-help',
      t('localCommunication'),
      t('localDependencies'),
      t('localPreviewScope'),
    ));
    tex.append(local);
    const cloud=element('div','opt-stack');cloud.id='opt-cloud-settings';
    const cloudNote=element('p','opt-note opt-key-note',t('cloudPreviewScope'));
    cloud.append(cloudNote);
    cloud.append(element('p','opt-note',t('cloudResources')));
    if(model.settings.cloudProjectId) {
      const link=element('a','',model.settings.cloudProjectName||t('openCloud'));link.id='opt-cloud-link';
      const origin=location.origin==='https://cn.overleaf.com'?location.origin:'https://www.overleaf.com';
      link.href=origin+'/project/'+model.settings.cloudProjectId;link.target='_blank';link.rel='noopener';cloud.append(link);
    }
    const create=actionButton(t(model.settings.cloudProjectId?'recreateCloud':'createCloud'),'create-cloud',async()=>{
      if(!actions.createCloudProject)return;
      try{await withSavedSettings(()=>actions.createCloudProject!());renderForm(true);}
      catch(error){renderForm(true);if(statusNode)statusNode.textContent=translateRuntimeText(error instanceof Error?error.message:String(error),locale);}
    });create.id='opt-create-cloud';
    cloud.append(create);
    if(!model.settings.cloudProjectId)cloud.append(element('p','opt-note',t('cloudFirstUse')));
    cloud.append(usageNotes('opt-cloud-help',
      t('cloudDependencies'),
      t('cloudRecreate'),
      t('cloudVersions'),
    ));
    tex.append(cloud);section.append(tex);
    const changePreviewMode=()=>{
      draft.previewEngine=engine.value as Settings['previewEngine'];draft.texBackend=backend.value as Settings['texBackend'];
      mathjaxNote.hidden=draft.previewEngine!=='mathjax';texNote.hidden=draft.previewEngine!=='tex';tex.hidden=draft.previewEngine!=='tex';
      local.hidden=draft.texBackend!=='local';cloud.hidden=draft.texBackend!=='overleaf';
    };
    engine.onchange=()=>{changePreviewMode();scheduleSave();};backend.onchange=engine.onchange;changePreviewMode();
    const rootControls = element('div'); rootControls.hidden = true;
    let rootFingerprint = '';
    updateRootControls = () => {
      const current = getModel();
      const candidates = [...new Set(current.rootCandidates || [])];
      const fingerprint = JSON.stringify([current.rootPath, candidates, draft.rootFile]);
      if (fingerprint === rootFingerprint) return;
      rootFingerprint = fingerprint;
      rootControls.replaceChildren();
      rootControls.hidden = true;
      if (!current.rootPath && candidates.length > 1) {
        const root = element('select','ide-dropdown-setting form-select form-select-sm opt-select-wide'); root.id='opt-root';
        root.append(new Option(t('chooseRoot'),''));
        for (const path of candidates) root.append(new Option(path,path));
        root.value=draft.rootFile||'';
        root.onchange=()=>{draft.rootFile=root.value||undefined;scheduleSave();};
        rootControls.append(row(t('rootTitle'),t('rootDescription'),root));
        rootControls.hidden = false;
      } else if (draft.rootFile) {
        const advanced = element('details'); advanced.id='opt-root-advanced';
        advanced.append(element('summary','',t('advanced')));
        const content = element('div','opt-advanced-content');
        content.append(element('div','opt-note',t('rootOverride',{path:draft.rootFile})));
        const reset = element('button','btn btn-secondary btn-sm',t('resetRoot')); reset.type='button'; reset.id='opt-root-reset';
        reset.onclick=()=>{draft.rootFile=undefined;updateRootControls?.();scheduleSave();};
        content.append(reset);advanced.append(content);rootControls.append(advanced);rootControls.hidden=false;
      }
    };
    section.append(rootControls);
    const mode=element('select','ide-dropdown-setting form-select form-select-sm opt-select-wide'); mode.id='opt-extra-mode';
    for (const [value,label] of [['auto',t('extraAuto')],['manual',t('extraManual')],['none',t('extraNone')]]) mode.append(new Option(label,value));
    mode.value=draft.extraFilesMode;
    section.append(row(t('extraTitle'),t('extraDescription'),mode));
    const auto=element('input','form-control form-control-sm'); auto.id='opt-auto-name'; auto.type='text'; auto.maxLength=128; auto.value=draft.autoFileName;
    auto.autocapitalize='off';auto.setAttribute('autocorrect','off');auto.spellcheck=false;
    auto.oninput=()=>{draft.autoFileName=auto.value.trim();scheduleSave(true);};
    auto.onblur=()=>{void flushSave();};
    const autoRow=row(t('autoNameTitle'),t('autoNameDescription'),auto);
    section.append(autoRow);
    const fileSection=element('div','opt-file-picker'); fileSection.id='opt-file-picker';
    const selectedFiles=element('div','opt-selected-files'); selectedFiles.id='opt-selected-files';
    const picker=element('details'); picker.id='opt-file-picker-menu';
    const pickerSummary=element('summary','',t('chooseFiles')); picker.append(pickerSummary);
    const pickerControls=element('div','opt-picker-controls');
    const search=element('input','form-control form-control-sm'); search.type='search';search.id='opt-file-search';search.placeholder=t('searchPlaceholder');search.setAttribute('aria-label',t('searchLabel'));
    const fileList=element('div','opt-file-list');fileList.id='opt-file-options';
    const availableFiles=model.files.filter(file=>/\.(tex|sty|cls|ltx|def)$/i.test(file.path));
    const renderSelectedFiles=()=>{
      selectedFiles.replaceChildren();
      pickerSummary.textContent=draft.extraFiles.length ? t('selectedFiles',{count:draft.extraFiles.length}) : t('chooseFiles');
      if(!draft.extraFiles.length)selectedFiles.append(element('span','opt-picker-empty',t('noSelectedFiles')));
      for(const path of draft.extraFiles){
        const chip=element('span','opt-selected-file');
        const label=element('span','',path);label.title=path;
        const remove=element('button','opt-remove-file','×');remove.type='button';remove.dataset.optFocus='remove:'+path;remove.setAttribute('aria-label',t('removeFile',{path}));
        remove.onclick=()=>{draft.extraFiles=draft.extraFiles.filter(file=>file!==path);renderSelectedFiles();renderFileOptions();scheduleSave();};
        chip.append(label,remove);selectedFiles.append(chip);
      }
    };
    const renderFileOptions=()=>{
      fileList.replaceChildren();
      const query=search.value.trim().toLocaleLowerCase();
      const filtered=availableFiles.filter(file=>file.path.toLocaleLowerCase().includes(query));
      for(const file of filtered){
        const label=element('label');label.title=file.path;
        const input=element('input','form-check-input');input.type='checkbox';input.value=file.path;input.dataset.optFocus='file:'+file.path;input.checked=draft.extraFiles.includes(file.path);
        input.onchange=()=>{
          draft.extraFiles=input.checked?[...new Set([...draft.extraFiles,file.path])]:draft.extraFiles.filter(path=>path!==file.path);
          renderSelectedFiles();
          scheduleSave();
        };
        label.append(input,element('span','',file.path));fileList.append(label);
      }
      if(!filtered.length)fileList.append(element('div','opt-picker-empty',t(query?'noMatchingFiles':'noAvailableFiles')));
    };
    search.oninput=renderFileOptions;
    picker.addEventListener('keydown',event=>{if(event.key==='Escape'){picker.open=false;pickerSummary.focus();}});
    pickerControls.append(search,fileList);picker.append(pickerControls);
    fileSection.append(selectedFiles,picker);
    renderSelectedFiles();renderFileOptions();
    section.append(fileSection);
    const changeMode=()=>{draft.extraFilesMode=mode.value as Settings['extraFilesMode'];autoRow.hidden=mode.value!=='auto';fileSection.hidden=mode.value!=='manual';};
    mode.onchange=()=>{changeMode();scheduleSave();};changeMode();
    const buttons=element('div','opt-actions');
    const defaults=actionButton(t('defaults'),'defaults',()=>withSavedSettings(()=>actions.defaults(copySettings(draft))));
    defaults.setAttribute('aria-describedby','opt-defaults-description');
    const retry=actionButton(t('retrySave'),'retry-save',()=>flushSave());retry.hidden=!saveError;
    buttons.append(defaults,retry);
    const defaultsDescription=element('p','opt-note',t('defaultsDescription'));defaultsDescription.id='opt-defaults-description';
    section.append(buttons,defaultsDescription);
    statusNode=element('div','opt-status');statusNode.id='opt-preview-settings-status';statusNode.setAttribute('role','status');statusNode.setAttribute('aria-live','polite');section.append(statusNode);
    detailsNode=element('details');detailsNode.id='opt-support-details';detailsNode.append(element('summary','',t('support')),element('div','opt-support-diagnostics'));
    const refreshDescription=element('p','opt-note',t('refreshDescription'));refreshDescription.id='opt-refresh-description';
    const refresh=actionButton(t('refresh'),'refresh',()=>withSavedSettings(()=>actions.refresh()));refresh.setAttribute('aria-describedby',refreshDescription.id);
    const reconnect=actionButton(t('reconnectEditor'),'reconnect-editor',async()=>{
      if(!actions.reconnectEditor)return;
      reconnectStatus='reconnectEditorPending';updateActionButtons();
      try {
        await actions.reconnectEditor();
        reconnectStatus='reconnectEditorSuccess';
      } catch(error) {
        const reason=error instanceof Error?error.message:String(error);
        reconnectStatus=reason==='editor-unavailable' || reason==='No active editor' ? 'reconnectEditorNoEditor' : 'reconnectEditorFailure';
      }
      if(available())updateActionButtons();
    },true);
    reconnect.setAttribute('aria-describedby','opt-editor-connection-status');
    const refreshActions=element('div','opt-actions');refreshActions.append(refresh,reconnect);
    detailsNode.append(refreshDescription);
    const reconnectNote=element('div','opt-status opt-editor-connection-status');reconnectNote.id='opt-editor-connection-status';reconnectNote.setAttribute('role','status');reconnectNote.setAttribute('aria-live','polite');reconnectNote.setAttribute('aria-atomic','true');
    const support=element('div','opt-support');support.append(detailsNode,refreshActions,reconnectNote);section.append(support);
    panel.append(section);
    update();
    restoreUiState(uiState);
  }

  function renderCodexForm(preserveDraft = false) {
    if(!panel)return;
    const model=getModel();
    codexDraft=(preserveDraft || pendingCodexSave || codexSaveTask) && codexDraft ? {...codexDraft} : {
      enabled:true,model:'',effort:'',instructions:'',contextMode:'project',...model.codex,
    };
    panel.replaceChildren();
    detailsNode=null;localStatusNode=null;updateRootControls=undefined;updatePreviewSources=undefined;
    const section=element('div','ide-settings-section');
    const enabled=element('input','form-check-input');enabled.type='checkbox';enabled.id='opt-codex-enabled';enabled.checked=codexDraft.enabled;
    enabled.onchange=()=>{codexDraft!.enabled=enabled.checked;scheduleCodexSave();};
    const toggle=element('div','form-switch');toggle.append(enabled);
    section.append(row(t('codexEnabled'),t('codexEnabledDescription'),toggle));

    const providerSelect=element('select','ide-dropdown-setting form-select form-select-sm opt-codex-select');providerSelect.id='opt-codex-provider';
    const providerControls=element('div','opt-stack');
    const providerButtons=element('div','opt-actions');
    providerButtons.append(
      actionButton(t('codexManageProviders'),'codex-manage-providers',async()=>{await actions.manageCodexProviders?.();}),
      actionButton(t('codexRefreshProviders'),'codex-refresh-providers',async()=>{await actions.refreshCodexProviders?.();update();}),
    );
    providerControls.append(providerSelect,providerButtons);
    section.append(row(t('codexProvider'),t('codexProviderDescription'),providerControls));
    const apiDetails=element('p','opt-note');apiDetails.id='opt-codex-api-details';
    section.append(apiDetails);
    const setupNote=element('p','opt-note');
    let providerFingerprint='';
    providerSelect.onchange=()=>{
      delete codexDraft!.apiModel;customModelEditing=false;
      if(providerSelect.value)codexDraft!.providerId=providerSelect.value;
      else delete codexDraft!.providerId;
      scheduleCodexSave();
    };

    const position=element('select','ide-dropdown-setting form-select form-select-sm');position.id='opt-codex-position';
    position.append(new Option(t('codexPositionLeft'),'left'),new Option(t('codexPositionRight'),'right'));
    position.value=model.codexPanelPosition || 'left';position.disabled=!actions.setCodexPosition;
    position.onchange=async()=>{
      const previous=getModel().codexPanelPosition || 'left';position.disabled=true;
      try{await saveCodexPreference(()=>actions.setCodexPosition?.(position.value as 'left'|'right'));}
      catch(error){position.value=previous;if(statusNode)statusNode.textContent=String(error);}
      finally{position.disabled=!actions.setCodexPosition;}
    };
    section.append(row(t('codexPosition'),t('codexPositionDescription'),position));

    const busyBehavior=element('select','ide-dropdown-setting form-select form-select-sm');busyBehavior.id='opt-codex-busy-message-behavior';
    busyBehavior.append(new Option(t('codexBusyMessageQueue'),'queue'),new Option(t('codexBusyMessageSteer'),'steer'));
    busyBehavior.value=model.codexBusyMessageBehavior==='steer'?'steer':'queue';busyBehavior.disabled=!actions.setCodexBusyMessageBehavior;
    busyBehavior.onchange=async()=>{
      const previous=getModel().codexBusyMessageBehavior==='steer'?'steer':'queue';busyBehavior.disabled=true;
      try{await saveCodexPreference(()=>actions.setCodexBusyMessageBehavior?.(busyBehavior.value==='steer'?'steer':'queue'));}
      catch(error){busyBehavior.value=previous;if(statusNode)statusNode.textContent=String(error);}
      finally{busyBehavior.disabled=!actions.setCodexBusyMessageBehavior;}
    };
    const busyBehaviorRow=row(t('codexBusyMessageBehavior'),t('codexBusyMessageDescription'),busyBehavior);
    const busyBehaviorDescription=busyBehaviorRow.querySelector<HTMLElement>('.ide-setting-description')!;
    busyBehaviorDescription.id='opt-codex-busy-message-description';busyBehavior.setAttribute('aria-describedby',busyBehaviorDescription.id);
    section.append(busyBehaviorRow);

    const clickToCopy=element('input','form-check-input');clickToCopy.type='checkbox';clickToCopy.id='opt-codex-click-to-copy';
    clickToCopy.setAttribute('aria-label',t('codexClickToCopy'));
    const copyToast=element('input','form-check-input');copyToast.type='checkbox';copyToast.id='opt-codex-copy-toast';
    copyToast.setAttribute('aria-label',t('codexCopyToast'));
    const clickToggle=element('div','form-switch');clickToggle.append(clickToCopy);
    const toastToggle=element('div','form-switch');toastToggle.append(copyToast);
    const toastRow=row(t('codexCopyToast'),t('codexCopyToastDescription'),toastToggle);
    let clickSaving=false,toastSaving=false;
    const refreshCopyPreferences=()=>{
      const current=getModel();
      if(!clickSaving)clickToCopy.checked=current.codexClickToCopy===true;
      if(!toastSaving)copyToast.checked=current.codexCopyToast===true;
      clickToCopy.disabled=clickSaving || !actions.setCodexClickToCopy;
      copyToast.disabled=!clickToCopy.checked || clickSaving || toastSaving || !actions.setCodexCopyToast;
      toastRow.classList.toggle('opt-disabled-setting',copyToast.disabled);
    };
    updateCodexCopyPreferences=refreshCopyPreferences;
    clickToCopy.onchange=async()=>{
      if(clickToCopy.disabled)return;
      const previous=getModel().codexClickToCopy===true;clickSaving=true;refreshCopyPreferences();
      try{await saveCodexPreference(()=>actions.setCodexClickToCopy?.(clickToCopy.checked));}
      catch(error){clickToCopy.checked=previous;if(statusNode)statusNode.textContent=String(error);}
      finally{clickSaving=false;refreshCopyPreferences();}
    };
    copyToast.onchange=async()=>{
      if(copyToast.disabled)return;
      const previous=getModel().codexCopyToast===true;toastSaving=true;refreshCopyPreferences();
      try{await saveCodexPreference(()=>actions.setCodexCopyToast?.(copyToast.checked));}
      catch(error){copyToast.checked=previous;if(statusNode)statusNode.textContent=String(error);}
      finally{toastSaving=false;refreshCopyPreferences();}
    };
    refreshCopyPreferences();
    section.append(row(t('codexClickToCopy'),t('codexClickToCopyDescription'),clickToggle),toastRow);

    const modelSelect=element('select','ide-dropdown-setting form-select form-select-sm opt-codex-select');modelSelect.id='opt-codex-model';
    const modelRow=row(t('codexModel'),t('codexModelDescription'),modelSelect);
    const modelDescription=modelRow.querySelector<HTMLElement>('.ide-setting-description')!;
    modelDescription.id='opt-codex-model-description';modelSelect.setAttribute('aria-describedby',modelDescription.id);
    const apiModelID=element('input','form-control form-control-sm');apiModelID.id='opt-codex-api-model-id';
    apiModelID.type='text';apiModelID.maxLength=128;apiModelID.required=true;apiModelID.pattern='[A-Za-z0-9._:@+\\/\\-]{1,128}';
    apiModelID.autocomplete='off';apiModelID.spellcheck=false;apiModelID.setAttribute('autocorrect','off');apiModelID.setAttribute('autocapitalize','off');
    const apiModelRow=row(t('codexAPIModelID'),t('codexAPIModelIDDescription'),apiModelID);
    const apiModelHint=apiModelRow.querySelector<HTMLElement>('.ide-setting-description')!;
    apiModelHint.id='opt-codex-api-model-description';apiModelID.setAttribute('aria-describedby',apiModelHint.id);
    let customModelEditing=false;
    const saveAPIModel=()=>{
      const value=apiModelID.value.trim();
      if(!/^[A-Za-z0-9._:/@+\-]{1,128}$/.test(value))return false;
      codexDraft!.apiModel=value;scheduleCodexSave(true);return true;
    };
    apiModelID.oninput=()=>{apiModelID.removeAttribute('aria-invalid');apiModelHint.textContent=t('codexAPIModelIDDescription');};
    apiModelID.onblur=()=>{const valid=saveAPIModel();apiModelID.setAttribute('aria-invalid',String(!valid));apiModelHint.textContent=t(valid?'codexAPIModelIDDescription':'codexAPIModelInvalid');if(valid)void flushCodexSave();};
    const effort=element('select','ide-dropdown-setting form-select form-select-sm');effort.id='opt-codex-effort';
    let effortFingerprint='';
    const effortLabels: Record<string, PanelMessageKey> = {none:'codexEffortNone',minimal:'codexEffortMinimal',low:'codexEffortLow',medium:'codexEffortMedium',high:'codexEffortHigh',xhigh:'codexEffortXhigh',max:'codexEffortMax',ultra:'codexEffortUltra'};
    const updateEfforts=()=>{
      const selected=getModel().codexModels?.find(model=>model.id===codexDraft!.model);
      const supported=selected?.efforts?.filter(value=>value in effortLabels);
      const values=supported?.length ? [...new Set(supported)] : ['low','medium','high','xhigh'];
      const fingerprint=JSON.stringify([values,codexDraft!.effort,locale]);
      if(fingerprint===effortFingerprint)return;
      effortFingerprint=fingerprint;
      effort.replaceChildren(new Option(t('codexDefaultEffort'),''));
      for(const value of values)effort.append(new Option(t(effortLabels[value]),value));
      if(codexDraft!.effort && !values.includes(codexDraft!.effort)){
        const value=codexDraft!.effort;
        effort.append(new Option((effortLabels[value]?t(effortLabels[value]):value)+' · '+t('codexEffortUnavailable'),value));
      }
      effort.value=codexDraft!.effort;
    };
    effort.onchange=()=>{codexDraft!.effort=effort.value;scheduleCodexSave();};
    modelSelect.onchange=()=>{
      if(codexDraft!.providerId){
        customModelEditing=modelSelect.value==='__custom__';
        apiModelRow.hidden=!customModelEditing;
        if(customModelEditing){apiModelID.value=codexDraft!.apiModel || '';apiModelID.focus();return;}
        if(modelSelect.value)codexDraft!.apiModel=modelSelect.value;else delete codexDraft!.apiModel;
      } else {codexDraft!.model=modelSelect.value;updateEfforts();}
      scheduleCodexSave();
    };
    const effortRow=row(t('codexEffort'),t('codexEffortDescription'),effort);
    let modelFingerprint='';
    let updateBudget=()=>{};
    updateCodexModels=()=>{
      updateBudget();
      const current=getModel();
      const profiles=current.codexProviders ?? [];
      const providerKey=JSON.stringify([profiles,codexDraft!.providerId,locale]);
      if(providerFingerprint!==providerKey){
        providerFingerprint=providerKey;providerSelect.replaceChildren(new Option(t('codexProviderDefault'),''));
        for(const profile of profiles)providerSelect.append(new Option(profile.name,profile.id));
        if(codexDraft!.providerId && !profiles.some(profile=>profile.id===codexDraft!.providerId))providerSelect.append(new Option(t('codexProviderMissing'),codexDraft!.providerId));
        providerSelect.value=codexDraft!.providerId || '';
      }
      providerSelect.disabled=!!current.codexBusy || !actions.saveCodex;
      enabled.disabled=!!current.codexBusy || !actions.saveCodex;
      const sourceChanged=(codexDraft!.providerId || '')!==(current.codex?.providerId || '');
      const check=panel?.querySelector<HTMLButtonElement>('[data-opt-action=codex-check]');if(check)check.disabled ||= sourceChanged;
      const custom=!!codexDraft!.providerId,profile=profiles.find(value=>value.id===codexDraft!.providerId);
      modelRow.hidden=false;effortRow.hidden=custom;apiDetails.hidden=!custom;
      apiDetails.textContent=profile ? `${profile.model} · ${profile.baseUrl}` : current.codexProvidersError || t('codexProviderMissing');
      setupNote.textContent=t(custom?'codexAPISetup':'codexSetup');
      const models=sourceChanged ? [] : current.codexModels ?? [];
      const loading=!!current.codexModelsLoading || codexOpenLoading;
      const error=current.codexModelsError || codexOpenError;
      modelSelect.disabled=!custom && loading && models.length===0;
      modelSelect.setAttribute('aria-busy',String(loading));
      modelDescription.textContent=loading ? t('codexModelsLoading') : error ? translateRuntimeText(error,locale) : custom ? t('codexAPIModelDescription') : models.length ? t('codexModelDescription') : t('codexModelsEmpty');
      updateEfforts();
      const selectedModel=custom ? codexDraft!.apiModel || '' : codexDraft!.model;
      const unlisted=custom && !!selectedModel && !models.some(value=>value.id===selectedModel);
      apiModelRow.hidden=!custom || !(customModelEditing || unlisted);
      apiModelID.disabled=!custom || !!current.codexBusy || !actions.saveCodex;
      if(!customModelEditing && document.activeElement!==apiModelID)apiModelID.value=codexDraft!.apiModel || '';
      const fingerprint=JSON.stringify([models,selectedModel,custom,profile?.model,customModelEditing,locale]);
      if(fingerprint===modelFingerprint)return;
      modelFingerprint=fingerprint;
      modelSelect.replaceChildren(new Option(custom ? t('codexAPIDefaultModel',{model:profile?.model || '—'}) : t('codexDefaultModel'),''));
      const seen=new Set<string>();
      for(const model of models){
        if(!model.id || seen.has(model.id))continue;
        seen.add(model.id);modelSelect.append(new Option(model.displayName||model.id,model.id));
      }
      if(custom){
        modelSelect.append(new Option(t('codexAPICustomModel'),'__custom__'));
        modelSelect.value=customModelEditing || unlisted ? '__custom__' : selectedModel;
      } else {
        if(selectedModel && !seen.has(selectedModel))modelSelect.append(new Option(selectedModel,selectedModel));
        modelSelect.value=selectedModel;
      }
    };
    updateCodexModels();
    apiDetails.after(modelRow,apiModelRow,effortRow);

    const scope=element('select','ide-dropdown-setting form-select form-select-sm');scope.id='opt-codex-context';
    scope.append(new Option(t('codexContextNormal'),'selection'),new Option(t('codexContextOnDemand'),'project'),new Option(t('codexContextPersistent'),'persistent'));
    scope.value=codexDraft.contextMode==='selection'?'selection':codexDraft.cacheMode==='persistent'?'persistent':'project';
    scope.onchange=()=>{codexDraft!.contextMode=scope.value==='selection'?'selection':'project';codexDraft!.cacheMode=scope.value==='selection'?'normal':scope.value==='persistent'?'persistent':'on-demand';scheduleCodexSave();};
    section.append(row(t('codexContext'),t('codexContextDescription'),scope));
    const retention=element('p','opt-note',t('codexCacheRetention'));section.append(retention);

    const budget=element('div','opt-api-budget');budget.id='opt-codex-api-budget';
    budget.setAttribute('role','group');budget.setAttribute('aria-labelledby','opt-codex-api-budget-title');
    const budgetTitle=element('p','opt-note');budgetTitle.id='opt-codex-api-budget-title';
    budgetTitle.append(element('strong','',t('codexAPIBudget')));
    const budgetNote=element('p','opt-note',t('codexAPIBudgetDescription'));budgetNote.id='opt-codex-api-budget-description';
    budget.append(budgetTitle,budgetNote);
    const budgetInputs:HTMLInputElement[]=[];
    for(const [key,id,title,description] of [
      ['apiMaxReadRounds','opt-codex-api-read-rounds','codexAPIReadRounds','codexAPIReadRoundsDescription'],
      ['apiMaxToolCalls','opt-codex-api-tool-calls','codexAPIToolCalls','codexAPIToolCallsDescription'],
      ['apiTimeoutSeconds','opt-codex-api-timeout','codexAPITimeout','codexAPITimeoutDescription'],
    ] as const){
      const limits=API_BUDGET_LIMITS[key];
      const input=element('input','form-control form-control-sm');input.id=id;
      input.type='number';input.inputMode='numeric';input.required=true;
      input.min=String(limits.min);input.max=String(limits.max);input.step='1';
      input.value=String(codexDraft[key] ?? limits.default);
      const control=element('div','opt-budget-control');
      const error=element('p','opt-budget-error',t('codexAPIBudgetInvalid',limits));
      error.id=id+'-error';error.hidden=true;error.setAttribute('aria-live','polite');
      control.append(input,error);
      const setting=row(t(title),t(description,limits),control);
      const hint=setting.querySelector<HTMLElement>('.ide-setting-description')!;hint.id=id+'-description';
      input.setAttribute('aria-describedby',`${hint.id} ${budgetNote.id} ${error.id}`);
      const valid=()=>input.validity.valid && Number.isInteger(input.valueAsNumber)
        && input.valueAsNumber>=limits.min && input.valueAsNumber<=limits.max;
      const showValidity=()=>{const ok=valid();input.setAttribute('aria-invalid',String(!ok));error.hidden=ok;return ok;};
      // Keep uncommitted/invalid drafts out of autosaved project settings.
      input.oninput=()=>{if(input.hasAttribute('aria-invalid'))showValidity();};
      input.onblur=()=>{
        if(!showValidity())return;
        if(codexDraft![key]===input.valueAsNumber)return;
        codexDraft![key]=input.valueAsNumber;scheduleCodexSave();
      };
      budgetInputs.push(input);budget.append(setting);
    }
    updateBudget=()=>{
      budget.hidden=!codexDraft!.providerId || codexDraft!.contextMode!=='project';
      for(const input of budgetInputs)input.disabled=budget.hidden || !actions.saveCodex;
    };
    updateBudget();section.append(budget);

    const instructions=element('textarea','form-control form-control-sm opt-codex-instructions');instructions.id='opt-codex-instructions';instructions.rows=4;instructions.maxLength=8000;
    instructions.value=codexDraft.instructions;instructions.placeholder=t('codexInstructionsPlaceholder');
    instructions.oninput=()=>{codexDraft!.instructions=instructions.value;scheduleCodexSave(true);};
    instructions.onblur=()=>{void flushCodexSave();};
    const instructionRow=row(t('codexInstructions'),t('codexInstructionsDescription'),instructions);instructionRow.classList.add('opt-codex-instructions-row');section.append(instructionRow);
    const buttons=element('div','opt-actions');
    buttons.append(
      actionButton(t('codexCheck'),'codex-check',async()=>{codexOpenError='';await actions.checkCodex?.();update();},true),
      actionButton(t('codexDefaults'),'codex-defaults',async()=>{
        codexDefaultsError='';
        await flushCodexSave();
        if(codexSaveError)throw new Error(t('codexSaveFailed',{error:codexSaveError}));
        try {await actions.defaultsCodex?.();}
        catch(error){codexDefaultsError=error instanceof Error?error.message:String(error);throw error;}
      }),
      actionButton(t('codexSyncProjectCache'),'codex-sync-project',async()=>{
        try {codexSyncStatus=await actions.onSyncProjectCache!();}
        catch(error){codexSyncStatus=error instanceof Error?error.message:String(error);throw error;}
        finally {if(available())update();}
      }),
    );
    section.append(buttons,element('p','opt-note',t('codexDefaultsDescription')),setupNote);
    if(actions.inspectProjectCache){
      const cacheDetails=element('div','opt-actions');
      const cacheInfo=element('p','opt-note');cacheInfo.setAttribute('role','status');cacheInfo.style.whiteSpace='pre-wrap';
      const clearConfirm=actionButton(t('codexCacheClearConfirm'),'codex-cache-confirm',async()=>{cacheInfo.textContent=await actions.clearProjectCache!();clearConfirm.hidden=true;});clearConfirm.hidden=true;clearConfirm.classList.replace('btn-secondary','btn-danger');
      cacheDetails.append(actionButton(t('codexCacheInspect'),'codex-cache-inspect',async()=>{clearConfirm.hidden=true;cacheInfo.textContent=await actions.inspectProjectCache!();}));
      if(actions.clearProjectCache)cacheDetails.append(actionButton(t('codexCacheClear'),'codex-cache-clear',async()=>{clearConfirm.hidden=true;cacheInfo.textContent=await actions.inspectProjectCache!()+'\n\n'+t('codexCacheClearWarning');clearConfirm.hidden=false;}),clearConfirm);
      if(actions.openProjectCache)cacheDetails.append(actionButton(t('codexCacheOpen'),'codex-cache-open',async()=>{clearConfirm.hidden=true;cacheInfo.textContent=await actions.openProjectCache!();}));
      section.append(cacheDetails,cacheInfo);
    }
    statusNode=element('div','opt-status');statusNode.id='opt-codex-status';statusNode.setAttribute('role','status');section.append(statusNode);
    panel.append(section);update();
  }

  async function loadCodexOnOpen() {
    if(!actions.openCodex || codexOpenLoading || !available())return;
    codexOpenLoading=true;codexOpenError='';update();
    try { await actions.openCodex(); }
    catch(error){ if(available())codexOpenError=error instanceof Error ? error.message : String(error); }
    finally {codexOpenLoading=false;if(available())update();}
  }

  function updateNavigation() {
    const label=tabNode?.querySelector('.opt-tab-label');if(label)label.textContent=t('extension');
    for(const [id,key] of [[PREVIEW_TAB,'previewTab'],[CODEX_TAB,'codexTab']] as const){
      const button=childrenNode?.querySelector<HTMLButtonElement>('#'+id);if(button)button.textContent=t(key);
    }
  }

  function mount() {
    if (!available()) return;
    if(!style.isConnected)document.head.append(style);
    const body=document.querySelector<HTMLElement>('[role="dialog"] .ide-settings-modal-body');
    if(!body) {if(active){void flushSave();void flushCodexSave();}removeNavListener?.();removeNavListener=undefined;currentDialog=null;panel=null;tabNode=null;childrenNode=null;statusNode=null;detailsNode=null;localStatusNode=null;updateRootControls=undefined;updatePreviewSources=undefined;updateCodexModels=undefined;updateCodexCopyPreferences=undefined;active=false;savedNative=[];return;}
    if(body.querySelector('#'+TAB)) return;
    const nav=body.querySelector<HTMLElement>('.ide-settings-tab-nav[role="tablist"]');
    const content=body.querySelector<HTMLElement>('.ide-settings-tab-content');
    if(!nav||!content) return;
    const avatarURL=context.assetURL('assets/zero-two-avatar.png');
    if(!avatarURL) return;
    currentDialog=body;
    const tab=element('button','ide-settings-tab-link ide-settings-tab-link-button nav-link');tab.type='button';tab.id=TAB;tab.setAttribute('aria-controls',CHILDREN);tab.setAttribute('aria-expanded','false');
    const avatar=element('span','opt-tab-avatar');avatar.setAttribute('aria-hidden','true');
    const avatarImage=element('img');avatarImage.src=avatarURL;avatarImage.alt='';avatarImage.onerror=()=>{avatar.hidden=true;};avatar.append(avatarImage);
    const chevron=element('span','opt-tab-chevron');chevron.setAttribute('aria-hidden','true');
    tab.append(avatar,element('span','opt-tab-label',t('extension')),chevron);
    nav.insertBefore(tab,nav.querySelector('a'));
    tabNode=tab;
    childrenNode=element('div');childrenNode.id=CHILDREN;childrenNode.hidden=true;childrenNode.setAttribute('role','presentation');tab.after(childrenNode);
    const preview=element('button','ide-settings-tab-link ide-settings-tab-link-button nav-link opt-settings-child',t('previewTab'));
    const codex=element('button','ide-settings-tab-link ide-settings-tab-link-button nav-link opt-settings-child',t('codexTab'));
    for(const [button,id,section] of [[preview,PREVIEW_TAB,'preview'],[codex,CODEX_TAB,'codex']] as const){
      button.type='button';button.id=id;button.setAttribute('role','tab');button.setAttribute('aria-controls',PANEL);button.setAttribute('aria-selected','false');button.tabIndex=-1;
      button.onclick=()=>{
        if(!available() || active && activeSection===section)return;
        void flushSave();
        void flushCodexSave();
        const switching=active;
        if(!active){
          savedNative=[...nav.querySelectorAll<HTMLElement>('[role=tab]')].filter(el=>!childrenNode!.contains(el)).map(el=>({el,selected:el.getAttribute('aria-selected'),tabIndex:el.getAttribute('tabindex')}));
          for(const {el} of savedNative){el.setAttribute('aria-selected','false');el.tabIndex=-1;}
          const settings=getModel().settings;
          if(!pendingSave && !saveTask)draft=copySettings(settings);if(!pendingCodexSave && !codexSaveTask)codexDraft=undefined;
        }
        active=true;activeSection=section;currentDialog!.classList.add('opt-settings-active');
        for(const child of [preview,codex]){child.setAttribute('aria-selected',String(child===button));child.classList.toggle('active',child===button);child.tabIndex=child===button?0:-1;}
        panel!.hidden=false;panel!.classList.add('active');panel!.setAttribute('aria-labelledby',id);renderForm(switching);
        if(section==='codex')void loadCodexOnOpen();
      };
      childrenNode.append(button);
    }
    panel=element('div','tab-pane');panel.id=PANEL;panel.hidden=true;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',PREVIEW_TAB);content.append(panel);
    tab.onclick=()=>{
      if(!available())return;
      const expanded=tab.getAttribute('aria-expanded')!=='true';
      tab.setAttribute('aria-expanded',String(expanded));childrenNode!.hidden=!expanded;
      preview.tabIndex=expanded?0:-1;
      if(!expanded)closePanel();
    };
    const nativeClick=(event:Event)=>{if(active&&!(event.target as Element).closest('#'+TAB+',#'+CHILDREN))closePanel();};
    nav.addEventListener('click',nativeClick,true);
    removeNavListener=()=>nav.removeEventListener('click',nativeClick,true);
    const onKey=(event:KeyboardEvent)=>{
      if(!available())return;
      const target=event.currentTarget as HTMLButtonElement;
      if(target===tab && (event.key==='ArrowRight'||event.key==='ArrowLeft')){
        event.preventDefault();event.stopPropagation();
        if(event.key==='ArrowRight'){
          if(childrenNode!.hidden)tab.click();else preview.focus();
        }else if(!childrenNode!.hidden)tab.click();
        return;
      }
      if(target!==tab && event.key==='ArrowLeft'){event.preventDefault();event.stopPropagation();tab.focus();return;}
      if(event.key==='ArrowUp'||event.key==='ArrowDown'){
        event.preventDefault();event.stopPropagation();const tabs=[...nav.querySelectorAll<HTMLButtonElement>('[role=tab],#'+TAB)].filter(node=>!node.closest('[hidden]'));
        const index=tabs.indexOf(target);const next=tabs[(index+(event.key==='ArrowUp'?-1:1)+tabs.length)%tabs.length];
        if(next!==tab)next.click();next.focus();
      }
    };
    tab.onkeydown=onKey;preview.onkeydown=onKey;codex.onkeydown=onKey;
  }

  function update() {
    if(!available())return;
    if(activeSection==='codex' && active){
      updateActionButtons();updateCodexModels?.();
      const model=getModel();
      const position=panel?.querySelector<HTMLSelectElement>('#opt-codex-position');
      if(position && !position.disabled)position.value=model.codexPanelPosition || 'left';
      const busyBehavior=panel?.querySelector<HTMLSelectElement>('#opt-codex-busy-message-behavior');
      if(busyBehavior && !busyBehavior.disabled)busyBehavior.value=model.codexBusyMessageBehavior==='steer'?'steer':'queue';
      updateCodexCopyPreferences?.();
      const error=model.codexModelsError || codexOpenError;
      const loading=!!model.codexModelsLoading || codexOpenLoading;
      const status=codexSyncStatus ? translateRuntimeText(codexSyncStatus,locale) : codexSaveError ? t('codexSaveFailed',{error:translateRuntimeText(codexSaveError,locale)}) : codexDefaultsError ? translateRuntimeText(codexDefaultsError,locale) : error ? translateRuntimeText(error,locale) : loading ? t('codexModelsLoading') : model.codexStatus ? translateRuntimeText(model.codexStatus,locale) : t('codexUnchecked');
      const retry=panel?.querySelector<HTMLButtonElement>('[data-opt-action=codex-check]');
      if(retry){retry.textContent=t(error?'codexRetry':'codexCheck');retry.disabled ||= loading;}
      if(statusNode && statusNode.textContent!==status)statusNode.textContent=status;
      return;
    }
    if(!statusNode||!detailsNode)return;
    const model=getModel();
    updateRootControls?.();
    updatePreviewSources?.();
    updateActionButtons();
    if(localStatusNode) {
      const localStatus=model.localStatus?translateRuntimeText(model.localStatus,locale):t('localUnchecked');
      if(localStatusNode.textContent!==localStatus)localStatusNode.textContent=localStatus;
    }
    const status=saveError?t('saveFailed',{error:translateRuntimeText(saveError,locale)}):translateRuntimeText(model.status,locale)+(model.editorReady?'':'\n'+t('waitingEditor'));
    const retry=panel?.querySelector<HTMLButtonElement>('[data-opt-action=retry-save]');if(retry)retry.hidden=!saveError;
    if(statusNode.textContent!==status)statusNode.textContent=status;
    const old=detailsNode.querySelector('.opt-support-diagnostics');const div=element('div','opt-support-diagnostics');
    const rootInfo=element('p','',t('rootStatus',{path:model.rootPath||t('unknownRoot')}));rootInfo.id='opt-root-status';div.append(rootInfo);
    div.append(element('p','',t('supportCounts',{commands:model.index.commands.length,packages:model.index.packages.length,files:model.index.files.length})));
    div.append(element('p','',model.index.packages.map(p=>p.name).join(t('packageSeparator'))||t('noPackages')));
    const list=element('ul');for(const d of model.index.diagnostics.slice(0,60)){
      const message=translateRuntimeText(d.message,locale);
      list.append(element('li','',d.source?t('diagnosticSource',{source:d.source,message}):message));
    }div.append(list);
    if(old)old.replaceWith(div);else detailsNode.append(div);
  }
  function available() { return !destroyed && context.alive(); }
  function destroy() {
    if(destroyed)return;
    clearTimeout(saveTimer);
    clearTimeout(codexSaveTimer);
    destroyed=true;
    context.signal.removeEventListener('abort',destroy);
    stopObservingLocale();observer?.disconnect();removeNavListener?.();
    closePanel();tabNode?.remove();childrenNode?.remove();panel?.remove();style.remove();
    tabNode=null;childrenNode=null;panel=null;statusNode=null;detailsNode=null;localStatusNode=null;
    updateRootControls=undefined;updatePreviewSources=undefined;updateCodexModels=undefined;updateCodexCopyPreferences=undefined;currentDialog=null;
  }
  context.signal.addEventListener('abort',destroy,{once:true});
  if(available()) {
    observer=new MutationObserver(()=>mount());observer.observe(document.documentElement,{childList:true,subtree:true});
    stopObservingLocale=observeLocale(()=>{if(!available())return;locale=getLocale();updateNavigation();if(active)renderForm(true);});
    mount();
  } else destroy();
  return { update, refreshForm:()=>{if(available()&&active)renderForm();}, destroy };
}
