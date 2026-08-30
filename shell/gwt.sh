# gwt - git-wt-pool wrapper for bash and zsh.
#
# A child process cannot change the cwd of your shell, so this file must be SOURCED, not executed.
# Add to ~/.bashrc or ~/.zshrc:
#   source "/path/to/git-worktree-pool/shell/gwt.sh"
# Then:  gwt assign <branch>   gwt path root   gwt path 2   (gwt list, gwt free ... stay where you are)
# GIT_WT_POOL_WRAPPER=1 is set for the child only; it tells git-wt-pool that it runs through the wrapper.

if [ -n "${BASH_VERSION:-}" ] && [ "${BASH_SOURCE[0]}" = "$0" ]; then
    echo "gwt.sh must be sourced, not executed. Add this line to your shell profile:  source \"$0\"" >&2
    exit 1
fi

gwt() {
    local cwd_file rc
    cwd_file="$(mktemp)" || return 1
    GIT_WT_POOL_WRAPPER=1 command git-wt-pool "$@" --cwd-file "$cwd_file"
    rc=$?
    if [ -s "$cwd_file" ]; then
        cd -- "$(cat "$cwd_file")" || rc=$?
    fi
    rm -f "$cwd_file"
    return "$rc"
}
