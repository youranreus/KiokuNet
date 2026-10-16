---
status: partially superseded by ADR-0004
date: 2026-10-15
---

# 基础设施与 Agent 执行分离

用户已有远端 Hermes，希望 KiokuNet 是接入记忆的 CLI，而不是新的 Agent 执行平台。CLI 管理身份、目录、配对、同步和备份，提供通过现有工具分发的通用 Skill；Hermes 自己配置定时任务并执行提炼，负责 Agent 的运行和失败处理。

此前提议的“CLI 定时调用 Hermes 并自动重试”已被用户明确替代。即使 Hermes 提供非交互接口，KiokuNet 首版也不据此建立执行器；知识流转时效由同步与 Hermes 任务共同决定。Skill 与本机配置分离，更新 Skill 不应重写本地身份和路径。

完整范围见 [设计记录](../2026-10-15-design-record.md)。

后续接入、权限和历史保留规则及其替代关系见 [架构决策索引](README.md)。
