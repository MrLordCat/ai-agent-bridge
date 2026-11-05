import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	ChatMarkdownLinkStream,
	sanitizeChatMarkdown,
	type LinkResolver,
} from "../providers/markdown-links";

const ROOT = process.platform === "win32" ? "D:\\proj" : "/proj";
const R2 = `${ROOT}\\R2_PERFORMANCE_RECOVERY.md`;
const REPORT = `${ROOT}\\docs\\report.md`;
/** Behaves like the real resolver: absolute, relative and bare names all match. */
const resolver: LinkResolver = candidate => {
	const normalized = candidate.trim().replace(/\\/g, "/").toLowerCase();
	if (normalized === "r2_performance_recovery.md" || normalized.endsWith("/r2_performance_recovery.md")) {
		return R2;
	}
	if (normalized === "docs/report.md" || normalized.endsWith("/docs/report.md")) {
		return REPORT;
	}
	return undefined;
};

const fileLink = (label: string, absolute: string): string =>
	`[${label}](${vscode.Uri.file(absolute).toString()})`;

suite("Chat markdown links", () => {
	test("a placeholder link becomes a real file link when the label names a file", () => {
		const text = "Done: [R2_PERFORMANCE_RECOVERY.md](http://_vscodecontentref_/1).";
		assert.strictEqual(
			sanitizeChatMarkdown(text, resolver),
			`Done: ${fileLink("R2_PERFORMANCE_RECOVERY.md", `${ROOT}\\R2_PERFORMANCE_RECOVERY.md`)}.`
		);
	});

	test("a placeholder link with an unknown label becomes plain code, not a broken link", () => {
		assert.strictEqual(
			sanitizeChatMarkdown("See [the summary](http://_vscodecontentref_/3) now.", resolver),
			"See `the summary` now."
		);
		assert.strictEqual(
			sanitizeChatMarkdown("[missing.md](http://_vscodecontentref_/2)", resolver),
			"`missing.md`"
		);
	});

	test("the mangled file URL produced by the chat view is repaired", () => {
		// Exactly the URL reported by the user, percent-decoded by the link handler.
		const mangled = "file:///d%3A/%5BR2_PERFORMANCE_RECOVERY.md%5D%28http%3A/_vscodecontentref_/1%29";
		assert.strictEqual(
			sanitizeChatMarkdown(`[R2_PERFORMANCE_RECOVERY.md](${mangled})`, candidate =>
				candidate === "R2_PERFORMANCE_RECOVERY.md" ? `${ROOT}\\R2_PERFORMANCE_RECOVERY.md` : undefined
			),
			fileLink("R2_PERFORMANCE_RECOVERY.md", `${ROOT}\\R2_PERFORMANCE_RECOVERY.md`)
		);
	});

	test("relative and Windows destinations are resolved through the workspace", () => {
		assert.strictEqual(
			sanitizeChatMarkdown("[report](docs/report.md)", resolver),
			fileLink("report", `${ROOT}\\docs\\report.md`)
		);
		assert.strictEqual(
			sanitizeChatMarkdown("[report](D:\\proj\\docs\\report.md)", resolver),
			fileLink("report", `${ROOT}\\docs\\report.md`)
		);
	});

	test("an absolute file that no longer exists stops being a link", () => {
		const missing = "file:///D%3A/proj/deleted.md";
		assert.strictEqual(sanitizeChatMarkdown(`[deleted.md](${missing})`, resolver), "`D:/proj/deleted.md`");
	});

	test("remote links, anchors and data URIs are untouched", () => {
		const text = [
			"[release](https://example.com/release)",
			"[section](#usage)",
			"![chart](data:image/png;base64,AAAA)",
			"[docs](https://example.com/a)",
		].join(" ");
		assert.strictEqual(sanitizeChatMarkdown(text, resolver), text);
	});

	test("a bare placeholder is removed from prose", () => {
		assert.strictEqual(
			sanitizeChatMarkdown("Attached: http://_vscodecontentref_/7 here.", resolver),
			"Attached:  here."
		);
	});

	test("an image with a placeholder destination becomes its label", () => {
		assert.strictEqual(
			sanitizeChatMarkdown("![screenshot](http://_vscodecontentref_/9)", resolver),
			"`screenshot`"
		);
	});

	test("plain text is returned without work", () => {
		const text = "No links here, only prose and a [bracket].";
		assert.strictEqual(sanitizeChatMarkdown(text, resolver), text);
	});
});

suite("Chat markdown link stream", () => {
	const collect = (chunks: readonly string[]): string => {
		const stream = new ChatMarkdownLinkStream(resolver);
		let output = "";
		for (const chunk of chunks) {
			output += stream.push(chunk);
		}
		return output + stream.flush();
	};

	test("a link split across deltas is rewritten as one link", () => {
		const text = "Done [R2_PERFORMANCE_RECOVERY.md](http://_vscodecontentref_/1).";
		const expected = sanitizeChatMarkdown(text, resolver);
		assert.strictEqual(collect([text.slice(0, 9), text.slice(9, 30), text.slice(30)]), expected);
		// One character per delta is the worst case.
		assert.strictEqual(collect([...text]), expected);
	});

	test("ordinary prose is released immediately", () => {
		const stream = new ChatMarkdownLinkStream(resolver);
		assert.strictEqual(stream.push("First line.\nSecond "), "First line.\nSecond ");
		assert.strictEqual(stream.push("line."), "line.");
		assert.strictEqual(stream.flush(), "");
	});

	test("a dangling bracket at the end of a turn is still delivered", () => {
		const stream = new ChatMarkdownLinkStream(resolver);
		// The prose before a possible link start is released; only the bracket waits.
		assert.strictEqual(stream.push("List item [1"), "List item ");
		assert.strictEqual(stream.flush(), "[1");
	});

	test("a partial placeholder is held until it is complete", () => {
		const stream = new ChatMarkdownLinkStream(resolver);
		assert.strictEqual(stream.push("See [file](http://_vscodecontent"), "See ");
		assert.strictEqual(
			stream.push("ref_/4) now."),
			"`file` now."
		);
		assert.strictEqual(stream.flush(), "");
	});
});
