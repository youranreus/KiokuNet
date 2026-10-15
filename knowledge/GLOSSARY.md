# KiokuNet

KiokuNet 为同一位用户的多个 Agent 提供可追溯的个人记忆网络。以下术语区分知识归属、机器位置与知识维护责任。

## Language

**记忆网络 Memory Network**：
同一位用户拥有、由多个节点和 Agent 实例共同使用的知识共享范围。
_Avoid_：用单个 Agent 的内置记忆指代整个记忆网络。

**节点 Node**：
记忆网络中的机器接入单位，一台机器可以承载多个 Agent 实例。
_Avoid_：将节点与 Agent 实例混称为 Agent。

**运行器 Runtime**：
承载 Agent 执行的工具或系统，例如 Codex、Hermes、Pi。运行器类型不代表某个长期 Agent 的身份。
_Avoid_：用工具名称替代 Agent 实例身份。

**Agent 实例 Agent Instance**：
具有稳定身份和长期知识归属的助手。它可以跨会话工作，也可以在迁移后继续保留同一身份。
_Avoid_：把每次聊天、每个项目或同类运行器的全部使用者自动视为一个独立 Agent。

**Agent 身份 Agent Identity**：
用于区分长期 Agent 实例的稳定标识，记作 `agent_id`。
_Avoid_：机器地址、运行器名称、会话编号。

**会话 Session**：
Agent 实例的一段具体交互或执行过程，是知识来源的补充信息。
_Avoid_：长期身份。

**Hub**：
汇集各 Agent 原始知识并分发公共知识的中心节点角色。
_Avoid_：Leader、公共知识本身。

**Leader**：
能够读取全部接入 Raw，并负责提炼、纠错和维护公共知识的 Agent 角色。
_Avoid_：Hub 机器、任务调度平台。

**原始知识 Raw Knowledge**：
由某个 Agent 实例记录、具有明确来源归属的知识原文，是后续提炼的依据。
_Avoid_：对 Leader 不可见的私密目录、可随时丢弃的缓存。

**公共知识 Shared Knowledge**：
由 Leader 维护、供记忆网络中的 Agent 共同使用的知识。它保留来源，并表达当前结论及仍存在的不确定性。
_Avoid_：全部 Raw 的简单合并、全部内容都已被用户确认的事实集。

**知识提炼 Curation**：
将原始知识整理为可复用公共知识的过程，包括识别重复、处理冲突、保留来源和更新结论。
_Avoid_：删除原文、自动把助手建议升级为用户决策。

**身份绑定 Identity Binding**：
把一次调用或一个执行环境与长期 Agent 实例对应起来的关系。
_Avoid_：设备认证、全机共享的当前 Agent。

**接入邀请 Invitation**：
由 Hub 发起、面向指定 Agent 的加入材料，供新节点识别目标网络和接入意图。
_Avoid_：设备私钥、云存储凭据。

**接入回执 Enrollment Receipt**：
新节点响应邀请产生的设备登记材料，供 Hub 完成双向配对和共享关系配置。
_Avoid_：知识整理回执。

**恢复点 Recovery Point**：
可用于验证和恢复某个历史时刻知识数据的备份版本。
_Avoid_：工作同步副本、持续覆盖的云端目录。
