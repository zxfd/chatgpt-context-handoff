# ChatGPT Context Handoff

ChatGPT 桌面客户端原生 Stop 钩子：每轮结束检查当前 token 状态；在 Codex 任务接近长上下文区间时，自动续发一轮，请模型写好交接文档，再由用户手动或由客户端原生任务工具尽力创建新任务。

它不是浏览器扩展，不读取网页，不调用 OpenAI API，也不需要 API Key。

## 工作方式

1. 客户端准备结束一轮任务时触发 `Stop`。
2. 插件从当前任务记录的最新 `token_count` 读取真实输入 token 和上下文窗口。
3. 每轮返回不消耗额外模型请求的 `systemMessage` warning，其中包含当前用量、本轮缓存覆盖率、交接线和剩余额度。
4. 达到阈值后才返回 `decision: "block"`，客户端自动续发一条“写交接文档”的提示，并因此产生一轮额外模型请求。
5. `stop_hook_active` 和会话标记共同保证同一任务只交接一次。

默认绝对阈值为 250,000 token，同时使用当前模型上下文窗口的 85% 作为保护线，实际取较小值。这样既为 GPT-5.6 超过 272,000 输入 token 的长上下文计价留余量，也能适配客户端较小的有效窗口。

## 展示与请求成本

默认策略是：**未达到交接线时零额外模型请求；只在达到交接线时追加一轮交接请求。**

OpenAI Hooks 将 `systemMessage` 定义为 UI 或事件流中的 warning，而不是助手回复正文。插件每轮都可以计算并返回下面这样的状态，但 ChatGPT/Codex 桌面客户端是否把成功 Stop 钩子的 warning 显示出来，取决于当前客户端的 UI 实现：

```text
上下文 63.1K / 996.1K（6.3%）｜缓存 本轮 93.2%（58.8K）｜交接线 250.0K｜距交接 186.9K｜安全
```

因此，在 `/hooks` 中看到钩子成功调用一次、但对话结尾没有附加状态，是可能出现的正常客户端行为，不代表插件没有完成检查。插件不会为了让状态进入对话正文而在每轮返回 `decision: "block"`，因为那会让每轮都多产生一次 API 请求和费用。

真正达到交接线时，插件才会返回 `decision: "block"`。这时客户端会额外请求模型写一次交接文档；这也是默认流程唯一主动增加的模型请求。

## 安装

在 ChatGPT 客户端的 Codex 终端中执行：

```bash
codex plugin marketplace add zxfd/chatgpt-context-handoff
codex plugin add chatgpt-context-handoff@chatgpt-context-handoff
```

然后重启 ChatGPT 客户端，在 Codex 中打开 `/hooks`，审查并信任该 Stop 钩子，再新建任务使用。

## 已安装用户更新

```bash
codex plugin marketplace upgrade chatgpt-context-handoff
codex plugin add chatgpt-context-handoff@chatgpt-context-handoff
```

更新后重启 ChatGPT 客户端并新建任务。打开 `/hooks` 确认钩子已启用；如果客户端把新版本标记为待审查，请重新查看并信任。

## 配置

把仓库中的 `配置示例.json` 复制为：

```text
~/.codex/context-handoff.json
```

可配置字段：

| 字段 | 默认值 | 含义 |
| --- | ---: | --- |
| `thresholdTokens` | `250000` | 输入 token 绝对阈值 |
| `maxContextPercent` | `85` | 当前上下文窗口保护百分比 |
| `showTokenStatus` | `true` | 每轮结束返回 token 状态 warning；客户端不保证显示在回复正文 |
| `showCumulativeCache` | `false` | 在状态 warning 中追加会话累计缓存覆盖率 |
| `newTaskMode` | `manual` | `manual` 或 `auto` |
| `handoffFile` | `交接文档.md` | 当前工作目录内的交接文件 |

也可用同名大写环境变量临时覆盖：

- `CONTEXT_HANDOFF_THRESHOLD_TOKENS`
- `CONTEXT_HANDOFF_MAX_CONTEXT_PERCENT`
- `CONTEXT_HANDOFF_SHOW_TOKEN_STATUS`
- `CONTEXT_HANDOFF_SHOW_CUMULATIVE_CACHE`
- `CONTEXT_HANDOFF_NEW_TASK_MODE`
- `CONTEXT_HANDOFF_FILE`

`auto` 模式不会模拟点击。它只要求续发模型在客户端确实提供 `create_thread` 等原生工具时创建新任务；工具不可用时退回手动提示。

缓存覆盖率使用客户端实际记录的 `cached_input_tokens / input_tokens`。第三方 API 未回传缓存字段时显示“本轮不可用”，而不是 `0%`；覆盖率只说明缓存 token 占比，不代表该供应商的具体折扣。

## 验证

```bash
npm test
```

## 已知边界

- OpenAI 将 `transcript_path` 定义为便利接口而非稳定协议。插件解析失败时会安静放行，不影响正常任务。
- `systemMessage` 是 warning，不是助手回复；当前客户端可能只记录钩子调用而不在对话结尾渲染 warning。
- 普通 Chat 模式是否提供 Codex 生命周期钩子取决于客户端功能；本插件只作用于桌面客户端中的 Codex 工作区。
- 客户端会要求用户单独信任命令钩子，这是安全设计，不应绕过。

## 来源与复用

- [OpenAI Hooks 文档](https://learn.chatgpt.com/docs/hooks)
- [OpenAI ChatGPT 桌面客户端文档](https://developers.openai.com/codex/app)
- [Ponytail](https://github.com/DietrichGebert/ponytail) 的原生插件和薄生命周期钩子结构

MIT License
