/* eslint-disable node/no-sync -- the fs fake must mirror the sync API the CLI calls */
import * as path from "node:path";

const mockQuestion = jest.fn<Promise<string>, [string]>();

jest.mock("node:child_process", () => ({ execSync: jest.fn() }));
jest.mock("node:fs");
jest.mock("clipboardy", () => ({ writeSync: jest.fn() }));
jest.mock("node:readline/promises", () => ({
    createInterface: () => ({ question: mockQuestion, on: () => {}, once: () => {}, off: () => {}, close: () => {} })
}));

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { FreeNote, InitContext, ShellKind, SlotInfo } from "../../../src/bin/git-wt-pool";
import {
    POSIX_WRAPPER_HOME_PATH, WRAPPER_ENV, cmdAssign, cmdFree, cmdInit, cmdPath, cmdRemove, detectShell, isClean, needsWrapperSetup, parseShellKind, parseSlotStatus, printList,
    readFreeNote, renderShellSetup
} from "../../../src/bin/git-wt-pool";

const ROOT_SLOT: SlotInfo = { path: "repo", status: "root", branch: "master", diff: "-" };

const REPO_NAME = "repo";
const REPO_ROOT = path.join("C:", "Dev", "repo");
const POOL_DIR = path.join("C:", "Dev", "repo-wt-pool");
const slotDir = (n: number): string => path.join(POOL_DIR, `${REPO_NAME}-wt${n}`);
const markerFile = (n: number): string => path.join(POOL_DIR, `.free-${REPO_NAME}-wt${n}`);

const files = new Map<string, string>();
const dirs = new Set<string>();
let gitLog: string[] = [];

/** Porcelain output keyed by slot dir; a slot with no entry reports clean. */
let porcelain: Record<string, string> = {};
/** Slot dirs whose porcelain flips to the second value once the checkout has run. */
let porcelainAfterCheckout: Record<string, string> = {};
let checkoutRan = false;
let stashSubjects: string[] = [];

const mockedFs = fs as jest.Mocked<typeof fs>;

const installFsFake = (): void => {
    mockedFs.existsSync.mockImplementation(p => files.has(String(p)) || dirs.has(String(p)));
    mockedFs.readdirSync.mockImplementation(p => {
        const prefix = `${String(p)}${path.sep}`;
        const names = new Set<string>();
        for (const key of [...files.keys(), ...dirs]) {
            if (key.startsWith(prefix)) {
                names.add(key.slice(prefix.length).split(path.sep)[0]);
            }
        }
        return [...names] as never;
    });
    mockedFs.statSync.mockImplementation(p => ({ isDirectory: () => dirs.has(String(p)) }) as never);
    mockedFs.readFileSync.mockImplementation(p => {
        const key = String(p);
        if (!files.has(key)) {
            throw new Error(`ENOENT: ${key}`);
        }
        return files.get(key) as never;
    });
    mockedFs.writeFileSync.mockImplementation((p, data) => {
        files.set(String(p), String(data));
    });
    mockedFs.unlinkSync.mockImplementation(p => {
        files.delete(String(p));
    });
    mockedFs.mkdirSync.mockImplementation(p => {
        dirs.add(String(p));
        return undefined as never;
    });
    mockedFs.copyFileSync.mockImplementation((src, dest) => {
        if (!files.has(String(src))) {
            throw new Error(`ENOENT: ${String(src)}`);
        }
        files.set(String(dest), files.get(String(src)) as string);
    });
    mockedFs.appendFileSync.mockImplementation((p, data) => {
        files.set(String(p), `${files.get(String(p)) ?? ""}${String(data)}`);
    });
};

const installGitFake = (): void => {
    (execSync as jest.Mock).mockImplementation((command: string) => {
        gitLog.push(command);

        if (command.includes("status --porcelain")) {
            const slot = Object.keys(porcelain).find(candidate => command.includes(candidate));
            const flipped = Object.keys(porcelainAfterCheckout).find(candidate => command.includes(candidate));
            if (checkoutRan && flipped) {
                return porcelainAfterCheckout[flipped];
            }
            return slot ? porcelain[slot] : "";
        }
        if (command.includes("clean -fd")) {
            const slot = Object.keys(porcelain).find(candidate => command.includes(candidate));
            if (slot) {
                porcelain[slot] = porcelain[slot]
                    .split("\n")
                    .filter(line => line.length > 0 && !line.startsWith("??"))
                    .map(line => `${line}\n`)
                    .join("");
            }
            return "";
        }
        if (command.includes("checkout")) {
            checkoutRan = true;
            return "";
        }
        if (command.includes("branch --show-current")) {
            return "ARCH-000-old-branch\n";
        }
        if (command.includes("symbolic-ref refs/remotes/origin/HEAD")) {
            return "refs/remotes/origin/master\n";
        }
        if (command.includes("stash push")) {
            const label = command.match(/-m "([^"]+)"/)?.[1] ?? "";
            stashSubjects.push(`On ARCH-000-old-branch: ${label}`);
            return "";
        }
        if (command.includes("stash list")) {
            return stashSubjects.map((subject, i) => `${String(i).repeat(40)} ${subject}`).join("\n");
        }
        if (command.includes("rev-parse --verify")) {
            return "0000000\n";
        }
        return "";
    });
};

/** Registers slot dirs 1..count in the fake pool, each marked free. */
const givenFreePool = (count: number, notes: Record<number, FreeNote> = {}): void => {
    dirs.add(POOL_DIR);
    dirs.add(REPO_ROOT);
    for (let n = 1; n <= count; n++) {
        dirs.add(slotDir(n));
        files.set(markerFile(n), notes[n] ? JSON.stringify(notes[n]) : "");
    }
};

const givenAssignedSlot = (n: number): void => {
    dirs.add(POOL_DIR);
    dirs.add(REPO_ROOT);
    dirs.add(slotDir(n));
};

const setTty = (isTty: boolean): void => {
    Object.defineProperty(process.stdin, "isTTY", { value: isTty, configurable: true });
};

const gitCommands = (needle: string): string[] => gitLog.filter(command => command.includes(needle));

const CWD_FILE = path.join("C:", "tmp", "gwt.cwd");

describe("git-wt-pool", () => {
    describe("bundled shell wrappers", () => {
        const realFs = jest.requireActual<typeof fs>("node:fs");
        const shellDir = path.join(__dirname, "..", "..", "..", "shell");
        const readWrapper = (file: string): string => realFs.readFileSync(path.join(shellDir, file), "utf8");

        it.each(["gwt.sh", "gwt.ps1", "gwt.cmd"])("ships %s, which calls git-wt-pool with --cwd-file and marks itself as the wrapper", file => {
            const wrapper = readWrapper(file);
            expect(wrapper).toContain("git-wt-pool");
            expect(wrapper).toContain("--cwd-file");
            expect(wrapper).toContain(WRAPPER_ENV);
        });

        // bash rejects CRLF ("$'\r': command not found"); cmd.exe wants CRLF. .gitattributes pins both.
        it("keeps gwt.sh and gwt.ps1 on LF and gwt.cmd on CRLF", () => {
            expect(readWrapper("gwt.sh")).not.toContain("\r");
            expect(readWrapper("gwt.ps1")).not.toContain("\r");
            const cmd = readWrapper("gwt.cmd");
            expect(cmd).toContain("\r\n");
            expect(cmd.replace(/\r\n/g, "")).not.toContain("\n");
        });
    });

    describe("wrapper gate", () => {
        it("lets a wrapped call through at a prompt", () => {
            expect(needsWrapperSetup("assign", { [WRAPPER_ENV]: "1" }, true)).toBe(false);
        });

        it("requires the wrapper for a direct call at a prompt", () => {
            expect(needsWrapperSetup("assign", {}, true)).toBe(true);
            expect(needsWrapperSetup("list", {}, true)).toBe(true);
        });

        // A first-time user types just "git-wt-pool"; the setup must appear there too, not the usage text.
        it("gates a bare invocation without a command", () => {
            expect(needsWrapperSetup(undefined, {}, true)).toBe(true);
            expect(needsWrapperSetup(undefined, { [WRAPPER_ENV]: "1" }, true)).toBe(false);
            expect(needsWrapperSetup(undefined, {}, false)).toBe(false);
        });

        // Scripts, CI and hooks have no prompt to cd, so they keep calling the CLI directly.
        it("lets a non-interactive caller through without the wrapper", () => {
            expect(needsWrapperSetup("assign", {}, false)).toBe(false);
        });

        it("never gates the installer itself", () => {
            expect(needsWrapperSetup("init", {}, true)).toBe(false);
            expect(needsWrapperSetup("INIT", {}, true)).toBe(false);
        });

        it("prints the install line of every bundled wrapper with its absolute path under --all on Windows", () => {
            const shellDir = path.join("C:", "pkg", "shell");
            const setup = renderShellSetup(shellDir, { platform: "win32" });
            for (const file of ["gwt.sh", "gwt.ps1", "gwt.cmd"]) {
                expect(setup).toContain(path.join(shellDir, file));
            }
            expect(setup).toContain("source ");
            expect(setup).toContain("PATH");
        });

        it("leaves cmd.exe out of --all on other platforms", () => {
            const shellDir = path.join("C:", "pkg", "shell");
            const setup = renderShellSetup(shellDir, { platform: "linux" });
            expect(setup).toContain(path.join(shellDir, "gwt.sh"));
            expect(setup).toContain(path.join(shellDir, "gwt.ps1"));
            expect(setup).not.toContain("gwt.cmd");
        });

        it("slims the output to the detected shell and points at the others", () => {
            const shellDir = path.join("C:", "pkg", "shell");
            const setup = renderShellSetup(shellDir, { detected: "powershell" });
            expect(setup).toContain("Your shell looks like PowerShell");
            expect(setup).toContain(path.join(shellDir, "gwt.ps1"));
            expect(setup).not.toContain("gwt.sh");
            expect(setup).not.toContain("gwt.cmd");
            expect(setup).toContain("git-wt-pool init --print --all");
        });

        it("names the right profile file for bash and zsh", () => {
            const shellDir = path.join("C:", "pkg", "shell");
            expect(renderShellSetup(shellDir, { detected: "bash" })).toContain("~/.bashrc:");
            expect(renderShellSetup(shellDir, { detected: "zsh" })).toContain("~/.zshrc:");
        });
    });

    describe("shell detection", () => {
        const win = (env: NodeJS.ProcessEnv, parentProcess?: string): ShellKind => detectShell({ platform: "win32", env, parentProcess });
        const linux = (env: NodeJS.ProcessEnv, parentProcess?: string): ShellKind => detectShell({ platform: "linux", env, parentProcess });
        const userProfile = "C:\\Users\\me";
        const psModulesFromPowerShell = `${userProfile}\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules`;
        const psModulesFromCmd = "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules";

        it.each([
            ["pwsh.exe", "powershell"],
            ["powershell.exe", "powershell"],
            ["cmd.exe", "cmd"],
            ["bash.exe", "bash"],
            ["sh.exe", "bash"],
            ["/bin/zsh", "zsh"],
            ["-zsh", "zsh"]
        ])("recognizes the parent process %s", (parent, expected) => {
            expect(detectShell({ platform: "win32", env: {}, parentProcess: parent })).toBe(expected);
        });

        // Environment markers are inherited, so the parent process must win over them.
        it("trusts the parent process over inherited environment markers", () => {
            expect(win({ MSYSTEM: "MINGW64", SHELL: "/bin/bash.exe" }, "pwsh.exe")).toBe("powershell");
            expect(win({ USERPROFILE: userProfile, PSModulePath: psModulesFromPowerShell }, "cmd.exe")).toBe("cmd");
        });

        it("falls back to Git Bash markers on Windows when the parent is unknown", () => {
            expect(win({ MSYSTEM: "MINGW64", SHELL: "/bin/bash.exe" }, "node.exe")).toBe("bash");
            expect(win({ SHELL: "/usr/bin/zsh" })).toBe("zsh");
        });

        it("tells PowerShell from cmd.exe by the user module path PowerShell prepends", () => {
            expect(win({ USERPROFILE: userProfile, PSModulePath: psModulesFromPowerShell })).toBe("powershell");
            expect(win({ USERPROFILE: userProfile, PSModulePath: psModulesFromCmd })).toBe("cmd");
            expect(win({})).toBe("cmd");
        });

        it("uses the login shell and pwsh's PSModulePath on other platforms", () => {
            expect(linux({ SHELL: "/usr/bin/zsh" })).toBe("zsh");
            expect(linux({ SHELL: "/bin/bash" })).toBe("bash");
            expect(linux({ SHELL: "/bin/bash", PSModulePath: "/home/me/.local/share/powershell/Modules" })).toBe("powershell");
            expect(linux({})).toBe("bash");
        });

        it("accepts explicit shell names and their common aliases", () => {
            expect(parseShellKind("PowerShell")).toBe("powershell");
            expect(parseShellKind("pwsh")).toBe("powershell");
            expect(parseShellKind("sh")).toBe("bash");
            expect(parseShellKind("CMD")).toBe("cmd");
            expect(parseShellKind("fish")).toBeUndefined();
        });
    });

    describe("printList", () => {
        beforeEach(() => {
            jest.spyOn(console, "table").mockImplementation(() => {});
            jest.spyOn(console, "log").mockImplementation(() => {});
        });

        afterEach(() => jest.restoreAllMocks());

        it("prints root row and empty message when there are no slots", () => {
            printList(ROOT_SLOT, []);
            expect(console.table).toHaveBeenCalledWith({
                "0": ROOT_SLOT
            });
            expect(console.log).toHaveBeenCalledWith("  (no worktrees in pool yet)");
        });

        it("renders table with root at index 0 and 1-based numeric index for slots", () => {
            const slots: SlotInfo[] = [
                { path: "/pool/repo-wt1", status: "assigned", branch: "feature/auth", diff: "+100 -20" },
                { path: "/pool/repo-wt2", status: "free", branch: "-", diff: "-" }
            ];
            printList(ROOT_SLOT, slots);
            expect(console.table).toHaveBeenCalledWith({
                "0": ROOT_SLOT,
                "1": { path: "/pool/repo-wt1", status: "assigned", branch: "feature/auth", diff: "+100 -20" },
                "2": { path: "/pool/repo-wt2", status: "free", branch: "-", diff: "-" }
            });
        });
    });

    describe("parseSlotStatus", () => {
        it("reports a clean slot for empty porcelain output", () => {
            expect(isClean(parseSlotStatus(""))).toBe(true);
        });

        it("classifies a staged modification as a tracked change", () => {
            const status = parseSlotStatus("M  src/pubsub.ts\n");
            expect(status.tracked).toEqual([{ code: "M ", path: "src/pubsub.ts" }]);
            expect(status.untracked).toEqual([]);
            expect(isClean(status)).toBe(false);
        });

        // "git diff --quiet HEAD" exits 0 here, which is how untracked files reached "git clean -fd".
        it("classifies an untracked file as untracked, not clean", () => {
            const status = parseSlotStatus("?? scratch.txt\n");
            expect(status.tracked).toEqual([]);
            expect(status.untracked).toEqual([{ code: "??", path: "scratch.txt" }]);
            expect(isClean(status)).toBe(false);
        });

        it("separates tracked from untracked, and keeps unstaged, rename and unmerged entries tracked", () => {
            const status = parseSlotStatus([
                "M  staged.ts",
                " M unstaged.ts",
                "R  old.ts -> new.ts",
                "UU conflicted.ts",
                "?? scratch.txt",
                ""
            ].join("\n"));

            expect(status.tracked.map(change => change.path)).toEqual(["staged.ts", "unstaged.ts", "old.ts -> new.ts", "conflicted.ts"]);
            expect(status.untracked.map(change => change.path)).toEqual(["scratch.txt"]);
        });
    });

    describe("commands", () => {
        beforeEach(() => {
            files.clear();
            dirs.clear();
            gitLog = [];
            porcelain = {};
            porcelainAfterCheckout = {};
            stashSubjects = [];
            checkoutRan = false;
            mockQuestion.mockReset();
            jest.clearAllMocks();
            installFsFake();
            installGitFake();
            jest.spyOn(console, "log").mockImplementation(() => {});
            jest.spyOn(console, "error").mockImplementation(() => {});
            jest.spyOn(process, "exit").mockImplementation(code => {
                throw new Error(`process.exit(${code})`);
            });
            setTty(false);
        });

        afterEach(() => jest.restoreAllMocks());

        describe("cmdAssign", () => {
            it("refuses to repurpose the only free slot when it holds tracked changes", async () => {
                givenFreePool(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await expect(cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, true)).rejects.toThrow("process.exit(1)");

                expect(gitCommands("checkout")).toEqual([]);
                expect(gitCommands("clean -fd")).toEqual([]);
                expect(files.has(markerFile(1))).toBe(true);
            });

            it("names the offending paths so the leftover work is traceable", async () => {
                givenFreePool(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\nM  test/setup.ts\n";

                await expect(cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, true)).rejects.toThrow("process.exit(1)");

                const reported = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(reported).toContain("src/pubsub.ts");
                expect(reported).toContain("test/setup.ts");
            });

            it("skips a dirty free slot and repurposes the next clean one", async () => {
                givenFreePool(2);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, true);

                expect(gitCommands("checkout").join("\n")).toContain(slotDir(2));
                expect(gitCommands("checkout").join("\n")).not.toContain(slotDir(1));
                expect(files.has(markerFile(1))).toBe(true);
                expect(files.has(markerFile(2))).toBe(false);
            });

            it("asks before git clean -fd deletes untracked files, and keeps the slot free when refused", async () => {
                givenFreePool(1);
                porcelain[slotDir(1)] = "?? scratch.txt\n";
                setTty(true);
                mockQuestion.mockResolvedValue("n");

                await cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, false);

                expect(mockQuestion).toHaveBeenCalled();
                expect(gitCommands("clean -fd")).toEqual([]);
                expect(gitCommands("checkout")).toEqual([]);
                expect(files.has(markerFile(1))).toBe(true);
            });

            it("deletes untracked files and checks out once the deletion is confirmed", async () => {
                givenFreePool(1);
                porcelain[slotDir(1)] = "?? scratch.txt\n";
                setTty(true);
                mockQuestion.mockResolvedValue("y");

                await cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, false);

                expect(gitCommands("clean -fd").length).toBe(1);
                expect(gitCommands("checkout").length).toBeGreaterThan(0);
                expect(files.has(markerFile(1))).toBe(false);
            });

            it("fails loudly when the slot is not clean after the checkout", async () => {
                givenFreePool(1);
                porcelainAfterCheckout[slotDir(1)] = "M  src/pubsub.ts\n";

                await expect(cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, true)).rejects.toThrow("process.exit(1)");

                const reported = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(reported).toContain("not clean after checkout");
            });

            it("surfaces the note recorded when the slot was freed", async () => {
                const note: FreeNote = {
                    freedAt: "2026-08-20T14:12:12.000Z",
                    branch: "ARCH-000-test-jest-client",
                    preserved: {
                        method: "stash",
                        ref: "2a1200a5d4e5630c390e70636480d0c697e0b3a1",
                        label: "git-wt-pool repo-wt1 ARCH-000-test-jest-client 20260820T141212",
                        restore: "git -C slot stash apply 2a1200a5d4e5630c390e70636480d0c697e0b3a1"
                    }
                };
                givenFreePool(1, { 1: note });

                await cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, true);

                const printed = (console.log as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(printed).toContain("ARCH-000-test-jest-client");
                expect(printed).toContain("2a1200a5d4e5630c390e70636480d0c697e0b3a1");
                expect(printed).toContain("stash apply");
            });

            it("writes the assigned slot to --cwd-file so the gwt wrapper can cd into it", async () => {
                givenFreePool(1);

                await cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, true, CWD_FILE);

                expect(files.get(CWD_FILE)).toBe(`${slotDir(1)}\n`);
            });

            it("writes no cwd file when the assign is aborted", async () => {
                givenFreePool(1);
                porcelain[slotDir(1)] = "?? scratch.txt\n";
                setTty(true);
                mockQuestion.mockResolvedValue("n");

                await cmdAssign(REPO_ROOT, POOL_DIR, REPO_NAME, "PCS-4821", true, false, CWD_FILE);

                expect(files.has(CWD_FILE)).toBe(false);
            });
        });

        describe("cmdPath", () => {
            it("prints the slot path and writes it to --cwd-file", () => {
                givenAssignedSlot(1);

                cmdPath(REPO_ROOT, POOL_DIR, REPO_NAME, "1", CWD_FILE);

                expect(console.log).toHaveBeenCalledWith(slotDir(1));
                expect(files.get(CWD_FILE)).toBe(`${slotDir(1)}\n`);
            });

            it("resolves root to the main repo", () => {
                givenAssignedSlot(1);

                cmdPath(REPO_ROOT, POOL_DIR, REPO_NAME, "root", CWD_FILE);

                expect(files.get(CWD_FILE)).toBe(`${REPO_ROOT}\n`);
            });

            it("refuses a missing slot and writes no cwd file", () => {
                givenAssignedSlot(1);

                expect(() => cmdPath(REPO_ROOT, POOL_DIR, REPO_NAME, "7", CWD_FILE)).toThrow("process.exit(1)");

                expect(files.has(CWD_FILE)).toBe(false);
            });
        });

        describe("cmdInit", () => {
            const HOME = path.join("C:", "Users", "me");
            const NPM_DIR = path.join(HOME, "AppData", "Roaming", "npm");
            const SHELL_DIR = path.join(NPM_DIR, "node_modules", "git-worktree-pool", "shell");
            const BIN_DIR = path.join(HOME, "bin");
            const SYSTEM_DIR = path.join("C:", "Windows", "system32");
            const interactive = { print: false, all: false };
            const context = (overrides: Partial<InitContext> = {}): InitContext => ({
                shellDir: SHELL_DIR,
                platform: "win32",
                env: { PATH: [SYSTEM_DIR, NPM_DIR, BIN_DIR].join(path.delimiter) },
                homeDir: HOME,
                interactive: true,
                detected: "powershell",
                ...overrides
            });
            const installedCopies = (file: string): string[] => [...files.keys()].filter(key => key.endsWith(file) && !key.startsWith(SHELL_DIR));

            beforeEach(() => {
                dirs.add(NPM_DIR);
                dirs.add(BIN_DIR);
                for (const file of ["gwt.sh", "gwt.ps1", "gwt.cmd"]) {
                    files.set(path.join(SHELL_DIR, file), `<${file}>`);
                }
            });

            it("copies gwt.ps1 into npm's global bin directory when it is on PATH and the user accepts the defaults", async () => {
                mockQuestion.mockResolvedValue("");

                await cmdInit(undefined, interactive, context());

                expect(files.get(path.join(NPM_DIR, "gwt.ps1"))).toBe("<gwt.ps1>");
                expect(installedCopies("gwt.ps1")).toEqual([path.join(NPM_DIR, "gwt.ps1")]);
            });

            // PATH is not listed (it commonly holds dozens of entries); the user pastes the directory.
            it("asks for a directory when npm's directory is not on PATH, and copies to the pasted one", async () => {
                mockQuestion.mockResolvedValueOnce("cmd").mockResolvedValueOnce(BIN_DIR);

                await cmdInit(undefined, interactive, context({ env: { PATH: [SYSTEM_DIR, BIN_DIR].join(path.delimiter) } }));

                expect(files.get(path.join(BIN_DIR, "gwt.cmd"))).toBe("<gwt.cmd>");
                expect(installedCopies("gwt.cmd")).toEqual([path.join(BIN_DIR, "gwt.cmd")]);
                const printed = (console.log as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(printed).not.toContain(SYSTEM_DIR);
            });

            it("expands ~ in a pasted directory", async () => {
                mockQuestion.mockResolvedValueOnce("n").mockResolvedValueOnce("~/bin");

                await cmdInit("powershell", interactive, context());

                expect(installedCopies("gwt.ps1")).toEqual([path.join(BIN_DIR, "gwt.ps1")]);
            });

            it("warns before copying to a directory that is not on PATH, and aborts when declined", async () => {
                mockQuestion.mockResolvedValueOnce("n").mockResolvedValueOnce(path.join("C:", "elsewhere")).mockResolvedValueOnce("n");

                await cmdInit("powershell", interactive, context());

                expect(installedCopies("gwt.ps1")).toEqual([]);
                const reported = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(reported).toContain("not on your PATH");
            });

            it("installs gwt.sh under $HOME and appends one source line to the profile, even when run twice", async () => {
                mockQuestion.mockResolvedValue("");
                files.set(path.join(HOME, ".bashrc"), "export FOO=1");
                const ctx = context({ platform: "linux", detected: "bash", env: { PATH: "/usr/bin" } });

                await cmdInit(undefined, interactive, ctx);
                await cmdInit(undefined, interactive, ctx);

                expect(files.get(path.join(HOME, ".config", "git-wt-pool", "gwt.sh"))).toBe("<gwt.sh>");
                const profile = files.get(path.join(HOME, ".bashrc")) ?? "";
                expect(profile.startsWith("export FOO=1\n")).toBe(true);
                expect(profile).toContain(`source "$HOME/${POSIX_WRAPPER_HOME_PATH}"`);
                expect(profile.split("\n").filter(line => line.includes(POSIX_WRAPPER_HOME_PATH)).length).toBe(1);
            });

            it("defaults to ~/.zshrc for zsh", async () => {
                mockQuestion.mockResolvedValue("");

                await cmdInit("zsh", interactive, context({ platform: "darwin", env: { PATH: "/usr/bin" } }));

                expect(files.get(path.join(HOME, ".zshrc"))).toContain(POSIX_WRAPPER_HOME_PATH);
                expect(files.has(path.join(HOME, ".bashrc"))).toBe(false);
            });

            it("prints the manual steps and writes nothing without a terminal or with --print", async () => {
                await cmdInit(undefined, interactive, context({ interactive: false }));
                await cmdInit(undefined, { print: true, all: false }, context());

                expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
                expect(mockedFs.appendFileSync).not.toHaveBeenCalled();
                expect(mockQuestion).not.toHaveBeenCalled();
                const printed = (console.log as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(printed).toContain("Your shell looks like PowerShell");
            });

            it("rejects an unknown shell name before asking anything", async () => {
                await expect(cmdInit("fish", interactive, context())).rejects.toThrow("process.exit(1)");

                expect(mockQuestion).not.toHaveBeenCalled();
                expect(mockedFs.copyFileSync).not.toHaveBeenCalled();
            });
        });

        describe("cmdFree", () => {
            it("refuses to free tracked changes unattended, and records nothing", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await expect(cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, false)).rejects.toThrow("process.exit(1)");

                expect(files.has(markerFile(1))).toBe(false);
                expect(gitCommands("checkout --detach")).toEqual([]);
            });

            it("points at --force as a preserving escape hatch, not a discarding one", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await expect(cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, false)).rejects.toThrow("process.exit(1)");

                const reported = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(reported).toContain("--force to stash them first");
                expect(reported).toContain("nothing is discarded");
            });

            it("stashes tracked changes under --force and records the stash SHA in the marker", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, true);

                expect(gitCommands("stash push -u -m").length).toBe(1);
                const note = readFreeNote(slotDir(1));
                expect(note?.branch).toBe("ARCH-000-old-branch");
                expect(note?.preserved?.method).toBe("stash");
                expect(note?.preserved?.ref).toBe("0".repeat(40));
                expect(note?.preserved?.restore).toContain(`stash apply ${"0".repeat(40)}`);
            });

            it("never addresses the shared stash stack by index and never pops it", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, true);

                const allGit = gitLog.join("\n");
                expect(allGit).not.toContain("stash@{");
                expect(allGit).not.toContain("stash pop");
                expect(readFreeNote(slotDir(1))?.preserved?.restore).not.toContain("stash@{");
            });

            it("records the untracked files left behind when the slot held only untracked files", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "?? scratch.txt\n?? profile.cpuprofile\n";

                await cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, false);

                const note = readFreeNote(slotDir(1));
                expect(note?.leftUntracked).toEqual(["scratch.txt", "profile.cpuprofile"]);
                expect(note?.preserved).toBeUndefined();
                expect(gitCommands("stash push")).toEqual([]);
            });

            it("parks the work on a wip branch when asked to interactively", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";
                setTty(true);
                mockQuestion.mockResolvedValue("park");

                await cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", false, false);

                expect(gitCommands("checkout -b \"wip/").length).toBe(1);
                expect(gitCommands("commit -q -m").length).toBe(1);
                expect(readFreeNote(slotDir(1))?.preserved?.method).toBe("wip-branch");
            });

            it("discards nothing when the discard confirmation is declined", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";
                setTty(true);
                mockQuestion.mockResolvedValueOnce("discard").mockResolvedValueOnce("n");

                await cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", false, false);

                expect(gitCommands("reset -q --hard")).toEqual([]);
                expect(files.has(markerFile(1))).toBe(false);
            });

            it("records what was thrown away when discard is confirmed", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";
                setTty(true);
                mockQuestion.mockResolvedValueOnce("discard").mockResolvedValueOnce("y");

                await cmdFree(REPO_ROOT, POOL_DIR, REPO_NAME, "1", false, false);

                expect(gitCommands("reset -q --hard").length).toBe(1);
                expect(readFreeNote(slotDir(1))?.discarded).toEqual(["M  src/pubsub.ts"]);
            });
        });

        describe("cmdRemove", () => {
            it("warns about the untracked files that git worktree remove --force destroys", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "?? scratch.txt\n";

                await cmdRemove(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, false);

                const reported = (console.error as jest.Mock).mock.calls.map(call => String(call[0])).join("\n");
                expect(reported).toContain("untracked file(s)");
                expect(reported).toContain("scratch.txt");
                expect(gitCommands("worktree remove --force").length).toBe(1);
            });

            it("still refuses tracked changes without --force", async () => {
                givenAssignedSlot(1);
                porcelain[slotDir(1)] = "M  src/pubsub.ts\n";

                await expect(cmdRemove(REPO_ROOT, POOL_DIR, REPO_NAME, "1", true, false)).rejects.toThrow("process.exit(1)");

                expect(gitCommands("worktree remove")).toEqual([]);
            });
        });
    });
});
