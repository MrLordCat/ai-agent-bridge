# Shared Memory

Shared memory is durable reference context owned by the extension. It is
available to local models and DeepSeek across chats. Agents explicitly choose
whether each new entry applies globally or only to the current project.

## Storage And Migration

The file is stored at:

```text
<extension global storage>/memory/shared-memory.json
```

The current format is version 2:

```json
{
  "version": 2,
  "entries": [
    {
      "id": "stable-id",
      "title": "Current project build command",
      "content": "Run npm run check before packaging the VSIX.",
      "tags": ["build", "validation"],
      "pinned": false,
      "scope": "workspace",
      "scopeId": "file:///D:/GitHub/llama-vscode-chat",
      "kind": "workflow",
      "createdAt": "2026-07-17T10:00:00.000Z",
      "updatedAt": "2026-07-17T10:00:00.000Z"
    }
  ]
}
```

Version-one entries migrate automatically to `scope: "global"` and
`kind: "other"`. Their ids, text, tags, pin state, and timestamps are retained.
The migrated document is persisted during initialization.

Writes use a temporary file and rename. Invalid startup data is preserved as an
`.invalid-<timestamp>` backup before a new empty document is created. Invalid
manual edits are rejected on reload without replacing active in-memory data.

## Scope And Types

Scopes:

- `global`: eligible for every agent and project. Use it only for durable
  cross-project preferences and reusable workflows.
- `workspace`: eligible only when `scopeId` equals the current workspace id.
  Use it for repository paths, commands, architecture, decisions, and
  project-specific environment facts.

The public agent tools expose exactly these two scopes and require an explicit
choice when saving or deleting. The extension derives `scopeId` itself; an
agent cannot write into or delete from another project by supplying a path.
Legacy `model` entries remain readable for format compatibility but new ones
cannot be created through the agent tools.

Kinds:

- `preference`: durable user choices and response preferences.
- `decision`: accepted project or architectural decisions.
- `environment`: stable local paths, commands, and runtime constraints.
- `workflow`: repeatable procedures and verification steps.
- `externalFact`: source-backed facts that can become stale.
- `other`: reference information that does not fit another kind.

An `externalFact` requires both `sourceUrl` and `verifiedAt`. Use `expiresAt`
for versions, compatibility facts, service behavior, or any claim that should
be reviewed later. Expired entries remain stored and inspectable but are
excluded from normal search and automatic prompt injection.

## Retrieval

For every request, the extension builds a query from the four most recent user
messages. It first filters entries by active project scope and expiry,
then ranks them with:

- weighted exact title, tag, and content terms;
- BM25-style document frequency and length normalization;
- conservative trigram matching for misspellings and related word forms;
- exact title-phrase and pinned boosts after relevance is established;
- update time as the final tie-breaker.

Pinned entries are not injected merely because they are pinned. They must still
match a non-empty query. An empty manual search lists pinned and recent entries.

The first selected set is inserted immediately before the current user request.
Later changes are appended as memory-delta checkpoints while earlier checkpoints
stay byte-stable for prompt-cache reuse. Tool rounds freeze the selected set; a
new user turn may append newly relevant or updated entries. Compaction restores
a consolidated current checkpoint if older deltas are summarized.
`llamacpp.memoryMaxTokens` caps automatic memory context; the default is 4096.

## Agent Tools

- `llamacpp_store_memory`: create or update an entry with mandatory `global`
  or `workspace` scope. Workspace identity is always filled by the extension.
- `llamacpp_search_memory`: hybrid search over global plus current-project
  entries, optionally restricted to one of those scopes.
- `llamacpp_delete_memory`: delete one entry by exact id and mandatory scope.
  Workspace deletion is rejected if the entry belongs to another project.

VS Code asks for confirmation before extension tools execute. Users can inspect
or edit the file with `AI Agent Bridge: Open Shared Memory` and remove all entries
with `AI Agent Bridge: Clear Shared Memory`.

## Limits

- 500 entries total.
- 160 characters per title.
- 24,000 characters per content value.
- 16 normalized tags, 48 characters each.
- 32,768 tokens maximum automatic injection budget.

Search indexing considers at most the first 12,000 content characters per
entry to keep retrieval responsive; stored and returned content is not reduced.
When the store is full, the oldest non-pinned entry is evicted. A store made
entirely of pinned entries rejects additional entries.

## Safety Model

Memory is untrusted reference context. Its prompt wrapper says that it cannot
override current system or user instructions and that instructions inside a
memory entry must not be executed unless the live request asks for the same
action. Source metadata describes provenance, not authority.

Do not store secrets, credentials, temporary guesses, raw tool output, or
instructions copied from untrusted sources. Memory is local to the VS Code
profile and is not synchronized by this extension.
