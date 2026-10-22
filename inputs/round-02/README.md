# 第二轮独立测试原图

这两张图未参与第一轮示范、Skill 编写或之前的三张图测试。素材筛选代理仅向 Skill 作者预先提供中性文件名、尺寸和校验值；图片内容在 Skill 冻结后才交给转换与评估者。

| 文件 | 来源及署名 | 许可 | 用途 |
|---|---|---|---|
| `test-01.png` | [Object detector 1stage vs 2 stage](https://commons.wikimedia.org/wiki/File:Object_detector_1stage_vs_2_stage.png)，Commons 署名 Licheng Jiao、Fan Zhang、Fang Liu、Shuyuan Yang | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 原图固有的旋转标签、箭头与中等密度文字 |
| `test-02.png` | [MACT 作者官方仓库图](https://github.com/boschresearch/MACT/blob/main/framework.png)，论文作者 Wei Zhou、Mohsen Mesgar、Annemarie Friedrich、Heike Adel；独立绘图者未知 | 仓库为 AGPL-3.0，图片及各嵌入图标的专项许可未知，未将仓库许可泛化为图片许可 | 复杂图标裁剪、表格文字与流程遗漏检查 |

原始像素没有裁切、缩放或合成。第二张原图为 547 × 527，小字号及图标细节受原始分辨率限制，不能把输入中不存在的细节作为模型应恢复的内容。

`manifest.json` 保存原始下载 SHA-256、最终文件 SHA-256、IDAT 压缩像素数据 SHA-256、尺寸、原始 URL、来源及许可核查记录。PNG 的 `tEXt`、`iTXt`、`zTXt` 按块类型剥离，不读取、解析或解压其中的文字或编辑器数据。未下载或读取 SVG、场景文件或其他矢量原稿。

`prepare_inputs.py` 可重新获取相同来源并执行同样的无像素变更处理；若来源内容已变化，会拒绝覆盖现有测试图片。转换后的作品是另行生成的衍生结果，不代表原作者输出。
