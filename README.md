<p align="center">
  <img src="icon.svg" width="80" height="80" alt="Writing Style Learner" />
</p>

<h1 align="center">Writing Style Learner</h1>

<p align="center">
  把任意写作样例的风格固化成持久档案，并在每一步注入系统提示，让生成的文字在长对话、长文档和新会话里都保持一致。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/dsh-writing-style-learner"><img alt="npm" src="https://img.shields.io/npm/v/dsh-writing-style-learner.svg?style=flat-square"></a>
  <a href="https://github.com/ygz77/dsh-writing-style-learner"><img alt="GitHub" src="https://img.shields.io/github/stars/ygz77/dsh-writing-style-learner.svg?style=flat-square"></a>
</p>

---

## 插件作用

一个可学习任意写作风格的 DeepSeek Harness 插件。

通过它，你可以轻松学会自己**实验报告、思想汇报、作业**等文本的写作风格与格式，把一套写好的模板沉淀下来反复复用——写新的作业或实验报告时，不必每次从头措辞、重新调格式，**文本书写的准确率和速度都能明显提升**。

给它一段样例——实验报告、思想汇报、学术论文、公文、邮件、文案，甚至小说——它会：

- **提炼风格**：从样例中抽取结构、文本风格、编号、表格、字体、格式、插图、规则、示例等维度，不适用的维度写「无」；
- **固化档案**：把风格存成可复用的档案，不依赖上下文；
- **每步注入**：通过 `ctx.systemPrompt.section()` 注入系统提示，**每一步重新渲染**，所以长对话、上下文压缩、新会话都不会丢风格；
- **按需生成**：插件本身**不带任何内置风格**，`Writing-Style` 文件夹只在第一次保存时按需创建。

## 安装

- **本地目录**：

  ```sh
  dsh plugin --profile <profile> add <path-to-this-directory>
  ```

- **GitHub 源码**：

  ```sh
  dsh plugin --profile <profile> add github:ygz77/dsh-writing-style-learner
  ```

需要 DSH `>= 0.2.1-rc.5`（`engines.dsh`）。

## 使用

在输入框输入：

```
/writing-style <要学 / 要写的内容>
```

例如：

```
/writing-style 学习这篇思想汇报的写法，然后写一篇当前日期的思想汇报
```

- 命令会把 `/writing-style` 后面的内容（或附件）直接交给模型；
- 模型自动从内容里解析风格、调用 `save_writing_style` 保存，再按风格写作；
- 没有管理子命令，也不需要提前存档案。

也可以直接对模型说「学习 / 模仿 / 参照 / 按这个风格写」，插件会自动保存风格。

## 工具

| 工具 | 作用 |
|---|---|
| `save_writing_style` | 保存并激活一个风格档案 |
| `show_writing_style` | 查看当前激活的档案 |
| `list_writing_styles` | 列出已保存档案 |
| `activate_writing_style` | 切换激活档案 |
| `clear_writing_style` | 删除档案 |

## 数据位置

- **有工作区**：`<workspace>/Writing-Style/profiles.json`，每个风格一个 `<folder>/<name>.json`。
- **无工作区**：`$DSH_HOME/Writing-Style/`。
- 插件包本身**不含任何风格数据**；文件夹只在第一次保存时出现。
- **卸载不会删除** `Writing-Style`（它在工作区，不在插件包里）。

## 目录结构

```
Writing-Style/                  # 工作区根目录，或 $DSH_HOME
├── profiles.json               # 聚合存储（所有档案 + 当前激活）
└── 实验报告/
    └── buaa-dl-lab.json        # 每个风格一个子文件夹，名称可自定义
```

## 配置（`cordis.patch.yml` 的 `config`）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `sectionName` | `writing-style` | 系统提示的 section 名 |
| `sectionOrder` | `100` | 在组装提示中的位置 |
| `maxProfileBytes` | `24000` | 注入内容的字节上限 |
| `dataDir` | `Writing-Style` | 档案存放目录（工作区优先，无工作区回退 `$DSH_HOME`） |
| `autoWriteJson` | `false` | 保存时是否额外写一份 JSON 副本 |
| `jsonFileName` | `writing-style-profile.json` | 额外副本的文件名 |

## 许可证

[MIT](LICENSE)
