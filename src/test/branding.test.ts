import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

suite("AI Agent Bridge branding", () => {
	const root = path.resolve(__dirname, "..", "..");
	const manifest = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8")
	) as {
		name: string;
		publisher: string;
		displayName: string;
		version: string;
		repository: { url: string };
		contributes: {
			languageModelChatProviders: Array<{ vendor: string; displayName: string }>;
			viewsContainers: { activitybar: Array<{ title: string }> };
			configuration: {
				title: string;
				properties: Record<string, {
					default?: unknown;
					minimum?: number;
					description?: string;
				}>;
			};
			commands: Array<{ title: string; category?: string }>;
		};
	};

	test("uses the new product name while preserving compatibility ids", () => {
		assert.strictEqual(manifest.displayName, "AI Agent Bridge");
		assert.strictEqual(manifest.name, "llama-vscode-chat");
		assert.strictEqual(manifest.publisher, "mrlordcat");
		assert.strictEqual(manifest.contributes.languageModelChatProviders[0].vendor, "llamacpp");
		assert.strictEqual(manifest.contributes.languageModelChatProviders[0].displayName, "AI Agent Bridge");
		assert.strictEqual(manifest.contributes.viewsContainers.activitybar[0].title, "AI Agent Bridge");
		assert.strictEqual(manifest.contributes.configuration.title, "AI Agent Bridge");
		assert.strictEqual(manifest.repository.url, "https://github.com/MrLordCat/ai-agent-bridge.git");
	});

	test("brands every contributed command consistently", () => {
		for (const command of manifest.contributes.commands) {
			assert.match(command.title, /^AI Agent Bridge:/);
			if (command.category) {
				assert.strictEqual(command.category, "AI Agent Bridge");
			}
		}
	});

	test("keeps Claude model segments uncapped by default", () => {
		const setting = manifest.contributes.configuration.properties["llamacpp.claudeMaxAgentTurns"];
		assert.ok(setting);
		assert.strictEqual(setting.default, 0);
		assert.strictEqual(setting.minimum, 0);
		assert.match(setting.description ?? "", /0 to disable/i);
	});

	test("keeps the main README release and development facts current", () => {
		const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
		assert.match(readme, /^# AI Agent Bridge for VS Code/m);
			assert.ok(readme.includes("**Stable release: 1.14.3. Current local development build: 1.14.13.**"));
		assert.match(readme, /415 extension-host tests/);
		assert.match(readme, /Patch v22/);
		assert.doesNotMatch(readme, /Local LLM Chat Provider|Local LLM:|Stable release: 1.9.0|283 extension-host tests|Patch v16/);
	});
});
