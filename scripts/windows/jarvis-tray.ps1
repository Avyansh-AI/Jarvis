# jarvis-tray.ps1 — optional Windows tray wrapper for the Jarvis hub.
#
# Zero dependencies: Windows PowerShell 5.1 + WinForms ship with Windows 10/11.
# Run it hidden at login (a .lnk or scheduled task pointing at
#   powershell -WindowStyle Hidden -File …\jarvis-tray.ps1
# or double-click start-jarvis-quiet.vbs if you only want the hub, no tray).
#
# Tray menu:
#   • hub status (version · skills · satellites) — read live from /api/health
#   • open web app / Jarvis Remote / Settings (browser, localhost)
#   • start the hub quietly / stop the hub (same command `npm start` runs)
#   • quit the tray
#
# Honesty rules this script sticks to:
#   - LAUNCHER/CONTROL only: never a config surface. Port and keys stay in
#     .env; nothing here reads, writes or displays any credential or token.
#   - "Stop hub" kills ONLY the process this tray started (tracked PID).
#     It never broad-kills "node" or anything else on the machine.
#   - The hub URL is always 127.0.0.1 (this machine) — no remote calls.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts/windows → repo root
$Port = if ($env:PORT) { $env:PORT } else { '8080' }
$Base = "http://127.0.0.1:$Port"
$script:Hub = $null

function Get-HubHealth { try { Invoke-RestMethod -TimeoutSec 2 -UseBasicParsing "$Base/api/health" } catch { $null } }
function Test-HubUp { [bool](Get-HubHealth) }

function Start-QuietHub {
  if (Test-HubUp) { return }                       # never a second server
  $script:Hub = Start-Process node -ArgumentList 'hub/server.js' -WorkingDirectory $Root -WindowStyle Hidden -PassThru
}
function Stop-QuietHub {
  if ($script:Hub) { Stop-Process -Id $script:Hub.Id; $script:Hub = $null }
}

# ---- tray icon (small drawn glyph — no external image files) ----
$bmp = New-Object Drawing.Bitmap 32, 32
$g = [Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, 4, 16, 31))), 1, 1, 30, 30)
$g.DrawEllipse((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(255, 60, 224, 255), 3)), 4, 4, 24, 24)
$g.Dispose()
$hicon = $bmp.GetHicon()

$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = [Drawing.Icon]::FromHandle($hicon)
$tray.Visible = $true

$menu = New-Object Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add('status: checking…')
$miStatus.Enabled = $false
$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miStart = $menu.Items.Add('Start hub (quiet)')
$miStop = $menu.Items.Add('Stop hub')
$miWeb = $menu.Items.Add('Open web app')
$miRemote = $menu.Items.Add('Open Jarvis Remote')
$miSettings = $menu.Items.Add('Open Settings')
$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miQuit = $menu.Items.Add('Quit tray')

function Update-Status {
  $h = Get-HubHealth
  if ($h) {
    $tray.Text = "Jarvis hub v$($h.version) — up"
    $miStatus.Text = "up · v$($h.version) · $($h.skills) skills · $($h.satellites) satellites"
  } else {
    $tray.Text = 'Jarvis hub — down'
    $miStatus.Text = 'down (start it, then open the web app)'
  }
  $miStart.Enabled = -not $h
  $miStop.Enabled = [bool]($script:Hub)   # stop is scoped to OUR process
}

$miStart.Add_Click({ Start-QuietHub; Start-Sleep -Seconds 2; Update-Status })
$miStop.Add_Click({ Stop-QuietHub; Update-Status })
$miWeb.Add_Click({ Start-Process $Base })
$miRemote.Add_Click({ Start-Process "$Base/dashboard.html" })
$miSettings.Add_Click({ Start-Process "$Base/settings.html" })
$miQuit.Add_Click({ $tray.Visible = $false })

$tray.Add_MouseDoubleClick({ Start-Process $Base })

Update-Status
$ticks = 0
while ($tray.Visible) {
  [Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 250
  $ticks++
  if ($ticks -ge 40) { $ticks = 0; Update-Status }   # refresh hub status ~every 10 s
}
$tray.Dispose()
