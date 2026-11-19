# 统一维护入口

人的入口是 README，Agent 的入口是 AGENTS.md 和本文。`npm run manage -- help` 展示统一操作；安装步骤见 [installation.md](installation.md)。不增加 Mini App 或管理看板。

## 修改与部署

1. 读对应模块说明，区分源码开发与当前生产操作；实际安装位置在仓库外 local/DEPLOYMENT.md。
2. 模块业务改动在 modules/，统一权限、进程与 MCP 改动在 runtime/，安装迁移在 scripts/installer.mjs。旧模块 MCP/Hook/shell 不进入统一包，不能调用它们绕过授权。
3. 权限分别保存，不因一个模块启停改变另一个；新增入口必须说明后台行为、数据与完整退出路径。
4. 跑 `npm run check` 和 `npm test`，测试在外层 local/work/ 写模拟资料，系统命令与页面接口注入假实现，不得连真实 CDP 或启停当前守护。
5. 需要实际部署时明确授权范围，先看 install/migrate/rollback 预览。迁移要求离线、相关作业未登记；不得为迁移顺手强杀客户端、清空累计或取消用户选择。
6. 部署后在外层记录结果，保留固定上次代码槽位；未授权不提交、推送、重启或发布。

## 状态与故障

`npm run status` 查看统一控制器的配置与模块状态；`npm run status:legacy` 查看旧生产摘要。状态查询不执行页面修复。模块状态错误分别返回；损坏的全局配置直接报错，不自动重置用户选择。

`repair` 只修复已启用模块并遵守权限，不授权、不重启应用。`stop` 保存停用状态，停止作业并撤下自启动登记；暂停会话不自动续跑。后台退出超时应报告失败，不能强杀后声称完成。

install.lock/staging 用于阻断并发或中断覆盖；control.lock 用于序列化权限与控制操作。不要看到锁就自动删除，先核对进程和现场。配置损坏、未知状态版本、备份槽位占用都需人工确认，不能悄悄清零或覆盖。

## 后台与自启动

只使用统一模块标签 `com.minimax.local-enhancements.quotabar` 与 `.credit-guard`。后台权限本身不允许登录自启动；RunAtLoad plist 只有明确选择 autostart 后才写入。无插件 SessionStart Hook，无旧一分钟巡检。supervisor 反复核对授权，失效或撤销时安全退出。

用量条未授权后台时只能单次页面注入；页面本身仍有刷新计时器，应在文档和返回值中明确。积分限额需要持续监控，不能把无后台模式包装成有效限额。
