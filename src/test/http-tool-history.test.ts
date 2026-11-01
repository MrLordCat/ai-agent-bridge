import * as assert from "node:assert";
import * as vscode from "vscode";
import { prepareHttpToolHistory } from "../providers/http-tool-history";
import { convertMessages, validateRequest } from "../utils";

const user = vscode.LanguageModelChatMessage.User, assistant = vscode.LanguageModelChatMessage.Assistant;
const call = (id: string) => new vscode.LanguageModelToolCallPart(id, "read_file", { path: `${id}.txt` });
const result = (id: string) => new vscode.LanguageModelToolResultPart(id, [new vscode.LanguageModelTextPart(`${id} output`)]);

suite("HTTP tool history", () => {
	test("continues an interrupted cross-provider chat without inventing tool results", () => {
		const pending = call("interrupted");
		const messages = [user("task"), assistant([pending]), user("continue"), assistant([call("complete")]), user([result("complete")])];
		assert.throws(() => validateRequest(messages));
		const normalized = prepareHttpToolHistory(messages);
		assert.doesNotThrow(() => validateRequest(normalized.messages));
		assert.strictEqual(normalized.interruptedCalls, 1);
		assert.strictEqual(normalized.detachedResults, 0);
		assert.strictEqual(messages[1].content[0], pending, "the shared transcript is not changed");
		const quoted = normalized.messages[1].content[0] as vscode.LanguageModelTextPart;
		assert.match(quoted.value, /Execution status is unknown/);
		assert.match(quoted.value, /interrupted.txt/);
		const wire = convertMessages(normalized.messages, { toolResultMode: "tool" });
		assert.strictEqual(wire.filter(message => message.role === "tool").length, 1);
		assert.strictEqual(wire.filter(message => message.tool_calls?.length).length, 1);
	});

	test("preserves completed parallel calls while quoting missing and detached results", () => {
		const image = vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), "image/png");
		const messages = [assistant([call("one"), call("missing"), call("two")]),
			user([result("one"), new vscode.LanguageModelToolResultPart("unrelated", [image]), result("two")]),
			user("continue")];
		const normalized = prepareHttpToolHistory(messages);
		assert.doesNotThrow(() => validateRequest(normalized.messages));
		assert.strictEqual(normalized.interruptedCalls, 1);
		assert.strictEqual(normalized.detachedResults, 1);
		assert.deepStrictEqual(normalized.messages[0].content.filter(part => part instanceof vscode.LanguageModelToolCallPart).map(part => part.callId), ["one", "two"]);
		assert.ok(normalized.messages.some(message => message.content.includes(image)), "detached result images survive");
	});

	test("splits result batches from steering text and preserves a live result tail", () => {
		const completed = result("one");
		const messages = [assistant([call("one")]), user([completed, new vscode.LanguageModelTextPart("stop this task")])];
		const normalized = prepareHttpToolHistory(messages);
		assert.doesNotThrow(() => validateRequest(normalized.messages));
		assert.strictEqual(normalized.messages[1].content[0], completed);
		assert.strictEqual((normalized.messages[2].content[0] as vscode.LanguageModelTextPart).value, "stop this task");
		const live = prepareHttpToolHistory([assistant([call("one")]), user([completed])]);
		assert.strictEqual(live.interruptedCalls + live.detachedResults, 0);
		assert.strictEqual(live.messages.at(-1)?.content[0], completed);
	});

	test("quotes duplicate results and results beyond an intervening user request", () => {
		const messages = [assistant([call("one")]), user("new request"), user([result("one"), result("one")])];
		const normalized = prepareHttpToolHistory(messages);
		assert.doesNotThrow(() => validateRequest(normalized.messages));
		assert.strictEqual(normalized.interruptedCalls, 1);
		assert.strictEqual(normalized.detachedResults, 2);
		assert.ok(normalized.messages.flatMap(message => message.content).every(part => !(part instanceof vscode.LanguageModelToolResultPart)));
	});
});
