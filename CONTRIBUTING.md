# 开发说明

本仓库包含 Windows 桌面版和浏览器本地处理版。建议使用 Windows x64、Node.js 24 和 pnpm 11。

首次准备：

```powershell
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
```

提交前检查：

```powershell
pnpm build
pnpm --dir web exec tsc --noEmit
pnpm --dir web build
pnpm test
```

测试只生成合成 DOCX，不应提交真实文档、测试结果、用户配置、依赖目录或安装包。修改图片处理时，应核对方向、色彩配置、透明度以及全部非图片部件内容；涉及排版显示的改动还需在相同 Word 环境下对比。

界面与打包测试、目录结构和本地启动方式见 [README](README.md) 与 [网页版说明](web/README.md)。

提交尽量聚焦一个问题；说明触发条件、修改后的行为和验证结果。保留测试中的失败案例，避免静默跳过异常。
