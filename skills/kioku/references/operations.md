# 诊断与运行

先使用只读检查定位问题，保留实际错误码和受影响对象：

```bash
kioku status --json
kioku doctor --json
kioku workspace check --json
kioku service files --json
```

`status` 展示当前网络、来源、入口、同步及后台状态。`doctor` 和 `workspace check` 退出码为 3 时，解析检查结果定位不健康项，不能因为 JSON 的 `ok:true` 就报告健康。`doctor --runtime …` 是可选的额外检查；当前在 Hub 检查 `kioku-curate` 文件发现情况，不证明运行器实际加载，也不用于判断通用 `kioku` 指南是否安装。

| 现象 | 检查与后续操作 |
| --- | --- |
| `NOT_INITIALIZED` | 先核对安装根；确实未配置时，根据用户意图建立 Hub 或接收邀请，不直接重建已有网络。 |
| 节点未连接 Hub | 检查 Hub 是否完成 `enroll`、同步服务是否运行及固定 TCP 地址可达性；只完成 `join` 不代表双向配对完成。 |
| 来源 `pending` | 查看 `status.agents`、网络连接及 `status.worker`；连接恢复后后台会继续登记。 |
| 来源 `conflict` | 读取冲突原因，确认来源归属；使用新的来源 ID 或明确的迁移流程，不接管其他机器的同名来源。 |
| shared 未更新或首次接入失败 | 查看 `status.view` 的成功时间和错误、`status.sync` 以及 `status.worker` 心跳。首次副本需要收到 Hub 标记和内容；刷新失败会保留上次成功副本。 |
| 工作区检查失败 | 用 `workspace list` 核对入口与来源，检查链接是否被替换、路径是否重叠或目标不可用。不要强制覆盖用户文件。 |
| `LOCKED` | 检查是否有仍在执行的操作；确认原进程退出后再处理遗留锁，不直接删除活跃锁。 |
| MCP 不可连接或 `MCP_NOT_READY` | 查看 `mcp status` 的 enabled/running/error；检查端口、反向代理与密钥状态，按 [MCP 接入](mcp.md) 排查。 |
| Skill 安装 `PROCESS_FAILED` | 根据错误检查 npm 网络、缓存和安装目标权限；默认安装源为当前 CLI 包，可核对版本与打包内容。 |

shared 副本中的符号链接或特殊文件会阻止刷新；报告具体问题交由内容维护者处理，本指南不删除或改写知识文件。故障解除后后台自动继续刷新，不需要把入口降级到可写本体。成功生成的副本与跨节点同步都可能短暂落后；本地成功不能替代远端状态验证。

需要启停服务时执行：

```bash
kioku service start --json
kioku service restart --json
kioku service stop --json
```

停止会暂停同步、来源登记、副本刷新和已启用的 MCP，保留已有文件、副本和密钥，不停止 Agent。只有在用户要求改变运行方式时才使用 `--service manual` 或 `--service native` 切换；普通重启沿用现有方式。检查 `service files` 返回的服务定义和相应日志，避免在报告中输出私钥、Bearer 密钥或管理 API 凭据。
