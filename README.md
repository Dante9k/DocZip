# DocZip

中文 Windows 桌面工具，用于批量压缩 `.docx` 内嵌图片。文件在本机处理，按添加顺序串行执行，不需要安装 Word。

同时提供**本地网页版**：解压 `release/DocZip-Web-1.0.0-Windows-x64.zip` 后双击 `start.cmd`，自动在浏览器打开本机地址。包含运行时，无需另装 Node.js；可选择文件夹保存或下载结果。详情见 [网页版说明](web/README.md)。

仓库保存源码与使用说明，安装包不进入 Git 历史。克隆仓库后可按下方命令构建；生成的文件位于 `release/`。开源依赖保留各自许可证，项目自身目前未授予开源使用许可。

## 使用

1. 运行 `release/DocZip-1.0.0-Setup-x64.exe` 安装软件；也可直接运行 `release/win-unpacked/DocZip.exe`。使用免安装目录时，请保留其中全部文件。
2. 选择输出文件夹和压缩档位。
3. 拖入一个或多个 `.docx` 文件，也可以点击“添加文件”。
4. 点击“开始压缩”。处理期间可以继续添加文件；“暂停队列”在当前文件完成后生效。
5. 从任务“详情”查看结果或跳过原因，点击“打开输出目录”查找文件。

`报告.docx` 输出为 `报告_light.docx`；重名时依次生成 `报告_light_1.docx`、`报告_light_2.docx`。原文件和已有输出均不会被覆盖。

软件记住输出目录和压缩档位，不保存任务历史。取消当前任务可能需要等待当前图片编码结束；退出程序会取消未完成任务。

## 压缩规则

| 档位 | JPEG 质量 | 最大像素长边 |
|---|---:|---:|
| 清晰优先 | 90 | 3200 |
| 均衡（默认） | 82 | 2400 |
| 体积优先 | 70 | 1600 |

像素尺寸与文档中的显示尺寸是不同的概念。软件降低图片编码体积，必要时减少像素数量；不修改决定位置、宽高、环绕、裁剪和旋转的文档 XML。所有非图片部件的解压后内容在输出前逐字节校验。

- 支持嵌入的 JPEG、PNG；PNG 保留透明度，不做调色板量化。
- 不放大图片。保留色彩配置、方向和密度元数据；无法通过图片校验时保留原图。
- GIF、SVG、EMF、WMF、TIFF、多页或动画图片、外链图片和嵌入附件保持原样。
- 图片压缩结果更小时才采用；文档整体没有变小时输出原件的完整副本，显示“无需压缩”。
- 加密、数字签名、损坏文档及旧版 `.doc` 不处理。
- 单个图片编码失败只跳过该图片；文档包损坏或写入失败会使该任务失败，队列继续处理下一个文件。
- 安全上限：解压总量 1 GiB、20,000 个部件、单部件 256 MiB、单 XML 16 MiB；图片编码上限 64 MiB / 4,000 万像素，单张编码超时 30 秒。

压缩幅度取决于原文件里的图片，不能保证固定比例。虽然排版数据保持一致，最终视觉效果仍建议在平常使用的 Word 环境中核对，尤其是使用兼容模式或旧式绘图的文档。

## 开发与打包

环境：Windows x64、Node.js 24、pnpm 11。首次安装需要网络，软件正常使用时不需要网络。

```powershell
pnpm install
pnpm --dir web install
node node_modules/electron/install.js
pnpm build
pnpm start
```

```powershell
pnpm test
pnpm test:desktop
pnpm dist
```

`pnpm dev` 会构建并打开桌面程序；当前开发脚本不提供热更新。`pnpm dist` 输出 NSIS 安装程序和完整免安装目录。当前安装包未进行代码签名。

生成本地网页版免安装包（Windows x64）：

```powershell
pnpm --dir web build
node scripts/package-web.mjs
```

GitHub Actions 会在 Windows 上构建两个版本并执行核心测试，范围不包含原生文件选择对话框、安装器交互和 Word 视觉验收。开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，数据处理与问题报告见 [SECURITY.md](SECURITY.md)。

`patches/` 中的补丁通过 pnpm 自动应用：锁定的 electron-builder 26.15.3 在 Windows 上使用其内置 `UninstallerReader` 静态提取卸载程序，避免构建期间启动临时安装 EXE。这只影响打包流程，不影响应用运行。

目录结构：

- `src/core`：DOCX 包校验、图片压缩、输出提交及临时文件清理。
- `src/main`：Electron 主进程、受限 preload 接口、串行队列、压缩子进程。
- `src/renderer`：React 中文界面。
- `tests`：核心和队列自动化测试；测试文档在运行时生成。
- `scripts/desktop-test.mjs`：真实 Electron 窗口测试，包括拖放、文件选择、设置持久化、串行处理和异常任务。

测试数据及截图写入 `test-results/`，不会读取个人文档。桌面测试使用隔离的用户配置目录。若需要测试打包后的程序：

```powershell
$env:DOCZIP_EXE = (Resolve-Path release/win-unpacked/DocZip.exe).Path
node scripts/desktop-test.mjs
Remove-Item Env:DOCZIP_EXE
```

## 视觉验收

自动化测试核对文件结构、图片格式、尺寸与元数据，以及非图片部件内容一致性；不将这些检查等同于 Word 渲染一致性。

在装有 Word 的同一台电脑、相同字体和打印设置下，打开 `test-results/desktop/input/项目报告 含图片.docx` 与对应输出，对比页数、行内及浮动图片、表格图片、页眉页脚、裁剪与旋转；另用实际业务文档对比照片和文字截图的清晰度。
