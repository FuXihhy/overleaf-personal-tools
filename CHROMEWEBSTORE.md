# Chrome Web Store preparation record

Last updated: 2026-11-06

## Distribution status

The current distribution is **GitHub source and an unpacked extension**, not a Chrome Web Store listing. No store submission, approval, publisher certification, or store-assigned extension ID is claimed. Public GitHub visibility does not by itself make a Web Store listing or grant an open-source license.

Repository: [FuXihhy/overleaf-personal-tools](https://github.com/FuXihhy/overleaf-personal-tools)

User documentation: [README](README.md), [installation](docs/installation.md), [usage](docs/usage.md), [data and permissions](docs/privacy.md).

Release history is maintained in [CHANGELOG.md](CHANGELOG.md). Historical acceptance documents retain their original platform/version scope. Windows real-page evidence does not stand in for macOS acceptance or a new user's installation.

## Proposed product description

**Name:** Overleaf Personal Tools

**Single purpose:** Assist manuscript work in Overleaf with project-aware command completion, formula preview, and explicitly requested manuscript questions within the editor.

The extension integrates LaTeX Preview and Codex Assistant into Overleaf's existing settings. It supports the English and Chinese Overleaf sites, follows the site language/theme, and provides Code/LaTeX Visual interactions. Preview can use packaged MathJax, a dedicated Overleaf cloud workspace, or a separately installed sandboxed local TeX helper. Questions use a separately installed native helper with the user's existing Codex configuration or an explicitly selected compatible API connection.

This is an independent integration. Product names and artwork must not imply endorsement by Overleaf, OpenAI, or an API provider. A Web Store publication still requires a separate review of distributable artwork, listing assets, and brand presentation.

## Current manifest and permissions

Minimum Chrome version: 145. Manifest V3. Stable unpacked extension ID: `pffppbkokpnfafpechmlambifflkmbbn`. The manifest `key` is a public key used to stabilize this identity, not a private signing key or account credential.

| Declaration | Purpose and scope |
| --- | --- |
| `storage` | Persist project preferences, bounded display history and follow-up queues, workspace bindings, and cache lifecycle coordination metadata. No Chrome Sync. |
| `nativeMessaging` | Connect the user-installed assistant/API and TeX helpers. Instant/cloud preview do not require the helpers. |
| `alarms` | Wake the service worker for project-page reconciliation and safe temporary-source cleanup after the grace period. No model requests are scheduled by these alarms. |
| `host_permissions`: `https://www.overleaf.com/project/*`, `https://cn.overleaf.com/project/*` | Obtain relevant tab URL visibility for cache-page reconciliation. Content-script injection remains matched to project paths; host-permission path syntax must not be described as a path-level security boundary for all Chrome APIs. |
| Content scripts on the same two project patterns | Read editor and project text for completion, preview and user-requested questions; add the settings and assistant UI. |
| Web-accessible resources on the two Overleaf origins | Packaged renderers, PDF fonts and UI images required by the editor integration. |

There is no `tabs`, `history`, `cookies`, clipboard or all-sites permission. Cached page identity is checked using the trusted extension sender, top-level frame, browser-owned document identity, source URL/origin, and account/project scope. API requests originate in the native helper, not through added service-provider host permissions.

## Data inventory

| Data | Processing / storage | Off-device use |
| --- | --- | --- |
| Manuscript content and source positions | Browser analysis; optional validated native project snapshots and retained read-only mirrors; quoted selections in history | Cloud preview sends formula/preamble/dependencies to the user's Overleaf workspace. Submitted questions send chosen context to the selected Codex service or API. |
| Questions, answers and selected answer quotations | Bounded browser display cache and native histories; Codex keeps its normal conversation records | Chosen model service processes submitted questions and continuation context. API histories remain separate from Codex Desktop. |
| Account/project identifiers and preferences | Local scope bindings, coordination state, file metadata and hashes | Existing Overleaf operations use the same account/project context; no email is used as the scope key. |
| Authentication | Existing Overleaf session and transient same-origin CSRF token; Codex owns its login; API key in a restricted native file | API key authenticates requests only to its selected endpoint; redirects are not followed. No account-password collection or copied Codex credentials. |
| Queue and source-retention state | Up to eight queued items within 1 MiB, including captured references/context and settings; paused after reload | Only explicit submission/resume advances queued questions. Cleanup alarms do not send inference requests. |

The project has no publisher backend, analytics or advertising endpoint. It must not claim that all content stays on the device. An API `/models` probe sends no manuscript or question and is not a completed-inference test.

## Retention and controls

Preview-only text snapshots and PDF render caches remain in page memory. Cloud preview text remains in the dedicated Overleaf project; deleting current files does not promise erasure from Overleaf history.

Browser display history has a 60-message/350000-character budget, including quotations. Native assistant/API histories are stored separately; creating a new conversation, removing an API connection, and uninstalling a helper do not erase them. Removing an API connection deletes its saved key. Credentials are private local JSON with POSIX permissions or Windows current-user/SYSTEM ACLs, not application-encrypted storage or an OS credential vault.

On-demand project snapshots are eligible for cleanup only after verified page departure, the grace period and completion of protected work. Queued, active or uncertain requests retain their snapshots. Legacy and explicitly retained versions are not implicitly downgraded or deleted by switching modes. Explicit source cleanup checks current revision and ownership, removes only that scope's source, and leaves chat history and Overleaf originals intact. No unified erase-all control is claimed.

Users can disable features, choose selection-only context, remove quotations/queue items, manage API profiles, inspect/clear project source, and uninstall each component. Stopping a local request cannot guarantee remote processing or billing has stopped. Full locations and controls are documented in [docs/privacy.md](docs/privacy.md).

## Remaining work before any store submission

- Verify the final listing, screenshots and distributable artwork for the submitted version.
- Supply a publisher-approved public privacy contact and final privacy-policy URL; the repository data explanation is available, but no dashboard certification is inferred from it.
- Confirm the current dashboard data-use declarations, distribution regions and publisher account details.
- Test a clean store-installed build. If its extension ID differs, update the exact `allowed_origins` of both native host registrations; do not add wildcard origins.
- Explain clearly that installing the extension alone does not install Python, native helpers, Codex or TeX Live. macOS and Windows use distinct isolation/registration implementations.

No publication action or attestation is performed by maintaining this document.
