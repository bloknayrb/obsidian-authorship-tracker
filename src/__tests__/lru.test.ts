import { describe, it, expect } from "vitest";
import { LRUCache } from "../lru";

describe("LRUCache", () => {
	it("stores and retrieves values", () => {
		const cache = new LRUCache<string, number>(3);
		cache.set("a", 1);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("missing")).toBeUndefined();
	});

	it("evicts the least-recently-used entry when full", () => {
		const cache = new LRUCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3); // evicts "a"
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBe(2);
		expect(cache.get("c")).toBe(3);
	});

	it("treats a get as a recent use", () => {
		const cache = new LRUCache<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a"); // "a" is now most-recently-used
		cache.set("c", 3); // evicts "b", not "a"
		expect(cache.get("a")).toBe(1);
		expect(cache.get("b")).toBeUndefined();
	});

	it("overwrites an existing key without growing", () => {
		const cache = new LRUCache<string, number>(2);
		cache.set("a", 1);
		cache.set("a", 9);
		expect(cache.get("a")).toBe(9);
		expect(cache.size).toBe(1);
	});

	it("shrinks on resize, dropping oldest entries", () => {
		const cache = new LRUCache<string, number>(3);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		cache.resize(1);
		expect(cache.size).toBe(1);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBe(3);
	});
});
