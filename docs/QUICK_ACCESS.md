# Quick Access

Quick Access is the extension's control tree. The root keeps Providers Manager,
API profile cards, built-in providers, Token Usage, experiments, agents, model
behavior, memory, diagnostics and patch controls in their existing order.

Provider cards show connection and provider-specific actions. API cards also
show live metrics belonging to that exact saved source. Token Usage contains
Today and Last 7 Days for every recorded category, including API profiles.
API history is aggregated; current context and throughput remain per profile.

The common metrics renderer uses Tokens (live/last), Prompt Cache, Context and
Throughput when available. Estimated counters keep their estimate marker.
A missing counter remains unreported instead of being displayed as zero.

Coco has its own Tokens, Prompt Cache and Context usage rows and Token Usage
history category. The context row uses the last measured window when available.
Its input and cache counters come from ACP prompt results, including history
imports; they are not inferred from context occupancy or session reuse.

Cursor SDK usage appears on its saved API profile and in the aggregate API
history category. Session Diagnostics distinguishes Cursor from Claude, shows
new/warm/restored mode and separates fresh input, cache reads and cache writes.
Native Cursor input already includes cache reads/writes; the adapter counts
them once and checks SDK totals for the known duplicate-cache representation.
First cold starts are labelled separately from failed session reuse. A warm
session does not itself prove a server cache hit. Older aggregates are retained.
No SDK context-occupancy counter is inferred from cumulative billed tokens.
Details and verification: [Cursor continuity](CURSOR_CONTINUITY.md).

Supported account balances load in the background. The tree displays profile
metadata and cached values immediately, then updates after the request finishes.
Cached values carry a refresh hint. Provider cache TTL and the existing minute
timer control refreshes. Missing balance endpoints are briefly cached to avoid
render loops. Cursor has no balance or budget row and makes no billing requests;
its chat credentials do not grant the required Admin API access.

Each render captures provider snapshots once. Child expansion reads the
already-built tree and does not fetch accounts again. Empty child arrays are
leaf rows without a misleading expansion arrow. A profile-read failure leaves
the other root sections usable and marks Providers as unavailable.

The current visibility policy is preserved: unavailable built-in providers
are hidden until they recover, while Coco keeps its reconnect controls.
API profiles remain inspectable with their state. Model selection is available
from Models by Provider; reasoning controls remain in the native model picker.

The last root group, **AI Agent Bridge**, shows the installed version, the last
update check with the latest stable release, Check for Updates, Install Update
or Reload Window when an update applies, and the Automatic Updates mode.
`ExtensionUpdater` owns the check state in global storage, so every window shows
the same last check; one window at a time downloads and installs.

Implementation boundaries:

- `quick-access-items.ts`: TreeItem identity, icons and shared metric rows.
- `quick-access.ts`: section composition, captured state and provider controls.
- `ApiProviderService`: cached profile metadata and background account requests.
- `ProviderSnapshot` / `ProviderRuntimeMetrics`: source-owned data.

The [audit](QUICK_ACCESS_AUDIT.md) records the findings and implemented fixes.