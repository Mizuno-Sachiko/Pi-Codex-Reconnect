# pi-codex-reconnect

English | [简体中文](https://github.com/Mizuno-Sachiko/Pi-Codex-Reconnect/blob/main/README.zh-CN.md)

`pi-codex-reconnect` is a connection-recovery extension for [Pi](https://github.com/earendil-works/pi).

The extension helps Pi retry OpenAI Codex model requests after temporary connection failures.

Pi receives incremental model output through two connection types:

- WebSocket maintains a two-way connection between Pi and the model service.
- The server streams output through an HTTP response.

Pi's model library can retain an SSE selection for the entire session after a WebSocket failure. `pi-codex-reconnect` clears that selection after a temporary connection failure, allowing the next request to try a fresh WebSocket connection.

The extension preserves SSE for close code `1009`, which means the message is too large.

## Installation

Run in a terminal:

```sh
pi install npm:pi-codex-reconnect
```

## Configuration

The extension's optional configuration file is `~/.pi/agent/pi-codex-reconnect/config.json`.

Example configuration:

```json
{
  "logging": {
    "level": "warn",
    "maxFileBytes": 1048576,
    "maxFiles": 2
  }
}
```

Without a configuration file, the extension uses the defaults above. The extension does not create `config.json` automatically.

Omitted fields use their defaults. Unknown fields or invalid values prevent the extension from loading, and Pi reports an error.

After saving the extension's `config.json`, enter `/reload` in Pi's input box to apply the configuration.

| Field | Purpose |
| --- | --- |
| `logging.level` | Log detail level; default: `warn`. |
| `logging.maxFileBytes` | Maximum bytes per log file; default: 1,048,576 bytes. Must be an integer of at least 4096. |
| `logging.maxFiles` | Number of log files to retain, including the current file; default: 2. Must be an integer from 1 to 10. |

| Level | Records |
| --- | --- |
| `off` | No logging or network-error subscriptions. Connection recovery remains active. |
| `error` | Codex requests still failing after Pi finishes retries and other automatic continuations. |
| `warn` | Also connection-state resets and new `1009` decisions. |
| `info` | Also successful requests after connection recovery was scheduled. |
| `debug` | Also underlying network error names, codes, nested causes, elapsed time and WebSocket failure metadata. |

Each level from `warn` through `debug` includes the less detailed levels above it, except `off`.

## References

- [Pi extension programming interface and lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Codex recovery reference in fitchmultz/pi, derived from upstream earendil-works/pi](https://github.com/fitchmultz/pi/commit/732d7c07f18a739bd7103883b01b272392fd7314)
- [Undici network-error notifications](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md)

## License

MIT. See [`LICENSE`](https://github.com/Mizuno-Sachiko/Pi-Codex-Reconnect/blob/main/LICENSE) for the full terms.
