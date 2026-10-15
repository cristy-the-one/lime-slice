# Copy the Visual C++ runtime DLLs into a bundle directory.
#
# lime-slice-desktop.exe (through the vendored Clipper2 C++) and every Open
# CASCADE DLL link the C++ runtime dynamically. A Windows install without
# Visual Studio or the VC++ Redistributable has no msvcp140.dll, so the app
# does not start. Microsoft allows these DLLs to ship beside the program
# ("app-local"). tauri.crt.json puts them next to the exe, which is the first
# folder Windows searches for the exe and, through
# LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, for the Open CASCADE bridge.

param(
    [Parameter(Mandatory = $true)][string]$Dest
)

$ErrorActionPreference = "Stop"
$names = @("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll")

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere.exe is missing, so Visual Studio cannot be found" }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "No Visual Studio with the x64 C++ tools is installed" }

# The newest toolset's redistributable folder, e.g. VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT.
$crt = Get-ChildItem (Join-Path $vs "VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT") -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "msvcp140.dll") } |
    Sort-Object { [version]$_.Parent.Parent.Name } -Descending |
    Select-Object -First 1
if (-not $crt) { throw "No Visual C++ runtime redistributable folder under $vs" }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($name in $names) {
    $source = Join-Path $crt.FullName $name
    if (-not (Test-Path $source)) { throw "$name is missing from $($crt.FullName)" }
    Copy-Item $source (Join-Path $Dest $name) -Force
}
Write-Host "Staged $($names -join ', ') from $($crt.FullName)"
