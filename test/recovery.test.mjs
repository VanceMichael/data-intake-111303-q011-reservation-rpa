import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cases = JSON.parse(await readFile(new URL('../fixtures/recovery-cases.json', import.meta.url)));
const runner = path.join(root, 'scripts/recovery-runner.mjs');

const byName = name => cases.find(scenario => scenario.name === name);

async function readRecord(stateDir) {
  const files = (await readdir(path.join(stateDir, 'coordinations'))).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1, '同一请求只应有一份协调记录');
  return JSON.parse(await readFile(path.join(stateDir, 'coordinations', files[0]), 'utf8'));
}

function applied(source) {
  // 只统计真正改变门户状态的页面动作；浏览器对截断响应的自动重发由门户按幂等处理。
  return source.portal.actions.filter(entry => entry.result === 'applied').map(entry => entry.action);
}

test('中断后重启：中断点前的事实落盘，重启不重复占位', { timeout: 25000 }, async () => {
  const scenario = byName('执行中进程中断，重启后按业务编号续办成功');
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'recovery-test-'));
  try {
    const child = spawn(process.execPath, [runner, source.url, stateDir, scenario.interrupt.phase, scenario.input.requestId], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    await once(child, 'exit');
    assert.equal(child.signalCode, 'SIGKILL', '中断必须以强制终止真实发生：' + stderr);
    assert.equal(source.portal.state.boat.state, 'held');
    assert.equal(source.portal.state.equipment.state, 'held');

    const result = await run({ source: source.url, stateDir, input: scenario.input });
    assert.equal(result.state, 'confirmed');
    assert.equal(result.duplicateBookings, 0);
    assert.equal(source.portal.state.duplicateBookings, 0);
    const actions = applied(source);
    assert.equal(actions.filter(action => action === 'hold:boat').length, 1);
    assert.equal(actions.filter(action => action === 'hold:equipment').length, 1);
    assert.equal(actions.filter(action => action === 'release:boat').length, 0);
    assert.equal(actions.filter(action => action === 'release:equipment').length, 0);
    assert.equal((await readRecord(stateDir)).attempts, 2);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('确认船位后失联：重启只补做未完成的设备确认', { timeout: 25000 }, async () => {
  const scenario = byName('船位确认后执行进程失联，重启后核对并继续');
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'recovery-test-'));
  try {
    const child = spawn(process.execPath, [runner, source.url, stateDir, scenario.interrupt.phase, scenario.input.requestId], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child, 'exit');
    assert.equal(child.signalCode, 'SIGKILL');
    const result = await run({ source: source.url, stateDir, input: scenario.input });
    assert.equal(result.state, 'confirmed');
    const actions = applied(source);
    assert.equal(actions.filter(action => action === 'confirm:boat').length, 1, '已有确认不应重复提交');
    assert.equal(actions.filter(action => action === 'confirm:equipment').length, 1);
    assert.equal(actions.filter(action => action === 'release:boat').length, 0);
    assert.equal(source.portal.state.duplicateBookings, 0);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('确认响应丢失：回读承认已确认，不误报失败也不重试占位', { timeout: 25000 }, async () => {
  const scenario = byName('船位确认响应丢失，回读确认真实结果');
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'recovery-test-'));
  try {
    const result = await run({ source: source.url, stateDir, input: scenario.input });
    assert.equal(result.state, 'confirmed');
    assert.equal(result.boat.state, 'confirmed');
    assert.equal(result.equipment.state, 'confirmed');
    assert.equal(result.duplicateBookings, 0);
    assert.equal(source.portal.state.duplicateBookings, 0);
    assert.equal(applied(source).filter(action => action === 'confirm:boat').length, 1);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('船位确认后设备被拒：保留两边事实并转人工', { timeout: 25000 }, async () => {
  const scenario = byName('船位确认后设备确认被拒，保留已确认船位转人工');
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'recovery-test-'));
  try {
    const result = await run({ source: source.url, stateDir, input: scenario.input });
    assert.equal(result.state, 'manual');
    assert.equal(result.boat.state, 'confirmed');
    assert.ok(result.manualReasons.some(reason => reason.code === 'confirmed-boat-retained-for-staff'));
    assert.equal(applied(source).filter(action => action === 'release:boat').length, 0, '已确认船位不得释放');
    assert.equal(source.portal.state.boat.state, 'confirmed');
    assert.equal(source.portal.state.duplicateBookings, 0);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('人工已经使用：不自动取消，保留使用事实', { timeout: 25000 }, async () => {
  const scenario = byName('人工已经使用船位，不自动取消');
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'recovery-test-'));
  try {
    const result = await run({ source: source.url, stateDir, input: scenario.input });
    assert.equal(result.state, 'manual');
    assert.equal(result.boat.used, true);
    assert.equal(result.boat.requestId, 'trip-1');
    assert.ok(result.manualReasons.some(reason => reason.code === 'boat-used-by-staff'));
    assert.equal(applied(source).filter(action => action.startsWith('release:')).length, 0);
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
