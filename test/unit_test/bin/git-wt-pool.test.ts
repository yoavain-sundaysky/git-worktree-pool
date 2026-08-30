/* eslint-disable node/no-sync -- the fs fake must mirror the sync API the CLI calls */
import * as path from "node:path";

const mockQuestion = jest.fn<Promise<string>, [string]>();

jest.mock("node:child_process", () => ({ execSync: jest.fn() }));
jest.mock("node:fs");
jest.mock("clipboardy", () => ({ writeSync: jest.fn() }));
jest.mock("node:readline/promises", () => ({
    createInterface: () => ({ question: mockQuestion, close: () => {} })
}));

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { FreeNote, SlotInfo } from "../../../src/bin/git-wt-pool";
import { cmdAssign, cmdFree, cmdRemove, isClean, parseSlotStatus, printList, readFreeNote } from "../../../src/bin/git-wt-pool";

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

describe("git-wt-pool", () => {
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
