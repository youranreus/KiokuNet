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

已在全新临时目录验证 CLI 从官方地址自动下载并校验 Syncthing 2.1.6 / rclone 1.75.2；npm tarball 安装后的 `kioku --help` 与打包 Skill 均通过冒烟验证。`test:prepare` 已验证可复用显式依赖。Linux 服务的真实部署结果见下文，自动化测试数量仍为上述开发阶段记录。

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

两个轴的初审分别为 2 项和 4 项；复核新增 1 项。发现项均已处理；后续实机部署与尚未覆盖的行为见下文。

## 首次真实部署验收

**2026-10-15 已通过首次 Linux Hub ↔ Mac 端到端验收。** Hub 为 Debian 13，Hermes default profile 承载 `hermes-main`，每 5 分钟运行整理任务；Mac 以 `codex-mac` 通过邀请与回执加入。

Hub 部署报告验证 systemd user service enabled/active、linger=yes 和真实 Skill 加载。Mac 实测验证 TLS 1.3 连接、Hub Raw 完成度 100%，并收到包含自身 Raw 记录 ID 与匹配 SHA-256 的公共文档；最终 Mac `doctor` 全部 10 项通过。网络受阻期间已创建的 Raw 在连接恢复后成功上传。全过程未在 Mac 直接修改 shared。

完整环境、时间线、来源哈希与网络故障诊断更正见 [首次真实部署验收](2026-10-15-linux-hub-e2e-acceptance.md)。

后续仍需完成：

1. Linux 真实重启和退出登录后的后台服务持续运行演练。
2. CNAME → 源站域名解析结构配置与验证；本轮实测仍为直接 A 记录。
3. 真实部署中的附件、冲突与后续 correction 提炼结果验收。
4. 持续测量从 Raw 创建到另一节点可读 shared 的耗时，补充断网重连与长期稳定性验证；本轮不构成五分钟时效承诺。
5. 配置真实云目标，完成备份、新目录恢复及计划任务验证。凭据在 Hub 本机录入，不进入知识库。本轮 Hub 的三个备份检查未通过符合未配置备份的范围。

注意边界：

- 本地身份隔离依赖可信协作，不能防御同一系统用户下任意进程越权读写。
- 文件同步为最终一致，多文件发布不提供整体事务；附件与引用可能先后到达。
- 停用/撤销不会抹除历史或远端缓存。迁移前必须停止原 Agent 写入；CLI 不控制 Agent 进程。
- 备份包含 Raw/shared，不含私钥、云凭据、Syncthing 数据库及整理进度。完全灾难恢复需重新配对，整理进度可从来源重建。
- 已完成的快照才计入保留策略；上传失败的未完成目录不参与自动删除，可通过 list 识别后人工清理。
- macOS LaunchAgent 随用户登录运行；全天 Hub 采用开启 linger 的 Linux 用户服务。
