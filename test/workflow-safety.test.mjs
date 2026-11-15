import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run, StateBusyError } from '../src/workflow.mjs';

const base = {
  name: '安全边界', kind: 'browser', mode: 'success', routes: [], productNumber: 11,
  input: { requestId: 'trip-1' },
};

async function withPortal(options, body) {
  const source = await startSource({ ...base, ...options });
  const stateDir = await mkdtemp(path.join(tmpdir(), 'workflow-safety-'));
  try {
    await body({ source, stateDir });
  } finally {
    await source.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('重复执行同一请求只读核对，不再写入', { timeout: 15000 }, async () => {
  await withPortal({}, async ({ source, stateDir }) => {
    const first = await run({ source: source.url, stateDir, input: base.input });
    assert.equal(first.state, 'confirmed');
    const actionsBefore = source.portal.actions.length;
    const second = await run({ source: source.url, stateDir, input: base.input });
    assert.equal(second.state, 'confirmed');
    assert.equal(second.duplicateBookings, 0);
    assert.equal(second.verification.consistent, true);
    assert.deepEqual(source.portal.actions.slice(actionsBefore).map(entry => entry.action), ['lookup', 'lookup']);
    assert.equal(source.portal.state.duplicateBookings, 0);
    assert.equal(JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8')).state, 'confirmed');
  });
});

test('并发执行同一状态目录只有一个执行者，不产生第二份保留', { timeout: 15000 }, async () => {
  await withPortal({}, async ({ source, stateDir }) => {
    // 两个调用同时进入；谁先取得锁不确定，但必须恰好一个执行、一个被拒绝。
    const settled = await Promise.allSettled([
      run({ source: source.url, stateDir, input: base.input }),
      run({ source: source.url, stateDir, input: base.input }),
    ]);
    const fulfilled = settled.filter(entry => entry.status === 'fulfilled');
    const rejected = settled.filter(entry => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1, '应恰好有一个执行者');
    assert.equal(rejected.length, 1, '应恰好有一个并发调用被拒绝');
    assert.ok(rejected[0].reason instanceof StateBusyError || rejected[0].reason.code === 'STATE_BUSY');
    assert.equal(fulfilled[0].value.state, 'confirmed');
    assert.equal(source.portal.state.duplicateBookings, 0);
    const holds = source.portal.actions.filter(entry => entry.result === 'applied' && entry.action.startsWith('hold:'));
    assert.equal(holds.length, 2, '只应有两端各一次真实保留');
  });
});

test('保留到期后按同一业务编号续办，不重复占位', { timeout: 20000 }, async () => {
  await withPortal({ portal: { holdExpiryMs: 500 } }, async ({ source, stateDir }) => {
    const result = await run({
      source: source.url,
      stateDir,
      input: base.input,
      hooks: {
        async afterAction(event) {
          if (event.action === 'hold' && event.target === 'equipment' && event.status === 'accepted') {
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        },
      },
    });
    assert.equal(source.portal.state.duplicateBookings, 0);
    assert.equal(result.duplicateBookings, 0);
    // 两端有效期都很短，最终要么仍完成两边确认，要么据实转人工；不允许编造确认。
    if (result.state === 'confirmed') {
      assert.equal(result.boat.state, 'confirmed');
      assert.equal(result.equipment.state, 'confirmed');
      assert.equal(source.portal.state.boat.state, 'confirmed');
      assert.equal(source.portal.state.equipment.state, 'confirmed');
    } else {
      assert.equal(result.state, 'manual');
      assert.ok(result.manualReasons.length > 0);
      assert.notEqual(result.equipment.state, 'confirmed', '人工结论不能宣称设备已确认');
    }
    // 无论哪种结论，都不能释放已被确认或已被使用的对象。
    const releases = source.portal.actions.filter(entry => entry.action.startsWith('release:') && entry.result === 'applied');
    assert.equal(releases.filter(entry => entry.action === 'release:boat').length, 0, '船位已确认，不应释放');
  });
});

test('门户中途失联时保留已落盘事实并转人工', { timeout: 20000 }, async () => {
  await withPortal({}, async ({ source, stateDir }) => {
    let closed = false;
    const result = await run({
      source: source.url,
      stateDir,
      input: base.input,
      hooks: {
        async afterAction(event) {
          if (!closed && event.action === 'hold' && event.target === 'boat' && event.status === 'accepted') {
            closed = true;
            await source.close();
          }
        },
      },
    });
    assert.equal(result.state, 'manual');
    assert.ok(result.manualReasons.some(reason => reason.code === 'portal-unreachable'));
    assert.equal(result.boat.requestId, 'trip-1');
    assert.equal(result.duplicateBookings, 0);
  });
});

test('协调记录损坏时不猜测，明确要求人工核对', { timeout: 15000 }, async () => {
  await withPortal({}, async ({ source, stateDir }) => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { recordPath } = await import('../src/coordination.mjs');
    const file = recordPath(stateDir, 'trip-1');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{损坏');
    await assert.rejects(run({ source: source.url, stateDir, input: base.input }), /协调记录已损坏/);
    assert.equal(source.portal.actions.length, 0, '记录损坏时不得动手');
  });
});
