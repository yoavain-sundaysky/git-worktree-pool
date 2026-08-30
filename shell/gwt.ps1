# gwt - git-wt-pool wrapper for PowerShell.
#
# Copy this file into a directory on your PATH. PowerShell runs scripts inside your session,
# so the Set-Location below changes the location of your prompt.
# Then:  gwt assign <branch>   gwt path root   gwt path 2   (gwt list, gwt free ... stay where you are)
# GIT_WT_POOL_WRAPPER=1 is set for the duration of the call; it tells git-wt-pool that it runs through the wrapper.

$cwdFile = [System.IO.Path]::GetTempFileName()
try {
    $env:GIT_WT_POOL_WRAPPER = "1"
    & git-wt-pool @args --cwd-file $cwdFile
    if ((Get-Item -LiteralPath $cwdFile).Length -gt 0) {
        Set-Location -LiteralPath (Get-Content -LiteralPath $cwdFile -Raw).Trim()
    }
}
finally {
    Remove-Item Env:GIT_WT_POOL_WRAPPER -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $cwdFile -ErrorAction SilentlyContinue
}
