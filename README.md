# pi-codex-reconnect

Restore Codex WebSocket retries after transient connection failures in Pi.

Pi's Codex transport can retain an SSE fallback for the rest of a session after a WebSocket error. This extension clears that decision after a temporary failure so the next request can establish a fresh WebSocket connection. A WebSocket close code of **1009** means the message is too large; that decision remains on SSE.

## Installation

```sh
pi install npm:pi-codex-reconnect
```

For a local source checkout, run this from the package directory:

```sh
pi -e .
```

This loads the package for the current invocation. Source or configuration changes take effect with Pi's `/reload`.

Requires the Node.js/npm distribution of Pi, Node.js 22.19 or newer, and the Codex transport APIs present in `@earendil-works/pi-ai@1.0.4`. The recovery functions are resolved from the host Pi installation so they operate on its existing connection cache. Standalone bundled Pi executables are not supported.

The extension recognizes the `openai-codex-responses` API, including accounts registered by `pi-codex-multi`. Pi owns retry scheduling, authentication, model selection and cancellation. An explicitly configured `transport: "sse"` is respected.

On networks that cannot use WebSocket, each subsequent request may incur an additional WebSocket connection attempt. The extension changes Pi's retained transport state; it does not change the proxy, HTTP connection pool or network timeout settings.

## Configuration

Optional file: `~/.pi/agent/pi-codex-reconnect/config.json`. The agent directory follows `PI_CODING_AGENT_DIR` when set. Missing configuration uses the defaults below; the extension does not create a configuration file.

```json
{
  "logging": {
    "level": "warn",
    "maxFileBytes": 1048576,
    "maxFiles": 2
  }
}
```

Edit this file and use Pi's `/reload` to apply it. Unspecified fields retain their defaults. Invalid fields or values stop the extension from loading and are reported by Pi.

| Level | Records |
| --- | --- |
| `off` | No diagnostic subscriptions or log writes |
| `error` | Final failed Codex request after Pi settles |
| `warn` | Also transport resets and new 1009 decisions; default |
| `info` | Also successful requests after recovery was scheduled |
| `debug` | Also underlying network error codes, causes, elapsed time and transport diagnostics |

Levels include the less verbose levels above them. `maxFileBytes` is an integer of at least 4096; `maxFiles` is an integer from 1 to 10, including the current file.

Logs use JSON Lines in the same directory: `reconnect.jsonl`, followed by `reconnect.1.jsonl` and subsequent numbered files when configured. Files rotate before a write would exceed the byte limit. The default log budget is 2 MiB. Reduced limits apply to future rotations; previously retained files may need to be removed manually.

Logs contain session, provider and model identifiers, event names, numeric metadata, and bounded error names and codes. Raw error messages, stacks, headers, tokens, account IDs, URLs and conversation contents are excluded. Undici errors are attributed by Codex response path and the session header; requests without that header are not captured. Concurrent Pi processes share these files. A log-write or rotation failure disables further logging for that extension runtime and reports a notification, while recovery remains active.

## Recovery policy

The extension checks the finalized assistant message before Pi schedules its next automatic retry. A successful SSE reply is also checked: the WebSocket attempt may have failed before that reply began.

- Active fallback after a temporary WebSocket error: close the current session's cached sockets and clear its fallback/debug state.
- Close code 1009: preserve SSE, including later replies that no longer carry a new WebSocket diagnostic.
- User cancellation, explicit SSE or no active fallback: leave transport state unchanged.

Only the current session is reset. The next request retains Pi's account, model and conversation selection. Already emitted content and tools remain under Pi's normal retry behavior.

## Development

```sh
npm ci --ignore-scripts
npm run format
npm run check
npm test
```

The tests cover extension initialization against Pi's import-only module exports, the recovery decision, diagnostic privacy, session changes and log rotation.

For manual proxy-switching verification:

1. Set `logging.level` to `debug` in the configuration file and start Pi with `-e .`.
2. Submit a Codex request, change the proxy node while output is streaming, and let Pi finish its native retries.
3. Inspect `reconnect.jsonl`: `websocket_retry_enabled` records the reset, `request_recovered` records a subsequent successful request, and `network_error` records available underlying error codes. Check the session, provider and model identifiers against the request being tested.

A successful reply can still use SSE, so `request_recovered` alone does not prove that WebSocket was used. Close code 1009 retains SSE. Other active sessions should remain unaffected.

The npm package contains the extension source, configuration example, README and license. Pi libraries and TypeBox are host-provided peers and are not bundled.

## Releases

[The release workflow](.github/workflows/release.yml) checks formatting, types, tests and package contents on Windows and Linux with Node.js 22.19 and 24. A `vMAJOR.MINOR.PATCH` tag must match the version in `package.json`. After the checks pass, npm publishing uses GitHub's short-lived OIDC identity.

The first release requires a maintainer's npm login and 2FA, because [trusted publishing](https://docs.npmjs.com/trusted-publishers/) is configured for an existing npm package. From the committed release checkout:

```sh
npm run check
npm test
npm publish "$(npm pack --ignore-scripts --silent)" --ignore-scripts
```

Push the first annotated version tag after the manual publication. The workflow checks the already published package's integrity and skips uploading identical contents. A different package under the same version fails validation; publish a new version instead.

Before the first automated release, configure the package's trusted publisher on npmjs.com:

| Field | Value |
| --- | --- |
| Organization or user | `Mizuno-Sachiko` |
| Repository | `Pi-Codex-Reconnect` |
| Workflow filename | `release.yml` |
| Environment | Leave empty |
| Allowed action | Allow `npm publish` |

Update `package.json` and `package-lock.json`, commit the release and push its annotated version tag. A new trusted publisher configuration must complete its first successful automated publish within npm's documented activation period, so configure it when that release is ready.

## References

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Codex fallback recovery reference](https://github.com/fitchmultz/pi/commit/732d7c07f18a739bd7103883b01b272392fd7314)
- [Undici diagnostic channels](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md)

## License

MIT
