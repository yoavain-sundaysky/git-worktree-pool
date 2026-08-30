/**
 * Ensures husky git hooks are properly set up, including in git worktrees.
 *
 * In worktrees, `husky install` is skipped because core.hookspath is already set
 * in the shared git config. But the .husky/_/husky.sh helper script still needs
 * to exist locally. This script handles both cases:
 *   1. Runs `husky install` if core.hookspath is not yet configured
 *   2. Ensures .husky/_/husky.sh exists (copies from node_modules if missing)
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.cwd();
const huskyDir = path.join(ROOT, ".husky", "_");
const huskyShTarget = path.join(huskyDir, "husky.sh");

// Step 1: Run husky install if hookspath not set
try {
    execSync("git config --get core.hookspath", { encoding: "utf8", stdio: "pipe" });
    // hookspath is set — skip husky install
}
catch {
    // hookspath not set — run husky install
    console.log("[husky-setup] Running husky install...");
    try {
        execSync("husky install", { cwd: ROOT, stdio: "inherit" });
    }
    catch (e) {
        console.warn("[husky-setup] husky install failed:", e.message);
    }
}

// Step 2: Ensure .husky/_/husky.sh exists
if (!fs.existsSync(huskyShTarget)) {
    const source = path.join(ROOT, "node_modules", "husky", "husky.sh");
    if (fs.existsSync(source)) {
        fs.mkdirSync(huskyDir, { recursive: true });
        fs.copyFileSync(source, huskyShTarget);
        // Create .gitignore to match existing pattern
        const gitignorePath = path.join(huskyDir, ".gitignore");
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, "*\n", "utf8");
        }
        console.log("[husky-setup] Created .husky/_/husky.sh");
    }
    else {
        console.warn("[husky-setup] WARNING: node_modules/husky/husky.sh not found. Git hooks may not work.");
    }
}
