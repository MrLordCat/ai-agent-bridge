import * as assert from "node:assert";
import * as vscode from "vscode";

import { ApiProviderService } from "../api-providers/api-provider-service";
import { ProviderDirectory, type ProviderDirectoryOptions } from "../providers/provider-directory";
import {
        ApiProviderManagerPanel,
        renderApiProviderManagerHtml,
        type ApiProviderManagerRenderState,
} from "../ui/api-provider-manager";

class MockSecretStorage implements vscode.SecretStorage {
        private secrets = new Map<string, string>();
        get(key: string): Thenable<string | undefined> {
                return Promise.resolve(this.secrets.get(key));
        }
        store(key: string, value: string): Thenable<void> {
                this.secrets.set(key, value);
                return Promise.resolve();
        }
        delete(key: string): Thenable<void> {
                this.secrets.delete(key);
                return Promise.resolve();
        }
        keys(): Thenable<string[]> {
                return Promise.resolve(Array.from(this.secrets.keys()));
        }
        onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;
}

class MockMemento implements vscode.Memento {
        private store = new Map<string, unknown>();
        keys(): readonly string[] {
                return [...this.store.keys()];
        }
        get<T>(key: string): T | undefined {
                return this.store.get(key) as T | undefined;
        }
        update(key: string, value: unknown): Thenable<void> {
                this.store.set(key, value);
                return Promise.resolve();
        }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
                if (predicate()) {
                        return;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("condition not reached within " + timeoutMs + "ms");
}

class FakeWebviewPanel {
        messageHandler: ((message: unknown) => Promise<void>) | undefined;
        readonly webview = {
                html: "",
                onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
                        this.messageHandler = handler;
                        return { dispose() {} };
                },
                postMessage: async () => true,
                asWebviewUri: (uri: unknown) => uri,
                cspSource: "",
        };
        private disposeHandler: (() => void) | undefined;
        onDidDispose = (handler: () => void) => {
                this.disposeHandler = handler;
                return { dispose() {} };
        };
        reveal(): void {}
        dispose(): void {
                this.disposeHandler?.();
        }
}

function directoryOptions(): ProviderDirectoryOptions {
        return {
                getSecret: async () => undefined,
                getConfigValue: () => undefined,
                getApiProfiles: async () => [],
                probeIntervalMs: 0,
        };
}

function baseState(overrides: Partial<ApiProviderManagerRenderState> = {}): ApiProviderManagerRenderState {
        return {
                profiles: [],
                providers: [],
                editingId: undefined,
                status: "",
                error: "",
                ...overrides,
        };
}

function htmlScript(html: string): string {
        const match = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
        assert.ok(match, "webview script block must be present");
        return match[1];
}

// Fake panel plumbing is exercised with a real ApiProviderService and
// ProviderDirectory, driving the actual handleMessage path.
async function withPanel<T>(body: (fake: FakeWebviewPanel, service: ApiProviderService) => Promise<T>): Promise<T> {
        const service = new ApiProviderService(new MockMemento(), new MockSecretStorage());
        const directory = new ProviderDirectory(directoryOptions());
        const fake = new FakeWebviewPanel();
        const originalCreate = vscode.window.createWebviewPanel;
        const originalWarn = vscode.window.showWarningMessage;
        (vscode.window as unknown as { createWebviewPanel: unknown }).createWebviewPanel = () => fake;
        (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async () => "Delete";
        try {
                ApiProviderManagerPanel.createOrShow(service, directory, () => undefined);
                assert.ok(fake.messageHandler, "webview message handler must be registered");
                return await body(fake, service);
        } finally {
                (vscode.window as unknown as { createWebviewPanel: unknown }).createWebviewPanel = originalCreate;
                (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = originalWarn;
        }
}

suite("Providers Manager webview", () => {
        test("delete removes the profile and re-renders the list", async () => {
                await withPanel(async (fake, service) => {
                        const profile = await service.upsert({
                                name: "Cloudflare",
                                baseUrl: "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
                                protocol: "openai",
                                family: "auto",
                                contextLength: 131072,
                                enabled: true,
                        }, { apiKey: "sk-test" });
                        await fake.messageHandler!({ type: "refreshModels" });
                        await waitFor(() => fake.webview.html.includes("Cloudflare"));
                        assert.ok(fake.webview.html.includes("key saved"), "key badge must render");

                        await fake.messageHandler!({ type: "delete", id: profile.id });
                        await waitFor(() => !fake.webview.html.includes(">Cloudflare<"));
                        assert.strictEqual(service.get(profile.id), undefined, "profile must be removed from storage");
                        assert.ok(!fake.webview.html.includes(">Cloudflare<"), "deleted card must not render");
                        assert.ok(fake.webview.html.includes("Deleted Cloudflare"), "status must show the deletion");
                });
        });

        test("preset change reveals the Cloudflare account id field (script wiring)", () => {
                const html = renderApiProviderManagerHtml(baseState({ editingId: "new" }));
                const script = htmlScript(html);
                assert.ok(script.includes("syncAccountField();"), "account sync must be invoked");
                assert.ok(html.includes('id="provider-account"'), "account input must be present");
        });

        test("rendered script parses without syntax errors (list view)", () => {
                const html = renderApiProviderManagerHtml(baseState());
                new Function(htmlScript(html));
        });

        test("rendered script parses without syntax errors (new-provider form open)", () => {
                const html = renderApiProviderManagerHtml(baseState({ editingId: "new" }));
                new Function(htmlScript(html));
        });

        test("rendered script parses while editing an existing profile", () => {
                const html = renderApiProviderManagerHtml(baseState({
                        editingId: "prof-1",
                        profiles: [{
                                id: "prof-1",
                                name: "Cloudflare",
                                baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
                                protocol: "openai",
                                family: "auto",
                                contextLength: 131072,
                                enabled: true,
                                hasApiKey: true,
                                createdAt: "2026-08-19T00:00:00.000Z",
                                updatedAt: "2026-08-19T00:00:00.000Z",
                        }],
                }));
                new Function(htmlScript(html));
        });

        test("form renders the preset select and the Cloudflare account id field", () => {
                const html = renderApiProviderManagerHtml(baseState({ editingId: "new" }));
                assert.ok(html.includes('id="provider-preset"'), "preset select must be present");
                assert.ok(html.includes('id="provider-account-wrap"'), "account id field must be present");
                assert.ok(html.includes("Cloudflare Workers AI"), "cloudflare preset must be listed");
                assert.ok(html.includes("OpenRouter"), "openrouter preset must be listed");
        });
});
