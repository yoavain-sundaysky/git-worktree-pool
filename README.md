# git-worktree-pool

A reusable [Git worktree](https://git-scm.com/docs/git-worktree) pool manager for repositories where initializing a fresh worktree is expensive (e.g. large dependency installs, IDE re-indexing).

---

## The Problem

Git worktrees let you work on multiple branches simultaneously - each branch gets its own working directory with no stashing required. But creating a fresh worktree can be slow:

```sh
git worktree add ../myrepo-feature feature/my-branch
cd ../myrepo-feature
# ... expensive setup: npm install, build, IDE indexing ...
```

The obvious fix - reusing worktrees instead of recreating them - is exactly what `git-wt-pool` automates.

---

## The Solution: A Worktree Pool

Instead of creating and destroying worktrees per branch, maintain a **numbered pool** of persistent worktrees. Each slot can be either **assigned** (locked to a branch) or **free** (available for reuse). Switching a slot to a new branch is fast because the working directory already exists.

### Directory Layout

```
<parent>/
├── myrepo/                        ← main repo (any branch)
└── myrepo-wt-pool/                ← pool root (sibling of repo)
    ├── .free-myrepo-wt3           ← free marker for slot 3
    ├── myrepo-wt1/                ← assigned to feature/auth
    ├── myrepo-wt2/                ← assigned to fix/login-bug
    └── myrepo-wt3/                ← free (checked out on default branch)
```

### The `.free-<slotname>` Marker

A `.free-<slotname>` file in the **pool root** (not inside the worktree) marks a slot as **free**. Keeping the marker outside the worktree means it never appears in `git status` and no `.gitignore` entry is needed.

| State    | Marker in pool root?        |
|----------|-----------------------------|
| Free     | ✅ `.free-myrepo-wt3` etc.  |
| Assigned | ❌ No marker                |

---

## Installation

Two steps. First the CLI:

```sh
npm install -g git-worktree-pool
```

Then the `gwt` wrapper for your shell. `gwt` is what you type at the prompt; it runs `git-wt-pool` and changes directory for you after `assign` and `path`. `init` detects your shell, asks where to install, and does it:

```sh
git-wt-pool init             # interactive install for the detected shell
git-wt-pool init bash        # or name the shell: bash | zsh | powershell | cmd
git-wt-pool init --print     # only show the manual steps (add --all for every shell)
```

At an interactive prompt, `git-wt-pool` insists on running through `gwt` and points at `init` until the wrapper is installed. Scripts and CI can call `git-wt-pool` directly. Details in [Shell wrapper](#shell-wrapper-cd-into-the-slot-automatically).

---

## Commands

```
git-wt-pool list | ls                        Show all pool slots and their status (ls is an alias for list)
git-wt-pool assign <branch> [-n] [-y]           Assign a free slot to a branch (copies path to clipboard)
git-wt-pool free   <number|path> [-y] [-f]   Release a slot back to the pool
git-wt-pool remove <number|path> [-y] [-f]   Permanently delete a slot from the pool
git-wt-pool path   [root|<number>]           Copy path of main repo or a pool slot to clipboard
git-wt-pool init   [<shell>] [--print]       Install the `gwt` wrapper for your shell (--print: show the manual steps)
```

### Flags

| Flag | Short | Commands | Description |
|------|-------|----------|-------------|
| `--no-setup` | `-n` | `assign` | Skip post-assign setup hooks |
| `--yes` | `-y` | `assign` | Delete leftover untracked files without asking |
| `--yes` | `-y` | `free`, `remove` | Skip confirmation prompt |
| `--force` | `-f` | `free` | Stash the uncommitted work, then free the slot |
| `--force` | `-f` | `remove` | Remove a slot that holds uncommitted changes |
| `--cwd-file <file>` | - | `assign`, `path` | Also write the resulting path to `<file>` (used by the `gwt` wrapper) |
| `--help` | `-h` | all | Show usage |

### Examples

```sh
# See what's in the pool (works from main repo, any worktree, or pool root)
git-wt-pool list

# Assign a branch - path to the assigned worktree is copied to clipboard automatically
git-wt-pool assign feature/my-feature

# Copy the main repo path or a specific slot path to clipboard, then cd in your shell
git-wt-pool path root
git-wt-pool path 2

# Done with a branch - free the slot for reuse
git-wt-pool free 2

# Permanently remove a slot you no longer need
git-wt-pool remove 3
```

### `list` output

```
  Pool : C:\dev\myrepo-wt-pool
  ---------------------------------------------------
┌─────────┬──────────────┬──────────┬─────────────────┐
│ (index) │ path         │ status   │ branch          │
├─────────┼──────────────┼──────────┼─────────────────┤
│ 1       │ 'myrepo-wt1' │ 'assigned'│ 'feature/auth' │
│ 2       │ 'myrepo-wt2' │ 'assigned'│ 'fix/login-bug'│
│ 3       │ 'myrepo-wt3' │ 'free'   │ '-'             │
└─────────┴──────────────┴──────────┴─────────────────┘
```

---

## Shell wrapper: `cd` into the slot automatically

A child process cannot change its parent's working directory, on any OS. So `git-wt-pool` itself can only copy the path. The `gwt` wrapper does the `cd`: it runs inside your shell, calls `git-wt-pool` with `--cwd-file <tempfile>`, and changes to the path the CLI writes there. Only `assign` and `path` write the file, so `gwt list` or `gwt free 2` never move you.

The wrappers ship with the package, in its `shell/` folder:

| File | Shell | Install |
|---|---|---|
| `shell/gwt.sh` | bash, zsh | `source` it from `~/.bashrc` / `~/.zshrc` |
| `shell/gwt.ps1` | PowerShell | copy it into a directory on your `PATH` |
| `shell/gwt.cmd` | cmd.exe | copy it into a directory on your `PATH` |

`git-wt-pool init` detects the shell you are in and installs the wrapper for it:

| Shell | What `init` does |
|---|---|
| PowerShell, cmd.exe | copies `gwt.ps1` / `gwt.cmd` into a directory on your `PATH`: npm's global bin directory when it is on `PATH` (one confirmation), otherwise you paste the directory you want (it warns if that one is not on `PATH`) |
| bash, zsh | copies `gwt.sh` to `~/.config/git-wt-pool/gwt.sh` and appends `source "$HOME/.config/git-wt-pool/gwt.sh"` to `~/.bashrc` / `~/.zshrc` (or a file you name). Running it again changes nothing. The copy is sourced rather than the install directory, so a Node version switch under nvm does not break it |

`init` shows what it will write and asks before writing. `git-wt-pool init --print` prints the manual steps instead, with the absolute path of the bundled file; that is also what `init` does when stdin is not a terminal:

```
 Your shell looks like PowerShell.

 PowerShell    copy the file into a directory on your PATH:
               Copy-Item "C:\Users\me\AppData\Roaming\npm\node_modules\git-worktree-pool\shell\gwt.ps1" <directory-on-PATH>

 Other shells: git-wt-pool init --print bash | zsh | powershell | cmd, or git-wt-pool init --print --all
```

Detection looks at the parent process first (`tasklist` on Windows, `/proc` on Linux, `ps` on macOS) and only then at environment markers (`MSYSTEM`/`SHELL` for Git Bash, the user module path PowerShell prepends to `PSModulePath`, `SHELL` on Linux/macOS). Markers alone would be wrong for a cmd window opened from PowerShell or an editor started from Git Bash, because children inherit them. If the guess is wrong, name the shell: `git-wt-pool init powershell`.

Why the difference: a file on `PATH` runs as a child process, which cannot `cd` for you, so the bash/zsh wrapper must be sourced into the shell. PowerShell scripts and cmd batch files run inside the calling session, so a copy on `PATH` is enough.

Then:

```sh
gwt assign feature/my-feature   # assigns a slot and cd's into it
gwt path root                   # back to the main repo
gwt path 2                      # into slot 2
gwt list                        # same as git-wt-pool list; you stay where you are
```

`gwt` keeps stdin attached, so the interactive prompts of `assign` and `free` still work, and it returns the CLI's exit code. When `assign` stops before a slot is assigned, nothing is written and you stay where you are.

### How `git-wt-pool` knows it runs through `gwt`

Each wrapper sets `GIT_WT_POOL_WRAPPER=1` for the child process only (bash: a per-command prefix; PowerShell: set in `try`, removed in `finally`; cmd: inside `setlocal`). When the variable is missing **and** stdin is a terminal, `git-wt-pool` prints a two-line error pointing at `git-wt-pool init` and exits 1 instead of running the command - the plain CLI at a prompt would leave you with a path on the clipboard and nothing else. This includes a bare `git-wt-pool` with no command, so the first thing a new user sees is the pointer to `init`. `git-wt-pool init` and `--help` are exempt. Without a terminal (scripts, CI, `.superset` hooks, agents) the CLI runs as usual.

---

## Command Flows

### `assign <branch>` - Get a worktree for a branch

```mermaid
flowchart LR
    A([assign branch]) --> B{Branch already\nassigned?}
    B -- Yes --> C([ERROR: already in use])
    B -- No --> D{Free slot\nexists?}
    D -- Yes --> D2{Free slot has\ntracked changes?}
    D2 -- Yes --> D3[Skip slot, warn\nwith the paths]
    D3 --> D8{Another\nfree slot?}
    D8 -- Yes --> D2
    D8 -- No --> D4([ERROR: every free slot is dirty])
    D2 -- No --> D5{Untracked\nfiles?}
    D5 -- Yes --> D6{-y, or confirm\ndeletion?}
    D6 -- No --> D7([Aborted, slot stays free])
    D6 -- Yes --> E
    D5 -- No --> E[Print marker note,\nremove free marker]
    D -- No --> F[Create new\nnumbered slot]
    E --> E2[git clean -fd\nremove untracked files]
    E2 --> G{Branch exists\nlocally?}
    F --> G
    G -- Yes --> H[git checkout branch]
    G -- No --> I{Branch exists\non remote?}
    I -- Yes --> J[git checkout --track\norigin/branch]
    I -- No --> K[git checkout -b\ncreate branch]
    H --> P{Slot clean\nafter checkout?}
    J --> P
    K --> P
    P -- No --> PA([ERROR: not clean,\nslot stays assigned])
    P -- Yes --> L[Done - path on clipboard\nand in --cwd-file]
    L --> M{.superset/config.json\nexists?}
    M -- No --> N([Done])
    M -- Yes --> O[Run setup commands\nwith env vars injected]
    O --> N
```

### `free <slot>` - Return a worktree to the pool

```mermaid
flowchart LR
    A([free slot]) --> B{Worktree\nexists?}
    B -- No --> C([ERROR: not found])
    B -- Yes --> D{Already\nfree?}
    D -- Yes --> E([Already free - nothing to do])
    D -- No --> F{Uncommitted\ntracked changes?}
    F -- "Yes,\n--force" --> F2[Stash with a unique tag,\nresolve its SHA]
    F -- Yes,\nunattended --> G([ERROR: use --force to stash first])
    F -- Yes,\ninteractive --> F3{stash / park /\nabort / discard}
    F3 -- abort --> HA
    F3 -- stash --> F2
    F3 -- park --> F4[Commit to a\nwip/ branch]
    F3 -- discard --> F5[Confirm again, then\nreset --hard + clean -fd]
    F -- No,\nuntracked only --> F6[WARNING:\nfiles stay in place]
    F -- No --> H
    F6 --> H{--yes or\nconfirm?}
    H -- No --> HA([Aborted])
    H -- Yes --> HB[Checkout default branch]
    F2 --> HB
    F4 --> HB
    F5 --> HB
    HB --> I[Write free marker + note:\nbranch, what was kept, how to restore]
    I --> J([Slot is now free])
```

### `remove <slot>` - Permanently delete a worktree

```mermaid
flowchart LR
    A([remove slot]) --> B{Worktree\nexists?}
    B -- No --> C([ERROR: not found])
    B -- Yes --> D0{Tracked changes\nand no --force?}
    D0 -- Yes --> D1([ERROR: use --force to remove anyway])
    D0 -- No --> D{Assigned, tracked\nor untracked?}
    D -- Yes --> E{Confirm\nremove?}
    E -- No --> F([Aborted])
    E -- Yes --> G[git worktree remove --force]
    D -- No --> G
    G --> H[Clean up free marker\nif present]
    H --> I([Slot gone])
```

---

## Post-Assign Setup Hooks (Superset convention)

After a successful `assign`, `git-wt-pool` checks for a `.superset/config.json` file in the repo root. If found, it runs the commands listed in the `setup` array - the same lifecycle hook that [Superset](https://superset.sh) uses when creating a new workspace.

### Config format

```json
{
    "setup": ["node .superset/setup.js"],
    "teardown": [],
    "run": []
}
```

Only `setup` is read. The other keys are ignored.

### Environment variables injected

| Variable | Value |
|---|---|
| `SUPERSET_ROOT_PATH` | Absolute path to the main repo |
| `SUPERSET_WORKSPACE_PATH` | Absolute path to the assigned worktree slot |
| `SUPERSET_WORKSPACE_NAME` | The branch name |

Commands run sequentially with `cwd` set to the assigned worktree slot and `stdio: "inherit"` so all output is visible. If any command exits non-zero, the process exits with an error.

Repos without `.superset/config.json` are unaffected - the hooks step is silently skipped.

---

## Tips

- **How many slots?** Start with 3. Add more with `assign` - the pool grows automatically.
- **Slot numbering** fills gaps: if `wt2` is removed, the next `assign` reuses number `2`.
- **A dirty slot is never handed out.** Cleanliness comes from `git status --porcelain`, so untracked files count. `git diff --quiet HEAD` is not used: it cannot see untracked files, and `git checkout <branch>` carries staged changes across with exit code 0 when the dirty paths are identical in HEAD and in the target branch.
- **Dirty guard on `free`** - a slot with uncommitted tracked changes is never freed unattended. `--force` stashes the work first and discards nothing. Run `free` interactively to choose a stash, a `wip/` branch, abort, or an explicitly confirmed discard. Discard is never reachable under `-y`.
- **The free marker records what was left behind.** `.free-<slot>` is JSON: when the slot was freed, which branch it was on, and how to restore work that was stashed or parked. `assign` prints it when it repurposes the slot. Markers written by older versions are zero-byte and still read as "free, no note".
- **Guard on repurpose** - `assign` skips a free slot that still holds tracked changes and warns with the paths. It asks before `git clean -fd` deletes untracked files (`-y` deletes them without asking). After the checkout it re-checks that the slot is clean, and fails loudly if it is not. Files covered by `.gitignore` (e.g. `node_modules`) are never touched by `git clean -fd`.
- **The stash stack is shared** by the main repo and every slot, so `free` tags each entry uniquely and records its SHA. Restore is always `git stash apply <sha>`, never `stash@{0}` and never `stash pop`.
- **Default branch checkout** - `free` checks out the repo's default branch before releasing, so the freed branch is no longer locked in any worktree and can be deleted immediately with `git branch -d`.
- **Branch creation** - `assign` creates the branch if it doesn't exist, branching from the repo's default branch (main/master).
- **Remote tracking** - if the branch exists on `origin`, it is checked out with tracking automatically.
- **Works alongside your main repo** - the pool lives as a sibling directory and never touches your primary checkout.
- **`gwt` is the command you type** - the bundled wrappers (`shell/gwt.sh`, `gwt.ps1`, `gwt.cmd`) run the CLI with `--cwd-file` and change directory after `assign` and `path`. `git-wt-pool init` installs the one for your shell; at a prompt, `git-wt-pool` itself only points at `init` until that is done. See [Shell wrapper](#shell-wrapper-cd-into-the-slot-automatically).
- **Post-assign setup** - if a `.superset/config.json` exists, its `setup` commands run automatically after every `assign` (e.g. copy `.env`, allocate a port, run `npm install`). See [Post-Assign Setup Hooks](#post-assign-setup-hooks-superset-convention) above.

---

## Implementation

The CLI is implemented in TypeScript using Node.js built-ins (`node:util`, `node:child_process`, `node:fs`, `node:path`) and [`clipboardy`](https://github.com/sindresorhus/clipboardy) for cross-platform clipboard access. Args are parsed with `parseArgs` from `node:util`. The `gwt` wrappers are plain scripts in `shell/` (`gwt.sh` for bash/zsh, `gwt.ps1` for PowerShell, `gwt.cmd` for cmd.exe); they ship in the npm package and `.gitattributes` pins their line endings (LF for the first two, CRLF for cmd).

```
src/
└── bin/
    └── git-wt-pool.ts     ← CLI entry point (all commands)
```
