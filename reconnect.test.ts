import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { shouldReconnect } from "./index.ts";

const fallback = { websocketFallbackActive: true, lastWebSocketError: "WebSocket error" };
const failed = { stopReason: "error" } satisfies Pick<
	AssistantMessage,
	"stopReason" | "diagnostics"
>;

test("Pi loads the extension with the host's import-only Codex exports", async () => {
	const directory = fileURLToPath(new URL(".", import.meta.url));
	const result = await discoverAndLoadExtensions(["./index.ts"], directory, directory);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.deepEqual(
		[...(result.extensions[0]?.handlers.keys() ?? [])],
		["session_start", "turn_start", "message_end", "agent_settled", "session_shutdown"],
	);
});

test("transient failure restores WebSocket on the next request", () => {
	assert.equal(shouldReconnect(fallback, failed, "auto"), true);
	assert.equal(shouldReconnect(fallback, failed, "websocket"), true);
	assert.equal(shouldReconnect(fallback, failed, "websocket-cached"), true);
	assert.equal(shouldReconnect(fallback, failed, undefined), true);
	assert.equal(shouldReconnect(fallback, { stopReason: "stop" }, "auto"), true);
});

test("a structured 1009 close keeps SSE", () => {
	assert.equal(
		shouldReconnect(
			fallback,
			{
				...failed,
				diagnostics: [
					{
						type: "provider_transport_failure",
						timestamp: 0,
						error: { code: 1009, message: "WebSocket closed 1009 message too big" },
					},
				],
			},
			"auto",
		),
		false,
	);
});

test("later SSE-only replies retain a previous 1009 decision", () => {
	for (const reason of ["WebSocket closed 1009", "WebSocket closed 1009 message too big"]) {
		assert.equal(
			shouldReconnect({ ...fallback, lastWebSocketError: reason }, failed, "auto"),
			false,
		);
	}
	assert.equal(
		shouldReconnect({ ...fallback, lastWebSocketError: "WebSocket closed 10090" }, failed, "auto"),
		true,
	);
});

test("explicit SSE and user cancellation leave transport state unchanged", () => {
	assert.equal(shouldReconnect(fallback, failed, "sse"), false);
	assert.equal(shouldReconnect(fallback, { stopReason: "aborted" }, "auto"), false);
});

test("a session without active fallback needs no reset", () => {
	assert.equal(shouldReconnect(undefined, failed, "auto"), false);
	assert.equal(shouldReconnect({ websocketFallbackActive: false }, failed, "auto"), false);
});

test("diagnostic logs are private, session-scoped and bounded", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-codex-reconnect-test-"));
	const logs = join(directory, "pi-codex-reconnect");
	mkdirSync(logs);
	writeFileSync(
		join(logs, "config.json"),
		JSON.stringify({ logging: { level: "debug", maxFileBytes: 4096, maxFiles: 2 } }),
	);
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	t.after(() => {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		// Only remove this test's dedicated directory after checking its generated contents.
		assert.deepEqual(readdirSync(directory), ["pi-codex-reconnect"]);
		for (const file of readdirSync(logs)) {
			assert.match(file, /^(?:config\.json|reconnect(?:\.\d+)?\.jsonl)$/);
		}
		rmSync(directory, { recursive: true });
	});
	const packageDirectory = fileURLToPath(new URL(".", import.meta.url));
	const loaded = await discoverAndLoadExtensions(["./index.ts"], packageDirectory, directory);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	assert.ok(extension);
	loaded.runtime.getSettings = () => ({ transport: "auto" });
	let sessionId = "test-session-a";
	const ctx = { hasUI: false, sessionManager: { getSessionId: () => sessionId } };
	async function emit(type: string, data = {}) {
		for (const handler of extension?.handlers.get(type) ?? []) {
			await handler({ type, ...data }, ctx);
		}
	}
	t.after(() => emit("session_shutdown"));
	await emit("session_start");
	const request = {
		method: "POST",
		path: "/backend-api/codex/responses",
		headers: ["session-id", sessionId],
	};
	const cause = Object.assign(new Error("private-marker"), { code: "ECONNRESET" });
	channel("undici:request:create").publish({ request });
	channel("undici:request:error").publish({
		request,
		error: new TypeError("private-marker", { cause }),
	});
	const file = join(logs, "reconnect.jsonl");
	const record = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(record.event, "network_error");
	assert.deepEqual(record.errors, [{ name: "TypeError" }, { name: "Error", code: "ECONNRESET" }]);
	assert.ok(!readFileSync(file, "utf8").includes("private-marker"));
	const message = {
		role: "assistant",
		api: "openai-codex-responses",
		provider: "test-provider",
		model: "test-model",
		stopReason: "error",
	};
	await emit("message_end", { message });
	sessionId = "test-session-b";
	await emit("session_start");
	await emit("agent_settled");
	assert.ok(!readFileSync(file, "utf8").includes("request_failed"));
	for (let index = 0; index < 50; index++) {
		await emit("message_end", { message });
		await emit("agent_settled");
	}
	const files = readdirSync(logs).filter((name) => name.endsWith(".jsonl"));
	assert.equal(files.length, 2);
	for (const name of files) {
		assert.ok(statSync(join(logs, name)).size <= 4096);
		assert.ok(!readFileSync(join(logs, name), "utf8").includes("ECONNRESET"));
	}
});
