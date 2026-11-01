# Sourced from Git Bash on Windows: loads the x64 Visual Studio developer environment (cl, link, lib, the SDK's
# INCLUDE and LIB) from vcvars64.bat, which vswhere finds. Needs the "Desktop development with C++" workload.
vswhere="$(cygpath -u "${PROGRAMFILES:-C:\\Program Files} (x86)")/Microsoft Visual Studio/Installer/vswhere.exe"
[ -x "$vswhere" ] || { echo "msvc-env.sh: vswhere.exe not found; install Visual Studio with the C++ workload" >&2; return 1; }
vs_dir=$("$vswhere" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | tr -d '\r' | head -n 1)
[ -n "$vs_dir" ] || { echo "msvc-env.sh: Visual Studio has no C++ tools (cl.exe)" >&2; return 1; }
vs_bat=$(mktemp --suffix=.bat)
# vcvars64.bat looks for vswhere on PATH itself.
printf '@set "PATH=%s;%%PATH%%"\r\n@call "%s\\VC\\Auxiliary\\Build\\vcvars64.bat" > nul\r\n@set\r\n' "$(cygpath -w "$(dirname "$vswhere")")" "$vs_dir" > "$vs_bat"
vs_old_path=$(cygpath -wp "$PATH")
while IFS='=' read -r vs_name vs_value; do
  vs_value=${vs_value%$'\r'}
  case "$vs_name" in
    Path|PATH)
      # Prepend only the entries vcvars added, converted to Git Bash paths.
      vs_add=""
      IFS=';' read -r -a vs_parts <<< "$vs_value"
      for vs_p in "${vs_parts[@]}"; do
        [ -n "$vs_p" ] || continue
        case ";$vs_old_path;" in *";$vs_p;"*) ;; *) vs_add="$vs_add:$(cygpath -u "$vs_p")" ;; esac
      done
      PATH="${vs_add#:}:$PATH"
      ;;
    INCLUDE|LIB|LIBPATH|VCINSTALLDIR|VCToolsInstallDir|VCToolsVersion|VCToolsRedistDir|VSINSTALLDIR|WindowsSdkDir|WindowsSDKVersion|WindowsSdkBinPath|WindowsSdkVerBinPath|WindowsLibPath|UCRTVersion|UniversalCRTSdkDir|ExtensionSdkDir|DevEnvDir|Platform|VSCMD_ARG_TGT_ARCH|VSCMD_ARG_HOST_ARCH|VSCMD_VER)
      export "$vs_name=$vs_value"
      ;;
  esac
done < <(cmd.exe //d //c "$(cygpath -w "$vs_bat")")
rm -f "$vs_bat"
export PATH
command -v cl.exe > /dev/null || { echo "msvc-env.sh: vcvars64.bat did not put cl.exe on PATH" >&2; return 1; }
unset vswhere vs_dir vs_bat vs_old_path vs_name vs_value vs_add vs_parts vs_p
