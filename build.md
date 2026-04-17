# Windows 打包说明（中文）

下面命令请在 PowerShell 中执行。

## 1）标准打包（安装包 + 便携版）

使用本地配置，规避之前的符号链接权限问题：

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win --publish=never
```

## 2）快速打包（只生成安装包，速度更快）

只打 `nsis` 安装包（x64）：

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win nsis --x64 --publish=never
```

## 3）最快本地验证（不生成安装器）

只生成 `win-unpacked` 目录，用于本地快速测试：

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win --dir --x64 --publish=never
```

## 4）产物位置

默认输出目录：

- `release\`
- 安装包示例：`release\Netcatty-0.0.0-win-x64.exe`
- 便携版示例：`release\Netcatty-0.0.0-portable-win-x64.exe`
- 目录版示例：`release\win-unpacked\Netcatty.exe`
