# Architecture and extension points

This MV3 extension keeps settings inside Overleaf's native Settings dialog, under Extension → Preview and Extension → Codex Assistant. A separate Codex Assistant entry below the native AI assistant opens an in-page chat panel. The first preview choice is MathJax or TeX; TeX then selects a local or Overleaf backend. Both TeX backends compile a generated single-formula document and share the bundled PDF renderer. Completion remains an independent indexed feature. Codex is the default assistant source; optional API profiles are selected per project in the same native settings. Only credential management opens the extension-owned `api-settings.html` page.

## Code and Visual formula activation

LaTeX Code and Visual modes use the same host CodeMirror source document. The bridge observes document, selection, focus, syntax-tree identity and effect-only updates. Visual math widgets can reveal source after native pointer handlers or background parsing, without a new source edit. These updates are coalesced into CodeMirror's `requestMeasure` read/write lifecycle; a newly resolved formula is published before its matching geometry. Formula signatures include source location and are deduplicated, so caret motion, widget layout changes and mode switches do not restart rendering or the TeX typing debounce. The extension adds no polling, second editor runtime or DOM-to-TeX scraping. Static Visual math widgets remain owned by Overleaf.

## Module ownership

| Module | Responsibility |
| --- | --- |
| `overleaf/project-source.ts` | Read-only same-origin ZIP snapshot, bounded UTF-8 extraction, main-document precedence/cache and unambiguous live-editor overlays |
| `overleaf/project-metadata.ts` | Short authenticated metadata connection; bounded main-document mapping and explicit compiler/TeX Live environment |
| `overleaf/account.ts` | Current account ID from Overleaf page metadata, without reading an email address or password |
| `core/parser.ts`, `project-index.ts` | Declaration scanning, dependency order, extra-file selection and diagnostics; not a TeX interpreter |
| `core/preview-sources.ts` | Stable source identities, validated project preferences and ordered replay of enabled preview definitions |
| `packages/index.ts` | Explicit completion catalogs, snippets, MathJax support metadata and conflicts |
| `overleaf/completion-style.ts` | Scope native interface typography to extension-owned suggestion source labels |
| `overleaf/editor-bridge.ts` | MAIN-world `UNSTABLE_editor:extensions` adapter; host CodeMirror transactions, completions, formula ranges, selected source and active buffers |
| `overleaf/editor-connection.ts` | Correlated editor health checks and bounded recovery through the host's existing third-party extension handshake |
| `content.ts` | ISOLATED-world lifecycle, native main-document change handling, settings, revision/cache management, popup restoration, renderer selection and assistant orchestration |
| `preview/render.ts` | Bundled MathJax, fresh context and reachable macro definitions per render |
| `preview/popup.ts` | Independent formula portal, bounded viewport placement and native-surface suppression while enabled |
| `preview/cloud-document.ts` | Shared TeX builder: literal preamble, formula, source controls and bounded text dependency closure |
| `preview/tex-service.ts` | Shared workspace reconciliation, upload journal/hashes, environment matching, PDF cache and backend orchestration |
| `preview/cloud-coordinator.ts`, `cloud-coordinator-background.ts` | Account-wide FIFO transactions, fenced leases, persistent metadata and uncertainty quarantine across both language sites |
| `overleaf/cloud-client.ts` | Session/CSRF transport restricted to a verified shared project: create/upload/managed-file cleanup/settings/compile and build-specific PDF/log retrieval |
| `preview/local-client.ts`, `background.ts` | Content-to-worker messaging and validated per-tab Native Messaging |
| `native/host.py`, `native/install.py` | Python standard-library host, temporary jobs, macOS sandbox and explicit registration/unregistration |
| `preview/cloud-pdf.ts` | Shared bounded PDF.js rasterizer, cancellation and cleanup |
| `settings/native-panel.ts`, `storage.ts` | Native settings disclosure and child pages, project-file picker, optional main-document override and validated preview project/default preferences |
| `codex/panel.ts`, `panel-styles.ts`, `message-renderer.ts` | Native-rail assistant mount, manuscript/answer quotation cards, streaming transcript, bounded Markdown/math rendering and cleanup |
| `codex/selection-feedback.ts` | Preserve native text ranges while painting intersecting SVG formulas; opt-in, focus-safe formula-copy notice |
| `codex/prompt-queue.ts` | Bounded captured-context FIFO, conversation/provider fencing and paused recovery |
| `codex/clipboard.ts` | Read-only text/LaTeX snapshots of rendered selections and separate user-initiated copy actions |
| `codex/catalogue.ts` | Coalesced automatic model discovery, per-page five-minute cache, busy-turn deferral and model-supported efforts |
| `codex/context.ts`, `storage.ts`, `types.ts` | Bounded project context, validated per-account/project assistant settings and local display history |
| `codex/client.ts`, `background.ts` | Content-to-worker streaming port, sender checks, native protocol validation and display-history storage |
| `native/codex_host.py`, `native/install_codex.py` | Local assistant routing, independent Codex app-server connection, scoped thread bindings and explicit registration/unregistration |
| `codex/api-settings.ts`, root `api-settings.html` / `api-settings.css` | Extension-owned connection manager; credential entry, validation and sanitized profile metadata |
| `codex/provider-background.ts` | Exact management-page admission and isolated profile-management native port |
| `native/prompt_display.py` | Exact generated-annotation envelope recognition for display, preserving unknown or malformed user text |
| `native/api_provider.py` | Private API profile storage, bounded OpenAI-compatible requests and profile/account/project-local history |

JavaScript paths above are relative to `src/`; `native/` is at repository root. The MAIN-world bridge carries bounded JSON events but cannot persist settings, write cloud files or invoke native programs. The extension reuses host CodeMirror objects. Project native requests are accepted only from this extension's top-level Overleaf project content scripts. API profile mutations and checks use a separate port restricted to the exact extension-owned settings page.

## Main-document discovery and UI boundary

The Reconnect editor action dispatches Overleaf's `editor:extension-loaded`
handshake, which recollects third-party extensions into the host compartment.
It does not replace the document or EditorState. A fresh `opt:connection-request`
ID must receive a matching status for the currently visible host editor; a live
plugin whose initialization has completed is required. Old `ready` publications
cannot satisfy this check. Concurrent requests share one attempt, with a two-second
deadline and cancellation tied to the content-script lifetime. Completion and
keymap setup is marked in the current EditorState, so reusing a view after a
host state reset restores that configuration without accumulating duplicates.

Focus/pointer entry, restored page visibility and editor DOM replacement trigger
coalesced checks with a two-second cooldown. Only a detached bridge is repaired;
healthy editors and ordinary typing do not cause reconfiguration. These checks
have no permanent timer loop. Extension invalidation disposes the controller,
and extension updates still require refreshing the existing project page. The
green settings button remains available independently of project indexing, and
its bilingual result uses a reserved, quiet status row outside folded support
details.

Main-document selection is automatic by default. After successfully reading the project ZIP, the source adapter obtains the authenticated `joinProjectResponse.project` metadata through the pinned socket.io 0.9 browser client. The public server model exposes `rootDoc_id` and a one-element `rootFolder` array. Folder entries contain `folders`, `docs`, and `fileRefs` arrays; document entries supply `_id` and `name`. The adapter follows these fields to a complete project-relative path, including nested folders and duplicate basenames. It does not inspect page-owned hidden globals or request document text through the socket. Field shapes are grounded in the pinned public source and synthetic tests; those checks alone do not establish compatibility with every live deployment.

The precedence is an explicit extension `rootFile` override, the latest captured native main-document change, a valid already-mounted native `select#rootDocId` selection, the authoritative metadata root, then a unique uncommented `\documentclass` candidate. No filename such as `main.tex` is guessed. A metadata error or a path absent from the ZIP preserves the heuristic fallback. If no unambiguous entry remains, indexing reports the unresolved entry and the native Settings tab can offer a selection; normal use does not require configuring a main file twice. The override changes extension analysis, not Overleaf's compilation setting.

The metadata connection opens only after the ZIP succeeds, emits no application-level event, never joins a document, and disconnects after receiving the model. It has a six-second timeout, cancellation, and no automatic retry loop. Only the root ID/path and recognized compiler/TeX Live environment fields are retained; unrelated member metadata is discarded. The source and metadata snapshots remain in tab memory until explicit refresh or page reload. This short connection still participates in the server's normal project join/leave presence lifecycle; it does not reuse or disconnect the website's own connection.

Changing the main document through the existing native control is observed in the document event's capture phase. `content.ts` synchronously passes its selected path to `observeNativeRoot()` before rebuilding, without downloading the ZIP again. That captured path survives dialog removal and React's temporary restoration of the previously saved select value; only another captured change or explicit refresh replaces it. A metadata revision prevents an older pending socket response from replacing the newer choice. Explicit refresh cancels any pending metadata request and invalidates both snapshots and the captured native choice. Changes made elsewhere, such as another browser tab or a collaborator's session, are picked up on refresh/reload rather than through a permanent second project connection.

The Extension settings entry is mounted inside the known native Settings dialog, using the host's existing navigation and row classes. The parent only expands or collapses Preview and Codex Assistant; the children open their own controls and retain independent drafts. Leaving extension settings restores native tab selection. The assistant mounts only beside a detected native rail and uses its layout, font and colors; it does not place a floating overlay over the editor. Formula previews use an extension-owned portal styled to match the interface. While enabled, a scoped CSS rule hides native math tooltip containers; the native Equation preview setting is never changed or required.

Native settings typography comes from the host's navigation and form classes,
not `font: inherit` on children of a larger container. The observed Overleaf
settings use Noto Sans at 14px/20px for navigation and 14px/21px for row labels,
descriptions and small controls, while their parent containers use 16px/24px.
The fixture reproduces this difference to catch accidental oversized controls.
The Extension parent keeps the 02 avatar. The assistant rail and action buttons
use visible hover/focus tooltips with accessible descriptions, and thinking
status sits beside the answer's Codex label.

The bundled `assets/codex-app.png` is an unmodified copy of the user's local
`/Applications/ChatGPT.app/Contents/Resources/icon-codex-dark-color.png`. It is
used for this personal, unofficial integration at the user's request; no
runtime download or redrawn approximation is involved. The asset and name
remain their owner's marks and do not imply endorsement or redistribution rights.

## Codex Assistant context and conversation boundary

The MAIN-world CodeMirror bridge publishes bounded selection snapshots with source identity, line numbers and surrounding text. The isolated panel retains the selected passage while focus moves to its input. Project mode exports a fresh ZIP and overlays the frozen, identity-verified current editor document. It uploads all supported text sources through source-begin/chunk/commit, using UTF-8 byte offsets and per-file SHA-256 checks. The native host publishes an immutable account/project-scoped snapshot only when every file is complete. Limits are 2,000 files, 2 MiB per file and 16 MiB total; exceeding them rejects the capture rather than silently selecting excerpts. Queue entries retain a snapshot reference, so later editor changes cannot alter an already queued request. The model receives a short snapshot reference and reads/searches the full source through the read-only overleaf_project MCP. This does not index the whole Overleaf account or require Git integration. Code and LaTeX Visual selections use actual source offsets; PDF and Visual widget selections without a reliable source mapping are unsupported.

Assistant-answer quotation is a separate panel-only selection path. A bounded
snapshot is available only when both range endpoints belong to one assistant
message body. The explicit Quote selected text action above the composer attaches
it; selection alone never sends a question or changes the clipboard. The
serializer walks selected text and block boundaries, skips controls and rendered
SVG internals, and reads each formula's recorded original LaTeX. An endpoint
inside a formula expands to its complete expression. One `answerQuote` may
coexist with `selection`; it has text and optional source message identity, with
no manuscript coordinates. The UI provides expand/remove controls and preserves
the independent draft attachment during streaming and history updates.

The content script talks to the service worker on a named port; the worker validates the sender and forwards only supported operations to `com.overleaf.personal_tools.codex`. The default source uses local Codex authentication and a dedicated app-server connection, with no localhost listener or browser-provided executable. It enforces read-only Q&A, disables general shell/network/plugin capabilities in its private server, permits only the fixed local manuscript MCP, and rejects interactive permission requests. The reader exposes list_project_files, search_project and read_project_file; results include explicit pagination, including character positions within long lines. Answers are displayed for manual use; no source-edit operation exists. The model may use its configured network provider, so local transport does not imply offline inference. Installation and exact protocol/runtime limits are documented in [Codex backend](codex-backend.md).

Assistant preferences are keyed by Overleaf account and project; display histories also include an optional API profile identity, with absent identity retaining the original Codex key. The browser retains at most 60 recent messages and 350000 characters in local extension storage, counting both quotation types in the budget. A sent question carries its original file, line range, expandable selection snapshot and optional answer quote, so they remain inspectable after the composer clears and after history is restored. Retention keeps complete question/answer turns. If the newest answer exceeds the display budget, its saved copy gets an explicit excerpt marker while the question and exact quotations remain intact; the live answer and Codex conversation are not truncated. When account identity is available, the native host retains a separate conversation catalog and account/project-to-Codex-thread binding; otherwise it cannot restore that binding across connections. Codex stores its ordinary conversation and supplied context. New chat clears the current display and active binding while retaining old registered conversations. Only registered threads are imported; unrelated desktop chats, skills, memories and plugins are not imported.

The protocol remains version 1 with optional `answerQuote` on `ask`, `steer` and user
history messages. Both native and browser validators bound text in UTF-16 units,
reject unknown quote fields, and reserve native-page capacity for the combined
quotation payload. The native prompt labels the answer excerpt as untrusted
prior-answer material. A nullable SQLite column preserves old history while
recording new quotes, and authoritative history import recovers the attachment
without exposing hidden project-file payloads. See [Codex backend](codex-backend.md)
for exact limits and helper update instructions.

For the default Codex source, the settings-open action loads the model catalogue through `status`, backed by
app-server `account/read` and `model/list`. Catalogue requests are coalesced,
successful results are cached for five minutes in page memory, and requests
are deferred while the native connection is answering. Loading/errors stay in
settings and do not replace an in-progress answer's status. Updating catalogue
metadata preserves settings drafts; explicit model selection uses the model's
supported efforts. “Follow Codex” leaves the corresponding override unset.

Stream updates reconcile existing Markdown blocks and completed formula nodes
instead of replacing the transcript. Math rendering runs in small batches;
there is no 80-formula count cutoff. Individual MathJax and SVG limits still
apply, code stays literal, and an invalid expression keeps selectable source.
The panel follows the bottom while the user is reading there. Upward wheel,
keyboard, touch or scrollbar movement suspends following, and a stable visible
block anchors the viewport across streamed text and delayed math hydration.
“Jump to latest” explicitly resumes following.

## Compact conversation display without losing context (0.11.0)

Every new Codex start or steering request uses the exact question as visible
`input` text, for both independent and Desktop-owner routes. The selection, snapshot reference and answer quotation move to the installed
protocol's `additionalContext` entries with `kind: untrusted` and valid machine
names. The runtime hard-truncates each value at 4,000 UTF-8 bytes; 0.12.0 keeps
each independently encoded fragment below 3,600 bytes. A current manifest and
content digest distinguish the current fragment group from stale slots. Full
project files live in the dedicated native snapshot store, not this envelope. It remains model-visible data; it is not removed,
turned into instructions or rendered as a large machine-generated user bubble.
Both turn/start and turn/steer support this context field in the installed
schema. This is a versioned adapter contract, not a general claim about future
Codex releases. API mode retains question-only display history and uses the same snapshot
reader behind a bounded function-calling loop, with exact snapshot-ID admission.
Unsupported tools fail explicitly rather than falling back to truncated input.

For incoming history and native cached display pages, `prompt_display.py`
recognizes the complete known Desktop annotation formatter: exact preamble,
bounded valid JSON, closing tag and immediate request heading. It returns the
actual question and an `answerQuote` containing selected text and any labeled
user comments; offsets and formatter boilerplate stay outside the visible
bubble. Existing validated local quotation metadata is preserved when the
matching authoritative user message now contains only the plain question.
Legacy Overleaf envelopes remain readable through their separate scoped parser.

This is display parsing, not a trust grant or a rewrite of the original model
input. Plain user headings, mixed/unknown generated sections, malformed JSON,
ambiguous source metadata and oversized quotation payloads remain unchanged.
Long user messages—including that fallback—use a six-line collapsed view with
an explicit expand/collapse control. The underlying text remains complete.
No Codex logs or historical Desktop messages are rewritten; older Desktop
bubbles retain their original stored contents.

## Formula selection, copy notice and follow-up queue (0.11.0)

The formula-selection helper observes the real browser Selection and checks
whether each existing formula wrapper intersects a noncollapsed range. It
paints the wrapper with the same system Highlight/HighlightText colors as the
transcript's native `::selection`; it does not alter selection endpoints, wrap
text, change copied LaTeX or clear the page-wide Custom Highlight registry.
Updates are coalesced per frame and react to later formula hydration. The helper
observes content changes rather than its own presentation attributes, and clears
markers on deselection or disposal.

Click-to-copy and the new copy-notice setting are separate browser-only,
account/project preferences, both defaulting to false. Successful copying may
show one reused `popover="manual"` notice for about a second when explicitly
enabled. It does not take focus, intercept pointer input or add a control beside
every formula. The existing live region announces copying accessibly; the visual
notice does not duplicate that announcement. Scrolling or resizing dismisses it.

Since 0.11.2, a browser-only account/project preference chooses queue or steer
for messages sent during generation. The composer uses one native form submit
path for the Send button and Enter, plus an independent Stop control. Shift+Enter
inserts a newline; IME composition does not submit. Unsupported steering queues.
Queue
items clone question, manuscript selection, answer quotation, bounded files,
settings, provider and conversation identity at enqueue time. Later editor
changes do not mutate those snapshots. `PromptQueue` is FIFO, limited to eight
items and 1 MiB of encoded JSON. Entries are retained in `chrome.storage.local`
under the account/project key, with provider/conversation checked per item before
sending; unknown accounts keep only page-memory state. Queued context is thus a
new persistent manuscript-content flow, separate from preview-only caches.

Reload restores a paused queue. An item previously sending or failed becomes
review-required and cannot resume automatically. Stop and errors pause the queue;
uncertain delivery is never retried. Explicit edit/remove controls recover an
item without overwriting an existing composer draft. Editing restores the
question and quotations to the composer; its next submission captures context
again. Source changes, new conversations and history switches wait until queued
items have been processed or removed. This is a page-managed queue, not a
service-worker background runner or an inference schedule.

Steering is a distinct native operation against the already acknowledged
conversation. The independent Codex app-server route requires the exact active
turn. The validated Desktop-owner route uses the Desktop follower steering
protocol for the current active reply in that same conversation; Desktop may
retry once after an active-turn mismatch and returns the actual accepted turn
ID. Neither route starts a new turn or substitutes a tool result. Supported
connections advertise steering in `started`; API routes remain queue-only. The
frontend never implements steering as cancel plus replacement, and a
failed/uncertain steering call is not automatically queued or replayed.

## Optional API routing and credential boundary (0.10.0)

`CodexPanelSettings.providerId` selects a saved API profile; omission remains
Codex. The native settings source dropdown shows public profile metadata and
preserves the unsaved draft when refreshed. Selecting an API profile hides
Codex model/effort controls and shows the saved model/address. Saving applies
the source to the current Overleaf account/project. The panel displays the
connection name and hides Open in Codex for API histories. Rendering, quotation,
selection and context-building adapters are shared unchanged.

The extension-owned manager connects through `opt:api-settings`. Its transport
requires the exact extension origin and `api-settings.html` path in the top
frame; Overleaf cannot use this port. The project transport admits only the
read-only `provider-list` alongside supported chat/history operations, never
`provider-save`, `provider-delete` or `provider-test`. The worker uses the same
native host registration but separate ports. Credential inputs exist only in
the manager, not the content script or page bridge. Responses expose only
`id`, `name`, `baseUrl`, `model` and `hasKey`. No browser storage stores the key.

`native/api_provider.py` stores profiles in a private local file (directory
`0700`, file `0600`), not Keychain. Profile updates preserve a blank existing key;
base URLs are immutable after creation. A new destination requires a new UUID
and has separate history. Endpoint validation permits HTTPS or loopback HTTP,
rejects embedded credentials/query/fragment, and does not follow redirects.
The management probe sends only `GET /models`, without manuscript or inference;
an empty list does not validate the model. API `status` reads local saved
metadata, so it must not be presented as a live authentication check.

Native requests with `providerId` route to the API backend before any Codex
bootstrap. `POST /chat/completions` receives the bounded current context and
bounded prior conversation context; SSE and JSON answer text are supported.
There are no tools, automatic source writes, fallback to another provider or
replay after uncertain delivery. Cancellation closes the local connection,
without promising cancellation of remote processing or charges.

API conversations use separate per-profile native stores and account/project
scopes, with provider-specific locks, active pointers and browser display cache
keys. Their saved context supports later API turns but is not imported into
Codex Desktop. Deleting a connection retains its local history, and a new
profile does not inherit it. Default Codex history, thread synchronization and
Desktop ownership handling retain their existing path. Exact storage paths,
request shapes and installation details are in [the backend guide](codex-backend.md#optional-api-connections-0100).

## Preview ownership and source selection

The bridge publishes formula text immediately and measures its start through the host view's `requestMeasure` read phase. A stable location identifies the view, file and formula start. Geometry updates have matching formula/location data and never restart rendering. Missing, clipped, unfocused and stale anchors hide the portal. Popup content is measured and positioned before it becomes visible; the module observes only its own size and image loads, never native MathJax mutations.

There is no native rendering fallback. Interactive MathJax uses `{tolerant:true}`: unresolved commands become red text atoms without consuming unknown argument syntax, while the rest of the expression renders. `partial-syntax.ts` installs per-instance stack items for incomplete scripts and unclosed ordinary groups. They preserve parsed nodes and visibly mark the unfinished fragment red, replaying closing/group/cell boundaries instead of consuming them. Recovery is a single parser pass, capped at 64 structures; it does not reset macro or buffer counters. Missing command arguments and other structures without safe recovery still fall back to escaped source text, not an error banner. Strict rendering remains the default for audits. Formula, macro, expansion, generated-matrix, placeholder and SVG bounds still apply.

The renderer is preloaded. Drafts run at most once per animation frame; duplicate formula events and scroll/resize do not reset a debounce. Within the same formula location the last frame remains until its replacement is ready; moving to a different formula clears it. TeX waits 650 ms after input, uses a current-formula MathJax draft meanwhile, and replaces it with the PDF only after identity/generation checks. Compiler failures keep the draft and place details in settings. Drafts are identified by a hover explanation and render-kind metadata, not presented as exact TeX output.

Document snapshots remain throttled at 450 ms and declaration-index work at 900 ms. Ordinary math text changes do not rebuild an unchanged MathJax index. TeX snapshot revisions invalidate compiled results separately. Initial load/explicit refresh requests one document snapshot, rather than publishing the entire document on every configuration update. Leaving and re-entering a formula resets a cancelled or failed TeX request; duplicate events at the same location do not.

The full index feeds completion; a separately filtered index feeds preview. A stable source catalog represents an installed package once and a project-local style file once. Preferences are project-specific and omitted from global defaults. Unchanged ordering replays the original declaration event tape, retaining interleaved inputs; an actual reorder groups enabled source events by the user order. Resetting preview sources clears only those preferences and saves automatically. Preview settings use a serialized latest-snapshot write queue, with a 350 ms debounce for the file-name field and a flush on blur, tab change or dialog close. Storage failures retain the draft and expose an inline retry. Only root/extra-file settings start a new index build; display settings and preview-source choices apply from the existing index. Defaults, manual reload and shared-cloud setup wait for pending writes. The manual command/package reload remains visible beside the native support disclosure (below it in narrow panels), outside its collapsible content because cached unopened files and new/renamed files can need a fresh project export.

Both TeX backends use the same source-control builder. Customized controls rewrite isolated copies of static load chains; default controls retain the original preamble. Unsupported dynamic or conditional chains fail explicitly. TeX declaration conflicts remain genuine compile errors, and dependencies already loaded by the document class cannot be silently reordered.

## Shared TeX document construction

The builder preserves the selected main source before its explicit top-level `\begin{document}` and requires one unambiguous `\documentclass`. Unresolved conditional/document boundaries fail visibly. It does not evaluate TeX to discover a preamble. Referenced document-shaped extra files are rejected rather than adding their original body.

The generated entry does not collide with source paths. A lazy bounded walk starts from its source preamble, active formula and configured extras, then follows literal local class/package/input/import dependencies. Installed TeX Live packages need no upload. The returned bundle excludes the original main-document body and unrelated chapter/bibliography files; the source adapter still reads a bounded project ZIP before this stage. Extra files receive loading markers only in scratch copies. Source controls run before a final dependency pruning pass; a disabled source can remain as a dependency-only shim when required to retain independently enabled children. The wrapper uses the real `preview` package; the current formula is its only intentional body content.

This scanner is not a TeX interpreter. It conservatively includes literal dependencies found in macro definitions, diagnoses computed file names and missing project inputs, and respects literal false branches, comments and package `\endinput` boundaries. Explicit additional files can supply otherwise untracked text dependencies. It does not silently fall back to a full project copy. Required image/font binaries are not synchronized: recognizable active resource loads fail explicitly, while loads inside macros or uncertain conditions produce diagnostics and can still fail in TeX.

Real TeX runs with new document state. It does not preserve definitions introduced earlier in the original body, counters, references/auxiliary state, page context or `\jobname`. Preamble hooks, custom output routines and external build programs may prevent a single-page preview. Full TeX execution is not arbitrary project equivalence.

## Cloud lifecycle and write boundary

The content script and settings panel share `extension-context.ts`. Work boundaries check the runtime identity without polling or keeping the service worker alive. Invalid runtime getters/resource URLs permanently abort that content instance: listeners and observers stop, timers and pending results are invalidated, the popup and settings tab are removed, and the page bridge receives a disabled configuration. Async completions cannot restore stale UI or start subsequent compile operations. Reloading an extension still requires reloading existing Overleaf pages.

The explicit first-use action creates a blank project through `POST /project/new`; no clone endpoint is used. The `shared-v1` binding is keyed by the current Overleaf account ID in this Chrome profile, so all source projects on `www` and `cn` share one workspace. Startup only reads the binding. Repeated enablement validates and reuses it. Different browser profiles/devices have separate extension storage and do not discover each other's workspace automatically. Existing per-source clone bindings are neither adopted nor deleted.

All authenticated Overleaf HTTP remains in the originating top-level content script and on its current Overleaf origin. For cloud preview, the background coordinates metadata/leases only and receives no document source or PDF; Codex separately passes its bounded context through the worker to its native host. Sender validation for project operations accepts only this extension's top-level Overleaf project pages; API management has the separate extension-page boundary described above. The cloud client checks the current account, verified project owner and target identity, rejects a target equal to the source, and never accepts a general UI-supplied write destination. Its short forced-new metadata connection disconnects after retrieving the project tree; it never joins or edits an individual document. Normal Overleaf project presence effects can still occur.

`withSharedCloudLock` encloses the complete transaction: restore and verify the shared binding, reconcile known file identities, remove obsolete managed files, match the source compiler/TeX Live environment, upload changed text, compile the generated entry and download its build-specific PDF. The coordinator serializes lock-state read/modify/write and grants one FIFO lease per account across both language origins. Queue entries are refreshed while waiting and obsolete formula requests cancel before starting work. A changed formula never releases the lock while its awaited HTTP request remains in flight.

A lease is valid for 30 seconds and renews every 10 seconds only while a transaction owns it; each actual cloud network boundary also verifies its fencing token. Idle tabs generate no heartbeat. Lock identities and deadlines persist in `storage.local`, with a session mirror, so stopping the service worker or restarting the browser does not grant a second writer prematurely. A lost owner is quarantined for an additional 300 seconds beyond its last active deadline, matching the longest compile HTTP timeout. An explicitly uncertain remote outcome revokes the lease and retains that quarantine. This can delay the next cloud preview after a crash or ambiguous network failure; an ordinary successful transaction releases immediately. Expired tokens cannot renew, save bookkeeping or continue cloud work.

The workspace journal stores paths, file IDs/types and SHA-256 text digests. Before an upload, its path is journaled; after completion, the returned identity and digest are saved even if the formula has changed. Metadata reconciliation recovers such pending uploads. Cleanup can delete only registered file identities verified against the current tree. Unregistered or replaced identities stop synchronization instead of being deleted. The initial blank project's `main.tex` is adopted as bootstrap content. Shared files are extension-managed; manually editing them in place is unsupported and file-ID checks do not establish that their contents are unchanged.

Source compiler and TeX Live image are read from authenticated metadata, cached for 15 seconds, and invalidated by native compiler/version changes or explicit refresh. Unavailable values fail rather than guessing. Only the shared project's settings change. Compilation sends both `rootDoc_id` and `rootResourcePath`; the client fetches same-origin build-specific output routes rather than arbitrary returned URLs. This matches the selected environment but does not reproduce original-document state or custom external builds.

The global compile interval is at least three seconds; attempted request failures normally set a ten-second backoff. Tab-local PDF caching is keyed by source identity, compiler/image, entry and every bundled file digest, bounded to 12 entries and 16 MiB. Cache hits bypass synchronization and compilation. Formula revisions and environment changes invalidate stale visible results; already running remote work may finish without being shown.

Creation records a pending intent before its mutation. A known newly created ID is preserved even if metadata retrieval fails. An unknown create outcome is not retried automatically: the user must inspect the account rather than accumulate duplicates. Generated and synchronized files persist in Overleaf, and deleting obsolete workspace files does not promise erasure from project history. Old clone projects remain untouched. Detailed Chinese usage and tradeoffs are documented in [shared cloud preview](shared-cloud-preview.md).

## Local lifecycle and data boundary

The worker connects to `com.overleaf.personal_tools`; there is no HTTP listener or localhost service. Each tab has one render port. A newer render disconnects the older one; status has a separate short port, coalesces concurrent checks and does not interrupt rendering. Tab closure and the 30-second transport timeout disconnect ports. Responses echo request IDs and pass shape/size validation.

The Python host admits supported system TeX Live executables from fixed locations, writes supplied text into a temporary job directory and runs the engine under macOS `sandbox-exec`. It disables shell escape, sanitizes TeX environment paths, limits resources and kills the process group on cancellation/EOF. It never falls back to unsandboxed execution. See [native backend](native-backend.md) for exact limits and installation.

Only project text is transferred. Project image/font binaries and private user TeX trees are unavailable; permitted installed TeX/system dependencies remain readable. The local environment need not match Overleaf. The stable public `manifest.key` fixes the ID used in native-host `allowed_origins`; retain it across releases. No signing private key is shipped.

## Rendering, permissions and lifetime

MathJax/PDF.js and standard PDF fonts ship with the extension; there is no CDN loader. MathJax does not touch Overleaf's global. PDF.js uses its bundled loopback worker in the isolated extension realm, rejects encrypted/multiple-page output and bounds bytes, canvases, pixels and rendering time. PDF.js 6 requires the Chrome 145 baseline, including `Map.getOrInsertComputed`; an esbuild syntax target does not polyfill missing runtime APIs.

Preview source snapshots and render caches live in tab memory. Preview-related Chrome storage retains settings, account/shared-project bindings, owned file identities/digests and queue/lease deadlines, not preview source text or PDF. The assistant additionally retains bounded display history that can contain manuscript quotations and an explicitly created, bounded pending queue containing immutable project snapshot references, and sends requested context through the user's configured Codex service or explicitly selected API endpoint. API credentials remain in the native private profile file and never enter Overleaf DOM or Chrome storage. Shared cloud workspace files persist in the user's Overleaf account; local TeX jobs retain text/PDF only until temporary-directory cleanup. Permissions remain `storage` and `nativeMessaging`. Cloud requests use same-origin session credentials and the page CSRF token. There is no telemetry or external compilation service.

## Extending support

Add completion entries to `PACKAGE_CATALOG`: names omit the leading backslash, snippets include it and use numbered `${1:argument}` placeholders. A catalog does not implement MathJax rendering. Add static configuration imports and opt-in package activation separately, with diagnostics for unsupported options/collisions. Never execute `.sty` as JavaScript or use a remote loader.

TeX mode executes installed package code but does not discover every command exported by arbitrary packages. Completion remains a scanner plus catalogs. New backends should implement the `tex-types.ts` contract without coupling transport to popup DOM. Keep unstable native selectors/APIs in their owning adapters; add lifecycle cleanup to new features.

## Verification and release

Run `./dev.sh check` for type checking, synthetic Vitest tests and bundling. Focused suites cover parser/index, snippets/CodeMirror, MathJax/packages, TeX document construction, cloud/native transport, settings, assistant context/panel and PDF lifecycle. Run `/usr/bin/python3 -m unittest discover -s native/tests -v` separately; real TeX engine cases require a functioning macOS sandbox and TeX, while Codex host tests use a mock app-server and API tests use synthetic profiles and fake HTTP peers. Tests use synthetic files and owned sentinels rather than personal data.

The dev fixture uses built scripts with artificial ZIP/settings/formula interfaces and a native-style rail. Its Codex transport returns messages labeled simulated and does not contact a real model. The 0.8.2 fixture adds a delayed/failing model catalogue, per-model efforts, a 127-formula stream and visible progress counters for scroll/rendering checks. Mock transports establish contracts and failure handling, not production Overleaf compatibility or real Codex conversation acceptance. Earlier preview live checks are recorded separately in the [evidence document](overleaf-evidence.md); they do not establish acceptance of Codex Assistant.

Use `?preview-race=1&typing-regression=1` on the fixture for delayed native success/error replacements, continuous typing and per-frame visibility counters; add `&native-preview=0` to prove that no native popup is required. `scripts/benchmark-preview.mjs` measures synthetic cold/warm rendering and indexing separately from scheduling delays, explicitly in Node rather than claiming browser latency. `scripts/smoke-preview-sources.mjs` compiles synthetic ordering/disable cases through the production builder and sandboxed native host. The two `scripts/audit-*-macros.mjs` runners accept explicit local files, record fingerprints and representative invocation results, and write ignored artifacts. They never upload those files; a successful invocation is not a proof for arbitrary arguments or exact font equivalence.

After host changes, verify settings mounting/restoration, completion coexistence/undo, popup menus, archive reads, experimental editor exports and the shared create/synchronize/compile flow. Recheck the evidence document before changing endpoints. Do not write to the user's working project merely to test completion.

Preserve lockfile, public key, source and licenses. Update package/manifest versions and CHANGELOG together; rebuild, reload the extension and refresh Overleaf. Update the TeX and Codex native hosts independently with their respective installation scripts. Rollback does not delete the shared cloud project, legacy copies or Codex conversations, or unregister a separately installed host.

## Interface language

`i18n.ts` follows Overleaf’s `ol-i18n.currentLangCode` metadata, then HTML language, then English; browser language never overrides the website. Chinese tags map to the Chinese catalog. `settings/messages.ts` owns typed panel keys. `i18n-runtime.ts` is a presentation adapter for legacy diagnostic strings; new diagnostics should migrate toward keys and typed arguments. It only translates owned exact text and anchored templates, preserving opaque project content and raw logs.

Language observers watch metadata and the HTML language, not editor mutations. In-page changes preserve settings drafts and UI state, translate assistant controls, and update visible preview messages without invalidating formula caches. Normal Overleaf language links navigate to the selected language origin. Preview settings remain keyed by project ID; Codex settings use account and project IDs; conversation display history additionally includes the selected API profile identity when present. Unsaved edits follow normal page-navigation behavior. Production origins are explicitly allowlisted in `overleaf/origin.ts`, and every cloud/metadata operation remains same-origin. The local fixture builds a transport stub instead of allowing localhost through production guards.

## 0.8.2 verification status

TypeScript, 484 unit tests across 39 files, and the production build passed.
These checks cover the automatic catalogue, supported efforts, quote history,
tooltips, native typography, long-form math and viewport behavior using
synthetic inputs. Chrome fixture acceptance additionally verified the real
DOM and browser interactions: automatic model loading and retry, unchanged
settings drafts, 14px native controls, draft/sent quotes, focus tooltips, the
bundled icon, all 127 formula SVGs, stable upward reading during streaming,
Jump to latest, theme/language switching and stop. The detailed
[fixture acceptance record](../dev/README.md#082-browser-fixture-acceptance)
includes screenshots and measured scroll positions.

After manually reloading 0.8.2, the actual Overleaf editor additionally verified
automatic discovery of eight local models, model-specific effort choices in an
unsaved draft, native Noto Sans typography, visible keyboard-focus tooltips,
and selection-card retention while focus moved from the editor to the composer.
The official icon loaded, both existing history messages remained, and all 87
math placeholders in the existing answer rendered to SVG without MathJax error
markers. No new live inference was requested, no existing conversation was reset,
and no manuscript text was edited. The 127-formula streaming/scroll test and
post-send quote tests remain synthetic-fixture results. See the
[live-page check](../dev/README.md#082-live-overleaf-check) for the exact scope.


## 0.10.0 API verification status

TypeScript, 618 frontend tests across 46 files, 161 native tests and the
production build passed. The installed helper's four Python modules match
source. These checks exercise API management admission, draft preservation,
credential isolation, source-specific UI behavior, native history scopes,
streaming and failure/cancellation with synthetic inputs. Browser access was
disabled; no new visual/live Overleaf acceptance or real API inference was
performed. The existing historical browser records above retain their original
scope. The separate synthetic manager fixture at `/dev/api-settings.html`
uses in-memory metadata and does not contact a model or persist credentials.


## Visual formulas and quotation dismissal (0.11.1)

The MAIN-world Visual adapter maps existing `.ol-cm-math` replacement widgets
through public CodeMirror DOM positions and exact math syntax-node boundaries.
Only indexed project-macro references receive a successful supplemental SVG;
ordinary native formulas retain their rendering and line wrapping. Original
widget children/events remain intact, are hidden only while the supplemental
render is valid, and reappear on disable or failure. No manuscript transaction
is dispatched. Work is capped by visible widget count, bounded cache, source/SVG
size limits and time-based yields. DOM identity and generation checks reject
stale results. Source changes invalidate immediately; caret moves reconcile
without briefly exposing the native macro errors. The renderer stylesheet
remounts if Overleaf replaces the document head.

Empty source snapshots are passive unless the bridge marks an explicit editor
collapse, selection change or outside click. Focusing or clicking the assistant
preserves the current quote. An outside dismissal fences the retained CM range
until a new editor interaction, so opening Codex cannot reattach stale source.
Already-sent quotations and assistant-answer quotations are unaffected.

Update recovery remains DOM-only after extension context retirement. Its rail
control uses native navigation styling, a subtle status dot and a hover/focus
popover, with a DOM-only fallback. It never automatically reloads or requests
resources through the retired runtime. Native helpers remain at 0.11.0.

## Request admission and explicit queue promotion (0.11.2)

The helper uses a constrained machine-readable `additionalContext.name` while
keeping the same untrusted manuscript-context payload. A typed JSON-RPC error
separates explicit turn admission rejection from uncertain transport outcomes.
Independent native history is appended only after a valid turn ID. The content
script tracks submitted/accepted/rejected states and rolls back optimistic rows
only when non-admission is known, preserving the latest synchronized history.

`PromptQueue.beginItem` reserves a selected queued entry for explicit promotion,
without reordering others or admitting a second in-flight entry. The sending
marker is durable before `steer`; the captured files/quotes/settings are reused.
Before-dispatch failure releases the reservation into a paused queue. Uncertain
post-dispatch results become review-required. No old persisted records are deleted.


## Visual typing continuity (0.11.2)

MAIN-world formula ranges are mapped through CodeMirror ChangeDesc during a
text edit. Only ranges whose exact delimited TeX remains unchanged survive;
changed formulas invalidate synchronously before a native node can be reused.
The next source scan verifies syntax-tree/DOM positions again. This avoids the
old unconditional empty snapshot on every keystroke. Snapshot handling reuses
cached SVGs in that source frame rather than adding a second animation frame.
Mutation observation also handles new/remounted widgets and late identity markers.
Pending asynchronous rendering still checks generation, source key and current
DOM identity before applying its result. Native children and outer widget events
remain intact, and unsupported formulas fall back to the native rendering.

## Returning to quoted sources (0.11.3)

Draft and persisted quote cards share a small source action. Answer navigation
uses stable message IDs, an in-memory origin for unsent quotes, or a unique
rendered-text match only after the current history is complete. Older history
loads are bounded to eight pages per action. Navigation never changes the active
conversation, starts a model turn, or edits the draft. The transcript pauses
following, waits for scrolling to complete, and highlights the source. Layout
preservation does not write scrollTop during that motion; manual scroll intent
cancels pending jump effects.

Manuscript navigation resolves native file tabs and tree entries using public
DOM identity and full paths, including Overleaf's sibling folder lists. It
temporarily opens an unmounted file rail only when needed and restores it unless
the user has chosen another panel. Before a cross-file switch the MAIN bridge
captures the active CodeMirror view and document identity under a bounded request
ID. After activating the target tab, a prepared reveal waits until the target is
active and its view or document differs from that captured state. This supports
cached editor restoration with no new mount/edit event, while a renamed tab label
alone cannot prove that its document has loaded. Correlated bridge requests then
verify the exact text and use host CodeMirror selection and
scroll effects in either Code or Visual, without changing the document or mode.
Moved text is relocated only when exact text/context identifies one position.
Source selection publications are suppressed during navigation so existing
draft references remain intact; the next deliberate editor interaction resumes
normal capture. Timeout, cancellation and page retirement remove listeners.

### Complete project reader (0.12.0)

Snapshots are stored with private directory/file permissions under the native
assistant data directory, separate from API credentials and the manuscript
workspace. An unguessable snapshot reference grants read access only to that
published version; the MCP has no global project-list, arbitrary local-file,
network or mutation tool. Native upload and ask admission additionally enforce
the Overleaf account/project scope. The MCP is registered with Codex so Desktop
continuations can read the same snapshot. A running Desktop owner must load the
new reader before project-mode continuation is accepted. Source synchronization
happens on Overleaf send/queue/steer, not continuously after the browser closes.

The 0.12.1 native maintenance update deduplicates verified snapshots by scope,
root and a canonical complete manifest while retaining random snapshot IDs.
Index targets are revalidated in full under the same cross-process lock; old
published references are never removed. Incomplete uploads inactive for 24 hours
are cleaned at the next upload. Different revisions can still accumulate; the
16 MiB source limit is per snapshot, not a total disk quota.

Each ask/steer also carries a fixed application-context slot with only the
extension's current reader instructions, bounded below the runtime truncation
limit. Installed-runtime loopback tests verified that this becomes a complete
developer message while manuscript fragments remain untrusted user context.
This is needed for legacy chats: updating thread or collaboration settings alone
did not update the model-visible developer message in the observed live chat.
The helper preserves the resumed thread's model and effort, and does not rewrite
old conversation records or promote manuscript instructions.

### Planned context retention modes (not yet shipped)

The agreed settings design has three modes, with on-demand caching as default:

| Mode | Context | Local source lifetime |
| --- | --- | --- |
| Normal context | Chat history, selected source and nearby text | No complete-project download |
| On-demand cache (default) | Complete supported project text, read through scoped tools | Delete after the last tab for that project leaves or closes; switching focus or worker suspension must not trigger deletion |
| Keep project locally | Complete supported project text in its original directory structure, plus explicit version policy | Retain across browser exits until a user-triggered cleanup |

Present these as one project-level Context mode selector under Settings →
Extension → Codex Assistant, inheriting Overleaf's existing typography and
controls. Explain beside the selector that both full-project modes provide the
same reading capability; they differ in source lifetime. Normal context must be
labelled as limited to the supplied excerpt and must never claim whole-project
access. On-demand means synchronizing on a question that needs project context,
not downloading every project merely because the account or page was opened.
Before later questions, refresh source data; unchanged content can reuse a
verified snapshot. The source scope is supported text such as TeX, bibliography
and style files, not PDF output or image assets.

Persistent mode should show the project folder, last synchronization and disk
usage, with actions to open the folder, synchronize and clear local source.
The folder is an assistant-managed read-only mirror: edits in it must not be
silently overwritten or uploaded. Clearing or changing retention must disclose
which local copies and historical source versions will be removed, while chat
history remains independent. Existing snapshots cannot be silently deleted
simply by installing a release whose new default is on-demand caching.

Chat records and source storage must be separate. Temporary source removal keeps
chat text and quoted excerpts, but old full-source references are unavailable;
reopening downloads the current project version. Continuing full-project reads
in Desktop after Overleaf closes requires the persistent mode. Cleanup must
observe all tabs for a project and distinguish ordinary worker suspension from
page exit, scoped by account and project. A short reconnect grace period must
also keep a normal page reload from expiring its source references. If the last
page leaves during a reply, mark the cache for cleanup and retain only the
snapshot leased by that turn until completion or cancellation; do not wait
indefinitely for a Desktop owner to release a conversation. An expired source
reference must report that state and must never silently resolve to a newer
manuscript revision. An abnormal browser shutdown needs a startup recovery sweep; do not
promise immediate deletion after a crash without a verified lifecycle mechanism.
The persistent project mirror must stay within a dedicated, owned directory and
must not write changes back to Overleaf. Manual cleanup shows size and separates
the current mirror from source versions referenced by existing chats.

### Same-project multi-tab history reads (0.12.5)

The native project lock remains exclusive for asks, conversation selection, and
new-chat writes. A history-read that encounters `ProjectBusyError` can read the
account/project-scoped SQLite cache without a model RPC. It returns
`remoteState: unknown` and `syncPending: true`, with no fresh `syncRevision`.
This is ordinary waiting, not proof that the conversation is idle. The composer
keeps its draft and quotes but cannot submit until a normal read confirms state.
Each tab retains its explicitly selected conversation, regardless of another
tab's active binding. Other projects retain independent locks.

The existing visible-page five-second history poll continues even when a pending
page has no cached conversation yet. Once the writer releases the lock, the next
poll reads Codex history normally. No ask is replayed and no replacement chat is
created. Pending text is not repeatedly announced as a live-region error.

### Connection health and recovery (0.12.2)

The composer shows connection health separately from answer progress and source
synchronization. A successful authenticated status/model read establishes the
connected state; cached history alone cannot do so. Errors clear the catalogue
to avoid advertising models from a previous account. Read-only status operations
share one pending request; temporary routing/disconnection failures get two page
retries at 5 and 15 seconds, in addition to one native process rebuild within a
shared 36-second native deadline. The client transport does not retry status a
third time underneath this controller. Authentication and installation failures
wait for explicit action. Page visibility and ongoing operations defer recovery;
retirement, provider changes and disabling the assistant clear retry timers and
invalidate late replies. No ask, steer, or history-selection mutation is replayed.

The badge inherits host typography, uses text as well as a colored dot, and keeps
long diagnostics in the existing focus/hover tooltip. Only settled connection
changes are announced in a polite live region. Retry progress does not repeatedly
interrupt a screen reader or move focus away from the draft.

### Incremental project snapshots and page-side repair (0.12.6)

Capture still uses a complete fresh Overleaf source export plus the verified
current editor buffer. No private edit-log endpoint or guessed revision counter
is trusted as a complete record of collaborative edits. Every supported path,
UTF-8 length and SHA-256 enters the new manifest. `source-begin` optionally
returns `missingPaths`; the page uploads only this validated subset, or all
files for an older helper. A manifest change captures removals and renames.

New version-2 snapshots store immutable manifests referencing content blobs
scoped to the Overleaf account/project. Reuse checks actual bytes and hashes;
commit rechecks the entire manifest. Unchanged blobs are not rewritten.
Version-1 snapshots remain readable. Existing snapshot IDs retain their original
meaning; a repaired same-hash blob also repairs old version-2 references.

The settings action `Sync project cache` runs the same source capture/upload
path without a model request, conversation mutation, or preference write. Its
result reports total files and files requested for upload, not ZIP network savings.

Before ask/steer, `source-check` verifies the exact captured snapshot. While the
page's reply remains active, a single-flight guard checks every five seconds.
Only `source_unavailable` triggers a fresh source capture/upload and recheck of
the original ID. There are at most two repair attempts per guard; a failed
repair stops that guard and reports the error, preserving the model turn. Network
errors do not trigger repeated exports. Finishing/cancelling/retiring the page
stops monitoring; late callbacks cannot start another repair. A source admission
failure before any model dispatch is explicitly marked `notAccepted`.

This is page-side recovery, not an active-turn retention coordinator. It cannot
recover after every project page closes, guarantee a model tool waits for the
repair, or reconstruct a deleted original manifest from newer text. Those cases
fail explicitly. The durable pins, brokered read retry, and cleanup protocol
below remain planned. Updating the reader digest advances its startup marker:
an already running Desktop must restart before admitting a new full-project turn.

### Cache sync guidance in the composer (0.12.7)

A dedicated lightweight notice above the composer supplies the exact manual
sync path: Settings → Extension → Codex Assistant → Sync project cache. It is
independent of progress/status text, so thinking or answer completion cannot
overwrite the guidance. Repeated state leaves the DOM untouched; transitions
use a polite status region without moving focus or changing the reading position.
Source capture/check/recovery errors set the error notice; ordinary model or
history network failures do not. Successful capture/commit clears it, but a
subsequent failure verifying an older immutable ID restores the error notice.

`CodexCacheFreshness` keeps page-local fingerprints, not source copies. A stale
hint requires both a verified editor observation differing from the latest
successful full capture and at least five minutes since that capture. Age alone
and edits before the first known capture do not imply stale cache. The revision
boundary is taken before editor capture: older observed buffers are discarded
when the export succeeds, while edits arriving during capture remain compared
against the committed source. Reverting a difference clears the stale hint.
Focus/visibility restoration rechecks the clock; teardown cancels the timer.

This is a cautious local heuristic, not a cross-tab timestamp or an Overleaf
edit-log authority. It does not detect edits in unobserved files or other pages;
the fresh full export before a new project question still establishes currency.
Integrity checks remain native SHA-256 checks, not these hint fingerprints.

### Planned cache lifecycle and recovery contract — NOT IMPLEMENTED

**Status: design only, updated 2026-11-02.** This section extends the planned
retention modes above. It does not describe behavior shipped in 0.12.5 and does
not authorize the current runtime to remove any published project snapshot.
The existing runtime keeps published snapshots; only abandoned upload staging
has an idle cleanup policy. The three-mode selector and the lifecycle/recovery
protocol below still require implementation and acceptance testing. The narrower
0.12.6 page-side check/repair described above does not implement these durable
last-page cleanup or brokered reader guarantees.

| Planned mode | Project context | Retention rule |
| --- | --- | --- |
| Normal context | The question, chat, selection and nearby source | Do not download or retain the complete project for the assistant |
| On-demand cache — default | Download supported project text when a question needs whole-project context | Clean managed temporary source only after the last page for the same account and project has left and all accepted turns using it have finished |
| Keep project locally | The same whole-project reading capability | Keep an owned local mirror and explicitly retained versions across page/browser exits; removal is a separate user action |

The default applies to newly managed cache entries. Installing a release or
changing the selector must not silently convert existing retained snapshots into
deletion candidates. A mode change affects subsequent captures; any migration
of existing copies needs an explicit, reviewable scope. Chat records, quoted
excerpts and the source-retention policy remain separate.

#### Project occupancy and last-page cleanup

A page lease is a durable record that a particular browser document is still
using a project. Store a set of individually identified leases, not a lone
increment/decrement counter. Each record contains the Overleaf account and
project, a browser-instance identity, a document-generation identity and an
opaque lease token. This permits idempotent acquire/release and prevents a late
release from an old document from releasing its refreshed replacement.

The native coordinator must serialize lease changes and deletion across all
participating browser instances on the device. Browser memory or a single
service worker's variables are insufficient. Each project page registers even
when its Codex panel is closed, so a second page protects the shared cache before
it submits a question. Account changes release only that document's old scope
and register a new one; one account or project cannot release another's lease.

Closing one of two pages for the same account/project removes only its own
lease. Cached text stays available while the second page remains. Switching
tabs, hiding a window, browser timer throttling, worker suspension, or switching
Code/Visual mode does not count as exit. A normal reload enters a reconnect
grace period; the new document can acquire its lease before cleanup becomes
eligible. Missing heartbeats alone do not prove that a background page closed.

Use confirmed document/tab departure plus startup reconciliation to retire
stale leases. After a browser crash, reconcile persisted browser/document
identities before sweeping; if presence cannot be determined, defer cleanup.
Do not promise immediate removal after a crash. A last-page exit changes the
scope to cleanup-pending. Under the same cross-process coordinator lock,
recheck that the page-lease set is empty, the reconnect grace has elapsed,
no persistent-retention claim applies, and no accepted-turn pin applies before
deleting any managed temporary source. A new acquire cancels pending cleanup.

#### Accepted-turn protection, including Desktop

A turn pin is independent of page occupancy: it protects the exact immutable
snapshot used by an accepted model reply. Acquire a provisional pin before
submission and persist its scope/snapshot identity. After admission, bind it to
the confirmed thread and turn IDs. Explicit pre-admission rejection can release
the provisional pin. A timeout or lost acknowledgement is an uncertain outcome
and must retain protection until the outcome is reconciled; it must not cause a
question to be submitted again.

The last project page may close while Codex Desktop continues the reply. Native
host process death or closing its IPC connection does not prove that a
Desktop-owned turn ended. Accepted pins therefore survive both page departure
and native process death. Release them only after a confirmed terminal result
(completed, failed, or cancelled/interrupted) for the bound turn. A cancel
request alone is not confirmation. Unknown/unreachable status retains the pin
and schedules a later bounded status check; it never becomes permission to
delete. The earlier instruction not to wait indefinitely for conversation
ownership means that cleanup tracks the specific accepted turn, rather than
requiring Desktop to release the entire conversation.

Steering can introduce another snapshot into the same active turn; protect all
such snapshots until that turn is confirmed terminal. Once the turn finishes,
delete only eligible temporary source for scopes with no remaining pages.
Keeping full-project access from Desktop after all Overleaf pages have closed
and all accepted turns have finished requires the persistent mode.

#### Missing or corrupt source recovery

Before admitting a project-context question, verify scope, the root document,
the complete manifest, byte lengths and every content hash. A missing/corrupt
source file, interrupted upload or invalid index must not silently downgrade a
whole-project question to an excerpt. Discard only invalid cache metadata or
owned staging involved in the failed operation, then ask a currently authorized
page of the same account/project to download the supported source again.

Coalesce concurrent recovery for the same snapshot/scope. Allow at most two
source-export attempts under one 90-second overall recovery deadline, including
validation/upload; observe cancellation, account changes and document retirement
between stages. No question or steering request is replayed as part of source
recovery. A failed recovery preserves the question, draft and quoted text,
reports a concise source-recovery error, and leaves an explicit retry path.
Successful recovery can resume the blocked source operation within its original
deadline; it does not create a duplicate model turn.

Snapshot IDs name immutable manuscript versions, not a mutable project's latest
text. Before an uncaptured new question is submitted, a fresh export may receive
a new snapshot ID. For an already captured queue item or accepted turn, repair
the original ID only from text matching its retained original root and complete
manifest hashes exactly. A verified original copy may repair damaged storage
without changing the version. If another download contains newer edits, publish
it under a new ID for a later question; never attach it to the old ID or silently
change an in-flight question's context. If the original identity/manifest cannot
be verified, report that version unavailable instead of guessing.

During processing, integrity failure must enter the same bounded recovery path.
Keep the accepted pin while recovery is pending. Hold or retry the affected
source read within the deadline; do not resubmit the model question, inject a
second turn or pretend an empty read succeeded. Desktop and custom-API readers
must receive equivalent explicit recovery outcomes.

The MCP reader remains a separate, offline, read-only process. It cannot obtain
Overleaf cookies, perform a download or expose a write/network tool to the
model. Recovery must be brokered through the native coordinator to an authorized
open project page, using the established validated source-upload channel and
an exact snapshot capability. If no suitable page is open, login has expired,
or the network remains unavailable, preserve any valid pinned original copy and
report recovery unavailable. Automatic fresh downloads cannot be guaranteed in
those conditions.

#### Required acceptance matrix before enabling cleanup

| Scenario | Required observable result |
| --- | --- |
| Two pages, same account/project; first page leaves | Its lease is removed; cache and second-page access remain intact |
| Second/last page leaves, no accepted turn | Cleanup occurs only after grace and an atomic final eligibility check |
| Normal page reload with delayed old-document release | Replacement lease remains; cached version is not prematurely expired |
| Hidden/background page or worker suspension | Its occupancy remains; no cleanup from timer throttling alone |
| Multiple browser instances using one local store | Native coordination preserves all live scope leases |
| Different account or project | No lease, repair request or cleanup crosses its scope |
| Last page closes during accepted Desktop reply | Exact snapshot remains protected, including after native process exit |
| Start acknowledgement is lost or cancellation is unconfirmed | Pin is retained, outcome is reconciled, and the question is not replayed |
| Browser/native crash and restart | Durable leases and pins are reconciled before any sweep; unknown state defers removal |
| Snapshot disappears before a new question is admitted | Bounded redownload/validation completes before admission, or a clear error preserves the question |
| Snapshot is corrupted during a reply | The source read enters recovery; the accepted turn and original version remain protected |
| Recovery download differs from queued/in-flight version | Old ID is not overwritten; mismatch is explicit and new content receives a new ID |
| Two pages request recovery together | One scoped recovery operation serves both; no duplicate turn or conflicting publication |
| No page, expired login, offline network, or retry budget exhausted | No silent excerpt fallback; original copy is preserved when available and recovery failure is explicit |
| Normal mode or persistent mode | Normal mode creates no full-project capture; persistent copies survive last-page exit |
| Upgrade or switch from existing retained data | Existing snapshots are not silently deleted; only explicitly managed temporary entries become eligible |

### API models and editor recovery (0.12.9)

API status now queries the configured endpoint’s model list. Project `apiModel` overrides the connection default only for that provider, independently of Codex preferences. Missing model endpoints retain the configured fallback; authentication/network failures do not report a working connection.

Editor capture retries pending identity for up to 1.5 seconds. A verified active buffer may overlay the fresh complete export. If identity remains unavailable, no unverified buffer is overlaid: the saved Overleaf export is synced and a persistent notice explains that unsaved edits could not be verified. Export failures still block submission. Cached editor switches settle identity proactively so delayed questions do not lose ownership.
