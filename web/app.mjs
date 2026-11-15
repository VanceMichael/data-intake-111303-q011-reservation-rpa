const app = document.querySelector('#app');

let state = await fetch('/portal/state').then(response => response.json());
let sequence = 0;
const targets = ['boat', 'equipment'];

app.innerHTML = `
  <p>采样预约联办</p>
  <label>采样请求号<input id="request-id" autocomplete="off"></label>
  <section id="boat"><h2>船位</h2>
    <button data-target="boat" data-action="hold">保留</button>
    <button data-target="boat" data-action="confirm">确认</button>
    <button data-target="boat" data-action="release">释放</button>
  </section>
  <section id="equipment"><h2>设备</h2>
    <button data-target="equipment" data-action="hold">保留</button>
    <button data-target="equipment" data-action="confirm">确认</button>
    <button data-target="equipment" data-action="release">释放</button>
  </section>
  <button id="lookup">按请求号查询</button>
  <button id="refresh">刷新门户状态</button>
  <section id="portal-view" data-has-view="1" aria-live="polite"
      data-sequence="0" data-request-id="" data-duplicate-bookings="0"
      data-action-seq="0" data-last-outcome="" data-last-target="" data-last-message="">
    <h2>门户当前记录</h2>
    <p>请求号：<output data-field="request-id">—</output></p>
    <p>重复预约计数：<output data-field="duplicate-bookings">0</output></p>
    <table>
      <thead><tr><th>对象</th><th>状态</th><th>请求号</th><th>凭据</th><th>保留期限</th><th>人工使用</th></tr></thead>
      <tbody>
        <tr id="view-boat" data-target="boat" data-state="" data-used="false" data-receipt="" data-expires-at="" data-request-id="">
          <th>船位</th><td data-field="state">—</td><td data-field="request-id">—</td>
          <td data-field="receipt">—</td><td data-field="expires-at">—</td><td data-field="used">否</td>
        </tr>
        <tr id="view-equipment" data-target="equipment" data-state="" data-used="false" data-receipt="" data-expires-at="" data-request-id="">
          <th>设备</th><td data-field="state">—</td><td data-field="request-id">—</td>
          <td data-field="receipt">—</td><td data-field="expires-at">—</td><td data-field="used">否</td>
        </tr>
      </tbody>
    </table>
    <p id="view-status">等待门户核对</p>
  </section>
  <pre id="feedback" aria-live="polite"></pre>`;

const view = document.querySelector('#portal-view');
const feedback = document.querySelector('#feedback');

function renderState(value) {
  if (!value || typeof value !== 'object' || !value.boat || !value.equipment) return false;
  state = value;
  view.dataset.sequence = String(value.sequence ?? 0);
  view.dataset.requestId = value.requestId ?? '';
  view.dataset.duplicateBookings = String(value.duplicateBookings ?? 0);
  view.querySelector('[data-field="request-id"]').textContent = value.requestId || '—';
  view.querySelector('[data-field="duplicate-bookings"]').textContent = String(value.duplicateBookings ?? 0);
  for (const target of targets) {
    const section = document.querySelector('#' + target);
    const row = document.querySelector('#view-' + target);
    const current = value[target];
    section.dataset.state = current.state;
    row.dataset.state = current.state ?? '';
    row.dataset.used = String(current.used === true);
    row.dataset.receipt = current.receipt ?? '';
    row.dataset.expiresAt = current.expiresAt == null ? '' : String(current.expiresAt);
    row.dataset.requestId = current.requestId ?? '';
    row.querySelector('[data-field="state"]').textContent = current.state;
    row.querySelector('[data-field="request-id"]').textContent = current.requestId || '—';
    row.querySelector('[data-field="receipt"]').textContent = current.receipt || '—';
    row.querySelector('[data-field="expires-at"]').textContent = current.expiresAt == null
      ? '—' : new Date(current.expiresAt).toLocaleTimeString();
    row.querySelector('[data-field="used"]').textContent = current.used ? '是' : '否';
  }
  return true;
}

function settle(outcome, message, value, target) {
  if (value) renderState(value);
  sequence += 1;
  view.dataset.actionSeq = String(sequence);
  view.dataset.lastOutcome = outcome;
  view.dataset.lastTarget = target ?? '';
  view.dataset.lastMessage = message ?? '';
  document.querySelector('#view-status').textContent = message || outcome;
  feedback.textContent = message || outcome;
}

async function post(value) {
  const response = await fetch('/portal/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  return { ok: response.ok, value: await response.json() };
}

async function refresh() {
  try {
    const reply = await fetch('/portal/state', { cache: 'no-store' });
    const value = await reply.json();
    settle('observed', '已按门户回读刷新', value, '');
  } catch (error) {
    settle('network-error', '门户状态读取中断：' + error.message, null, '');
  }
}

function actionReason(target, action) {
  const current = state?.[target];
  if (!current) return '门户没有该预约对象';
  if (action === 'hold' && !['available', 'expired'].includes(current.state)) {
    const expired = current.state === 'held' && current.expiresAt != null && Number(current.expiresAt) < Date.now();
    if (!expired) return '门户显示该对象仍被有效保留，页面未重复提交';
    // 超过保留期限的同一请求可以续办，门户会按业务编号识别为同一份保留。
  }
  if (action === 'confirm' && current.state === 'confirmed') {
    return '门户显示该对象已经确认，页面未重复提交';
  }
  if (action === 'confirm' && current.state !== 'held') {
    return '门户显示该对象没有有效保留，页面未提交确认';
  }
  if (action === 'release' && current.used) {
    return '门户显示该预约已供人工使用，页面不提供释放';
  }
  if (action === 'release' && current.state === 'available') {
    return '门户显示该对象本来就可预约，页面未提交释放';
  }
  return null;
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', async () => {
    const { target, action } = button.dataset;
    const requestId = document.querySelector('#request-id').value.trim();
    if (!requestId) {
      settle('blocked', '请先填写采样请求号', null, target);
      return;
    }
    const reason = actionReason(target, action);
    if (reason) {
      // 页面侧防重：状态已不成立时不再发送动作，避免一次点击制造重复预约。
      settle('blocked', reason, null, target);
      return;
    }
    try {
      const reply = await post({ action, target, requestId });
      const value = reply.value?.state ?? reply.value;
      const message = reply.ok
        ? `${target} ${action} 已由门户受理`
        : `门户拒绝 ${target} ${action}：${reply.value?.error ?? '未知原因'}`;
      settle(reply.ok ? 'accepted' : 'rejected', message, value, target);
    } catch (error) {
      // 服务端可能已经写入，只是响应没有回来；页面不猜测结果，交由回读核对。
      settle('network-error', '动作响应中断，门户事实需刷新核对：' + error.message, null, target);
    }
  });
}

document.querySelector('#lookup').addEventListener('click', async () => {
  const requestId = document.querySelector('#request-id').value.trim();
  if (!requestId) {
    settle('blocked', '请先填写采样请求号', null, '');
    return;
  }
  try {
    const reply = await post({ action: 'lookup', requestId });
    const value = reply.value?.state ?? reply.value;
    settle(reply.ok ? 'observed' : 'rejected', reply.ok ? '已按请求号核对' : (reply.value?.error ?? '核对失败'), value, '');
  } catch (error) {
    settle('network-error', '核对响应中断：' + error.message, null, '');
  }
});

document.querySelector('#refresh').addEventListener('click', refresh);
renderState(state);
