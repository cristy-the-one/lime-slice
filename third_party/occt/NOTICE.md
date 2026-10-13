# Open CASCADE Technology

Lime Slice ships Open CASCADE Technology 7.9.2 as shared libraries so a STEP solid can be edited. The slicer does not link these libraries. The modeling crate loads them when `OCCT_ROOT` is set at build time, and the desktop shell does not load them until Model mode is switched on.

Open CASCADE Technology is licensed under the GNU Lesser General Public License version 2.1, with the Open CASCADE exception 1.0. Both texts are beside this notice (`LICENSE_LGPL_21.txt`, `OCCT_LGPL_EXCEPTION.txt`).

The header files used by `crates/lime-model/cpp/bridge.cpp` are part of that library. The exception allows the object code that incorporates that header material to be distributed under other terms, provided this notice is given. The rest of Lime Slice remains MIT. Changes to Open CASCADE Technology itself, if any were shipped, would stay under the LGPL. This build does not modify the Open CASCADE sources.

The shared libraries are replaceable. On Linux they are loaded by soname with rpath `$ORIGIN`. On macOS the install names are `@rpath`. On Windows they are DLLs. A user may substitute an interface-compatible build of the same toolkits.

## Source offer

The source of the libraries is the official archive for tag `V7_9_2`:

https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V7_9_2.tar.gz

SHA-256: `3cd080d3fc33ba0c6c157e110afe3e015859524c4694dbb09812ec9d61595639`

The commands that compile it are `tools/occt/install.py` in the Lime Slice repository, at the commit that produced the installer. For at least three years after a release that includes these libraries, that source archive and that script will be made available on request through the Lime Slice project repository.
