# Temporary: run the brep test against Delabella and record fatal exits.
# Exit codes stay the raw process code. 0xC0000005 is a fatal, not a script error.
param(
    [Parameter(Mandatory = $true)][ValidateSet("investigate", "occt802")][string]$Phase,
    [Parameter(Mandatory = $true)][string]$OcctRoot,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$summary = Join-Path $OutDir "summary.txt"

function Add-Summary([string]$line) {
    Write-Host $line
    Add-Content -Path $summary -Value $line
}

function Get-ExitHex($code) {
    if ($null -eq $code) { return "null" }
    $n = [int64]$code
    if ($n -lt 0) { $n += 4294967296 }
    return ("{0:X8}" -f $n)
}

function Test-FatalHex([string]$hex) {
    return $hex -in @("C0000005", "C0000374", "C0000409", "C00000FD", "C000001D", "C0000094", "C0000096")
}

function Find-Cdb {
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64\cdb.exe",
        "${env:ProgramFiles}\Windows Kits\10\Debuggers\x64\cdb.exe"
    )
    foreach ($path in $roots) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    $found = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits", "${env:ProgramFiles}\Windows Kits" -Recurse -Filter cdb.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "x64\\cdb.exe$" } |
        Select-Object -First 1
    if ($found) { return $found.FullName }
    return $null
}

function Get-OpenFace([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return "NO_LOG" }
    $open = $null
    $openSplit = $null
    $lastMesh = $null
    foreach ($line in Get-Content -LiteralPath $path) {
        if ($line -like "MESH_BEGIN*") { $lastMesh = $line }
        elseif ($line -like "FACE_BEGIN*") { $open = $line }
        elseif ($line -like "FACE_END*") { $open = $null }
        elseif ($line -like "FACE_SPLIT_BEGIN*") { $openSplit = $line }
        elseif ($line -like "FACE_SPLIT_END*") { $openSplit = $null }
    }
    if ($open) { return $open }
    if ($openSplit) { return $openSplit }
    if ($lastMesh) { return "NO_OPEN_FACE last=$lastMesh" }
    return "NO_OPEN_FACE"
}

function Show-MeshTail([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) {
        Add-Summary "MESH_LOG_MISSING $path"
        return
    }
    Add-Summary "MESH_TAIL $path"
    Get-Content -LiteralPath $path -Tail 30 | ForEach-Object { Add-Summary "MESH $_" }
    Add-Summary ("CRASH_FACE " + (Get-OpenFace $path))
}

$env:PATH = "$OcctRoot\bin;$OcctRoot\lib;" + $env:PATH
$env:OCCT_ROOT = $OcctRoot
$env:LIME_REQUIRE_OCCT = "1"
$env:RUST_BACKTRACE = "1"
$env:CARGO_BUILD_JOBS = "4"
Add-Summary "PHASE $Phase OCCT_ROOT=$OcctRoot"
Add-Summary ("MACHINE runner=" + $env:RUNNER_NAME + " os=" + [Environment]::OSVersion.VersionString)
Get-CimInstance Win32_Processor | ForEach-Object {
    Add-Summary ("CPU name=" + $_.Name + " logical=" + $_.NumberOfLogicalProcessors)
}
if (Test-Path (Join-Path $OcctRoot "lime-occt-build.txt")) {
    Add-Summary ("OCCT_BUILD " + (Get-Content (Join-Path $OcctRoot "lime-occt-build.txt") -Raw).Trim())
}
Get-ChildItem "$OcctRoot\bin\TKMesh.*" -ErrorAction SilentlyContinue | ForEach-Object {
    Add-Summary ("TKMESH " + $_.Name + " bytes=" + $_.Length)
}

function Find-Brep([string]$targetDir) {
    $deps = Join-Path $targetDir "debug\deps"
    $exe = Get-ChildItem $deps -Filter "brep-*.exe" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($exe) { return $exe.FullName }
    return $null
}

function Invoke-Plain([string]$exe, [int]$times, [string]$label, [int]$timeoutSec) {
    $crashes = 0; $passes = 0; $other = 0; $timeouts = 0
    $ms = @()
    $kept = $null
    $otherShown = 0
    for ($i = 1; $i -le $times; $i++) {
        $mesh = Join-Path $OutDir "mesh-$label-$i.txt"
        if (Test-Path $mesh) { Remove-Item $mesh -Force }
        $env:LIME_OCCT_MESH_LOG = $mesh
        $stdout = Join-Path $OutDir "stdout-$label-$i.txt"
        $stderr = Join-Path $OutDir "stderr-$label-$i.txt"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $p = Start-Process -FilePath $exe -ArgumentList @("--exact", "a_saved_solid_reopens_as_its_step", "--nocapture") -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $finished = $p.WaitForExit($timeoutSec * 1000)
        $sw.Stop()
        if (-not $finished) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            $timeouts++
            Add-Summary "TIMEOUT $label iter=$i elapsed_ms=$($sw.ElapsedMilliseconds)"
            continue
        }
        $hex = Get-ExitHex $p.ExitCode
        $ms += $sw.ElapsedMilliseconds
        if ($p.ExitCode -eq 0) {
            $passes++
            Remove-Item $stdout, $stderr, $mesh -ErrorAction SilentlyContinue
        }
        elseif (Test-FatalHex $hex) {
            $crashes++
            Add-Summary "CRASH $label iter=$i exit=0x$hex elapsed_ms=$($sw.ElapsedMilliseconds)"
            if (-not $kept) {
                $kept = $mesh
                Show-MeshTail $mesh
            }
        }
        else {
            $other++
            Add-Summary "OTHER $label iter=$i exit=$($p.ExitCode) (0x$hex) elapsed_ms=$($sw.ElapsedMilliseconds)"
            if ($otherShown -lt 3) {
                $otherShown++
                if (Test-Path $stderr) { Get-Content $stderr -Tail 15 | ForEach-Object { Add-Summary "STDERR $label $_" } }
                if (Test-Path $stdout) { Get-Content $stdout -Tail 15 | ForEach-Object { Add-Summary "STDOUT $label $_" } }
            }
        }
    }
    $avg = if ($ms.Count) { [int](($ms | Measure-Object -Average).Average) } else { 0 }
    Add-Summary "RESULT $label crashes=$crashes passes=$passes other=$other timeouts=$timeouts total=$times avg_ms=$avg"
    return $crashes
}

function Invoke-CdbUntil([string]$exe, [string]$cdb, [int]$times, [string]$label) {
    $sym = "$OcctRoot\bin;" + (Split-Path $exe)
    $scriptPath = Join-Path $OutDir "cdb-commands.txt"
    Set-Content -Path $scriptPath -Encoding ascii -Value @(
        ".echo CDB_READY",
        ".lines -e",
        ".symopt+ 0x40",
        'sxd -c ".echo FACE_STACK_BEGIN; .echo ---KP---; kP; .echo ---LN---; ln; .echo ---REGS---; r; .echo ---THREADS---; ~*kP; .echo ---ANALYZE---; !analyze -v; .echo FACE_STACK_END; q" av',
        'sxe -c ".echo FACE_STACK_BEGIN; .echo FASTFAIL_374; kP; ln; r; ~*kP; .echo FACE_STACK_END; q" c0000374',
        'sxe -c ".echo FACE_STACK_BEGIN; .echo FASTFAIL_409; kP; ln; r; ~*kP; .echo FACE_STACK_END; q" c0000409',
        "g",
        "q"
    )
    $hits = 0
    for ($i = 1; $i -le $times; $i++) {
        $mesh = Join-Path $OutDir "mesh-$label-$i.txt"
        if (Test-Path $mesh) { Remove-Item $mesh -Force }
        $env:LIME_OCCT_MESH_LOG = $mesh
        $log = Join-Path $OutDir "cdb-$label-$i.txt"
        $cmd = '$<' + $scriptPath
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $p = Start-Process -FilePath $cdb -ArgumentList @("-g", "-G", "-lines", "-logo", $log, "-y", $sym, "-c", $cmd, $exe, "--exact", "a_saved_solid_reopens_as_its_step", "--nocapture") -PassThru
        $finished = $p.WaitForExit(180000)
        $sw.Stop()
        if (-not $finished) {
            taskkill /F /T /PID $p.Id 2>$null | Out-Null
            Add-Summary "CDB_TIMEOUT $label iter=$i elapsed_ms=$($sw.ElapsedMilliseconds)"
            continue
        }
        $hex = Get-ExitHex $p.ExitCode
        $text = ""
        if (Test-Path $log) { $text = [string](Get-Content $log -Raw -ErrorAction SilentlyContinue) }
        if ($text -match "FACE_STACK_BEGIN" -and $text -match "TKMesh|buildBaseTriangulation|elabella") {
            $hits++
            Add-Summary "CDB_HIT $label iter=$i exit=0x$hex elapsed_ms=$($sw.ElapsedMilliseconds) log=$log"
            Show-MeshTail $mesh
            Add-Summary "CDB_LOG_FOLLOWS $log"
            Get-Content $log | ForEach-Object { Write-Host $_ }
            return $hits
        }
        Add-Summary "CDB_MISS $label iter=$i exit=0x$hex elapsed_ms=$($sw.ElapsedMilliseconds)"
    }
    Add-Summary "CDB_NO_HIT $label tries=$times"
    return $hits
}

if ($Phase -eq "investigate") {
    $brep = Find-Brep "target"
    if (-not $brep) {
        Add-Summary "NO_BREP_EXE"
        exit 1
    }
    Add-Summary "BREP $brep"
    $env:LIME_OCCT_MESHER = "delabella"
    $env:LIME_OCCT_MESH_PARALLEL = "0"
    Remove-Item Env:LIME_OCCT_MESH_SPLIT -ErrorAction SilentlyContinue
    Add-Summary "VARIANT serial Delabella InParallel=false MESHER=$($env:LIME_OCCT_MESHER) PARALLEL=$($env:LIME_OCCT_MESH_PARALLEL)"
    $cdb = Find-Cdb
    Add-Summary "CDB=$cdb"
    $hits = 0
    if ($cdb) {
        $hits = Invoke-CdbUntil $brep $cdb 60 "serial"
    }
    else {
        Add-Summary "CDB_MISSING serial face log still recorded by a plain loop"
        Invoke-Plain $brep 60 "serial-plain" 180 | Out-Null
    }
    if ($hits -eq 0 -and $cdb) {
        Add-Summary "VARIANT serial plain, cdb did not break"
        Invoke-Plain $brep 40 "serial-plain" 180 | Out-Null
    }

    $env:LIME_OCCT_MESH_SPLIT = "1"
    Add-Summary "VARIANT split one face per IncrementalMesh, Delabella, MESHER=$($env:LIME_OCCT_MESHER) SPLIT=$($env:LIME_OCCT_MESH_SPLIT)"
    Invoke-Plain $brep 40 "split" 180 | Out-Null
    Remove-Item Env:LIME_OCCT_MESH_SPLIT -ErrorAction SilentlyContinue

    if ($hits -eq 0 -and $cdb) {
        Remove-Item Env:LIME_OCCT_MESH_PARALLEL -ErrorAction SilentlyContinue
        Add-Summary "VARIANT parallel Delabella InParallel=true because serial produced no stack"
        Invoke-CdbUntil $brep $cdb 40 "parallel" | Out-Null
    }
    Add-Summary "INVESTIGATE_DONE"
    exit 0
}

# OCCT 8.0.2: the product bridge if it links, otherwise the standalone mesher.
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) "target-occt802"
$buildLog = Join-Path $OutDir "cargo-occt802.txt"
Add-Summary "CARGO_TARGET_DIR=$($env:CARGO_TARGET_DIR)"
$cargoErr = "$buildLog.err"
$cargo = Start-Process -FilePath "cargo" -ArgumentList @("test", "-p", "lime-model-occt", "--test", "brep", "--locked", "--no-run", "-vv") -PassThru -Wait -NoNewWindow -RedirectStandardOutput $buildLog -RedirectStandardError $cargoErr
$cargoExit = $cargo.ExitCode
Add-Summary "CARGO_OCCT802 exit=$cargoExit log=$buildLog"
if ($cargoExit -ne 0) {
    Add-Summary "CARGO_OCCT802_FAIL tail:"
    foreach ($log in @($buildLog, $cargoErr)) {
        if (Test-Path $log) { Get-Content $log -Tail 40 | ForEach-Object { Add-Summary "CARGO $_" } }
    }
    $standalone = Join-Path $OutDir "standalone"
    $cmakeLog = Join-Path $OutDir "cmake-standalone.txt"
    $cmakeErr = "$cmakeLog.err"
    $cfgProc = Start-Process -FilePath "cmake" -ArgumentList @("-S", "tools/w2", "-B", $standalone, "-DCMAKE_PREFIX_PATH=$OcctRoot", "-A", "x64") -PassThru -Wait -NoNewWindow -RedirectStandardOutput $cmakeLog -RedirectStandardError $cmakeErr
    $cfg = $cfgProc.ExitCode
    if ($cfg -eq 0) {
        $cfgProc = Start-Process -FilePath "cmake" -ArgumentList @("--build", $standalone, "--config", "Release", "--parallel", "2") -PassThru -Wait -NoNewWindow -RedirectStandardOutput "$cmakeLog.build" -RedirectStandardError "$cmakeErr.build"
        $cfg = $cfgProc.ExitCode
    }
    Add-Summary "STANDALONE_CMAKE exit=$cfg"
    if ($cfg -ne 0) {
        foreach ($log in @($cmakeLog, $cmakeErr, "$cmakeLog.build", "$cmakeErr.build")) {
            if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 40 | ForEach-Object { Add-Summary "CMAKE $_" } }
        }
        Add-Summary "OCCT802_BUILD_FAILED"
        exit 1
    }
    $exe = Get-ChildItem $standalone -Recurse -Filter "delabella_loop.exe" | Select-Object -First 1 -ExpandProperty FullName
    if (-not $exe) {
        Add-Summary "NO_STANDALONE_EXE"
        exit 1
    }
    Add-Summary "STANDALONE $exe"
    $crashes = 0; $passes = 0; $other = 0; $timeouts = 0
    for ($i = 1; $i -le 200; $i++) {
        $p = Start-Process -FilePath $exe -PassThru
        if (-not $p.WaitForExit(180000)) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            $timeouts++
            continue
        }
        $hex = Get-ExitHex $p.ExitCode
        if ($p.ExitCode -eq 0) { $passes++ }
        elseif (Test-FatalHex $hex) {
            $crashes++
            Add-Summary "CRASH standalone iter=$i exit=0x$hex"
        }
        else {
            $other++
            Add-Summary "OTHER standalone iter=$i exit=0x$hex"
        }
    }
    Add-Summary "RESULT occt802-standalone crashes=$crashes passes=$passes other=$other timeouts=$timeouts total=200"
    Add-Summary "OCCT802_DONE bridge=no"
    exit 0
}

$brep = Find-Brep $env:CARGO_TARGET_DIR
if (-not $brep) {
    Add-Summary "NO_BREP_EXE_OCCT802"
    exit 1
}
Add-Summary "BREP802 $brep"
$env:LIME_OCCT_MESHER = "delabella"
Remove-Item Env:LIME_OCCT_MESH_PARALLEL -ErrorAction SilentlyContinue
Remove-Item Env:LIME_OCCT_MESH_SPLIT -ErrorAction SilentlyContinue
Add-Summary "VARIANT occt802 Delabella InParallel=true (product path) 200 runs"
Invoke-Plain $brep 200 "occt802" 180 | Out-Null
Add-Summary "OCCT802_DONE bridge=yes"
exit 0
