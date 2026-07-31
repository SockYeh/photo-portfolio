# Syncs photos from VSCO and pushes the update to GitHub.
# Run from the project root:  powershell -ExecutionPolicy Bypass -File scripts/update.ps1
# Or right-click -> "Run with PowerShell".

param(
  [switch]$Probe
)

if ($Probe) {
  npm run probe
  exit $LASTEXITCODE
}

npm run sync
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git add -A
if (git diff --cached --quiet) {
  Write-Host "No changes to commit - photos are already up to date."
} else {
  git commit -m "sync: update photos"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  git push
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Done. GitHub Actions will rebuild and deploy the site automatically."
