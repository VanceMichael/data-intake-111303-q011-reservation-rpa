# 来源与接收约定

浏览器从 /portal 进入，两个保留对象 boat/equipment，业务 requestId 贯穿操作。先两边保留再确认，设备拒绝时释放未使用的船位；used=true 只能转人工。输出 state=confirmed/released/manual、duplicateBookings 以及两侧凭据。门户动作日志能核对实际交互。

## 边界与操作

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
