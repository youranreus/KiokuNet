# 问题跟踪：GitHub

本仓库的问题与规格记录在 `youranreus/KiokuNet` 的 GitHub Issues 中。
在仓库目录内使用 `gh` CLI 操作。

## 常用操作

- 创建：`gh issue create --title "..." --body-file <file>`。
  多行正文先写入临时文件，再通过 `--body-file` 传入。
- 读取：`gh issue view <number> --json number,title,body,labels,comments`。
- 列表：`gh issue list --state open --json number,title,body,labels`。
  按需增加标签和状态筛选条件。
- 修改：`gh issue edit <number> --body-file <file>`。
- 评论：`gh issue comment <number> --body-file <file>`。
- 添加或移除标签：`gh issue edit <number> --add-label "..."`，
  或使用 `--remove-label "..."`。
- 关闭：`gh issue close <number> --comment "..."`。
- 关联子问题：`gh issue edit <parent> --add-sub-issue <child>`。
  若无法使用子问题功能，在子问题正文顶部添加 `Part of #<parent>`，
  并在父问题的任务列表中链接该子问题。

技能要求“发布到问题跟踪系统”时，创建 GitHub Issue。
技能要求“获取相关工单”时，读取对应的 GitHub Issue。

## 拉取请求是否参与分诊

**PRs as a request surface: no.**
