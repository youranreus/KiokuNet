# KiokuNet

面向个人多 Agent 协作的文件式记忆网络。各 Agent 在本地维护独立 Raw，远端 Hermes Leader 提炼公共知识；CLI 负责身份、路径、设备接入、同步和备份基础设施。

当前阶段：已完成首版设计讨论，尚未实现 CLI 或部署服务。以下文档记录截至 2026-10-15 的已确认方案。

- [设计讨论记录](knowledge/2026-10-15-design-record.md)：范围、职责、数据流、确认过程和待落实事项。
- [首版 CLI 草案](knowledge/cli-draft.md)：命令职责、接入流程、身份解析和验收场景；示例命令尚不可执行。
- [领域术语](knowledge/GLOSSARY.md)：节点、运行器、Agent 实例、会话、Leader、Raw 和公共知识。
- [架构决策](knowledge/adr/README.md)：重要取舍及其原因。

跨工具共享的项目知识保存在 `knowledge/`。后续编写 Skill 时使用 `skills/`；本轮未创建运行时 Skill、业务代码或任务工单。
