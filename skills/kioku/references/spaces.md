# 知识空间与目录映射

`kioku space add --space ID` 在当前节点创建空间。ID 在网络内唯一，1–64 位小写字母、数字、下划线、连字符，首位字母或数字。`space list`、`space info --space ID` 查询登记状态和路径。

普通节点离线创建返回 pending，联网后自动登记；conflict 表示标识被其他节点占用，不可改归属强行接管。空间文件直接位于 <安装根>/data/spaces/<id>/。

```sh
kioku space map --space work --path /absolute/project/knowledge
kioku shared map --path /absolute/project/shared
kioku space mappings
kioku space check
```

父目录必须存在，入口必须不存在或已是相同映射。一个空间可以有多个入口，文件为同一份数据。Shared 默认使用只读副本。

Hub 可用 `shared map --path PATH --access read-write` 访问 Shared 本体；`space map --all --path PATH` 提供全部空间只读副本，内容位于 PATH/<space-id>/，没有 raw 层。

`space unmap --path PATH` 或 `shared unmap --path PATH` 只移除匹配的入口，不删除知识。入口被替换后拒绝自动删除。目录映射不自动启动程序、触发阅读或创建助手身份。
