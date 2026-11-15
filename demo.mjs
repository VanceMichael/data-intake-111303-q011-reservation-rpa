import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSource } from './src/source.mjs';
import { run } from './src/workflow.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const scenarios = JSON.parse(await readFile(new URL('./fixtures/recovery-cases.json', import.meta.url)));
const runner = path.join(root, 'scripts/recovery-runner.mjs');

// 演示四种业务情形：成功联办、一边失约、确认后失联、人工已接手。
const selection = [
  '执行中进程中断，重启后按业务编号续办成功',
  '设备保留失败，释放未使用的船位',
  '船位确认后执行进程失联，重启后核对并继续',
  '人工已经使用船位，不自动取消',
];

setTimeout(() => { console.error('运行超过 75 秒，停止并保留失败状态'); process.exit(124); }, 75000).unref();

for (const name of selection) {
  const scenario = scenarios.find(item => item.name === name);
  if (!scenario) throw new Error('演示情形缺失：' + name);
  const startedAt = Date.now();
  const source = await startSource(scenario);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'reservation-demo-'));
  try {
    console.log('正在执行：' + scenario.name);
    let interrupted = null;
    if (scenario.interrupt) {
      const child = spawn(process.execPath, [runner, source.url, stateDir, scenario.interrupt.phase, scenario.input.requestId], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      await once(child, 'exit');
      if (child.signalCode !== 'SIGKILL') throw new Error('中断子进程未按预期终止：' + stderr);
      interrupted = { phase: scenario.interrupt.phase, signal: child.signalCode, afterInterrupt: { boat: source.portal.state.boat.state, equipment: source.portal.state.equipment.state } };
    }
    const result = await run({ source: source.url, stateDir, input: { ...scenario.input } });
    const elapsed = Date.now() - startedAt;
    if (elapsed > 15000) throw new Error(scenario.name + ' 超过 15 秒');
    const actions = source.portal.actions.map(entry => `${entry.action}[${entry.result}]`);
    const count = prefix => source.portal.actions.filter(entry => entry.action.startsWith(prefix) && entry.result === 'applied').length;
    console.log(JSON.stringify({
      scenario: scenario.name,
      interrupted,
      elapsedMs: elapsed,
      result,
      portal: {
        boat: { state: source.portal.state.boat.state, used: source.portal.state.boat.used, requestId: source.portal.state.boat.requestId, receipt: source.portal.state.boat.receipt },
        equipment: { state: source.portal.state.equipment.state, used: source.portal.state.equipment.used, requestId: source.portal.state.equipment.requestId, receipt: source.portal.state.equipment.receipt },
        duplicateBookings: source.portal.state.duplicateBookings,
        appliedHolds: { boat: count('hold:boat'), equipment: count('hold:equipment') },
        appliedConfirms: { boat: count('confirm:boat'), equipment: count('confirm:equipment') },
        appliedReleases: { boat: count('release:boat'), equipment: count('release:equipment') },
      },
      pageActions: actions,
    }, null, 2));
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}
