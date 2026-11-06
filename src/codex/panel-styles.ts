export const codexPanelStyles = `
#opt-codex-tab { position:relative; display:flex; align-items:center; justify-content:center; }
#opt-codex-tab[hidden],#opt-codex-panel[hidden],#opt-codex-panel [hidden],.opt-codex-tooltip[hidden] { display:none!important; }
#opt-codex-tab .opt-codex-logo { width:28px; height:28px; object-fit:contain; display:block; }
#opt-codex-tab.open-rail { color:var(--opt-codex-rail-active,#fff); background:var(--opt-codex-rail-active-bg,#24613d); }
#opt-codex-panel { --opt-codex-muted:var(--content-secondary,#8d98a6); --opt-codex-border:var(--border-primary,#354252); --opt-codex-bg:var(--ide-rail-background-color,#202a35); --opt-codex-fg:var(--content-primary,#f1f3f5); --opt-codex-hover:rgba(128,145,163,.12); position:relative; display:flex; flex-direction:column; flex:0 0 var(--opt-codex-width,340px); width:var(--opt-codex-width,340px); min-width:0; height:100%; max-width:70vw; background:var(--opt-codex-bg); color:var(--opt-codex-fg); border-right:1px solid var(--opt-codex-border); font:inherit; line-height:1.6; overflow:hidden; box-sizing:border-box; }
#opt-codex-panel *,#opt-codex-panel *::before,#opt-codex-panel *::after { box-sizing:border-box; }
#opt-codex-panel[data-position=right] { border-right:0; border-left:1px solid var(--opt-codex-border); }
#opt-codex-panel[data-position=right] .opt-codex-resize { right:auto; left:0; }
#opt-codex-panel .opt-codex-icon-button[data-position=right] svg { transform:scaleX(-1); }
#opt-codex-panel button,#opt-codex-panel textarea { font:inherit; color:inherit; }
#opt-codex-panel button { cursor:pointer; }
#opt-codex-panel button:disabled { opacity:.45; cursor:default; }
#opt-codex-panel button:focus-visible,#opt-codex-panel textarea:focus-visible,#opt-codex-panel .opt-codex-resize:focus-visible { outline:2px solid var(--link-color,#8bb3e5); outline-offset:2px; }
#opt-codex-panel .opt-codex-header { display:flex; gap:6px; align-items:center; flex:none; min-height:48px; padding:8px 12px 8px 16px; border-bottom:1px solid var(--opt-codex-border); }
#opt-codex-panel .opt-codex-title { color:inherit; flex:1; min-width:0; margin:0; font:inherit; font-weight:600; font-size:var(--opt-codex-title-size,1em); line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#opt-codex-panel .opt-codex-icon-button { border:0; border-radius:4px; background:transparent; width:28px; height:28px; flex:0 0 28px; display:inline-flex; align-items:center; justify-content:center; padding:5px; color:inherit; }
#opt-codex-panel .opt-codex-icon-button:hover { background:var(--opt-codex-hover); }
#opt-codex-panel .opt-codex-icon-button svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
#opt-codex-panel .opt-codex-history { position:relative; flex:1; min-height:0; }
#opt-codex-panel .opt-codex-conversations { flex:1; min-height:0; overflow:auto; padding:12px; font-size:14px; line-height:21px; }
#opt-codex-panel .opt-codex-conversation-status { margin:0 4px 10px; color:var(--opt-codex-muted); overflow-wrap:anywhere; }
#opt-codex-panel .opt-codex-conversation-list { list-style:none; margin:0; padding:0; }
#opt-codex-panel .opt-codex-conversation { display:flex; align-items:center; gap:3px; border-bottom:1px solid var(--opt-codex-border); }
#opt-codex-panel .opt-codex-conversation-select { display:block; flex:1; min-width:0; padding:10px 8px; border:0; border-radius:4px; background:transparent; text-align:left; line-height:21px; }
#opt-codex-panel .opt-codex-conversation-select:hover,#opt-codex-panel .opt-codex-conversation-select[aria-current=true] { background:var(--opt-codex-hover); }
#opt-codex-panel .opt-codex-conversation-title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:400; }
#opt-codex-panel .opt-codex-conversation-select[aria-current=true] .opt-codex-conversation-title { font-weight:600; }
#opt-codex-panel .opt-codex-conversation-meta { display:flex; flex-wrap:wrap; gap:4px 8px; color:var(--opt-codex-muted); font-size:12px; line-height:18px; margin-top:2px; }
#opt-codex-panel .opt-codex-conversation-current { font-weight:600; }
#opt-codex-panel .opt-codex-open-conversation { align-self:center; }
#opt-codex-panel .opt-codex-history-retry,#opt-codex-panel .opt-codex-history-more { border:1px solid var(--opt-codex-border); border-radius:4px; padding:4px 9px; margin:0 0 10px; background:transparent; font-size:14px; line-height:21px; }
#opt-codex-panel .opt-codex-history-retry:hover,#opt-codex-panel .opt-codex-history-more:hover { background:var(--opt-codex-hover); }
#opt-codex-panel .opt-codex-conversations > .opt-codex-history-more { margin:12px 0 0; }
#opt-codex-panel .opt-codex-earlier { display:flex; flex-direction:column; align-items:center; gap:4px; margin-bottom:12px; font-size:14px; line-height:21px; }
#opt-codex-panel .opt-codex-earlier .opt-codex-history-more { margin:0; }
#opt-codex-panel .opt-codex-earlier-status { color:var(--opt-codex-muted); text-align:center; overflow-wrap:anywhere; }
#opt-codex-panel .opt-codex-messages { height:100%; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; scroll-behavior:auto; padding:16px; scrollbar-width:thin; }
#opt-codex-panel .opt-codex-latest { position:absolute; bottom:12px; left:50%; transform:translateX(-50%); max-width:90%; border:1px solid var(--opt-codex-border); background:var(--opt-codex-bg); color:var(--opt-codex-fg); border-radius:20px; padding:5px 12px; white-space:nowrap; font-size:.86em; box-shadow:0 2px 8px #0003; }
#opt-codex-panel .opt-codex-empty { color:var(--opt-codex-muted); margin:5px 0; font-size:.93em; line-height:1.7; }
#opt-codex-panel .opt-codex-message { margin:0 0 22px; overflow-wrap:anywhere; }
#opt-codex-panel .opt-codex-message-role { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; font-size:.86em; font-weight:600; color:var(--opt-codex-muted); margin-bottom:5px; }
#opt-codex-panel .opt-codex-message-copy { margin-left:auto; width:24px; height:24px; flex-basis:24px; padding:4px; }
#opt-codex-panel .opt-codex-activity { display:inline-flex; align-items:baseline; gap:6px; font-weight:400; color:var(--opt-codex-fg); }
#opt-codex-panel .opt-codex-activity::before { content:''; width:5px; height:5px; flex:none; background:currentColor; border-radius:50%; align-self:center; animation:opt-codex-pulse 1.4s ease-in-out infinite; }
@keyframes opt-codex-pulse { 50% { opacity:.3; } }
@media (prefers-reduced-motion:reduce) { #opt-codex-panel .opt-codex-activity::before { animation:none; } }
#opt-codex-panel .opt-codex-message[data-role=user] .opt-codex-message-body { background:var(--opt-codex-hover); padding:9px 11px; border-radius:6px; white-space:pre-wrap; }
#opt-codex-panel .opt-codex-message[data-role=user] .opt-codex-message-body[data-expanded=false] { display:-webkit-box; -webkit-line-clamp:6; -webkit-box-orient:vertical; overflow:hidden; }
#opt-codex-panel .opt-codex-user-expand { display:block; margin:3px 0 0 auto; padding:2px 4px; border:0; background:transparent; color:var(--opt-codex-muted); font-size:12px; line-height:18px; }
#opt-codex-panel .opt-codex-user-expand:hover { color:var(--opt-codex-fg); text-decoration:underline; }
#opt-codex-panel .opt-codex-message-body p { margin:0 0 12px; white-space:pre-wrap; }
#opt-codex-panel .opt-codex-message-body p:last-child { margin-bottom:0; }
#opt-codex-panel .opt-codex-message-body h3,#opt-codex-panel .opt-codex-message-body h4,#opt-codex-panel .opt-codex-message-body h5,#opt-codex-panel .opt-codex-message-body h6 { color:inherit; font:inherit; font-weight:600; margin:14px 0 8px; }
#opt-codex-panel .opt-codex-message-body ul,#opt-codex-panel .opt-codex-message-body ol { margin:8px 0 12px; padding-left:23px; }
#opt-codex-panel .opt-codex-message-body li { margin:5px 0; }
#opt-codex-panel .opt-codex-message-body pre { margin:12px 0; padding:10px; overflow:auto; background:var(--opt-codex-hover); border:1px solid var(--opt-codex-border); border-radius:4px; color:inherit; font-size:.86em; white-space:pre; }
#opt-codex-panel .opt-codex-message-body code { color:inherit; background:var(--opt-codex-hover); border-radius:3px; padding:1px 3px; font-size:.9em; }
#opt-codex-panel .opt-codex-message-body pre code { background:transparent; padding:0; }
#opt-codex-panel .opt-codex-message-body a { color:var(--link-color,#83b9ee); text-decoration:underline; }
#opt-codex-panel .opt-codex-message-body blockquote { border-left:2px solid var(--opt-codex-border); padding-left:12px; margin:10px 0; color:var(--opt-codex-muted); }
#opt-codex-panel .opt-codex-math { display:inline-block; max-width:100%; vertical-align:middle; }
#opt-codex-panel .opt-codex-math-display { display:block; overflow-x:auto; padding:8px 0; text-align:center; }
#opt-codex-panel .opt-codex-math svg { max-width:100%; }
#opt-codex-panel .opt-codex-math:focus-visible { outline:2px solid var(--link-color,#8bb3e5); outline-offset:2px; border-radius:2px; }
#opt-codex-panel[data-click-to-copy=true] .opt-codex-math { cursor:pointer; }
#opt-codex-panel .opt-codex-math[data-copy-feedback=copied] { background:var(--opt-codex-hover); box-shadow:0 0 0 2px var(--opt-codex-border); border-radius:2px; }
#opt-codex-panel .opt-codex-math[data-copy-feedback=error] { outline:1px solid var(--content-danger,#bf6b6b); outline-offset:2px; }
#opt-codex-panel .opt-codex-copy-notice { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
#opt-codex-panel .opt-codex-quote-selected { position:absolute; bottom:calc(100% + 4px); left:12px; z-index:2; display:block; width:max-content; max-width:calc(100% - 24px); margin:0; box-shadow:0 1px 4px #0002; border:1px solid var(--opt-codex-border); border-radius:5px; padding:4px 8px; background:var(--opt-codex-bg); color:var(--opt-codex-muted); font-size:.86em; }
#opt-codex-panel .opt-codex-quote-selected:hover { color:var(--opt-codex-fg); border-color:var(--opt-codex-muted); }
#opt-codex-panel .opt-codex-selection:not([hidden]) ~ .opt-codex-input-wrap { border-top-left-radius:0; border-top-right-radius:0; }
#opt-codex-panel .opt-codex-selection:not([hidden]) + .opt-codex-answer-quote { border-radius:0; }
#opt-codex-panel .opt-codex-compose { position:relative; flex:none; padding:0 12px 12px; }
#opt-codex-panel .opt-codex-selection { border:1px solid var(--opt-codex-border); border-bottom:0; padding:9px 10px; border-radius:6px 6px 0 0; font-size:.86em; }
#opt-codex-panel .opt-codex-selection[hidden] { display:none; }
#opt-codex-panel .opt-codex-selection-heading { display:flex; align-items:center; gap:6px; }
#opt-codex-panel .opt-codex-selection-label { border:0; background:transparent; padding:0; text-align:left; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--opt-codex-muted); }
#opt-codex-panel .opt-codex-selection-label::before { content:"▸"; display:inline-block; width:1em; }
#opt-codex-panel .opt-codex-selection-label[aria-expanded=true]::before { content:"▾"; }
#opt-codex-panel .opt-codex-selection-source { margin-top:4px; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; white-space:pre-wrap; line-height:1.5; }
#opt-codex-panel .opt-codex-selection.expanded .opt-codex-selection-source { display:block; max-height:180px; overflow:auto; }
#opt-codex-panel .opt-codex-message-selection { position:relative; font-size:.86em; margin:0 0 7px; border:1px solid var(--opt-codex-border); border-radius:5px; padding:7px 9px; color:var(--opt-codex-muted); }
#opt-codex-panel .opt-codex-message-selection summary { cursor:pointer; overflow-wrap:anywhere; padding-right:27px; min-height:24px; }
#opt-codex-panel .opt-codex-source-button { width:24px; height:24px; flex-basis:24px; padding:4px; color:var(--opt-codex-muted); }
#opt-codex-panel .opt-codex-source-button svg { width:16px; height:16px; }
#opt-codex-panel .opt-codex-message-selection .opt-codex-source-button { position:absolute; top:5px; right:5px; }
#opt-codex-panel .opt-codex-source-notice { margin:0; padding:5px 9px; border:1px solid var(--opt-codex-border); border-bottom:0; color:var(--opt-codex-muted); font-size:.85em; line-height:1.45; }
#opt-codex-panel .opt-codex-source-highlight { outline:2px solid var(--link-color,#83b9ee); outline-offset:5px; border-radius:2px; background:var(--opt-codex-hover); }
#opt-codex-panel .opt-codex-quote-preview { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; color:var(--opt-codex-fg); margin-top:4px; }
#opt-codex-panel .opt-codex-message-selection[open] .opt-codex-quote-preview { display:none; }
#opt-codex-panel .opt-codex-quote-full { color:var(--opt-codex-fg); white-space:pre-wrap; overflow-wrap:anywhere; max-height:240px; overflow:auto; margin-top:6px; }
#opt-codex-panel .opt-codex-input-wrap { border:1px solid var(--opt-codex-border); border-radius:6px; overflow:hidden; }
#opt-codex-panel .opt-codex-input-label { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
#opt-codex-panel .opt-codex-selection:not([hidden]) + .opt-codex-input-wrap { border-top-left-radius:0; border-top-right-radius:0; }
#opt-codex-panel textarea { display:block; width:100%; min-height:88px; max-height:180px; resize:vertical; padding:10px 11px; border:0; background:transparent; line-height:1.6; outline:none; box-shadow:none; }
#opt-codex-panel textarea::placeholder { color:var(--opt-codex-muted); opacity:1; }
#opt-codex-panel .opt-codex-input-actions { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:2px 5px; min-height:35px; padding:3px 6px; }
#opt-codex-panel .opt-codex-status { flex:1 1 100%; color:var(--opt-codex-muted); font-size:.85em; line-height:1.45; padding:0 5px; white-space:pre-wrap; max-height:56px; overflow:auto; }
#opt-codex-panel .opt-codex-connection { display:inline-flex; align-items:center; gap:6px; flex:0 1 auto; min-width:0; max-width:calc(100% - 64px); min-height:28px; padding:3px 5px; border:0; border-radius:4px; background:transparent; color:var(--opt-codex-muted); font-size:.8em; line-height:1.4; text-align:left; }
#opt-codex-panel .opt-codex-connection:hover { background:var(--opt-codex-hover); }
#opt-codex-panel .opt-codex-connection[aria-disabled=true] { cursor:default; }
#opt-codex-panel .opt-codex-connection-label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#opt-codex-panel .opt-codex-connection-dot { flex:0 0 6px; height:6px; border-radius:50%; background:currentColor; }
#opt-codex-panel .opt-codex-connection[data-state=connected] .opt-codex-connection-dot { background:var(--content-positive,#57a575); }
#opt-codex-panel .opt-codex-connection:is([data-state=checking],[data-state=reconnecting],[data-state=blocked]) .opt-codex-connection-dot { background:var(--content-warning,#c99541); }
#opt-codex-panel .opt-codex-connection:is([data-state=offline],[data-state=auth-required]) .opt-codex-connection-dot { background:var(--content-danger,#bf6b6b); }
#opt-codex-panel .opt-codex-connection-announcement { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
#opt-codex-panel .opt-codex-remote-status { margin:0 0 7px; color:var(--opt-codex-muted); font-size:.85em; line-height:1.45; }
#opt-codex-panel .opt-codex-cache-notice { display:flex; align-items:flex-start; gap:4px; margin:0 0 8px; color:var(--opt-codex-muted); font-size:.85em; line-height:1.45; overflow-wrap:anywhere; }
#opt-codex-panel .opt-codex-cache-notice-text { flex:1; min-width:0; }
#opt-codex-panel .opt-codex-cache-dismiss { min-width:28px; min-height:28px; }
#opt-codex-panel .opt-codex-cache-dismiss svg { width:14px; height:14px; }
#opt-codex-panel .opt-codex-resize { position:absolute; z-index:1; width:5px; right:0; top:0; bottom:0; cursor:col-resize; touch-action:none; }
#opt-codex-panel .opt-codex-resize:hover { background:var(--link-color,#83b9ee); opacity:.6; }
.opt-codex-tooltip { position:fixed; z-index:100000; max-width:280px; background:#111820; color:#fff; border-radius:4px; padding:5px 8px; font-size:12px; font-weight:400; line-height:1.4; white-space:normal; text-align:center; box-shadow:0 2px 5px #0002; pointer-events:none; }
#opt-codex-panel .opt-codex-submit-actions { display:flex; gap:3px; margin-left:auto; }
#opt-codex-panel .opt-codex-queue-action { border:1px solid var(--opt-codex-border); border-radius:4px; padding:3px 7px; background:transparent; font-size:12px; line-height:20px; }
#opt-codex-panel .opt-codex-queue-action:hover { background:var(--opt-codex-hover); }
#opt-codex-panel .opt-codex-queue { margin:0 0 8px; border:1px solid var(--opt-codex-border); border-radius:6px; font-size:12px; line-height:18px; overflow:hidden; }
#opt-codex-panel .opt-codex-queue-heading { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 8px; color:var(--opt-codex-muted); }
#opt-codex-panel .opt-codex-queue-list { list-style:none; padding:0; margin:0; max-height:160px; overflow:auto; overscroll-behavior:contain; }
#opt-codex-panel .opt-codex-queued-item { border-top:1px solid var(--opt-codex-border); padding:6px 8px; }
#opt-codex-panel .opt-codex-queued-preview { white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
#opt-codex-panel .opt-codex-queued-context { display:block; color:var(--opt-codex-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#opt-codex-panel .opt-codex-queued-controls { display:flex; justify-content:flex-end; align-items:center; gap:4px; margin-top:3px; }
#opt-codex-panel .opt-codex-queued-controls .opt-codex-queue-action { border:0; padding:0 3px; }
#opt-codex-panel .opt-codex-queued-error { margin:4px 0; color:var(--content-danger,#bf6b6b); overflow-wrap:anywhere; }
`;
