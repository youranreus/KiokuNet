# Hub MCP 接入

在目标 Hub 上先检查 `kioku --help`、`kioku source list --json` 和 `kioku mcp status --json`。仅 Hub 可启用，默认关闭。选择已登记的活跃 Hub 身份，通过 `kioku mcp key create --agent ID --json` 发放密钥，不猜身份或自动创建来源。角色采用登记记录；普通 Agent 绑定自己的 Hub Raw，Leader 只写 shared、读取全部活跃 Raw。

`kioku mcp enable --host 127.0.0.1 --port 7331 --public-url https://实际域名/mcp --json` 适用于同机 HTTPS 反向代理。监听地址和端口可配置；省略时默认监听所有接口。公网域名、TLS 和 DNS 由部署者的反向代理管理。检查 `running` 和 `error`，不能把 `enabled` 当成服务已经就绪。`mcp disable` 只关闭 MCP，`service stop` 同时停止同步与 MCP。

密钥只在生成/轮换时显示；`mcp key list` 查看信息，`mcp key rotate --key ID` 撤销旧密钥并返回新密钥，`mcp key revoke --key ID` 撤销。按用户授权范围操作，生成后交由用户安全保存，不写进知识目录、项目配置或日志。角色变化、停用和迁移会影响已有密钥的有效性。

Codex 配置使用 `url` 与 `bearer_token_env_var = "KIOKU_MCP_TOKEN"`；Claude Code HTTP 配置使用 `headers.Authorization = "Bearer ${KIOKU_MCP_TOKEN}"`。变量由客户端进程环境提供，桌面应用未必继承终端环境。完成工具发现和最小调用后才报告接入成功；手动 Bearer 不等同于 OAuth 登录。

MCP 暴露 `/shared` 和授权的 `/raw/<来源>`，不提供本机管理工具。正文和搜索关键词不进入日志。`VERSION_CONFLICT` 交给内容任务重新读取并合并，本指南不擅自改写知识。远端节点 Raw 不可在 Hub 写入。MCP 故障不停止同步，检查 `status.mcp`、`doctor` 和后台日志，修复后可重新启用。
