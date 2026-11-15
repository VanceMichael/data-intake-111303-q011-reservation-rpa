# 跨门户预约联办的保留与补偿自动化

这是 reservation-rpa 的 Node.js 项目。现有能力是本地资料源启动、来源检查、接口演练，以及跨门户采样预约联办的浏览器工作流。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。浏览器使用 Playwright 1.56.1 与 Chromium，镜像中包含匹配的浏览器。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t reservation-rpa:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
npm run acceptance
npm run recovery
npm run demo
npm start -- --host 127.0.0.1 --port 3000
```

`npm test` 检查资料源、真实浏览器页面、基线业务结果、并发/恢复安全边界与中断重启。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

`npm start` 启动带业务接口的门户服务，首页与 `/portal` 均可操作。可用 `HOST`、`PORT` 配置监听地址，也可通过 `--host`、`--port` 覆盖；默认使用回环地址和自动分配端口。页面与 `/portal/state`、`/portal/action` 必须由同一进程提供，不能只用静态文件服务器托管 web 目录。

## 工作流接入

业务入口为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入（至少 `requestId`），stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json。不能依赖调用方持有的内存来完成恢复。

- 浏览器会话为 `src/browser.mjs`：Playwright 从 /portal 进入，按 requestId 查询回读页面业务记录，再按需点保留/确认/释放。会话断开时重建新会话，并从门户回读重新定位进度。
- 协调记录为 `src/coordination.mjs`：`coordinations/` 每请求一份记录，`journal.jsonl` 记录动作前意图与动作后回读，`run.lock` 防止同一状态目录并发执行。
- 浏览器从 /portal 进入，两个保留对象 boat/equipment，业务 requestId 贯穿操作。先两边保留再确认，设备拒绝时释放未使用的船位；used=true 只能转人工。输出 state=confirmed/released/manual、duplicateBookings 以及两侧凭据。
- 页面动作受理不等于业务成功：确认与释放都以门户回读为准；已确认或已使用的预约不因“回滚”被取消；同请求保留到期按同一业务编号续办，不产生第二份。
- 无法补偿时返回 manual，`manualReasons` 保留两侧事实和人工处理原因。详细语义见 `docs/source-contract.md`。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance   # 基线结果、落盘内容、实际门户动作、安全边界与中断恢复测试
npm run recovery     # 六种恢复情形的端到端核对，打印实际页面动作与是否多占/误取消
npm run demo         # 成功联办、一边失约、确认后失联、人工已接手
```

acceptance 检查结果与 result.json 一致、实际经页面访问门户，并覆盖并发执行、终态复用、保留到期、门户失联和协调记录损坏。recovery / demo 从干净临时状态启动本地门户，真实执行；中断情形由子进程 `SIGKILL` 产生，随后在同一状态目录恢复。每种情形在 15 秒内完成，整次演示 75 秒超时。

容器内执行基线检查：`docker run --rm --network none reservation-rpa:local npm test`。完整演练执行 `docker run --rm --network none reservation-rpa:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
