export interface ReasoningRepetitionDetection {
	totalChars: number;
	repeatedChars: number;
	unitChars: number;
	repetitions: number;
}

export interface ReasoningRepetitionDetectorOptions {
	minTotalChars?: number;
	minRepeatedChars?: number;
	maxBufferChars?: number;
	maxUnitChars?: number;
}

const DEFAULT_MIN_TOTAL_CHARS = 4_096;
const DEFAULT_MIN_REPEATED_CHARS = 3_072;
const DEFAULT_MAX_BUFFER_CHARS = 16_384;
const DEFAULT_MAX_UNIT_CHARS = 128;

/**
 * Detects an exact periodic suffix in streamed private reasoning. The guard is
 * deliberately conservative: it waits for several kilobytes of output and
 * requires at least 3K characters to be explained by one repeated unit. This
 * catches degeneration such as `(A: (A: ...` while allowing repetitive code,
 * tables, and ordinary step-by-step analysis to pass.
 */
export class ReasoningRepetitionDetector {
	private readonly minTotalChars: number;
	private readonly minRepeatedChars: number;
	private readonly maxBufferChars: number;
	private readonly maxUnitChars: number;
	private buffer = "";
	private totalChars = 0;
	private detection: ReasoningRepetitionDetection | undefined;

	constructor(options: ReasoningRepetitionDetectorOptions = {}) {
		this.minTotalChars = Math.max(512, Math.floor(options.minTotalChars ?? DEFAULT_MIN_TOTAL_CHARS));
		this.minRepeatedChars = Math.max(512, Math.floor(options.minRepeatedChars ?? DEFAULT_MIN_REPEATED_CHARS));
		this.maxBufferChars = Math.max(this.minRepeatedChars, Math.floor(options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS));
		this.maxUnitChars = Math.max(1, Math.min(512, Math.floor(options.maxUnitChars ?? DEFAULT_MAX_UNIT_CHARS)));
	}

	append(text: string): ReasoningRepetitionDetection | undefined {
		if (this.detection || !text) {
			return this.detection;
		}
		this.totalChars += text.length;
		this.buffer = `${this.buffer}${text}`.slice(-this.maxBufferChars);
		if (this.totalChars < this.minTotalChars || this.buffer.length < this.minRepeatedChars) {
			return undefined;
		}

		const maxUnit = Math.min(this.maxUnitChars, Math.floor(this.buffer.length / 2));
		let best: ReasoningRepetitionDetection | undefined;
		for (let unitChars = 1; unitChars <= maxUnit; unitChars += 1) {
			const unit = this.buffer.slice(-unitChars);
			// Whitespace/punctuation-only output is harmless and can legitimately
			// occur in formatted code. Require some semantic-looking character.
			if (!/[A-Za-z0-9\u0400-\u04ff]/.test(unit)) {
				continue;
			}
			let repetitions = 1;
			let cursor = this.buffer.length - unitChars;
			while (cursor >= unitChars && this.buffer.slice(cursor - unitChars, cursor) === unit) {
				repetitions += 1;
				cursor -= unitChars;
			}
			const repeatedChars = repetitions * unitChars;
			if (repetitions < 6 || repeatedChars < this.minRepeatedChars) {
				continue;
			}
			if (!best || repeatedChars > best.repeatedChars) {
				best = {
					totalChars: this.totalChars,
					repeatedChars,
					unitChars,
					repetitions,
				};
			}
		}

		this.detection = best;
		return best;
	}
}

export class ReasoningRepetitionError extends Error {
	constructor(readonly detection: ReasoningRepetitionDetection) {
		super("The model reasoning stream entered an exact repetition loop.");
		this.name = "ReasoningRepetitionError";
	}
}