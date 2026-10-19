# Hub MCP 与空间权限

Hub 可提供远程文本访问，不要求客户端机器加入 Syncthing。服务默认关闭，公网 HTTPS 由反向代理提供；配置管理仍只在 Hub 本机执行。

```sh
kioku mcp enable --host 127.0.0.1 --port 7331 --public-url https://knowledge.example/mcp
kioku mcp status
kioku mcp disable
```

默认监听 0.0.0.0:7331；同机反向代理可显式使用 127.0.0.1。public-url 必须为 HTTPS 的 /mcp，无查询参数或嵌入凭据。精确允许的浏览器 Origin 可用 `--allowed-origins ORIGIN,ORIGIN` 配置。监听失败单独报告，不停止同步。

## 显式授权

每条静态密钥或 OAuth 连接有自己的访问范围，默认无权限：

| 参数 | 含义 |
| --- | --- |
| `--read-space ID` | 读取指定空间，可重复 |
| `--read-space '*'` | 读取全部当前及未来空间，须单独使用并加引号 |
| `--write-space ID` | 读写指定 Hub 所属空间，可重复，不支持通配 |
| `--shared none\|read\|read-write` | 独立的 Shared 权限，默认 none |

```sh
kioku mcp key create --read-space work-mbp --write-space hub-notes --shared read
kioku mcp key create --read-space '*' --shared read-write
kioku mcp key list
kioku mcp key rotate --key KEY_ID
kioku mcp key revoke --key KEY_ID
```

密钥只在创建时显示，服务端仅存哈希。轮换保留相同范围并撤销旧密钥；扩大范围须重新授权。指定空间停用、归属改变或发生登记冲突，会使相关授权失效，状态恢复不复活旧凭据。全空间读取只暴露当前活跃且无冲突的空间，新增空间不会因此获得写入权。远端节点拥有的空间只能在 Hub 读取，MCP 不转发写入。

OAuth 使用相同参数与权限规则，见 [OAuth 流程](oauth.md)。连接名称只是管理标签，不是助手身份。

## 工具与路径

- `/spaces/<id>/...`：授权范围内的空间内容。
- `/shared/...`：独立授权的公共知识。
- `/`：发现当前可读入口；无权限时返回空列表。

提供 `list_directory`、`read_file`、`create_directory`、`create_file`、`write_file`、`edit_file`、`search_files`、`search_content`。旧 `/raw` 路径不再支持。返回来源信息使用 `space` 字段。

读文件返回版本哈希；修改必须带版本。create 不覆盖已有文件，edit 要求目标文本仅出现一次。文本为 UTF-8，不提供删除、重命名、任意文件系统路径、二进制写入或历史恢复。拒绝穿越、符号链接、硬链接和同步控制文件。

搜索是递归的字面关键词匹配，支持 any/all、大小写选择、文件名或正文。默认最多 32 个关键词、200 条结果、10 秒扫描预算，文本上限 1 MiB；由 `--max-keywords`、`--max-results`、`--search-timeout-ms`、`--max-file-bytes` 配置。读取 complete、skipped、truncated 字段，不能把部分结果当作全量检索结论。

同一 Hub MCP 的写操作串行校验并原子提交，但直接本地写入不受同一把锁控制，不承诺全局防丢失更新。日志只记录连接标识、路径、操作和结果，不记录令牌、正文或搜索关键词。
