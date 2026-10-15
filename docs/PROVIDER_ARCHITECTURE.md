# Provider architecture

The extension keeps the VS Code vendor and persisted model IDs stable while
separating source identity, model metadata and execution protocol.

| Component | Responsibility |
|---|---|
| `ProviderRegistry` | Model ownership, catalog aggregation and change propagation |
| `ProviderSourceDefinition` | Source ID, label, status mode and enabled setting |
| `ModelDescriptor` | VS Code metadata and bounded input/output limits |
| `ProviderSnapshot` | Source status, runtime metrics and typed usage |
| `AsyncResourceCache` | TTL, shared loads, invalidation generations and consumer cancellation |
| `ApiSourceRouter` | API-profile discovery, responses, counting and lifecycle dispatch |
| `DelegatedTurnState` | Response boundaries, buffered output and terminal completion |
| `PendingToolRegistry` | Exactly-once delivery and settlement of native tool callbacks |

Register a subscription transport in the composition root with a source
definition, a VS Code provider and an ownership predicate. Composite routing,
the directory and model grouping consume these registrations. Quick Access
can render a generic snapshot; integrations can provide extra controls.
API-profile transports use `ApiSourceAdapter`; HTTP request policies remain
inside the HTTP implementation, and Cursor SDK uses its own adapter.

Model adapters supply their native ID, capabilities, context origin and output
policy to `modelInformation`. Reasoning values and wire parameter names remain
protocol-specific. A working cap cannot increase a model's reported window.

Use source IDs for runtime metrics. Family names describe model behavior and
must not determine the account billed for a request. Persisted usage history
retains its existing categories and adds a separate API category.
`spendingCap`, `monthlyUsage`, `creditsBalance` and `rollingQuota` have different
meanings; format their typed values without treating them as interchangeable.

Resource invalidation retires the old entry before aborting its loader. Late
responses cannot publish into a newer entry. Cancelling an individual reader
detaches that reader; source refresh or disposal owns shared cancellation.
Catalog cache identities include a credentials revision or a private digest.

Cursor and Coco use the shared response boundary and output buffer. Claude
and Codex use the shared pending registry while retaining their long-lived
runtime lifecycle and recovery. Protocol adapters own result serialization,
batch timing, timeout policy, usage events and delivery of steered messages.
All delegated actions continue to execute through VS Code Chat tools.

Contract suites cover registry extension, metadata and source attribution,
cache generations and cancellation, transport dispatch and delegated results.
Protocol suites still verify native tool calls, images and session recovery.
See [the implementation plan](UNIFICATION_PLAN.md) for validation results.

The [Quick Access guide](QUICK_ACCESS.md) describes the current UI/data
boundaries and its audit. [Development workflow](DEVELOPMENT_WORKFLOW.md)
documents shared CI/release gates and the two-version compatibility matrix.