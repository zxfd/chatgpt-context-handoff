# ChatGPT Context Handoff

ChatGPT 桌面客户端原生 Stop 钩子：在 Codex 任务接近长上下文区间时，自动续发一轮，请模型写好交接文档，再由用户手动或由客户端原生任务工具尽力创建新任务。

它不是浏览器扩展，不读取网页，不调用 OpenAI API，也不需要 API Key。

## 工作方式

1. 客户端准备结束一轮任务时触发 `Stop`。
2. 插件从当前任务记录的最新 `token_count` 读取真实输入 token 和上下文窗口。
3. 达到阈值后返回 `decision: "block"`，客户端自动续发一条“写交接文档”的提示。
4. `stop_hook_active` 和会话标记共同保证同一任务只交接一次。

默认绝对阈值为 250,000 token，同时使用当前模型上下文窗口的 85% 作为保护线，实际取较小值。这样既为 GPT-5.6 超过 272,000 输入 token 的长上下文计价留余量，也能适配客户端较小的有效窗口。

## 安装

在 ChatGPT 客户端的 Codex 终端中执行：

```bash
codex plugin marketplace add zxfd/chatgpt-context-handoff
codex plugin add chatgpt-context-handoff@chatgpt-context-handoff
```

然后重启 ChatGPT 客户端，在 Codex 中打开 `/hooks`，审查并信任该 Stop 钩子，再新建任务使用。

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
| `newTaskMode` | `manual` | `manual` 或 `auto` |
| `handoffFile` | `交接文档.md` | 当前工作目录内的交接文件 |

也可用同名大写环境变量临时覆盖：

- `CONTEXT_HANDOFF_THRESHOLD_TOKENS`
- `CONTEXT_HANDOFF_MAX_CONTEXT_PERCENT`
- `CONTEXT_HANDOFF_NEW_TASK_MODE`
- `CONTEXT_HANDOFF_FILE`

`auto` 模式不会模拟点击。它只要求续发模型在客户端确实提供 `create_thread` 等原生工具时创建新任务；工具不可用时退回手动提示。

## 验证

```bash
npm test
```

## 已知边界

- OpenAI 将 `transcript_path` 定义为便利接口而非稳定协议。插件解析失败时会安静放行，不影响正常任务。
- 普通 Chat 模式是否提供 Codex 生命周期钩子取决于客户端功能；本插件只作用于桌面客户端中的 Codex 工作区。
- 客户端会要求用户单独信任命令钩子，这是安全设计，不应绕过。

## 来源与复用

- [OpenAI Hooks 文档](https://developers.openai.com/codex/hooks)
- [OpenAI ChatGPT 桌面客户端文档](https://developers.openai.com/codex/app)
- [Ponytail](https://github.com/DietrichGebert/ponytail) 的原生插件和薄生命周期钩子结构

MIT License
