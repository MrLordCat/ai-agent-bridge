/** Native tool callbacks are resolved once, independently of the protocol codec. */
export class PendingToolRegistry<T> extends Map<string, T> {
	accept<R>(results: readonly R[], id: (result: R) => string, deliver: (call: T, result: R) => void, accepts: (call: T) => boolean = () => true): number {
		let delivered = 0;
		for (const result of results) {
			const key = id(result), call = this.get(key);
			if (!call || !accepts(call)) { continue; }
			this.delete(key); deliver(call, result); delivered++;
		}
		return delivered;
	}
	settleAll(settle: (call: T) => void): void {
		const calls = [...this.values()]; this.clear();
		for (const call of calls) { settle(call); }
	}
	missing(returned: ReadonlySet<string>, required: (call: T) => boolean): string[] {
		return [...this].filter(([id, call]) => required(call) && !returned.has(id)).map(([id]) => id);
	}
}

/** A response can yield for tools and attach again; completion retires it once. */
export class DelegatedTurnState<TCall, TOutput> {
	readonly pending = new PendingToolRegistry<TCall>();
	private boundary?: { resolve(): void; reject(error: Error): void };
	private output: TOutput[] = [];
	private outputSize = 0;
	terminal = false;
	error?: Error;
	constructor(private readonly maximumOutput = 500_000) {}
	get attached(): boolean { return this.boundary !== undefined; }
	attach(): Promise<void> {
		if (this.boundary) { throw new Error("A Chat response is already attached to this tool turn."); }
		if (this.terminal) { return this.error ? Promise.reject(this.error) : Promise.resolve(); }
		return new Promise((resolve, reject) => { this.boundary = { resolve, reject }; });
	}
	release(error?: Error): void {
		const boundary = this.boundary; this.boundary = undefined;
		if (error) { boundary?.reject(error); } else { boundary?.resolve(); }
	}
	enqueue(value: TOutput, size: number): void {
		if (this.terminal) { return; }
		if (this.outputSize + size > this.maximumOutput) { throw new Error("Too much output while waiting for a Chat tool result."); }
		this.output.push(value); this.outputSize += size;
	}
	takeOutput(): TOutput[] { const values = this.output; this.output = []; this.outputSize = 0; return values; }
	finish(error: Error | undefined, settle: (call: TCall) => void): boolean {
		if (this.terminal) { return false; }
		this.terminal = true; this.error = error;
		this.pending.settleAll(settle); this.takeOutput(); this.release(error);
		return true;
	}
}