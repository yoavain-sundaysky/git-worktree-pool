/* eslint-disable no-console,no-process-exit,node/no-sync */
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
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

// --- Clipboard + post-assign hooks -------------------------------------

const copyToClipboard = (text: string): void => {
    try {
        clipboardy.writeSync(text);
    }
    catch {
        console.error("WARNING: Could not copy to clipboard.");
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

export const cmdAssign = async (repoRoot: string, poolDir: string, repoName: string, branch: string, noSetup: boolean, yes: boolean): Promise<void> => {
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

const cmdPath = (repoRoot: string, poolDir: string, repoName: string, arg: string): void => {
    const targetPath = (!arg || arg === "root") ? repoRoot : resolveSlot(poolDir, repoName, arg);

    if (!fs.existsSync(targetPath)) {
        console.error(`ERROR: Slot not found: ${targetPath}`);
        process.exit(1);
    }

    console.log(targetPath);
    copyToClipboard(targetPath);
    console.error("Path copied to clipboard.");
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

 Flags:
   -n, --no-setup   (assign) Skip post-assign setup hooks
   -y, --yes        (assign) Delete leftover untracked files without asking
                    (free, remove) Skip the confirmation prompt
   -f, --force      (free)   Stash the uncommitted work, then free the slot
                    (remove) Remove a worktree that holds uncommitted changes

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
            "no-setup": { type: "boolean", short: "n" }
        },
        strict: false
    });

    const [command, arg] = positionals;
    const yes = (values.yes as boolean | undefined) ?? false;
    const force = (values.force as boolean | undefined) ?? false;
    const help = (values.help as boolean | undefined) ?? false;
    const noSetup = (values["no-setup"] as boolean | undefined) ?? false;

    if (!command || help) {
        printUsage();
        process.exit(!command ? 1 : 0);
    }

    const { repoRoot, repoName, poolDir } = resolvePool();

    switch (command.toLowerCase()) {
        case "list":
        case "ls":
            cmdList(repoRoot, poolDir, repoName);
            break;
        case "assign":
            await cmdAssign(repoRoot, poolDir, repoName, arg, noSetup, yes);
            break;
        case "free":
            await cmdFree(repoRoot, poolDir, repoName, arg, yes, force);
            break;
        case "remove":
            await cmdRemove(repoRoot, poolDir, repoName, arg, yes, force);
            break;
        case "path":
            cmdPath(repoRoot, poolDir, repoName, arg);
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
