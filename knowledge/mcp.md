# Hub MCP 使用指南

[使用与运维](usage.md) · [ADR 0007](adr/0007-hub-mcp-access.md)

Hub 可为个人可信客户端提供远程文件和搜索工具。MCP 默认关闭，现有安装无需修改配置；启用后与后台服务一起运行。客户端机器不需要成为 Syncthing 节点，也不需要工作区链接。首批客户端为 Codex、Claude Code，使用手动 Bearer 密钥。

## 身份和密钥

在已初始化的 Hub 上执行；自定义安装根时为每条命令补充同一个 `--home`：

```bash
kioku source add --agent writer
kioku mcp key create --agent writer
# Leader 身份仍在 Hub 登记，运行器可以在其他机器上
kioku source add --agent leader --role leader
kioku mcp key create --agent leader --role leader
kioku mcp key list
kioku mcp key rotate --key <密钥id>
kioku mcp key revoke --key <密钥id>
```

创建返回 `id` 和 `token`。明文只在创建/轮换时显示，私有配置仅保存 SHA-256 校验值；丢失后重新生成。同一身份可有多把密钥，也可跨运行器共用一把。角色省略时采用登记角色，显式指定时必须匹配。普通 Agent 绑定自身同名 Hub 来源；Leader 绑定身份与角色，不获得 Raw 写权限。身份必须活跃、本机持有、角色匹配，不存在时不会自动创建。

轮换在一次配置保存中撤销旧密钥并生成新密钥。列表不返回明文或校验值。每次 HTTP 请求检查授权，停用/迁移身份、角色变化和撤销无需重启；已经完成的请求不回滚。写入在排队后与提交前再次检查授权。密钥管理只提供本机命令，不是 MCP 工具。

## 监听、域名与 HTTPS

```bash
# 公网通过同机反向代理进入，后端只监听回环地址
kioku mcp enable --host 127.0.0.1 --port 7331 \
  --public-url https://knowledge.example.com/mcp
kioku mcp status --json
kioku mcp disable
kioku mcp enable
```

默认监听 `0.0.0.0:7331`，HTTP 端点固定 `/mcp`。`0.0.0.0` 不是客户端连接地址，客户端使用实际 IP 或域名。公网 Bearer 流量通过 HTTPS，证书申请和续期由反向代理负责。`--public-url` 记录外部 HTTPS 地址并允许其 Origin，不配置 DNS、证书或监听端口。代理保留 Authorization，不把明文后端直接暴露到公网。

已有证书的 Nginx HTTPS `server` 中可加入：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:7331/mcp;
    proxy_http_version 1.1;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 330s;
    client_max_body_size 13m;
}
```

域名、TLS 证书和外部端口在现有代理中配置；调整文件上限时同时调整代理请求大小上限。代理与后端不在同机时使用受保护的后端链路。

携带 Origin 的请求必须匹配允许列表，否则返回 403；无 Origin 的客户端可以正常鉴权。自动允许公网地址的 Origin、回环 Origin 和具体监听主机的 Origin。额外来源用 `--allowed-origins https://client.example.com,https://other.example.com`，只接受精确 HTTP(S) Origin，不接受通配符。空字符串清空额外列表；`--public-url ''` 清除外部地址。服务面向桌面/命令行客户端，不实现浏览器 CORS 或 OAuth 登录发现。

启用会在必要时启动现有后台服务；已运行时独立重新配置 MCP，不重启 Syncthing。关闭 MCP 不停止同步。`service stop` 同时停止 MCP、同步、登记和副本刷新；重启恢复此前启用状态和密钥。manual 模式仍不保证登出/重启持久运行，native 沿用现有系统服务。

`mcp status` 和 `status.mcp` 显示 `enabled`、`running`、`applied`、`error`、更新时间和未撤销密钥数量。端口占用时启用命令返回 `MCP_NOT_READY`，配置保留、同步继续，后台每约 5 秒重试。`doctor` 在已启用时检查 MCP 状态。

## 客户端配置

在客户端进程环境中设置专用变量 `KIOKU_MCP_TOKEN`，值为生成的 token；不复用模型服务凭据，不将真实密钥写入项目仓库。配置由客户端所有者管理。

Codex `config.toml`：

```toml
[mcp_servers.kiokunet]
url = "https://knowledge.example.com/mcp"
bearer_token_env_var = "KIOKU_MCP_TOKEN"
```

Claude Code `.mcp.json`：

```json
{
  "mcpServers": {
    "kiokunet": {
      "type": "http",
      "url": "https://knowledge.example.com/mcp",
      "headers": { "Authorization": "Bearer ${KIOKU_MCP_TOKEN}" }
    }
  }
}
```

配置依据：[Codex MCP](https://developers.openai.com/codex/mcp)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。桌面应用未必继承终端环境。更换密钥后更新变量并重连；以实际安装版本的工具发现及调用验收。

使用官方 TypeScript SDK 的无会话 Streamable HTTP，返回 JSON。当前锁定依赖协商的最新协议版本为 `2025-11-25`，兼容范围由 SDK 协商决定，不宣称支持后续未验收版本。GET/DELETE 返回 405，不提供旧式独立 SSE 端点。每次请求均需 Bearer，密钥不能放进 URL。

## 路径、权限和工具

| 身份 | 可读 | 可写 |
| --- | --- | --- |
| 普通 Agent | `/shared`、`/raw/<自己的来源>` | `/raw/<自己的来源>`，且归属于 Hub |
| Leader | `/shared`、全部活跃来源的 `/raw/<来源>` | `/shared` |

`/` 和 `/raw` 用于发现可见目录，来源/系统配置不通过工具创建。MCP 读取 shared 本体，普通 Agent 的只读限制由服务端执行，不依赖工作区只读副本。其他节点尚未同步的内容不会出现。

拒绝路径穿越、反斜杠、空路径段、控制字符、系统路径、符号链接、硬链接和特殊文件。`.stfolder`、`.stversions`、`.stignore`、`.syncthing.*`、`*.kioku-tmp`、`.kioku-shared.json` 不可访问，也不进入列表或搜索。同账号本地文件系统所有者仍受信任，这不是隔离恶意本机进程的系统沙箱。

| 工具 | 参数与行为 |
| --- | --- |
| `list_directory` | `path` 默认 `/`；返回可见条目和可写标记。有 `nextCursor` 时作为下一次 `cursor`，按名称分页，不是快照。 |
| `read_file` | `path`；返回 UTF-8 `content`、完整内容 SHA-256 `version` 和字节数。 |
| `create_directory` | `path`；创建多级目录，已有目录成功，不制造来源根目录。 |
| `create_file` | `path, content`；原子发布，拒绝同名覆盖，父目录须已存在。 |
| `write_file` | `path, content, version`；版本匹配才替换全文。 |
| `edit_file` | `path, oldText, newText, version`；oldText 必须恰好出现一次。 |
| `search_files` | 按文件名搜索，可选择匹配来源根内相对路径。 |
| `search_content` | 返回来源、路径、1 起始行号、片段和匹配关键词。 |

典型流程：列目录 → 读取 → 携带 version 修改 → 再读取确认。`VERSION_CONFLICT` 要求重新读取并判断如何合并，不能盲目重试旧内容。精确替换未命中或不唯一返回 `EDIT_NOT_UNIQUE`；创建遇到同名返回 `ALREADY_EXISTS`。

支持合法 UTF-8 文本，保留 BOM 和换行；拒绝非法编码、未配对 Unicode 代理项及二进制控制字符。大小按 UTF-8 字节计算。MCP 内部对同一文件串行修改，临时文件写完后原子发布；外部原生写入只尽力检测，检查和提交之间仍可能竞争。没有全局条件写入、多文件事务、删除、移动、重命名、历史或恢复工具。

## 多关键词搜索与上限

```json
{"keywords":["记忆","同步"],"mode":"all","caseSensitive":false,"path":"/raw/writer","limit":100}
```

默认 `any` 命中任意关键词；`all` 要求同一文件包含全部关键词，可跨行。关键词为单行字面文本，每个最多 1024 个字符，无正则，默认忽略大小写。`path` 默认全部可读知识，递归扫描，可指定来源、子目录或文件。`search_files` 默认匹配文件名，`matchPath: true` 改为来源根内相对路径；二进制文件也参与名称搜索。

内容搜索合并同一行的多关键词命中，片段最多 400 个字符，截短时标记 `snippetTruncated`。返回 `complete`、`truncated`、`reason`、`scannedFiles`、`skipped`、`skippedCount`；跳过清单本身过长时标记 `skippedTruncated`。超大、非文本、不可访问或变化中的文件明确报告；达到条数/时间上限返回部分结果及原因。不能据此宣称没有匹配。结果顺序不保证，可缩小范围继续搜索，不提供跨请求快照或索引。

| 配置选项 | 默认值 | 最大值 |
| --- | ---: | ---: |
| `--max-file-bytes` | 1048576（1 MiB） | 67108864（64 MiB） |
| `--max-keywords` | 32 | 10000 |
| `--max-results` | 200 | 10000 |
| `--search-timeout-ms` | 10000 | 300000 |

用 `mcp enable` 调整；客户端 `limit` 只能降低上限。目录分页大小采用 `maxResults`。超大文件仍可列出、按名称搜索，内容读写报 `FILE_TOO_LARGE`，内容搜索报告跳过。请求体上限为文件上限的 12 倍加 64 KiB，容纳 JSON 转义与替换参数；同时最多处理 32 个已鉴权请求，繁忙返回 503。时间预算在遍历和处理过程中检查，不承诺中断阻塞的底层磁盘系统调用。

## 日志与验收

`<安装根>/logs/mcp.log` 记录工具调用的时间、身份、密钥 ID、操作、虚拟路径和结果码，不记录 token、正文或搜索关键词。启动故障见状态与现有后台日志。不要将私有配置放进问题报告。

自动化测试使用官方 SDK 客户端、真实 HTTP 和 Syncthing 验证权限、读写搜索、启停重启、端口冲突隔离、远端 Raw 禁写和 shared 分发。实际客户端、公开域名/TLS 和原生服务的运行环境验收边界见 [实现记录](implementation.md)。
