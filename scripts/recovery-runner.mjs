// 恢复演练的子进程：在指定页面动作已由门户受理后强制终止自身，
// 模拟执行进程中断；状态与门户都保持中断瞬间的事实。
import { run } from '../src/workflow.mjs';

const [source, stateDir, phase, requestId = 'trip-1'] = process.argv.slice(2);

const triggers = {
  'after-hold-equipment': ({ action, target, status }) => action === 'hold' && target === 'equipment' && status === 'accepted',
  'after-confirm-boat': ({ action, target, status }) => action === 'confirm' && target === 'boat' && status === 'accepted',
};

const trigger = triggers[phase];
if (!trigger) throw new Error('未知中断时点：' + phase);

const hooks = {
  async afterAction(event) {
    if (!trigger(event)) return;
    process.kill(process.pid, 'SIGKILL');
  },
};

const result = await run({ source, stateDir, input: { requestId }, hooks });
console.log(JSON.stringify(result));
