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

Account balances and Cursor budgets load in the background. The tree displays
profile metadata and cached values immediately, then updates after the request
finishes. A new Cursor budget displays Checking while loading; cached values
carry a refresh hint. Provider cache TTL and the existing minute timer control
refreshes. Missing balance endpoints are briefly cached to avoid render loops.

Each render captures provider snapshots once. Child expansion reads the
already-built tree and does not fetch accounts again. Empty child arrays are
leaf rows without a misleading expansion arrow. A profile-read failure leaves
the other root sections usable and marks Providers as unavailable.

The current visibility policy is preserved: unavailable built-in providers
are hidden until they recover, while Coco keeps its reconnect controls.
API profiles remain inspectable with their state. Model selection is available
from Models by Provider; reasoning controls remain in the native model picker.

Implementation boundaries:

- `quick-access-items.ts`: TreeItem identity, icons and shared metric rows.
- `quick-access.ts`: section composition, captured state and provider controls.
- `ApiProviderService`: cached profile metadata and background account requests.
- `ProviderSnapshot` / `ProviderRuntimeMetrics`: source-owned data.

The [audit](QUICK_ACCESS_AUDIT.md) records the findings and implemented fixes.