# KiokuNet 架构决策

记录已确认且会影响后续数据模型或职责边界的重要取舍。ADR 的 accepted 表示设计已确认，不代表代码已实现。

| 决策 | 日期 | 状态与关系 |
| --- | --- | --- |
| [0001 本地文件与单写入归属](0001-local-files-and-single-writer.md) | 2026-10-15 | 部分由 0004 替代 |
| [0002 基础设施与 Agent 执行分离](0002-separate-infrastructure-and-agent-execution.md) | 2026-10-15 | 部分由 0004 替代 |
| [0003 长期身份与调用绑定分离](0003-stable-agent-identity-and-binding.md) | 2026-10-15 | 部分由 0004 替代 |
| [0004 工作区目录接入与当前状态](0004-workspace-directories-and-current-state.md) | 2026-10-15 | 配对关系及权限要求部分由 0005、0006 替代 |
| [0005 机器入网与来源登记分离](0005-machine-enrollment-and-source-registration.md) | 2026-10-16 | 已实现，验收见 [实现记录](../implementation.md) |
| [0006 shared 只读副本与工作区防误写](0006-readonly-shared-workspace-copies.md) | 2026-10-16 | 已实现，验收见 [实现记录](../implementation.md) |

最新完整方案见 [机器入网与 Agent 工作区接入设计](../2026-10-16-machine-and-agent-access-design.md)，覆盖统一安装根、离线来源登记、副本更新与失败行为。首版历史背景见 [2026-10-15 设计记录](../2026-10-15-design-record.md)。

当前可执行命令见 [使用指南](../usage.md)。工具版本、安装参数和工程细节保留在设计记录及使用文档中，不为每项操作单独创建 ADR。
