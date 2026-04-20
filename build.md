# Windows 打包说明（中文）

下面命令请在 PowerShell 中执行。

## 0）推荐：一条命令直接打包（Fork 最稳）

这条命令会：清理 `winCodeSign` 缓存 + 编译前端 + 生成 `nsis x64` 安装包。

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" -ErrorAction SilentlyContinue; npm run build; $env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win nsis --x64 --publish=never
```

## 1）先编译前端（必须）

`electron-builder` 只会打包当前 `dist`，不会自动更新 UI 代码。
所以每次打包前都先执行：

```powershell
npm run build
```

## 2）标准打包（安装包 + 便携版，Fork 推荐）

使用本地配置（`electron-builder.local.cjs`），避免 Fork 项目卡在签名流程：

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win --publish=never
```

## 3）快速打包（只生成安装包，速度更快，Fork 推荐）

只打 `nsis` 安装包（x64）：

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win nsis --x64 --publish=never
```

## 4）最快本地验证（不生成安装器，Fork 推荐）

只生成 `win-unpacked` 目录，用于本地快速测试：

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win --dir --x64 --publish=never
```

## 5）不要直接用 `npm run pack:win`（Fork 注意）

`npm run pack:win` 走的是 `electron-builder.config.cjs`（官方发布配置），
Fork 场景下可能卡在签名/可执行文件编辑相关流程。

Fork 本地打包请统一用上面的 `--config electron-builder.local.cjs` 命令。

## 6）产物位置

默认输出目录：

- `release\`
- 安装包示例：`release\Netcatty-0.0.0-win-x64.exe`
- 便携版示例：`release\Netcatty-0.0.0-portable-win-x64.exe`
- 目录版示例：`release\win-unpacked\Netcatty.exe`

## 7）如果“打包成功但 UI 还是旧的”

优先按下面顺序排查：

1. 是否先执行了 `npm run build`
2. 是否运行了新产物：`release\win-unpacked\Netcatty.exe`
3. 是否打开了旧安装路径/旧快捷方式
