# ChatGPT 与 Hub OAuth 接入

[MCP 使用指南](mcp.md) · [ADR 0008](adr/0008-hub-oauth-connections.md)

OAuth 让 ChatGPT 网页版连接你自己的 Hub，跨聊天使用同一个长期 Agent 身份。每位用户运行自己的 Hub，不需要 KiokuNet 云端账号。OAuth 默认关闭，与现有静态 Bearer 密钥并存，权限仍由 Hub 中登记的 Agent 角色决定。

## 配置与首次授权

在 Hub 本机执行；自定义安装根时给每条命令添加同一个 `--home`：

```bash
kioku source add --agent chatgpt
kioku mcp enable --host 127.0.0.1 --port 7331 \
  --public-url https://knowledge.example.com/mcp
kioku mcp oauth enable
kioku mcp oauth approve --agent chatgpt
```

最后一条命令返回一次性 `credential`、绑定的 Agent/角色和过期时间。凭证 10 分钟有效，只能使用一次；仅在你自己 Hub 的 HTTPS 授权页输入，勿粘贴到聊天、日志或问题报告。CLI 不会自动创建身份。普通 Agent 必须持有 Hub 本地来源；远端节点来源不能借 OAuth 获得第二个写入节点。

在 ChatGPT 的自定义 MCP 连接中填写 `https://knowledge.example.com/mcp`，选择 OAuth，并使用自动客户端注册，无需手动填写 Client ID / Client Secret。ChatGPT 的入口与账号可用性以其实际界面为准。首版采用 DCR，尚不实现 CIMD。[OpenAI 自定义 MCP 文档](https://developers.openai.com/api/docs/guides/custom-mcp-server) · [OpenAI 认证文档](https://developers.openai.com/plugins/build/auth)

浏览器跳转到 Hub 后：

1. 核对浏览器域名、客户端名称及回调地址。客户端名称是客户端自行提供的，不能作为认证证明。
2. 输入一次性凭证，查看绑定 Agent、角色和读写范围。此时凭证已被消费；取消或关闭流程后需重新生成。
3. 填写易识别的连接名称，点击“批准连接”，返回 ChatGPT。

普通 Agent 可读写自己的 Raw、只读 shared；Leader 可读全部活跃 Raw、读写 shared，不能写 Raw。若要使用 Leader，先在 Hub 登记对应身份，再通过 `--agent` 选择它。授权页不允许临时提升角色。

## HTTPS 与反向代理

OAuth 要求配置 HTTPS `publicUrl`，授权服务器与 `/mcp` 同源，部署在独立域名根路径。除 `/mcp` 外，必须转发下列端点，保留请求方法、查询参数、Cookie、Origin 和响应 Set-Cookie：

| 路径 | 用途 |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | MCP 资源发现 |
| `/.well-known/oauth-authorization-server` | 授权服务发现 |
| `/register` | DCR 客户端注册 |
| `/authorize` | 授权入口 |
| `/oauth/consent` | 查看权限、批准或取消 |
| `/token` | 授权码交换与刷新 |
| `/revoke` | OAuth 客户端撤销令牌对应的连接 |

可在已有证书的 Nginx HTTPS `server` 中使用以下配置，替代仅代理 `/mcp` 的示例：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:7331;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 330s;
    client_max_body_size 13m;
}

location ~ ^/(\.well-known/oauth-(authorization-server|protected-resource/mcp)|register|authorize|oauth/consent|token|revoke)$ {
    proxy_pass http://127.0.0.1:7331;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    client_max_body_size 16k;
    # 授权回调查询参数可能含 code/state；不把它们写入访问日志。
    access_log off;
}
```

不需要给 ChatGPT 添加 MCP Origin 通配符。浏览器只在 Hub 页提交授权表单，服务端要求 Origin 精确匹配公开域名，并使用 Secure/HttpOnly/SameSite Cookie 绑定授权浏览器。后端不信任转发头来决定 issuer 或客户端 IP；反向代理可另设按 IP 的限流，不得把请求正文或凭据写入日志。授权页禁用缓存、外部资源和 iframe 嵌入。

## 有效期、续期与权限变更

| 对象 | 行为 |
| --- | --- |
| 一次性批准凭证 | 10 分钟、单次使用，预绑定 Agent |
| 浏览器授权流程 | 最长 10 分钟，不能超过凭证有效期 |
| OAuth 授权码 | 60 秒、单次使用，绑定客户端、精确回调与 S256 PKCE |
| 访问令牌 | 15 分钟，客户端自动刷新 |
| 连接闲置期限 | 90 天；批准时开始计时，成功调用知识工具后重新计时 |
| 授权总期限 | 无固定上限，持续使用无需定期重新批准 |

后台刷新、服务发现、初始化、列出工具和失败的工具调用均不延长闲置期限。刷新令牌轮换后，紧邻的前一代令牌在 30 秒内重试会得到相同的新令牌对，以容忍响应丢失和并发刷新；更早一代或超出窗口的旧令牌重用会撤销该连接。窗口内无法区分正常重试与持有同一令牌的攻击者，这是明确的兼容性取舍。

SDK 使用 `authorization_code` + PKCE S256、`refresh_token`，支持 `none` 和 `client_secret_post` 客户端认证，仅提供 `kioku:access` scope。DCR 回调必须是精确 HTTPS URL，不接受通配、片段或内嵌账号密码。不提供 OIDC ID token 或 `offline_access` scope；有效授权默认签发刷新令牌。单资源 Hub 可在客户端省略 `resource` 时推断为自己的 `/mcp`；提供该参数时必须精确匹配。跨 Hub 的令牌不能复用。

连接的客户端凭据不会随访问令牌到期。未建立连接的 DCR 注册在 24 小时后可清理。授权数据有容量限制：最多 1000 个客户端、1000 条连接记录、100 个待用批准凭证及 200 个待完成授权流程；连接记录达到上限时需重置并重新连接。OAuth 请求体上限 16 KiB，服务级限流每分钟 240 次，SDK 另有注册/授权/令牌端点限流。

每次 MCP 请求和写入提交前都重新检查权限。Agent 停用、角色或写入归属变化会使旧授权永久失效，即使之后改回原值也需重新批准。公开 MCP 地址改变也会使原地址的授权失效。新聊天不创建新 Agent，重新连接不改变已有知识归属。

## 管理与撤销

```bash
kioku mcp oauth list
kioku mcp oauth revoke --connection <连接id>
kioku mcp oauth disable
kioku mcp oauth enable
```

列表包含名称、绑定身份和角色、创建时间、最近使用时间、闲置截止时间及状态，不返回凭据。每次批准形成独立连接，同一 Agent 可有多条连接；撤销其中一条不会影响其他连接或静态密钥。访问令牌与刷新令牌同时失效，无需等满 15 分钟，也不需要重启服务。

关闭 OAuth 暂停所有 OAuth 接入，保留记录；重新开启后仍满足身份与闲置条件的授权可以继续使用。`mcp disable` 则关闭整个 MCP 服务。若希望彻底废止授权，应撤销指定连接或重置 OAuth。

在 ChatGPT 中断开连接不保证通知 Hub。需要确定撤销时，使用 Hub 命令；服务也支持 `/revoke`，但不依赖客户端调用它。撤销不能收回已发送到客户端的知识。

## 重连与备份恢复

闲置过期、撤销或异常重用后，重新生成一次性批准凭证，在 ChatGPT 中重新授权；必要时删除旧连接并重新添加。继续选择原 Agent 即可，不要因此新建来源目录。身份已停用时，先在 Hub 修复或重新登记符合现有生命周期规则的身份。

授权状态位于 `<安装根>/config/oauth/state.json`，独立于知识目录，不参与知识同步。文件权限为 0600，目录权限为 0700；保存令牌签名密钥及可能存在的 OAuth 客户端密钥，按敏感配置保护。批准凭证、浏览器 nonce 和授权码仅存哈希，不存访问/刷新令牌明文。重试所需的令牌由私有签名密钥及连接代次重建。

恢复文件或机器快照时必须按以下顺序：

1. 停止服务并关闭外部访问，恢复所需文件。
2. **开放访问前**在恢复后的 Hub 执行 `kioku mcp oauth reset --confirm oauth`。
3. 启动服务，重新添加 ChatGPT 连接并批准原 Agent。

重置更换令牌签名密钥，并清除客户端注册、待用凭证、授权流程与全部连接记录；不改变 Agent、知识和静态 MCP 密钥。授权数据丢失会拒绝旧令牌；损坏时拒绝读写，不自动覆盖，使用同一重置命令恢复。

当前产品没有自动备份恢复入口。任意整机快照若同时恢复全部授权状态，服务无法自行知道发生了回滚；不能省略上述离线重置步骤，也不能把复制旧 `state.json` 当成安全恢复。

## 验证边界

自动化测试覆盖真实 HTTP、官方 MCP SDK 的发现/DCR/PKCE/自动刷新、角色权限、浏览器绑定、闲置、撤销、令牌重放、重启和恢复操作。尚未以用户真实 ChatGPT 账号、公开域名和 TLS 反向代理完成实机验收。具体测试执行记录见 [实现记录](implementation.md)。
