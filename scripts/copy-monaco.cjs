const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'node_modules', 'monaco-editor', 'min', 'vs');
const target = path.join(repoRoot, 'public', 'monaco', 'vs');

if (!fs.existsSync(source)) {
  console.error('[copy-monaco] Source not found:', source);
  process.exit(1);
}

function copyDirRecursive(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  const entries = fs.readdirSync(fromDir, { withFileTypes: true });

  for (const entry of entries) {
    const fromPath = path.join(fromDir, entry.name);
    const toPath = path.join(toDir, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(fromPath, toPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      const realPath = fs.realpathSync(fromPath);
      const stat = fs.statSync(realPath);
      if (stat.isDirectory()) {
        copyDirRecursive(realPath, toPath);
      } else {
        fs.copyFileSync(realPath, toPath);
      }
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(fromPath, toPath);
    }
  }
}

try {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  copyDirRecursive(source, target);
  console.log('[copy-monaco] Copied Monaco VS assets to', target);
} catch (error) {
  console.error('[copy-monaco] Failed to copy Monaco assets.');
  console.error(error);
  process.exit(1);
}
