# 源码来源与版本差异

初始基线来自已安装的 quotabar 1.1.0 与 credit-guard 1.0.2，29 个模块文件的原件及 SHA-256 清单留在外层 local/backups/，没有复制运行状态。两份原始模拟测试调整相对导入后迁入 tests/。

## 归档参数化

- credit 默认状态路径使用 homedir()，保留 CREDIT_GUARD_STATE_DIR；新增 CREDIT_GUARD_PORT 与显式端口参数。
- quotabar 旧 start.sh 的 Node 兜底改为 HOME 相对路径；旧 plist 改成带占位符的 .plist.in 模板。这些旧安装脚本仅留作历史参考，不进入统一包。
- 模块旧声明移除个人署名与未核实许可的图标引用，旧 Skill 未直接迁入。
- 没有收录真实会话测试脚本、账号凭据、日志、配置快照或应用提取物。

## 文档截图

`docs/images/` 下四张 PNG 是本机 MiniMax Code 3.1.16 的界面截图，用于 README 与模块说明：整体界面、额度条悬停读数、会话右键菜单、限额设置弹窗。已统一缩放到 1600 px 宽，仅作说明用途，不参与构建，也不进入安装包。

这些是仓库内唯一的二进制内容，图中可见账号名称、积分读数和会话名；这几项已确认不敏感，保留原样。`scripts/check.mjs` 只对 `docs/images/` 下的 PNG 放行并校验文件头，其他位置的二进制仍按需人工复核处理。

截图摄于项目改名之前，侧边栏分组显示的还是旧标签。改名后分组标题随插件显示名一起更新，截图需重新截取才能对上。

## 统一入口 0.2.0

新增 runtime/ 控制器、授权配置、系统后端、独立 supervisor 和单 MCP server；scripts/ 提供预览优先的安装、同配置离线迁移和固定槽位回退。

安装白名单只包含 credit-guard 的 core、engine、lib、daemon、page-adapter、ui，以及 quotabar 的共享库与 page-script；另带统一 runtime。不复制旧 MCP、Hook、控制器或任何旧 shell。统一版本由安装器、package.json 与统一 MCP serverInfo 使用 0.2.0。

credit daemon 在统一模式下核对新授权与提前处理优雅退出信号，仍保留原预算停止与取消自动恢复的收尾语义。quotabar CDP 选择取消任意 page 回退，仅选应用 app:// 页面。

旧 quotabar ensure.sh 的 bootstrap/notify 粘连行、旧控制器会移除旧 job 等历史行为仍可在归档文件看到，但不再是统一包的运行路径。旧 credit MCP serverInfo 1.0.1 也只属于未打包的历史控制入口。

这些改动仅在维护仓库和隔离测试包内；生产插件未回写。不要把源码完成与测试通过说成已完成生产迁移或客户端扫描识别。
