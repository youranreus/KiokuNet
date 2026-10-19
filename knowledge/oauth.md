# OAuth 连接授权

OAuth 为远程客户端提供显式的空间访问授权，不创建 Agent、账号或节点。每次批准建立独立连接。

## 用户流程

1. Hub 启用 MCP，配置 HTTPS 的 `/mcp` 地址及反向代理。
2. 执行 `kioku mcp oauth enable`。
3. 在 Hub 生成预设权限的一次性授权码，例如：

   ```sh
   kioku mcp oauth approve --read-space '*' --shared read-write
   ```

4. 在客户端添加 Hub MCP 地址，进入 Hub 授权页面，输入授权码。
5. 页面展示客户端、回调地址、空间范围和 Shared 权限。全空间读取明确包含未来新增空间。确认后建立连接。

授权码有效 10 分钟且仅使用一次。预设范围在服务端保存，客户端不能扩大。检查范围时会消费授权码并将其绑定当前浏览器请求；取消或超时后须生成新码。不要把授权码输入其他网站。

权限参数与 [MCP 静态密钥](mcp.md)一致，默认无权限。无需先登记任何助手身份，也不要求客户端机器加入网络。客户端注册本身不授予知识访问权。

## 管理

```sh
kioku mcp oauth list
kioku mcp oauth revoke --connection CONNECTION_ID
kioku mcp oauth disable
kioku mcp oauth reset --confirm oauth
```

list 显示连接名称、客户端、明确权限、创建/活动时间及状态。撤销连接使其令牌失效，不删除空间。修改或扩大权限使用新授权流程。

访问令牌有效 15 分钟，刷新令牌轮换。只有成功调用知识工具才延长 90 天闲置期限；持续使用没有固定总期限。停用 OAuth 期间连接不能访问；显式撤销、空间归属变化或长期闲置需要重新授权。更改公共 URL 会使旧 OAuth 授权失效，改回 URL 也不会复活它们。

协议沿用 PKCE S256、精确回调 URI、资源 audience、单次授权码、浏览器请求绑定与刷新重放检测。并发刷新在短重试窗口内返回同一结果，过期重放撤销整条连接。

## 恢复与升级

OAuth 状态位于 `<安装根>/config/oauth/state.json`，与知识存储独立。恢复旧授权状态前，应先在未暴露服务时 reset，再让客户端重新连接；不承诺自动识别任意整机快照回滚。

版本 1 升级会使所有旧静态密钥与 OAuth 连接失效，详见[升级指南](upgrading.md)。新连接按空间和 Shared 授权，不继承旧 member/Leader 角色。
