> 历史记录：当前产品概念与接口以 [ADR 0009](adr/0009-nodes-spaces-and-explicit-access.md) 和[使用指南](usage.md)为准；本文保留当时的设计与验证事实。

# Jujutsu 对 KiokuNet 同步与备份方案的影响

- 调研日期：2026-10-15，Asia/Shanghai。
- 状态：调研与候选方案，不修改已接受的 ADR，也不代表已经批准迁移。
- 范围：项目官方 README、官方 latest 文档及官方仓库文档源码；未安装 jj，未进行双机实测。latest 页面可能更新，落地时需要固定版本并验证。

## 判断

**可以重新评估用 Git 传输替换 Syncthing，但 jj 本身不能直接替换后台文件同步，更不能推出“不需要备份”。** jj 的价值主要是降低工作中保存版本、改写提交和撤销操作的成本。它支持普通 Git 远端，因而允许回到 Git 生态；跨设备传播仍须显式 push/fetch 或另建自动化。[项目 README](https://github.com/jj-vcs/jj)、[Bookmarks](https://docs.jj-vcs.dev/latest/bookmarks/)

对 KiokuNet，回归 Git 的更强理由其实是现有的单写入归属：每个 Raw 仅一个写入节点，shared 仅 Leader 写入。这使自动提交和发布较容易约束，普通 Git 也能实现。是否值得迁移，取决于我们是否愿意用“自动版本发布流程”替代现有“目录同步流程”；这是根据本地需求做出的架构判断。[现行 ADR](adr/0001-local-files-and-single-writer.md)、[设计记录](2026-10-15-design-record.md)

## jj 实际提供什么

| 能力 | 核验结果 | 对本项目的含义 |
| --- | --- | --- |
| 工作区自动快照 | 大多数 jj 命令执行时读取工作区并更新工作提交；新文件默认自动追踪，忽略文件除外。并非编辑器每次保存即创建快照。 | Agent 只写文件而不调用 jj 时，不能假定已有版本记录。需接入写入结束动作或后台任务。 |
| 操作历史与撤销 | operation log 记录仓库视图，包括引用位置、可见提交与各 workspace 的工作提交；支持 undo、撤销指定操作及恢复旧视图。 | 很适合修复误操作，但恢复范围取决于已经记录且仍保存的数据。 |
| Git 兼容 | 提交与文件可存入 Git，书签映射为远端 Git 分支。 | 可复用现有 Git 托管和审阅工具。 |
| 推送工作进度 | push 推选定引用可达的提交；工作提交可以通过书签发布，但匿名提交不会因此全部自动上传。 | 自动发布必须明确选择什么内容发布、何时发布以及失败如何重试。 |

依据：[Working copy](https://docs.jj-vcs.dev/latest/working-copy/)、[Operation log 官方源码文档](https://github.com/jj-vcs/jj/blob/main/docs/operation-log.md)、[Bookmarks](https://docs.jj-vcs.dev/latest/bookmarks/)、[push CLI](https://docs.jj-vcs.dev/latest/cli-reference/#jj-git-push)。

例如 Agent 写入一篇 Raw 后立刻断电：若尚未运行快照命令，不能通过 jj 找回未记录的历史；若已快照但尚未成功 push，另一台机器也没有这次内容。这是上述命令触发和传输边界的直接推论。

有两个容易误读的细节：

- 最新 CLI 提供 `--allow-conflicts` 和 `--allow-empty-description`，因此不能断言“未解决冲突或未填写说明的工作永远无法推送”。但这是显式放宽检查；Git 工具看到冲突提交时可能显示 jj 的内部冲突表示，不适合作为共享知识的正常发布格式。[push CLI](https://docs.jj-vcs.dev/latest/cli-reference/#jj-git-push)、[格式映射](https://docs.jj-vcs.dev/latest/git-compatibility/#format-mapping-details)
- README 中的并发复制能力仍标为实验性，指配合 rsync、Dropbox 等复制仓库后的并发处理，并不表示 jj 自带自动传输服务。技术文档还明确列出 Git backend 的已知问题、未充分测试以及 colocated 仓库的额外限制。[README](https://github.com/jj-vcs/jj)、[Concurrency](https://docs.jj-vcs.dev/latest/technical/concurrency/)

## 为什么 operation log 不能替代备份

operation log 与提交存储是不同的后端，`.jj/repo/op_store` 等本地元数据不属于普通 Git push 的仓库完整复制范围。由此可知，另一台机器 clone Git 远端，并不会获得原机器完整的 jj 操作历史。[Architecture](https://docs.jj-vcs.dev/latest/technical/architecture/#storage-independent-apis)

此外，历史并非不可清理：官方 CLI 说明可先 abandon 旧操作，再用 `jj util gc` 清理相关对象；默认过期阈值针对超过两周的 **obsolete** 对象和操作，不能误写为“所有历史两周后自动删除”。[GC CLI](https://docs.jj-vcs.dev/latest/cli-reference/#jj-util-gc)

因此应区分以下恢复需求：

| 场景 | 已发布的 Git 历史能否覆盖 |
| --- | --- |
| 文件误删，但旧提交仍可达 | 通常可以从旧版本取回。 |
| 本机损坏，内容此前已成功推送 | 可从可用远端恢复已推送部分。 |
| 尚未推送、从未被追踪或被忽略的文件 | 不覆盖。 |
| 本地 jj 操作记录、工作区配置 | 普通 Git clone 不等于还原这些状态。 |
| 远端仓库被删、错误改写历史且旧对象不再保留 | 不能只依赖该远端的当前状态。 |

上表是根据版本记录、push 范围和元数据分层做出的故障推演，并非声称这些故障已在本项目发生。GitHub 自己也提供仓库备份流程：mirror clone 后归档，另存到安全位置；LFS 对象须额外获取。[GitHub 仓库备份](https://docs.github.com/en/repositories/archiving-a-github-repository/backing-up-a-repository)

## 如果决定回归 Git，建议怎样收敛

以下为候选设计，尚未实施：

1. **按现有写入和共享边界组织仓库。** 每个 Agent 的 Raw 各自一个仓库，shared 单独一个仓库；Hub 可获取全部 Raw，普通节点仅获取自身 Raw 与 shared。避免为一个总仓库增加多方并发提交，也避免普通节点因 clone 总仓库获得其他 Agent 的 Raw。此建议来自现有共享范围与单 writer 约束。[设计记录](2026-10-15-design-record.md)
2. **后台发布必须明确存在。** 文件写完后快照/提交、推送；Hub 获取成功后再让 Leader 消费；Leader 发布 shared 后，各节点获取并更新本地副本。补齐离线重试、认证失败、推送冲突和发布延迟状态。jj 可以改善其中的本地版本操作，但无法省去这条流程。[官方远端书签模型](https://docs.jj-vcs.dev/latest/bookmarks/)
3. **共享知识采用明确的可消费版本。** 原始记录完成写入后再发布；shared 验证无冲突后发布。默认沿用只追加的提交历史，避免自动反复改写同一个已发布工作提交。即使底层是 jj，服务端限制也应保持可检查；这是为恢复和无人值守操作提出的工程约束。
4. **附件单独评估。** 本项目要求保留 PDF、图片、音视频原件；jj 官方兼容表仍将 Git LFS 标为不支持。因此不能默认将现有附件传输无成本迁入“jj + LFS”。可先以 Markdown/小附件做试点，大附件继续用文件或对象存储。[内容范围](2026-10-15-design-record.md)、[Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/#supported-features)
5. **简化备份实现，而非取消恢复保障。** 可以用每日带日期的 Git bundle 或 mirror 归档替代部分文件快照，另备不在 Git 中的附件；保留校验、独立存放和恢复演练。持续覆盖的单份 mirror 本身不提供固定历史恢复点。bundle 覆盖所选引用的历史，不包括未提交工作、索引及仓库配置等本地状态。[git bundle](https://git-scm.com/docs/git-bundle)、[GitHub 仓库备份](https://docs.github.com/en/repositories/archiving-a-github-repository/backing-up-a-repository)

现有实现已提供每日 rclone 快照、30 天保留、下载校验和完成标记，恢复到新目录；备份范围为 Raw/shared，不含凭据、Syncthing 数据库和整理进度。迁移方案应证明替代后的恢复能力，而不是因引入版本控制就删除这一层。[实现记录](implementation.md)

## 决策建议与验证边界

当前建议：**认可 Git 作为替代同步后端的候选，jj 作为可选的本地版本工具；先保留独立恢复点。** 对当前单 writer 的知识流，普通 Git 自动提交可能已经足够，不能预设增加 jj 依赖必然比现有 Syncthing 更简单。

正式切换前，至少用一条 Raw、一次更正、一个附件跑通两节点断网重连；确认每个节点只获得授权范围的数据；测量写入到 shared 可读的五分钟目标；再从独立归档恢复一个误删版本和一个全新 Hub。上述是针对现有验收目标的迁移验证提案，不是本次已完成的测试。[现有验收边界](implementation.md)
