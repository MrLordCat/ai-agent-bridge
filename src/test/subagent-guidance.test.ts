import * as assert from "assert";

import {
	buildSubagentToolGuidance,
	enhanceSubagentToolDescription,
	getSubagentModelProfiles,
	setSubagentModelProfiles,
	withRequiredSubagentModel,
} from "../subagent-guidance";

suite("subagent model guidance", () => {
	test("explains native model inheritance and preferred routing profiles", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder",
			label: "Qwen 3 Coder",
			provider: "local",
			useWhen: "Narrow economical tasks",
		}]);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro",
			label: "DeepSeek V4 Pro",
			provider: "deepseek",
			defaultEffort: "high",
			useWhen: "Focused complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "gpt-5.6-codex",
			label: "GPT-5.6 Codex",
			provider: "codex",
			defaultEffort: "high",
			useWhen: "Repository-wide work",
		}]);

		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes('model="DeepSeek V4 Pro", high thinking'));
		assert.ok(guidance.includes('model="GPT-5.6 Codex", high thinking'));
		assert.ok(guidance.includes("Budget routing policy"));
		assert.ok(guidance.includes("Never omit runSubagent.model"));
		assert.ok(guidance.includes("agentName selects behaviour/custom instructions independently of model"));
		assert.ok(guidance.includes('set runSubagent.model to one of the quoted model= strings'));
		assert.ok(guidance.includes('Copy the exact string inside the quotes'));
		assert.ok(guidance.includes("one bounded, independently verifiable task"));
		assert.ok(guidance.includes("explicit allowed files"));
		assert.ok(guidance.includes("expected output"));
	});

	test("augments only subagent tool descriptions", () => {
		assert.ok(enhanceSubagentToolDescription("runSubagent", "Run an agent").includes("Subagent model routing"));
		assert.strictEqual(enhanceSubagentToolDescription("read_file", "Read a file"), "Read a file");
	});

	test("requires an explicit model in subagent schemas without mutating the host definition", () => {
		const original = {
			name: "runSubagent",
			inputSchema: {
				type: "object",
				properties: { description: { type: "string" } },
				required: ["description"],
			},
		};
		const routed = withRequiredSubagentModel(original);
		const schema = routed.inputSchema as Record<string, unknown>;
		const properties = schema.properties as Record<string, unknown>;

		assert.notStrictEqual(routed, original);
		assert.deepStrictEqual(schema.required, ["description", "model"]);
		assert.deepStrictEqual(properties.description, { type: "string" });
		assert.deepStrictEqual(properties.model, {
			type: "string",
			description: "Exact model-picker label from the advertised subagent catalog.",
		});
		assert.deepStrictEqual(original.inputSchema.required, ["description"]);
		assert.ok(!("model" in original.inputSchema.properties));
	});

	test("preserves an existing model schema and leaves ordinary tools unchanged", () => {
		const subagent = {
			name: "executionSubagent",
			inputSchema: {
				type: "object",
				properties: { model: { type: "string", enum: ["Qwen"] } },
				required: ["model"],
			},
		};
		const ordinary = { name: "read_file", inputSchema: { type: "object", properties: {} } };

		const routed = withRequiredSubagentModel(subagent);
		const properties = routed.inputSchema.properties as Record<string, unknown>;
		assert.deepStrictEqual(properties.model, { type: "string", enum: ["Qwen"] });
		assert.deepStrictEqual(routed.inputSchema.required, ["model"]);
		assert.strictEqual(withRequiredSubagentModel(ordinary), ordinary);
	});

	test("keeps model-visible guidance stable when availability changes", () => {
		setSubagentModelProfiles("claude", [{
			id: "claude-opus-5",
			label: "Opus 5 (Claude)",
			provider: "claude",
			defaultEffort: "high",
			useWhen: "Complex coding model",
			availability: "unavailable",
			availabilityReason: "5-hour limit 100%",
			unavailableUntil: "2026-07-19T10:50:00.000Z",
		}]);
		const unavailableGuidance = buildSubagentToolGuidance();
		setSubagentModelProfiles("claude", [{
			id: "claude-opus-5",
			label: "Opus 5 (Claude)",
			provider: "claude",
			defaultEffort: "high",
			useWhen: "Complex coding model",
			availability: "available",
			availabilityReason: "Subscription limit reset",
		}]);
		const availableGuidance = buildSubagentToolGuidance();
		assert.strictEqual(unavailableGuidance, availableGuidance);
		assert.ok(availableGuidance.includes('model="Opus 5 (Claude)", high thinking'));
		assert.ok(!availableGuidance.includes("5-hour limit"));
		assert.ok(!availableGuidance.includes("Subscription limit reset"));
	});

	test("excludes Sol from subagent routing while retaining Opus 5", () => {
		setSubagentModelProfiles("codex", [
			{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex", useWhen: "Large tasks" },
			{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex", useWhen: "Subagent tasks" },
		]);
		setSubagentModelProfiles("claude", [
			{ id: "claude-opus-5", label: "Opus 5", provider: "claude", useWhen: "Subagent tasks" },
		]);
		const profiles = getSubagentModelProfiles();
		assert.ok(!profiles.some(profile => profile.id === "gpt-5.6-sol"));
		assert.ok(profiles.some(profile => profile.id === "gpt-5.6-luna"));
		assert.ok(profiles.some(profile => profile.id === "claude-opus-5"));
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("GPT-5.6 Sol"));
	});

	test("orders budget tiers from cheapest local to premium subscription", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "gpt-5.6-codex", label: "GPT-5.6 Codex", provider: "codex", defaultEffort: "high", useWhen: "Repo work",
		}]);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		const cheapest = guidance.indexOf("cheapest —");
		const mid = guidance.indexOf("mid —");
		const premium = guidance.indexOf("premium —");
		assert.ok(cheapest >= 0 && mid > cheapest && premium > mid);
	});

	test("omits budget policy when only one cost tier is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", [{
			id: "gpt-5.6-codex", label: "GPT-5.6 Codex", provider: "codex", defaultEffort: "high", useWhen: "Repo work",
		}]);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("Budget routing policy"));
		assert.ok(guidance.includes("Never omit runSubagent.model"));
	});

	test("includes vision delegation guidance when a local model is available", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes("Vision delegation:"));
		assert.ok(guidance.includes("The subagent has access to view_image and terminal tools"));
		assert.ok(guidance.includes("Use agentName 'Explore' or any available agent type with a local model"));
	});

	test("omits vision delegation guidance when no local model is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("Vision delegation:"));
	});
});
