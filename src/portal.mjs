import { readFile } from 'node:fs/promises';

export function createPortal(scenario, history, options = {}) {
  const actions = [];
  const number = scenario.productNumber;
  const mode = options.portalMode ?? scenario.mode;
  // 门户仍可运行在正常的服务端保留期限下：默认保留会到期，演练可显式选择 free。
  const expiryMs = options.holdExpiryMs !== undefined
    ? options.holdExpiryMs
    : mode === 'free' ? 0 : 4000;
  const rejectConfirm = new Set(options.rejectConfirm ?? []);
  const confirmDelayMs = Number(options.confirmDelayMs ?? 0);
  const loseResponse = new Set(options.loseResponse ?? []);
  const state = {
    mode, number, version: 2, requestId: null, sequence: 0,
    boat: { state: 'available', used: false, requestId: null, receipt: null, expiresAt: null },
    equipment: { state: 'available', used: false, requestId: null, receipt: null, expiresAt: null },
    record: { note: '现场新备注', method: 'manual', container: 'glass' },
    duplicateBookings: 0, duplicateRecords: 0, accepted: {}, rows: [], preview: null,
    point: 'p1', revision: 1, generation: 1,
  };
  let commitCount = 0;
  const changed = () => {
    state.sequence += 1;
    return state;
  };
  const dropResponse = (response, label) => {
    // 服务端已经写入，但响应在返回途中被截断；机器人必须靠回读判断业务结果。
    if (!loseResponse.has(label)) return false;
    loseResponse.delete(label);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.write('{"partial":');
    response.destroy();
    // 页面动作已经到达门户但拿不到完整结果，不改写页面状态。
    return true;
  };
  const writeJson = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  return {
    actions, state,
    async handle(request, response, raw, origin) {
      const address = new URL(request.url, origin);
      if (address.pathname === '/' || address.pathname === '/portal') {
        const html = await readFile(new URL('../web/index.html', import.meta.url));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html); return true;
      }
      if (address.pathname === '/app.mjs') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(new URL('../web/app.mjs', import.meta.url))); return true;
      }
      if (address.pathname === '/frame') {
        const point = mode === 'conflict' ? 'p1' : address.searchParams.get('point');
        const revision = mode === 'conflict' ? 1 : Number(address.searchParams.get('revision'));
        const generation = Number(address.searchParams.get('generation'));
        const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h2>机构甲资料详情</h2><main data-point="${point}" data-revision="${revision}" data-generation="${generation}"><p id="context">观察点 ${point} / 修订 ${revision}</p><button id="download">下载</button><p id="receipt"></p></main><script>
          const notify = () => parent.postMessage({ point: ${JSON.stringify(point)}, revision: ${revision}, generation: ${generation} }, ${JSON.stringify(origin)});
          setTimeout(notify, 35);
          document.querySelector('#download').onclick = async () => {
            const reply = await fetch('/portal/action', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'download',point:${JSON.stringify(point)},revision:${revision},generation:${generation}})});
            const value = await reply.json(); document.querySelector('#receipt').textContent = JSON.stringify(value);
            const link = document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));link.download='sample-'+${JSON.stringify(point)}+'.json';link.click();
          };
        </script></html>`;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return true;
      }
      if (address.pathname === '/portal/state') { writeJson(response, state); return true; }
      if (address.pathname !== '/portal/action') return false;
      if (request.method !== 'POST') { writeJson(response, { error: '只接受页面动作' }, 405); return true; }
      let input;
      try { input = JSON.parse(raw); } catch { writeJson(response, { error: '无效 JSON' }, 400); return true; }
      const action = input.action;
      actions.push({ action: input.target ? action + ':' + input.target : action === 'select' || action === 'download' ? action + ':' + input.point : action, input, userAgent: request.headers['user-agent'], result: 'observed' });
      const mark = value => { actions.at(-1).result = value; };
      if (number === 11) {
        if (action === 'lookup') {
          changed();
          writeJson(response, state); return true;
        }
        if (!['boat', 'equipment'].includes(input.target)) { writeJson(response, { error: '无此预约对象' }, 400); return true; }
        const target = state[input.target];
        const requestId = String(input.requestId ?? '');
        if (!requestId) { writeJson(response, { error: '缺少采样请求号' }, 400); return true; }
        if (action === 'hold') {
          if (input.target === 'equipment' && ['reject', 'consumed'].includes(mode)) {
            if (mode === 'consumed') {
              // 人工在设备侧处理时已经把船位当作实际出船使用，不能再当作可释放的保留。
              state.boat.state = 'confirmed'; state.boat.used = true; state.boat.requestId = state.boat.requestId ?? 'staff-usage';
              state.sequence += 1;
            }
            mark('rejected');
            writeJson(response, { error: '设备无可用位置', state }, 409); return true;
          }
          if (target.state === 'held' || target.state === 'confirmed') {
            if (target.requestId === requestId) {
              if (target.state === 'held' && target.expiresAt != null && target.expiresAt < Date.now()) {
                // 同一请求的保留已过期限但尚未被确认：按同一请求续办，不产生第二份占位。
                target.expiresAt = expiryMs > 0 ? Date.now() + expiryMs : null;
                changed();
                mark('renewed');
                writeJson(response, { ...state, renewed: true, target: input.target }); return true;
              }
              // 同一请求的重复执行按门户事实返回，不制造第二份保留。
              mark('idempotent');
              writeJson(response, { ...state, idempotent: true, target: input.target }); return true;
            }
            state.duplicateBookings += 1;
            mark('duplicate');
            writeJson(response, { error: '该对象已被占用', state }, 409); return true;
          }
          state.requestId = requestId;
          target.state = 'held';
          target.requestId = requestId;
          target.used = false;
          target.expiresAt = expiryMs > 0 ? Date.now() + expiryMs : null;
          target.receipt = input.target + '-' + requestId;
          changed();
          mark('applied');
          if (dropResponse(response, 'hold:' + input.target)) return true;
        }
        if (action === 'confirm') {
          if (rejectConfirm.has(input.target)) {
            if (confirmDelayMs > 0) await new Promise(resolve => setTimeout(resolve, confirmDelayMs));
            mark('rejected');
            writeJson(response, { error: '场所确认被拒绝', state }, 409); return true;
          }
          if (target.state === 'confirmed' && target.requestId === requestId) {
            mark('idempotent');
            writeJson(response, { ...state, idempotent: true, target: input.target }); return true;
          }
          if (target.state !== 'held' || (target.expiresAt != null && target.expiresAt < Date.now())) {
            if (target.state === 'held') { target.state = 'expired'; changed(); }
            mark('rejected');
            writeJson(response, { error: '保留失效', state }, 409); return true;
          }
          target.state = 'confirmed';
          target.expiresAt = null;
          changed();
          mark('applied');
          if (confirmDelayMs > 0) await new Promise(resolve => setTimeout(resolve, confirmDelayMs));
          if (dropResponse(response, 'confirm:' + input.target)) return true;
        }
        if (action === 'release') {
          if (target.used) { mark('rejected'); writeJson(response, { error: '人工已经使用', state }, 409); return true; }
          if (target.state === 'available') {
            mark('idempotent');
            writeJson(response, { ...state, idempotent: true, target: input.target }); return true;
          }
          target.state = 'available';
          target.requestId = null;
          target.receipt = null;
          target.expiresAt = null;
          changed();
          mark('applied');
          if (dropResponse(response, 'release:' + input.target)) return true;
        }
        writeJson(response, state); return true;
      }
      if (number === 12 && action === 'save') {
        if (input.version !== state.version) { writeJson(response, { error: '版本冲突', state }, 409); return true; }
        state.record = { ...state.record, ...input.record };
        if (state.record.method === 'automatic') state.record.container = '';
        state.version += 1;
      }
      if (number === 13 && action === 'generate') {
        writeJson(response, { registration: 'reg-1', revision: 2, failed: mode === 'failed', staleFirst: mode === 'stale' }); return true;
      }
      if (number === 14 && action === 'save') {
        if (input.composing || input.calculatedGeneration !== input.inputGeneration) { writeJson(response, { error: '输入尚未提交' }, 409); return true; }
        if (!/^\d+$/.test(input.record.quantity) || Number(input.record.quantity) <= 0) { writeJson(response, { error: '数量必须为正整数' }, 422); return true; }
        state.record = input.record;
      }
      if (number === 15) {
        if (action === 'select') { state.point = input.point; state.revision = 2; state.generation += 1; }
        if (action === 'download') {
          if (input.point !== state.point || input.revision !== state.revision || input.generation !== state.generation) { writeJson(response, { error: '上下文冲突' }, 409); return true; }
          writeJson(response, { id: 'sample-' + state.point, point: state.point, revision: state.revision, receipt: 'download-' + state.generation }); return true;
        }
      }
      if (number === 20) {
        if (action === 'upload') { state.rows = input.rows; state.preview = null; }
        if (action === 'preview') {
          state.preview = { id: 'preview-' + actions.length, rows: [...state.rows].reverse().map((row, index) => ({ position: index + 1, id: row.id, errors: row.kind === 'water' ? [] : ['unknown-kind'], dependsOn: row.site ? [] : ['site'] })) };
        }
        if (action === 'commit') {
          if (!state.preview) { writeJson(response, { error: '尚未预检' }, 409); return true; }
          commitCount += 1;
          let ready = state.rows.filter(row => row.kind === 'water' && row.site);
          if (mode === 'partial' && commitCount === 1) ready = ready.slice(0, 1);
          for (const row of ready) {
            if (state.accepted[row.id]) state.duplicateRecords += 1;
            else state.accepted[row.id] = { archiveId: 'archive-' + row.id, row };
          }
          state.receipt = 'receipt-' + commitCount;
          if (mode === 'partial' && commitCount === 1) { writeJson(response, { error: '提交后连接丢失，请查询正式回执', receipt: state.receipt }, 503); return true; }
        }
        if (action === 'receipt') { writeJson(response, { receipt: state.receipt ?? null, accepted: state.accepted, duplicateRecords: state.duplicateRecords }); return true; }
      }
      writeJson(response, state); return true;
    },
  };
}
