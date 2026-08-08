import * as assert from "node:assert";

import { estimateMemoryTokens, humanScopeLabel, renderMemoryManagerHtml } from "../ui/memory-manager";
import type { SharedMemoryEntry } from "../memory/types";

function entry(overrides: Partial<SharedMemoryEntry> = {}): SharedMemoryEntry {
	return {
		id: "entry-1",
		title: "Test memory",
		content: "Some durable context about the project workflow.",
		tags: ["build", "workflow"],
		kind: "other",
		scope: "workspace",
		scopeId: "file:///d%3A/GitHub/llama-vscode-chat",
		pinned: false,
		createdAt: "2026-08-08T10:00:00.000Z",
		updatedAt: "2026-08-08T11:00:00.000Z",
		...overrides,
	};
}

suite("memory manager panel", () => {
	test("estimates context tokens from active entries only", () => {
		const active = entry({ title: "Hello", content: "world" });
		const expired = entry({ id: "expired-1", title: "Old", content: "gone", expiresAt: "2020-01-01T00:00:00.000Z" });
		// ceil((5 + 5) / 4) = 3
		assert.strictEqual(estimateMemoryTokens([active]), 3);
		assert.strictEqual(estimateMemoryTokens([active, expired]), 3);
		assert.strictEqual(estimateMemoryTokens([]), 0);
	});

	test("renders entries with badges, tags, and token estimates", () => {
		const html = renderMemoryManagerHtml({
			entries: [
				entry({ title: "Global rule", scope: "global", pinned: true, kind: "preference", tags: ["rules", "memory"] }),
				entry({ id: "expired-1", title: "Old", expiresAt: "2020-01-01T00:00:00.000Z" }),
			],
		});
		assert.match(html, /Global rule/);
		assert.match(html, /preference/);
		assert.match(html, /global/);
		assert.match(html, /workspace/);
		assert.match(html, /pinned/);
		assert.match(html, /expired/);
		assert.match(html, /class="tag">rules/);
		assert.match(html, /~[0-9.k]+ tokens/);
		assert.match(html, /id="new-btn"/);
		assert.match(html, /id="open-file-btn"/);
		assert.match(html, /class="btn danger delete-btn"/);
		assert.match(html, /2 entries/);
		assert.ok(!html.includes('</script><script>'));
	});

	test("renders the edit form for an existing entry and for a new one", () => {
		const existing = renderMemoryManagerHtml({ entries: [entry()], editingId: "entry-1" });
		assert.match(existing, /Edit memory entry/);
		assert.match(existing, /id="fm-title"/);
		assert.match(existing, /value="Test memory"/);
		assert.match(existing, /id="fm-kind"/);
		assert.match(existing, /id="fm-scope"/);
		assert.match(existing, /id="fm-tags"/);
		assert.match(existing, /value="build, workflow"/);
		assert.match(existing, /id="fm-save"/);

		const fresh = renderMemoryManagerHtml({ entries: [], editingId: "new" });
		assert.match(fresh, /New memory entry/);
		assert.match(fresh, /id="fm-cancel"/);
	});

	test("formats workspace scope labels as readable project paths", () => {
		assert.strictEqual(humanScopeLabel("global", undefined), "global");
		assert.strictEqual(humanScopeLabel("workspace", "file:///d%3A/GitHub/llama.cpp-with-GUI"), "d:/GitHub/llama.cpp-with-GUI");
		assert.strictEqual(humanScopeLabel("workspace", undefined), "workspace");
	});

	test("marks entries of other projects and renders filter chips", () => {
		const current = "file:///d%3A/GitHub/llama-vscode-chat";
		const html = renderMemoryManagerHtml({
			entries: [
				entry({ title: "Mine", scope: "workspace", scopeId: current }),
				entry({ id: "other-1", title: "Foreign", scope: "workspace", scopeId: "file:///d%3A/GitHub/llama.cpp-with-GUI" }),
				entry({ id: "global-1", title: "Shared", scope: "global", scopeId: undefined }),
			],
			currentWorkspaceScopeId: current,
		});
		assert.match(html, /data-scope="current"/);
		assert.match(html, /data-scope="other"/);
		assert.match(html, /data-scope="global"/);
		assert.match(html, /other project/);
		assert.match(html, /workspace:d:\/GitHub\/llama\.cpp-with-GUI/);
		assert.match(html, /data-filter="all"/);
		assert.match(html, /data-filter="global"/);
		assert.match(html, /data-filter="current"/);
		assert.match(html, /data-filter="other"/);
	});

	test("warns when editing an entry that belongs to another project", () => {
		const html = renderMemoryManagerHtml({
			entries: [
				entry({ id: "other-1", title: "Foreign", scope: "workspace", scopeId: "file:///d%3A/GitHub/llama.cpp-with-GUI" }),
			],
			editingId: "other-1",
			currentWorkspaceScopeId: "file:///d%3A/GitHub/llama-vscode-chat",
		});
		assert.match(html, /belongs to another project/);
	});

	test("escapes untrusted entry text inside the embedded page", () => {
		const html = renderMemoryManagerHtml({
			entries: [entry({ title: "x</script><script>bad()</script>", content: "<b>bold</b> & more" })],
		});
		assert.ok(!html.includes("<script>bad()</script>"));
		assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt; &amp; more"));
		assert.ok(html.includes("&lt;/script&gt;"));
	});
});
