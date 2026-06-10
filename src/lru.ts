// A small insertion-ordered LRU cache used to hold per-file content snapshots
// for diff computation. Pure logic — no Obsidian dependency, so it is unit
// testable in isolation.
export class LRUCache<K, V> {
	private maxSize: number;
	private cache: Map<K, V>;

	constructor(maxSize: number) {
		this.maxSize = Math.max(1, maxSize);
		this.cache = new Map();
	}

	get(key: K): V | undefined {
		if (!this.cache.has(key)) return undefined;
		const value = this.cache.get(key)!;
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) this.cache.delete(firstKey);
		}
		this.cache.set(key, value);
	}

	resize(newMax: number): void {
		this.maxSize = Math.max(1, newMax);
		while (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) this.cache.delete(firstKey);
		}
	}

	get size(): number {
		return this.cache.size;
	}
}
