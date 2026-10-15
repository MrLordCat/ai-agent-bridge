# Development and release workflow

CI and tagged releases call `.github/workflows/verify.yml`, so both paths run
the same metadata checks, lint and extension-host tests. The matrix covers
Windows/Linux on VS Code 1.131.0 (minimum supported API) and 1.141.0 (current
integration baseline). Node 22 is used for tooling and the Cursor SDK.
All matrix tests must pass before Windows x64 and Linux x64 VSIX packaging.

For local verification run `npm run check:metadata`, `npm run lint` and
`npm test`. To test the second host explicitly, run
`npm test -- --code-version 1.141.0`. Provider, cache, transport and delegated
tool contract suites are part of the full extension-host test suite.

After deleting or renaming TypeScript sources, run `npm run clean` before
testing. Compilation does not remove old JavaScript files from `out/`, so a
stale compiled test can otherwise exercise a feature that has been removed.

Local development changes increment only the patch version in package.json
and both root entries in package-lock.json. Update README's Current build and
CHANGELOG. Compile, package and install through `code --install-extension`;
verify the installed version and `source: vsix`, then reload the window.
Development patches do not automatically create Git tags or GitHub Releases.

A stable release requires an explicit release request. Prepare the requested
version and docs/RELEASE_NOTES.md before tagging. The release workflow rejects
a mismatching tag, lockfile or release-notes heading, and publishes only after
all tests and both platform packages succeed. Only the publication job has
repository write permission. The existing stable-release.sh helper remains
the explicit tagging/push entry point.

CI runs can also be started manually from GitHub Actions. Superseded CI runs
are cancelled; release runs are not cancelled by a newer run. Build artifacts
are retained for seven days. Publishing never runs for an ordinary CI build.