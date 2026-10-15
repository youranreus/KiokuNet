# KiokuNet 0.1.0 实现与验收

2026-10-15。设计基线为 `d9c31e8`；首版实现提交 `59e33d3`，之后补充恢复、迁移、后台服务与安装验证。源代码与操作入口见 [README](../README.md)。

## 已实现范围

| 模块 | 行为 |
| --- | --- |
| CLI | Node.js/TypeScript、交互缺参引导、JSON 错误、退出码、私有配置锁 |
| 配对 | Ed25519 邀请与回执、Hub 双向登记、设备密钥固定、重复操作检查 |
| 身份 | 稳定 Agent ID、一机多实例、显式绑定及歧义/冲突拒绝、Hub 本机普通实例 |
| 同步 | 每个 Raw 单写入节点；Hub 汇集；shared 从 Hub 下发；固定 TCP 连接 |
| 依赖 | 复用明确指定或 PATH 中的二进制；缺失时下载并校验官方发布包 |
| 服务 | macOS LaunchAgents、Linux systemd user service/timer；manual 模式；模式切换时注销旧服务 |
| 备份 | rclone 每日快照、30 天保留、下载校验及完成标记、只恢复到新目录 |
| 灾难恢复 | 枚举备份网络、显式选择旧 networkId 恢复；不恢复凭据，不自动切换网络 |
| 生命周期 | 停用、设备撤销、签名迁移材料、种子验证；迁移可重试，可返回旧机器 |
| Skills | kioku-memory、kioku-curate；通过 skills@1.7.2 分发，不在 Skill 中写入机器状态 |
| 诊断 | 服务、连接、文件夹、备份新鲜度/恢复演练、Skill 文件、Linux linger |

实现未加入模型调用、Agent 执行器、任务调度、在线注册、全文向量检索或二进制文档理解。

## 自动化验证

开发环境：macOS arm64，Node.js 22.23.2。真实工具版本：Syncthing 2.1.6、rclone 1.75.2、skills 1.7.2。

全量命令（原生服务与 Skill 安装为显式 opt-in）：

```bash
npm run build
KIOKU_TEST_NATIVE=1 KIOKU_TEST_SKILLS=1 \
  node --test test/*.test.mjs test/integration/*.test.mjs
```

结果：**8/8 通过，0 跳过**。所有用例通过公开 CLI 操作，不 mock 内部模块。

| 用例 | 验证内容 |
| --- | --- |
| 未登记身份 | 结构化报错，不猜身份 |
| 非交互参数 | 缺参、未知参数、知识目录与私有配置重叠被拒绝 |
| 邀请登记 | 签名、重复登记、伪造回执拒绝、Hub 同机新增 Agent |
| 多实例与迁移 | 无绑定歧义、显式绑定、种子要求、已有一致文件重试、A→B→A、旧回执拒绝、撤销 |
| 文件同步 | 两个真实 Syncthing 进程上传 Raw、分发 shared，并保留原文件 |
| 备份恢复 | 真实 rclone 本地后端、恢复旧内容、拒绝覆盖在线目录、新 Hub 恢复旧网络、损坏文件拒绝 |
| 原生服务 | 临时 macOS LaunchAgent 启动/停止；切为 manual 后移除注册文件 |
| Skill 分发 | 临时项目通过 pinned skills CLI 安装 Codex 和 Hermes 的静态 Skill，内容不含实例路径 |

另外执行 TypeScript 检查、Prettier 检查、两份 Skill 格式校验。测试使用临时目录；不会给真实 Hermes 创建任务或读写云账号。

已在全新临时目录验证 CLI 从官方地址自动下载并校验 Syncthing 2.1.6 / rclone 1.75.2；npm tarball 安装后的 `kioku --help` 与打包 Skill 均通过冒烟验证。`test:prepare` 已验证可复用显式依赖。Linux 的服务文件已实现，但尚未在真实 Linux/systemd 上运行验收。

## 审查与修复

### Standards

初审 2 项正确性问题，已修复并回归验证：

1. Hub 配置丢失后无法读取旧网络快照：增加 `backup networks` 和 `--network` 恢复源选择；不改写当前网络身份。
2. 迁移接入中断后被非空目录阻断：验证已有 Raw 是种子历史的一致子集；先完整校验暂存副本，再逐文件原子发布、不覆盖已有文件。

### Spec

初审 4 项规格缺口，已补齐：

1. 旧网络灾难恢复入口。
2. 迁移重试及合法返回已退休旧节点。
3. Hub 本地增加普通 Agent。
4. Linux 原生服务启动前检查并尝试启用 linger；无法启用时显式失败，不报告部署就绪。

复核新增 1 项服务模式切换问题，也已修复：native→manual 时删除本工具 macOS LaunchAgent；Linux disable 并删除对应 user unit/timer。普通 `service stop` 只停止本次运行。

两个轴的初审分别为 2 项和 4 项；复核新增 1 项。发现项均已处理；Linux 原生行为仍需实机验证。

## 首次真实部署验收

尚需用户实际环境信息：Hub 固定 IP/用户及知识目录、Hermes 的 profile/执行环境、云存储目标与其凭据。无需把凭据发给助手，可在 Hub 的 `backup credentials` 向导中录入。

部署时按顺序完成：

1. 在 Linux 初始化 Hub，验证 linger、TCP 端口和重新登录/重启后后台服务。
2. Mac 通过邀请/回执加入；断网写入 Raw，恢复连接后确认 Hub 收到原文件。
3. 把两个 Skill 装到实际 Hermes profile，绑定 Leader；在 Hermes 创建定时整理任务。
4. 使用一条真实 Markdown 记录、一次更正和一个附件验证提炼来源、去重、冲突保留及 shared 下发。
5. 测量从本地 Raw 提交到另一节点可读 shared 的时间；五分钟是目标，当前没有真实模型闭环耗时数据。
6. 配置真实云目标，完成一次备份与新目录恢复，检查下一次计划任务及 24 小时备份新鲜度。

注意边界：

- 本地身份隔离依赖可信协作，不能防御同一系统用户下任意进程越权读写。
- 文件同步为最终一致，多文件发布不提供整体事务；附件与引用可能先后到达。
- 停用/撤销不会抹除历史或远端缓存。迁移前必须停止原 Agent 写入；CLI 不控制 Agent 进程。
- 备份包含 Raw/shared，不含私钥、云凭据、Syncthing 数据库及整理进度。完全灾难恢复需重新配对，整理进度可从来源重建。
- 已完成的快照才计入保留策略；上传失败的未完成目录不参与自动删除，可通过 list 识别后人工清理。
- macOS LaunchAgent 随用户登录运行；全天 Hub 采用开启 linger 的 Linux 用户服务。
