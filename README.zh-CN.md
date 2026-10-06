# pi-codex-reconnect

[English](https://github.com/Mizuno-Sachiko/Pi-Codex-Reconnect/blob/main/README.md) | 简体中文

`pi-codex-reconnect`是[Pi](https://github.com/earendil-works/pi)的连接恢复插件。

插件帮助Pi在临时连接故障后重新尝试OpenAI Codex模型请求。

Pi通过两种连接方式逐段接收模型输出：

- WebSocket在Pi与模型服务之间保持双向连接。
- 服务器通过HTTP响应持续发送输出。

Pi的模型调用库可能在WebSocket失败后，为整个会话持续保留SSE选择。`pi-codex-reconnect`会在临时连接故障后清除这个选择，让下一次请求尝试重新建立WebSocket连接。

插件遇到关闭码`1009`，即消息过大时会保留SSE。

## 安装

在终端中执行：

```sh
pi install npm:pi-codex-reconnect
```

## 配置

插件的可选配置文件为`~/.pi/agent/pi-codex-reconnect/config.json`。

示例配置文件内容如下：

```json
{
  "logging": {
    "level": "warn",
    "maxFileBytes": 1048576,
    "maxFiles": 2
  }
}
```

没有配置文件时，插件使用上述默认值。插件不会自动创建`config.json`。

省略的字段使用默认值；未知字段或无效值会使插件停止加载，并由Pi显示错误。

保存插件的`config.json`后，在Pi输入框中输入`/reload`应用配置。

| 字段 | 作用 |
| --- | --- |
| `logging.level` | 日志详细程度，默认为`warn`。 |
| `logging.maxFileBytes` | 单个日志文件的字节数上限，默认为1,048,576字节。必须是不小于4096的整数。 |
| `logging.maxFiles` | 保留的日志文件数量，包含当前文件，默认为2。必须是1至10的整数。 |

| 等级 | 记录内容 |
| --- | --- |
| `off` | 不记录日志，也不订阅网络错误通知。连接恢复功能仍然启用。 |
| `error` | Pi完成重试及其他自动继续操作后，仍然失败的Codex请求。 |
| `warn` | 加上连接状态清除操作，以及新出现的`1009`处理决定。 |
| `info` | 加上安排连接恢复后，后续请求成功的结果。 |
| `debug` | 加上底层网络错误名称、错误码、嵌套原因、耗时和WebSocket故障信息。 |

从`warn`到`debug`，每个等级均包含表中排在它上方的较简略等级，`off`除外。

## 参考资料

- [Pi扩展编程接口与生命周期](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [上游earendil-works/pi的派生仓库fitchmultz/pi中的Codex恢复参考实现](https://github.com/fitchmultz/pi/commit/732d7c07f18a739bd7103883b01b272392fd7314)
- [Undici网络错误通知](https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md)

## 许可证

采用MIT许可证，完整条款见[`LICENSE`](https://github.com/Mizuno-Sachiko/Pi-Codex-Reconnect/blob/main/LICENSE)。
