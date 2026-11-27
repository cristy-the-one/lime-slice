// Temporary stand-in for the brep test when the bridge does not compile against a newer OCCT.
// Box, a hole, a cut, then a fillet, meshed with Delabella after each one. The same shapes the
// brep test builds, not the bridge's own hole operator.

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <IMeshTools_Parameters.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <cstdio>

namespace {

void mesh(const TopoDS_Shape& shape, const char* label) {
    std::fprintf(stderr, "STANDALONE_MESH %s\n", label);
    std::fflush(stderr);
    IMeshTools_Parameters parameters;
    parameters.Deflection = 0.1;
    parameters.Angle = 0.5;
    parameters.Relative = false;
    parameters.InParallel = true;
    parameters.MeshAlgo = IMeshTools_MeshAlgoType_Delabella;
    BRepMesh_IncrementalMesh mesher(shape, parameters);
    (void)mesher;
}

}  // namespace

int main() {
    const TopoDS_Shape box = BRepPrimAPI_MakeBox(20.0, 20.0, 20.0).Shape();
    mesh(box, "box");
    const TopoDS_Shape hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(10.0, 10.0, 20.0), gp_Dir(0.0, 0.0, -1.0)), 3.0, 8.0).Shape();
    const TopoDS_Shape holed = BRepAlgoAPI_Cut(box, hole).Shape();
    mesh(holed, "hole");
    const TopoDS_Shape cutter = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0.0, 0.0, 12.0), gp_Dir(0.0, 0.0, 1.0)), 6.0, 20.0).Shape();
    const TopoDS_Shape cut = BRepAlgoAPI_Cut(holed, cutter).Shape();
    mesh(cut, "cut");
    BRepFilletAPI_MakeFillet fillet(cut);
    TopExp_Explorer edges(cut, TopAbs_EDGE);
    if (edges.More()) {
        fillet.Add(1.0, TopoDS::Edge(edges.Current()));
        fillet.Build();
        if (fillet.IsDone()) {
            mesh(fillet.Shape(), "fillet");
        }
    }
    return 0;
}
