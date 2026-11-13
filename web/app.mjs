const app = document.querySelector('#app');
let state = await fetch('/portal/state').then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};
const feedback = '<pre id="feedback" aria-live="polite"></pre>';
app.innerHTML = '<p>采样预约联办</p><label>采样请求号<input id="request-id"></label><section id="boat"><h2>船位</h2><button data-target="boat" data-action="hold">保留</button><button data-target="boat" data-action="confirm">确认</button><button data-target="boat" data-action="release">释放</button></section><section id="equipment"><h2>设备</h2><button data-target="equipment" data-action="hold">保留</button><button data-target="equipment" data-action="confirm">确认</button><button data-target="equipment" data-action="release">释放</button></section><button id="lookup">按请求号查询</button>' + feedback;
for (const button of document.querySelectorAll('[data-action]')) button.onclick = async () => {
  const result = await action({ action: button.dataset.action, target: button.dataset.target, requestId: document.querySelector('#request-id').value });
  state = result.value.state ?? result.value;
  for (const target of ['boat', 'equipment']) document.querySelector('#' + target).dataset.state = state[target].state;
};
document.querySelector('#lookup').onclick = () => action({action:'lookup',requestId:document.querySelector('#request-id').value});
