# Build (Windows)

Use this command in PowerShell to build Windows installer/portable packages
with the local config (avoids the previous symlink permission issue):

```powershell
$env:NODE_OPTIONS='--disable-warning=DEP0190'; npx electron-builder --config electron-builder.local.cjs --win --publish=never
```

