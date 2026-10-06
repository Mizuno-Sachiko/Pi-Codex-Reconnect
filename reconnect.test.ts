import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi loads pi-codex-reconnect", async () => {
	const directory = fileURLToPath(new URL(".", import.meta.url));
	const result = await discoverAndLoadExtensions(["./index.ts"], directory, directory);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
});
