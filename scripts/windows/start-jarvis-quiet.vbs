Option Explicit
' Jarvis — quiet (no console window) launcher for Windows.
'
'   Double-click to start the hub invisibly; it keeps running in the
'   background after the launcher itself exits. To start on login:
'   Win+R → shell:startup → drop a shortcut to this file there.
'   (Prefer restart-on-failure/crash-resilience? Run jarvis-tray.ps1 hidden —
'   it shows a tray menu and can start/stop the hub.)
'
'   A second double-click while the hub is already up is a NO-OP: we ask the
'   hub's own /api/health first, so this never starts a duplicate server.
'
' Honesty rules this file sticks to:
'   - It is a LAUNCHER, not a config. It runs exactly what `npm start` runs
'     (node hub/server.js). No bespoke entry point, no flags, no overrides.
'   - It never reads, writes or embeds any credential — port, keys and tokens
'     live in .env / Settings only, same as always.
'   - The one hidden PowerShell call is a localhost GET for the running? probe;
'     no remote content is ever downloaded or executed.
Dim sh, fso, root, nodeCmd, port, already
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
nodeCmd = "node"   ' ← full path (e.g. C:\Program Files\nodejs\node.exe) if node is not on the SYSTEM PATH
port = "8080"      ' ← match PORT here if you set it in .env

already = sh.Run("powershell -noprofile -command ""if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:" & port & "/api/health')) { exit 0 } else { exit 1 }""", 0, True)
If already = 0 Then WScript.Quit 0   ' hub already up — quietly do nothing

sh.CurrentDirectory = root
sh.Run """" & nodeCmd & """ hub\server.js", 0, False   ' window style 0 = hidden; don't wait
