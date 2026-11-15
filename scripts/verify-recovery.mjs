// 恢复演练核对：实际用浏览器页面操作，不直接调用门户内部写接口。
// 每个子情形使用独立门户与独立状态目录；中断通过 SIGKILL 真实发生。
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cases = JSON.parse(await readFile(new URL('../fixtures/recovery-cases.json', import.meta.url)));
const runner = path.join(root, 'scripts/recovery-runner.mjs');

async function child({ source, stateDir, phase, requestId }) {
  const started = new Date().toISOString();
  const startedAt = Date.now();
  const process = spawnNode([runner, source, stateDir, phase, requestId]);
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  await once(process, 'exit');
  return { started, startedAt, code: process.exitCode, signal: process.signalCode, stdout, stderr };
}

function spawnNode(args) {
  return spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function readJournal(stateDir) {
  try {
    const text = await readFile(path.join(stateDir, 'journal.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function portalActions(source) {
  // 只统计真正改变门户状态的页面动作；浏览器对中断响应的自动重发会被门户按幂等受理，
  // 单独计数会把传输层重试误当成第二次预约。
  return source.portal.actions.filter(entry => entry.result === 'applied').map(entry => entry.action);
}

function countTarget(actions, verb, target) {
  return actions.filter(action => action === `${verb}:${target}`).length;
}

async function assertCheck(scenario, source, result, records, evidence) {
  const actions = await portalActions(source);
  const expected = scenario.check ?? {};
  for (const [target, state] of Object.entries(expected.portal ?? {})) {
    assert.equal(source.portal.state[target].state, state, `${scenario.name}: 门户 ${target} 实际为 ${source.portal.state[target].state}`);
  }
  for (const target of expected.forbidReleases ?? []) {
    assert.equal(countTarget(actions, 'release', target), 0, `${scenario.name}: 不应释放 ${target}`);
  }
  for (const [target, maximum] of Object.entries(expected.maxHolds ?? {})) {
    assert.ok(countTarget(actions, 'hold', target) <= maximum, `${scenario.name}: ${target} 保留动作 ${countTarget(actions, 'hold', target)} 次，超出 ${maximum}`);
  }
  for (const [target, maximum] of Object.entries(expected.maxConfirms ?? {})) {
    assert.ok(countTarget(actions, 'confirm', target) <= maximum, `${scenario.name}: ${target} 确认动作 ${countTarget(actions, 'confirm', target)} 次，超出 ${maximum}`);
  }
  assert.equal(source.portal.state.duplicateBookings, 0, `${scenario.name}: 门户记录了重复预约`);
  assert.equal(result.duplicateBookings, 0, `${scenario.name}: 业务结果报告重复预约`);
  assert.equal(result.state, scenario.expected.state);
  const saved = JSON.parse(await readFile(path.join(evidence.stateDir, 'result.json'), 'utf8'));
  assert.equal(saved.state, result.state);
  assert.equal(saved.duplicateBookings, 0);
  for (const record of records) {
    // 中断落盘后再次执行，协调记录必须累计两次尝试，而不是丢掉中断事实。
    assert.ok(record.attempts >= evidence.runs, `${scenario.name}: 协调记录只记录 ${record.attempts} 次尝试`);
    assert.equal(record.requestId, scenario.input.requestId);
  }
  if (scenario.expected.state === 'manual') assert.ok(result.manualReasons.length > 0, `${scenario.name}: 人工处理缺少原因`);
  if (scenario.expected.state === 'confirmed') {
    assert.equal(result.boat.state, 'confirmed');
    assert.equal(result.equipment.state, 'confirmed');
  }
}

const selections = process.argv.slice(2).map(Number).filter(Number.isInteger);
assert.ok(cases.length >= 1, '恢复演练至少需要一个情形');
const usedStateDirs = new Set();
for (const [index, scenario] of cases.entries()) {
  if (selections.length && !selections.includes(index + 1)) continue;
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'recovery-'));
  usedStateDirs.add(stateDir);
  try {
    const actionsBefore = source.portal.actions.length;
    let result;
    let runs = 1;
    let journal = [];
    if (scenario.interrupt) {
      const interrupted = await child({ source: source.url, stateDir, phase: scenario.interrupt.phase, requestId: scenario.input.requestId });
      assert.equal(interrupted.signal, 'SIGKILL', `${scenario.name}: 中断子进程未按预期被强制终止`);
      journal = await readJournal(stateDir);
      const intents = journal.filter(entry => entry.event === 'outcome' && entry.status === 'accepted');
      assert.ok(intents.length > 0, `${scenario.name}: 中断前的动作没有落盘`);
      runs = 2;
      result = await run({ source: source.url, stateDir, input: { ...scenario.input } });
    } else {
      result = await run({ source: source.url, stateDir, input: { ...scenario.input } });
    }
    const recordFiles = (await readdir(path.join(stateDir, 'coordinations'))).filter(name => name.endsWith('.json'));
    assert.equal(recordFiles.length, 1, `${scenario.name}: 应只有一份该请求的协调记录`);
    const records = JSON.parse(await readFile(path.join(stateDir, 'coordinations', recordFiles[0]), 'utf8'));
    if (!scenario.interrupt) journal = await readJournal(stateDir);
    await assertCheck(scenario, source, result, [records], { runs, stateDir });
    assert.ok(source.portal.actions.length > actionsBefore, `${scenario.name}: 没有通过门户页面执行动作`);
    console.log(JSON.stringify({
      scenario: scenario.name,
      runs,
      state: result.state,
      duplicateBookings: result.duplicateBookings,
      boat: { state: result.boat.state, used: result.boat.used },
      equipment: { state: result.equipment.state, used: result.equipment.used },
      manualReasons: result.manualReasons.map(reason => reason.code),
      pageActions: source.portal.actions.map(entry => `${entry.action}[${entry.result}]`),
      holds: { boat: countTarget(source.portal.actions.map(entry => entry.action), 'hold', 'boat'), equipment: countTarget(source.portal.actions.map(entry => entry.action), 'hold', 'equipment') },
      releases: { boat: countTarget(source.portal.actions.map(entry => entry.action), 'release', 'boat'), equipment: countTarget(source.portal.actions.map(entry => entry.action), 'release', 'equipment') },
      journalEvents: journal.map(entry => entry.event),
      attempts: records.attempts,
      portalDuplicateBookings: source.portal.state.duplicateBookings,
    }, null, 2));
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}
assert.equal(usedStateDirs.size, selections.length ? selections.length : cases.length);
console.log('恢复演练核对通过：没有重复占位，没有取消已确认或已使用的预约。');
