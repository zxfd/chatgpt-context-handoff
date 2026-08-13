'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  thresholdTokens: 250000,
  maxContextPercent: 85,
  showTokenStatus: true,
  showCumulativeCache: false,
  newTaskMode: 'manual',
  handoffFile: '交接文档.md',
});

function positiveNumber(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function booleanValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function safeHandoffFile(value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULTS.handoffFile;
  const normalized = path.normalize(value.trim());
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return DEFAULTS.handoffFile;
  }
  return normalized;
}

function readConfig(env = process.env) {
  const configPath = env.CONTEXT_HANDOFF_CONFIG || path.join(os.homedir(), '.codex', 'context-handoff.json');
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    // Missing or malformed user config means defaults, never a blocked task.
  }

  const thresholdTokens = positiveNumber(
    env.CONTEXT_HANDOFF_THRESHOLD_TOKENS ?? fileConfig.thresholdTokens,
    DEFAULTS.thresholdTokens,
  );
  const maxContextPercent = positiveNumber(
    env.CONTEXT_HANDOFF_MAX_CONTEXT_PERCENT ?? fileConfig.maxContextPercent,
    DEFAULTS.maxContextPercent,
    100,
  );
  const requestedMode = env.CONTEXT_HANDOFF_NEW_TASK_MODE ?? fileConfig.newTaskMode;
  const newTaskMode = requestedMode === 'auto' ? 'auto' : 'manual';

  return {
    thresholdTokens,
    maxContextPercent,
    showTokenStatus: booleanValue(
      env.CONTEXT_HANDOFF_SHOW_TOKEN_STATUS ?? fileConfig.showTokenStatus,
      DEFAULTS.showTokenStatus,
    ),
    showCumulativeCache: booleanValue(
      env.CONTEXT_HANDOFF_SHOW_CUMULATIVE_CACHE ?? fileConfig.showCumulativeCache,
      DEFAULTS.showCumulativeCache,
    ),
    newTaskMode,
    handoffFile: safeHandoffFile(env.CONTEXT_HANDOFF_FILE ?? fileConfig.handoffFile),
  };
}

function formatTokens(value) {
  if (value < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}K`;
}

function cacheCoverage(cachedTokens, inputTokens) {
  if (!Number.isFinite(cachedTokens) || !Number.isFinite(inputTokens) || inputTokens <= 0) return null;
  return Math.max(0, Math.min(100, cachedTokens * 100 / inputTokens));
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildStatus(config, usage, threshold) {
  const percent = usage.contextWindow
    ? usage.inputTokens / usage.contextWindow * 100
    : null;
  const remaining = Math.max(0, threshold - usage.inputTokens);
  const state = usage.inputTokens >= threshold || percent !== null && percent >= 85
    ? '准备交接'
    : percent !== null && percent >= 70 ? '注意' : '安全';
  const window = usage.contextWindow
    ? ` / ${formatTokens(usage.contextWindow)}（${percent.toFixed(1)}%）`
    : '';
  const currentCoverage = cacheCoverage(usage.cachedInputTokens, usage.inputTokens);
  const currentCache = currentCoverage === null
    ? '缓存 本轮不可用'
    : `缓存 本轮 ${currentCoverage.toFixed(1)}%（${formatTokens(usage.cachedInputTokens)}）`;
  const cumulativeCoverage = cacheCoverage(usage.cumulativeCachedInputTokens, usage.cumulativeInputTokens);
  const cumulativeCache = config.showCumulativeCache
    ? `｜累计 ${cumulativeCoverage === null ? '不可用' : `${cumulativeCoverage.toFixed(1)}%（${formatTokens(usage.cumulativeCachedInputTokens)}）`}`
    : '';
  return `上下文 ${formatTokens(usage.inputTokens)}${window}｜${currentCache}${cumulativeCache}｜交接线 ${formatTokens(threshold)}｜距交接 ${formatTokens(remaining)}｜${state}`;
}

function readTail(filePath, maxBytes = 4 * 1024 * 1024) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    fs.closeSync(handle);
  }
}

function latestUsage(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  const lines = readTail(transcriptPath).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"token_count"') && !lines[index].includes('"context_compacted"')) continue;
    try {
      const event = JSON.parse(lines[index]);
      if (event?.type === 'event_msg' && event?.payload?.type === 'context_compacted') return null;
      if (event?.type !== 'event_msg' || event?.payload?.type !== 'token_count') continue;
      const info = event.payload.info;
      const input = Number(info?.last_token_usage?.input_tokens);
      const total = Number(info?.last_token_usage?.total_tokens);
      const inputTokens = input > 0 ? input : total;
      const cachedInputTokens = optionalNumber(info?.last_token_usage?.cached_input_tokens);
      const cumulativeInputTokens = optionalNumber(info?.total_token_usage?.input_tokens);
      const cumulativeCachedInputTokens = optionalNumber(info?.total_token_usage?.cached_input_tokens);
      const contextWindow = Number(info?.model_context_window);
      if (!Number.isFinite(inputTokens) || inputTokens <= 0) continue;
      return {
        inputTokens,
        cachedInputTokens: Number.isFinite(cachedInputTokens) && cachedInputTokens >= 0
          ? cachedInputTokens : null,
        cumulativeInputTokens: Number.isFinite(cumulativeInputTokens) && cumulativeInputTokens > 0
          ? cumulativeInputTokens : null,
        cumulativeCachedInputTokens: Number.isFinite(cumulativeCachedInputTokens) && cumulativeCachedInputTokens >= 0
          ? cumulativeCachedInputTokens : null,
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
      };
    } catch (_) {
      // Keep scanning older complete lines.
    }
  }
  return null;
}

function effectiveThreshold(config, usage) {
  if (!usage.contextWindow) return Math.floor(config.thresholdTokens);
  return Math.floor(Math.min(
    config.thresholdTokens,
    usage.contextWindow * config.maxContextPercent / 100,
  ));
}

function markerPath(sessionId, env = process.env) {
  const stateDir = env.CONTEXT_HANDOFF_STATE_DIR || env.PLUGIN_DATA ||
    path.join(os.homedir(), '.codex', 'chatgpt-context-handoff');
  const id = crypto.createHash('sha256').update(String(sessionId)).digest('hex');
  return path.join(stateDir, 'handled-sessions', id);
}

function claimSession(sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  const marker = markerPath(sessionId, env);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  try {
    const handle = fs.openSync(marker, 'wx', 0o600);
    fs.writeFileSync(handle, `${new Date().toISOString()}\n`);
    fs.closeSync(handle);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

function buildReason(input, config, usage, threshold) {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const handoffPath = path.resolve(cwd, config.handoffFile);
  const nextTask = config.newTaskMode === 'auto'
    ? `如果当前 ChatGPT 客户端向你提供 create_thread 等原生任务工具，请创建一个新任务，让其首条消息读取 ${JSON.stringify(handoffPath)} 并从“下一步”继续；若这些工具不可用，则退回手动方式，明确请用户新建任务并附上该文件。不要通过浏览器或模拟点击实现。`
    : `完成后只在最终回复中给出交接文档的绝对路径，并明确请用户在 ChatGPT 客户端新建任务，把该文件作为首条上下文。`;

  return [
    `当前任务上下文约为 ${usage.inputTokens} 输入 token，已达到交接阈值 ${threshold}。`,
    `不要继续原任务。现在立即在当前工作目录写入 ${JSON.stringify(config.handoffFile)}。`,
    '交接文档必须简洁且可直接供新任务接手，包含：目标与边界、已完成工作、当前事实与证据、已改文件和 Git 状态、未解决问题与风险、最小下一步、验证命令，以及一段可复制的新任务开场提示。不得写入凭据或隐私数据。',
    nextTask,
  ].join('\n\n');
}

function evaluate(input, env = process.env) {
  if (input?.hook_event_name !== 'Stop') return {};
  const config = readConfig(env);
  const usage = latestUsage(input.transcript_path);
  if (!usage) return {};
  const threshold = effectiveThreshold(config, usage);
  const output = config.showTokenStatus ? { systemMessage: buildStatus(config, usage, threshold) } : {};
  if (input.stop_hook_active === true || usage.inputTokens < threshold) return output;
  if (!claimSession(input.session_id, env)) return output;
  return {
    ...output,
    decision: 'block',
    reason: buildReason(input, config, usage, threshold),
  };
}

function main() {
  let output = {};
  try {
    const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
    output = evaluate(JSON.parse(raw));
  } catch (_) {
    output = {};
  }
  process.stdout.write(JSON.stringify(output));
}

if (require.main === module) main();

module.exports = {
  DEFAULTS,
  buildStatus,
  buildReason,
  effectiveThreshold,
  evaluate,
  latestUsage,
  readConfig,
  safeHandoffFile,
};
