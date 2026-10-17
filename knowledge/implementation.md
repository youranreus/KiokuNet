# KiokuNet 0.1.0 实现与验收

> 本文记录当前实现与历史验收。当前操作见 [使用指南](usage.md)，决策见 [ADR 索引](adr/README.md)。下方旧版本记录保留历史事实，不能作为当前命令或权限要求。

## Hub MCP 与远程 Leader（2026-10-17）

按已确认的 MCP 访谈方案实现 [ADR 0007](adr/0007-hub-mcp-access.md)，完整操作见 [MCP 使用指南](mcp.md)。

- Hub 显式启用的无会话 Streamable HTTP `/mcp`，默认关闭、监听地址和端口可配置；公网 HTTPS 由反向代理处理，支持外部 URL 与精确 Origin 允许列表。使用官方 TypeScript MCP SDK，不自行实现协议协商。
- 本机命令生成、列出、撤销与原子轮换独立 Bearer 密钥；配置仅保存校验值。请求重新检查身份、角色、活跃状态及 Hub 写入归属；排队写入和提交前再次鉴权。
- 普通 Agent 读写自己的 Hub Raw、只读 shared；Leader 读取全部活跃 Raw、写 shared，远端来源 Raw 禁写。虚拟路径拒绝目录穿越、链接、特殊文件和同步控制文件，大小写别名也不能访问控制文件。
- 8 个工具覆盖目录分页、创建目录、UTF-8 文件读取/创建/全文替换/唯一文本替换、文件名与内容多关键词 any/all 搜索。版本校验与原子提交保护 MCP 内部并发；知识根内串行修改覆盖大小写路径别名。外部原生写入仍只能尽力检测。
- 搜索直接扫描 Hub 本体，支持范围、大小写和结果上限，明确报告跳过、截断及超时。日志记录身份、路径、操作与结果，不记录密钥、正文或关键词。
- MCP 在现有 worker 中有独立的配置与心跳循环，启停、调整端口无需重启同步；监听失败单独报告并重试，整个 service 停止时关闭 MCP。

验证环境：macOS arm64、Node.js 24.14.1、Syncthing 2.1.6、MCP TypeScript SDK 1.32.1。执行 `KIOKU_TEST_NATIVE=1 KIOKU_TEST_SKILLS=1 node --test test/*.test.mjs test/integration/*.test.mjs`：**58 项通过，0 失败、0 跳过**。其中新增 14 项 MCP 协议/文件/鉴权测试和 2 项真实后台/同步集成测试；原生服务测试新增 MCP 启用与连续 50 次重启验证，并断言停止后 launchd 任务已卸载。TypeScript、Prettier、diff 空白检查及 npm 包内容检查通过。

测试经真实 HTTP 和官方 SDK 客户端验证初始化、工具发现、调用、Origin、撤销、分块请求上限、错误响应、权限、并发版本、搜索完整性和日志脱敏；两个真实节点验证远端 Raw 在 Hub MCP 上只读、Leader 发布的 shared 正常分发。临时 macOS LaunchAgent 验证系统托管与重启；Skill 在隔离项目中实际安装。

验证边界：没有部署用户的公开域名、证书或生产 Hub；没有运行 Codex/Claude Code 的实际模型会话，客户端示例依据官方配置文档，互操作验收使用官方 SDK。Linux systemd 本轮未做实机测试。发布前并行测试再次触发 `launchctl bootstrap` 错误 5。诊断捕获旧任务仍处于 `SIGTERMed`：停止逻辑先观察到 worker 状态消失，但 launchd 尚未完成卸载。现已在停止与重新注册前等待该任务从 launchd 消失，最多等待 10 秒，其他查询或卸载错误直接报告。修复后独立 50 次连续重启与原始并行全量 58 项测试均通过，临时诊断日志已移除。

本功能随 v0.4.0 发布，验收未修改现有 KiokuNet 安装。`kioku-curate` 的现有本机工作区进度/锁流程没有自动迁移成 MCP 工作流；远程 Leader 使用 MCP 工具，并由运行器自行维护任务进度。

## 机器与 Agent 接入分离（2026-10-16）

以 `7a12378d62e831df20ee56969f782ba4659ea221` 为基线实现 [接入设计](2026-10-16-machine-and-agent-access-design.md) 与 ADR 0005、0006。

- 安装根默认 `~/.kiokunet`，`--home` / `KIOKU_HOME` 整体切换根目录；data、config、state、logs、bin、views 集中存放。系统服务注册文件、workspace 链接、包管理器安装的 CLI 为约定例外。
- Hub 和节点可先完成机器配对而不创建 Agent。`source add` 在本机登记来源；可信节点通过按设备隔离的 Syncthing 控制文件夹交换签名来源清单和回执，离线创建后自动登记，拒绝来源归属冲突。
- Hub 汇集全部 Raw，普通节点只配置本机 Raw 和 shared。Leader 在 Hub 创建，shared 直接可写，可额外链接全部 Raw。
- 普通 Agent 使用独立复制、文件 0444 / 目录 0555 的 shared 副本，不再要求独立系统账号。原子切换稳定入口；刷新失败保留上一成功副本，状态报告时间与错误，恢复后继续刷新。
- 同一来源可接入多个工作区，保留链接幂等、冲突保护和解除后保留数据的行为。后台 worker 管理同步、登记和刷新，不启动 Agent 或创建提炼任务。

验证环境：macOS arm64、Node.js 22.23.2、Syncthing 2.1.6。全量 `KIOKU_TEST_NATIVE=1 KIOKU_TEST_SKILLS=1 node --test test/*.test.mjs test/integration/*.test.mjs` 为 **25 项通过、0 跳过**。审查后新增异常退出回归，定向运行来源登记故障恢复与进程异常退出 **2 项通过**；当前共 26 项测试。TypeScript、Prettier 和 diff 空白检查通过。

三个验收边界均使用真实接口：公开 CLI 验证布局、配对和来源登记；同账号文件操作验证 Raw 可写、shared 的写入/创建/删除被拒绝、Leader 可写、多个工作区和链接生命周期；两个真实 Syncthing 节点及后台进程验证自动登记、冲突拒绝、Raw 上传、shared 分发、只读副本更新、首次无副本报错、失败保留和自动恢复。另通过真实 macOS LaunchAgent 和隔离项目的 Skill 安装验证。

Standards 初审 2 项、Spec 初审 1 项（其中来源登记问题重合），均已修复，复核无遗留：节点成功应用同步配置后才保存登记状态，避免瞬时失败后不再重试；Syncthing 非主动退出返回非零状态，使 Linux 的 `Restart=on-failure` 能触发重启。两项回归都先复现失败，再验证修复。

本轮没有更新真实云机或现有安装。Linux systemd 新 worker 的实机重启行为仍需部署验证；只读副本定位为防误写，不提供同账号恶意绕过防护，也不承诺跨文件、跨节点事务一致性。本轮不做旧安装布局迁移，来源迁移功能保留。

## 历史：工作区目录接入实现（2026-10-16）

本轮以 `ab09798` 为基线实现 ADR 0004：增加 workspace attach/detach/list/check，使用独立系统账号验证源目录、父目录及私有配置的权限；Leader 保留提炼 Skill，普通 Agent 直接操作文件。移除历史备份、恢复及旧文档保存，现有备份数据不做清理。完整使用和升级步骤见 [使用指南](usage.md)。

验证环境为 macOS arm64，执行 `KIOKU_TEST_NATIVE=1 KIOKU_TEST_SKILLS=1 node --test test/*.test.mjs test/integration/*.test.mjs`：**21 项，20 通过、0 失败、1 跳过**。通过项包括真实 Syncthing 同步、临时 macOS 后台服务、实际 Skill 分发、目录映射幂等与冲突保护、解除接入保留数据，以及 Raw 控制文件符号链接/硬链接越权写入回归测试。TypeScript、Prettier、diff 空白检查通过。

跳过项是清空附加组后切换 nobody/daemon 系统账号进行的实际读写测试，本机没有非交互 root 权限。代码包含此用例，但本轮不声称已完成跨账号实机验收；应在隔离的 root 测试环境及实际运行器中验证。

审查结果：Standards 0 项；Spec 初审及复核共 4 项，均已修复，剩余 0 项。修复了控制文件链接导致的高权限代理写入、校验期间入口被占用却报告成功、已有同步进程未采用新 umask，以及非 root 基础设施缺少安全替换控制文件所需目录写权限。

## 首版历史实现

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
