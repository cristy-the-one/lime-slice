// Calls one exported Open CASCADE function so the shared library stays linked.
// OCCT is LGPL-2.1 with the Open CASCADE exception. The notice is
// third_party/occt/NOTICE.md. This file is part of Lime Slice (MIT).

#include <Standard_VersionInfo.hxx>

extern "C" const char* lime_model_occt_version(void) {
    return OCCT_Version_String_Complete();
}
