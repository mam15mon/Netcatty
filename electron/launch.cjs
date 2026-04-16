const { spawn } = require("node:child_process");
const electronPath = require("electron"); // returns binary path

// Keep parent environment as-is (Windows can fail with spawn UNKNOWN when
// using a rebuilt env object in some shells), only clear this flag.
delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ["."], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

// Forward SIGINT/SIGTERM to the Electron child process so Ctrl+C works
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) {
      child.kill(sig);
    }
  });
}
