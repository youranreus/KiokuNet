---
name: kioku
description: 介绍 KiokuNet 并使用 CLI 完成安装、节点入网、知识空间管理、目录映射、MCP 授权与排障。用于明确的 KiokuNet 操作或命令错误；不处理普通记忆请求和知识内容。
---

# KiokuNet 使用指南

KiokuNet 管理多台机器上的知识空间，提供本地目录、Syncthing 同步和 Hub MCP 文件访问。它不管理使用方的 Agent 身份、会话、角色或任务调度。

## 产品边界

- Node 是接入网络的机器，可以拥有零个或多个 Knowledge Space。
- Space 是网络内标识唯一、同一时刻只有一个写入节点的知识目录。内容直接位于 data/spaces/<id>/。
- Hub 是中心节点角色，汇集全部空间。普通节点只同步自己的空间和 Shared。
- Shared 暂时独立于普通空间，由 Hub 写入并分发。
- 目录映射是入口配置，没有独立 Workspace 对象。空间可映射多次，Shared 默认使用只读副本；Hub 可显式映射可写 Shared。
- MCP 连接按空间及 Shared 明确授权，默认无权限。全空间读取须显式选择并包含未来空间；写入仅能逐个指定 Hub 所属空间。

本 skill 只解释产品和操作，不制定内容组织、采集、读取、检索或提炼规则。用户可选择安装 kioku-curate，也可自行处理知识；不要自动调用它。

## 操作前

先确认目标机器和安装根，检查已安装版本的 `kioku --help`。不要把仓库新命令当作旧发布版本已经支持。已配置环境通过 `kioku status --json`、`kioku space list --json`、`kioku space mappings --json` 检查现状。

NOT_INITIALIZED 不表示应自动创建网络。UPGRADE_REQUIRED 表示旧配置需要显式迁移，不通过编辑版本号或重跑 init 绕过。空间标识由用户选择，不根据运行器、项目或会话自动猜测。

| 用户意图 | 参考 |
| --- | --- |
| 安装、机器配对、后台服务 | [安装与节点入网](references/setup.md) |
| 创建空间、查询路径、目录映射 | [空间与映射](references/spaces.md) |
| MCP、静态密钥与 OAuth | [远程访问](references/mcp.md) |
| 同步、登记与只读副本诊断 | [诊断](references/operations.md) |
| 解除入口、停用空间、撤销节点、迁移升级 | [生命周期](references/lifecycle.md) |

## 执行约定

`--home` / KIOKU_HOME 指整个安装根，默认 ~/.kiokunet。路径使用目标机器的绝对路径，保持安装根一致。自动化补齐参数并加 --json，同时检查退出码；doctor 和 space check 的不健康结果退出码为 3。

按已有用户授权执行。停用、撤销、迁移等会中断访问的操作，应先说明目标和影响，再取得必要确认；CLI 的 --confirm 不能替代人的授权。既有明确授权无需重复询问。

同步是最终一致，本机写入成功不代表 Hub 已收到。只读副本用于防误写，不构成同账号安全隔离；不要通过改权限或替换入口绕过限制。基础设施排障不修改用户知识内容。
