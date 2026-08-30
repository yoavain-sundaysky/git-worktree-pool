/* eslint-disable no-console,no-process-exit,node/no-sync */
import { parseArgs } from "node:util";
import { execFileSync, execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import clipboardy from "clipboardy";

// --- Repo + pool resolution -------------------------------------------

const resolvePool = (): { repoRoot: string; repoName: string; poolDir: string } => {
    let raw: string | undefined;
    try {
        raw = execSync("git worktree list --porcelain", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    }
    catch {
        // not in a git repo
    }

    if (raw !== undefined) {
        // git worktree list always lists the main repo first, even when run from inside a worktree slot
        const wtMatch = raw.match(/^worktree (.+)/m);
        if (!wtMatch) {
            console.error("ERROR: Could not parse git worktree list output.");
            process.exit(1);
        }
        const repoRoot = path.normalize(wtMatch[1].trim());
        const repoName = path.basename(repoRoot);
        const poolDir = path.join(path.dirname(repoRoot), `${repoName}-wt-pool`);
        return { repoRoot, repoName, poolDir };
    }

    // Not in a git repo - check if cwd is the pool root (<name>-wt-pool/)
    const cwd = process.cwd();
    const base = path.basename(cwd);
    if (base.endsWith("-wt-pool")) {
        const repoName = base.slice(0, -"-wt-pool".length);
        const repoRoot = path.join(path.dirname(cwd), repoName);
        if (fs.existsSync(path.join(repoRoot, ".git"))) {
            return { repoRoot, repoName, poolDir: cwd };
        }
    }

    console.error("ERROR: Not inside a git repository or worktree pool directory.");
    process.exit(1);
};

// --- Helpers -----------------------------------------------------------

const resolveSlot = (poolDir: string, repoName: string, arg: string): string => {
    if (/^\d+$/.test(arg)) {
        return path.join(poolDir, `${repoName}-wt${arg}`);
    }
    return arg;
};

const nextIndex = (poolDir: string, repoName: string): number => {
    let i = 1;
    while (fs.existsSync(path.join(poolDir, `${repoName}-wt${i}`))) {
        i++;
    }
    return i;
};

const confirm = async (message: string): Promise<boolean> => {
    if (!process.stdin.isTTY) {
        console.error("WARNING: Non-interactive mode - treating as no.");
        return false;
    }

    const rl = createInterface({ input, output });
    try {
        const answer = await rl.question(`${message} [y/N] `);
        return answer.toLowerCase() === "y";
    }
    finally {
        rl.close();
    }
};

type Prompter = {
    ask: (message: string, defaultValue: string) => Promise<string>;
    yesNo: (message: string, defaultYes: boolean) => Promise<boolean>;
    close: () => void;
};

// One readline interface for a whole interactive session. A line that answers a pending question goes to that
// question and is never emitted as "line", so every "line" event seen here is one that arrived between two
// questions (piped stdin delivers everything at once); those are buffered instead of dropped. An empty answer
// takes the default; EOF aborts instead of hanging.
const createPrompter = (): Prompter => {
    const rl = createInterface({ input, output });
    const INPUT_CLOSED = "Input closed before the question was answered.";
    const buffered: string[] = [];
    let closed = false;
    rl.on("line", line => {
        buffered.push(line);
    });
    rl.on("close", () => {
        closed = true;
    });

    const nextAnswer = async (promptText: string): Promise<string> => {
        if (buffered.length > 0) {
            const answer = buffered.shift() as string;
            output.write(`${promptText}${answer}\n`);
            return answer;
        }
        if (closed) {
            throw new Error(INPUT_CLOSED);
        }
        let onClose: () => void = () => {};
        const closedWhileWaiting = new Promise<never>((_, reject) => {
            onClose = () => reject(new Error(INPUT_CLOSED));
            rl.once("close", onClose);
        });
        try {
            return await Promise.race([rl.question(promptText), closedWhileWaiting]);
        }
        finally {
            rl.off("close", onClose);
        }
    };

    const ask = async (message: string, defaultValue: string): Promise<string> => {
        const answer = (await nextAnswer(`${message} [${defaultValue}] `)).trim();
        return answer || defaultValue;
    };
    const yesNo = async (message: string, defaultYes: boolean): Promise<boolean> => {
        const answer = (await ask(message, defaultYes ? "Y/n" : "y/N")).toLowerCase();
        if (answer === "y/n") {
            return defaultYes;
        }
        return answer === "y" || answer === "yes";
    };
    return { ask, yesNo, close: () => rl.close() };
};

const choose = async (message: string, choices: string[]): Promise<string | undefined> => {
    if (!process.stdin.isTTY) {
        console.error("WARNING: Non-interactive mode - no choice made.");
        return undefined;
    }

    const rl = createInterface({ input, output });
    try {
        const answer = (await rl.question(`${message} [${choices.join("/")}] `)).trim().toLowerCase();
        return choices.find(choice => choice === answer || choice[0] === answer);
    }
    finally {
        rl.close();
    }
};

const listSlots = (poolDir: string, repoName: string): string[] => {
    if (!fs.existsSync(poolDir)) {
        return [];
    }
    return fs.readdirSync(poolDir)
        .filter(name => name.startsWith(`${repoName}-wt`))
        .map(name => path.join(poolDir, name))
        .filter(p => {
            try {
                return fs.statSync(p).isDirectory();
            }
            catch {
                return false;
            }
        })
        .sort((a, b) => {
            const numA = parseInt(path.basename(a).match(/wt(\d+)$/)?.[1] ?? "0", 10);
            const numB = parseInt(path.basename(b).match(/wt(\d+)$/)?.[1] ?? "0", 10);
            return numA - numB;
        });
};

// --- Free marker, and the note it carries ------------------------------

export type PreservedWork = { method: "stash" | "wip-branch"; ref: string; label: string; restore: string };

export type FreeNote = {
    freedAt: string;
    branch: string;
    preserved?: PreservedWork;
    discarded?: string[];
    leftUntracked?: string[];
};

const markerPath = (slotPath: string): string =>
    path.join(path.dirname(slotPath), `.free-${path.basename(slotPath)}`);

const isFree = (slotPath: string): boolean =>
    fs.existsSync(markerPath(slotPath));

const markFree = (slotPath: string, note?: FreeNote): void => {
    fs.writeFileSync(markerPath(slotPath), note ? `${JSON.stringify(note, null, 4)}\n` : "", "utf8");
};

const markAssigned = (slotPath: string): void => {
    const marker = markerPath(slotPath);
    if (fs.existsSync(marker)) {
        fs.unlinkSync(marker);
    }
};

// Markers written before this note existed are zero-byte, so an empty or unparsable marker is normal.
export const readFreeNote = (slotPath: string): FreeNote | undefined => {
    try {
        const raw = fs.readFileSync(markerPath(slotPath), "utf8").trim();
        return raw ? JSON.parse(raw) as FreeNote : undefined;
    }
    catch {
        return undefined;
    }
};

const printFreeNote = (note: FreeNote): void => {
    console.log(`  Freed ${note.freedAt}, was on branch "${note.branch}"`);
    if (note.preserved) {
        console.log(`  Work kept as ${note.preserved.method}: ${note.preserved.ref}`);
        console.log(`  Restore with: ${note.preserved.restore}`);
    }
    if (note.discarded?.length) {
        console.log(`  ${note.discarded.length} change(s) were discarded when the slot was freed.`);
    }
    if (note.leftUntracked?.length) {
        console.log(`  ${note.leftUntracked.length} untracked file(s) were left behind when the slot was freed.`);
    }
};

// --- Slot state --------------------------------------------------------

export type SlotChange = { code: string; path: string };
export type SlotStatus = { tracked: SlotChange[]; untracked: SlotChange[] };

export const parseSlotStatus = (porcelain: string): SlotStatus => {
    const tracked: SlotChange[] = [];
    const untracked: SlotChange[] = [];

    for (const line of porcelain.split("\n")) {
        if (line.length < 4) {
            continue;
        }
        const change: SlotChange = { code: line.slice(0, 2), path: line.slice(3) };
        if (change.code === "??") {
            untracked.push(change);
        }
        else {
            tracked.push(change);
        }
    }

    return { tracked, untracked };
};

export const isClean = (status: SlotStatus): boolean =>
    status.tracked.length === 0 && status.untracked.length === 0;

// "git diff --quiet HEAD" cannot see untracked files, so porcelain status is the only safe source.
export const slotStatus = (slotPath: string): SlotStatus => {
    try {
        const porcelain = execSync(`git -C "${slotPath}" status --porcelain`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return parseSlotStatus(porcelain);
    }
    catch {
        // A slot whose status will not read is not provably clean, so call it dirty instead of handing it out.
        return { tracked: [{ code: "!!", path: "(git status failed - slot state unknown)" }], untracked: [] };
    }
};

const printChanges = (changes: SlotChange[]): void => {
    for (const change of changes) {
        console.error(`    ${change.code} ${change.path}`);
    }
};

const printSlotStatus = (slotPath: string, status: SlotStatus): void => {
    if (status.tracked.length > 0) {
        console.error(`  ${status.tracked.length} uncommitted tracked change(s) in ${slotPath}:`);
        printChanges(status.tracked);
    }
    if (status.untracked.length > 0) {
        console.error(`  ${status.untracked.length} untracked file(s) in ${slotPath}:`);
        printChanges(status.untracked);
    }
};

const getAssignedBranch = (slotPath: string): string => {
    try {
        return execSync(`git -C "${slotPath}" branch --show-current`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim() || "(detached HEAD)";
    }
    catch {
        return "(unknown)";
    }
};

const getDiffStat = (slotPath: string, defaultBranch: string, branch: string): string => {
    if (branch === defaultBranch || branch === "-" || branch === "(detached HEAD)" || branch === "(unknown)") {
        return "-";
    }
    try {
        const output = execSync(
            `git -C "${slotPath}" diff "${defaultBranch}...HEAD" --shortstat`,
            { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (!output) {
            return "-";
        }
        const insertions = output.match(/(\d+) insertion/)?.[1] ?? "0";
        const deletions = output.match(/(\d+) deletion/)?.[1] ?? "0";
        return `+${insertions} -${deletions}`;
    }
    catch {
        return "?";
    }
};

const gitBranchExistsLocally = (cwd: string, branch: string): boolean => {
    try {
        execSync(`git -C "${cwd}" rev-parse --verify "refs/heads/${branch}"`, { stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
};

const gitBranchExistsOnRemote = (cwd: string, branch: string): boolean => {
    try {
        execSync(`git -C "${cwd}" rev-parse --verify "refs/remotes/origin/${branch}"`, { stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
};

const resolveDefaultBranch = (repoRoot: string): string => {
    let defaultBranch: string | undefined;
    try {
        defaultBranch = execSync(
            `git -C "${repoRoot}" symbolic-ref refs/remotes/origin/HEAD`,
            { encoding: "utf8", stdio: "pipe" }
        ).trim().replace("refs/remotes/origin/", "");
    }
    catch {
        // origin/HEAD not set - try local fallbacks
    }
    if (!defaultBranch) {
        if (gitBranchExistsLocally(repoRoot, "main")) {
            defaultBranch = "main";
        }
        else if (gitBranchExistsLocally(repoRoot, "master")) {
            defaultBranch = "master";
        }
        else {
            console.error("ERROR: Cannot determine default branch (origin/HEAD not set, and neither \"main\" nor \"master\" exists locally).");
            process.exit(1);
        }
    }
    return defaultBranch;
};

// --- Keeping the work found in a dirty slot ----------------------------

const timestampTag = (): string =>
    new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");

const sanitizeRefPart = (value: string): string =>
    value.replace(/[^A-Za-z0-9._-]/g, "-");

// The stash stack is shared by the main checkout and every pool slot, and other sessions push to it,
// so an entry is addressed only by the SHA resolved from its unique label, never as stash@{0}.
const findStashSha = (slotPath: string, label: string): string | undefined => {
    try {
        const raw = execSync(`git -C "${slotPath}" stash list --format="%H %gs"`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        for (const line of raw.split("\n")) {
            const separator = line.indexOf(" ");
            if (separator > 0 && line.slice(separator + 1).includes(label)) {
                return line.slice(0, separator);
            }
        }
    }
    catch {
        // fall through - the caller reports an unresolved SHA
    }
    return undefined;
};

const stashSlotWork = (slotPath: string, branch: string): PreservedWork => {
    const label = `git-wt-pool ${path.basename(slotPath)} ${sanitizeRefPart(branch)} ${timestampTag()}`;
    execSync(`git -C "${slotPath}" stash push -u -m "${label}"`, { stdio: "inherit" });

    const sha = findStashSha(slotPath, label);
    if (!sha) {
        console.error(`ERROR: The work was stashed as "${label}" but the entry's SHA did not resolve.`);
        console.error(`Find it with: git -C "${slotPath}" stash list --format="%H %gs"`);
        console.error("The slot was NOT freed. Nothing is lost.");
        process.exit(1);
    }

    return { method: "stash", ref: sha, label, restore: `git -C "${slotPath}" stash apply ${sha}` };
};

const parkSlotWork = (slotPath: string, branch: string): PreservedWork => {
    const wipBranch = `wip/${path.basename(slotPath)}-${sanitizeRefPart(branch)}-${timestampTag()}`;
    execSync(`git -C "${slotPath}" checkout -b "${wipBranch}"`, { stdio: "inherit" });
    execSync(`git -C "${slotPath}" add -A`, { stdio: "inherit" });
    execSync(`git -C "${slotPath}" commit -q -m "WIP parked by git-wt-pool from ${sanitizeRefPart(branch)}"`, { stdio: "inherit" });

    return { method: "wip-branch", ref: wipBranch, label: wipBranch, restore: `git switch ${wipBranch}` };
};

const discardSlotWork = (slotPath: string): void => {
    execSync(`git -C "${slotPath}" reset -q --hard HEAD`, { stdio: "inherit" });
    execSync(`git -C "${slotPath}" clean -fd`, { stdio: "inherit" });
};

export type DirtyPlan = "stash" | "park" | "discard" | "leave" | "abort";

const chooseDirtyPlan = async (slotPath: string): Promise<DirtyPlan> => {
    console.log();
    console.log("  How must this work be kept?");
    console.log("    stash    stash it with a unique tag, then free the slot");
    console.log("    park     commit it to a wip/ branch, then free the slot");
    console.log("    abort    leave the slot assigned and change nothing");
    console.log("    discard  throw the changes away (asks for confirmation)");

    const choice = await choose("Choose", ["stash", "park", "abort", "discard"]);
    if (choice === undefined) {
        return "abort";
    }
    if (choice === "discard" && !await confirm(`Permanently discard the uncommitted work in ${slotPath}?`)) {
        return "abort";
    }
    return choice as DirtyPlan;
};

// --- Clipboard, cwd file + post-assign hooks ---------------------------

const copyToClipboard = (text: string): void => {
    try {
        clipboardy.writeSync(text);
    }
    catch {
        console.error("WARNING: Could not copy to clipboard.");
    }
};

// A child process cannot change its parent's cwd, so the bundled "gwt" wrappers (shell/) read the
// target path from this file and run the cd themselves.
const writeCwdFile = (cwdFile: string | undefined, targetPath: string): void => {
    if (!cwdFile) {
        return;
    }
    try {
        fs.writeFileSync(cwdFile, `${targetPath}\n`, "utf8");
    }
    catch {
        console.error(`WARNING: Could not write the cwd file: ${cwdFile}`);
    }
};

const runPostAssignHooks = (repoRoot: string, assignedSlot: string, branch: string): void => {
    const configPath = path.join(repoRoot, ".superset", "config.json");
    if (!fs.existsSync(configPath)) {
        return;
    }

    let config: { setup?: string[] };
    try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    }
    catch {
        console.error("WARNING: Could not parse .superset/config.json - skipping hooks.");
        return;
    }

    const setup = config.setup ?? [];
    if (setup.length === 0) {
        return;
    }

    console.log("\n=== Running post-assign setup (.superset/config.json) ===");
    const env = {
        ...process.env,
        SUPERSET_ROOT_PATH: repoRoot,
        SUPERSET_WORKSPACE_PATH: assignedSlot,
        SUPERSET_WORKSPACE_NAME: branch
    };

    for (const cmd of setup) {
        console.log(`\n$ ${cmd}`);
        try {
            execSync(cmd, { cwd: assignedSlot, stdio: "inherit", env });
        }
        catch {
            console.error(`ERROR: Setup command failed: ${cmd}`);
            process.exit(1);
        }
    }

    console.log("\n=== Setup complete ===");
};

// --- Commands ----------------------------------------------------------

export type SlotInfo = { path: string; status: "free" | "assigned" | "root"; branch: string; diff: string };

export const printList = (rootSlot: SlotInfo, slots: SlotInfo[]): void => {
    const tableData: Record<string, SlotInfo> = {};
    tableData["0"] = rootSlot;
    for (let i = 0; i < slots.length; i++) {
        tableData[String(i + 1)] = slots[i];
    }
    console.table(tableData);
    if (slots.length === 0) {
        console.log("  (no worktrees in pool yet)");
    }
    console.log();
};

const cmdList = (repoRoot: string, poolDir: string, repoName: string): void => {
    console.log();
    console.log(`  Pool : ${poolDir}`);
    console.log("  ---------------------------------------------------");

    const defaultBranch = resolveDefaultBranch(repoRoot);
    const rootBranch = getAssignedBranch(repoRoot);
    const rootSlot: SlotInfo = {
        path: repoName,
        status: "root",
        branch: rootBranch,
        diff: getDiffStat(repoRoot, defaultBranch, rootBranch)
    };

    if (!fs.existsSync(poolDir)) {
        printList(rootSlot, []);
        return;
    }

    const slotPaths = listSlots(poolDir, repoName);
    const slots: SlotInfo[] = slotPaths.map(slotPath => {
        const free = isFree(slotPath);
        const branch = free ? "-" : getAssignedBranch(slotPath);
        return {
            path: path.basename(slotPath),
            status: free ? "free" : "assigned",
            branch,
            diff: free ? "-" : getDiffStat(slotPath, defaultBranch, branch)
        };
    });
    printList(rootSlot, slots);
};

type BlockedSlot = { slot: string; status: SlotStatus };
type FreeSlotPick = { slot?: string; status?: SlotStatus; blocked: BlockedSlot[] };

// A freed slot is never trusted to be clean: "git checkout <branch>" carries tracked changes across and
// still exits 0 when the dirty paths are identical in HEAD and in the target branch.
export const pickFreeSlot = (freeSlots: string[]): FreeSlotPick => {
    const blocked: BlockedSlot[] = [];

    for (const slot of freeSlots) {
        const status = slotStatus(slot);
        if (status.tracked.length === 0) {
            return { slot, status, blocked };
        }
        blocked.push({ slot, status });
    }

    return { blocked };
};

export const cmdAssign = async (repoRoot: string, poolDir: string, repoName: string, branch: string, noSetup: boolean, yes: boolean, cwdFile?: string): Promise<void> => {
    if (!branch) {
        console.error("ERROR: Usage: git-wt-pool assign <branch>");
        process.exit(1);
    }

    // Guard: branch already assigned?
    const slots = listSlots(poolDir, repoName);
    for (const slotPath of slots) {
        if (!isFree(slotPath)) {
            const current = getAssignedBranch(slotPath);
            if (current === branch) {
                console.error(`ERROR: "${branch}" is already assigned to ${slotPath}`);
                process.exit(1);
            }
        }
    }

    const freeSlots = slots.filter(slotPath => isFree(slotPath));
    let assignedSlot: string;

    if (freeSlots.length > 0) {
        const { slot, status, blocked } = pickFreeSlot(freeSlots);

        for (const skipped of blocked) {
            console.error(`WARNING: Skipping free slot ${skipped.slot} - it still holds uncommitted tracked changes.`);
            printSlotStatus(skipped.slot, skipped.status);
        }

        if (!slot || !status) {
            console.error("ERROR: Every free slot holds uncommitted tracked changes. No slot was assigned.");
            console.error("Free one and keep its work: git-wt-pool free <number> --force");
            process.exit(1);
        }

        const note = readFreeNote(slot);
        console.log(`Repurposing: ${slot} <-- ${branch}`);
        if (note) {
            printFreeNote(note);
        }

        if (status.untracked.length > 0) {
            console.error(`WARNING: "git clean -fd" deletes ${status.untracked.length} untracked file(s) in ${slot}:`);
            printChanges(status.untracked);
            if (!yes && !await confirm("Delete them and continue?")) {
                console.log("Aborted. The slot stays free and the files stay in place.");
                return;
            }
        }

        // The free marker is removed only after every guard passes, so an aborted assign leaves the slot free.
        markAssigned(slot);

        try {
            execSync(`git -C "${slot}" clean -fd`, { stdio: "inherit" });
            if (gitBranchExistsLocally(slot, branch)) {
                console.log(`Branch "${branch}" found locally -- checking out`);
                execSync(`git -C "${slot}" checkout "${branch}"`, { stdio: "inherit" });
            }
            else if (gitBranchExistsOnRemote(slot, branch)) {
                console.log(`Branch "${branch}" found on remote -- checking out with tracking`);
                execSync(`git -C "${slot}" checkout --track "origin/${branch}"`, { stdio: "inherit" });
            }
            else {
                const defaultBranch = resolveDefaultBranch(repoRoot);
                console.log(`Branch "${branch}" not found -- creating from "${defaultBranch}"`);
                execSync(`git -C "${slot}" checkout -b "${branch}" "${defaultBranch}"`, { stdio: "inherit" });
            }
        }
        catch {
            // clean -fd may have removed the files the note listed, but its stash pointer must survive the rollback.
            markFree(slot, note ? { ...note, leftUntracked: undefined } : undefined);
            console.error("ERROR: Checkout failed; slot released back to free.");
            process.exit(1);
        }

        const afterCheckout = slotStatus(slot);
        if (!isClean(afterCheckout)) {
            console.error(`ERROR: ${slot} is on "${branch}" but is not clean after checkout.`);
            printSlotStatus(slot, afterCheckout);
            console.error("The slot stays assigned. Inspect it before you work in it.");
            process.exit(1);
        }

        assignedSlot = slot;
    }
    else {
        // Create a new numbered worktree
        if (!fs.existsSync(poolDir)) {
            fs.mkdirSync(poolDir, { recursive: true });
        }

        const idx = nextIndex(poolDir, repoName);
        const newSlot = path.join(poolDir, `${repoName}-wt${idx}`);
        console.log(`Creating new worktree: ${newSlot}`);

        if (gitBranchExistsLocally(repoRoot, branch)) {
            execSync(`git worktree add "${newSlot}" "${branch}"`, { stdio: "inherit", cwd: repoRoot });
        }
        else if (gitBranchExistsOnRemote(repoRoot, branch)) {
            console.log(`Branch "${branch}" found on remote -- checking out with tracking`);
            execSync(`git worktree add --track -b "${branch}" "${newSlot}" "origin/${branch}"`, { stdio: "inherit", cwd: repoRoot });
        }
        else {
            const defaultBranch = resolveDefaultBranch(repoRoot);
            console.log(`Branch "${branch}" not found -- creating from "${defaultBranch}"`);
            execSync(`git worktree add -b "${branch}" "${newSlot}" "${defaultBranch}"`, { stdio: "inherit", cwd: repoRoot });
        }

        assignedSlot = newSlot;
    }

    console.log();
    console.log(`  Assigned: ${assignedSlot} <-- ${branch}`);
    copyToClipboard(assignedSlot);
    console.error("Path copied to clipboard.");
    writeCwdFile(cwdFile, assignedSlot);

    if (!noSetup) {
        runPostAssignHooks(repoRoot, assignedSlot, branch);
    }
};

export const cmdFree = async (repoRoot: string, poolDir: string, repoName: string, arg: string, yes: boolean, force: boolean): Promise<void> => {
    if (!arg) {
        console.error("ERROR: Usage: git-wt-pool free <number> or <path>");
        process.exit(1);
    }

    const slotPath = resolveSlot(poolDir, repoName, arg);

    if (!fs.existsSync(slotPath)) {
        console.error(`ERROR: Worktree not found: ${slotPath}`);
        process.exit(1);
    }

    if (isFree(slotPath)) {
        console.log(`${slotPath} was already free.`);
        return;
    }

    const branch = getAssignedBranch(slotPath);
    const status = slotStatus(slotPath);
    if (!isClean(status)) {
        console.error(`WARNING: ${slotPath} holds uncommitted work.`);
        printSlotStatus(slotPath, status);
    }

    let plan: DirtyPlan = "leave";
    if (status.tracked.length > 0) {
        if (force) {
            plan = "stash";
        }
        else if (yes || !process.stdin.isTTY) {
            console.error("ERROR: Worktree holds uncommitted tracked changes, so it cannot be freed unattended.");
            console.error("Re-run with --force to stash them first (nothing is discarded), or run interactively to choose.");
            process.exit(1);
        }
        else {
            plan = await chooseDirtyPlan(slotPath);
        }
        if (plan === "abort") {
            console.log("Aborted.");
            return;
        }
    }
    else if (!yes && !await confirm(`Free worktree at ${slotPath}?`)) {
        console.log("Aborted.");
        return;
    }

    let preserved: PreservedWork | undefined;
    let discarded: string[] | undefined;
    switch (plan) {
        case "stash":
            preserved = stashSlotWork(slotPath, branch);
            break;
        case "park":
            preserved = parkSlotWork(slotPath, branch);
            break;
        case "discard":
            discarded = [...status.tracked, ...status.untracked].map(change => `${change.code} ${change.path}`);
            discardSlotWork(slotPath);
            break;
        default:
            break;
    }

    const defaultBranch = resolveDefaultBranch(repoRoot);
    try {
        execSync(`git -C "${slotPath}" checkout --detach "${defaultBranch}"`, { stdio: "pipe" });
    }
    catch {
        console.error(`ERROR: Could not check out "${defaultBranch}" in slot. Is the branch available locally?`);
        if (preserved) {
            console.error(`The work is kept as ${preserved.method} ${preserved.ref}. Restore with: ${preserved.restore}`);
        }
        process.exit(1);
    }

    const note: FreeNote = {
        freedAt: new Date().toISOString(),
        branch,
        preserved,
        discarded,
        leftUntracked: plan === "leave" && status.untracked.length > 0 ? status.untracked.map(change => change.path) : undefined
    };
    markFree(slotPath, note);

    console.log(`Freed: ${slotPath} (was: ${branch})`);
    if (preserved) {
        console.log(`Work kept as ${preserved.method}: ${preserved.ref}`);
        console.log(`Restore with: ${preserved.restore}`);
    }
    if (discarded) {
        console.log(`Discarded ${discarded.length} change(s).`);
    }
    if (note.leftUntracked) {
        console.log(`Left ${note.leftUntracked.length} untracked file(s) in place. The next assign asks before it deletes them.`);
    }
};

export const cmdRemove = async (repoRoot: string, poolDir: string, repoName: string, arg: string, yes: boolean, force: boolean): Promise<void> => {
    if (!arg) {
        console.error("ERROR: Usage: git-wt-pool remove <number> or <path>");
        process.exit(1);
    }

    const slotPath = resolveSlot(poolDir, repoName, arg);

    if (!fs.existsSync(slotPath)) {
        console.error(`ERROR: Worktree not found: ${slotPath}`);
        process.exit(1);
    }

    const status = slotStatus(slotPath);
    if (status.tracked.length > 0 && !force) {
        console.error("ERROR: Worktree has uncommitted changes. Use --force to remove anyway.");
        printSlotStatus(slotPath, status);
        process.exit(1);
    }

    const reasons: string[] = [];
    if (!isFree(slotPath)) {
        const branch = getAssignedBranch(slotPath);
        reasons.push(`assigned to branch "${branch}"`);
    }
    if (status.tracked.length > 0) {
        reasons.push(`${status.tracked.length} uncommitted tracked change(s)`);
    }
    if (status.untracked.length > 0) {
        reasons.push(`${status.untracked.length} untracked file(s)`);
    }

    if (reasons.length > 0) {
        console.error(`WARNING: Worktree ${reasons.join(" and ")}. "git worktree remove --force" destroys all of it.`);
        printSlotStatus(slotPath, status);
    }
    if (!yes && !await confirm(`Remove worktree at ${slotPath}${reasons.length > 0 ? " anyway" : ""}?`)) {
        console.log("Aborted.");
        return;
    }

    execSync(`git worktree remove --force "${slotPath}"`, { stdio: "inherit", cwd: repoRoot });
    // Clean up the external free marker if present (not removed by git worktree remove)
    const marker = markerPath(slotPath);
    if (fs.existsSync(marker)) {
        fs.unlinkSync(marker);
    }
    console.log(`Removed: ${slotPath}`);
};

export const cmdPath = (repoRoot: string, poolDir: string, repoName: string, arg: string, cwdFile?: string): void => {
    const targetPath = (!arg || arg === "root") ? repoRoot : resolveSlot(poolDir, repoName, arg);

    if (!fs.existsSync(targetPath)) {
        console.error(`ERROR: Slot not found: ${targetPath}`);
        process.exit(1);
    }

    console.log(targetPath);
    copyToClipboard(targetPath);
    console.error("Path copied to clipboard.");
    writeCwdFile(cwdFile, targetPath);
};

// --- Shell integration ("gwt") -----------------------------------------

export const WRAPPER_ENV = "GIT_WT_POOL_WRAPPER";

// Resolves to <package root>/shell both from dist/bin at runtime and from src/bin under ts-jest.
const SHELL_DIR = path.join(__dirname, "..", "..", "shell");

// The wrappers set GIT_WT_POOL_WRAPPER=1 for the child process. At an interactive prompt git-wt-pool insists
// on running through them, because only the wrapper can cd the user's shell. Scripts, CI and hooks have no
// prompt to cd, so a non-TTY stdin passes through.
export const needsWrapperSetup = (command: string | undefined, env: NodeJS.ProcessEnv, interactive: boolean): boolean =>
    interactive && env[WRAPPER_ENV] !== "1" && (command ?? "").toLowerCase() !== "init";

export const SHELL_KINDS = ["bash", "zsh", "powershell", "cmd"] as const;
export type ShellKind = typeof SHELL_KINDS[number];

const SHELL_LABELS: Record<ShellKind, string> = { bash: "bash", zsh: "zsh", powershell: "PowerShell", cmd: "cmd.exe" };

export const parseShellKind = (name: string): ShellKind | undefined => {
    const lower = name.toLowerCase();
    if (lower === "pwsh") {
        return "powershell";
    }
    if (lower === "sh") {
        return "bash";
    }
    return SHELL_KINDS.find(kind => kind === lower);
};

// "-zsh" is a macOS login shell; "sh.exe" is Git Bash seen through npm's sh shim, whose exec cannot replace the process on Windows.
const normalizeProcessName = (name: string): string =>
    path.basename(name.trim()).replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();

// Only "init" pays for this: about 300 ms for tasklist on Windows, negligible elsewhere.
const parentProcessName = (): string | undefined => {
    try {
        if (process.platform === "win32") {
            const csv = execFileSync("tasklist", ["/FI", `PID eq ${process.ppid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            return csv.startsWith("\"") ? csv.split(",")[0].replace(/"/g, "") : undefined;
        }
        if (process.platform === "linux") {
            return fs.readFileSync(`/proc/${process.ppid}/comm`, "utf8").trim() || undefined;
        }
        return execFileSync("ps", ["-o", "comm=", "-p", String(process.ppid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    }
    catch {
        return undefined;
    }
};

export type ShellEvidence = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; parentProcess?: string };

// The parent process wins because environment markers are inherited: a cmd window opened from PowerShell, or an editor
// started from Git Bash, carries the parent's markers. The env fallback covers npx (the parent is node) and a failed lookup.
export const detectShell = ({ platform, env, parentProcess }: ShellEvidence): ShellKind => {
    const parent = parentProcess ? normalizeProcessName(parentProcess) : "";
    if (parent === "zsh") {
        return "zsh";
    }
    if (parent === "bash" || parent === "sh") {
        return "bash";
    }
    if (parent === "pwsh" || parent === "powershell") {
        return "powershell";
    }
    if (parent === "cmd") {
        return "cmd";
    }

    const loginShell = path.basename(env.SHELL ?? "");
    if (platform === "win32") {
        if (env.MSYSTEM || env.SHELL) {
            return loginShell.startsWith("zsh") ? "zsh" : "bash";
        }
        // pwsh and Windows PowerShell prepend the user's Documents\...\Modules for their children; cmd.exe does not.
        const userModules = (env.PSModulePath ?? "").split(";").some(entry => env.USERPROFILE !== undefined && entry.startsWith(env.USERPROFILE));
        return userModules ? "powershell" : "cmd";
    }
    if (env.PSModulePath) {
        return "powershell";
    }
    return loginShell.startsWith("zsh") ? "zsh" : "bash";
};

const detectCurrentShell = (): ShellKind =>
    detectShell({ platform: process.platform, env: process.env, parentProcess: parentProcessName() });

const formatSetupBlock = (label: string, what: string, how: string): string =>
    ` ${label.padEnd(13)} ${what}\n               ${how}\n`;

const setupBlock = (shellDir: string, kind: ShellKind | "bash / zsh"): string => {
    const sourceLine = `source "${path.join(shellDir, "gwt.sh")}"`;
    switch (kind) {
        case "bash":
            return formatSetupBlock("bash", "add this line to ~/.bashrc:", sourceLine);
        case "zsh":
            return formatSetupBlock("zsh", "add this line to ~/.zshrc:", sourceLine);
        case "bash / zsh":
            return formatSetupBlock("bash / zsh", "add this line to ~/.bashrc or ~/.zshrc:", sourceLine);
        case "powershell":
            return formatSetupBlock("PowerShell", "copy the file into a directory on your PATH:", `Copy-Item "${path.join(shellDir, "gwt.ps1")}" <directory-on-PATH>`);
        case "cmd":
            return formatSetupBlock("cmd.exe", "copy the file into a directory on your PATH:", `copy "${path.join(shellDir, "gwt.cmd")}" <directory-on-PATH>`);
        default:
            return "";
    }
};

export type SetupOptions = { detected?: ShellKind; platform?: NodeJS.Platform };

export const renderShellSetup = (shellDir: string, { detected, platform = process.platform }: SetupOptions = {}): string => {
    const blocks = detected
        ? [
            ` Your shell looks like ${SHELL_LABELS[detected]}.`,
            "",
            setupBlock(shellDir, detected),
            " Other shells: git-wt-pool init --print bash | zsh | powershell | cmd, or git-wt-pool init --print --all",
            ""
        ]
        : [
            setupBlock(shellDir, "bash / zsh"),
            setupBlock(shellDir, "powershell"),
            ...(platform === "win32" ? [setupBlock(shellDir, "cmd")] : [])
        ];
    return [
        "",
        " gwt - runs git-wt-pool and changes directory after \"assign\" and \"path\".",
        " A child process cannot cd for its parent shell, so a small wrapper runs inside your shell.",
        " \"git-wt-pool init\" installs it for you. To do it by hand, the files ship with this package:",
        "",
        ...blocks,
        " Then use:  gwt assign <branch>   gwt path root   gwt path 2   gwt list   gwt free 2",
        " Scripts and CI can call git-wt-pool directly; the wrapper is required only at an interactive prompt.",
        ""
    ].join("\n");
};

const printWrapperRequired = (): void => {
    console.error("ERROR: At a prompt, git-wt-pool is used through its \"gwt\" wrapper, which changes directory for you.");
    console.error("       Run \"git-wt-pool init\" once to install it. Scripts and CI can call git-wt-pool directly.");
};

// --- init: install the wrapper -----------------------------------------

export type InitContext = {
    shellDir: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    homeDir: string;
    interactive: boolean;
    detected: ShellKind;
};

const expandHome = (candidate: string, homeDir: string): string =>
    path.resolve(candidate.replace(/^~(?=$|[\\/])/, homeDir));

const normalizeDir = (dir: string, platform: NodeJS.Platform): string => {
    const resolved = path.resolve(dir).replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.toLowerCase() : resolved;
};

const pathEntries = (env: NodeJS.ProcessEnv): string[] =>
    (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(entry => entry.length > 0);

const isOnPath = (dir: string, { env, platform }: InitContext): boolean =>
    pathEntries(env).some(entry => normalizeDir(entry, platform) === normalizeDir(dir, platform));

// npm installs a global package at <prefix>/node_modules/<pkg> on Windows and <prefix>/lib/node_modules/<pkg> elsewhere;
// the bin directory npm already put on PATH is <prefix> and <prefix>/bin respectively.
const npmGlobalBinDir = ({ shellDir, platform }: InitContext): string =>
    platform === "win32" ? path.resolve(shellDir, "..", "..", "..") : path.resolve(shellDir, "..", "..", "..", "..", "bin");

// npm's global bin dir is offered when it is on PATH; otherwise the user pastes a directory. PATH is not listed:
// it commonly holds dozens of entries, and the user knows which one is theirs.
const chooseInstallDir = async (file: string, ctx: InitContext, prompt: Prompter): Promise<string | undefined> => {
    const npmDir = npmGlobalBinDir(ctx);
    if (isOnPath(npmDir, ctx) && await prompt.yesNo(` Copy ${file} to ${npmDir} (on your PATH)?`, true)) {
        return npmDir;
    }

    const answer = await prompt.ask(` Copy ${file} to which directory? It must be on your PATH.`, "");
    if (!answer) {
        console.error("ERROR: No directory given. Nothing was installed.");
        process.exit(1);
    }
    const chosen = expandHome(answer, ctx.homeDir);
    if (!isOnPath(chosen, ctx)) {
        console.error(`WARNING: ${chosen} is not on your PATH, so "gwt" will not be found until it is.`);
        if (!await prompt.yesNo(" Copy there anyway?", false)) {
            console.log("Aborted. Nothing was installed.");
            return undefined;
        }
    }
    return chosen;
};

// PowerShell scripts and batch files run inside the calling session, so a copy on PATH is a complete install.
const installPathWrapper = async (kind: "powershell" | "cmd", ctx: InitContext, prompt: Prompter): Promise<void> => {
    const file = kind === "powershell" ? "gwt.ps1" : "gwt.cmd";
    const dir = await chooseInstallDir(file, ctx, prompt);
    if (!dir) {
        return;
    }
    const destination = path.join(dir, file);
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(path.join(ctx.shellDir, file), destination);
    }
    catch (e) {
        console.error(`ERROR: Could not copy to ${destination}: ${(e as Error).message}`);
        process.exit(1);
    }
    console.log(` Installed ${destination}.`);
    console.log(" Ready in this shell: gwt assign <branch>   gwt path root   gwt list");
};

export const POSIX_WRAPPER_HOME_PATH = ".config/git-wt-pool/gwt.sh";
const POSIX_SOURCE_LINE = `source "$HOME/${POSIX_WRAPPER_HOME_PATH}"`;

// A file on PATH runs as a child process and cannot cd, so bash/zsh get a copy in $HOME plus a source line in the
// profile. The copy, not the install directory, is sourced: it survives a Node version switch under nvm.
const installPosixWrapper = async (kind: "bash" | "zsh", ctx: InitContext, prompt: Prompter): Promise<void> => {
    const destination = path.join(ctx.homeDir, ...POSIX_WRAPPER_HOME_PATH.split("/"));
    const profileAnswer = await prompt.ask(" Add the source line to which profile file?", `~/.${kind}rc`);
    const profile = expandHome(profileAnswer, ctx.homeDir);

    console.log();
    console.log(" This will:");
    console.log(`   copy    ${path.join(ctx.shellDir, "gwt.sh")}`);
    console.log(`       to  ${destination}`);
    console.log(`   append  ${POSIX_SOURCE_LINE}`);
    console.log(`       to  ${profile}`);
    if (!await prompt.yesNo(" Proceed?", true)) {
        console.log("Aborted. Nothing was installed.");
        return;
    }

    try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(ctx.shellDir, "gwt.sh"), destination);
        const existing = fs.existsSync(profile) ? fs.readFileSync(profile, "utf8") : "";
        if (existing.includes(POSIX_WRAPPER_HOME_PATH)) {
            console.log(` ${profile} already sources the wrapper - left unchanged.`);
        }
        else {
            const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
            fs.appendFileSync(profile, `${separator}\n# git-wt-pool: the gwt wrapper, added by "git-wt-pool init"\n${POSIX_SOURCE_LINE}\n`, "utf8");
            console.log(` Added the source line to ${profile}.`);
        }
    }
    catch (e) {
        console.error(`ERROR: Could not install: ${(e as Error).message}`);
        process.exit(1);
    }
    console.log(` Installed ${destination}.`);
    console.log(` New shells load it from ${profileAnswer}. For this shell, run:  ${POSIX_SOURCE_LINE}`);
    console.log(" Then use: gwt assign <branch>   gwt path root   gwt list");
};

export type InitOptions = { print: boolean; all: boolean };

export const cmdInit = async (requested: string | undefined, { print, all }: InitOptions, ctx: InitContext): Promise<void> => {
    const requestedKind = requested ? parseShellKind(requested) : undefined;
    if (requested && !requestedKind) {
        console.error(`ERROR: Unknown shell "${requested}". Use one of: ${SHELL_KINDS.join(", ")}.`);
        process.exit(1);
    }
    const target = requestedKind ?? ctx.detected;

    if (print || !ctx.interactive) {
        if (!print) {
            console.error("Not an interactive terminal - printing the manual setup instead.");
        }
        console.log(renderShellSetup(ctx.shellDir, all ? { platform: ctx.platform } : { detected: target, platform: ctx.platform }));
        return;
    }

    console.log();
    console.log(" gwt - runs git-wt-pool and changes directory after \"assign\" and \"path\".");
    if (requestedKind) {
        console.log(` Installing the wrapper for ${SHELL_LABELS[requestedKind]}.`);
    }
    else {
        console.log(` Your shell looks like ${SHELL_LABELS[target]}.`);
    }

    const prompt = createPrompter();
    try {
        const kind = requestedKind ?? parseShellKind(await prompt.ask(` Install the wrapper for which shell? (${SHELL_KINDS.join(", ")})`, target));
        if (!kind) {
            console.error(`ERROR: Unknown shell. Use one of: ${SHELL_KINDS.join(", ")}.`);
            process.exit(1);
        }
        console.log();
        if (kind === "bash" || kind === "zsh") {
            await installPosixWrapper(kind, ctx, prompt);
        }
        else {
            await installPathWrapper(kind, ctx, prompt);
        }
    }
    catch (e) {
        console.error(`\nAborted: ${(e as Error).message} Nothing was installed.`);
        process.exit(1);
    }
    finally {
        prompt.close();
    }
};

const printUsage = (): void => {
    console.log(`
 git-wt-pool - reusable worktree pool manager

 Commands:
   git-wt-pool list | ls                        Show all pool worktrees and status
   git-wt-pool assign <branch> [-n] [-y]        Assign a free slot to a branch
   git-wt-pool free   <number|path> [-y] [-f]   Release a worktree back to the pool
   git-wt-pool remove <number|path> [-y] [-f]   Permanently delete a pool worktree
   git-wt-pool path   [root|<number>]           Copy path of repo or slot to clipboard
   git-wt-pool init   [<shell>] [--print]       Install the "gwt" wrapper for your shell (--print: manual steps)

 Flags:
   -n, --no-setup   (assign) Skip post-assign setup hooks
   -y, --yes        (assign) Delete leftover untracked files without asking
                    (free, remove) Skip the confirmation prompt
   -f, --force      (free)   Stash the uncommitted work, then free the slot
                    (remove) Remove a worktree that holds uncommitted changes
   --cwd-file <f>   (assign, path) Also write the resulting path to file <f> (used by gwt)

 At a prompt, run these commands through "gwt" (installed by "git-wt-pool init"): it cd's
 into the result of assign and path, which no child process can do. Scripts and CI can call
 git-wt-pool directly.

 A dirty slot is never handed out. assign skips a free slot that still holds tracked
 changes, and it asks before "git clean -fd" deletes untracked files. free keeps the
 work it finds - as a tagged stash, or as a commit on a wip/ branch - and records it
 in the .free-<slot> marker, which assign prints when it repurposes the slot.

 Layout:
   <parent>/
   +-- <name>/               <- main repo (any branch)
   +-- <name>-wt-pool/       <- worktree pool root (sibling of repo)
       +-- .free-<name>-wt2  <- marks slot 2 free, and records what was left in it
       +-- <name>-wt1/       <- assigned to a branch
       +-- <name>-wt2/       <- free
`);
};

// --- Main --------------------------------------------------------------

const main = async (): Promise<void> => {
    const { positionals, values } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            yes: { type: "boolean", short: "y" },
            force: { type: "boolean", short: "f" },
            help: { type: "boolean", short: "h" },
            "no-setup": { type: "boolean", short: "n" },
            "cwd-file": { type: "string" },
            all: { type: "boolean" },
            print: { type: "boolean" }
        },
        strict: false
    });

    const [command, arg] = positionals;
    const yes = (values.yes as boolean | undefined) ?? false;
    const force = (values.force as boolean | undefined) ?? false;
    const help = (values.help as boolean | undefined) ?? false;
    const noSetup = (values["no-setup"] as boolean | undefined) ?? false;
    const cwdFile = values["cwd-file"] as string | undefined;
    const all = (values.all as boolean | undefined) ?? false;
    const print = (values.print as boolean | undefined) ?? false;

    if (help) {
        printUsage();
        process.exit(0);
    }

    // Also gates a bare "git-wt-pool": a first-time user at a prompt gets the setup, not the usage text.
    if (needsWrapperSetup(command, process.env, process.stdin.isTTY === true)) {
        printWrapperRequired();
        process.exit(1);
    }

    if (!command) {
        printUsage();
        process.exit(1);
    }

    if (command.toLowerCase() === "init") {
        await cmdInit(arg, { print, all }, {
            shellDir: SHELL_DIR,
            platform: process.platform,
            env: process.env,
            homeDir: os.homedir(),
            interactive: process.stdin.isTTY === true,
            detected: detectCurrentShell()
        });
        return;
    }

    const { repoRoot, repoName, poolDir } = resolvePool();

    switch (command.toLowerCase()) {
        case "list":
        case "ls":
            cmdList(repoRoot, poolDir, repoName);
            break;
        case "assign":
            await cmdAssign(repoRoot, poolDir, repoName, arg, noSetup, yes, cwdFile);
            break;
        case "free":
            await cmdFree(repoRoot, poolDir, repoName, arg, yes, force);
            break;
        case "remove":
            await cmdRemove(repoRoot, poolDir, repoName, arg, yes, force);
            break;
        case "path":
            cmdPath(repoRoot, poolDir, repoName, arg, cwdFile);
            break;
        default:
            console.error(`ERROR: Unknown command "${command}"`);
            printUsage();
            process.exit(1);
    }
};

// compiled to CJS - require.main works at runtime even though source uses ESM-style imports
if (require.main === module) {
    main().catch(e => {
        console.error(e); process.exit(1);
    });
}
