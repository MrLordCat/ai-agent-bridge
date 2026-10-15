interface ResourceEntry<T> {
	value?: T;
	fetchedAt?: number;
	pending?: Promise<T | undefined>;
	controller?: AbortController;
}

/** Shared requests outlive individual consumers; invalidation retires their generation. */
export class AsyncResourceCache<T> {
	private readonly entries = new Map<string, ResourceEntry<T>>();
	constructor(private readonly now: () => number = Date.now) {}

	peek(key: string, ttlMs = Infinity): T | undefined {
		const entry = this.entries.get(key);
		return entry?.fetchedAt !== undefined && ttlMs > 0 && this.now() - entry.fetchedAt < ttlMs ? entry.value : undefined;
	}

	get(key: string, load: (signal: AbortSignal) => Promise<T | undefined>, options: { ttlMs: number; force?: boolean; signal?: AbortSignal } ): Promise<T | undefined> {
		if (options.signal?.aborted) { return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError")); }
		if (options.force) { this.invalidate(key); }
		const cached = this.peek(key, options.ttlMs);
		if (cached !== undefined) { return Promise.resolve(cached); }
		let entry = this.entries.get(key);
		if (!entry) { entry = {}; this.entries.set(key, entry); }
		const current = entry;
		if (!current.pending) {
			current.controller = new AbortController();
			const signal = current.controller.signal;
			current.pending = Promise.resolve().then(() => load(signal)).then(value => {
				if (this.entries.get(key) !== current) { return undefined; }
				if (value !== undefined) { current.value = value; current.fetchedAt = this.now(); }
				return value;
			}, error => { if (this.entries.get(key) !== current) { return undefined; } throw error; })
				.finally(() => { current.pending = undefined; current.controller = undefined; });
		}
		return this.consume(current.pending, options.signal);
	}

	invalidate(key: string): void {
		const entry = this.entries.get(key);
		this.entries.delete(key);
		entry?.controller?.abort();
	}
	clear(): void { for (const key of this.entries.keys()) { this.invalidate(key); } }

	private consume(pending: Promise<T | undefined>, signal?: AbortSignal): Promise<T | undefined> {
		if (!signal) { return pending; }
		return new Promise((resolve, reject) => {
			const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) { abort(); }
			pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		});
	}
}