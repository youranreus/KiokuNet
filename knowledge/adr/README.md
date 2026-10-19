# KiokuNet 架构决策

当前产品模型以 [0009 机器、知识空间与显式授权](0009-nodes-spaces-and-explicit-access.md) 为准；旧记录保留为历史依据。

记录已确认且会影响后续数据模型或职责边界的重要取舍。ADR 的 accepted 表示设计已确认，不代表代码已实现。

| 决策 | 日期 | 状态与关系 |
| --- | --- | --- |
| [0009 机器、知识空间与显式授权](0009-nodes-spaces-and-explicit-access.md) | 2026-10-19 | 已接受；替代 Agent/Leader 与独立 Workspace 模型 |
| [0001 本地文件与单写入归属](0001-local-files-and-single-writer.md) | 2026-10-15 | 部分由 0004 替代 |
| [0002 基础设施与 Agent 执行分离](0002-separate-infrastructure-and-agent-execution.md) | 2026-10-15 | 部分由 0004 替代 |
| [0003 长期身份与调用绑定分离](0003-stable-agent-identity-and-binding.md) | 2026-10-15 | 部分由 0004 替代 |
| [0004 工作区目录接入与当前状态](0004-workspace-directories-and-current-state.md) | 2026-10-15 | 配对关系及权限要求部分由 0005、0006 替代 |
| [0005 机器入网与来源登记分离](0005-machine-enrollment-and-source-registration.md) | 2026-10-16 | 已实现；Leader 运行地点限制由 0007 调整 |
| [0006 shared 只读副本与工作区防误写](0006-readonly-shared-workspace-copies.md) | 2026-10-16 | 已实现，验收见 [实现记录](../implementation.md) |
| [0007 Hub MCP 接入与远程 Leader](0007-hub-mcp-access.md) | 2026-10-17 | 已接受；实现与验证见 [实现记录](../implementation.md) |
| [0008 Hub OAuth 连接授权](0008-hub-oauth-connections.md) | 2026-10-17 | 已接受；扩展 0007 的凭据签发，保留静态密钥与本机管理边界 |

机器与工作区方案见 [机器入网与 Agent 工作区接入设计](../2026-10-16-machine-and-agent-access-design.md)，覆盖统一安装根、离线来源登记、副本更新与失败行为；新增远程接入见 [Hub MCP 使用指南](../mcp.md)。首版历史背景见 [2026-10-15 设计记录](../2026-10-15-design-record.md)。

当前可执行命令见 [使用指南](../usage.md)。工具版本、安装参数和工程细节保留在设计记录及使用文档中，不为每项操作单独创建 ADR。
