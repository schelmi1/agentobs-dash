# Architecture

agentobs ports the local Codex Session Observer VS Code extension into
a standalone Node HTTP server and browser client. It has no runtime dependencies.

1. `bin/agentobs.js` accepts a monitored root, persistent initialization, transcript
   stores, and timing settings. `lib/config.js` resolves the root and loads
   optional `.agentobs/dashboard.json` settings. CLI options override saved ones.
2. `lib/harnesses/index.js` registers the coding harnesses. Each harness is one
   module: `codex.js` or `copilot.js`, owning storage discovery, parsing, safe
   reduction, and a cache per observer instance. The registry supplies storage
   defaults, validation/persistence keys, CLI flags/help and adapter construction.
   Existing `sessionRoots`/`copilotRoots` settings and CLI flags remain compatible.
   `lib/observer.js` aggregates their normalized scans without provider branches.
   `lib/harness-runner.js` owns concurrent deadlines, cooperative cancellation and
   quarantine of unfinished scans; `lib/observation-coverage.js` retains unavailable
   source observations without confusing healthy deletions with read failures.
   Recorded workspace paths are canonicalized and checked against the root using
   path boundaries. Quiet status is reevaluated even for cached transcripts.
   Shared policy copies sessions before annotating them. See
   the harness interfaces in `lib/harnesses/`.
3. `lib/harnesses/codex.js` and `lib/tool-details.js` retain the extension's lifecycle,
   fork boundaries, token usage, safe tool summaries, and completion evidence.
   `lib/hierarchy.js` groups related fragments by provider-qualified explicit ancestry and builds
   run-scoped agent trees. Inferred paths cannot merge established runs. Parent
   paths are indexed once and cycle classification is memoized before depth limits.
   Task timestamps distinguish original assignment, local follow-ups and reassignment.
   `lib/live-map-model.js` derives cards, history groups, and descendant totals.
   Failed/interrupted runs enter inactive history after 15 minutes without
   activity; quiet runs enter their own collapsed section after 30 minutes.
   Quiet families stay separate from inactive history, and any live descendants
   keep their ancestor context in the live view.
   Codex uses append offsets and bounded lifecycle reducer state. File signatures
   and prefix/tail guards detect rotation, truncation, and ordinary compaction. Partial last lines are tolerated, broken files counted,
   directory symlinks skipped, and internal guardian rollouts excluded. There is
   one async discovery path; aging remains in the shared observer/model.
   `lib/harnesses/copilot.js` discovers VS Code workspace storage, replays chat mutations,
   and joins transcript events with diagnostic spans by session ID. It emits the
   same session model, with provider-qualified IDs, explicit subagent edges and
   deduplicated per-call token accounting. Raw tool data is reduced before the
   model is exposed. Projected chat mutations replay only new records; unchanged
   workspaces reuse summaries. Pending calls, explicit child links and usage
   survive display-history trimming. `lib/ingestion.js` owns bounded append reads,
   reset detection, deferred-read priority, and separate parser/display-summary budgets; `lib/limits.js` defines configurable
   file/record/state/agent/depth/frame limits. `lib/json-lines.js` handles JSONC.
4. `lib/server.js` serves an explicit asset allowlist, `GET /api/snapshot`, and
   `GET /api/events` (server-sent events). One shared polling loop scans for all
   tabs; concurrent refreshes share a scan. The server binds only to loopback,
   checks Host/Origin, and sends a restrictive content security policy.
   `lib/wire-model.js` serializes protocol v2 with one agent table and child/root
   IDs, avoiding recursive payload duplication. `public/snapshot.js` validates
   and hydrates shared browser objects. Health includes scan sequence, per-harness
   status, observer instance identity and last success; safe named SSE events report whole-scan failures.
   Failed adapters/sources retain marked-stale summaries while healthy providers
   continue. Late or duplicate HTTP/SSE frames cannot replace newer observations.
5. `public/browser-host.js` owns SSE/reconnection state, workspace selection,
   overview metrics and transport/freshness state. Workspace member IDs are
   separate from ancestor context IDs, so scoped totals match the picker. `public/preferences.js`
   validates and persists browser selections, including malformed storage recovery. It passes a scoped model through
   an in-page event to `public/live-map.js`, the adapted map renderer. The renderer
   retains keyed DOM nodes, inspector details, and keyboard focus across updates.
   `public/selectors.js` holds pure filtering and hierarchy helpers; `public/dom.js`
   owns reconciliation; `public/agent-views.js` owns card/inspector views. History
   cards are constructed only for open sections and expanded live branches,
   preserving selected inspection. The Modern renderer presents workspaces as
   cards or compact networks, with per-workspace zoom, sizing, and tool activity.
   `public/modern.css` defines the workspace layout; `public/themes.css` and
   `public/theme-shapes.css` define visual treatments. `public/appearance.js`
   defines the theme and palette catalogs and migrates older saved preferences.
   `public/color-themes/index.js` supplies the color catalog.
   `public/status.js` maps observation diagnostics to severity and plain-language
   reasons and owns the accessible Status dropdown. Its open state and scroll
   position survive observation updates.

`test/modern-transcript-playwright.js` exercises synthetic transcripts through
both the server and browser. The Modern, multi-workspace, hierarchy, and theme
browser tests cover live updates, selection, responsive layouts, and graph
navigation. `test/appearance.test.js` checks preference migration and contrast.

Transcript content stays in memory. The observer stores no transcript copies;
`init` persists only configuration. Tasks and assistant progress are compact
visible excerpts. Tool arguments and outputs are reduced to approved numeric
and fixed-label summaries before reaching the API. Browser preferences contain
UI state, not transcript histories.

The observer supports Codex and local VS Code Copilot Chat files. It does not use process probes,
install hooks into agents, control sessions, or discover arbitrary providers.
An unfinished transcript can be quiet while the agent is still alive. Local
read access to the transcript stores is required. Polling enumerates configured
stores with explicit capacity/IO budgets; Codex favors recent date paths and
reserves file capacity per store. Agent limits apply after root scoping. Cold
scans can be incomplete or slow and report limits; append readers and unchanged
workspace summaries avoid repeated parsing/replay. Prefix/tail guards assume
append-only logs between ordinary rotation/compaction events.

`scripts/copilot-demo.js` writes clearly labeled synthetic sessions to a dedicated
`.agentobs/copilot/workspaceStorage` store, never a real VS Code profile.
`test/copilot.test.js` covers mutation replay, file replacement, root scoping,
partial writes, deduplication, hierarchy and lifecycle. `test/copilot-playwright.js`
checks the real Copilot observer/SSE/browser path, including mixed providers,
token updates, failure/retry, completion/resume, themes and mobile layouts.
`test/harnesses.test.js` exercises the common scan contract for each harness,
missing/disabled stores, lifecycle changes, snapshot ownership, and an injected
third harness using shared scoping, aging and concurrent-scan coalescing.

`test/production.test.js` verifies fault isolation, contracts, append/reset and
resource semantics, linear wire growth, malformed preferences and pure layout.
`test/production-playwright.js` verifies health and stale-state recovery over real
HTTP/SSE plus lazy history. CI runs Node 22/24, selected browser flows and offline
package installation; scheduled/manual CI runs the full appearance matrix.

Protocol v2, resource defaults and operational limits are defined in the server and ingestion modules. Actual Copilot captures remain unavailable: sanitizing export and
checkpoint tests are provided, but verified real-format coverage is explicitly
skipped and Copilot remains best effort.

`public/inspector.js` owns details-panel focus and modal interaction. The shared
760 px breakpoint selects a contained modal panel on narrow screens; desktop
details stay fixed beneath the measured header. Both use one flexible scrolling
body. Chamfered paints focus and selection inside its clipped surfaces. The
Modern network supports per-workspace graph navigation and resizing.
