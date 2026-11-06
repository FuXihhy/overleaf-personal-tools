## DeepSeek models and saved-source recovery (0.12.9)

Open `?api-provider=1&codex-editor-unavailable=1` to exercise API model selection and a persistently unavailable live editor. Model changes survive settings closure; Other model supports manual IDs. Sending still captures all four source files and displays the saved-source notice. No model API is contacted by this fixture. Real DeepSeek tests use only artificial temporary project files; see `artifacts/0.12.9/deepseek-live-api-acceptance.json`.

# 0.12.7 cache-guidance acceptance

Open the harness with `?codex-source-fail=1&theme=dark`. A manual sync fails
against the synthetic helper and the assistant shows its independent manual
settings-path notice. The visible Restore simulated source access control
removes that synthetic failure; manually syncing again clears the notice.
Chrome verified the draft survives both transitions. Screenshot:
`artifacts/0.12.7/cache-guidance.jpg`. No real project or model request is used.

Fake-clock tests verify five-minute freshness hints, no age-only warnings, editor
changes during capture, revert/teardown behavior and successful sync dismissal.
Content tests distinguish source errors from model-network errors. The helper
remains 0.12.6; real-page acceptance awaits user extension reload to 0.12.7.

# 0.12.6 incremental project-cache acceptance

In the synthetic harness, open Settings → Extension → Codex Assistant and click
Sync project cache. Chrome verified 4 files uploaded initially, 0 on an unchanged
second sync (same snapshot ID), and 1 after editing only main.tex (new snapshot
ID). The button uses the native 600 14px / 20px Noto Sans font and 9999px radius.
No real manuscript was edited or model question sent. Screenshots and test logs
are under `artifacts/0.12.6/`.

Native regressions verify unchanged blobs are not rewritten, deleted/renamed
files, cross-scope isolation, missing/corrupt blob repair of old immutable IDs,
changed text refusing to replace an older version, v1 compatibility and reader
startup checks. Frontend regressions cover same-ID recovery before/during a
reply, no question replay, stopped polling on completion, and persistent warnings
for failed steering-snapshot restoration. Actual updated Overleaf UI acceptance
awaits extension reload and a Desktop restart for the v2 reader.

Full ZIP download remains intentional: this is incremental local storage/upload,
not a verified Overleaf edit-log or incremental network-export implementation.
Cleanup modes remain a design; no published snapshot is deleted on page exit.

# 0.12.5 multi-tab synchronization acceptance

Use `?codex-history=1&codex-sync-pending=1&theme=dark` for cached history
blocked by a synthetic second-page writer. `Release simulated other page`
releases it; only the normal history poll updates the assistant. Omit
`codex-history=1` to cover first-use empty history. The fixture sends no real
Codex question and uses no personal manuscript.

Native regression tests reproduce an actual pair of NativeHost workers sharing
a project lock. While one answer is active, the other returns scoped cached
history with unknown/pending state, no RPC, and no write revision. After release
it recovers to normal history. Separate projects, account isolation and blocked
write mutations are covered. All 278 native tests passed.

Chrome verified the pending cached transcript, preserved draft, disabled Send,
and automatic return to Send-enabled without reconnecting or starting a chat.
After the user reloaded 0.12.5, the real Overleaf page was refreshed on 2026-11-02:
rail and assistant returned, connection was Connected, and no unsynced warning
was visible. No draft or active reply was interrupted. Actual model contention
was not injected; the concurrent native-host regression covers that condition.
Evidence: `artifacts/0.12.5/`.

# 0.12.2 connection recovery acceptance

The `?codex-routing-fail=1&theme=dark` fixture returns one temporary account
routing error, then restores the catalogue including a synthetic Astra model.
Chrome confirmed automatic request 2 recovery, unchanged unsent draft, no model
turn, Astra maximum/ultra choices, and English dark / Chinese light badge styles.
Actual installed native status returned 8 models including GPT-6-Astra. After
the user reloaded 0.12.2, the real Overleaf page showed Connected, manually
rechecked successfully, and displayed selectable Astra with all six supported
efforts. Original Follow Codex settings were restored without saving changes;
no manuscript edits or real questions were sent.

Validation: 766 frontend tests, 275 native tests, typecheck, build and archive
integrity passed. Evidence: `artifacts/0.12.2/`.

# Local integration harness

## 0.11.3 quote-source navigation acceptance

Open `?quote-return=1&theme=dark&visual-preview=1` for a synthetic 48-message
conversation: a quotation of the second answer is on the latest page, and source
quotes point to `main.tex` and `defs/extra.tex`. The visible source status reports
the current file, exact CodeMirror selection and whether the fixture document
remains unchanged. **Select answer passage** only creates a browser text selection
for testing the normal **Quote selected text** action.

Chrome checks on 2026-11-01:

- History source actions opened the nested file, selected its exact macro, then
  returned to the main file in both Code and Visual without document changes.
- Draft source/answer quote actions preserved the unsent question and both
  prepared references. The left panel remained visible during file switching.
- An older answer action loaded all 48 rows through ordinary history paging,
  located the original answer, and preserved the draft. The first browser run
  exposed layout-preservation writes canceling smooth scrolling; after the fix
  the transcript settled at scrollTop 107.5 with the source paragraph visible,
  instead of retaining the old bottom at 3713.
- English/Chinese action labels, the right-side panel, and inherited Noto Sans
  font were checked. Buttons reuse the panel's small icon and tooltip styling.
- These checks used only synthetic content and no model calls. The real Overleaf
  DOM was inspected for tab IDs and the sibling LI/UL folder structure.

Screenshots: `artifacts/0.11.3/quote-actions.png` and `answer-source.png`.
Native helper modules are unchanged from 0.11.2.
Final automated validation: TypeScript, 729 tests in 51 files, production build,
archive integrity and `git diff --check` passed. The two archives are
`artifacts/overleaf-personal-tools-0.11.3.zip` and its `-source.zip` companion.

### Live 0.11.3 check and cached-tab fix

After the user reloaded 0.11.3, real Overleaf checks confirmed source selection in
both Code and Visual, with the mode unchanged; closed source files reopened and
selected correctly through the native tree. Answer navigation scrolled the exact
quoted formula into view (target top/bottom 112/230 within transcript 88/495) and
preserved an unsent test draft. No manuscript edits or model turns were made.
Screenshots: `artifacts/0.11.3/live-visual-source.png`, `live-answer-source.png`.

The same check found a specific failure: switching to an already-open cached
file tab changed the native active file and displayed the correct source, but did
not emit the natural mount/docChanged event required by 0.11.3. The extension
timed out without selecting. Version 0.11.4 uses a correlated preparation that
records MAIN-world view/document identity before the native click, then retries
only the bridge's explicit pending result. It accepts restored cached views and
continues to reject an old document under a new tab label. Completion, cancel and
timeout release preparation; no document snapshot can bypass the identity check.

The opt-in `&cached-editors=1` fixture keeps real CodeMirror instances alive across
file tabs. Restoring a cached view changes visibility/focus only, without
setState/docChanged. Chrome 0.11.4 regression passed in Code and Visual: two views,
four cached reuses, zero document changes; each source quote was selected, the
draft survived, and no source error was shown. Proof:
`artifacts/0.11.4/cached-editor-return.png`. TypeScript, 735 tests in 51 files,
production build and fixture compilation passed. Real Overleaf still needs the
user to reload the corrected 0.11.4 extension for final cached-tab verification.

This page uses a real CodeMirror editor and the production bridge plus a development content build
with a stubbed cloud transport against a small synthetic source ZIP. It simulates the native
Overleaf settings, left rail and math-preview DOM required by the integration, plus synthetic
streaming Codex responses. It is not a
copy of Overleaf and cannot prove compatibility with every deployed version.
No personal documents or remote credentials are used.

After installing dependencies:

```sh
npm run build
node scripts/dev-server.mjs
```

Open `http://127.0.0.1:43123/project/0123456789abcdef01234567`.
The server binds only to `127.0.0.1`; stop it with Ctrl+C when finished.
`OPT_DEV_PORT` can override the default port.

Historical browser checks performed on 2026-10-29, before Codex Assistant:

- Only the native Settings dialog receives an extra tab. No permanent extension
  button or sidebar is created.
- Auto-discovered `macros.sty` participates in completion and preview. Manual
  selection of `notes/unloaded.tex` changes the command index, and returning to
  automatic mode restores the default set.
- Clicking a `physics` formula renders the derivative and sized parentheses.
- Clicking a custom `\\RR` / `\\vect` formula renders the user-defined symbols.
- The native preview's dropdown menu remains visible.
- Native CodeMirror completion offers `\\pdv`; accepting it inserts arguments,
  Tab selects the next argument, and Cmd+Z restores the prefix.
- Repeated settings opening and closing preserves native tabs and avoids
  duplicate extension sections (also covered in DOM tests).

Version 0.8 adds an explicit **人工测试** title and disclaimer, an artificial native rail with
the AI assistant entry, and a mock `opt:codex` runtime port. The production Codex panel mounts
below that entry. Settings → Extension now expands Preview and Codex Assistant; select Preview
to exercise the earlier preview controls. The mock supports status/models, streamed replies,
stop, new chat and in-memory display history. Every reply identifies itself as simulated and
includes inline and display mathematics for rendering checks. It never connects a real Codex
host, reads private projects or submits model inference. The memory-only mock history resets
on reload; the production extension uses bounded local storage instead.

On 2026-10-30, local fixture UI checks covered the two settings children, assistant settings,
rail placement, selection attachment and streamed mathematical rendering. These are synthetic
UI checks only; real Overleaf mounting and a real Codex conversation require separate acceptance.

Release checks for 0.8.0 passed on 2026-10-30: TypeScript, 452 browser-side unit
tests, the production build, and 40 native tests (including 26 Codex tests).
The fixture also verified stop, new conversation, English/Chinese switching,
and an empty warning/error console after these interactions. Recorded views:
settings (local screenshot, excluded from the repository) and
sidebar (local screenshot, excluded from the repository). Both screenshots are
explicitly marked synthetic; they are not evidence of a live Overleaf rollout.

The fixture's syntax-tree shim recognizes inline dollar math only; this is a
test-fixture limitation, not the production parser's supported math syntax.
The Chrome storage shim is intentionally memory-only and resets on reload.

Generated `dev/harness.js`, `dev/content.js` and their sourcemaps are build products, not source.

Version 0.2 browser checks additionally cover the MathJax/TeX selector, conditional
local/cloud settings, temporary-cloud-file explanation and the unavailable-host
status. The harness does not connect a native host or create cloud projects.

On macOS with system TeX Live, run `node scripts/smoke-tex.mjs` to feed a synthetic
project through the real document builder and sandboxed native compiler. Its body
contains an intentionally undefined command, while the preview formula uses
physics, a custom operator and a starred xparse macro. Successful compilation
checks that the original body was excluded and extra macros were not loaded twice.
No installation is performed. The generated PDF is ignored under `dev/generated/`.
With the dev server running, open `/dev/pdf-smoke.html` to test the packaged PDF.js
renderer with that PDF. This browser rendering check passed on 2026-10-29.

The UI language selector updates the same `ol-i18n.currentLangCode` metadata contract used by Overleaf. English and Chinese layouts can be checked without changing an account preference. `dev/content.js` replaces only the cloud transport with `dev/cloud-client.ts`; it cannot contact Overleaf or create projects. The production extension keeps strict same-origin checks.

For browser layout regression, open the fixture with `?tooltip-regression=1` and click **Run tooltip positioning regression**. The formula is placed near the editor’s top edge in a body-level absolute tooltip portal. After rendering, the fixture applies four late native hidden-position writes. The status reports both native inline values and effective viewport position. The popup must remain visible, close when leaving math, and reopen correctly from cache. This passed in Chrome on 2026-10-29; it complements, rather than replaces, real Overleaf checks.

On 2026-10-30, a refreshed real Overleaf editor also passed settings navigation,
connection/model listing, a synthetic browser-to-Codex question and rendered math,
source-selection attachment, and new-chat reset. The question contained only test
text, with project context temporarily disabled and then restored. No manuscript
text was edited. The real dark theme exposed a host heading-color override; 0.8.1
sets sidebar and answer headings to inherit the panel color.

After reloading 0.8.1, the real dark Overleaf sidebar title was confirmed as
`rgb(244, 245, 246)` on `rgb(27, 34, 44)`; the page had no captured warning/error
console entries. The editor was left with Codex Assistant open and ready.


## 0.8.2 regression scenarios

The following are artificial test data. They never contact a model or the
user's Overleaf projects. On the fixture URL, use:

- `?codex-long=1&theme=dark` for a long response and dark native-style rail.
- `?codex-status-fail=1` to fail the first automatic catalogue request and
  succeed after Retry connection; combine parameters with `&` as needed.
- The visible **Run simulated long reply** button to submit another long
  response through the production panel. The UI language and Rail theme
  controls can switch the surrounding fixture without an account change.

The catalogue waits 500 ms and advertises Synthetic Model A
(`synthetic-model-a`: low, medium, high, xhigh) and Synthetic Model B
(`synthetic-model-b`: minimal, low, medium). Open Extension → Codex Assistant
and verify loading resolves automatically, the effort choices change with the
model, and unsaved instructions remain intact during retry or refresh. The
visible model status includes the number of status requests.

The long response streams 100 chunks over approximately 15 seconds. It contains
127 math expressions: 112 inline examples, eight display examples, and the seven
expressions in the user's reported Chinese rendering sample at the end. This
exercises formulas beyond the old 80-expression cutoff. Progress counters show
chunk count, math placeholders/rendered SVG count, scroll position and remaining
content below the viewport; they belong only to the fixture. Paragraph growth
and subsequent formula SVG hydration exercise layout changes while streaming.

While a response is arriving, scroll upward, inspect an earlier paragraph, and
verify both new chunks and delayed formula rendering preserve that paragraph's
screen position. Click Jump to latest to resume following. Also inspect the
final seven formulas, tooltip placement on the rail and toolbar, the activity
label beside Codex, and selection cards before and after sending. Production
history survives reload when account identity is available; the fixture's
memory-only history intentionally does not.

The fixture deliberately uses 16px/24px settings containers but 14px/20px native
navigation and 14px/21px native labels, descriptions and small controls. This
exposes children accidentally inheriting oversized parent typography. The
font stack starts with Noto Sans, like the observed native Overleaf controls.

For 0.8.2, TypeScript, 484 unit tests in 39 files, and the production build have
passed. Current Chrome fixture acceptance is recorded below, followed by a
separate 0.8.2 live Overleaf check after extension reload. Earlier releases'
results remain historical; the current check's scope is stated explicitly.

<a id="082-browser-fixture-acceptance"></a>

## 0.8.2 browser fixture acceptance

On 2026-10-30, real Chrome interactions with the local synthetic fixture
verified the following. The fixture uses production panel/rendering code and a
mock Codex transport; it does not read a personal manuscript or perform model
inference.

| Area | Observed result |
| --- | --- |
| Automatic model catalogue | Opening Codex settings loaded models without a manual check; the injected first failure recovered through Retry connection. |
| Settings drafts and efforts | Unsaved instructions survived catalogue loading/retry. Model B exposed only minimal, low and medium as explicit efforts, alongside the default Follow Codex choice. |
| Native typography | Navigation measured 14px/20px; labels, descriptions and controls measured 14px/21px. |
| Selection | The draft quote expanded to full text, and the sent question retained its expandable source quote. |
| Tooltips and icon | New conversation and rail focus displayed visible tooltips. The bundled official Codex icon loaded with a 1024px intrinsic width. |
| Mathematics | All 127 expression placeholders became SVGs, including the seven expressions from the reported screenshot at the end of the answer. |
| Streaming viewport | After scrolling upward to paragraph 42 at `scrollTop = 3736`, subsequent output completed with `scrollTop` still `3736`. Jump to latest then reported zero distance from the bottom. |
| Theme, language and stop | Dark/light and English/Chinese switching worked, and Stop finished generation cleanly. |

Recorded synthetic fixture views:
settings (local screenshot, excluded from the repository),
thinking status (local screenshot, excluded from the repository),
selection and tooltip (local screenshot, excluded from the repository),
long-answer mathematics (local screenshot, excluded from the repository),
scroll position (local screenshot, excluded from the repository), and
light theme (local screenshot, excluded from the repository).
These screenshots document the local artificial page. They are not evidence of
0.8.2 running in the user's actual Overleaf editor. The separate live check is
recorded below.

<a id="082-live-overleaf-check"></a>

## 0.8.2 live Overleaf check

On 2026-10-30, after the user reloaded the extension and the actual Overleaf
editor was refreshed, browser interactions verified the following. This check
used the existing conversation and selected a short source passage without
submitting it. No new inference request was sent, no manuscript text was edited,
and the conversation was not reset.

| Area | Observed result |
| --- | --- |
| Automatic native catalogue | Opening Codex settings showed Connected to local Codex and eight available models plus Follow Codex, without clicking Check connection. |
| Supported efforts | Selecting `gpt-6.1-sol` in the settings draft exposed Default, Low, Medium, High, Extra high, Maximum and Ultra. The draft was restored to its original Follow Codex value without saving. |
| Native typography | Native and extension navigation both measured Noto Sans 14px/20px. The model control and instructions field measured 14px/21px. |
| Tooltips | New conversation and the Codex Assistant rail entry displayed visible tooltips on keyboard focus. This is focus evidence, not a claim that mouse hover was separately tested on the live page. |
| Selection | A short real editor selection produced a draft card with source file, line and text. It remained attached after focus moved to the composer and could be expanded. The selection was not sent. |
| History and mathematics | Both existing history messages remained. All 87 math placeholders in the existing answer contained SVGs; no `data-mjx-error` or `merror` nodes were found, and all seven previously reported expressions at the end rendered. |
| Official icon | The bundled icon loaded in the actual panel with a 1024px intrinsic width. |

Live screenshots are kept only in ignored local artifacts and are not copied
into these docs because they include manuscript context. The 127-formula stream,
scroll retention through new output, and post-send quote checks above remain
synthetic-fixture evidence. This live check establishes current native model
listing and UI/history rendering, not a new browser-to-model inference run.

<a id="090-acceptance"></a>

## 0.9.0 acceptance — 2026-10-31

TypeScript, 541 frontend tests across 43 files, 62 native tests, production build
and diff checks passed. The native helper was installed with the existing Codex
Overleaf workspace. Its registered conversation was assigned to that existing
backend project using official RPC; a fresh app-server read confirmed the
assignment. No Codex database or rollout file was edited.

Chrome's synthetic fixture verified the history list, switching between two
conversations, loading an older page from 12 to 24 messages, placing the panel
after the PDF in the real flex layout, and source/formula copying. Screenshot:
right-side history (local screenshot, excluded from the repository).

After the user reloaded 0.9.0, the actual Overleaf project verified:

| Area | Observed result |
| --- | --- |
| Code selection | Keyboard selection produced a quote with file, source line and LaTeX text; focusing the chat preserved it. |
| Visual selection | After clearing the prior quote, switching to Visual and making a new selection produced a real LaTeX quote at the correct source line; focusing the chat preserved it. Code mode was restored after the check. |
| History | The local helper recovered four existing messages, including both original user quotations. The history list showed the current scoped conversation. No real conversation was reset or replaced. |
| Mathematics | All 110 math containers across the two existing replies contained rendered SVGs after a fresh page reload. |
| Position | Moving right put the panel at x=836 with width=340 while the editor ended at x=829. Refreshing the page retained right placement and all four messages. |
| Typography/models | Native and extension navigation both used Noto Sans 14px/20px; the position field used 14px/21px. The settings loaded eight real models and Connected to local Codex. |
| Clipboard | The browser automation clipboard readout was empty even after successful copy. Native Chrome keyboard paste into the local-only fixture independently confirmed the exact 38-character formula source and a 911-character answer containing both inline and display LaTeX. Temporary fixture input was cleared without sending it. |
| Open in Codex | The history action invoked the supported codex://threads/UUID route; external-app handoff detached the browser command. The original Overleaf tab remained intact. The destination app UI cannot be inspected through the computer-use tool; the exact thread was separately readable via the Codex app tool. This is not an end-to-end desktop UI assertion. |

Live screenshots remain only in ignored local artifacts because they contain
manuscript context. No new inference, manuscript edit or synthetic question was
submitted to the real project. Page body/head replacement, context retirement,
readonly reconnects, mutation non-replay, cross-window expected-thread checks,
and history pagination/cancellation are automated-test evidence. The original
intermittent disappearing-entry incident was not observed directly in this live
session; the reproducible whole-body replacement failure was fixed and tested.


<a id="091-acceptance"></a>
## 0.9.1 acceptance — 2026-10-31

Automated validation: `./dev.sh check` passed TypeScript, 567 tests in 44 frontend files, and the production build. `/usr/bin/python3 -m unittest discover -s native/tests -q` passed 72 tests. `git diff --check` passed.

The local `?codex-history=1` page supplies synthetic data only. Its visible desktop controls update the mock native history; the extension discovers them through its actual polling path. Verified that adding a desktop turn appended two messages, while starting and finishing another updated the same assistant message without duplication. The draft was unchanged and `scrollTop` stayed at zero throughout. The remote active state disabled Send; the completed state restored it. Opening settings during polling still loaded the model catalogue. Formula copying was off initially; enabling the setting copied `x_31^2` and persisted the preference. No formula popup appeared. Synthetic synchronization screenshot (local screenshot, excluded from the repository).

The existing real Overleaf project was refreshed after reloading the installed 0.9.1 extension and installing its matching native helper. Its four existing messages and 110 rendered formulas returned, with no duplicate after repeated history reads. The new setting uses the website's 14px Noto Sans label styling and defaults to off. Temporarily enabled it, clicked a real formula, then used a native macOS paste into the localhost fixture: the value exactly matched `\delta_\alpha A_\mu=\partial_\mu\alpha`. Cleared the local test textarea and restored the real preference to off. No test question was sent to the real chat, no real conversation was reset, and no manuscript was edited. Real settings screenshot (local screenshot, excluded from the repository).

An isolated real app-server experiment used a fresh synthetic paginated thread and no model turn. The second client could read while the first held its writer. `thread/unsubscribe` did not immediately permit resume; closing the first client did. The test thread was archived through the official API. This confirms the delivery boundary: automatic display sync is supported; unrestricted immediate Desktop-to-Overleaf sending is not promised while Desktop holds the writer. See [backend constraints](../docs/codex-backend.md).


## 0.9.2 Visual preview acceptance

The local fixture now accepts `?visual-preview=1` to start directly in synthetic Visual mode. It uses real CodeMirror replacement decorations and a stable synthetic syntax tree; the formula chips are explicitly artificial, not native Overleaf rendering. Its controls exercise a 400 ms parse-only completion without a document/selection change and a displayed formula containing project-defined macros.

On 2026-10-31, local Chrome checks confirmed cold Visual activation, custom-macro widget reveal, delayed parser completion, display formula entry, `V_` partial-error rendering, recovery to `V_i`, and Code/Visual round trips retaining the same preview key. The screenshot `artifacts/0.9.2/visual-partial-input.png` shows the artificial source and local error display. TypeScript, 572 front-end tests across 44 files and the build passed. Native helpers were unchanged; this release does not claim a new native-helper acceptance run.

After the user reloaded 0.9.2, the independent real Overleaf tab was refreshed directly into LaTeX Visual mode without first entering Code. The existing `E_5=\partial_y-V^\mu\partial_\mu` formula displayed the extension's visible SVG preview immediately after loading. Entering the existing `\SU_I(2)` formula changed the preview key to that formula and rendered without red unknown-command nodes. Moving the caret outside hid the popup; returning restored it on the next measured frame. Code/Visual round trips preserved the same preview key. The page was left in its original Visual mode. No manuscript text, engine preference, conversation or cloud project was changed. Actual typing/partial-error and delayed-parser cases were exercised in the synthetic fixture, not by editing the user's manuscript. Screenshot: `artifacts/0.9.2/live-visual-preview.png`.


## 0.9.3 answer quote acceptance — 2026-10-31

- TypeScript, 600 frontend tests (44 files), production build and 63 Codex-native tests pass.
- Real Chrome, local artificial fixture: selected an assistant answer containing text and hydrated SVG mathematics; the action remained opt-in and preserved the draft. On attaching, original LaTeX appeared in an independent Codex answer card. No clipboard write or model inference.
- The temporary action is positioned above the composer without changing transcript layout. In the measured drag, the last answer body remained at `y=602.4765625` with height `23.5078125` before and after the action appeared. Selection events are coalesced with requestAnimationFrame.
- A simulated send included the answer quote, then reopening the saved synthetic conversation restored it from the mock native history. Switching to Chinese relabeled both history and pending quote cards; a second multiline quote retained inline and display LaTeX.
- Unit coverage includes coexistence with manuscript selection, removal/expansion, failed-send recovery without clobbering newer drafts/quotes, invalid/cross-answer selection, source rerender/removal, history reconciliation, source size limits, native prompt boundaries and SQLite migration.
- Updated the installed Codex helper to 0.9.3 with the standard installer; existing workspace configuration remains present and installed source bytes match. No new extension permissions.
- Evidence: `artifacts/0.9.3/answer-quote-zh.png` and `answer-quote-dark.png` (synthetic; light/dark themes). Live Overleaf acceptance after the user-confirmed reload passed: selected existing answer text with inline mathematics, attached exact LaTeX, expanded and removed the card. Evidence: `artifacts/0.9.3/live-answer-quote.png`. No live question was submitted or manuscript text edited.
- Live acceptance also exposed overlap between the temporary quote action and Jump to latest. The final build hides Jump to latest while a quote action is present; 600 frontend tests and the real Chrome fixture pass again, including visible quote / hidden latest. Final extension reload is pending.

<a id="094-acceptance"></a>

## 0.9.4 same-conversation continuation — 2026-10-31

The backend now sends through the existing Desktop owner after an isolated
resume reports a writer conflict. The browser keeps the same protocol, selection
collector, project context limits and quotation UI. This acceptance does not
claim that arbitrary third-party Desktop versions support the internal adapter.

`./dev.sh check` passed TypeScript, 600 frontend tests across 44 files and the
production build. The complete native suite passed 126 tests, including 49
Desktop adapter/state/handoff tests. Python compilation and diff checks passed.

Real inference used a separate temporary conversation, a separate helper history
directory and artificial source text. Desktop kept its writer throughout:

| Check | Observed result |
| --- | --- |
| Same conversation | An Overleaf native request entered the Desktop-owned thread, and a follow-up recalled the preceding synthetic token. The thread ID stayed unchanged. |
| Streaming | One completed response delivered 20 delta events, a final answer and `cancelled: false`. |
| Desktop → Overleaf continuation | A plain Desktop-side turn changed the remembered token. The next native request returned the new value exactly. |
| Current Overleaf context | A request included a newer editor selection, an intentionally stale copy of its file and a second project file. The answer preferred the new selection and also read the second file: `LATEST_SELECTION_73\|PROJECT_CONTEXT_86`. |
| Installed helper | Standard installation preserved the existing workspace configuration; installed host and both adapter modules matched source bytes. |
| Existing live page | Graceful disable/save/enable/save/check reconnected to the updated helper. The UI showed `Connected to local Codex`, and the six historical messages, unsent draft and current answer quotation remained. No extension or page reload was used. |

The QA conversation was archived through the application API and the original
Codex chat reopened. No synthetic question was submitted to the user's real
manuscript conversation, no actual source text was edited, and no existing
conversation was reset or forked. Live screenshot evidence stays in ignored
`artifacts/0.9.4/live-connected.png`. Chrome was still running its compatible
0.9.3 frontend; this verifies deployment of the helper, not a manifest reload.

The real tests found that an independent app-server can temporarily report
another process's running turn as `interrupted`. Such an observer status alone
must not finish the response; live owner state and actual persisted completion
are handled separately. Targeted tests also cover unknown delivery without
replay, exact-turn stopping, owner disconnection, history revision conflicts,
page close without cancelling Desktop, canonical snapshots and patch gaps.


## 0.10.0 API provider acceptance

On 2026-10-31, TypeScript, 618 frontend tests (46 files), 161 native tests and
production build passed. The newly covered paths include the default Codex
source, project-specific provider selection, separate profile/account/project
history and display caches, bounded full-context continuation, late history
polls during a source change, and extension-origin-only credential management.
Native tests exercise actual loopback HTTP/SSE, split UTF-8, partial failures,
length-truncated answers, immediate and setup-time cancellation, and cancellation
of a response whose socket is no longer held by the connection. These tests use
synthetic keys and documents, not provider credentials or manuscript content.

The companion helper and its three modules were installed and byte-compared with
source. This does not activate the new browser UI: reload the extension and refresh
Overleaf after preserving any unsent draft. A browser check was attempted twice;
the tool reported that local browser use was disabled in Work settings. No 0.10.0
visual/live-Overleaf acceptance or real third-party model inference is claimed.

For the pending synthetic visual check, build the extension, then run `./dev.sh dev`:

- `/dev/api-settings.html?lang=zh`: production connection manager with an in-memory
  fake transport. It uses no real keys, network model requests or durable storage.
- `/project/0123456789abcdef01234567?api-provider=1`: synthetic API choice in the
  native-style settings, with a link to the manager fixture. The fixture's mock
  conversation store is not evidence of provider isolation; automated integration
  tests verify the real scoping functions and transport instead.

Verify English/Chinese, light/dark layout, keyboard focus, labels and validation,
provider choice followed by explicit project Save, and unchanged 14px native
Overleaf controls. In the real extension, manage a user-supplied connection only
from the extension settings page; returning to Overleaf and refreshing the source
list must not erase an unsaved question. The model-list probe does not submit
inference or guarantee that the configured model accepts chat requests.


## 0.11.0 acceptance

Final release checks passed: **646 frontend tests (48 files), 192 native tests,
TypeScript, production build, synthetic harness compilation and diff check**.
The 0.11.0 native helper and all four Python companions were installed,
byte-compared with source, and checked for private file permissions.

This release adds formula-selection paint, an opt-in formula-copy notice, queued
follow-ups and native steering, and compact synchronized user messages.

Read-only live diagnosis on 2026-10-31 found that the current Codex login and
model catalogue were valid, with eight models and readable history. The active
extension conversation had no reachable Desktop owner: the Desktop discovery
step waited ten seconds while the old helper timed out after 5.5 seconds. The
root agent opened that same registered chat using the official Codex navigation
tool; a subsequent read-only probe found its owner immediately and read model
settings. No manuscript or inference question was submitted. This establishes
recovered ownership, not a live inference/steering test of the new release.

Browser use remains unavailable because the tool reports local browser use is
disabled in Work settings. Computer Use also explicitly refuses control of
ChatGPT itself. The documented Browser settings link opened but did not expose
the controlling Work preference; a source-verified Work settings link returned
the user to the settings homepage. No permission was changed by editing app
configuration or by bypassing the tool restriction. Consequently no live browser
visual acceptance is claimed for this release.

Pending synthetic browser checks use the existing local fixture with
`?codex-long=1&theme=dark` (no real credentials or model). During streaming, queue
two questions and steer one: the original prompt and all follow-ups should stay
visible, queued questions should retain their captured context, and Stop should
pause remaining work. The mock now emits active-turn/steering acknowledgements
and implements the queue's compare-and-swap revision API. Its history and queue
are still in memory only; reload persistence and cross-window stale writes are
covered by the automated production-code tests, not this fixture.

Select text across multiple formulas, including backwards selection, and check
that the SVG formulas share the text highlight. Toggle the copied-formula notice
in the native-style settings: the default is off, the opt-in notice is small and
short-lived, and typing focus/selection must not move. Long user bubbles should
show roughly six lines with Show more/Show less; expanding preserves full text
and the reader's position. Compact native-prompt tests separately verify that
visible user input is the question while full context is supplied to the model.


## 0.11.1 browser acceptance (2026-10-31)

Local browser access became available in this run. The synthetic Chrome fixture
verified Code and Visual selection capture, quote retention while typing in the
composer, immediate clearing on source collapse and outside clicks, and no stale
reattachment. The same unsent test draft survived quote dismissal.

The Visual fixture now uses native-shaped math containers and a project-defined
`\cN` macro. Cold Visual load rendered `\cN=(1,0)` without clicking; clicking
revealed the original source and moving away restored the rendered result.
Ordinary formulas and unsupported inputs retained their native widgets. The
retired-context simulation removed all extension panels, restored native math,
and showed only the refreshed rail control. Keyboard focus, Escape dismissal,
Chinese/English text and dark theme were checked. The tooltip inherited Noto
Sans. No errors from the tested extension were reported; unrelated Zotero
injection connection errors were observed in the tab log.

The real Overleaf page was inspected read-only to verify the native SVG error
node for `\cN`, 32px native rail geometry, Noto Sans and rail color tokens. Its
existing unsent question was left untouched; it was not reloaded and the new
release has not yet been activated on that real page. Screenshots in
`artifacts/0.11.1/` are synthetic acceptance evidence, not live manuscript proof.

TypeScript, all 660 frontend tests across 49 files and the production build pass.
Native code was unchanged, so its earlier 0.11.0 validation was not rerun.


## 0.11.2 verification — 2026-11-01

TypeScript, all 683 frontend tests across 49 files, the production build, and
196 native tests passed. The installed helper's five modules match source and
report version 0.11.2. A framed request through the installed native launcher
returned available/authenticated true and eight models, with no model prompt sent.
No new Chrome permissions or origins were introduced.

An ephemeral test against the installed Codex runtime and a loopback fake Responses
provider reproduced the old additional-context name rejection before any model
request. Changing only the inner name fixed it; the normalized key/name combination
also completed. All synthetic selection, file and answer-quote markers reached
the fake provider without an Authorization header. This proves runtime admission
and context forwarding, not a live account/provider inference result.

Chrome synthetic fixture checks verified:
- The native settings select uses 14px typography and defaults to Queue. Choosing
  Steer changes the single Send button's behavior without adding composer buttons.
- During a simulated streamed reply, Send queues an item. Steer now moves that
  captured item into the active conversation exactly once without replacing the
  original message. With Steer selected, ordinary Send directly adds the follow-up.
- `?codex-reject=1` yields an explicit admission rejection: the original draft
  returns, the error is visible, and zero optimistic messages remain in history.
- `?visual-preview=1` → Type near custom formula (synthetic) performs 16 edits
  before/after the custom formula. All 16 source frames had the supplemental SVG,
  and the formula source remained unchanged.

Artifacts under `artifacts/0.11.2/` include synthetic browser screenshots and the
runtime contract probe/results. No user manuscript or account credentials were
used for these tests. The current live Overleaf page was initially in retired
extension state; activation of the browser update is tracked separately.


### 0.11.2 live Overleaf activation

After the user confirmed the extension manager showed 0.11.2, the real Overleaf
project page was refreshed. The first account check reported the Codex runtime's
`workspace routing discovery timed out`; a later clean connection returned
`Connected to local Codex` and eight model choices. This runtime error refers
to account backend routing; its underlying transient cause was not established.
It is distinct from the repaired invalid additional-context name.

On the active page, Messages while working defaulted to Queue and used native
Noto Sans, 14px. Visual contained 59 mapped math widgets; both visible custom
cN expressions had supplementary SVGs and hidden native error output. Opening
the assistant restored its right-side placement and 15 displayed history rows,
with no error status or unsent draft. No manuscript text was edited and no model
question was sent. Sustained typing remains the separately recorded synthetic
16/16 check, not an edit to the user's live manuscript.

Local proof images: `artifacts/0.11.2/live-busy-message-setting.png`,
`live-connected.png`, and `live-visual-macros.png` in the same directory.


## 0.12.12 API reading budget acceptance

- Frontend: 872 tests in 54 files, TypeScript and unpacked build passed. Native: 315 tests passed. Native installation matches all eight shipped Python modules.
- Chrome synthetic fixture: API/project mode shows defaults 64 / 128 / 580 and explicit API usage/cost notice; changing rounds to 32 survives closing/reopening; invalid 0 shows an error and reopening retains 32; selection-only hides the group. Defaults restored after fixture checks. English and Chinese screenshots are under `artifacts/0.12.12/`.
- Regression coverage also checks boundary values, invalid empty/fractional/out-of-range inputs, preservation across status/locale changes, future-message settings during active replies, strict native/transport validation, actual override effects and unchanged selection-only timeout.
- Real Overleaf reloaded after the user confirmed 0.12.12: DeepSeek connected, defaults 64 / 128 / 580 present, rounds 32 persisted after closing/reopening, then restored to 64. Labels and inputs use native 14px / 21px Noto Sans. The unsent question was restored and no new live model question was submitted. Screenshot: `artifacts/0.12.12/live-budget-settings.png`.


## 0.12.13 dismissible cache notice acceptance

- TypeScript, 873 frontend tests across 54 files and the unpacked build passed. Native code remains 0.12.12.
- The synthetic Chrome page with `codex-editor-unavailable=1` produces the saved-source notice through ordinary Sync project cache. Its close icon is visible in the dark panel, Enter dismisses it, reopening the panel keeps it dismissed and retains the input draft. No model request was sent.
- Regression checks cover unchanged-status updates, language changes, reappearance after resolution or a different error, keyboard focus, draft/quotation preservation and transcript scroll position.
- User confirmed extension 0.12.13, then the real Overleaf page was refreshed through native window control (browser tab automation timed out). DeepSeek remained connected; manual Sync project cache reported 9 files, 0 uploaded. The live editor was verified on this attempt and the notice did not appear, so the actual dismiss click remains verified by the synthetic reproduction rather than this live run. No manuscript edits or new question were made; composer remained empty. Screenshots: `artifacts/0.12.13/notice-before-dismiss.png`, `notice-after-dismiss.png` and `live-after-sync.png`.

## 0.12.14 editor reconnect acceptance

- TypeScript, 894 frontend tests across 55 files and the unpacked build passed. No native changes or new permissions.
- Open the synthetic project with `?preview-reconnect=1`. Select formula and disconnect editor removes the third-party compartment without replacing the source state. Reconnect editor in the closed support section restores the live bridge; Return to editor without editing exercises automatic recovery. Both recovered an SVG popup in Chrome, with the fixture reporting unchanged document, selection and undo history. The connection counter increased once per recovery.
- Tests additionally cover full EditorState replacement on the same view, restored completion and Tab placeholders, no duplicate providers, preservation of another third-party plugin, failed initialization, stale acknowledgements, timeout, cancellation and manual/automatic races.
- The bilingual button uses native 14px typography and green primary styling. The gray confirmation row reserves 21px before activation. At an 800px browser viewport the support area was 494px wide with no horizontal overflow; actions moved below its summary. Screenshots: `artifacts/0.12.14/reconnect-settings-en.png`, `reconnect-settings-zh.png`, `reconnect-settings-narrow.png`.
- The preceding live diagnosis confirmed that a missing bridge was restored by the host's native extension-loaded handshake, but this new 0.12.14 build has not yet been reloaded and accepted on the user's real Overleaf page.
