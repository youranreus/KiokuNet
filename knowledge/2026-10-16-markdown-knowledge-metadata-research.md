> 历史记录：当前产品概念与接口以 [ADR 0009](adr/0009-nodes-spaces-and-explicit-access.md) 和[使用指南](usage.md)为准；本文保留当时的设计与验证事实。

# Markdown 知识文件元数据规范与 KiokuNet 适用性

- 调研日期：2026-10-16，Asia/Shanghai。
- 状态：调研与候选约定，不修改已接受的 ADR，不代表已经实施。
- 范围：CommonMark 0.31.2、GFM 正式规范、YAML 1.2.2，以及 Agent Skills、Jekyll、Pandoc、Obsidian、DCMI、W3C 的官方资料。在线产品文档会变化，实施时应固定解析器与规则版本。

> 同步复核（2026-10-19）：本报告的本地核查基于 2026-10-16 的提交 `a50264d` 及当时安装副本。最新 master `7978d4f` 已包含 [Shared 输出约定与模板](../skills/kioku-curate/references/shared-format.md)：主题文档采用 `schema: kiokunet.shared/v1`、`title`、`updated`、`status`，逐项来源保存在正文表格，不确定性在具体结论旁说明；新目录使用 `Index.md`。因此，下文“尚未统一字段与模板”仅描述调研时的状态，候选 `certainty`、`sources` 等字段不属于当前默认格式。CLI 自动 schema 校验仍未实现，发布前检查由 Leader 执行。另见 [知识组织调研及采纳记录](2026-10-16-shared-knowledge-organization-research.md)。

## 判断

**Markdown 有正文语法规范，但本次核验的规范没有规定一套“知识文件必须带哪些元数据”的通用格式。** YAML front matter 是多个工具支持的应用约定；是否必填、字段叫什么、如何解析，由消费这些文件的工具或项目决定。缺少 front matter 本身，不构成违反 CommonMark 或 GFM。[CommonMark](https://spec.commonmark.org/0.31.2/)、[GFM](https://github.github.com/gfm/)、[Jekyll front matter](https://jekyllrb.com/docs/front-matter/)

必须把两个问题分开：`SKILL.md` 是供运行器发现和加载的技能包入口，有 Agent Skills 的具体格式要求；Raw/shared 中的知识文件是业务内容，不会因为由 Skill 生成，就自动继承 `SKILL.md` 的字段要求。[Agent Skills 规范](https://agentskills.io/specification)

## 四层规范分别管什么

| 层次 | 规范或约定 | 约束范围 | 不应推导出的结论 |
| --- | --- | --- | --- |
| 正文语法 | CommonMark、GFM | 标题、列表、链接、代码块等；GFM 增加表格、任务列表等扩展 | 所有 `.md` 都必须有标题、作者、日期或 YAML 头 |
| 元数据序列化 | YAML | 映射、序列、标量、类型解析等 | `title`、`sources`、`updated_at` 是 YAML 强制字段 |
| 文件封装与工具行为 | Jekyll、Pandoc、Obsidian 等 | 从哪里提取 metadata、接受哪些格式、如何呈现属性 | 一个工具能识别，另一个工具就一定具有相同语义 |
| 业务语义 | 项目 schema；可参考 DCMI、PROV | 字段含义、必填性、来源关系、状态和生命周期 | 使用相似字段名就已经完整遵循某个外部标准 |

前三层依据：[CommonMark](https://spec.commonmark.org/0.31.2/)、[GFM](https://github.github.com/gfm/)、[YAML 1.2.2](https://yaml.org/spec/1.2.2/)、[Jekyll](https://jekyllrb.com/docs/front-matter/)、[Pandoc metadata block](https://pandoc.org/MANUAL.html#extension-yaml_metadata_block)。第四层是本报告对标准适用边界的归纳，语义参考见下文。

CommonMark/GFM 没有为 front matter 定义独立节点。若没有额外提取步骤，`---` 可能作为分隔线，后续文字与 `---` 还可能组成 Setext 标题；“渲染没有报错”不能证明头部被当作元数据。该判断来自语法规则，而非本次对 Kioku 运行器的渲染实测。[CommonMark 分隔线](https://spec.commonmark.org/0.31.2/#thematic-breaks)、[Setext 标题](https://spec.commonmark.org/0.31.2/#setext-headings)

## YAML front matter 的实际边界

常见写法是在文件起始位置用两行 `---` 包围 YAML 映射，随后写 Markdown。**这一封装规则与 YAML 语言规范应分开理解**：YAML 流中的 `---` 标识文档开始，显式结束标识是 `...`；front matter 的第二行 `---` 充当封装结束符，是宿主工具的约定。[YAML 文档标记](https://yaml.org/spec/1.2.2/#912-document-markers)、[Jekyll front matter](https://jekyllrb.com/docs/front-matter/)

| 工具 | 官方行为 | 对可移植知识文件的影响 |
| --- | --- | --- |
| Jekyll | 头部位于文件最开始，使用 `---` 包围合法 YAML；允许自定义变量 | 可以借用封装，但 Jekyll 的页面字段不是知识库通用必填项 |
| Pandoc | `yaml_metadata_block` 是扩展；可用 `---` 或 `...` 结束，满足条件时也可出现在正文中；支持嵌套对象 | 不宜把 Pandoc 的宽松规则默认要求所有读取器支持 |
| Obsidian | Properties 存于文件顶部的 YAML，属性名唯一；属性界面不支持嵌套属性，建议在源码模式查看 | 结构化 `sources` 可以保留，但不应承诺嵌套来源对象都能在属性面板编辑 |

依据：[Jekyll](https://jekyllrb.com/docs/front-matter/)、[Pandoc](https://pandoc.org/MANUAL.html#extension-yaml_metadata_block)、[Obsidian 官方文档源码](https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Editing%20and%20formatting/Properties.md)。

对 Kioku 的候选工程约定是：采用 UTF-8、文件顶部单个 YAML 映射、键名唯一、固定字段类型，日期时间和版本号显式写为字符串；明确解析器所用 YAML schema。这些是减少兼容歧义的建议。YAML 本身允许更丰富的数据表达，并不强制这一子集；其 Core schema 会将部分未引用标量解析为布尔、数字或空值。[YAML 映射约束](https://yaml.org/spec/1.2.2/#3211-nodes)、[Core schema](https://yaml.org/spec/1.2.2/#103-core-schema)

## 可以借鉴哪些知识元数据语义

**Dublin Core / DCMI Terms** 提供 `title`、`identifier`、`creator`、`created`、`modified`、`subject`、`source`、`relation`、`rights` 等术语。官方明确允许非 RDF 元数据参考其自然语言定义。对 Kioku，可据此区分标题、标识、内容作者、时间、主题和来源；但在 YAML 里写同名键，不等于已经具备 RDF 互操作性或采用了完整应用规范。[DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)

**W3C PROV-O** 区分实体、活动与责任主体，并提供派生、归属、修订、引用等关系。它适合帮助思考“公共结论从哪份 Raw 提炼而来、谁负责、是转述还是修订”。Kioku 可以借鉴这些关系而暂不引入 RDF；自己的 `sources` 数组不能直接称为 PROV-O 合规实现。[PROV-O 概述及核心关系](https://www.w3.org/TR/prov-o/#description-starting-point-terms)

本项目还需要自己的语义：结论是否只是推测、是否得到用户确认、来源当前是否存在、更新时间与来源观察时间有什么区别。这些应在 Kioku 的内容约定中定义，不能单凭 `status: confirmed` 或一个置信度数字让知识自动变成事实。该建议依据本项目“Shared 表达当前结论与不确定性、知识提炼不自动把助手建议升级为用户决策”的领域定义。[KiokuNet 术语表](GLOSSARY.md)

## SKILL.md 的格式要求

Agent Skills 要求技能目录内包含 `SKILL.md`，文件由 YAML front matter 和 Markdown 指令组成。`name` 与 `description` 必填；名称 1–64 字符、符合命名限制并匹配目录，描述 1–1024 字符。`license`、`compatibility`、`metadata`、`allowed-tools` 为可选字段；其中 `metadata` 是字符串键到字符串值的映射，`allowed-tools` 仍属实验性。[Agent Skills 格式](https://agentskills.io/specification#frontmatter)

因此，只有 `name` 和 `description` 的技能头可以满足最小要求；不必为了“元数据完整”加入作者、版本、标签或更新时间。知识文档的结构化来源数组也不应直接塞进 Skill 的 `metadata` 字段。技能正文和按需引用资源承担具体工作流程，知识文件内容约定需要在其中另行说明。[Agent Skills metadata 与正文](https://agentskills.io/specification#metadata-field)

## 2026-10-16 Kioku 的核查结果

结论：**两份 Skill 入口满足本次检查的最小格式要求；知识内容已有来源追踪原则，但尚未定义统一、可机器校验的元数据格式。** 这不构成违反 Markdown 标准，属于内容约定尚未收敛。

| 核查对象 | 当前行为 | 判断与证据 |
| --- | --- | --- |
| `kioku/SKILL.md` | YAML 头含 `name`、`description`；正文将职责限定为产品和 CLI 使用 | 最小字段齐全，明确不制定知识内容规范。[Skill](../skills/kioku/SKILL.md) |
| `kioku-curate/SKILL.md` | YAML 头含 `name`、`description`；正文指导 Leader 提炼 | 最小字段齐全；知识内容规则主要在此。[Skill](../skills/kioku-curate/SKILL.md) |
| Raw 输入 | 明确不要求记录 ID、frontmatter 或 correction 模板 | 与自由编辑和组织的现行设计一致，不应因为缺少头部拒绝提炼。[整理规则](../skills/kioku-curate/SKILL.md)、[ADR 0004](adr/0004-workspace-directories-and-current-state.md) |
| shared 输出 | 要求更新时间、确定程度、来源目录、相对路径、实际哈希；失效来源要标记 | 已有语义要求，但未指定头部位置、字段名、类型、枚举、模板及解析规则。不同运行器可能产出不同写法。[整理规则](../skills/kioku-curate/SKILL.md) |
| 文件传播与只读副本 | 读取文件字节、计算摘要、复制文件并设置权限 | 所检查路径没有解析知识 YAML 或验证其业务字段，文件成功同步不代表内容字段完整。[副本实现](../src/views.ts) |
| Skill 诊断与安装测试 | `doctor` 检查文件存在；安装集成测试比较分发后的文件内容 | 不证明运行器实际加载，也不证明生成的 shared 符合内容约定。[诊断](../src/diagnostics.ts)、[安装集成测试](../test/integration/skill-install.test.mjs) |

本次静态检查：两份文件均以 `---` 包围 `name`、`description` 两个简单字符串字段，名称匹配目录并符合命名限制。`kioku` 名称长 5 字符、描述长 105 字符、共 41 行，4 个引用文件均存在；`kioku-curate` 名称长 12 字符、描述长 65 字符、共 32 行。本机 `/Users/reuszeng/.agents/skills/kioku/SKILL.md` 与仓库文件逐字节一致。

验证范围：使用针对当前简单头部的静态检查，未运行官方 `skills-ref` 校验器，未重新执行安装集成测试，未验证远程运行器、已安装的 `kioku-curate` 或实际 Raw/shared 产物。以上描述的是当前规则与实现，不能推断所有历史提炼结果都遵守这些规则。

## 调研时对 KiokuNet 的候选约定

**建议 Raw 保持宽容、shared 逐步统一必要元数据。** ADR 0004 明确 Raw 自由组织、不要求追加记录模板，来源可修改或删除，系统不承诺历史恢复。因此不能以“遵循 Markdown 标准”为理由，反向强迫所有 Raw 带固定头部或稳定 ID。[ADR 0004](adr/0004-workspace-directories-and-current-state.md)

下面仅是一份 shared 候选示例，用于讨论字段语义；字段名、枚举和必填项尚未成为项目规范。它是普通知识文件的 front matter，不是 `SKILL.md` 的 `metadata`：

```yaml
---
schema: "kioku-shared/v1"
title: "示例：报表导出规则"
updated_at: "2026-10-16T12:00:00+08:00"
certainty: "tentative"
sources:
  - source_directory: "example-source"
    path: "reports/export-rules.md"
    observed_at: "2026-10-16T11:50:00+08:00"
    hash: "sha256:<读取时实际计算的摘要>"
    state: "present"
---
```

示例中的来源和时间均为说明值，哈希是待替换占位符，不能作为真实输出使用。建议把 `updated_at` 定义为当前公共知识结论的维护时间；`observed_at` 表示读取该来源的时间；`certainty` 的候选值可区分 `tentative`、`supported`、`user_confirmed`、`mixed`，其中用户确认必须有依据。来源 `state` 可区分 `present`、`changed`、`missing`、`unavailable`，表达最近检查结果；未能读取不等于已删除。

哈希只标识所观察到的文件内容，不能恢复已删原文、证明事实正确或证明作者身份。来源变动后应保留“结论当时依据哪份内容”的信息，再记录复核结果，避免把旧依据哈希悄悄替换成新文件哈希而不重新判断结论。这是针对 ADR 0004 当前状态模型的设计建议，不是新增备份承诺。[ADR 0004](adr/0004-workspace-directories-and-current-state.md)

正文仍应保留读者可理解的结论、适用范围、不确定性及逐项来源引用。文档中若混有已确认与待验证内容，单个文档级 `certainty` 不够，应在对应段落标明；front matter 主要帮助筛选与校验，不能代替证据和解释。是否增加 `id`、`tags`、`aliases`、失效日期，取决于实际检索与维护需求，不必在首版全部强制。

若决定实施，建议先把上述规则收敛为一份内容约定和 shared 模板，再由 `kioku-curate` 引用；需要自动化时才增加检查，覆盖必填项、类型、来源路径与真实摘要。旧文件和无头 Raw 继续可读。验证应分别检查技能包格式、知识字段语义和实际读取器行为，不能用其中一项通过代替另外两项。
