<#
  Installs the EMS MCP server as a Windows service using NSSM (https://nssm.cc).
  Run in an ELEVATED PowerShell from the project folder:
     .\scripts\install-service.ps1 -NssmPath C:\tools\nssm.exe
  Optional: -ServiceUser "DOMAIN\svc-emsmcp" -ServicePassword "..."  (recommended: a dedicated low-privilege account)
#>
param(
  [string]$NssmPath = "nssm.exe",
  [string]$ServiceName = "EmsMcp",
  [string]$ServiceUser = "",
  [string]$ServicePassword = "",
  [string]$BrowsersPath = "C:\ems-mcp-browsers"
)
$ErrorActionPreference = "Stop"
$dir  = (Resolve-Path "$PSScriptRoot\..").Path
$node = (Get-Command node).Source
if (-not (Test-Path "$dir\.env")) { throw ".env not found in $dir - copy .env.example to .env and fill it in first." }

& $NssmPath install $ServiceName $node "server.js"
& $NssmPath set $ServiceName AppDirectory $dir
& $NssmPath set $ServiceName AppEnvironmentExtra "PLAYWRIGHT_BROWSERS_PATH=$BrowsersPath" "NODE_ENV=production"
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppStdout "$dir\logs\out.log"
& $NssmPath set $ServiceName AppStderr "$dir\logs\err.log"
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 5242880
New-Item -ItemType Directory -Force "$dir\logs", "$dir\data" | Out-Null
if ($ServiceUser) {
  & $NssmPath set $ServiceName ObjectName $ServiceUser $ServicePassword
  # Only the service account + admins may read data (encrypted creds/sessions) and .env (SECRET)
  icacls "$dir\data" /inheritance:r /grant:r "${ServiceUser}:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
  icacls "$dir\.env" /inheritance:r /grant:r "${ServiceUser}:R" "Administrators:F" | Out-Null
  icacls $BrowsersPath /grant "${ServiceUser}:(OI)(CI)RX" | Out-Null
}
& $NssmPath start $ServiceName
Write-Host "Service '$ServiceName' installed and started. Test: curl http://127.0.0.1:3000/health"
