# AI Agent Bridge 1.14.1 — release notes

Hotfix release. The 1.14.0 storefront advertised **Manage API Providers** in
the README and Quick Access, but the command was declared in `package.json`
and never registered in the extension host — the button silently did nothing.
This release makes the advertised feature actually work, plus two storefront
fixes.

## 1. Manage API Providers now works

- `llamacpp.openApiProviders` is now registered and opens the API Provider
  Manager panel (`ApiProviderManagerPanel`).
- The profile service (`ApiProviderService`) is wired into model discovery via
  the provider's `getApiModelSources` hook, so saved/enabled profiles
  contribute their models to the VS Code model picker — not just to the
  manager UI.
- Toggling, saving, or deleting a profile refreshes the model catalog
  automatically instead of requiring a manual "Refresh models" click.

Scope note (unchanged from the README): the multi-endpoint flow is implemented
and unit-tested, but has not yet been field-tested end-to-end against real
third-party OpenAI-compatible gateways.

## 2. Storefront fixes

- **Architecture diagram rebuilt.** Source-box widths now derive from measured
  text (no more overflowing labels), all source arrows join a vertical bus
  that connects into the central "AI Agent Bridge" block, and the connector to
  the VS Code block reaches its edge without crossing any text. The
  generating function is fixed in `scripts/generate-brand-assets.py`.
- **README badges are now links**: the release badge opens the latest GitHub
  Release, the license badge opens `LICENSE`, and the CI badge opens the
  workflow runs page.

## Verification

- 396 extension-host tests passing (VS Code 1.131, Windows).
- Lint and TypeScript compilation clean.
- GitHub Actions CI and Release workflows green for this tag.
