# Codex Assistant local connection

Codex Assistant uses the existing extension's editor and project-source adapters,
plus a **separate** native-messaging host named
`com.overleaf.personal_tools.codex`. The existing local TeX host is unchanged.
The browser passes explicit questions, bounded quotations and complete project snapshots to the helper;
answers stream back through Chrome's native-messaging pipe. Codex remains the
default source and uses its existing local login, without a separate API key or
copied login token. Version 0.10.0 adds optional DeepSeek or other OpenAI-compatible
Chat Completions connections. Their requests use the supplied API address and
key through the same helper. Neither mode starts a localhost HTTP listener or
uses an extension-publisher service.

## Install on this Mac

Inspect the registration without writing files:

```sh
/usr/bin/python3 native/install_codex.py
```

Register or update the Codex helper for the stable extension ID, assigning new
conversations to an existing Codex project:

```sh
/usr/bin/python3 native/install_codex.py --install --workspace /absolute/path/to/Overleaf
```

`--workspace` resolves an existing app-server project by exact root path and
project name. It reads `project/list` without creating a project, thread or model
turn. An ambiguous or missing match is an error. Alternatively add
`--project-id <backend-project-id>` using the ID returned by app-server, which
can differ from the desktop tool's project ID. The workspace must already exist.

A plain `--install` preserves an earlier workspace configuration. With no
configuration, the helper keeps its original private working directory. The
optional `workspace.json` is private local configuration (mode `0600`), never a
browser-provided path. New `thread/start` requests explicitly carry its `cwd`
and backend `projectId`; `thread/resume` uses its `cwd`. Project-source context
comes from the browser. The private app-server disables project-file discovery;
the Desktop route has the separate permission boundary described below.

The installer copies five Python files—`codex_host.py` and its four companions
`desktop_ipc.py`, `desktop_state.py`, `api_provider.py`, `prompt_display.py`—plus a fixed
Python launcher, its own ownership marker, and optional workspace configuration into
`~/Library/Application Support/OverleafPersonalTools/codex-native-host/`.
It registers a Chrome Native Messaging manifest allowing exactly the extension
ID derived from this repository's public key. It does not change the TeX host,
global Codex configuration, account login, or Overleaf source files. Reload the extension and
refresh the Overleaf editor after a browser-side update. Re-run the installer
when the Python helper changes.

Version 0.9.4 adds the Desktop-owner adapter alongside the existing private
app-server client. To update an
existing installation, run `/usr/bin/python3 native/install_codex.py --install`
without `--workspace`; this preserves its existing workspace configuration.
Reload the extension and refresh the editor to start a connection using the
updated helper. Codex Desktop does not need to restart or release its conversation.
The browser/native protocol remains version 1. The adapter modules must be
updated together with the host; the installer rejects a production host whose
companion modules are missing. Assistant-answer quotations introduced in 0.9.3
remain supported.

Version 0.10.0 adds `api_provider.py`; re-run the same installer, reload the
extension and refresh Overleaf to update both sides. Existing Codex history and
workspace configuration are retained. The browser/native protocol remains
version 1, with optional provider routing and separately admitted management
operations. A plain installation also supports API-only use without Codex login;
`--workspace` and project lookup remain Codex-specific.

Version 0.11.2 updates both the browser and the native helper: refresh the
installation for account-transition handling and supported reply steering, then
preserve any composer draft, reload the extension and refresh Overleaf. The
new queue, compact user-message display and formula-copy notice need the new
browser build; installing only the helper does not enable those controls.
`prompt_display.py` must be installed with the other companion modules. The protocol remains version 1 with
additional validated operations and capability fields.

The helper supports macOS and Python 3.9+. For the default source, it discovers Codex in the known
ChatGPT/Codex application bundles or `/opt/homebrew/bin/codex` and
`/usr/local/bin/codex`. Browser messages cannot choose a command or executable.
Open the local Codex app and sign in normally, then open
Settings → Extension → Codex Assistant. Opening this settings page automatically
checks the connection and loads the available model catalogue. Authentication
remains owned by Codex.
A disconnected or signed-out backend is shown explicitly; the helper never
requests a password or exposes account email, login tokens, or raw auth data.

Unregister only the dedicated helper:

```sh
/usr/bin/python3 native/install_codex.py --uninstall
```

Uninstall keeps Codex conversations, the assistant's private history databases
and saved API connections. It
refuses to delete an unmarked directory or conflicting registration.

## Optional API connections (0.10.0)

In Overleaf, open **Settings → Extension → Codex Assistant → Manage API
connections**. The extension-owned `api-settings.html` page can add multiple
named connections, with an API base URL, model ID and password-type API-key
field. A DeepSeek preset supplies an address and model; the user supplies their
own key. Save the connection, return to Overleaf, refresh the connections list,
select it under **Model source**, and save the project settings. Codex remains
the default when no `providerId` is set. The source selection is scoped to the
Overleaf account and project, while saved connection profiles belong to this
Mac's helper installation.

Credential entry is restricted to the extension page. Its `opt:api-settings`
port admits only the exact extension-owned page and supports `provider-list`,
`provider-save`, `provider-delete` and `provider-test`. Overleaf content scripts
can request public connection metadata but cannot save, remove or test profiles,
and cannot supply credentials in chat requests. Returned profiles contain only
`id`, `name`, `baseUrl`, `model` and `hasKey`; the secret is never returned. The
manager clears the key field after a successful save or navigation, and an empty
key when editing preserves the saved value. It does not save credentials in
Chrome storage or Overleaf DOM.

The native store is
`~/Library/Application Support/OverleafPersonalTools/codex-assistant/api-connections/profiles.json`.
Its directory is mode `0700` and file mode `0600`; this is a private local JSON
file, **not macOS Keychain storage or application-level encryption**. The helper
checks ownership, rejects symlink storage, serializes mutations and writes
atomically. Up to 24 profiles are supported. Changing an existing profile's
base URL is rejected: create a new connection for another destination so old
history cannot silently move there. Name, model and key can be updated. Deleting
a profile removes its saved credential but retains its local conversations.
Those retained histories do not become part of a newly created profile.

A profile uses HTTPS, or HTTP restricted to a loopback address. URL credentials,
query strings and fragments are rejected; redirects are not followed. The
helper sends `Authorization: Bearer` only to the selected endpoint when a key is
present. It does not accept arbitrary browser headers, tools or executable
paths. No additional Chrome host permission is needed because the native helper
performs these outbound requests. API-only mode does not require an installed
or signed-in Codex, but does require the native helper. Usage belongs to the
chosen API service rather than the Codex subscription.

**Check connection** in the manager performs only `GET <base>/models`, with no
question or manuscript content. It checks the endpoint's metadata response, not
a completed inference; an empty list explicitly leaves the configured model
unverified. The API `status` operation shown in Overleaf only reports the saved
configuration and model, not a live authentication result. The configured model
remains usable even if a compatible gateway omits `/models`; a failed probe is
not silently replaced with a model question.

Questions use `POST <base>/chat/completions`, accepting bounded SSE streams or
ordinary JSON responses. The request includes the same bounded Code/Visual
selection, nearby/project context, writing instructions and optional answer
quotation as Codex mode, plus bounded prior conversation context. Files and
quotations are untrusted text; only scoped read-only source tools are available, with no automatic document writes
provided. Only answer content is displayed, not provider reasoning fields.
Network errors, rate limits or uncertain outcomes never trigger a replay,
automatic model-source fallback or duplicate request. Stop closes the local
connection; it cannot guarantee that the remote provider has stopped processing
or billing an accepted request.

Each connection has its own private history database under
`codex-assistant/api/<profile-id>/`, with separate Overleaf-account/project
scopes and active pointers. Both native history and the bounded browser display
cache include the provider identity. Switching source loads that source's
history rather than copying the other source's messages. API history stores
questions, answers, quotations and context needed for later API turns locally;
the remote provider receives that context when a question is sent and may retain
it under its own policy. These local conversations are not Codex threads and do
not sync to Codex Desktop; **Open in Codex** is hidden. Source switching does
not delete either history. Unknown account identity retains the existing
connection-only, nonpersistent scope rule.

The remaining Codex authentication, thread-import and Desktop-owner details
below apply to the default Codex source. Shared editor context, quotations,
rendering and history pagination remain available with either source.

## Scope and persistence

The current implementation is read-only manuscript discussion. Selected text
is the snapshot captured by the editor and may be newer than the project ZIP;
it takes priority over project-file context. Files are quoted data, and source
comments cannot authorize tools or actions. Project-specific writing preferences
are supplied separately. Source files are not written to the helper's workspace.

For the default Codex source, the Overleaf account ID and project ID jointly
define the history scope. Their
combined hash indexes an extension-owned `history.sqlite3` under
`~/Library/Application Support/OverleafPersonalTools/codex-assistant/`.
This is separate from Codex's database: the helper never edits Codex SQLite or
rollout files. The directory is mode `0700` and the database is mode `0600`.
A catalog retains each registered conversation's title, dates, active pointer
and display messages, including the exact manuscript selection and assistant
answer excerpt attached to a question.
Completed final answers and partial answers on interruption/disconnection are
saved locally. The native catalog has no 60-message or 350000-character eviction
rule. Large histories are paged rather than silently truncated.

A project lock covers asking, reading, selecting and starting a new conversation;
SQLite transactions protect the shared catalog across projects and processes.
`ask.expectedConversationId` checks the browser's intended active conversation
under that lock, before any Codex RPC, so a selection in another window cannot
silently redirect the next question. Without an identified Overleaf account,
the catalog and messages remain in memory for that connection only.

The browser can select only a conversation registered in the current
account/project scope. Knowing an arbitrary desktop UUID does not grant access.
New conversation clears the active pointer and creates a thread only when the
next question is sent; it neither deletes nor archives previous conversations.
The History view lists those retained entries and can select them for review
and follow-up. Opening an entry in Codex addresses that same stored thread.

On the first access to a scope, version 0.9 imports the previous small JSON
active-thread binding into the catalog. Its first history read hydrates display
messages through `thread/read` metadata and paginated `thread/turns/list` with
`itemsView: full`, one turn per RPC because each turn can include a large
manuscript snapshot. The old prompt wrapper is parsed to recover the actual user
question, selection and answer quotation; manuscript-file payloads, reasoning and tool activity
are not copied into the display history. Assistant messages designated as final
answers are imported; a partial persisted version is updated in place as the
turn progresses.
The importer is limited to the registered thread. Threads unbound before 0.9
cannot be attributed safely to an Overleaf account and are not auto-discovered.
A scope with no active conversation displays an empty new chat while its catalog
entries remain available. A failed read leaves the browser's existing display
cache available for retry rather than resetting the native conversation.

Codex itself persists its normal conversation, including source context supplied
for answering. Source snippets used for Q&A therefore are not confined to the
preview's in-memory cache. Actual inference uses the configured Codex account
or provider and its normal usage limits. New threads receive an
`Overleaf · <first question>` title through `thread/name/set` when supported.
An existing registered thread can be assigned to an existing Codex project
through supported `thread/metadata/update`; changing `cwd` alone is not evidence
that its project assignment changed.

The browser's 60-message/350000-character storage remains a bounded display
cache for startup and unavailable-helper fallback. It is not the native history
catalog. Native pages preserve full saved text and both quotation types; older
pages can be loaded without replacing already displayed content. A history read
refreshes a registered thread from Codex, while the private mirror remains
readable when that RPC is unavailable. Version 0.9.1 supports automatic display
refresh of this registered conversation. It does not browse unrelated desktop
chats or synchronize projects, skills, memories or plugins.

## Assistant-answer quotations (0.9.3)

Selecting text within one assistant answer reveals **Quote selected text** above
the composer. Only clicking that action attaches the selection to the next
question. One answer quotation is retained at a time and may coexist with an
editor-selection attachment; a later quote replaces only the answer quotation.
The draft card can be expanded or removed. Selecting and attaching text do not
send a model request or read/write the system clipboard.

The snapshot contains selected text and original LaTeX for rendered formulas.
A selection boundary inside a rendered formula expands to that full formula;
it does not attempt to infer a LaTeX substring from selected glyphs. Both range
endpoints must be inside the same assistant message. The snapshot remains
independent of later rendering or history updates.

The helper receives `answerQuote` separately from `selection`. It places the
snapshot in the quoted context JSON as `assistant_answer_quote` and explicitly
identifies it as untrusted prior-answer material to discuss or correct according
to the actual question. A quote never supplies file coordinates or grants a
tool capability. On send, browser display history and the native mirror retain
the attachment on the user message. Legacy history import recovers it from
the saved wrapper; new compact question records retain matching validated
metadata from the local mirror. The nullable `messages.answer_quote` SQLite column is added in place,
preserving pre-0.9.3 rows. Quotes are never silently shortened to fit a limit.

## Compact visible questions and preserved model context (0.11.0)

All new Codex `turn/start` and `turn/steer` calls use the exact question as their
visible text input, including the Desktop-owner routes. The full bounded
manuscript JSON is sent separately through the supported `additionalContext`
map. Its per-project entry has `kind: untrusted`, a valid machine name,
and a value containing the data-only context label plus project ID, editor
selection, project files and optional `assistant_answer_quote`. The installed
experimental schema supports this on both operations, and the Desktop adapter
forwards it. It is not a tool-output substitute and does not hide context from
the model. Model instructions still distinguish quoted manuscript/answer data
from the actual user's request.

New visible user bubbles therefore contain the question rather than a JSON
project dump or the old `User question / Quoted manuscript_context` wrapper.
Both the browser and native mirror retain inspectable quotation metadata. When
authoritative history contains the same plain question, the importer preserves
matching, validated locally saved selections/answer quotes. API inference keeps
its existing contextual messages and already stores plain question text in its
display history; this change does not reroute API traffic.

`prompt_display.py` is a display-only parser for incoming Desktop response
annotations. It requires the exact known formatter preamble, a valid bounded
array, complete closing delimiter and an immediate `## My request` heading.
It extracts the actual question, selected passages and labeled user comments
into an ordinary answer-quote card. A common valid source message ID is kept;
machine offsets and annotation instructions are not added to the visible bubble.
It handles the current brace directive and known earlier bracket spelling.

The parser limits the whole wrapper to 1,048,576 characters, the array to 64
items and the combined quotation to 64,000 UTF-16 units. Duplicate JSON keys,
nonfinite values, malformed/deep JSON, invalid Unicode, unknown fields or extra
unhandled generated sections return no compact representation. Ordinary user
headings are never a sufficient signature. Cached native display pages apply
the same recognition; the legacy Overleaf parser remains scoped to its project.
Unknown or malformed text is kept for the frontend's six-line expansion view,
not silently deleted or shortened.

The original Codex input, stored conversation and logs are never rewritten.
This compaction changes Overleaf's display and the structure of newly submitted
questions, not old Desktop messages. Expanding an ordinary long message still
shows its full preserved text, and current context budgets remain unchanged.

## Captured follow-up queue and steering (0.11.0)

While a reply is running, Queue stores a follow-up with its question, manuscript
selection, answer quote, bounded project files, settings and provider/conversation
identity captured at that moment. It does not replace or stop the active answer.
The page sends queued entries FIFO after the current turn completes. Since 0.11.2,
Messages while working chooses queue (default) or steer. The ordinary Send
button and Enter share this behavior; Shift+Enter remains a newline. Unsupported
steering falls back to queue. Stop remains a separate control. A queued entry
can be promoted with Steer now, preserving its original captured context.

The browser queue admits at most eight items within a 1 MiB serialized JSON
budget. With an identified Overleaf account it is stored in `chrome.storage.local`
under the account/project queue key; each item remains fenced to its provider
and conversation. Unknown accounts keep the queue only in page memory. This is
separate from native history and is a new persistent copy of bounded manuscript
context. Later document edits do not rewrite an already queued item. A queue
must be processed or cleared before changing model source, starting a new chat
or switching history. Editing an unsent item restores its question and quotes
only when the composer is empty; its next explicit submission recaptures context.

Reload restores the queue paused. Explicit Resume queue can continue unsent
entries; previously sending/failed entries require review and cannot resume
as though they were never delivered. Stop, network errors and unknown outcomes
pause further dispatch. The queue is not a background service and does not
wake a closed page. No failure triggers automatic resubmission or source fallback.

Steer now is a separate `steer` request, never cancel/start or answer replacement.
It carries the ordinary bounded question/context fields plus the acknowledged
`expectedConversationId` and `expectedTurnId`. Supported connections advertise
`canSteer: true` only after a turn ID is acknowledged. The helper checks the
current project, account, provider and active conversation. The independent
app-server route uses `turn/steer` with the exact expected active turn.

The Desktop-owner route uses version 1 of `thread-follower-steer-turn` through
the validated owner. It follows Desktop's current-reply behavior within that
same conversation: the owner may retry once if the active turn changes during
delivery, and the acknowledgement identifies the actual accepted turn. It does
not start a new turn or inject a tool-output substitute. The UI must not describe
Desktop steering as strict delivery to an old, already-completed turn. API
connections remain queue-only; unavailable capability disables steering.

Successful confirmation creates a separate stable user-message identity and
preserves the current answer. Missing activity, ambiguous confirmation or a
timeout leaves the prompt for review; it is not automatically queued or replayed.
The transport returns the confirmed conversation/turn identity rather than
assuming every acknowledgement belongs to the original request's turn.

## Desktop continuation and writer ownership (0.9.4)

Read-only synchronization imports ordinary desktop user messages as well as
Overleaf's wrapped questions. Persisted partial and final answers are upserted
by turn identity, and display messages retain a stable `messageId` so a refresh
does not append a duplicate answer. Each refresh checks the newest turn even
when Codex's second-resolution `updatedAt` has not changed. Changed tail turns
are imported until a matching completed turn is found; a metadata change with
an unchanged latest turn triggers a deeper scan for older edits. This polls the
history Codex has persisted. While an Overleaf question runs through the Desktop
owner, an additional scoped Desktop stream supplies its live answer updates.

`remoteState` distinguishes an unfinished turn (`active`), a confirmed finished
history (`idle`), and unavailable or unsupported confirmation (`unknown`). Cached
messages remain readable when refreshing fails, but `unknown` cannot authorize
another question. Legacy history without the paginated writer guarantee is also
readable but cannot be continued through this cross-client bridge.

Before a question, the browser supplies the history `syncRevision` it displayed.
The native host starts a fresh isolated app-server and checks the latest history.
If the registered thread has no other writer, it resumes that same thread and
checks the revision again before `turn/start`. New conversations also use this
private writer. The helper closes its own app-server after every completed,
cancelled or failed ask, including a failure after resume.

If resume reports another writer, the helper discovers the existing Desktop
owner and submits the question through that owner's follower interface. Desktop
keeps the writer and starts the turn in the same conversation; the helper remains
a reader and follower. It rechecks persisted history after finding the owner,
and Desktop rejects context injection if another turn becomes active. Finishing
a Desktop answer is sufficient to continue from Overleaf when this adapter is
supported: no manual release, inactivity timeout or Desktop restart is needed.
A turn still running in either client must finish or be stopped before another
contextual question can start. The native bridge does not queue a conflicting question; the 0.11.0 browser queue keeps it unsent until the current round has finished.

Only a conversation already registered to the current Overleaf account/project
can reach this route. No arbitrary Desktop UUID, account-wide thread listing or
remote-host routing is exposed to the browser. A private resume must return the
same registered thread ID. There is no fork, transcript copy into a replacement
chat, lock deletion/stealing or shutdown of another owner's process. Codex's
[single-writer implementation](https://github.com/openai/codex/pull/34986) and
[unsubscribe behavior](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)
remain intact; 0.9.4 delegates to the writer instead of waiting for it to release.

### Versioned local Desktop adapter

`desktop_ipc.py` implements the installed Desktop's internal IPC protocol, not a
public stable API. It identifies itself honestly as `overleaf-personal-tools`.
The current adapter requires initialize version 0, owner discovery version 1,
start-turn version 2, steering version 1, model-settings version 1, interrupt
version 4, following version 1 and state-stream version 11. The discovered owner must explicitly
advertise `supportsUntrustedAppInput: true`. Unknown versions or missing support
fail closed; an app update can require an adapter update. This is protocol and
capability gating, not a claim that every Desktop release is compatible.

The endpoint is `$CODEX_HOME/ipc/ipc.sock` (normally `~/.codex/ipc/ipc.sock`). Before
connecting, the helper verifies a same-user socket with mode `0600` inside a
same-user directory with mode `0700`; it rejects symlink endpoints and verifies
the peer UID where the platform supports it, including macOS. It neither creates
nor changes that endpoint. Messages are length-bounded JSON frames. Responses
must match their request and owner; stream events must match the discovered
owner, this follower, the local host and the registered conversation. Other
threads' broadcasts are discarded, and raw Desktop state is not logged or sent
to the browser.

Each submitted turn carries a fresh `clientUserMessageId` UUID. This identifies
the submission; it is not a promise of exactly-once delivery or permission to
retry. A timeout, disconnect or invalid confirmation after delivery is an
**unknown outcome**: the question may already be running in Desktop. The helper
does not replay it or fall back to a second writer. The user can inspect the
synchronized conversation before intentionally sending again. Cancellation
targets only the confirmed turn ID with `mode: user-stop` and
`expectedTurnId`; it never issues an unqualified stop against the conversation.

`desktop_state.py` applies bounded snapshots and revision-checked patches in
memory. A revision gap requests a fresh snapshot. Only final-answer text for the
submitted turn is displayed; reasoning and tool events remain outside the
browser history. The private app-server continues read-only polling of that
turn. Persisted completion or failure can finish the response, but a separate
reader's `interrupted` status is not authoritative while Desktop owns the live
turn. An initial interrupted placeholder waits for owner activity, or a fresh
owner snapshot explicitly confirming idle after acknowledgement. An unknown
runtime cannot be treated as idle; an unresolved confirmation ends with an
explicit unknown-state error without replaying or interrupting the question.
An answer exceeding the output bound stops only its confirmed turn. Closing
the adapter unsubscribes and closes only its socket; it does not close Desktop's
app-server.

### Account transitions and absent Desktop owners (0.11.0)

Login health and ownership of an existing conversation are distinct. Status
checks use a fresh app-server. A long-lived read connection is refreshed when
the local credential file's metadata changes; the helper observes metadata,
not credential contents, and does not return account identities or tokens.
Desktop IPC reset broadcasts invalidate cached owner/state information.

The Desktop router can spend a fixed ten seconds locating a thread owner before
its method timeout begins. Earlier code waited about 5.5 seconds locally and
reported a generic coordination timeout before receiving a valid no-owner
response. The local wait now includes the separate discovery allowance. If no
Desktop owner exists, the helper may retry ordinary resume of the same registered
thread once using a fresh connection, before any question has been submitted.
This is not a resend, lock takeover or fallback to a new conversation.

If that thread still has an active writer but no accessible Desktop owner, the
helper reports the ownership problem explicitly. Open the same chat in the
current Codex window and retry; if it remains unavailable, starting a new chat
is an explicit user choice and retains the old local history. Re-authentication
alone does not establish that an older Desktop-owned chat is available through
the current window. The adapter never deletes a lock, stops another owner or
copies the conversation automatically.

### Permission boundaries

The private app-server disables shell, browser, computer use, apps, plugins,
hooks, memory, agents, web search, skill discovery and external MCP tools. During
bootstrap it reads effective integration names without logging their values,
then explicitly disables each inherited MCP server and plugin because empty
TOML tables alone merge with existing configuration. A read-only effective-config
check confirms only the fixed local overleaf_project reader is enabled for this
dedicated process; inherited MCP servers and plugins remain disabled. It uses a read-only sandbox, no network, approval policy
`never`, empty turn environments and rejects server-initiated tool or permission
requests. The installer registers the fixed read-only manuscript MCP in Codex
configuration so Desktop can access the same snapshots; the runtime does not
change unrelated configuration.

The Desktop route uses Desktop's existing process and therefore has a different
boundary. Every submitted turn explicitly supplies `sandboxPolicy: {type:
readOnly, networkAccess: false}`, `approvalPolicy: never`, `permissions: null`,
`environments: []` and the discovered `disabledPluginIds`. It also supplies the
read-only manuscript-discussion `INSTRUCTIONS` through the default collaboration
mode, and disables inheriting thread permission defaults. Those instructions
forbid commands, browsing, edits, service contact and unrelated actions.
Manuscript files, selection and answer quotations are admitted through the
owner's supported named `additionalContext` entry with `kind: untrusted`. The
visible question stays plain; full bounded source material remains available
to the model. The old response-item/question-wrapper route remains historical
0.9.4 behavior, not the new submission shape.

These turn constraints do **not** physically remove all tools from Desktop's
running service, and its tool catalog must not be described as identical to the
isolated server's. Model, collaboration and permission settings can persist on
this shared conversation, so a later Desktop turn may inherit its read-only
settings. No global configuration or other conversation is changed. This
integration is for manuscript Q&A, not general automation or arbitrary editing.

## Model discovery and defaults

The browser sends `status` when Codex Assistant settings opens. The native host
uses `account/read` and `model/list`; it does not start a thread or submit model
inference. Model IDs, display names and supported reasoning efforts are kept
through the browser transport, so choosing a model narrows the effort selector
to that model's advertised options. An already-saved unsupported effort is
shown as unavailable rather than silently rewritten.

The browser coalesces concurrent catalogue requests and caches a successful
result in page memory for five minutes. A status request waits until an active
answer finishes, because the host handles one operation at a time. Loading,
connection errors and retry controls appear in settings without replacing the
user's unsaved draft. Check connection forces a refresh. This cache is not
persisted across page reloads.

“Follow Codex” leaves the browser's model or effort override unset. A private
app-server turn uses the local Codex configuration's default; a Desktop-owner
turn reads that conversation owner's current model and reasoning effort. An
explicit extension setting overrides the corresponding default. Both Codex routes
use the local Codex account/provider and its normal limits; they require no
separate extension API key or subscription. Optional API connections instead
use the saved profile model and credentials and hide the Codex model/effort
controls. Their metadata refresh also preserves unsaved project settings.

## Protocol

Every Chrome message is a 4-byte little-endian length followed by UTF-8 JSON.
The host serializes ordinary operations; cancellation and validated steering remain responsive while
a question is running. Disconnecting the native port terminates its dedicated
app-server process group and closes its Desktop follower connection. A question
already accepted by Desktop may continue there; closing the native port does not
terminate Desktop or replay that question.

Requests have `version: 1`, a bounded `id`, and `op`. The optional `providerId`
is a saved profile UUID; omission keeps the existing Codex route. Asking,
status and history operations carry this identity consistently, and a mismatched
`settings.providerId` is rejected. API operations do not fall through to Codex.

The project transport supports:

- `status`: inspect the local connection and login; returns available models.
  This does not start a conversation or consume a model turn.
- `ask`: includes `projectId`, optional `accountId`, `question`, optional
  `selection`, `answerQuote`, `files`, and `settings`. Optional `expectedConversationId` is a
  registered UUID or `null` for a new conversation; a mismatch with the active
  binding is rejected before model execution. Optional `expectedSyncRevision`
  is the 64-character lowercase hexadecimal revision returned by a current
  history read; it is checked before and after acquiring the private writer, or
  again after discovering the Desktop owner. Omitting
  these expectation fields preserves older request syntax, while active/unknown
  remote state and unavailable owner routing still reject a question. Selection fields are `path`, `text`, `from`, `to`,
  `startLine`, `endLine`, `before`, and `after`. Character offsets are JavaScript
  UTF-16 offsets, not Python code-point counts. Optional `answerQuote` has
  `{text: string, messageId?: string}`; its message identity is provenance for
  the earlier answer, not a path or a remote-thread selector. The nonempty text
  permits at most 64,000 UTF-16 units and rejects NUL or isolated surrogates;
  an optional ID must match `[A-Za-z0-9_.:-]{1,300}`. Operations other than ask/steer reject
  `answerQuote`, and additional fields inside it are rejected.
- `steer`: accepts the same bounded question, selections, quotations, files and
  settings as `ask`, requires `expectedConversationId` and `expectedTurnId`, and
  rejects custom API routing. It is admitted only for this host’s active
  conversation, using strict expected-turn delivery for the independent route
  or the validated Desktop owner’s current-reply semantics. It returns `steered`
  with the actual confirmed thread/turn and a stable `userMessageId`; it never
  sends a second `turn/start`.
- `cancel`: acknowledge the control request and interrupt the current turn. The
  original ask receives its own terminal event, retaining partial answer text.
- `new-chat`: clear only the active pointer; retain the conversation catalog.
- `history-list`: list the current scope's conversations, with optional `cursor`
  and `limit` (1–50; default 30).
- `history-read`: read a registered `conversationId`, or the active conversation
  if omitted, with optional `cursor` and `limit`. The first page contains the
  newest messages in chronological order. `nextCursor` reads the preceding
  page; the client prepends that page. A cursor is bound to its scope and thread.
- `history-select`: requires a registered `conversationId`, changes the active
  pointer and returns its latest display page. It accepts no cursor/limit, does
  not resume a thread or start a model turn, and is rejected while another
  operation is busy.

Terminal events are delivered after the project lock and busy state are released,
so a subsequent operation submitted immediately from the callback can start.
Events echo `id` and use `type: status | started | delta | done | error | history | profiles | steered`.
`status` includes `available`, `authenticated`, `models`, and `message`.
Each model includes `id`, `displayName`, and supported `efforts` when supplied
by Codex. `started` includes `threadId`; `delta` includes incremental `text`;
`done` includes final `text`, optional `threadId` and `cancelled`/`reset` flags;
`error` includes a bounded `message`.

`history` returns `activeConversationId` (UUID or `null`), optional
`conversationId`, `conversations`, `messages` and `nextCursor`. Catalog entries
contain `id`, `title`, `createdAt`, `updatedAt` (epoch milliseconds), `current`
and `messageCount`. Display messages contain `messageId` (a stable local ID such
as `m123`), `role`, `text` and optional `selection` or `answerQuote` on user
messages; both may appear together. No raw Codex reasoning, tool
items or project-file payloads cross this interface. A latest-page read/select
also includes `remoteState: idle | active | unknown` and a 64-character
`syncRevision` covering turn content and active/final state. Older-page reads do
not independently establish the latest remote state. `idle` confirms a finished
persisted turn, not that another process has released its writer. Each history page stays below 700000 encoded UTF-8 JSON bytes.
Unusually large or heavily JSON-escaped stored messages are returned as adjacent
fragments, preserving their complete text across pages. Cursors are limited to
4096 characters. UUIDs outside the current scope and cross-thread cursors are rejected.

Limits: 4 MiB native input, 16,000 question characters, 64,000 selection
characters, 64,000 UTF-16 units per answer quote, 16,000 characters of context on either side, legacy inline inputs of 64 files / 240,000 characters (new project mode instead
uploads complete snapshots of at most 2,000 text files, 2 MiB each, 16 MiB total), 8,000 project-instruction characters,
and 450,000 UTF-8 bytes of answer output. Combined `selection` and `answerQuote`
metadata is limited to 560,000 UTF-8 bytes of compact JSON to leave room for a
fully escaped question in one native history page. RPC calls time out after 45 seconds;
the Desktop submission confirmation has a 40-second method timeout plus the router’s separate ten-second owner-discovery allowance. Independent steering confirmation has a twenty-second limit; Desktop steering has a thirty-five-second method limit plus its router discovery allowance. A model turn's
local observation is bounded to ten minutes; a Desktop-owned turn can still be
running after that timeout. Overlong input is rejected rather than
silently truncated. App-server stdout is parsed as JSON-RPC; its raw stderr and
authentication payload are never sent to the browser.

Provider management requests share protocol version 1 but have a separate
browser admission boundary: `provider-list` has no profile argument;
`provider-save` carries `profile: {id?, name, baseUrl, model, apiKey?}`;
`provider-delete` and `provider-test` require `providerId`. They reject project
or chat payloads. The `profiles` event returns sanitized `profiles` metadata and
an optional status `message`. Only the management page may issue mutations or
checks. The Overleaf project transport admits the read-only list and never
receives saved keys. A pending mutation is not retried after disconnect.

## Verification and compatibility

Run the synthetic tests without installing, signing in, or invoking a model:

```sh
/usr/bin/python3 -m unittest discover -s native/tests -v
```

The tests cover framing, malformed and oversized requests, relative paths,
account/project isolation, concurrent project locks, unknown account behavior,
streaming, cancellation, failed resume, new-chat boundaries, and confined
installation. A separate read-only check on this Mac confirmed `initialize`,
`account/read` and `model/list` against Codex CLI `0.166.0-alpha.5.1`, reporting
a signed-in ChatGPT account and eight catalog models. That check did not create
a thread or perform inference.

The JSON-RPC shapes were checked against schemas generated by this installed
CLI, including `thread/start`, `thread/resume`, `turn/start`,
`item/agentMessage/delta`, `item/completed` and `turn/completed`. Codex app-server
is experimental; changes to the installed CLI may need adapter updates.
See the [official app-server documentation](https://learn.chatgpt.com/docs/app-server).
A real model smoke check then used an isolated temporary project/account and
only synthetic text. It produced six streamed deltas and the exact final marker
`OPT_CODEX_SMOKE_OK`; the one test conversation was archived afterward. The
dedicated native host was registered successfully. These checks cover the
native client through Codex inference. A subsequent real Overleaf browser check successfully completed connection/model
listing and a synthetic question through the native pipe, including mathematical
rendering. It used selection-only context with no selection, then restored the
project setting and reset the test conversation.

For 0.8.2, TypeScript, 484 browser-side unit tests across 39 files, and the
production build passed. Chrome interaction with the synthetic development
fixture verified automatic discovery, first-attempt failure and retry, supported
efforts, preserved unsaved instructions, and a 127-formula simulated stream.
This exercises the browser UI and mocked transport, not a new native inference
check. See the [fixture acceptance record](../dev/README.md#082-browser-fixture-acceptance).
After reloading 0.8.2, opening Codex settings in the actual Overleaf editor
reported “Connected to local Codex” and listed eight models plus Follow Codex,
without pressing Check connection. Temporarily selecting `gpt-6.1-sol` in the
unsaved draft showed Default, Low, Medium, High, Extra high, Maximum and Ultra;
the draft was then returned to its original Follow Codex value without saving.
This is a current real browser-to-native model-list check. No new inference
request was sent in this live check, and the existing conversation was neither
reset nor replaced. Earlier real inference evidence above remains historical.
The [live-page record](../dev/README.md#082-live-overleaf-check) also distinguishes
current UI/history rendering checks from synthetic streaming tests.


### 0.9 native history and workspace checks

The 0.8.2 browser and inference acceptance records above remain historical; they
are not evidence of a new 0.9 model run. On 2026-10-31, all 62 native tests passed
(48 Codex tests including history/workspace coverage, plus 14 existing TeX-host
tests). These synthetic tests cover legacy-pointer migration, retained new-chat
history, account/project isolation, rejection before RPC of unknown threads,
expected-conversation races, latest/older pagination, complete large and
JSON-escaped output, quote recovery, final-only imports, offline cached reads,
disconnected partial answers, terminal callback re-entry, database permissions,
workspace installation, project lookup and configuration preservation.

A read-only check of the one already registered Overleaf thread recovered four
display messages with both original user selections into a temporary private
mirror; the returned page was 52944 encoded bytes. It used the installed
app-server's paginated history API, submitted no model turn, and left the
production history files untouched. The temporary mirror was removed afterward.

At the user's request, the existing thread was assigned through
`thread/metadata/update` to the already existing Overleaf backend project
identified by its exact workspace root. A fresh app-server process then read
back the expected `projectId`, confirming that assignment persisted. The
thread's historical `cwd` remained the private helper directory: an unloaded
thread rejected `thread/settings/update`, so this check does not claim its old
working directory was rewritten. Configured future start/resume requests use
the selected Overleaf workspace. The installer resolved the same existing
backend project via `project/list`, without creating a project or conversation.
No Codex database or rollout file was edited directly.


### 0.9.1 native synchronization and ownership checks

All 72 native tests passed (58 Codex tests, 14 TeX-host tests). New synthetic
coverage exercises plain desktop questions, same-second partial/final updates,
stable message IDs across refresh and reload, new tail turns, completed-message
edits, fresh writer context containing desktop turns, busy-turn rejection,
unchanged scoped bindings, and revision changes during the resume window. It
also verifies offline cached history returns `unknown`, unknown scope is rejected
before RPC, writer conflicts are not retried or stolen, and failures after
ownership acquisition close only the helper's server without starting inference.

A separate two-client test used one newly created synthetic paginated thread
with no model turn or real manuscript content. Client B could read it while A
owned it. After A's successful `thread/unsubscribe`, B's resume still returned
an active-writer conflict. Once A's process closed, B could resume the same
thread. Both clients were then closed and the synthetic thread was archived
through the official API. This confirms the ownership boundary; it does not
claim that merely finishing a desktop answer releases its writer. No real
conversation was modified or used for inference during these 0.9.1 checks.

### 0.9.4 Desktop adapter checks

The Desktop transport's 16 synthetic socket tests passed. They exercise honest
client identity, exact method versions, capability gating, same-user endpoint
and peer checks, thread/owner/recipient filtering, snapshot identity validation,
owner disconnection, exact-turn cancellation, and unknown submission outcomes
without replay. These tests use fake local peers and perform no model inference.

A separate read-only check against the currently installed Desktop successfully
initialized as `overleaf-personal-tools`, discovered the owner of the already
registered Overleaf conversation with `supportsUntrustedAppInput: true`, and
received its scoped snapshot. It sent no turn, changed no settings and closed
only its follower socket. This verifies discovery and read access on this Mac;
it does not by itself establish successful model submission through the new
route. Earlier inference checks and the 0.9.1 writer-conflict check above remain
historical evidence for their respective paths.

Subsequent real inference checks used one separate temporary conversation with
synthetic source text and a separate helper history directory. Desktop retained
the writer throughout. Overleaf's native request entered that same conversation,
remembered a preceding token, and returned a streamed answer with 20 deltas.
A plain Desktop-side turn then changed the token; the next Overleaf request
correctly recalled the new value. A further request carried a new editor
selection, a deliberately stale copy of that file, and a second project file
through the untrusted context route. The answer returned the current selection's
value and the second file's value exactly. The temporary conversation was
archived through the application API afterward. No question was sent to the
user's manuscript conversation and no manuscript was edited.

The existing Chrome 0.9.3 client is protocol-compatible with this backend change.
On this Mac, the installed helper was updated and the live project's connection
was closed and reopened through its enable setting without reloading the page.
The UI reported `Connected to local Codex`; its six existing messages, unsent
draft and current answer quotation remained. The 0.9.4 extension package is
also built, but that live check does not claim Chrome reloaded its manifest.
Detailed automated counts and acceptance scope are in
[`dev/README.md`](../dev/README.md#094-acceptance).


### 0.10.0 API verification scope

The release passed 618 frontend tests across 46 files, 161 native tests,
TypeScript and production build checks. API coverage uses synthetic profiles,
fake HTTP peers and mocked browser transports for credential isolation,
management admission, profile/account/project history separation, bounded
responses, streaming, cancellation and no-replay behavior. The installed helper's
four Python modules were checked against source. No real API credentials or
manuscript were submitted for these tests.

Browser access was disabled for this release's new API work. There is no new
visual/live Overleaf acceptance or real-provider inference claim. The synthetic
manager fixture is available for a later browser check; historical live Codex
checks above do not establish API-provider compatibility. See the release scope
in [`dev/README.md`](../dev/README.md).


### 0.11.0 verification scope

Read-only diagnosis on this Mac found a valid current Codex login and eight
catalogue models, and could read the registered chat's paginated history. Desktop
initialization responded promptly; owner discovery returned no owner after its
ten-second lookup, while an ordinary same-thread resume reported an active
writer. This establishes a live ownership/coordination problem, not a failed
login. It is consistent with the reported account/window transition but does
not prove that switching accounts alone caused it. No manuscript question was
submitted for that diagnosis.

Opening that same registered chat through the official Codex navigation route
restored its accessible Desktop owner. A subsequent read-only check found the
owner immediately and read its model settings. Thus the affected ownership
connection was recovered without submitting a manuscript question or model
inference. This does not establish that every future account switch preserves
an accessible owner automatically.

The frontend release check passed 646 tests in 48 files, TypeScript and the
production build. Native account-transition, steering and compact-display
coverage is recorded separately in `dev/README.md`; these automated checks do
not establish new live inference or browser layout acceptance. Browser-tool access remained disabled
and controlling the ChatGPT app itself was unavailable, so this record does not
claim live browser layout acceptance, enabling the user's browser permission,
or a new inference turn in the recovered writer-owned chat. Historical real
inference checks above retain their original version and scope.

## 0.11.2 context admission and rejected-send recovery

The runtime validates the inner `additionalContext` entry's `name` against
`[a-z][a-z0-9_]{0,63}`. `Overleaf project context` was invalid; the helper now
uses `overleaf_project_context`. The project map key is opaque, but is also
normalized to `overleaf_manuscript_<lowercase project ID>` for consistency.
A real installed-Codex test with a loopback fake Responses provider reproduced
the old rejection before any provider call; the fixed name completed and the
provider received selection, project-file and answer-quote markers. These were
ephemeral synthetic threads, without reading account credentials or documents.

Independent `turn/start` user-history insertion now follows a confirmed turn
ID. Typed received JSON-RPC admission errors (-32600/-32602 before a turn exists)
can emit `notAccepted: true`. The page rolls back only pre-dispatch or explicitly
rejected, unaccepted optimistic messages; partial output or a started event
prevents rollback. Timeouts and unknown outcomes remain uncertain, never replayed.
Existing historic ghost rows and Codex rollout logs are not rewritten.

Queued promotion persists a sending marker before steering. A turn that ends
before dispatch returns the item to a paused queue. Missing/uncertain acknowledgement
holds it for review; it cannot be resumed as an unsent message. The busy-message
preference is independent browser storage, never an additional model-setting field.

## Complete manuscript context (0.12.0)

The previous single additionalContext value was silently truncated by the local
Codex runtime to approximately 4,000 UTF-8 bytes, retaining only its head and
tail. This was reproduced in the failed manuscript chat and identified in the
installed runtime; changing model output limits does not repair it. The static
64-file/80,000-character-per-file selection also provided no way to retrieve
omitted text. Both limitations are superseded for project-mode questions.

source-begin admits a complete path/UTF-8-byte-count/SHA-256 manifest; sequential
source-chunk messages upload exact content with byte offsets; source-commit
verifies all files and publishes an immutable snapshot. ask/steer carry its
64-hex snapshotId. Upload operations do not change active conversation ownership
and can prepare follow-ups while a turn runs. The native host validates each
reference against the Overleaf account/project scope before model admission.
Only the frozen current editor buffer overlays a fresh ZIP; stale buffers from
previously visited tabs cannot overwrite newly exported collaborative content.

The local overleaf_project MCP has only list_project_files, search_project and
read_project_file. It reads a named snapshot, never arbitrary filesystem paths.
All results explicitly paginate, including within a long TeX line. The short
model context supplies the snapshot reference, root metadata and quotations;
large quotation envelopes use independently encoded fragments below 3,600 UTF-8
bytes with a current manifest and SHA-256 group identity. Visible question text
remains short in both clients. Desktop continuations read the same saved version;
later Overleaf edits are synchronized by the next explicit send/queue/steer.

Installation registers the reader in Codex and records its registration time.
The old Desktop process cannot be refreshed by sending reload to a different
private app-server. Snapshot turns held by a Desktop IPC session predating the
registration are blocked before submission and request a one-time Desktop
restart. This is a conservative startup gate, not a tool-inventory proof for
the owner; the private reader catalogue and actual model retrieval are verified
separately. The Desktop route retains its existing shared-runtime boundary.

API mode exposes the same three functions, accepts only the request's snapshot
ID, and supports streamed function arguments and bounded tool rounds. Unsupported
function calling and reader failures are reported explicitly. No silent static
context fallback, account credential transfer, document write or automatic
question retry is introduced.

## API whole-manuscript review budget (native 0.12.11)

The API loop allows 64 lookup rounds and 128 tool requests, with a separate terminal answer request using `tool_choice: none`. Immutable source remains in the read-only store. Identical normalized requests reference earlier results; three rounds without new lookups stop further reading. The 1,400,000-byte request envelope retains a 16,000-byte reserve, and the overall 580-second deadline reserves 60 seconds for synthesis. Limits trigger a visible partial-coverage notice and a grounded final answer rather than claiming a complete review. Auth/network errors and cancellation do not automatically retry the question. Model context capacity may be lower than the local byte cap.

Validated with 131,412 bytes across four synthetic TeX files: actual DeepSeek reached all file ends and found three seeded end-of-file errors. A deliberately reduced two-round budget produced an honest partial review with tools disabled in the third request. No personal manuscript was used for those API tests.

### User-configurable budget (0.12.12)

API project-context settings expose optional integer fields `apiMaxReadRounds` (1–256, default 64), `apiMaxToolCalls` (1–512, default 128), and `apiTimeoutSeconds` (90–580, default 580). Missing fields retain the defaults; explicit invalid values are rejected at transport/native boundaries. Only API requests with matching provider identities can carry these overrides. The frontend saves committed valid numbers on blur, preserves invalid drafts without persisting them, and explains that higher limits may increase API requests, token usage, costs and latency. Settings are captured with each request, including queued requests; changing them does not alter an active reply. The existing final-answer pass, 60-second reserve, duplicate detection and input-size limits still apply.

These overrides apply only when reading a project snapshot. Selection-only replies keep the existing 580-second deadline even if the project retains a shorter reading budget for future project-context messages. Locale changes preserve unfinished numeric drafts and validation messages without saving them prematurely.
