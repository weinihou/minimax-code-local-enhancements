# 统一安装、迁移与独立控制

0.2.0 提供统一命令行和统一 MCP 入口。源码开发与生产部署分开：本版本先在隔离目录测试，不切换原有两套生产插件。需要 macOS、Node.js 24+，无需 npm install。

## 安装与授权是两个动作

| 选择 | 含义 | 默认 |
|---|---|---|
| enabled | 此模块是否启用 | 关闭 |
| background | 允许独立守护常驻 | 关闭 |
| autostart | 允许登录后自动启动模块守护，需要 background | 关闭 |
| autoRestart | 允许用量条在满足安全条件后自动重启客户端，需要 background | 关闭 |

两模块各存一组选择，互不捆绑。积分限额依赖持续采样，必须先同意后台常驻才可启动；不提供无法持续执行限额的“无后台监控”。用量条可以不授予后台权限而单次注入，但应用重载后需要再次运行，不保证持续恢复。

`repair` 不更改授权、不启用已停用模块，也不触发应用重启。自动重启仅由已授权的用量条后台策略处理；积分模块不申请该权限。连续三次注入失败后，先只读本机运行时 SQLite 索引取得全部本机会话 ID（不读正文、余额或凭据），逐个查询递归活动状态，再检查索引集合未变；最多 256 会话、证明最多四秒，结构变化、截断或任何未知情况均延后。

只有新鲜的全局空闲证明成立，且执行前再次确认授权和空闲，才正常请求退出、等待确认退出、重新打开应用；每次尝试冷却 20 分钟，永不强杀。CDP 缺失时无法证明全局空闲，因此保留手动恢复，不会猜测“已经没人用”。本机索引和活动接口依赖已核实的客户端契约，升级不兼容会停止自动操作。部署前仍需在无任务环境检查真实系统行为。

## 预览与安装

在源码根目录运行：

```bash
npm run manage -- install --data-dir /path/to/profile
```

默认仅输出预览。首次安装必须提供 PNG/JPEG/WebP 图标路径；深色图标可选。图标不随公开源码再分发，使用者应提供有权使用的素材。本机预备的配对图标位置见外层部署记录。

```bash
npm run manage -- install --data-dir /path/to/profile --icon /path/to/icon.png --dark-icon /path/to/icon-dark.png --apply
```

应用必须关闭，旧、新相关 launchd 作业必须都已撤销登记；安装器不会帮你退出应用或停作业。若目录存在旧插件，普通 install 拒绝，改用 migrate 预览。`--data-dir` 省略时从 `MINIMAX_DATA_DIR` 或当前用户 `.minimax` 定位，实际部署前先看预览。

生成的插件位于 `<dataDir>/plugins/minimax-code-local-enhancements`，只声明一个 MCP server，不声明 Hook；不会复制旧模块 MCP、旧巡检、旧自动重启 shell 或旧安装器。安装本身不启动模块、不注册 LaunchAgent、不修改信用积分状态文件。客户端下一次启动会扫描新插件；本轮未在生产客户端验证扫描识别。

## 独立启停

启动积分限额前，确认 MiniMax Code 设置里的「使用积分」已开启，其说明为「开启后，可以在对话中消耗你的积分（含赠予积分）」。守护依靠积分余额下降来计量消耗；该选项关闭时余额不下降，限额不会触发。

显式选择用量条的后台权限，然后启动：

```bash
npm run manage -- configure quotabar --background on
npm run manage -- start quotabar
```

单独启动积分限额、单独停用用量条：

```bash
npm run manage -- configure credit-guard --background on
npm run manage -- start credit-guard
npm run manage -- stop quotabar
```

明确需要登录自启动或自动重启时才设置：

```bash
npm run manage -- configure quotabar --autostart on
npm run manage -- configure quotabar --auto-restart on
```

可一次性撤销相关权限：

```bash
npm run manage -- configure quotabar --background off --autostart off --auto-restart off
```

撤销后台授权要同时撤销依赖它的选择；不接受自相矛盾配置。`stop` 停用模块并撤下其作业登记，保留用户的权限选择但不会在停用状态运行；下次 start 才依照保留选择重新启动。积分模块停用不会自动续跑已暂停会话。

统一 MCP 暴露 `enhancements_status/configure/start/stop/repair`。每次开启权限必须来自用户明确选择，工具调用本身不是授权来源。命令行控制也可加 `--data-dir`，统一入口不会通过导入旧控制脚本绕过新策略。

## 从现有两套插件迁移

```bash
npm run manage -- migrate --data-dir /path/to/profile
```

预览会列出阻塞项、保留文件摘要和动作。只支持同一配置目录的离线迁移，不提供跨账号/跨配置目录状态导入。应用、旧守护和旧巡检未停妥时拒绝 apply，避免同时存在两套控制者。

```bash
npm run manage -- migrate --data-dir /path/to/profile --icon /path/to/icon.png --dark-icon /path/to/icon-dark.png --apply
```

迁移动作：

1. 校验旧 `credit-guard/state.json` 与启用标记，损坏或未知结构拒绝迁移，不清零；迁移前后保留原始字节，包括会话选择、累计消费、暂停所有权及指纹。
2. 将旧插件目录移到 `<dataDir>/local-enhancements/legacy-plugins/`；默认用户配置下的旧 LaunchAgent 文件移到 `legacy-launchagents/`。相关作业须事先撤销登记，不会因移文件就声称已停进程。
3. 安装统一插件。首次创建的新策略仍全部关闭；旧会话限额设置保留，但旧后台授权不会静默继承，需要用户主动选择后启动。

离线准备若通过旧积分守护正常停用，它可能按旧语义取消自动恢复；安装器保留的是迁移时已有的状态，不承诺把停用前的恢复权重新造出来。整个切换过程不要重新打开客户端，直到命令结束。

旧运行日志、余额读数和健康缓存不拷进安装包。安装回执与 SHA-256 只写本机管理目录，不能提交进仓库。

## 更新、回退与中断恢复

更新 install 保留已有统一策略和状态，旧包只保留一个 `previous-package/` 槽位。槽位已有内容时拒绝继续覆盖，需用户先检查并处理；不生成无界备份。

```bash
npm run manage -- rollback --data-dir /path/to/profile
npm run manage -- rollback --data-dir /path/to/profile --apply
```

回退也要求离线，不会回滚余额累计或会话状态，不启动服务。当前统一包移到 `rolled-back-package/` 后，恢复上次包或原插件目录。恢复旧插件/旧 LaunchAgent 文件会使下一次客户端启动或登录重新具备旧版后台行为，执行前必须看回退预览中的提醒。

安装中断会保留 `staging/` 和 `install.lock`，防止下一次盲目覆盖。先检查包路径、回执和锁的进程是否仍在，保留现场；不要直接删除旧插件或状态目录来重试。安装器不自动清理这些证据。

## 验收范围

自动化使用项目外层 `local/work/` 下的隔离配置目录，模拟系统命令和 CDP。覆盖默认关闭、独立控制、撤销权限、离线门槛、字节保留、备份槽位和回退。测试通过不代表真实 launchd、客户端识别与真实重启已经实测；当前生产明确不切换。
