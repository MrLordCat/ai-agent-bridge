import * as assert from "node:assert";
import { ReasoningRepetitionDetector } from "../context/reasoning-repetition";

suite("reasoning repetition detector", () => {
	test("detects a short exact degeneration loop across stream chunks", () => {
		const detector = new ReasoningRepetitionDetector();
		let detection;
		const broken = `${"Initial analysis. ".repeat(80)}${"(А: ".repeat(1_200)}`;
		for (let offset = 0; offset < broken.length; offset += 257) {
			detection = detector.append(broken.slice(offset, offset + 257)) ?? detection;
		}

		assert.ok(detection);
		assert.ok(detection.repeatedChars >= 3_072);
		assert.ok(detection.repetitions >= 6);
	});

	test("allows long varied technical reasoning", () => {
		const detector = new ReasoningRepetitionDetector();
		const reasoning = Array.from(
			{ length: 600 },
			(_, index) => `Step ${index}: inspect register ${index % 31}, offset ${index * 17}, and verify branch ${index % 13}.\n`
		).join("");
		let detection;
		for (let offset = 0; offset < reasoning.length; offset += 311) {
			detection = detector.append(reasoning.slice(offset, offset + 311)) ?? detection;
		}

		assert.strictEqual(detection, undefined);
	});

	test("does not trigger before the minimum reasoning volume", () => {
		const detector = new ReasoningRepetitionDetector();
		assert.strictEqual(detector.append("(A: ".repeat(700)), undefined);
	});
});