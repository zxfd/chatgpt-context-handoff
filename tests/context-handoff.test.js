'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'context-handoff.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'context-handoff-'));
const stateDir = path.join(temp, 'state');
const transcript = path.join(temp, 'transcript.jsonl');

after(() => fs.rmSync(temp, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 810, total_tokens: 900 },
      model_context_window: 1000,
    } } }),
    JSON.stringify({ type: 'response_item', payload: { text: 'later line' } }),
  ].join('\n'));
});

function run(overrides = {}, env = {}) {
  const input = {
    hook_event_name: 'Stop',
    stop_hook_active: false,
    session_id: 'session-1',
    cwd: temp,
    transcript_path: transcript,
    ...overrides,
  };
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTEXT_HANDOFF_STATE_DIR: stateDir,
      CONTEXT_HANDOFF_THRESHOLD_TOKENS: '900',
      CONTEXT_HANDOFF_MAX_CONTEXT_PERCENT: '80',
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('达到实际阈值时只续发一次交接提示', () => {
  const first = run();
  assert.equal(first.decision, 'block');
  assert.equal(first.systemMessage, '上下文 810 / 1.0K（81.0%）｜交接线 800｜距交接 0｜准备交接');
  assert.match(first.reason, /810 输入 token/);
  assert.match(first.reason, /交接文档\.md/);
  assert.equal(run().decision, undefined);
});

test('每轮结束显示 token 状态但不额外续发', () => {
  const active = run({ stop_hook_active: true });
  assert.equal(active.decision, undefined);
  assert.match(active.systemMessage, /准备交接/);
  const low = run({ session_id: 'low' }, { CONTEXT_HANDOFF_MAX_CONTEXT_PERCENT: '90' });
  assert.equal(low.decision, undefined);
  assert.equal(low.systemMessage, '上下文 810 / 1.0K（81.0%）｜交接线 900｜距交接 90｜注意');
  assert.deepEqual(run({ session_id: 'missing', transcript_path: path.join(temp, 'missing') }), {});
});

test('可以关闭每轮 token 状态但保留阈值交接', () => {
  const output = run(
    { session_id: 'status-off' },
    { CONTEXT_HANDOFF_SHOW_TOKEN_STATUS: 'false' },
  );
  assert.equal(output.systemMessage, undefined);
  assert.equal(output.decision, 'block');
});

test('自动模式只请求客户端原生新任务能力并保留手动回退', () => {
  const output = run({ session_id: 'auto' }, { CONTEXT_HANDOFF_NEW_TASK_MODE: 'auto' });
  assert.match(output.reason, /create_thread/);
  assert.match(output.reason, /工具不可用，则退回手动方式/);
  assert.match(output.reason, /不要通过浏览器或模拟点击/);
});

test('不会把压缩前的 token 遥测误当成当前上下文', () => {
  fs.appendFileSync(transcript, `\n${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'context_compacted' },
  })}`);
  assert.deepEqual(run({ session_id: 'compacted' }), {});
});

test('配置路径不能逃出当前工作目录', () => {
  const output = run(
    { session_id: 'safe-path' },
    { CONTEXT_HANDOFF_FILE: '../../secret.md' },
  );
  assert.match(output.reason, /交接文档\.md/);
  assert.doesNotMatch(output.reason, /secret\.md/);
});
