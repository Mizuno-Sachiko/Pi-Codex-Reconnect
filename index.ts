import { subscribe, unsubscribe } from "node:diagnostics_channel";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { join } from "node:path";
import type { AssistantMessage, StreamOptions } from "@earendil-works/pi-ai";
import type { OpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { type ExtensionAPI, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const levels = { off: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
const LoggingSchema = Type.Object(
	{
		level: Type.Union([
			Type.Literal("off"),
			Type.Literal("error"),
			Type.Literal("warn"),
			Type.Literal("info"),
			Type.Literal("debug"),
		]),
		maxFileBytes: Type.Integer({ minimum: 4096 }),
		maxFiles: Type.Integer({ minimum: 1, maximum: 10 }),
	},
	{ additionalProperties: false },
);
const ConfigSchema = Type.Object(
	{ logging: Type.Optional(Type.Partial(LoggingSchema)) },
	{ additionalProperties: false },
);

export function shouldReconnect(
	stats:
		| Pick<OpenAICodexWebSocketDebugStats, "websocketFallbackActive" | "lastWebSocketError">
		| undefined,
	message: Pick<AssistantMessage, "stopReason" | "diagnostics">,
	transport: StreamOptions["transport"],
): boolean {
	// SSE-only replies have no new WebSocket diagnostic, so also check the retained close reason.
	return (
		stats?.websocketFallbackActive === true &&
		transport !== "sse" &&
		message.stopReason !== "aborted" &&
		!message.diagnostics?.some(
			(diagnostic) =>
				diagnostic.type === "provider_transport_failure" && diagnostic.error?.code === 1009,
		) &&
		!/^WebSocket closed 1009(?:\s|$)/.test(stats.lastWebSocketError ?? "")
	);
}

function errorCodes(error: unknown): { name: string; code?: string | number }[] {
	const pending = [error];
	const result: { name: string; code?: string | number }[] = [];
	// Bound nested and aggregate errors; raw messages and stacks may contain private data.
	while (pending.length > 0 && result.length < 8) {
		const current = pending.shift();
		if (!(current instanceof Error)) continue;
		const code: unknown = Reflect.get(current, "code");
		result.push({
			name: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(current.name) ? current.name : "Error",
			code:
				typeof code === "number" ||
				(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
					? code
					: undefined,
		});
		if (current.cause) pending.push(current.cause);
		if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 8));
	}
	return result;
}

interface NetworkRequest {
	method: string;
	path: string;
	headers: string[];
}

export default function (pi: ExtensionAPI) {
	const directory = join(getAgentDir(), "pi-codex-reconnect");
	const configPath = join(directory, "config.json");
	const config: unknown = existsSync(configPath)
		? JSON.parse(readFileSync(configPath, "utf8"))
		: {};
	if (!Value.Check(ConfigSchema, config)) {
		throw new Error(`pi-codex-reconnect: invalid configuration at ${configPath}`);
	}
	const logging: Static<typeof LoggingSchema> = {
		level: "warn",
		maxFileBytes: 1048576,
		maxFiles: 2,
		...config.logging,
	};
	// Resolve the host copy natively; pi-ai exposes import-only package exports.
	const aiPackage = findPackageJSON("@earendil-works/pi-ai", join(getPackageDir(), "package.json"));
	if (!aiPackage) throw new Error("pi-codex-reconnect: host pi-ai package not found");
	const require = createRequire(aiPackage);
	const codex =
		require("./dist/api/openai-codex-responses.js") as typeof import("@earendil-works/pi-ai/api/openai-codex-responses");
	const { clampOpenAIPromptCacheKey } =
		require("./dist/api/openai-prompt-cache.js") as typeof import("@earendil-works/pi-ai/api/openai-prompt-cache");
	let loggingFailed = false;
	let reportLogError = (error: unknown) =>
		console.error(
			`pi-codex-reconnect: log writing failed; logging disabled. ${JSON.stringify(errorCodes(error))}`,
		);
	let unsubscribeDiagnostics = () => {};
	let networkFailure: Record<string, unknown> | undefined;
	let finalFailure: Record<string, unknown> | undefined;
	let awaitingRecovery = false;

	function log(
		level: Exclude<keyof typeof levels, "off">,
		event: string,
		data: Record<string, unknown>,
	) {
		if (loggingFailed || levels[level] > levels[logging.level]) return;
		const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...data })}\n`;
		const file = (index: number) =>
			join(directory, index === 0 ? "reconnect.jsonl" : `reconnect.${index}.jsonl`);
		try {
			if (Buffer.byteLength(line) > logging.maxFileBytes) {
				throw new Error("Log record exceeds maxFileBytes");
			}
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (
				existsSync(file(0)) &&
				statSync(file(0)).size + Buffer.byteLength(line) > logging.maxFileBytes
			) {
				for (let index = logging.maxFiles - 1; index > 0; index--) {
					if (existsSync(file(index - 1))) renameSync(file(index - 1), file(index));
				}
				if (logging.maxFiles === 1) writeFileSync(file(0), "", { mode: 0o600 });
			}
			appendFileSync(file(0), line, { mode: 0o600 });
		} catch (error) {
			// Diagnostic subscribers must not throw into Undici; recovery remains independent of logging.
			loggingFailed = true;
			reportLogError(error);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		unsubscribeDiagnostics();
		// Session changes must not inherit another request's diagnostic or recovery state.
		networkFailure = undefined;
		finalFailure = undefined;
		awaitingRecovery = false;
		reportLogError = (error: unknown) => {
			const message = `pi-codex-reconnect: log writing failed; logging disabled. ${JSON.stringify(errorCodes(error))}`;
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else console.error(message);
		};
		if (logging.level === "off") return;
		const sessionId = clampOpenAIPromptCacheKey(ctx.sessionManager.getSessionId());
		const requests = new WeakMap<NetworkRequest, number>();
		const onCreate = (value: unknown) => {
			const { request } = value as { request: NetworkRequest };
			if (!/\/codex\/responses(?:\?|$)/.test(request.path)) return;
			const matchesSession = request.headers.some(
				(header, index) =>
					index % 2 === 0 &&
					header.toLowerCase() === "session-id" &&
					request.headers[index + 1] === sessionId,
			);
			if (matchesSession) requests.set(request, performance.now());
		};
		const onError = (value: unknown) => {
			const { request, error } = value as { request: NetworkRequest; error: unknown };
			const started = requests.get(request);
			if (started === undefined) return;
			networkFailure = {
				errors: errorCodes(error),
				elapsedMs: Math.round(performance.now() - started),
				transport: request.method === "POST" ? "sse" : "websocket",
			};
			log("debug", "network_error", { sessionId, ...networkFailure });
		};
		subscribe("undici:request:create", onCreate);
		subscribe("undici:request:error", onError);
		unsubscribeDiagnostics = () => {
			unsubscribe("undici:request:create", onCreate);
			unsubscribe("undici:request:error", onError);
		};
	});

	pi.on("turn_start", () => {
		networkFailure = undefined;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.api !== "openai-codex-responses") {
			// A successful handoff to another provider is not a final Codex failure.
			finalFailure = undefined;
			awaitingRecovery = false;
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const stats = codex.getOpenAICodexWebSocketDebugStats(sessionId);
		const diagnostic = message.diagnostics?.find(
			(item) => item.type === "provider_transport_failure",
		);
		const data = {
			sessionId: clampOpenAIPromptCacheKey(sessionId),
			provider: message.provider.slice(0, 128),
			model: message.model.slice(0, 128),
			websocketErrorCode: diagnostic?.error?.code,
			...networkFailure,
		};
		finalFailure = message.stopReason === "error" ? data : undefined;
		if (message.stopReason === "aborted") {
			awaitingRecovery = false;
			return;
		}
		if (awaitingRecovery && message.stopReason !== "error") {
			log("info", "request_recovered", data);
			awaitingRecovery = false;
		}
		if (diagnostic) {
			log("debug", "websocket_failure", {
				...data,
				phase: diagnostic.details?.phase,
				requestBytes: diagnostic.details?.requestBytes,
			});
		}
		if (shouldReconnect(stats, message, pi.getSettings().transport)) {
			codex.closeOpenAICodexWebSocketSessions(sessionId);
			codex.resetOpenAICodexWebSocketDebugStats(sessionId);
			awaitingRecovery = true;
			log("warn", "websocket_retry_enabled", data);
		} else if (diagnostic?.error?.code === 1009) {
			log("warn", "sse_retained_message_too_large", data);
		}
	});

	pi.on("agent_settled", () => {
		if (finalFailure) log("error", "request_failed", finalFailure);
		finalFailure = undefined;
	});

	pi.on("session_shutdown", () => {
		unsubscribeDiagnostics();
	});
}
