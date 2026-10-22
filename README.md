# PNG to SVG with Luna

将 PNG/JPG diagram 还原为混合 SVG：文字、框和连接线使用可编辑的 SVG 对象，复杂图标、照片和微缩图保留原图局部像素。

项目通过 Codex 代理完成观察、测量、生成、检查和修复。本地 Python/Node 工具负责 OCR、裁剪、渲染和证据保存；CLI 不调用生成模型，也不自动加载 SKILL。团队成员使用自己的 Codex 账号和模型权限。

目前为实验工具，可能遗漏对象、误判箭头或裁剪边界。检查记录完整不等于视觉还原合格，交付结果仍需复核。

## 1. 安装环境

在 VS Code 或 Codex 中打开克隆后的仓库，并从仓库根目录运行下列命令。示例使用 Windows PowerShell；所有项目路径都相对于仓库。

- Node.js **22 或以上**，以及 npm。
- Python **3.13** 为已验证的 OCR 环境；具体依赖和权重说明见 [OCR_SETUP.md](OCR_SETUP.md)。
- 支持子代理且能够访问 `gpt-6-luna` 的 Codex 客户端。模型是否可用由账号、工作区和客户端决定。

```powershell
node --version
python --version
npm ci
npm test
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-ocr.txt
```

`npm test` 运行本地工具测试，不调用 Luna，不衡量模型转换准确率。

按 [OCR 安装说明](OCR_SETUP.md) 准备三个 ONNX 权重，并在当前终端配置 `RAPIDOCR_MODEL_DIR`。OCR 权重不随 Git 仓库分发，运行 OCR 时也不会自动下载。

macOS/Linux 的 Python 路径使用 `.venv/bin/python`。字体由操作系统提供；跨平台使用相同字体才能更接近相同的文字宽度和布局。不要把本机虚拟环境或系统字体直接提交到仓库。

## 2. 让 Luna 子代理执行转换

将自己的图片放入 `inputs/diagram.png`。该目录中的图片默认被 Git 忽略，避免把个人输入和论文图片自动提交。

在打开此仓库的 Codex 聊天中发送下面的任务，将输入和输出名称改成自己的值：

```text
请启动一个全新上下文的子代理：
模型 gpt-6-luna，推理等级 high。
如果无法指定该模型，请明确报告，不自行换成其他模型。

项目目录：当前仓库根目录。
输入：inputs/diagram.png
输出：runs/my-diagram-01（必须是尚不存在的新目录）。

让子代理完整读取根目录 SKILL.md，以及 TOOLING.md 中
Scene JSON 和 Closed-loop workflow 的对应说明，实际查看原图。
使用本仓库 Node 工具和 .venv 中的 Python，先确认 OCR 权重可用。

使用 init --closed-loop --max-attempts 3 开始本次转换。
按 SKILL 自行建立源清单、处理 OCR 候选、执行相关像素测量，
生成 SVG，再沿 review.mjs 队列完成检查、必要修复、问题关闭和复查。
允许在本次输出目录按需编写定位、裁剪和测量代码。
保留初稿、每版 SVG、实际渲染、Scene、清单及检查修改记录。
不要修改工具、SKILL、已有版本或 manifest 来绕过门禁。
不要读取其他 runs 或教师答案。

由 Luna 独立完成转换和视觉判断，不再委托其他代理。
主代理只检查环境、调度、等待与整理结果；不给中途视觉提示，也不代改产物。

最后交付简短报告：最新及最佳版本路径、实际模型、SKILL 文件 hash、
完成状态、遗留问题、可得耗时与 token。无法取得的用量和费用写 unknown。
预算用尽或遇到真实阻塞时保留产物并如实标 incomplete，不声称检查通过。
```

不指定子代理模型时，Codex 可能继承主代理配置；代理名叫 Luna 不代表实际模型就是 Luna。核对可得的子代理配置或运行记录，不能只依据自报角色。[OpenAI 官方子代理说明](https://learn.chatgpt.com/docs/agent-configuration/subagents)

该示例最多允许 3 次实际渲染。`--closed-loop` 默认是 8 次，可在初始化时设置 `--max-attempts 1` 至 `12`。渲染上限不等于 token、模型调用次数或总耗时上限。每次另选输出目录，不覆盖之前的 run。

如果 Codex 终端看不到 `RAPIDOCR_MODEL_DIR`，在代理执行 OCR 的同一 shell 中，按 OCR_SETUP 配置指向 `models/rapidocr` 的绝对路径；不要依赖另一终端的临时环境变量。

## 3. 查看结果

成功渲染后，输出目录大致如下：

```text
runs/my-diagram-01/
├── source.png
├── manifest.json
├── render-events.jsonl
├── evidence/
│   ├── inventory.json
│   ├── open-issues.json
│   └── workflow/
├── v01/
│   ├── result.svg
│   ├── preview.png
│   ├── scene.json
│   └── stats.json
└── v02/                       # 发生修复并渲染后才会出现
```

- 用浏览器打开 `result.svg`，用图片查看器打开实际渲染的 `preview.png`。
- 最新版本不一定最好；报告应说明推荐使用哪一版以及残留问题。
- 对比页和 `report.md` 由执行代理按任务生成，不是渲染器保证提供的固定文件。
- 工具的本地 `apiCalls: 0`、`modelTokens: 0` 不包含 Codex 代理用量。

复杂图标在 SVG 中仍是嵌入的 PNG。当前输出不包含编辑器节点约束，移动框时箭头不会自动跟随。

## 4. 工具命令与只找错模式

完整命令、JSON 字段和状态约束以 [TOOLING.md](TOOLING.md) 为准。转换前的核心调用是：

```powershell
node tools/render.mjs init inputs/diagram.png runs/my-diagram-01 --closed-loop --max-attempts 3
.\.venv\Scripts\python.exe tools/ocr.py runs/my-diagram-01 --label source
```

这两条命令只创建 run 和 OCR 证据，不会自动得到 SVG；后续源清单、测量、Scene 提案、渲染、检查和修复由代理按 [SKILL.md](SKILL.md) 执行。如果已经由代理初始化，不要重复运行 `init`。

只检查已有原图和候选渲染时，使用独立的重叠分区队列：

```powershell
node tools/partition-review.mjs create reference.png candidate.png runs/my-review --tile-size 640 --overlap 96
node tools/partition-review.mjs status runs/my-review
```

原图和候选 PNG/JPG 的归一化尺寸必须相同。代理需要实际查看每格配对图并记录，最后完成全图复核；`create` 和 `status` 本身不执行视觉检查。记录 schema 和后续命令见 TOOLING 的 Automatic partition review。

## 5. 仓库文件与团队提交

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | 通用转换、检查和修复规则；执行代理需要实际读取 |
| [TOOLING.md](TOOLING.md) | Scene、命令、队列、修复关闭和状态协议 |
| [OCR_SETUP.md](OCR_SETUP.md) | Python 环境、OCR 权重下载与校验、故障排查 |
| `src/`、`tools/` | 本地实现和 CLI |
| `tests/` | 本地工具测试 |
| `package.json`、`package-lock.json` | Node 依赖及锁定版本，两者一起提交 |
| [requirements-ocr.txt](requirements-ocr.txt) | Python OCR 依赖 |
| [SKILL_CHANGELOG.md](SKILL_CHANGELOG.md) | SKILL 开发背景与修改记录 |
| [SKILL.backup-20261022.md](SKILL.backup-20261022.md) | 清理前的 SKILL 原文备份 |
| [EVALUATION.md](EVALUATION.md) | 开展对照实验时使用的评估约定 |

`.gitignore` 默认排除 `node_modules/`、虚拟环境、模型权重、个人输入、`runs/`、历史对照页面、日志、密钥和本机配置。共享 `.gitignore` 会让团队克隆后沿用同一排除范围；已跟踪文件不会因为新增忽略规则自动从 Git 删除。[GitHub 忽略规则说明](https://docs.github.com/en/get-started/git-basics/ignoring-files)

新增团队样例可放在单独的 `examples/`，附输入来源和适用的许可说明，再明确审核提交；不要直接提交所有个人图片和历史运行。

本机已有实验与原 README 保存在 `runs/` 归档中，默认不进入团队源码仓库。原 README 备份为 `runs/team-sharing-prep-20261022/README.before.md`。代码、SKILL 和文档修改随 Git 提交；生成产物需要分享时，另选经过检查的文件。

## 6. 常见问题

- **只运行 npm 没有 SVG**：CLI 不调用模型，请用第 2 节的代理任务。
- **OCR 提示缺模型或请求下载**：核对 OCR_SETUP 的文件名、hash、环境变量以及所用 Python，不要通过开启静默下载绕过缺失资源。
- **渲染下一版被拒绝**：先处理上一版复查、未绑定发现和缺失字段；只缺记录时可同版补录或 `reopen`，不要为了补记录制造新版本。
- **检查完成但仍有错误**：字段、hash、像素变化和覆盖记录不验证语义正确；保留真实遗留问题，区分 `finish` 的流程状态与人工视觉验收。
- **换电脑字体或排版变化**：安装源图所需字体或选定可用替代，重新检查文字宽度、公式和遮挡；当前 SVG 不嵌入字体。
