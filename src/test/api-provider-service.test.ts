import * as assert from "node:assert";
import * as vscode from "vscode";

import { ApiProviderService } from "../api-providers/api-provider-service";

class MockSecretStorage implements vscode.SecretStorage {
	private readonly values = new Map<string, string>();
	readonly onDidChange = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;

	get(key: string): Thenable<string | undefined> {
		return Promise.resolve(this.values.get(key));
	}

	store(key: string, value: string): Thenable<void> {
		this.values.set(key, value);
		return Promise.resolve();
	}

	delete(key: string): Thenable<void> {
		this.values.delete(key);
		return Promise.resolve();
	}

	keys(): Thenable<string[]> {
		return Promise.resolve([...this.values.keys()]);
	}
}

class MockMemento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.values.has(key) ? this.values.get(key) as T : defaultValue;
	}

	update(key: string, value: unknown): Thenable<void> {
		this.values.set(key, value);
		return Promise.resolve();
	}
}

suite("API provider service", () => {
	test("stores profile metadata globally and API keys only in SecretStorage", async () => {
		const state = new MockMemento();
		const secrets = new MockSecretStorage();
		const service = new ApiProviderService(state, secrets);

		const created = await service.upsert({
			name: "OpenRouter",
			baseUrl: "https://openrouter.ai/api/v1/",
			protocol: "openai",
			family: "auto",
			contextLength: 200_000,
			enabled: true,
		}, { apiKey: "secret-value" });

		assert.strictEqual(created.baseUrl, "https://openrouter.ai/api/v1");
		assert.strictEqual(service.count, 1);
		assert.ok(!JSON.stringify(state.get("llamacpp.apiProviders.v1")).includes("secret-value"));

		const summaries = await service.listSummaries();
		assert.strictEqual(summaries[0].hasApiKey, true);
		const sources = await service.getModelSources();
		assert.deepStrictEqual(sources[0], {
			key: `api-${created.id}`,
			label: "OpenRouter",
			serverUrl: "https://openrouter.ai/api/v1",
			apiKey: "secret-value",
			familyOverride: "auto",
			contextLengthOverride: 200_000,
			protocol: "openai",
		});

		service.dispose();
	});

	test("preserves an existing key on ordinary edits and deletes it with the profile", async () => {
		const state = new MockMemento();
		const secrets = new MockSecretStorage();
		const service = new ApiProviderService(state, secrets);
		const created = await service.upsert({
			name: "Gateway",
			baseUrl: "https://example.com/v1",
		}, { apiKey: "keep-me" });

		await service.upsert({
			...created,
			name: "Gateway Renamed",
			enabled: false,
		});
		assert.strictEqual((await service.listSummaries())[0].hasApiKey, true);
		assert.strictEqual((await service.getModelSources()).length, 0);

		assert.strictEqual(await service.remove(created.id), true);
		assert.strictEqual(service.count, 0);
		assert.strictEqual((await secrets.keys()).length, 0);
		service.dispose();
	});

	test("validates URLs and duplicate provider names", async () => {
		const service = new ApiProviderService(new MockMemento(), new MockSecretStorage());
		await assert.rejects(
			service.upsert({ name: "Bad", baseUrl: "file:///tmp/provider" }),
			/http:\/\/ or https:\/\//
		);
		await service.upsert({ name: "One", baseUrl: "https://one.example/v1" });
		await assert.rejects(
			service.upsert({ name: "one", baseUrl: "https://two.example/v1" }),
			/already exists/
		);
		service.dispose();
	});
});
