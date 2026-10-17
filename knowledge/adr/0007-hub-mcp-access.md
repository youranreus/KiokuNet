---
status: accepted
date: 2026-10-17
---

# Hub MCP 接入与远程 Leader

个人 AI 客户端需要在没有本地工作区入口的机器上读取和维护知识。决定由 Hub 提供默认关闭、显式启用的 MCP 服务，以程序生成的独立 Bearer 密钥绑定已登记 Agent 身份与角色；公开 HTTPS 由反向代理承担。普通 Agent 读写归属于 Hub 的自己的 Raw、只读 shared；Leader 读取全部活跃来源 Raw、维护 shared。工具使用虚拟路径并执行访问检查，不能访问系统任意文件、跟随知识目录内链接或修改归属于其他节点的 Raw。密钥管理只在 Hub 本机进行，不把远程文件访问扩展成机器入网或来源管理 API。

允许 Leader 的运行器通过 MCP 远程执行，而 shared 的持有与写入节点仍是 Hub。这调整 [ADR 0005](0005-machine-enrollment-and-source-registration.md) 中 Leader 必须位于 Hub 的运行地点限制，保留机器配对、单写入节点、来源登记及不执行 Agent 任务的边界。MCP 普通 Agent 从 shared 本体读取，由服务端拒绝写入；[ADR 0006](0006-readonly-shared-workspace-copies.md) 的只读副本继续服务于本机工作区，两种接入方式不互相降级。

首版提供 UTF-8 文件读写、目录操作及多关键词字面搜索，直接扫描 Hub 当前本地文件，不建立索引或跨请求快照。读取返回版本，修改串行校验并原子提交。保留原生文件工具的代价是无法让所有写入者遵守同一个锁：外部直接写入只能尽力检测冲突，不承诺全局条件写入、防丢失更新或历史恢复。MCP 监听故障单独报告，不使同步停止。具体命令、上限与兼容性见 [MCP 使用指南](../mcp.md)。
