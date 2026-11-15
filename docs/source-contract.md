# 来源与接收约定

浏览器从 /portal 进入，两个保留对象 boat/equipment，业务 requestId 贯穿操作。先两边保留再确认，设备拒绝时释放未使用的船位；used=true 只能转人工。输出 state=confirmed/released/manual、duplicateBookings 以及两侧凭据。门户动作日志能核对实际交互。

## 边界与操作

浏览器从 `/portal` 进入，只通过页面按钮与页面展示的业务记录操作；`/portal/state` 与 `/portal/action` 仅服务页面，不是机器人可直接调用的业务 API。机器人读取的是页面上的对象状态、请求号、凭据、保留期限与人工使用标记，不读取模拟门户的内部对象。

页面提供按业务请求号的“查询”和“刷新门户状态”，机器人在每次动作前后都用它们回读真实业务事实。页面自身在对象已被有效保留、已经确认或已使用时会阻止重复提交；门户对同一请求的重复保留、确认、释放按幂等返回（`result: idempotent`），只有真正改变门户状态的才记为实际动作（`result: applied/renewed/duplicate/rejected`）。

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 两边确认成功

业务输入：
```json
{
  "requestId": "trip-1"
}
```
结果必须包含：
```json
{
  "state": "confirmed",
  "duplicateBookings": 0
}
```

### 设备保留失败释放船位

业务输入：
```json
{
  "requestId": "trip-1"
}
```
结果必须包含：
```json
{
  "state": "released",
  "duplicateBookings": 0
}
```

### 人工已经使用不可自动取消

业务输入：
```json
{
  "requestId": "trip-1"
}
```
结果必须包含：
```json
{
  "state": "manual",
  "duplicateBookings": 0
}
```

上述三段是 `fixtures/cases.json` 的基线。恢复与补偿情形另见 `fixtures/recovery-cases.json`，覆盖执行中断、确认后失联、确认响应丢失、确认后另一边拒绝、人工已使用。

## 协调记录与恢复

`src/workflow.mjs` 导出的 `run({ source, stateDir, input })` 按 requestId 在状态目录中维护：

- `coordinations/<请求哈希>.json`：协调记录。包含 `state`、`attempts`、两端最新凭据、`manualReasons`、动作与回读历史、最后的落盘核对结果。每次页面动作后先落盘，再进入下一步。
- `journal.jsonl`：只追加的意图与实际结果流水（`intent` 在动作发出前写入，`outcome` 在动作与回读之后写入）。进程被强杀后仍可判断动作是否发出、门户回读是什么。
- `run.lock`：同请求单执行者。并发执行同一状态目录会被拒绝（`STATE_BUSY`）；遗留锁按进程存活判断后替换。
- `result.json`：结构化业务结果，与 `run` 返回值相同。

恢复规则：

1. 每次启动先按 requestId 在页面“查询”回读，不使用内存中上一次会话的旧状态，也不假设上一轮动作成功。
2. 页面动作结果是“成功点击/受理”，不是业务成功。确认与释放都要看回读：同一请求的两端状态、凭据、`used`、`expiresAt`。
3. 确认与释放不是原子组合。任意一端确认后另一端失败时，不释放已经确认的预约；未确认且未使用的一侧保留才可释放，`used=true` 只能转人工。
4. 保留有服务端期限。发现同一请求的保留到期，先在同一业务编号下续办，再确认；续办由门户按 requestId 识别为同一份保留，不产生第二笔。
5. 执行中断后重新进入同一状态目录：已有终态只读核对门户，多为 `lookup`，不再发出任何写动作；核对不一致时保留两边事实并转 `manual`。
6. 重复执行同一 requestId 不会多占位置：门户对同请求动作幂等，机器人也以门户回读为准，不会为了“重试”提交第二份。
7. 确实无法补偿（门户失联、对端已确认、人工已使用、保留无法续办、记录损坏）时返回 `manual`，`manualReasons` 保留两边事实、页面结果与需人工处理的原因；不把不确定写成成功。

结果可增加证据字段，例如 `evidence.actions`（动作与状态）、`evidence.sessionLosses`、`verification`（复用终态时的回读核对）。业务状态 `state` 与 `duplicateBookings` 不可省略。
