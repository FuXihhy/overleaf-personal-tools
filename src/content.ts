import { captureEditorContext } from './codex/editor-context';
import { DEFAULT_SETTINGS, emptyIndex, type Settings, type ProjectIndex } from './core/types';
import { buildProjectIndex } from './core/project-index';
import { applyPreviewSources } from './core/preview-sources';
import { parseTex } from './core/parser';
import { enrichIndex } from './packages';
import { OverleafProjectSource } from './overleaf/project-source';
import { createEditorConnection } from './overleaf/editor-connection';
import { revealSource } from './overleaf/source-navigation';
import { selectedSourcePath } from './overleaf/source-path';
import { loadSettings, saveSettings, saveDefaults, validateSettings } from './settings/storage';
import { mountNativeSettings, type PanelModel } from './settings/native-panel';
import { TexPreviewService } from './preview/tex-service';
import { cancelLocalTex, getLocalStatus } from './preview/local-client';
import { getLocale, observeLocale, translateRuntimeText } from './i18n';
import { completionListChanged, completionSourceStyles, styleCompletionSources } from './overleaf/completion-style';
import { mountPreviewPopup, previewPopupStyles, type PopupContent, type PopupAnchor } from './preview/popup';
import { mountVisualMathRenderer } from './preview/visual-math';
import { createExtensionContext } from './extension-context';
import { mountExtensionRecoveryNotice } from './extension-recovery';
import { isExtensionContextInvalidated } from './runtime-connection';
import { readOverleafAccount } from './overleaf/account';
import { mountCodexAssistant } from './codex/panel';
import { CodexClient } from './codex/client';
import { CodexCatalogue } from './codex/catalogue';
import { DEFAULT_CODEX_SETTINGS, isCodexSelection, sourcePath, validateCodexSettings, type CodexAnswerQuote, type CodexMessage, type CodexSelection } from './codex/types';
import { codexStorageKey, loadCodexSettings, saveCodexSettings, saveCodexDefaults, loadCodexMessages, saveCodexMessages, loadCodexPanelPosition, saveCodexPanelPosition, loadCodexClickToCopy, saveCodexClickToCopy, loadCodexCopyToast, saveCodexCopyToast, loadCodexBusyMessageBehavior, saveCodexBusyMessageBehavior } from './codex/storage';
import type { CodexEvent } from './codex/types';
import { syncCodexProjectSource, type CodexProjectSnapshot } from './codex/context';
import { CodexSourceGuard } from './codex/source-guard';
import { CodexCacheFreshness } from './codex/cache-freshness';
import { mergeConversationHistory } from './codex/history-state';
import { CodexHistorySync } from './codex/history-sync';
import { PromptQueue, type CapturedPrompt } from './codex/prompt-queue';

type PreviewResult = { svg?: string; dataUrl?: string; width?: number; height?: number; fallbackText?: string; unresolvedCommands?: string[]; draft?: boolean; diagnostics: string[] };

async function start() {
  const parsedProjectId = /^\/project\/([a-f0-9]{24})(?:\/|$)/.exec(location.pathname)?.[1];
  if (!parsedProjectId) return;
  const projectId: string = parsedProjectId;
  const context = createExtensionContext();
  if (!context.alive()) return;
  const model: PanelModel = { settings: DEFAULT_SETTINGS, files: [], index: emptyIndex(), status: '正在读取项目文件…', busy: true, editorReady: false, codex: { ...DEFAULT_CODEX_SETTINGS } };
  const accountId = readOverleafAccount();
  const codexClient = new CodexClient(projectId, accountId, () => context.invalidate('extension-updated'));
  const provider = () => model.codex?.providerId;
  const requestCodex: CodexClient['request'] = async (...args) => {
    const [op,data,onEvent]=args;
    try {
      if (op === 'provider-list' || op.startsWith('source-') || !provider()) return await codexClient.request(...args);
      const scoped={...data,providerId:provider()};
      return await (onEvent ? codexClient.request(op,scoped,onEvent) : codexClient.request(op,scoped));
    } catch(error) { if(op!=='status' && op!=='provider-list')codexCatalogue.reportFailure(error); throw error; }
  };
  const loadAssistantMessages = () => provider() ? loadCodexMessages(projectId,accountId,provider()) : loadCodexMessages(projectId,accountId);
  const saveAssistantMessages = (messages: CodexMessage[]) => provider() ? saveCodexMessages(projectId,accountId,messages,provider()) : saveCodexMessages(projectId,accountId,messages);
  let codexMessages: CodexMessage[] = [];
  let codexSending = false;
  let codexGeneration = 0;
  let codexReady = false;
  let codexCancelled = false;
  let sourceRecoveryWarning = '';
  let codexNativePending = false;
  let codexHistoryBusy = false;
  let nativeHistoryLoaded = false;
  let historyRestoreError = false;
  let activeConversationId: string | undefined;
  let historyCursor: string | undefined;
  let syncRevision: string | undefined;
  let remoteConversationState:'idle'|'active'|'unknown'='idle';
  let historySync: CodexHistorySync | undefined;
  const promptQueue=new PromptQueue();
  const queuePendingIds=new Set<string>();
  let queuePreparing=0, queueDraining=false, activeTurnId:string|undefined, activeCanSteer=false;
  let queueSave=Promise.resolve();
  let queueRevision='';
  let selectedFile = '';
  let sourceRevealsPending = 0;
  let projectSourceSync: Promise<void> = Promise.resolve();
  const codexText = (zh: string, en: string) => getLocale() === 'zh' ? zh : en;
  const source = new OverleafProjectSource(projectId);
  const texService = new TexPreviewService(projectId, undefined, context.alive);
  let previewIndex: ProjectIndex = emptyIndex();
  let rootPath = '';
  let revision = 0;
  let buildGeneration = 0;
  let indexSignature = '';
  let rebuildTimer: ReturnType<typeof setTimeout>;
  const liveDocuments = new Map<string, string>();
  let cacheReadError=false, cachePossiblyStale=false, cacheSavedOnly=false;
  function refreshCacheNotice(){
    if(!context.alive())return;
    codexPanel.setCacheNotice(model.codex?.enabled && model.codex.contextMode==='project'
      ? cacheReadError?'error':cacheSavedOnly?'saved':cachePossiblyStale?'stale':null : null);
  }
  function cacheFailure(){cacheReadError=true;refreshCacheNotice();}
  const cacheFreshness=new CodexCacheFreshness({changed:stale=>{cachePossiblyStale=stale;refreshCacheNotice();}});
  function snapshotNote(snapshot: { fileCount?: number; sourceFileCount?: number }) {
    const count = snapshot.fileCount ?? snapshot.sourceFileCount;
    return count ? codexText(`完整项目已同步：${count} 个源文件，可按需读取全文。`, `Complete project synced: ${count} source files available for reading.`) : codexText('完整项目快照可供读取。', 'The complete project snapshot is available for reading.');
  }
  async function captureProjectSnapshot(current: () => boolean, background = false): Promise<CodexProjectSnapshot> {
    try{return await captureProjectSnapshotInner(current,background);}
    catch(error){if(current())cacheFailure();throw error;}
  }
  async function captureProjectSnapshotInner(current: () => boolean, background = false): Promise<CodexProjectSnapshot> {
    const captureRevision=cacheFreshness.beginSync();
    // Capture only the active buffer. Previously visited files may have newer
    // collaborative edits in the fresh ZIP; stale caches must not replace them.
    const activePath = selectedSourcePath(), documents = new Map<string, string>();
    if (activePath || document.querySelector('.cm-editor')) {
      const live = await captureEditorContext({path:activePath,selectedPath:selectedSourcePath,current,signal:context.signal});
      if(live)documents.set(live.path,live.content);
    }
    // Sequential upload acknowledgements leave room for the active answer and
    // history/status requests on the shared native port, including while queuing.
    const operation = projectSourceSync.then(async () => {
      if (!current()) throw new Error(codexText('对话已改变，项目同步已取消。', 'The conversation changed; project synchronization was cancelled.'));
      if(!background)codexPanel.setStatus(codexText('正在同步完整项目…', 'Syncing the complete project…'));
      const full = await source.captureFull({ liveDocuments: documents, signal: context.signal });
      const result=await syncCodexProjectSource(full, (op, data) => requestCodex(op, data), current);
      cacheReadError=false;cacheSavedOnly=!!(activePath || document.querySelector('.cm-editor')) && !documents.size;cacheFreshness.synced(full.files,captureRevision);refreshCacheNotice();
      return result;
    });
    projectSourceSync = operation.then(() => {}, () => {});
    try { return await operation; }
    catch (error) { throw new Error(codexText('完整项目同步失败。', 'Complete project synchronization failed.') + ' ' + codexError(error)); }
    finally { if (!background && current()) codexPanel.setStatus(codexSending ? codexText('正在思考…', 'Thinking…') : ''); }
  }
  const sourceGuards = new Set<CodexSourceGuard>();
  function guardProjectSnapshot(snapshotId:string,current:()=>boolean,failed:(error:Error)=>void) {
    const guard=new CodexSourceGuard({current,failed,
      check:async()=>{
        let unavailable=false;
        try {
          const event=await codexClient.request('source-check',{snapshotId},event=>{if(event.type==='error' && event.errorCode==='source_unavailable')unavailable=true;});
          if(event.type!=='source' || event.snapshotId!==snapshotId)throw new Error('The local connection could not verify this project cache. Update the local connection.');
          return true;
        }catch(error){if(current())cacheFailure();if(unavailable)return false;throw error;}
      },
      repair:()=>captureProjectSnapshot(current,true),
    });
    return guard;
  }
  const signatures = new Map<string, string>();
  let currentFormula: { tex: string; display: boolean; location?: string } | null = null;
  let currentAnchor: PopupAnchor | null = null;
  let presented: {location?:string;content:PopupContent}|undefined;
  let editorFailed = false;
  let renderGeneration = 0;
  let renderer: Promise<typeof import('./preview/render')> | undefined;
  const renderCache = new Map<string, PreviewResult>();
  const draftCache = new Map<string, PreviewResult>();
  const draftRequests = new Map<string,number>();
  let pdfRenderer: Promise<typeof import('./preview/cloud-pdf')> | undefined;
  let rendering = false;
  let pendingPreview = false;
  let pdfAbort: AbortController | undefined;
  let previewFrame = 0;
  let texTimer: ReturnType<typeof setTimeout>;
  let scheduledTexKey = '';
  let lastPreviewError: {key:string;result:PreviewResult} | undefined;

  const ui = mountNativeSettings(() => model, {
    async onSyncProjectCache() {
      if(!context.alive() || !codexReady || !model.codex?.enabled || model.codex.contextMode!=='project')throw new Error(codexText('请先启用完整项目上下文。','Enable complete project context first.'));
      const generation=codexGeneration;
      const result=await captureProjectSnapshot(()=>context.alive() && generation===codexGeneration,true);
      const changed=result.uploadedFileCount??result.fileCount;
      return codexText(`项目缓存已同步：${result.fileCount} 个文件，上传 ${changed} 个，其余复用本机缓存。`,`Project cache synced: ${result.fileCount} files; ${changed} uploaded, the rest reused locally.`);
    },
    async save(draft) {
      if(!context.alive())return;
      const next=validateSettings(draft);
      // The panel serializes storage writes. Apply only a persisted snapshot,
      // then let indexing run independently so rapid changes stay responsive.
      await saveSettings(projectId,next);
      if(!context.alive())return;
      const previous=model.settings;
      model.settings=next;
      reflectCloudBinding();
      const needsIndex=previous.rootFile!==next.rootFile || previous.extraFilesMode!==next.extraFilesMode
        || previous.autoFileName!==next.autoFileName || JSON.stringify(previous.extraFiles)!==JSON.stringify(next.extraFiles);
      const sourcesChanged=JSON.stringify(previous.previewSources)!==JSON.stringify(next.previewSources);
      const previewChanged=needsIndex || sourcesChanged || previous.preview!==next.preview
        || previous.previewEngine!==next.previewEngine || previous.texBackend!==next.texBackend || previous.texCompiler!==next.texCompiler;
      if(previewChanged) {
        renderGeneration++;pdfAbort?.abort();void cancelLocalTex();clearTimeout(texTimer);
        renderCache.clear();draftCache.clear();lastPreviewError=undefined;scheduledTexKey='';
      }
      if(sourcesChanged) {
        previewIndex=enrichIndex(applyPreviewSources(model.index,next));
        indexSignature=JSON.stringify({rootPath,index:previewIndex},(key,value)=>key==='offset'?undefined:value);
        revision++;
      }
      configureEditor(sourcesChanged || previous.preview!==next.preview);
      if(needsIndex)void rebuild();
      else if(previewChanged)schedulePreview();
      ui.update();
    },
    async defaults(draft) { if(!context.alive())return;await saveDefaults(draft);if(!context.alive())return;model.status='已设为默认；已有项目设置保持不变。';ui.update(); },
    async reconnectEditor() {
      await editorConnection.reconnect();
      if(!context.alive())throw new Error('editor-connection-disposed');
      editorFailed=false;
      model.editorReady=true;
      configureEditor(false);
      window.dispatchEvent(new Event('opt:measure'));
      ui.update();
    },
    async refresh() {
      if(!context.alive())return;
      liveDocuments.clear();
      signatures.clear();
      source.invalidate();
      texService.invalidate();
      if(model.settings.previewEngine==='tex')invalidateTexContext();
      await rebuild();
      if(!context.alive())return;
      configureEditor();
      window.dispatchEvent(new Event('opt:request-document'));
      ui.refreshForm();
    },
    async checkLocal() {
      if(!context.alive())return;
      model.localStatus=(await getLocalStatus(() => context.invalidate('extension-updated'))).message;
      if(!context.alive())return;
      ui.update();
    },
    async createCloudProject() {
      if(!context.alive())return;
      if(rendering)throw new Error('正在处理公式预览，请等待完成后再连接共享项目。');
      model.busy=true;model.status='正在连接账号共享预览项目…';ui.update();
      try {
        await texService.prepareSharedProject();
        if(!context.alive())return;
        model.status='共享预览项目已连接；本账号的其他项目会自动复用。';
      } finally {
        if(context.alive()) {
          reflectCloudBinding();model.busy=false;ui.update();schedulePreview();
        }
      }
    },
    async saveCodex(draft) {
      if (!context.alive()) return;
      const next = validateCodexSettings(draft), changed = next.providerId !== provider();
      const enabledChanged = next.enabled !== model.codex?.enabled;
      // Model/instruction edits affect future requests. Only source/lifecycle
      // changes need the native connection idle; typing must not await status.
      if(changed && (promptQueue.length || queuePreparing))throw new Error(codexText('请先处理或移除排队消息，再切换模型来源。','Finish or remove queued messages before switching model sources.'));
      const persist=async()=>{
        await saveCodexSettings(projectId, accountId, next);
        if (!context.alive()) return;
        model.codex = next;
        refreshCacheNotice();
        if (changed) {
          codexGeneration++; codexClient.close(); codexCatalogue.reset();
          activeConversationId=undefined; historyCursor=undefined; syncRevision=undefined;
          nativeHistoryLoaded=false; historyRestoreError=false;
          codexMessages=await loadAssistantMessages().catch(()=>[]);
          if (!context.alive()) return;
          codexPanel.setMessages(codexMessages); codexPanel.clearAnswerQuote(); codexPanel.setStatus('');
          codexPanel.setRemoteState('unknown'); codexPanel.setHistoryPaging({hasOlder:false});
          if (next.enabled) await restoreNativeHistory(true);
        }
        if (!next.enabled && (changed || enabledChanged)) {promptQueue.pause();publishQueue();codexClient.close();codexCatalogue.reset();}
      };
      // Reserve the connection before storage awaits so a new send cannot race
      // a source switch and get closed midway through its answer.
      if(changed || enabledChanged)await withCodexHistory(persist);
      else await persist();
      if(!context.alive())return;
      if(model.codex?.enabled && (changed || enabledChanged))void codexCatalogue.refresh();
      codexPanel.update(); if(changed || enabledChanged)historySync?.trigger();
      model.codexStatus = codexText('已自动保存。', 'Saved automatically.'); ui.update();
    },
    async defaultsCodex() {
      if(!context.alive())return;
      await saveCodexDefaults(accountId,{
        settings:validateCodexSettings(model.codex),
        panelPosition:model.codexPanelPosition || 'left',
        busyMessageBehavior:model.codexBusyMessageBehavior || 'queue',
        clickToCopy:model.codexClickToCopy===true,
        copyToast:model.codexCopyToast===true,
      });
      if(!context.alive())return;
      model.codexStatus=codexText('已设为默认；已有项目设置和项目补充要求保持不变。','Default set. Existing project settings and project instructions are unchanged.');ui.update();
    },
    async openCodex() { await refreshProviders(); if(context.alive())await codexCatalogue.refresh(); },
    refreshCodexProviders: refreshProviders,
    async manageCodexProviders() { const result = await chrome.runtime.sendMessage({type:"opt:open-api-settings"}); if (!result?.ok) throw new Error(codexText("暂时无法打开 API 连接设置。","Unable to open API connection settings.")); },
    async checkCodex() { await codexCatalogue.refresh(true); },
    setCodexPosition,
    async setCodexBusyMessageBehavior(behavior){
      if(!context.alive())return;await saveCodexBusyMessageBehavior(projectId,accountId,behavior);if(!context.alive())return;model.codexBusyMessageBehavior=behavior;codexPanel.update();ui.update();
    },
    async setCodexCopyToast(enabled){
      if(!context.alive())return;await saveCodexCopyToast(projectId,accountId,enabled);if(!context.alive())return;model.codexCopyToast=enabled;codexPanel.update();ui.update();
    },
    async setCodexClickToCopy(enabled) {
      if(!context.alive())return;
      await saveCodexClickToCopy(projectId,accountId,enabled);
      if(!context.alive())return;
      model.codexClickToCopy=enabled;codexPanel.update();ui.update();
    },
  }, context);

  async function refreshProviders() {
    await historySync?.whenIdle(); await codexCatalogue.whenIdle();
    if (!context.alive() || codexSending || codexHistoryBusy) return;
    try { const event=await requestCodex('provider-list'); if (context.alive()) { model.codexProviders=event.profiles ?? []; model.codexProvidersError=undefined; } }
    catch (error) { if(context.alive())model.codexProvidersError=codexError(error); }
    if(context.alive())ui.update();
  }

  const codexCatalogue = new CodexCatalogue(
    () => requestCodex('status'),
    () => codexSending || codexHistoryBusy || !!historySync?.busy,
    state => {
      if (!context.alive()) return;
      model.codexModels = state.models;
      model.codexModelsLoading = state.loading;
      model.codexModelsError = state.error ? codexError(new Error(state.error)) : undefined;
      model.codexStatus = state.loading
        ? codexText('正在读取模型连接…', 'Loading model connection…')
        : model.codexModelsError || state.message || codexText('Codex 已连接。', 'Codex connected.');
      codexPanel.setConnection({state:state.connection ?? 'unknown', message:state.error ? connectionSummary(state.error)+(state.connection==='reconnecting'?codexText(' · 重连中…',' · Reconnecting…'):'') : undefined, detail:state.diagnostic || state.error});
      ui.update();
    },
    Date.now,
    () => context.alive() && codexReady && !!model.codex?.enabled && document.visibilityState === 'visible',
  );

  function connectionSummary(message:string):string {
    if(/workspace (?:routing|connection)|account.*(?:discovery|connection|routing).*timed out/i.test(message)) return codexText('账号连接超时','Timed out');
    if(/sign in|signed in|log in/i.test(message)) return codexText('请先登录','Sign in required');
    return codexText('连接暂时中断','Connection interrupted');
  }
  function codexError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/workspace (?:routing discovery|connection) timed out|account.*(?:discovery|connection|routing).*timed out/i.test(message)) return codexText('Codex 账号连接超时；恢复连接后即可加载模型列表。','Codex account connection timed out. Models will load when the connection recovers.');
    if (/native messaging host.*not found|specified native messaging host|not registered/i.test(message)) return codexText('本机 Codex 连接程序未安装。请完成扩展配套安装后重试。', 'The local Codex helper is not installed. Complete the companion installation and try again.');
    if (/Codex is still holding this conversation/i.test(message)) return codexText('Codex 桌面仍占用这个对话。历史会继续同步；目前请在 Codex 续聊，或等待它释放会话后再从这里发送。', message);
    if (/New messages arrived from Codex/i.test(message)) return codexText('Codex 中有新消息。请等待对话同步后再发送，输入的问题已保留。', message);
    return message.slice(0, 1500);
  }
  async function setCodexPosition(position: 'left' | 'right') {
    if(!context.alive())return;
    await saveCodexPanelPosition(projectId, accountId, position);
    if(!context.alive())return;
    model.codexPanelPosition=position;codexPanel.setPosition(position);ui.update();
  }
  async function withCodexHistory<T>(read: () => Promise<T>): Promise<T> {
    if(!context.alive() || codexSending || codexHistoryBusy)throw new Error(codexText('请等待当前操作完成。','Wait for the current operation to finish.'));
    if(!codexReady)throw new Error(codexText('项目仍在载入，请稍后重试。','The project is still loading. Try again shortly.'));
    codexHistoryBusy=true;model.codexBusy=true;codexPanel.setBusy(true,'history');ui.update();
    try{
      await historySync?.whenIdle();await codexCatalogue.whenIdle();
      if(!context.alive())throw new Error(codexText('页面连接已关闭。','The page connection has closed.'));
      return await read();
    }
    finally{codexHistoryBusy=false;model.codexBusy=false;if(context.alive()){codexPanel.setBusy(false);ui.update();codexCatalogue.resume();historySync?.schedule();}}
  }
  function applyRemoteState(page: CodexEvent) {
    syncRevision=page.syncRevision;
    remoteConversationState=page.remoteState ?? 'idle';
    if(page.syncPending)codexPanel.setRemoteState(remoteConversationState,true);
    else codexPanel.setRemoteState(remoteConversationState);
    if(historyRestoreError && page.remoteState!=='unknown'){historyRestoreError=false;codexPanel.setStatus('');}
  }
  function applyHistory(page: CodexEvent) {
    if(!context.alive() || page.type!=='history')return;
    activeConversationId=page.conversationId ?? page.activeConversationId;
    historyCursor=page.nextCursor;nativeHistoryLoaded=true;
    applyRemoteState(page);
    codexMessages=page.messages ?? [];codexPanel.setMessages(codexMessages);
    codexPanel.setHistoryPaging({hasOlder:!!historyCursor});
  }
  async function restoreNativeHistory(connectionReserved = false) {
    const read=async()=>{applyHistory(await requestCodex('history-read'));};
    try{if(connectionReserved)await read();else await withCodexHistory(read);}
    catch(error){if(context.alive()){historyRestoreError=true;codexPanel.setRemoteState('unknown');codexPanel.setStatus(codexText('本机历史暂时无法读取，可在对话历史中重试。','Local history is unavailable. Retry from Conversation history.')+' '+codexError(error));}}
  }
  async function newCodexChat() {
    if(promptQueue.length || queuePreparing)throw new Error(codexText('请先处理或移除排队消息，再新建对话。','Finish or remove queued messages before starting a conversation.'));
    if (!context.alive() || codexSending || codexHistoryBusy) return;
    if (!codexReady) throw new Error(codexText('项目仍在载入，请稍后重试。', 'The project is still loading. Try again shortly.'));
    codexSending = true; model.codexBusy = true; codexPanel.setBusy(true,'history'); ui.update();
    try {
      await historySync?.whenIdle();
      await codexCatalogue.whenIdle();
      if(!context.alive())return;
      await requestCodex('new-chat');
      if (!context.alive()) return;
      codexMessages = []; codexPanel.setMessages([]); codexPanel.clearAnswerQuote();
      activeConversationId=undefined;historyCursor=undefined;nativeHistoryLoaded=true;
      syncRevision=undefined;codexPanel.setRemoteState('idle');
      codexPanel.setHistoryPaging({hasOlder:false});
      await saveAssistantMessages([]).catch(() => {});
      model.codexStatus = codexText('已开始此项目的新对话。', 'A new conversation is ready for this project.');
      codexPanel.setStatus(model.codexStatus);
    } finally {
      codexSending = false; model.codexBusy = false;
      if (context.alive()) { codexPanel.setBusy(false); ui.update(); codexCatalogue.resume(); }
    }
  }
  async function sendCodexQuestion(question: string, selection?: CodexSelection, answerQuote?: CodexAnswerQuote, prepared?:CapturedPrompt) {
      if (!context.alive() || codexSending || codexHistoryBusy || !model.codex?.enabled) throw new Error(codexText('请等待当前操作完成。','Wait for the current operation to finish.'));
      if(prepared && (prepared.providerId!==provider() || prepared.conversationId!==activeConversationId))throw new Error(codexText('排队消息属于其他对话，请检查后再发送。','The queued message belongs to another conversation. Review it before sending.'));
      if(prepared?.settings.contextMode==='project' && !prepared.snapshotId)throw new Error(codexText('这条旧排队消息仅保存了项目节选。请编辑后重新发送，以重新捕获完整项目。','This older queued message contains only excerpts. Edit and send it again to capture the complete project.'));
      if (!codexReady) throw new Error(codexText('项目仍在载入，请稍后重试。', 'The project is still loading. Try again shortly.'));
      question = question.trim(); if (!question) return;
      if (question.length > 16_000) throw new Error(codexText('问题超过 16000 字符，请缩短后发送。', 'Please keep the question under 16,000 characters.'));
      const generation = ++codexGeneration;
      sourceRecoveryWarning='';
      codexCancelled = false; codexNativePending = false;
      if(!promptQueue.length)promptQueue.resume();
      codexSending = true; model.codexBusy = true; codexPanel.setBusy(true); ui.update();
      const settings = prepared?.settings ?? { ...model.codex };
      const quotedSelection = selection ? { ...selection, before: '', after: '' } : undefined;
      const quotedAnswer = answerQuote ? { ...answerQuote } : undefined;
      const previousMessages = codexMessages;
      const questionMessage: CodexMessage = { role: 'user', text: question, ...(quotedSelection ? { selection: quotedSelection } : {}), ...(quotedAnswer ? { answerQuote: quotedAnswer } : {}) };
      const answerMessage: CodexMessage = { role: 'assistant', text: '' };
      codexMessages = [...previousMessages, questionMessage, answerMessage];
      if (quotedAnswer) codexPanel.appendMessage('user', question, quotedSelection, quotedAnswer);
      else codexPanel.appendMessage('user', question, quotedSelection);
      codexPanel.appendMessage('assistant', '');
      codexPanel.setStatus(model.codexModelsLoading
        ? codexText('正在连接本机 Codex…', 'Connecting to local Codex…')
        : codexText('正在整理项目上下文…', 'Preparing project context…'));
      let text = '', completed = false, submitted = false, accepted = false, rejected = false;
      let rollbackMessages = previousMessages;
      try {
        // Show the question and its quote immediately, including while the native
        // catalogue is loading. A second window may have extended the history.
        // Browser storage is only a fast display cache. Never replace a loaded
        // native conversation (including its earlier pages) with that excerpt.
        let latest = nativeHistoryLoaded ? previousMessages : await loadAssistantMessages().catch(() => previousMessages);
        rollbackMessages = latest;
        if (!context.alive() || generation !== codexGeneration || codexCancelled) return;
        if (JSON.stringify(latest) !== JSON.stringify(previousMessages)) {
          codexMessages = [...latest, questionMessage, answerMessage];
          codexPanel.setMessages(codexMessages);
        }
        await historySync?.whenIdle();
        await codexCatalogue.whenIdle();
        if (!context.alive() || generation !== codexGeneration || codexCancelled) return;
        if(accountId){
          const current=await requestCodex('history-read');
          if(!context.alive() || generation!==codexGeneration || codexCancelled)return;
          if(current.type==='history'){
            const merged=mergeConversationHistory(activeConversationId,previousMessages,historyCursor,current);
            activeConversationId=merged.id;historyCursor=merged.cursor;nativeHistoryLoaded=true;
            applyRemoteState(current);
            if(prepared && prepared.conversationId!==activeConversationId)throw new Error(codexText('其他窗口切换了对话，排队消息已暂停。','Another window switched conversations. The queued message is paused.'));
            latest=merged.messages;
            rollbackMessages=latest;
            if(JSON.stringify(latest)!==JSON.stringify(previousMessages)){
              codexMessages=[...latest,questionMessage,answerMessage];codexPanel.setMessages(codexMessages);
            }
            codexPanel.setHistoryPaging({hasOlder:!!historyCursor});
            if(current.remoteState==='active')throw new Error(provider() ? codexText('另一个窗口正在回复这个对话，请等待完成后再发送。','This conversation is answering in another window. Wait for it to finish.') : codexText('Codex 桌面正在回复这个对话，请等待完成后再发送。','Codex is replying to this conversation on the desktop. Wait for it to finish.'));
            if(current.remoteState==='unknown')throw new Error(codexText('暂时无法确认最新对话，请同步成功后再发送。','The latest conversation is unavailable. Wait for synchronization before sending.'));
          }
        }
        let files: Array<{ path: string; content: string }> = [];
        let note = '', snapshotId: string | undefined;
        if(prepared){files=prepared.files;snapshotId=prepared.snapshotId;note=prepared.note;}
        else if (settings.contextMode === 'project') {
          const result = await captureProjectSnapshot(() => context.alive() && generation === codexGeneration && !codexCancelled);
          snapshotId = result.snapshotId; note = snapshotNote(result);
        }
        if(snapshotId){
          const guard=guardProjectSnapshot(snapshotId,()=>context.alive() && generation===codexGeneration && !codexCancelled,error=>{
            cacheFailure();
            sourceRecoveryWarning=codexText('项目缓存恢复未完成：','Project cache recovery did not complete: ')+codexError(error);
            codexPanel.setStatus(sourceRecoveryWarning);
          });
          sourceGuards.add(guard);await guard.ensure();guard.start();
        }
        if (!context.alive() || generation !== codexGeneration || codexCancelled) return;
        codexPanel.setStatus(note || (provider() ? codexText('正在思考…','Thinking…') : codexText('Codex 正在思考…', 'Codex is thinking…')));
        codexNativePending = true;
        submitted = true;
        const result = await requestCodex('ask', { question, selection, ...(quotedAnswer ? { answerQuote: quotedAnswer } : {}), files, ...(snapshotId ? { snapshotId } : {}), settings, ...(accountId?{expectedConversationId:activeConversationId??null}:{}),...(syncRevision?{expectedSyncRevision:syncRevision}:{}) }, event => {
          if (!context.alive() || generation !== codexGeneration || codexCancelled) return;
          if (event.type === 'started' || event.type === 'delta') accepted = true;
          if (event.type === 'error' && event.notAccepted === true) rejected = true;
          if (event.type === 'error' && event.errorCode === 'source_unavailable') cacheFailure();
          if (event.type === 'started' && event.threadId) { activeConversationId=event.threadId;nativeHistoryLoaded=true;activeTurnId=event.turnId;activeCanSteer=!!event.canSteer && !!activeTurnId;codexPanel.setSteering(activeCanSteer);promptQueue.bindConversation(provider(),event.threadId);publishQueue(); }
          if (event.type === 'delta') { text += event.text || ''; answerMessage.text = text; codexPanel.setAssistantText(text); }
        });
        if (!context.alive() || generation !== codexGeneration) return;
        completed = true;
        text = result.text ?? text; answerMessage.text = text; codexPanel.setAssistantText(text);
        codexPanel.setStatus(codexCancelled ? codexText('已停止。', 'Stopped.') : sourceRecoveryWarning || note);
      } catch (error) {
        if (context.alive() && generation === codexGeneration && !codexCancelled) {
          // Roll back only requests that never left this page or were explicitly
          // rejected before admission. Lost acknowledgements remain uncertain.
          if (!submitted || rejected && !accepted && !text) {
            codexMessages = rollbackMessages;
            codexPanel.setMessages(codexMessages);
          }
          model.codexStatus = codexError(error); codexPanel.setStatus(model.codexStatus); throw new Error(model.codexStatus);
        }
      } finally {
        for(const guard of sourceGuards)guard.stop();sourceGuards.clear();
        if (context.alive() && generation === codexGeneration) {
          if (completed || codexCancelled && text) await saveAssistantMessages(codexMessages).catch(() => {});
          if(!completed || codexCancelled)promptQueue.pause();
          activeTurnId=undefined;activeCanSteer=false;codexPanel.setSteering(false);publishQueue();
          codexNativePending = false; codexSending = false; model.codexBusy = false; codexPanel.setBusy(false); ui.update();
          if (codexCancelled) codexPanel.setStatus(codexText('已停止。', 'Stopped.'));
          codexCatalogue.resume();
          historySync?.trigger();
          void drainQueue();
        }
      }
  }
  function saveQueue() {
    if(!accountId || typeof chrome.runtime.sendMessage!=='function')return Promise.resolve();
    const items=promptQueue.snapshot();
    queueSave=queueSave.catch(()=>{}).then(async()=>{
      const result=await chrome.runtime.sendMessage({type:'opt:codex-queue',projectId,accountId,action:'write',expectedRevision:queueRevision,items});
      if(!result?.ok || typeof result.revision!=='string')throw new Error(result?.message || 'Queued messages could not be saved.');
      queueRevision=result.revision;
    });return queueSave;
  }
  function publishQueue(persist=true) {
    codexPanel.setQueue(promptQueue.items.filter(item=>!queuePendingIds.has(item.id)),promptQueue.paused);
    if(persist)void saveQueue().catch(()=>{
      if(!context.alive())return;promptQueue.pause();codexPanel.setQueue(promptQueue.items.filter(item=>!queuePendingIds.has(item.id)),true);
      codexPanel.setStatus(codexText('排队消息暂时无法保存在浏览器中，队列已暂停。请保留文本后再刷新。','Queued messages could not be saved in this browser. The queue is paused; keep the text before refreshing.'));
    });
  }
  async function capturePrompt(question:string,selection?:CodexSelection,answerQuote?:CodexAnswerQuote):Promise<CapturedPrompt>{
    if(!codexReady || !model.codex?.enabled || !context.alive())throw new Error(codexText('项目仍在载入，请稍后重试。','The project is still loading. Try again shortly.'));
    question=question.trim();if(!question || question.length>16_000)throw new Error(codexText('问题需为 1–16000 个字符。','Keep the question between 1 and 16,000 characters.'));
    const generation=codexGeneration, settings={...model.codex},providerId=provider();
    const prompt:CapturedPrompt={question,settings,providerId,conversationId:activeConversationId,selection:selection?{...selection}:undefined,answerQuote:answerQuote?{...answerQuote}:undefined,files:[],note:''};
    if(settings.contextMode==='project'){
      const result=await captureProjectSnapshot(()=>context.alive() && !!model.codex?.enabled && generation===codexGeneration && providerId===provider());
      prompt.snapshotId=result.snapshotId;prompt.sourceFileCount=result.fileCount;prompt.sourceTotalBytes=result.totalBytes;prompt.note=snapshotNote(result);
    }
    if(!context.alive() || !model.codex?.enabled || generation!==codexGeneration || providerId!==provider())throw new Error(codexText('对话已改变，问题尚未加入队列。','The conversation changed. The question has not been queued.'));
    // The first turn may have acquired its conversation ID during collection.
    if(!prompt.conversationId)prompt.conversationId=activeConversationId;
    return prompt;
  }
  async function queueQuestion(question:string,selection?:CodexSelection,answerQuote?:CodexAnswerQuote){
    queuePreparing++;
    try{
      const id=promptQueue.add(await capturePrompt(question,selection,answerQuote));queuePendingIds.add(id);
      try{await saveQueue();}catch(error){queuePendingIds.delete(id);promptQueue.remove(id);promptQueue.pause();publishQueue(false);throw new Error(codexText('无法保存排队消息，问题与选区已保留。请检查浏览器存储后重试。','Could not save the queued message. Your question and selection were kept; check browser storage and try again.'));}
      queuePendingIds.delete(id);publishQueue(false);
    }
    finally{queuePreparing--;void drainQueue();}
  }
  async function steerQuestion(question:string,selection?:CodexSelection,answerQuote?:CodexAnswerQuote,prepared?:CapturedPrompt,onSubmit?:()=>void){
    const turnId=activeTurnId,conversationId=activeConversationId;
    if(!codexSending || !activeCanSteer || !turnId || !conversationId || provider())throw new Error(codexText('当前回复不支持引导，请使用排队。','This reply cannot be steered. Queue the follow-up instead.'));
    queuePreparing++;
    let sourceGuard:CodexSourceGuard|undefined,steerAccepted=false;
    try{
      const prompt=prepared ?? await capturePrompt(question,selection,answerQuote);
      if(prompt.settings.contextMode==='project' && !prompt.snapshotId)throw new Error(codexText('这条旧排队消息仅保存了项目节选。请编辑后重新发送，以重新捕获完整项目。','This older queued message contains only excerpts. Edit and send it again to capture the complete project.'));
      if(prompt.providerId!==provider() || prompt.conversationId!==conversationId)throw new Error(codexText('排队消息属于其他对话，请检查后再发送。','The queued message belongs to another conversation. Review it before sending.'));
      if(prompt.snapshotId){
        const generation=codexGeneration;
        sourceGuard=guardProjectSnapshot(prompt.snapshotId,()=>context.alive() && codexSending && generation===codexGeneration && !codexCancelled,error=>{
          cacheFailure();
          sourceRecoveryWarning=codexText('引导消息的项目缓存恢复未完成：','The steering message cache could not be restored: ')+codexError(error);
          codexPanel.setStatus(sourceRecoveryWarning);
        });
        sourceGuards.add(sourceGuard);await sourceGuard.ensure();
      }
      if(!codexSending || turnId!==activeTurnId || conversationId!==activeConversationId || !activeCanSteer)throw new Error(codexText('这一轮已结束，补充内容尚未发送。请使用排队或发送。','The turn ended. Your addition was not sent; queue or send it instead.'));
      onSubmit?.();
      const result=await requestCodex('steer',{question:prompt.question,selection:prompt.selection,answerQuote:prompt.answerQuote,files:prompt.files,...(prompt.snapshotId?{snapshotId:prompt.snapshotId}:{}),settings:prompt.settings,expectedConversationId:conversationId,expectedTurnId:turnId});
      if(!context.alive())return;
      if(result.type!=='steered' || result.threadId!==conversationId)throw new Error(codexText('无法确认补充内容是否被接收，请检查对话；不会自动重发。','The addition could not be confirmed. Check the conversation; it will not be resent automatically.'));
      steerAccepted=true;sourceGuard?.start();
      const item:CodexMessage={role:'user',text:prompt.question,...(result.userMessageId?{messageId:result.userMessageId}:{}),...(prompt.selection?{selection:{...prompt.selection,before:'',after:''}}:{}),...(prompt.answerQuote?{answerQuote:prompt.answerQuote}:{})};
      if(conversationId===activeConversationId && !codexMessages.some(message=>item.messageId && message.messageId===item.messageId)){
        if(codexSending && activeTurnId===turnId){codexMessages.splice(Math.max(0,codexMessages.length-1),0,item);codexPanel.insertSteeringMessage(item);}
        else{codexMessages.push(item);codexPanel.insertSteeringMessage(item,false);}
        await saveAssistantMessages(codexMessages).catch(()=>{});
      }
      if(!codexSending){await historySync?.whenIdle();if(context.alive() && conversationId===activeConversationId)historySync?.trigger();}
    }catch(error){promptQueue.pause();publishQueue();throw error;}finally{if(sourceGuard && !steerAccepted){sourceGuard.stop();sourceGuards.delete(sourceGuard);}queuePreparing--;void drainQueue();}
  }
  async function steerQueuedQuestion(id:string){
    if(!context.alive() || !model.codex?.enabled || !codexSending || !activeCanSteer || provider())throw new Error(codexText('当前回复不支持引导，消息仍在队列中。','This reply cannot be steered. The message remains queued.'));
    const turnId=activeTurnId,conversationId=activeConversationId;
    const item=promptQueue.beginItem(id,provider(),conversationId);
    if(!item)throw new Error(codexText('此消息已在处理或需要检查，不能重复发送。','This message is being processed or needs review; it cannot be sent again.'));
    let submitted=false;
    queuePreparing++;publishQueue(false);
    try{
      // Persist the admission marker before dispatch so another window cannot
      // drain the same item while it is being promoted into the active turn.
      await saveQueue();
      if(!context.alive() || turnId!==activeTurnId || conversationId!==activeConversationId)throw new Error(codexText('这一轮已结束，消息仍保留在队列中。','The turn ended. The message remains queued.'));
      await steerQuestion(item.prompt.question,item.prompt.selection,item.prompt.answerQuote,item.prompt,()=>{submitted=true;});
      promptQueue.finish(id);
    }catch(error){
      if(submitted)promptQueue.finish(id,codexError(error));
      else{promptQueue.release(id);promptQueue.pause();}
      throw error;
    }finally{queuePreparing--;publishQueue();void drainQueue();}
  }
  async function drainQueue(){
    if(queueDraining || queuePreparing || codexSending || codexHistoryBusy || remoteConversationState!=='idle' || promptQueue.paused || !promptQueue.length || !context.alive() || !model.codex?.enabled)return;
    queueDraining=true;
    try{
      await historySync?.whenIdle();await codexCatalogue.whenIdle();
      while(context.alive() && remoteConversationState==='idle' && !codexSending && !codexHistoryBusy && !queuePreparing && !promptQueue.paused && promptQueue.length && model.codex?.enabled){
        let item;
        try{item=promptQueue.begin(provider(),activeConversationId);}catch(error){codexPanel.setStatus(codexError(error));publishQueue();break;}
        if(!item)break;publishQueue(false);
        try{await saveQueue();await sendCodexQuestion(item.prompt.question,item.prompt.selection,item.prompt.answerQuote,item.prompt);promptQueue.finish(item.id,codexCancelled?codexText('已停止，请检查此项后继续。','Stopped. Review this item before continuing.'):undefined);}
        catch(error){promptQueue.finish(item.id,codexError(error));}
        publishQueue();await historySync?.whenIdle();
      }
    }finally{queueDraining=false;}
  }
  const codexPanel = mountCodexAssistant({
    projectId, getSettings: () => ({...(model.codex || DEFAULT_CODEX_SETTINGS),busyMessageBehavior:model.codexBusyMessageBehavior,clickToCopy:!!model.codexClickToCopy,copyToast:!!model.codexCopyToast,providerName:model.codexProviders?.find(p=>p.id===provider())?.name || (provider() ? 'API' : undefined)}), getIndex: () => model.index, context,
    onPositionChange:setCodexPosition,
    onVisibilityChange:open=>{historySync?.trigger();if(open && codexReady){cacheFreshness.refresh();refreshCacheNotice();void codexCatalogue.refresh();}},
    async onReconnect(){await codexCatalogue.refresh(true);historySync?.trigger();},
    async onRevealSource(selection) {
      if (!context.alive()) throw new Error(codexText('扩展已更新，请刷新页面。', 'The extension was updated. Refresh this page.'));
      sourceRevealsPending++;
      try {
        await revealSource(selection, { signal: context.signal, files: model.files.map(file => file.path) });
      } finally { sourceRevealsPending--; }
    },
    async onListConversations(cursor) {
      return withCodexHistory(async()=>{
        const result=await requestCodex('history-list',{...(cursor?{cursor}:{}),limit:30});
        return {conversations:result.conversations ?? [],nextCursor:result.nextCursor};
      });
    },
    async onSelectConversation(conversationId) {
      if(promptQueue.length || queuePreparing)throw new Error(codexText('请先处理或移除排队消息，再切换对话。','Finish or remove queued messages before switching conversations.'));
      await withCodexHistory(async()=>{
        const result=await requestCodex('history-select',{conversationId});
        if(!context.alive())return;
        applyHistory(result);codexPanel.clearSelection();codexPanel.clearAnswerQuote();codexPanel.setStatus('');
        await saveAssistantMessages(codexMessages).catch(()=>{});
      });
    },
    async onOpenConversationInCodex(id) {
      if (provider()) return;
      if(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id))window.location.assign('codex://threads/'+id);
    },
    async onLoadOlderMessages() {
      if(!activeConversationId || !historyCursor)return;
      const conversationId=activeConversationId,cursor=historyCursor;
      await withCodexHistory(async()=>{
        const result=await requestCodex('history-read',{conversationId,cursor});
        if(!context.alive() || conversationId!==activeConversationId)return;
        const older=result.messages ?? [];codexMessages=[...older,...codexMessages];
        historyCursor=result.nextCursor;codexPanel.prependMessages(older);codexPanel.setHistoryPaging({hasOlder:!!historyCursor});
      });
    },
    onSend: sendCodexQuestion,
    onQueue: queueQuestion,
    onSteer: steerQuestion,
    onSteerQueued: steerQueuedQuestion,
    onRemoveQueued(id){const prompt=promptQueue.remove(id);publishQueue();return prompt;},
    onResumeQueue(){if(promptQueue.resume()){publishQueue();void drainQueue();}},
    onCancel() {
      if (!codexSending) return;
      promptQueue.pause();publishQueue();
      codexCancelled = true;
      codexPanel.setStatus(codexText('正在停止…', 'Stopping…'));
      // The cancel ACK only means the signal was received. Keep the composer
      // busy until the original ask completes (or the connection closes).
      if (codexNativePending) void requestCodex('cancel').catch(() => codexClient.close());
    },
    onNewChat: newCodexChat,
  });

  historySync=new CodexHistorySync({
    enabled:()=>context.alive() && codexReady && !!accountId && (!!activeConversationId || !nativeHistoryLoaded || remoteConversationState==='unknown') && !!model.codex?.enabled && document.visibilityState==='visible' && codexPanel.isOpen(),
    available:()=>!codexSending && !codexHistoryBusy && !model.codexModelsLoading,
    async read(){
      const generation=codexGeneration,conversationId=activeConversationId;
      const page=await requestCodex('history-read',conversationId?{conversationId}:{});
      if(!context.alive() || codexSending || codexHistoryBusy || generation!==codexGeneration || conversationId!==activeConversationId || page.type!=='history')return;
      // A different browser tab may have selected a different conversation.
      // Keep this visible chat until the user explicitly switches or sends.
      const merged=mergeConversationHistory(activeConversationId,codexMessages,historyCursor,page);
      applyRemoteState(page);activeConversationId=merged.id;historyCursor=merged.cursor;nativeHistoryLoaded=true;
      if(JSON.stringify(merged.messages)!==JSON.stringify(codexMessages)){
        codexMessages=merged.messages;codexPanel.syncMessages(codexMessages);
        await saveAssistantMessages(codexMessages).catch(()=>{});
      }
      codexPanel.setHistoryPaging({hasOlder:!!historyCursor});
    },
    failed(){if(context.alive() && !codexSending && !codexHistoryBusy){remoteConversationState='unknown';codexPanel.setRemoteState('unknown');}},
    settled(){if(context.alive()){codexCatalogue.resume();void drainQueue();}},
  });
  context.signal.addEventListener('abort',()=>{historySync?.destroy();codexCatalogue.destroy();for(const guard of sourceGuards)guard.stop();sourceGuards.clear();},{once:true});
  window.addEventListener('focus',()=>{historySync?.trigger();codexCatalogue.resume();cacheFreshness.refresh();},{signal:context.signal});
  document.addEventListener('visibilitychange',()=>{historySync?.trigger();codexCatalogue.resume();cacheFreshness.refresh();},{signal:context.signal});

  const historyKey = () => codexStorageKey(projectId, accountId, provider()) + ':messages';
  const historyChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (!accountId || !codexReady || codexSending || codexHistoryBusy || !context.alive() || area !== 'local' || !changes[historyKey()]) return;
    if(nativeHistoryLoaded){historySync?.trigger();return;}
    const generation=codexGeneration,conversationId=activeConversationId;
    void loadAssistantMessages().then(messages => {
      if (!context.alive() || codexSending || codexHistoryBusy || nativeHistoryLoaded || generation!==codexGeneration || conversationId!==activeConversationId) return;
      codexMessages = messages; codexPanel.setMessages(messages);
    }).catch(() => {});
  };
  chrome.storage.onChanged?.addListener(historyChanged);
  context.signal.addEventListener('abort', () => { try{chrome.storage.onChanged?.removeListener(historyChanged);}catch{/* Retired extension context. */} }, { once: true });

  function reflectCloudBinding() {
    const binding=texService.cloud.getPreviewProject();
    model.settings.cloudProjectId=binding?.projectId;
    model.settings.cloudProjectName=binding?.name;
    model.settings.cloudCompiler=binding?.compiler;
    model.settings.cloudTexLiveVersion=binding?.texLiveVersion?.match(/20\d{2}/)?.[0];
  }

  const previewStyle = document.createElement('style');
  previewStyle.textContent = `
    ${previewPopupStyles}
    ${completionSourceStyles}
  `;
  document.head.append(previewStyle);
  const previewPopup=mountPreviewPopup({document,initial:{enabled:model.settings.preview,content:null,anchor:null}});
  const visualMath = mountVisualMathRenderer({
    enabled: () => context.alive() && model.settings.preview && !editorFailed,
    async render(tex, display) {
      // Native Visual math already handles ordinary formulas and line breaking.
      // Only supplement formulas which actually use indexed project macros.
      const commands = new Set([...tex.matchAll(/\\([A-Za-z@]+)/g)].map(match => match[1]));
      if (!previewIndex.macros.some(macro => commands.has(macro.name.replace(/^\\/, '')))) return { svg: '', diagnostics: [] };
      const engine = await loadRenderer();
      return engine.renderFormula(tex, previewIndex, display);
    },
  });

  function configureEditor(refreshVisual = true) {
    if(!context.alive())return;
    if(refreshVisual)visualMath.refresh();
    syncPreview();
    window.dispatchEvent(new CustomEvent('opt:configuration', {detail:JSON.stringify({commands:model.index.commands,settings:model.settings})}));
    styleCompletionSources(document,model.settings.completion?model.index.commands:[]);
  }

  function restorePreviews() {
    presented=undefined;
    previewPopup.update({enabled:model.settings.preview,content:null,anchor:null});
  }

  function schedulePreview() {
    if(!context.alive())return;
    syncPreview();
    if(!currentFormula||!model.settings.preview||editorFailed)return;
    // One render per paint, with no typing debounce for the in-browser draft.
    if(!previewFrame)previewFrame=requestAnimationFrame(()=>{previewFrame=0;void renderDraft();});
    const key=previewKey();
    if(model.settings.previewEngine==='tex' && scheduledTexKey!==key && !renderCache.has(key)){
      clearTimeout(texTimer);scheduledTexKey=key;
      texTimer=setTimeout(()=>void renderTex(),650);
    }
  }

  function previewKey(formula=currentFormula,settings=model.settings) {
    return formula?revision+'|'+settings.previewEngine+'|'+settings.texBackend+'|'+settings.texCompiler+'|'+formula.display+'|'+formula.tex:'';
  }

  async function loadRenderer() {
    if(renderer)return renderer;
    const url=context.assetURL('renderer.js');
    if(!url)throw new Error('扩展已更新，请刷新 Overleaf 页面。');
    return renderer ??= import(url);
  }

  function createSourceBody(tex:string,invalid=false) {
    const body=document.createElement('div');body.className='opt-formula-body';
    body.style.setProperty('--opt-interface-font',getComputedStyle(document.body).fontFamily);
    const source=document.createElement('span');source.className='opt-preview-source';
    // Plain text is the only fallback for unfinished structure. Never interpret
    // user TeX as HTML, and never show a previous formula as the current one.
    source.textContent=tex.length>2000?tex.slice(0,2000)+'…':tex;
    if(invalid)source.style.color='#c62828';
    body.append(source);
    return body;
  }

  function syncPreview() {
    if(!context.alive())return;
    if(!currentFormula||!model.settings.preview||editorFailed){restorePreviews();return;}
    const key=previewKey();
    const result=renderCache.get(key)||draftCache.get(key);
    // During edits at the same formula location, keep the last frame until the
    // new SVG is ready. Do not replace it with raw TeX for a single paint.
    // Moving to another formula clears this record immediately below.
    if(!result&&presented&&presented.location===currentFormula.location){
      previewPopup.update({enabled:true,anchor:currentAnchor,content:presented.content});return;
    }
    const content:PopupContent=result
      ? {key:(result.draft?'draft:':'result:')+key,pending:false,createBody:()=>createResultBody(result)}
      : {key:'source:'+key,pending:false,createBody:()=>createSourceBody(currentFormula!.tex)};
    previewPopup.update({enabled:true,formulaTex:currentFormula.tex,formulaId:key,anchor:currentAnchor,content});
    if(result)presented={location:currentFormula.location,content};
  }

  function createResultBody(result:PreviewResult) {
    const body=document.createElement('div');body.className='opt-formula-body';
    body.dataset.optRenderKind=result.draft?'draft':result.dataUrl?'tex':'mathjax';
    body.style.setProperty('--opt-interface-font',getComputedStyle(document.body).fontFamily);
    if(result.svg) {
      const doc=new DOMParser().parseFromString(result.svg,'image/svg+xml');
      const svg=doc.documentElement;
      if(svg.localName!=='svg'||doc.querySelector('parsererror,script,foreignObject,image'))throw new Error('预览返回了不支持的格式。');
      body.append(document.importNode(svg,true));
    }
    if(result.dataUrl) {
      if(!result.dataUrl.startsWith('data:image/png;base64,'))throw new Error('无效的预览图像。');
      const img=document.createElement('img');
      img.addEventListener('load',()=>{if(img.isConnected)window.dispatchEvent(new Event('opt:measure'));},{once:true});
      img.src=result.dataUrl;img.alt=translateRuntimeText('TeX 公式预览',getLocale());
      img.width=result.width!;img.height=result.height!;body.append(img);
    }
    if(!result.svg&&!result.dataUrl){
      body.append(...createSourceBody(result.fallbackText??currentFormula?.tex??'',true).childNodes);
    }
    if(result.diagnostics.length)body.title=getLocale()==='en'?'Red input is incomplete or unavailable in this preview. Details are in Extension settings.':'红色内容尚未完成或无法在当前预览中识别；详情可在 Extension 设置中查看。';
    else if(result.draft&&model.settings.previewEngine==='tex')body.title=getLocale()==='en'?'Instant MathJax draft; the TeX result replaces it when ready.':'即时 MathJax 草稿；TeX 结果完成后会替换它。';
    return body;
  }

  function remember(cache:Map<string,PreviewResult>,key:string,result:PreviewResult){
    if(cache.size>=24)cache.delete(cache.keys().next().value!);
    cache.set(key,result);
  }

  function invalidateTexContext(){
    const draft=draftCache.get(previewKey());
    revision++;renderGeneration++;renderCache.clear();scheduledTexKey='';lastPreviewError=undefined;
    if(draft)remember(draftCache,previewKey(),draft);
    pdfAbort?.abort();void cancelLocalTex();
  }

  async function renderDraft() {
    if(!context.alive()||!currentFormula||!model.settings.preview||editorFailed)return;
    const formula=currentFormula;
    const key=previewKey();
    const generation=renderGeneration;
    if(renderCache.has(key)||draftCache.has(key)||draftRequests.get(key)===generation)return;
    const isCurrent=()=>context.alive()&&generation===renderGeneration&&previewKey()===key&&model.settings.preview&&!editorFailed;
    draftRequests.set(key,generation);
    try{
      const engine=await loadRenderer();
      if(!isCurrent())return;
      const result=await engine.renderFormula(formula.tex,previewIndex,formula.display,{tolerant:true});
      if(!isCurrent())return;
      remember(draftCache,key,{...result,draft:true});syncPreview();
      if(result.diagnostics.length){model.status=result.diagnostics[0];ui.update();}
    }catch(error){
      if(!isCurrent())return;
      remember(draftCache,key,{fallbackText:formula.tex,draft:true,diagnostics:[String(error)]});syncPreview();
    }finally{if(draftRequests.get(key)===generation)draftRequests.delete(key);}
  }

  async function renderTex() {
    if(!context.alive()||!currentFormula||!model.settings.preview||editorFailed||model.settings.previewEngine!=='tex')return;
    if(model.busy){scheduledTexKey='';return;}
    if(rendering){pendingPreview=true;return;}
    const formula=currentFormula;
    const settings={...model.settings};
    const key=previewKey();
    if(renderCache.has(key)||lastPreviewError?.key===key)return;
    // Let the service check its PDF cache before waiting for the shared cloud
    // cooldown. A cached result never needs to wait behind another tab's compile.
    const generation=renderGeneration;
    const isCurrent=()=>context.alive()&&generation===renderGeneration&&previewKey()===key&&model.settings.preview&&!editorFailed;
    rendering=true;
    pendingPreview=false;
    try {
      lastPreviewError=undefined;
      const compiled=await texService.render({files:model.files,rootPath,readFile:file=>source.readFile(file),settings,formula:formula.tex,display:formula.display,isCurrent});
      if(!isCurrent())return;
      reflectCloudBinding();
      pdfAbort=new AbortController();
      if(!pdfRenderer){
        const url=context.assetURL('cloud-pdf.js');
        if(!url)return;
        pdfRenderer=import(url);
      }
      const pdfEngine=await pdfRenderer;
      if(!isCurrent())return;
      const bitmap=await pdfEngine.renderCloudPdf(compiled.pdf,{signal:pdfAbort.signal});
      if(!isCurrent())return;
      remember(renderCache,key,{...bitmap,diagnostics:[...compiled.diagnostics,...bitmap.diagnostics]});syncPreview();
    }catch(error) {
      if(!isCurrent())return;
      const message=(error instanceof Error?error.message:String(error));
      lastPreviewError={key,result:{diagnostics:['所选预览引擎未能生成结果：'+message]}};
      model.status='公式预览失败：'+message;ui.update();
    }finally {
      rendering=false;pdfAbort=undefined;
      if(pendingPreview){pendingPreview=false;scheduledTexKey='';schedulePreview();}
    }
  }

  const previewObserver=new MutationObserver(records=>{
    if(!context.alive())return;
    if(completionListChanged(records))styleCompletionSources(document,model.settings.completion?model.index.commands:[]);
  });
  previewObserver.observe(document.body,{childList:true,subtree:true});

  // Translate visible messages without recompiling a formula or changing its
  // cache key. Formula source, project paths and compiler logs remain intact.
  const stopObservingLocale=observeLocale(locale => {
    if(!context.alive())return;
    for(const img of document.querySelectorAll<HTMLImageElement>('.opt-formula-body img'))img.alt=translateRuntimeText('TeX 公式预览',locale);
    if(document.querySelector('.opt-formula-body'))window.dispatchEvent(new Event('opt:measure'));
  });

  // Capture before React can stop bubbling or unmount its select. Preserve the
  // path synchronously because discover() yields before reading native controls.
  document.addEventListener('change', event => {
    if(!context.alive())return;
    if(event.target instanceof HTMLSelectElement && ['compiler','texLiveVersion'].includes(event.target.id)) {
      texService.invalidateEnvironment();invalidateTexContext();schedulePreview();
    }
    if(event.target instanceof HTMLSelectElement && event.target.id==='rootDocId') {
      source.observeNativeRoot(event.target.selectedOptions[0]?.textContent?.trim() || '');
      void rebuild();
    }
  }, {capture:true,signal:context.signal});

  async function rebuild() {
    if(!context.alive())return;
    const generation=++buildGeneration;
    model.busy=true;model.status='正在分析项目宏包与命令…';ui.update();
    try {
      source.setRootPath(model.settings.rootFile);
      const project=await source.discover();
      if(!context.alive()||generation!==buildGeneration)return;
      model.files=project.files;
      model.rootPath=project.rootPath;
      model.rootCandidates=project.rootCandidates;
      rootPath=project.rootPath;
      for(const [path,text]of liveDocuments)source.setLiveDocument(path,text);
      const index=await buildProjectIndex({files:project.files,rootPath:project.rootPath,readFile:file=>source.readFile(file),settings:model.settings});
      if(!context.alive()||generation!==buildGeneration)return;
      if(!project.rootPath)index.diagnostics.unshift({level:'warning',message:'未能确定 Overleaf 主文件，请检查原生项目设置，或在 Extension 中选择入口。'});
      model.index=enrichIndex(index);
      previewIndex=enrichIndex(applyPreviewSources(index,model.settings));
      const nextSignature=JSON.stringify({rootPath,index:previewIndex},(key,value)=>key==='offset'?undefined:value);
      const changed=nextSignature!==indexSignature;
      indexSignature=nextSignature;
      if(changed){revision++;renderGeneration++;pdfAbort?.abort();void cancelLocalTex();renderCache.clear();draftCache.clear();scheduledTexKey='';}
      model.status=`已更新：${model.index.commands.length} 个命令，${model.index.packages.length} 个宏包。`;
      if(!project.rootPath)model.status='未能确定项目入口，请检查 Overleaf 的主文件设置。';
      if(changed)configureEditor();
    }catch(error) {
      if(!context.alive()||generation!==buildGeneration)return;
      // Never keep a stale index after a failed refresh or a configuration change.
      model.index=emptyIndex();previewIndex=emptyIndex();indexSignature='';revision++;renderGeneration++;renderCache.clear();draftCache.clear();scheduledTexKey='';configureEditor();
      model.status='项目读取失败：'+(error instanceof Error?error.message:String(error));
    }finally {
      if(context.alive()&&generation===buildGeneration){model.busy=false;ui.update();schedulePreview();}
    }
  }

  window.addEventListener('opt:editor',((event:CustomEvent<string>)=>{
    if(!context.alive())return;
    try {
      const message=JSON.parse(event.detail);
      if (message.type === 'selection') {
        // Switching files and revealing an existing quote must not replace or
        // clear the references already prepared in the composer.
        if (sourceRevealsPending) return;
        if (message.selection === null) {
          if (message.clear === true || message.error || selectedFile && message.name && message.name !== selectedFile) codexPanel.clearSelection();
          if (typeof message.name === 'string' && message.name) selectedFile = message.name;
          if (message.error === 'selection-too-large') codexPanel.setStatus(codexText('选区超过 64000 字符，请选择较短的片段。', 'The selection exceeds 64,000 characters. Select a shorter passage.'));
        } else if (isCodexSelection(message.selection)) {
          const selection = message.selection as CodexSelection;
          selectedFile = selection.path;
          const exact = model.files.find(file => file.path === selection.path);
          const matches = model.files.filter(file => file.path.split('/').at(-1) === selection.path);
          const resolved = exact || (matches.length === 1 ? matches[0] : undefined);
          codexPanel.setSelection({ ...selection, path: resolved?.path || selection.path });
        }
        return;
      }
      if(message.type==='ready') {editorFailed=false;if(!model.editorReady){model.editorReady=true;ui.update();configureEditor();}return;}
      if(message.type==='error') {
        editorFailed=true;model.editorReady=false;currentFormula=null;currentAnchor=null;renderGeneration++;
        cancelAnimationFrame(previewFrame);previewFrame=0;clearTimeout(texTimer);scheduledTexKey='';pendingPreview=false;pdfAbort?.abort();void cancelLocalTex();restorePreviews();
        model.status=String(message.message);ui.update();return;
      }
      if(message.type==='formula') {
        if(editorFailed)return;
        if(message.formula && (typeof message.formula.tex!=='string'||message.formula.tex.length>32000))return;
        if(currentFormula?.tex===message.formula?.tex && currentFormula?.display===message.formula?.display && currentFormula?.location===message.formula?.location){syncPreview();return;}
        if(!message.formula||currentFormula?.location!==message.formula.location){currentAnchor=null;presented=undefined;}
        clearTimeout(texTimer);scheduledTexKey='';lastPreviewError=undefined;
        currentFormula=message.formula;renderGeneration++;pdfAbort?.abort();void cancelLocalTex();schedulePreview();return;
      }
      if(message.type==='geometry'){
        if(message.formula===null&&message.anchor===null){currentAnchor=null;syncPreview();return;}
        if(editorFailed||!currentFormula||message.formula?.tex!==currentFormula.tex||message.formula?.display!==currentFormula.display||message.formula?.location!==currentFormula.location)return;
        const anchor=message.anchor;
        if(anchor && !['left','top','bottom','editorTop','editorBottom','editorLeft','editorRight','viewportWidth','viewportHeight'].every(key=>typeof anchor[key]==='number'&&Number.isFinite(anchor[key])))return;
        currentAnchor=anchor||null;syncPreview();return;
      }
      if(message.type==='document' && typeof message.text==='string' && message.text.length<=2_000_000) {
        const candidates=model.files.filter(file=>file.path===message.name||file.path.split('/').at(-1)===message.name);
        if(candidates.length!==1)return;
        const file=candidates[0];
        const previous=liveDocuments.get(file.path);
        if(previous===message.text)return;
        source.setLiveDocument(file.path,message.text);liveDocuments.set(file.path,message.text);
        cacheFreshness.observe(file.path,message.text);
        const parsed=parseTex(message.text,file.path);
        const digest=JSON.stringify(parsed, (key,value)=>key==='offset'?undefined:value);
        // TeX consumes the newest document snapshot even when completion/index
        // declarations did not change. Do not rebuild the entire index on edits
        // to ordinary formula text; keep the instant draft visible throughout.
        if(model.settings.previewEngine==='tex'){
          invalidateTexContext();schedulePreview();
        }
        if(signatures.get(file.path)===digest)return;
        signatures.set(file.path,digest);
        clearTimeout(rebuildTimer);rebuildTimer=setTimeout(()=>void rebuild(),900);
      }
    }catch { /* Only accept bounded, structured data from the page bridge. */ }
  })as EventListener,{signal:context.signal});

  const editorConnection=createEditorConnection({signal:context.signal});
  let stopped=false;
  function dispose() {
    if(stopped)return;
    cacheFreshness.destroy();
    editorConnection.dispose();
    stopped=true;buildGeneration++;renderGeneration++;editorFailed=true;
    clearTimeout(rebuildTimer);clearTimeout(texTimer);cancelAnimationFrame(previewFrame);
    previewFrame=0;scheduledTexKey='';pendingPreview=false;pdfAbort?.abort();
    previewObserver.disconnect();stopObservingLocale();ui.destroy();
    codexGeneration++;codexClient.close();codexPanel.destroy();
    visualMath.destroy();previewPopup.destroy();previewStyle.remove();
    currentFormula=null;currentAnchor=null;presented=undefined;
    renderCache.clear();draftCache.clear();draftRequests.clear();liveDocuments.clear();signatures.clear();
    // The page-world bridge survives extension reloads too. Disable its
    // contributions without re-entering any invalid Chrome extension API.
    window.dispatchEvent(new CustomEvent('opt:configuration',{detail:JSON.stringify({commands:[],settings:{...model.settings,completion:false,preview:false}})}));
    styleCompletionSources(document,[]);
    if(context.reason==='extension-updated')mountExtensionRecoveryNotice();
  }
  context.signal.addEventListener('abort',dispose,{once:true});
  if(context.signal.aborted){dispose();return;}
  window.addEventListener('pagehide',event=>{if(!event.persisted)context.invalidate('pagehide');},{signal:context.signal});

  try {
    model.settings=await loadSettings(projectId);
    model.codex=await loadCodexSettings(projectId, accountId);
    if (provider()) await refreshProviders();
    model.codexPanelPosition=await loadCodexPanelPosition(projectId, accountId).catch(()=>'left' as const);
    model.codexClickToCopy=await loadCodexClickToCopy(projectId,accountId).catch(()=>false);
    model.codexCopyToast=await loadCodexCopyToast(projectId,accountId).catch(()=>false);
    model.codexBusyMessageBehavior=await loadCodexBusyMessageBehavior(projectId,accountId).catch(()=>'queue' as const);
    codexPanel.setPosition(model.codexPanelPosition);
    codexMessages=await loadAssistantMessages().catch(()=>[]);
    codexPanel.update();
    if(!context.alive())return;
    if(model.settings.preview)void loadRenderer().catch(()=>{});
    if(!context.alive())return;
    try { await texService.loadSharedBinding(); }
    catch { if(context.alive())model.status='暂时无法读取共享预览绑定；可在 Extension 中重新连接。'; }
    if(!context.alive())return;
    reflectCloudBinding();
    configureEditor();
    await rebuild();
    if(!context.alive())return;
    // Render saved mathematics only after project macros and packages are known.
    codexPanel.setMessages(codexMessages);
    // The bridge may have published the first file before the initial snapshot arrived.
    configureEditor();
    window.dispatchEvent(new Event('opt:request-document'));
    window.dispatchEvent(new Event('opt:request-selection'));
    if(accountId && typeof chrome.runtime.sendMessage==='function'){
      try{
        const result=await chrome.runtime.sendMessage({type:'opt:codex-queue',projectId,accountId,action:'read'});
        if(!result?.ok || typeof result.revision!=='string')throw new Error('Queue unavailable');
        queueRevision=result.revision;promptQueue.restore(result.items);publishQueue(false);
      }catch{codexPanel.setStatus(codexText('暂时无法读取排队消息，刷新前请保留草稿。','Queued messages could not be read. Keep your draft before refreshing.'));}
    }
    codexReady = true;
    if(model.codex.enabled && codexPanel.isOpen())void codexCatalogue.refresh();
    if(accountId && model.codex.enabled)void restoreNativeHistory();
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')configureEditor();},{signal:context.signal});
  } catch(error) {
    if(isExtensionContextInvalidated(error))context.invalidate('extension-updated');
    if(context.alive())throw error;
  }
}

void start().catch(error=>console.warn('[Overleaf Personal Tools]',error));
