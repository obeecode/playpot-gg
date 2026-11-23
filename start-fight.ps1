# One-click start for PlayPot with the Fight test game.
# Run it from the playpot-gg folder:   powershell -ExecutionPolicy Bypass -File .\start-fight.ps1
# It puts the two game folders next to playpot-gg (in your projects folder), keeps your private settings in live.env.ps1
# (this file stays on your PC and git ignores it), and starts the server.
$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$projects = Split-Path $repo -Parent
$gameDir = Join-Path $projects "gameplay-core"
$refDir = Join-Path $projects "counterpick-ref"

function Get-Repo($url, $dir) {
  if (Test-Path (Join-Path $dir ".git")) {
    Write-Host "Updating $dir"
    git -C $dir pull
  } elseif (Test-Path $dir) {
    throw "$dir exists but is not a git checkout. Rename or move it, then run this again."
  } else {
    Write-Host "Downloading $url into $dir"
    git clone $url $dir
  }
  if ($LASTEXITCODE -ne 0) { throw "git failed for $dir" }
}

Get-Repo "https://github.com/obeecode/gameplay-core.git" $gameDir
Get-Repo "https://github.com/obeecode/gameplay-assets.git" $refDir

$envFile = Join-Path $repo "live.env.ps1"
if (-not (Test-Path $envFile)) {
  @'
# Your private settings for PlayPot. This file stays on this PC and git ignores it. Never paste it into a chat.
$env:ESCROW = "0x558f479c8de7019AA26893e743e4e9FF3F989FfD"
$env:JINX_ESCROW = "0xd8604826C40B57dA7472A1A813C10DC20Aa7555e"
$env:REFEREE_PK = "0xPUT_THE_REFEREE_PRIVATE_KEY_HERE"
$env:TUNNEL_NAME = "playpot"
$env:TUNNEL_HOST = "app.playpot.gg"
# Add these lines (remove the #) if you use passkey gas sponsoring and email sign-in:
# $env:BUNDLER_URL = "https://api.pimlico.io/v2/84532/rpc?apikey=YOUR_KEY"
# $env:PAYMASTER_URL = $env:BUNDLER_URL
# $env:PAYMASTER_CONTEXT = '{"sponsorshipPolicyId":"sp_your_policy"}'
# $env:BREVO_API_KEY = "xkeysib-..."
# $env:EMAIL_FROM = "no-reply@playpot.gg"
# $env:EMAIL_FROM_NAME = "PlayPot.GG"
'@ | Set-Content -Path $envFile -Encoding ASCII
  Write-Host ""
  Write-Host "I made $envFile for your private settings."
  Write-Host "Notepad opens now: replace the REFEREE_PK line with your real referee key (and the Pimlico/Brevo lines if you use them), save, close, and run this script again."
  notepad $envFile
  exit 0
}
. $envFile
if ($env:REFEREE_PK -like "*PUT_THE*") {
  Write-Host "Open $envFile, put your real referee key on the REFEREE_PK line, save, and run this script again."
  notepad $envFile
  exit 0
}

$env:FIGHT_DIR = $gameDir
$env:FIGHT_REF = $refDir
Set-Location $repo
if (-not (Test-Path (Join-Path $repo "node_modules"))) { npm install }
Write-Host ""
Write-Host "Starting PlayPot with the Fight game. Look for the Fight card in the lobby."
npm run live
