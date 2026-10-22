# 本地 OCR 安装与验证

本项目用 RapidOCR 提取文字候选和原图坐标，供转换代理逐项核对。OCR 不调用绘图模型，不识别字体名称、字号或文字颜色，也不保证公式、手写体、旋转文字和小字完整。closed-loop 转换要求 OCR 证据；只安装 Node.js 依赖尚不能完成这一流程。

以下 PowerShell 命令都在仓库根目录执行。macOS/Linux 使用相同依赖和模型，将 `.venv/Scripts/python.exe` 换为 `.venv/bin/python`。当前已验证 Windows x64、Python 3.13.4；固定依赖要求 Python 3.11 以上，其他系统和 Python 版本尚未逐一验证。

## 1. 创建项目自己的 Python 环境

```powershell
py -3.13 -m venv .venv
& ./.venv/Scripts/python.exe -m pip install -r requirements-ocr.txt
& ./.venv/Scripts/python.exe -m pip check
```

`py -3.13` 是 Windows Python Launcher 的写法；没有该命令时，使用已安装的 Python 3.13 执行 `python -m venv .venv`。直接调用虚拟环境里的解释器即可，不必激活环境或修改 PowerShell 执行策略。不要复制其他电脑的 `.venv`。

`requirements-ocr.txt` 固定了 `rapidocr==3.10.0`、`onnxruntime==1.31.0` 和 `Pillow==12.3.0`；RapidOCR 的其余依赖由 pip 安装，当前未锁定所有间接依赖。默认使用 CPU，不需要 GPU、CUDA 或模型 API 密钥。

## 2. 准备并校验三个 ONNX 文件

`tools/ocr.py` 只查找以下固定文件名。设置了 `RAPIDOCR_MODEL_DIR` 后，三个文件必须直接放在该目录下，不能再套一层子目录。未设置时，脚本查找当前 Python 环境的 `rapidocr/models`。

| 文件 | 用途 | SHA-256 |
| --- | --- | --- |
| `PP-OCRv6_det_small.onnx` | 文字区域检测 | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` |
| `PP-OCRv6_rec_small.onnx` | 文字识别 | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` |
| `ch_ppocr_mobile_v2.0_cls_mobile.onnx` | 文字方向分类 | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` |

这些值来自 [RapidOCR v3.10.0 官方模型清单](https://github.com/RapidAI/RapidOCR/blob/v3.10.0/python/rapidocr/default_models.yaml)，本机现用文件实测 hash 也与之相符。它们是 RapidAI 发布的转换产物；不要仅凭相似文件名替换成其他 PaddleOCR 导出的 ONNX。

先建立仓库内的本地权重目录，并设置当前终端的环境变量：

```powershell
New-Item -ItemType Directory -Force ./models/rapidocr | Out-Null
$env:RAPIDOCR_MODEL_DIR = Join-Path (Get-Location).Path 'models/rapidocr'
```

权重共约 32 MB，不需要提交到 Git。若已安装的 wheel 带有这三个文件，可从它的 `rapidocr/models` 复制到该目录后校验；否则执行下面的**手动联网安装步骤**。URL 固定在官方 ModelScope 仓库的 `v3.10.0` 版本：

```powershell
$ocrModels = @(
    @{
        Name = 'PP-OCRv6_det_small.onnx'
        Url = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx'
        Sha256 = '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f'
    },
    @{
        Name = 'PP-OCRv6_rec_small.onnx'
        Url = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx'
        Sha256 = '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884'
    },
    @{
        Name = 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'
        Url = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx'
        Sha256 = 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c'
    }
)

foreach ($ocrModel in $ocrModels) {
    $ocrFile = Join-Path $env:RAPIDOCR_MODEL_DIR $ocrModel.Name
    if (-not (Test-Path -LiteralPath $ocrFile -PathType Leaf)) {
        Invoke-WebRequest -Uri $ocrModel.Url -OutFile $ocrFile -ErrorAction Stop
    }
    $ocrHash = (Get-FileHash -LiteralPath $ocrFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ocrHash -ne $ocrModel.Sha256) {
        throw "模型校验失败，请重新获取该文件：$ocrFile"
    }
    Write-Output "OK $($ocrModel.Name)"
}
```

以上下载和校验是安装动作。实际运行 `tools/ocr.py` 时，模型、字典和字体的 RapidOCR 下载入口均被阻止；缺少资源时会报错，不会自动补下载。模型路径显式传入推理引擎，因此运行脚本不会再次按官方清单验证文件 hash；安装时的校验不能省略。每次 OCR 结果仍会记录实际使用文件的 SHA-256。

`$env:RAPIDOCR_MODEL_DIR` 只作用于当前 PowerShell 及其子进程。重新打开终端或启动另一套 Codex 环境时，需要重新设置，并确保执行 OCR 的进程继承该变量。不要将个人绝对路径写入仓库。

### 字典、OCR 字体与 SVG 字体

- 上表的识别 ONNX 已内嵌 `character` 字典；本机验证有 18,708 行，不需要额外下载 `ppocr_keys_v1.txt`。没有该元数据的替代模型可能触发字典下载请求并被本项目拒绝，不应随意配一个旧字典继续运行。
- 本项目自己绘制 OCR 框和 ASCII 编号，未调用 RapidOCR 的 `result.vis()`，因此上述 OCR 路线无需另下载 `FZYTK.TTF` 等可视化字体。直接使用 RapidOCR 自带 CLI 的可视化功能，行为可能不同。
- SVG 文本渲染仍依赖操作系统安装的字体。团队成员应使用相同字体和版本，并检查字体许可；缺字体时可能发生回退、文字宽度变化或缺字。OCR 权重不能解决字体还原和排版问题。

## 3. 执行最小 smoke test

先按根目录 README 完成 `npm ci`。下面生成一张纯文字测试图，初始化一个新的运行目录并执行 OCR，不调用转换模型，也不生成 SVG：

```powershell
New-Item -ItemType Directory -Force ./inputs | Out-Null
& ./.venv/Scripts/python.exe -c "from PIL import Image, ImageDraw, ImageFont; im=Image.new('RGB',(480,140),'white'); ImageDraw.Draw(im).text((24,40),'HELLO DIAGRAM',fill='black',font=ImageFont.load_default(size=36)); im.save('inputs/ocr-smoke.png')"

node tools/render.mjs init inputs/ocr-smoke.png runs/ocr-smoke --closed-loop --max-attempts 3
& ./.venv/Scripts/python.exe -X utf8 tools/ocr.py runs/ocr-smoke --label source
```

`runs/ocr-smoke` 必须尚不存在；再次测试时使用新的目录名。OCR 预期返回 JSON 路径、PNG 路径、候选数量和耗时，并生成：

- `runs/ocr-smoke/evidence/ocr-source.json`：文字、置信度、四边形、包围框、依赖版本、权重 hash，以及 `networkDownloads: false`。
- `runs/ocr-smoke/evidence/ocr-source.png`：原图上的候选框及编号。

查看 JSON：

```powershell
$ocrResult = Get-Content ./runs/ocr-smoke/evidence/ocr-source.json -Raw | ConvertFrom-Json
$ocrResult.candidates | Format-Table id, text, confidence
$ocrResult.engine
```

在已验证的环境中，测试识别出 `HELLO DIAGRAM`。这是安装和证据写入检查，不是文字完整性或整图转换质量的保证。真实转换应在初始化后的运行目录执行 `tools/ocr.py`，再由代理逐条接受、修正或拒绝候选，并额外查找 OCR 未检出的文字。

## 4. 常见故障

| 报错或现象 | 处理 |
| --- | --- |
| `Local OCR dependencies missing` | 确认使用 `.venv` 内解释器，重新安装 `requirements-ocr.txt` 并执行 `pip check`。 |
| `Local OCR model files missing` | 检查执行进程中的 `RAPIDOCR_MODEL_DIR`、三个精确文件名及目录层级；环境变量设置后应重新启动需要继承它的代理环境。 |
| 下载失败、DNS 错误或 hash 不符 | 从上面的官方来源手动获取，或由可联网成员按同一 hash 分发到本机；不要将错误页、半个文件或未验证镜像当作模型。 |
| `RapidOCR requested a missing local resource` | 确认使用上表原始 ONNX 和固定依赖；常见原因是替代模型缺少内嵌字典。先解决资源差异，不要解除下载阻止来掩盖问题。 |
| ONNX Runtime／DLL 加载失败 | 核对 Python、系统和 wheel 架构是否一致；Windows 按 [ONNX Runtime 官方要求](https://onnxruntime.ai/docs/install/)准备 Visual C++ 运行库。不要从非官方站点下载单个 DLL。 |
| `Unsupported run manifest`、源图 hash 不符 | 使用 `render.mjs init` 创建新目录；不要手工拼 manifest 或修改生成后的 `source.png`。 |
| label 已存在 | 同一目录换一个新 `--label`，或使用新运行目录；脚本保护既有 OCR 证据，不覆盖它。 |
| 漏字、乱码、候选数量为零 | 先看原图清晰度和标注 PNG，再人工核对、局部放大测量；置信度较高也可能识别错误。 |

## 来源与验证范围

- [RapidOCR v3.10.0 模型 URL 和 SHA-256 官方清单](https://github.com/RapidAI/RapidOCR/blob/v3.10.0/python/rapidocr/default_models.yaml)
- [RapidOCR 官方安装文档](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/install/)
- [模型来源、许可与再分发说明](https://rapidai.github.io/RapidOCRDocs/main/en/model_licenses/)

2026-10-22 已检查本项目 OCR 源码、固定依赖、已安装 RapidOCR 的模型清单和字符元数据；现用三个文件的本机 hash 与官方清单一致，并用新建测试图完成 `init → OCR → JSON/PNG` 测试。未重新联网下载权重或从零安装全新环境；本环境对 ModelScope 的 HEAD 请求因 DNS 解析失败，URL 来自官方发布清单，不代表本机已实测该下载链路可用。
