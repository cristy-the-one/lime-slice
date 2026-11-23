// Open CASCADE operations for the Model history tree (tree.cpp). This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <locale>
#include <mutex>
#include <sstream>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressScope.hxx>
#include <Message_Printer.hxx>
#include <Message_PrinterOStream.hxx>
#include <TCollection_AsciiString.hxx>

#include <BinTools.hxx>
#include <OSD_Parallel.hxx>
#include <BRepAdaptor_CompCurve.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepLProp_SLProps.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_Check.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepFill.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_NormalProjection.hxx>
#include <BRepProj_Projection.hxx>
#include <ShapeAnalysis_FreeBounds.hxx>
#include <ShapeAnalysis_Surface.hxx>
#include <TopTools_HSequenceOfShape.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <gp_GTrsf.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GC_MakeEllipse.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Wire.hxx>
#include <Geom_BSplineCurve.hxx>
#include <GeomAbs_Shape.hxx>
#include <GeomConvert.hxx>
#include <GeomConvert_CompCurveToBSplineCurve.hxx>
#include <GeomFill_BSplineCurves.hxx>
#include <GeomFill_ConstrainedFilling.hxx>
#include <GeomFill_SimpleBound.hxx>
#include <Geom_BezierCurve.hxx>
#include <Geom_BSplineSurface.hxx>
#include <Geom_BezierSurface.hxx>
#include <Geom_Circle.hxx>
#include <Geom_Curve.hxx>
#include <Geom_Surface.hxx>
#include <GeomAdaptor_Curve.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <BRepTopAdaptor_FClass2d.hxx>
#include <BRepBuilderAPI_TransitionMode.hxx>
#include <Law_Interpol.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <TColStd_Array2OfReal.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <Draft_ErrorStatus.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffset_Mode.hxx>
#include <ChFi3d.hxx>
#include <ChFiDS_TypeOfConcavity.hxx>
#include <GeomAbs_JoinType.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeFillet2d.hxx>
#include <BRepOffsetAPI_MakeOffset.hxx>
#include <ChFi2d_ConstructionError.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Domain.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepGProp_Vinert.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <IMeshTools_Parameters.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
// K4: a drafted or stopped face extrude, a per-face offset, and a face's outline.
#include <BRepFeat_MakeDPrism.hxx>
#include <BRepFeat_MakePrism.hxx>
#include <BRepOffset_MakeOffset.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <GeomAPI_ProjectPointOnCurve.hxx>
#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <gp_Pnt2d.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
// K3: draft prisms (the LocOpe prism BRepFeat_MakeDPrism::Perform builds) and an extrude that stops on a face.
// LGPL, linked dynamically with the rest of Open CASCADE.
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepFeat_MakePrism.hxx>
#include <LocOpe_DPrism.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRepPrimAPI_MakeWedge.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <GeomAbs_Shape.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <Poly_TriangulationParameters.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <Standard_Failure.hxx>
#include <Standard_VersionInfo.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Sphere.hxx>
#include <gp_Mat.hxx>
#include <gp_Pnt.hxx>
#include <gp_Quaternion.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include "kernel.h"

#ifdef LIME_OCCT_STEP
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_ActorRead.hxx>
#include <StepData_StepModel.hxx>
#include <StepRepr_RepresentationRelationshipWithTransformation.hxx>
#include <StepShape_ContextDependentShapeRepresentation.hxx>
#include <StepShape_ShapeRepresentation.hxx>
#include <StepGeom_Axis2Placement3d.hxx>
#include <XSControl_WorkSession.hxx>
#include <XSControl_TransferReader.hxx>
#include <Transfer_TransientProcess.hxx>
#include <functional>
#include <map>
#include <set>
#include <STEPControl_StepModelType.hxx>
#include <STEPControl_Writer.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDF_Label.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <Quantity_Color.hxx>
#include <DESTEP_Parameters.hxx>
#endif

/// OCCT's default messenger prints STEP transfer statistics on std::cout.
/// A console-subsystem process shows that as a window. The lines go to a log instead.
class LimeOcctLogPrinter : public Message_Printer {
    DEFINE_STANDARD_RTTIEXT(LimeOcctLogPrinter, Message_Printer)
public:
    explicit LimeOcctLogPrinter(std::string path) : path_(std::move(path)) {
        const std::filesystem::path file(path_);
        std::error_code ignore;
        if (file.has_parent_path()) {
            std::filesystem::create_directories(file.parent_path(), ignore);
        }
        out_.open(file, std::ios::app);
    }

protected:
    void send(const TCollection_AsciiString& text, const Message_Gravity) const override {
        if (!out_.is_open()) {
            return;
        }
        out_ << text.ToCString() << '\n';
        out_.flush();
    }

private:
    std::string path_;
    mutable std::ofstream out_;
};

IMPLEMENT_STANDARD_RTTIEXT(LimeOcctLogPrinter, Message_Printer)

namespace lime_occt {

std::string occt_log_path() {
    const char* bases[] = {std::getenv("LOCALAPPDATA"), std::getenv("TEMP"), std::getenv("TMPDIR"), std::getenv("TMP")};
    for (const char* base : bases) {
        if (base != nullptr && base[0] != '\0') {
            return std::string(base) + "/lime-slice/occt.log";
        }
    }
    return "lime-occt.log";
}

void route_occt_log() {
    static std::once_flag once;
    std::call_once(once, [] {
        const Handle(Message_Messenger) messenger = Message::DefaultMessenger();
        messenger->RemovePrinters(STANDARD_TYPE(Message_PrinterOStream));
#ifdef AddPrinter
#undef AddPrinter
#endif
        messenger->AddPrinter(new LimeOcctLogPrinter(occt_log_path()));
    });
}

const char* split_reject(
    const gp_Pnt& origin,
    const gp_Dir& normal,
    double xmin,
    double ymin,
    double zmin,
    double xmax,
    double ymax,
    double zmax) {
    const double n[3] = {normal.X(), normal.Y(), normal.Z()};
    const double corner[3][2] = {{xmin, xmax}, {ymin, ymax}, {zmin, zmax}};
    double lo = 1e300;
    double hi = -1e300;
    for (int ix = 0; ix < 2; ++ix) {
        for (int iy = 0; iy < 2; ++iy) {
            for (int iz = 0; iz < 2; ++iz) {
                const double d = corner[0][ix] * n[0] + corner[1][iy] * n[1] + corner[2][iz] * n[2];
                lo = std::min(lo, d);
                hi = std::max(hi, d);
            }
        }
    }
    const double thickness = hi - lo;
    // Keep this floor and fraction in step with `splitMargin` in src/model-plane.ts.
    const double margin = std::max(0.25, thickness * 0.02);
    if (!(thickness > margin * 2.0)) {
        return "This solid is too thin to split";
    }
    const double at = origin.X() * n[0] + origin.Y() * n[1] + origin.Z() * n[2];
    if (at < lo - 1e-4 || at > hi + 1e-4) {
        return "The plane did not split this solid";
    }
    if (at < lo + margin || at > hi - margin) {
        return "The plane is too close to a face. Move it into the part.";
    }
    return nullptr;
}

/// How deep `shape` runs along `normal`, read from its vertices.
double vertex_depth_along(const TopoDS_Shape& shape, const gp_Dir& normal) {
    double lo = 1e300;
    double hi = -1e300;
    bool any = false;
    for (TopExp_Explorer explorer(shape, TopAbs_VERTEX); explorer.More(); explorer.Next()) {
        const gp_Pnt point = BRep_Tool::Pnt(TopoDS::Vertex(explorer.Current()));
        const double d = point.X() * normal.X() + point.Y() * normal.Y() + point.Z() * normal.Z();
        lo = std::min(lo, d);
        hi = std::max(hi, d);
        any = true;
    }
    return any ? hi - lo : 0.0;
}

/// How deep `shape` runs along `normal`, at least `enough`. The vertices answer most pieces at
/// once. They can say less than the surfaces do: half a torus, a sphere or a cylinder cut along its
/// axis has every vertex in the cut plane. Only then is the shape boxed exactly from its geometry,
/// relocated into a frame whose Z is `normal` and never copied; on Telo test that box costs about
/// 250 ms a piece, so it is skipped whenever the vertices already show `enough`.
double depth_along(const TopoDS_Shape& shape, const gp_Dir& normal, double enough) {
    const double from_vertices = vertex_depth_along(shape, normal);
    if (from_vertices >= enough) {
        return from_vertices;
    }
    gp_Trsf to_normal;
    to_normal.SetTransformation(gp_Ax3(gp::Origin(), normal));
    Bnd_Box bounds;
    BRepBndLib::AddOptimal(shape.Moved(TopLoc_Location(to_normal)), bounds, Standard_False, Standard_False);
    if (bounds.IsVoid()) {
        return 0.0;
    }
    double xmin = 0;
    double ymin = 0;
    double zmin = 0;
    double xmax = 0;
    double ymax = 0;
    double zmax = 0;
    bounds.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    return zmax - zmin;
}

/// Kernel work done since load. Tests read it to prove a probe's result was reused.
struct Stats {
    std::atomic<long> builds{0};
    std::atomic<long> volumes{0};
    std::atomic<long> tessellations{0};
    std::atomic<long> meshes{0};
    std::atomic<long> descriptions{0};
    /// Meshes of the whole shape; the rest meshed only around the faces a step made.
    std::atomic<long> full_meshes{0};
    /// Microseconds spent in each kind of work, for timing tests and benches.
    std::atomic<long long> boolean_us{0};
    std::atomic<long long> volume_us{0};
    std::atomic<long long> mesh_us{0};
    std::atomic<long long> readout_us{0};
    std::atomic<long long> describe_us{0};
};

Stats g_stats;

/// Adds the time from its making to its end to `total`.
class Timed {
public:
    explicit Timed(std::atomic<long long>& total) : total_(total), start_(std::chrono::steady_clock::now()) {}
    ~Timed() {
        total_ += std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - start_).count();
    }
    Timed(const Timed&) = delete;
    Timed& operator=(const Timed&) = delete;

private:
    std::atomic<long long>& total_;
    std::chrono::steady_clock::time_point start_;
};

char* alloc(const std::string& text) {
    char* out = static_cast<char*>(std::malloc(text.size() + 1));
    if (out == nullptr) {
        return nullptr;
    }
    std::memcpy(out, text.c_str(), text.size() + 1);
    return out;
}

std::string escape(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    for (char c : text) {
        if (c == '\\' || c == '"') {
            out.push_back('\\');
        }
        if (c == '\n' || c == '\r') {
            out.push_back(' ');
            continue;
        }
        out.push_back(c);
    }
    return out;
}

/// One stream per thread in the classic locale: GTK sets the C locale from the environment in the
/// desktop shell, and a decimal comma there would break the JSON.
struct NumberText {
    std::ostringstream stream;
    NumberText() {
        stream.imbue(std::locale::classic());
        stream.setf(std::ios::fixed);
        stream.precision(6);
    }
};

void append_num(std::string& out, double value) {
    thread_local NumberText text;
    text.stream.str(std::string());
    text.stream << value;
    out += text.stream.str();
}

double chord_of(double chord) {
    if (!(chord > 0.0) || chord < 0.01) {
        return 0.01;
    }
    if (chord > 2.0) {
        return 2.0;
    }
    return chord;
}

Held hold_of(const TopoDS_Shape& shape, double volume) {
    Held held;
    held.shape = shape;
    held.volume = volume;
    TopExp::MapShapes(shape, TopAbs_FACE, held.faces);
    TopExp::MapShapes(shape, TopAbs_EDGE, held.edges);
    return held;
}

TopoDS_Shape as_solid(const TopoDS_Shape& shape) {
    if (shape.IsNull() || shape.ShapeType() == TopAbs_SOLID || shape.ShapeType() == TopAbs_COMPSOLID) {
        return shape;
    }
    TopoDS_Shape found;
    int count = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_SOLID); explorer.More(); explorer.Next()) {
        found = explorer.Current();
        count += 1;
        if (count > 1) {
            return shape;
        }
    }
    return count == 1 ? found : shape;
}

void integrate(const TopoDS_Shape& shape, GProp_GProps& props) {
    g_stats.volumes += 1;
    const Timed timed(g_stats.volume_us);
    BRepGProp::VolumeProperties(shape, props);
}

/// Each face integrated about `about` in parallel, added in the order given.
double faces_volume(const std::vector<TopoDS_Face>& faces, const gp_Pnt& about) {
    std::vector<double> parts(faces.size(), 0.0);
    OSD_Parallel::For(0, static_cast<int>(faces.size()), [&faces, &parts, &about](int i) {
        const TopoDS_Face& face = faces[static_cast<size_t>(i)];
        const TopAbs_Orientation orientation = face.Orientation();
        if (orientation != TopAbs_FORWARD && orientation != TopAbs_REVERSED) {
            return;
        }
        BRepGProp_Face surface;
        BRepGProp_Vinert inertia;
        inertia.SetLocation(about);
        surface.Load(face);
        if (face.NbChildren() == 0) {
            inertia.Perform(surface);
        } else {
            BRepGProp_Domain domain;
            domain.Init(face);
            inertia.Perform(surface, domain);
        }
        parts[static_cast<size_t>(i)] = inertia.Mass();
    });
    double total = 0.0;
    for (const double part : parts) {
        total = total + part;
    }
    return total;
}

/// `BRepGProp::VolumeProperties(shape, props).Mass()`, the same number to the last bit, with the faces integrated in
/// parallel. Open CASCADE integrates each face about one point, the mean of the shape's vertices, and adds the faces'
/// volumes in the order it explores them; this integrates each face alone, into its own slot, about the same point, and
/// adds the slots in the same order. A face with no surface, which Open CASCADE measures from its mesh, sends the
/// whole shape to Open CASCADE's own loop.
double integrated_volume(const TopoDS_Shape& shape) {
    g_stats.volumes += 1;
    const Timed timed(g_stats.volume_us);
    gp_XYZ middle(0, 0, 0);
    int vertices = 0;
    for (TopExp_Explorer explorer(shape, TopAbs_VERTEX); explorer.More(); explorer.Next()) {
        middle += BRep_Tool::Pnt(TopoDS::Vertex(explorer.Current())).XYZ();
        vertices += 1;
    }
    std::vector<TopoDS_Face> faces;
    bool plain = vertices > 0;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More() && plain; explorer.Next()) {
        const TopoDS_Face& face = TopoDS::Face(explorer.Current());
        TopLoc_Location location;
        plain = !BRep_Tool::Surface(face, location).IsNull();
        faces.push_back(face);
    }
    if (!plain) {
        GProp_GProps props;
        BRepGProp::VolumeProperties(shape, props);
        return props.Mass();
    }
    middle /= vertices;
    return faces_volume(faces, gp_Pnt(middle));
}

double volume_of(const TopoDS_Shape& shape) {
    if (shape.IsNull()) {
        return 0;
    }
    if (shape.ShapeType() == TopAbs_COMPOUND || shape.ShapeType() == TopAbs_COMPSOLID) {
        double total = 0;
        int count = 0;
        for (TopExp_Explorer explorer(shape, TopAbs_SOLID); explorer.More(); explorer.Next()) {
            total += integrated_volume(explorer.Current());
            count += 1;
        }
        if (count > 0) {
            return total;
        }
    }
    return integrated_volume(shape);
}

/// The volume of `shape` integrated about `about`. Two shapes measured about the same point give the same share for
/// every face they have in common, so the difference of their volumes is what changed and nothing of where the vertices
/// moved: a hole's volume, to the last few bits, out of a piece of a thousand curved faces.
double volume_about(const TopoDS_Shape& shape, const gp_Pnt& about) {
    if (shape.IsNull()) {
        return 0;
    }
    g_stats.volumes += 1;
    const Timed timed(g_stats.volume_us);
    std::vector<TopoDS_Face> faces;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        const TopoDS_Face& face = TopoDS::Face(explorer.Current());
        TopLoc_Location location;
        if (BRep_Tool::Surface(face, location).IsNull()) {
            return volume_of(shape);
        }
        faces.push_back(face);
    }
    return faces_volume(faces, about);
}

bool has_solid(const TopoDS_Shape& shape) {
    TopExp_Explorer explorer(shape, TopAbs_SOLID);
    return explorer.More();
}

bool editable(const TopoDS_Shape& shape, std::string& error) {
    if (has_solid(shape)) {
        return true;
    }
    error = "This STEP file has surfaces but no closed solid, so it can be measured but not edited.";
    return false;
}

/// Mesh converters write each part as a closed shell of loose facets and no solid.
/// Each part is sewn alone, so parts that share a wall stay separate solids.
/// A shell that stays open or crosses itself breaks every edit, so then the
/// surfaces are kept as they are, for measuring only.
TopoDS_Shape solids_from_shells(const std::vector<TopoDS_Shape>& parts, const TopoDS_Shape& surfaces) {
    TopoDS_Compound solids;
    BRep_Builder builder;
    builder.MakeCompound(solids);
    for (const TopoDS_Shape& part : parts) {
        BRepBuilderAPI_Sewing sewing;
        sewing.Add(part);
        sewing.Perform();
        const TopoDS_Shape sewn = sewing.SewedShape();
        if (TopExp_Explorer(sewn, TopAbs_FACE, TopAbs_SHELL).More()) {
            return surfaces;
        }
        for (TopExp_Explorer shell(sewn, TopAbs_SHELL); shell.More(); shell.Next()) {
            if (!BRep_Tool::IsClosed(shell.Current())) {
                return surfaces;
            }
            ShapeFix_Solid fix;
            const TopoDS_Solid solid = fix.SolidFromShell(TopoDS::Shell(shell.Current()));
            if (!BRepAlgoAPI_Check(solid, Standard_False, Standard_True).IsValid()) {
                return surfaces;
            }
            builder.Add(solids, solid);
        }
    }
    return has_solid(solids) ? TopoDS_Shape(solids) : surfaces;
}

void push_point(std::vector<float>& out, const gp_Pnt& point) {
    out.push_back(static_cast<float>(point.X()));
    out.push_back(static_cast<float>(point.Y()));
    out.push_back(static_cast<float>(point.Z()));
}

void append_face_normal(std::string& out, const TopoDS_Face& face);
void append_face_radius(std::string& out, const TopoDS_Face& face);
void append_face_fold(std::string& out, const TopoDS_Face& face);

/// Mesh every face of a solid, never only around what a step made: for tests that compare the two.
std::atomic<bool> g_whole_meshes{false};

/// Whether the face carries a mesh made by a mesh asked at exactly `chord`, which meshing at `chord` keeps: Open CASCADE
/// keeps a mesh made at under 1.1 times the face's own deflection, which is never under the chord
/// (`BRepMesh_ModelPreProcessor`), and records the chord asked with the mesh (`BRepMesh_ModelPostProcessor`). A mesh made
/// at another chord, even a finer one that would be kept too, answers no: its edges could be cut finer than a mesh of the
/// whole solid at `chord` would take them from the faces beside it.
bool mesh_kept(const TopoDS_Face& face, double chord) {
    TopLoc_Location location;
    const Handle(Poly_Triangulation)& mesh = BRep_Tool::Triangulation(face, location);
    if (mesh.IsNull() || mesh->NbTriangles() == 0) {
        return false;
    }
    const Handle(Poly_TriangulationParameters)& made = mesh->Parameters();
    return !made.IsNull() && made->HasDeflection() && made->Deflection() == chord;
}

/// Mesh with Open CASCADE's Watson triangulation, as the bridge did before Delabella: set by a test, or for one run by
/// LIME_OCCT_MESHER=watson in the environment, to compare the two. Never the default.
std::atomic<bool> g_watson_mesher{[] {
    const char* asked = std::getenv("LIME_OCCT_MESHER");
    return asked != nullptr && std::string(asked) == "watson";
}()};

/// Leave a face Delabella could not mesh without triangles, for a test that shows why Watson stands behind it.
std::atomic<bool> g_no_mesher_fallback{false};

/// Every mesh the bridge makes: the faces of `shape` triangulated to within `chord`, half a radian between neighbouring
/// segments, faces in parallel after their shared edges. The triangulation of each face is Open CASCADE's Delabella
/// (a sweep-line Delaunay), not its default Watson: Watson's time on one face grows with the square of the face's
/// holes (1.5 s for a plate face with 1,000 holes), Delabella's does not. The edges are cut the same either way, so
/// the faces still meet point for point. Delabella gives up on some faces of some parts and leaves them with no
/// triangles (239 of a 1,900-face STEP cover, which then had 8,917 open edges): when any face of `shape` is left so,
/// the shape is meshed again with Watson, which keeps every face that has its triangles and meshes the rest.
/// `angle` is half a radian for every mesh that is committed, sliced or exported, as it always was. Only the Model
/// view's display mesh passes mesh_angle_of(chord), on a copy of the shape (display_faces).
///
/// The display mesh's angular deflection (radians) from the linear chord: finer on smooth/organic inspection chords
/// (~0.20 rad at chord <= 0.05 mm) and faster on coarse preview chords (~0.35 rad at chord >= 0.15 mm).
/// Planar faces are unaffected by Angle and keep minimal triangles.
double mesh_angle_of(double chord) {
    if (chord <= 0.05) {
        return 0.20;
    }
    if (chord >= 0.15) {
        return 0.35;
    }
    const double t = (chord - 0.05) / 0.10;
    return 0.20 + t * (0.35 - 0.20);
}

void mesh_faces(const TopoDS_Shape& shape, double chord, double angle = 0.5) {
    IMeshTools_Parameters parameters;
    parameters.Deflection = chord;
    parameters.Angle = angle;
    parameters.Relative = Standard_False;
    parameters.InParallel = Standard_True;
    parameters.MeshAlgo = g_watson_mesher.load() ? IMeshTools_MeshAlgoType_Watson : IMeshTools_MeshAlgoType_Delabella;
    const BRepMesh_IncrementalMesh mesher(shape, parameters);
    if (parameters.MeshAlgo == IMeshTools_MeshAlgoType_Watson || g_no_mesher_fallback.load()) {
        return;
    }
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        TopLoc_Location location;
        const Handle(Poly_Triangulation)& mesh = BRep_Tool::Triangulation(TopoDS::Face(explorer.Current()), location);
        if (mesh.IsNull() || mesh->NbTriangles() == 0) {
            parameters.MeshAlgo = IMeshTools_MeshAlgoType_Watson;
            const BRepMesh_IncrementalMesh again(shape, parameters);
            return;
        }
    }
}

/// Mesh only the faces a step made and the faces beside them, when every other face keeps the mesh it shares with the
/// solid the step was built on. Meshing the whole solid would keep those meshes too, and would mesh the made faces against
/// the same edges of the faces beside them, so the result is the same; it only checks every face first. False when that
/// does not hold, and nothing is meshed.
bool mesh_around_made(Held& held, double chord) {
    const int faces = held.faces.Extent();
    if (!held.built_on || held.made.empty() || 2 * held.made.size() > static_cast<size_t>(faces)) {
        return false;
    }
    std::vector<char> made(static_cast<size_t>(faces) + 1, 0);
    for (const int index : held.made) {
        made[static_cast<size_t>(index)] = 1;
    }
    for (int index = 1; index <= faces; ++index) {
        if (!made[static_cast<size_t>(index)] && !mesh_kept(TopoDS::Face(held.faces(index)), chord)) {
            return false;
        }
    }
    TopTools_IndexedMapOfShape edges;
    for (const int index : held.made) {
        TopExp::MapShapes(held.faces(index), TopAbs_EDGE, edges);
    }
    TopoDS_Compound around;
    BRep_Builder builder;
    builder.MakeCompound(around);
    for (int index = 1; index <= faces; ++index) {
        bool beside = made[static_cast<size_t>(index)] != 0;
        for (TopExp_Explorer explorer(held.faces(index), TopAbs_EDGE); !beside && explorer.More(); explorer.Next()) {
            beside = edges.Contains(explorer.Current());
        }
        if (beside) {
            builder.Add(around, held.faces(index));
        }
    }
    mesh_faces(around, chord);
    return true;
}

/// The faces of a copy of `held.shape`, meshed for the Model view at `chord` with mesh_angle_of(chord), in the order
/// and with the orientation of `held.faces`. Open CASCADE keeps a finer mesh a face already has, so the display mesh
/// never touches the held faces: their mesh stays the one every commit, slice and export reads. A new chord copies
/// again, so a coarser chord is not left with the finer mesh of an earlier one.
const std::vector<TopoDS_Face>& display_faces(Held& held, double chord) {
    const int faces = held.faces.Extent();
    if (held.display_meshed == chord && static_cast<int>(held.display_faces.size()) == faces) {
        return held.display_faces;
    }
    BRepBuilderAPI_Copy copy(held.shape, Standard_False, Standard_False);
    std::vector<TopoDS_Face> copied;
    copied.reserve(static_cast<size_t>(faces));
    for (int index = 1; index <= faces; ++index) {
        const TopoDS_Shape& face = held.faces(index);
        copied.push_back(TopoDS::Face(copy.ModifiedShape(face).Oriented(face.Orientation())));
    }
    mesh_faces(copy.Shape(), chord, mesh_angle_of(chord));
    held.display_shape = copy.Shape();
    held.display_faces = std::move(copied);
    held.display_meshed = chord;
    return held.display_faces;
}

Mesh tessellate(Held& held, double chord, bool display) {
    g_stats.tessellations += 1;
    chord = chord_of(chord);
    // Open CASCADE keeps a finer mesh it already has, so a face shared with a solid meshed finer
    // since is what meshing again would leave too.
    if (display) {
        display_faces(held, chord);
    } else if (held.meshed != chord) {
        g_stats.meshes += 1;
        const Timed timed(g_stats.mesh_us);
        if (g_whole_meshes.load() || !mesh_around_made(held, chord)) {
            g_stats.full_meshes += 1;
            // In parallel: faces mesh apart, after their shared edges, so the mesh is the same as one thread's.
            mesh_faces(held.shape, chord);
        }
        held.meshed = chord;
    }
    const Timed timed(g_stats.readout_us);

    struct Piece {
        Handle(Poly_Triangulation) tri;
        gp_Trsf trsf;
        bool reversed;
        /// Exact outward unit normals for each triangulation node (1-based indexed at i-1), when available.
        std::vector<std::array<float, 3>> node_normals;
        std::vector<uint8_t> node_ok;
        bool constant_normal = false;
        std::array<float, 3> plane_normal = {0.0f, 0.0f, 1.0f};
    };
    std::vector<Piece> pieces(static_cast<size_t>(held.faces.Extent()));
    size_t count = 0;
    const auto face_of = [&held, display](int face_index) {
        return display ? held.display_faces[static_cast<size_t>(face_index - 1)] : TopoDS::Face(held.faces(face_index));
    };
    for (int face_index = 1; face_index <= held.faces.Extent(); ++face_index) {
        const TopoDS_Face face = face_of(face_index);
        TopLoc_Location location;
        Piece& piece = pieces[static_cast<size_t>(face_index - 1)];
        piece.tri = BRep_Tool::Triangulation(face, location);
        piece.trsf = location.Transformation();
        piece.reversed = face.Orientation() == TopAbs_REVERSED;
        if (!piece.tri.IsNull()) {
            count += static_cast<size_t>(piece.tri->NbTriangles());
        }
    }

    // --- Organic surfaces S1: compute exact outward analytic surface normals per triangulation node in parallel, for
    // the display mesh only. Planar faces use their plane's normal (O(1)); curved faces evaluate BRepLProp_SLProps once
    // per UV node.
    OSD_Parallel::For(0, display ? static_cast<int>(pieces.size()) : 0, [&face_of, &pieces](int idx) {
        Piece& piece = pieces[static_cast<size_t>(idx)];
        if (piece.tri.IsNull() || piece.tri->NbTriangles() == 0) {
            return;
        }
        const TopoDS_Face face = face_of(idx + 1);
        const double sign = piece.reversed ? -1.0 : 1.0;
        try {
            BRepAdaptor_Surface surf(face);
            if (surf.GetType() == GeomAbs_Plane) {
                // The surface's own normal is D1U x D1V: the axis for a direct placement, its reverse for an indirect
                // one (mirrored geometry, a left-handed STEP placement).
                const gp_Pln plane = surf.Plane();
                gp_Dir d = plane.Axis().Direction();
                if (!plane.Position().Direct()) {
                    d.Reverse();
                }
                if (piece.reversed) {
                    d.Reverse();
                }
                piece.constant_normal = true;
                piece.plane_normal = {static_cast<float>(d.X()), static_cast<float>(d.Y()), static_cast<float>(d.Z())};
                return;
            }
            if (!piece.tri->HasUVNodes()) {
                return;
            }
            const int nb_nodes = piece.tri->NbNodes();
            piece.node_normals.resize(static_cast<size_t>(nb_nodes));
            piece.node_ok.assign(static_cast<size_t>(nb_nodes), 0);
            BRepLProp_SLProps props(surf, 1, 1e-9);
            for (int n = 1; n <= nb_nodes; ++n) {
                const gp_Pnt2d uv = piece.tri->UVNode(n);
                props.SetParameters(uv.X(), uv.Y());
                if (props.IsNormalDefined()) {
                    const gp_Dir d = props.Normal();
                    const double nx = d.X() * sign;
                    const double ny = d.Y() * sign;
                    const double nz = d.Z() * sign;
                    if (std::isfinite(nx) && std::isfinite(ny) && std::isfinite(nz)) {
                        piece.node_normals[static_cast<size_t>(n - 1)] = {
                            static_cast<float>(nx),
                            static_cast<float>(ny),
                            static_cast<float>(nz),
                        };
                        piece.node_ok[static_cast<size_t>(n - 1)] = 1;
                    }
                }
            }
        } catch (const Standard_Failure&) {
            piece.constant_normal = false;
            piece.node_ok.clear();
        }
    });

    Mesh out;
    out.positions.reserve(count * 9);
    if (display) {
        out.normals.reserve(count * 9);
    }
    out.triangles.reserve(count);
    for (size_t at = 0; at < pieces.size(); ++at) {
        const size_t face = held.order.empty() ? at : static_cast<size_t>(held.order[at] - 1);
        const Piece& piece = pieces[face];
        if (piece.tri.IsNull()) {
            continue;
        }
        const bool has_nodes = !piece.node_ok.empty();
        for (int triangle_index = 1; triangle_index <= piece.tri->NbTriangles(); ++triangle_index) {
            int n1 = 0;
            int n2 = 0;
            int n3 = 0;
            piece.tri->Triangle(triangle_index).Get(n1, n2, n3);
            if (piece.reversed) {
                std::swap(n2, n3);
            }
            const gp_Pnt p1 = piece.tri->Node(n1).Transformed(piece.trsf);
            const gp_Pnt p2 = piece.tri->Node(n2).Transformed(piece.trsf);
            const gp_Pnt p3 = piece.tri->Node(n3).Transformed(piece.trsf);
            push_point(out.positions, p1);
            push_point(out.positions, p2);
            push_point(out.positions, p3);
            out.triangles.push_back(static_cast<uint32_t>(face));

            if (!display) {
                continue;
            }
            if (piece.constant_normal) {
                for (int k = 0; k < 3; ++k) {
                    out.normals.push_back(piece.plane_normal[0]);
                    out.normals.push_back(piece.plane_normal[1]);
                    out.normals.push_back(piece.plane_normal[2]);
                }
            } else {
                const int nodes[3] = {n1, n2, n3};
                bool need_tri = false;
                for (int k = 0; k < 3; ++k) {
                    const size_t ni = static_cast<size_t>(nodes[k] - 1);
                    if (!has_nodes || ni >= piece.node_ok.size() || piece.node_ok[ni] == 0) {
                        need_tri = true;
                        break;
                    }
                }
                std::array<float, 3> fallback = {0.0f, 0.0f, 1.0f};
                if (need_tri) {
                    const gp_Vec e1(p1, p2);
                    const gp_Vec e2(p1, p3);
                    const gp_Vec cross = e1.Crossed(e2);
                    const double len = cross.Magnitude();
                    if (len > 1e-20) {
                        fallback = {
                            static_cast<float>(cross.X() / len),
                            static_cast<float>(cross.Y() / len),
                            static_cast<float>(cross.Z() / len),
                        };
                    }
                }
                for (int k = 0; k < 3; ++k) {
                    const size_t ni = static_cast<size_t>(nodes[k] - 1);
                    const auto& n = (has_nodes && ni < piece.node_ok.size() && piece.node_ok[ni] != 0)
                        ? piece.node_normals[ni]
                        : fallback;
                    out.normals.push_back(n[0]);
                    out.normals.push_back(n[1]);
                    out.normals.push_back(n[2]);
                }
            }
        }
    }

    out.edge_offsets.reserve(static_cast<size_t>(held.edges.Extent()) + 1);
    out.edge_offsets.push_back(0);
    for (int edge_index = 1; edge_index <= held.edges.Extent(); ++edge_index) {
        BRepAdaptor_Curve curve(TopoDS::Edge(held.edges(edge_index)));
        GCPnts_QuasiUniformDeflection sampler(curve, chord);
        if (sampler.IsDone() && sampler.NbPoints() >= 2) {
            for (int point_index = 1; point_index <= sampler.NbPoints(); ++point_index) {
                push_point(out.edge_points, sampler.Value(point_index));
            }
        } else {
            push_point(out.edge_points, curve.Value(curve.FirstParameter()));
            push_point(out.edge_points, curve.Value(curve.LastParameter()));
        }
        out.edge_offsets.push_back(static_cast<uint32_t>(out.edge_points.size() / 3));
    }
    return out;
}

std::string describe(Held& held) {
    g_stats.descriptions += 1;
    const Timed timed(g_stats.describe_us);
    const int faces = held.faces.Extent();
    const int edges = held.edges.Extent();
    held.face_about.resize(static_cast<size_t>(faces));
    held.edge_about.resize(static_cast<size_t>(edges));
    // Each face and edge is measured alone, into its own slot, so the threads share nothing they write.
    OSD_Parallel::For(0, faces, [&held](int i) {
        std::string& text = held.face_about[static_cast<size_t>(i)];
        if (!text.empty()) {
            return;
        }
        GProp_GProps props;
        BRepGProp::SurfaceProperties(held.faces(i + 1), props);
        text = "{\"areaMm2\":";
        append_num(text, props.Mass());
        append_face_normal(text, TopoDS::Face(held.faces(i + 1)));
        // P1. Optional. A plane, the faces of a box, stays as it was.
        append_face_radius(text, TopoDS::Face(held.faces(i + 1)));
        // Optional. A face that is a whole closed shell, and how far it moves before it folds.
        append_face_fold(text, TopoDS::Face(held.faces(i + 1)));
        text += '}';
    });
    OSD_Parallel::For(0, edges, [&held](int i) {
        std::string& text = held.edge_about[static_cast<size_t>(i)];
        if (!text.empty()) {
            return;
        }
        GProp_GProps props;
        BRepGProp::LinearProperties(held.edges(i + 1), props);
        append_num(text, props.Mass());
    });
    std::string out = "{\"volumeMm3\":";
    append_num(out, held.volume);
    out += has_solid(held.shape) ? ",\"solid\":true" : ",\"solid\":false";
    out += ",\"faces\":[";
    for (int i = 0; i < faces; ++i) {
        if (i > 0) {
            out += ',';
        }
        out += held.face_about[static_cast<size_t>(i)];
    }
    out += "],\"edgeLengths\":[";
    for (int i = 0; i < edges; ++i) {
        if (i > 0) {
            out += ',';
        }
        out += held.edge_about[static_cast<size_t>(i)];
    }
    out += "]";
    // The edges a window should not draw: a seam (a face meets itself along it) or a pole (no length). They stay in
    // the list above, so picking and every index a caller holds are as before.
    TopTools_IndexedDataMapOfShapeListOfShape ancestors;
    TopExp::MapShapesAndAncestors(held.shape, TopAbs_EDGE, TopAbs_FACE, ancestors);
    std::string seams;
    std::string naked;
    for (int i = 1; i <= edges; ++i) {
        const TopoDS_Edge edge = TopoDS::Edge(held.edges(i));
        bool seam = BRep_Tool::Degenerated(edge);
        const int at = ancestors.FindIndex(edge);
        int face_count = 0;
        if (!seam && at > 0) {
            const TopTools_ListOfShape& flist = ancestors.FindFromIndex(at);
            face_count = flist.Extent();
            for (const TopoDS_Shape& face : flist) {
                if (BRep_Tool::IsClosed(edge, TopoDS::Face(face))) {
                    seam = true;
                    break;
                }
            }
        }
        if (seam) {
            seams += seams.empty() ? "" : ",";
            seams += std::to_string(i - 1);
        } else if (face_count < 2) {
            naked += naked.empty() ? "" : ",";
            naked += std::to_string(i - 1);
        }
    }
    if (!seams.empty()) {
        out += ",\"edgeSeams\":[" + seams + "]";
    }
    if (!naked.empty()) {
        out += ",\"nakedEdges\":[" + naked + "]";
    }
    out += "}";
    return out;
}

void inherit_about(Held& held, const Held& from) {
    if (from.face_about.empty() && from.edge_about.empty()) {
        return;
    }
    held.face_about.resize(static_cast<size_t>(held.faces.Extent()));
    held.edge_about.resize(static_cast<size_t>(held.edges.Extent()));
    for (int i = 1; i <= held.faces.Extent() && !from.face_about.empty(); ++i) {
        const int at = from.faces.FindIndex(held.faces(i));
        // The same face turned over has the other normal: it is measured again.
        if (at > 0 && from.faces(at).Orientation() == held.faces(i).Orientation()) {
            held.face_about[static_cast<size_t>(i - 1)] = from.face_about[static_cast<size_t>(at - 1)];
        }
    }
    for (int i = 1; i <= held.edges.Extent() && !from.edge_about.empty(); ++i) {
        const int at = from.edges.FindIndex(held.edges(i));
        if (at > 0) {
            held.edge_about[static_cast<size_t>(i - 1)] = from.edge_about[static_cast<size_t>(at - 1)];
        }
    }
}

bool pick(const Held& held, const char* kind, int index, TopoDS_Shape& out) {
    if (kind == nullptr) {
        return false;
    }
    const std::string which(kind);
    if (which == "face") {
        if (index < 0 || index >= held.faces.Extent()) {
            return false;
        }
        out = held.faces(index + 1);
        return true;
    }
    if (which == "edge") {
        if (index < 0 || index >= held.edges.Extent()) {
            return false;
        }
        out = held.edges(index + 1);
        return true;
    }
    return false;
}

constexpr double kPi = 3.14159265358979323846;
/// Below this a size is no size: Open CASCADE would build a sliver or a seam that breaks later edits.
constexpr double kTinyMm = 1e-6;

bool positive(double size) { return size > kTinyMm; }

/// The spec with each size that may be 0 (a cone's ends, a tube's hole, a wedge's top) snapped to 0 when it is
/// within `kTinyMm` of it, so a pointed cone, a solid tube, and a ramp build clean.
PrimitiveSpec snapped(PrimitiveSpec p) {
    for (double* size : {&p.radius, &p.top_radius, &p.inner_radius, &p.top_x}) {
        if (std::abs(*size) <= kTinyMm) {
            *size = 0.0;
        }
    }
    return p;
}

/// A built shape, or the message why Open CASCADE did not build it.
template <typename Maker>
TopoDS_Shape built(Maker& maker, const char* what, std::string& error) {
    maker.Build();
    if (!maker.IsDone()) {
        error = std::string("Open CASCADE did not build the ") + what;
        return {};
    }
    return maker.Shape();
}

/// A box whose four edges along Z are quarter circles of `corner_radius`: a rounded rectangle pushed up `dz`, one
/// feature, so a pocket or boss cut with it has round corners from the start. A radius of half the shorter side makes
/// those ends full half circles.
TopoDS_Shape rounded_box(const PrimitiveSpec& p, std::string& error) {
    const double half = std::min(p.dx, p.dy) / 2.0;
    if (p.corner_radius > half + kTinyMm) {
        std::ostringstream text;
        text.imbue(std::locale::classic());
        text << "A box's corner radius must be at most half its shorter side, " << std::round(half * 100.0) / 100.0
             << " mm";
        error = text.str();
        return {};
    }
    const double r = std::min(p.corner_radius, half);
    const double x0 = p.x;
    const double y0 = p.y;
    const double x1 = p.x + p.dx;
    const double y1 = p.y + p.dy;
    const double z = p.z;
    BRepBuilderAPI_MakeWire wire;
    const auto line = [&](double ax, double ay, double bx, double by) {
        if (std::hypot(bx - ax, by - ay) > kTinyMm) {
            wire.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(ax, ay, z), gp_Pnt(bx, by, z)).Edge());
        }
    };
    const auto arc = [&](double cx, double cy, double from_deg) {
        const auto at = [&](double deg) {
            const double a = deg * kPi / 180.0;
            return gp_Pnt(cx + r * std::cos(a), cy + r * std::sin(a), z);
        };
        const Handle(Geom_TrimmedCurve) curve = GC_MakeArcOfCircle(at(from_deg), at(from_deg + 45.0), at(from_deg + 90.0)).Value();
        wire.Add(BRepBuilderAPI_MakeEdge(curve).Edge());
    };
    // Counter-clockwise from above, so the face points up and the prism grows up.
    line(x0 + r, y0, x1 - r, y0);
    arc(x1 - r, y0 + r, -90.0);
    line(x1, y0 + r, x1, y1 - r);
    arc(x1 - r, y1 - r, 0.0);
    line(x1 - r, y1, x0 + r, y1);
    arc(x0 + r, y1 - r, 90.0);
    line(x0, y1 - r, x0, y0 + r);
    arc(x0 + r, y0 + r, 180.0);
    if (!wire.IsDone()) {
        error = "Open CASCADE did not build the rounded box";
        return {};
    }
    BRepBuilderAPI_MakeFace face(wire.Wire(), Standard_True);
    if (!face.IsDone()) {
        error = "Open CASCADE did not build the rounded box";
        return {};
    }
    BRepPrimAPI_MakePrism prism(face.Face(), gp_Vec(0, 0, p.dz));
    return built(prism, "rounded box", error);
}

/// The primitive as it stands, before any turn. Every size is checked here, in the words the readout shows.
TopoDS_Shape make_primitive(const PrimitiveSpec& p, std::string& error) {
    const std::string& which = p.kind;
    const gp_Ax2 up(gp_Pnt(p.x, p.y, p.z), gp_Dir(0, 0, 1));
    if (which == "box") {
        if (!positive(p.dx) || !positive(p.dy) || !positive(p.dz)) {
            error = "A box needs a positive length on each side";
            return {};
        }
        if (p.corner_radius < 0.0 || !std::isfinite(p.corner_radius)) {
            error = "A box's corner radius must be 0 or more";
            return {};
        }
        if (positive(p.corner_radius)) {
            return rounded_box(p, error);
        }
        BRepPrimAPI_MakeBox box(gp_Pnt(p.x, p.y, p.z), p.dx, p.dy, p.dz);
        return built(box, "box", error);
    }
    if (which == "cylinder") {
        if (!positive(p.radius) || !positive(p.height)) {
            error = "A cylinder needs a positive radius and height";
            return {};
        }
        BRepPrimAPI_MakeCylinder cylinder(up, p.radius, p.height);
        return built(cylinder, "cylinder", error);
    }
    if (which == "sphere") {
        if (!positive(p.radius)) {
            error = "A sphere needs a positive radius";
            return {};
        }
        BRepPrimAPI_MakeSphere sphere(gp_Pnt(p.x, p.y, p.z), p.radius);
        return built(sphere, "sphere", error);
    }
    if (which == "ellipsoid") {
        // A unit sphere stretched along each axis: dx, dy, dz are the full widths, centred on x, y, z.
        if (!positive(p.dx) || !positive(p.dy) || !positive(p.dz)) {
            error = "An ellipsoid needs a positive width along each axis";
            return {};
        }
        BRepPrimAPI_MakeSphere unit(gp_Pnt(0, 0, 0), 1.0);
        const TopoDS_Shape ball = built(unit, "ellipsoid", error);
        if (ball.IsNull()) {
            return {};
        }
        gp_GTrsf stretch;
        stretch.SetValue(1, 1, p.dx / 2.0);
        stretch.SetValue(2, 2, p.dy / 2.0);
        stretch.SetValue(3, 3, p.dz / 2.0);
        stretch.SetTranslationPart(gp_XYZ(p.x, p.y, p.z));
        BRepBuilderAPI_GTransform shaped(ball, stretch, Standard_True);
        return built(shaped, "ellipsoid", error);
    }
    if (which == "cone") {
        if (!positive(p.height)) {
            error = "A cone needs a height above 0";
            return {};
        }
        if (!(p.radius >= 0.0) || !(p.top_radius >= 0.0)) {
            error = "A cone's radii cannot be below 0";
            return {};
        }
        if (!positive(p.radius) && !positive(p.top_radius)) {
            error = "A cone needs a bottom or top radius above 0";
            return {};
        }
        // Equal radii are a cylinder, which the cone builder refuses.
        if (p.radius == p.top_radius) {
            BRepPrimAPI_MakeCylinder cylinder(up, p.radius, p.height);
            return built(cylinder, "cone", error);
        }
        BRepPrimAPI_MakeCone cone(up, p.radius, p.top_radius, p.height);
        return built(cone, "cone", error);
    }
    if (which == "torus") {
        if (!positive(p.radius)) {
            error = "A torus needs a ring radius above 0";
            return {};
        }
        if (!positive(p.tube_radius)) {
            error = "A torus needs a tube radius above 0";
            return {};
        }
        if (!(p.tube_radius < p.radius)) {
            error = "The torus's tube radius must be smaller than its ring radius";
            return {};
        }
        BRepPrimAPI_MakeTorus torus(up, p.radius, p.tube_radius);
        return built(torus, "torus", error);
    }
    if (which == "wedge") {
        if (!positive(p.dx) || !positive(p.dy) || !positive(p.dz)) {
            error = "A wedge needs a positive length on each side";
            return {};
        }
        if (!(p.top_x >= 0.0) || !(p.top_x <= p.dx)) {
            error = "The wedge's top length must be from 0 to its X length";
            return {};
        }
        // Open CASCADE's wedge narrows along its own Y. Its Y is our Z here, and its Z runs back
        // along −Y from the far side, so the wedge fills x..x+dx, y..y+dy, z..z+dz.
        const gp_Ax2 frame(gp_Pnt(p.x, p.y + p.dy, p.z), gp_Dir(0, -1, 0), gp_Dir(1, 0, 0));
        BRepPrimAPI_MakeWedge wedge(frame, p.dx, p.dz, p.dy, p.top_x);
        return built(wedge, "wedge", error);
    }
    if (which == "polygon") {
        const double sides = std::round(p.sides);
        if (!(sides >= 3.0) || !(sides <= 64.0) || sides != p.sides) {
            error = "A polygon needs 3 to 64 sides";
            return {};
        }
        if (!positive(p.across)) {
            error = "A polygon needs a width across above 0";
            return {};
        }
        if (!positive(p.height)) {
            error = "A polygon needs a height above 0";
            return {};
        }
        const int count = static_cast<int>(sides);
        const double corner = p.flats ? p.across / 2.0 / std::cos(kPi / count) : p.across / 2.0;
        // Counter-clockwise from above, with one flat facing −Y, so the face points up and the prism grows up.
        BRepBuilderAPI_MakePolygon outline;
        for (int i = 0; i < count; ++i) {
            const double angle = -kPi / 2.0 - kPi / count + 2.0 * kPi * i / count;
            outline.Add(gp_Pnt(p.x + corner * std::cos(angle), p.y + corner * std::sin(angle), p.z));
        }
        outline.Close();
        if (!outline.IsDone()) {
            error = "Open CASCADE did not build the polygon";
            return {};
        }
        BRepBuilderAPI_MakeFace face(outline.Wire(), Standard_True);
        if (!face.IsDone()) {
            error = "Open CASCADE did not build the polygon";
            return {};
        }
        BRepPrimAPI_MakePrism prism(face.Face(), gp_Vec(0, 0, p.height));
        return built(prism, "polygon", error);
    }
    if (which == "tube") {
        if (!positive(p.height)) {
            error = "A tube needs a height above 0";
            return {};
        }
        if (!positive(p.radius)) {
            error = "A tube needs an outer radius above 0";
            return {};
        }
        if (!(p.inner_radius >= 0.0)) {
            error = "The tube's inner radius cannot be below 0";
            return {};
        }
        if (!(p.inner_radius < p.radius)) {
            error = "The tube's inner radius must be smaller than its outer radius";
            return {};
        }
        // No hole is a cylinder.
        if (p.inner_radius == 0.0) {
            BRepPrimAPI_MakeCylinder cylinder(up, p.radius, p.height);
            return built(cylinder, "tube", error);
        }
        // The wall's section, turned once about the axis: one solid, not a cylinder with another cut out.
        BRepBuilderAPI_MakePolygon section(
            gp_Pnt(p.x + p.inner_radius, p.y, p.z),
            gp_Pnt(p.x + p.radius, p.y, p.z),
            gp_Pnt(p.x + p.radius, p.y, p.z + p.height),
            gp_Pnt(p.x + p.inner_radius, p.y, p.z + p.height),
            Standard_True);
        if (!section.IsDone()) {
            error = "Open CASCADE did not build the tube";
            return {};
        }
        BRepBuilderAPI_MakeFace face(section.Wire(), Standard_True);
        if (!face.IsDone()) {
            error = "Open CASCADE did not build the tube";
            return {};
        }
        BRepPrimAPI_MakeRevol tube(face.Face(), gp_Ax1(gp_Pnt(p.x, p.y, p.z), gp_Dir(0, 0, 1)), 2.0 * kPi);
        return built(tube, "tube", error);
    }
    error = "The primitive is box, cylinder, sphere, ellipsoid, cone, torus, wedge, polygon, or tube";
    return {};
}

/// Where a primitive turns: a box's or a wedge's centre, a torus's centre, the middle of any other one's axis.
gp_Pnt turn_centre(const PrimitiveSpec& p) {
    if (p.kind == "box" || p.kind == "wedge") {
        return gp_Pnt(p.x + p.dx / 2.0, p.y + p.dy / 2.0, p.z + p.dz / 2.0);
    }
    if (p.kind == "torus" || p.kind == "ellipsoid") {
        return gp_Pnt(p.x, p.y, p.z);
    }
    return gp_Pnt(p.x, p.y, p.z + p.height / 2.0);
}

TopoDS_Shape make_solid(const PrimitiveSpec& given, std::string& error) {
    const PrimitiveSpec spec = snapped(given);
    const TopoDS_Shape made = make_primitive(spec, error);
    if (made.IsNull()) {
        if (error.empty()) {
            error = "Open CASCADE did not build the primitive";
        }
        return {};
    }
    if (spec.kind == "sphere" || (spec.rx == 0.0 && spec.ry == 0.0 && spec.rz == 0.0)) {
        return made;
    }
    const gp_Pnt centre = turn_centre(spec);
    const double rad = kPi / 180.0;
    gp_Trsf tx;
    gp_Trsf ty;
    gp_Trsf tz;
    tx.SetRotation(gp_Ax1(centre, gp_Dir(1, 0, 0)), spec.rx * rad);
    ty.SetRotation(gp_Ax1(centre, gp_Dir(0, 1, 0)), spec.ry * rad);
    tz.SetRotation(gp_Ax1(centre, gp_Dir(0, 0, 1)), spec.rz * rad);
    gp_Trsf total = tz;
    total.Multiply(ty);
    total.Multiply(tx);
    BRepBuilderAPI_Transform builder(made, total, Standard_True);
    return builder.Shape();
}

namespace {

/// When the step being built must stop, in steady-clock milliseconds, and the budget it was given; 0 for none. One
/// engine builds one step at a time, but Open CASCADE asks from its own threads too, so these are not thread-local.
std::atomic<long long> g_deadline_ms{0};
std::atomic<long long> g_budget_ms{0};

long long steady_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

/// Open CASCADE polls `UserBreak` as a boolean or a blend works, so a step past its time stops there, cleanly,
/// instead of holding the engine until its caller kills the process and every open tree with it.
class Deadline : public Message_ProgressIndicator {
public:
    Standard_Boolean UserBreak() override { return past_deadline(); }

protected:
    void Show(const Message_ProgressScope&, const Standard_Boolean) override {}
};

}  // namespace

void set_deadline(long long budget_ms) {
    g_budget_ms.store(budget_ms > 0 ? budget_ms : 0);
    g_deadline_ms.store(budget_ms > 0 ? steady_ms() + budget_ms : 0);
}

bool past_deadline() {
    const long long until = g_deadline_ms.load();
    return until > 0 && steady_ms() >= until;
}

std::string deadline_message() {
    const long long seconds = (g_budget_ms.load() + 999) / 1000;
    return "This step ran past its " + std::to_string(seconds) +
           " s limit, so Open CASCADE stopped it and nothing changed. Use a smaller tool, fewer edges, or fewer faces "
           "in the way, or split the part and edit one piece";
}

/// Why a section stopped at its deadline: on a sound solid a plane cut takes well under a second.
std::string section_overran() {
    const long long seconds = (g_budget_ms.load() + 999) / 1000;
    return "Open CASCADE could not cut this section within " + std::to_string(seconds) +
           " s, so it was stopped. A plane cut is quick on a sound solid, so this one is likely damaged: model_check "
           "lists edges where pieces meet only along a line and walls too thin to print. Undo the step that made them";
}

/// A progress range that stops at the deadline, or a plain one when no step is being timed. `watch` keeps the indicator
/// alive while the build runs.
Message_ProgressRange deadline_range(Handle(Message_ProgressIndicator)& watch) {
    if (g_deadline_ms.load() <= 0) {
        return Message_ProgressRange();
    }
    watch = new Deadline();
    return watch->Start();
}

/// One boolean, built once. The two-shape constructors of `BRepAlgoAPI_Fuse`, `_Cut` and `_Common` build at once, with the
/// default options, so setting options on one and calling `Build` again ran every boolean twice, the first time
/// destructively, which could change the input's tolerances. History stays unfilled unless `history` is set: a hole's
/// tool fuse and a split's piece fuse never ask, so their shapes stay as they were.
TopoDS_Shape boolean_list(
    const std::string& op,
    const TopoDS_Shape& solid,
    const TopTools_ListOfShape& tools,
    std::string& error,
    Handle(BRepTools_History)* history = nullptr) {
    BOPAlgo_Operation operation = BOPAlgo_UNKNOWN;
    if (op == "fuse") {
        operation = BOPAlgo_FUSE;
    } else if (op == "cut") {
        operation = BOPAlgo_CUT;
    } else if (op == "common") {
        operation = BOPAlgo_COMMON;
    } else {
        error = "The boolean is fuse, cut, or common";
        return {};
    }
    g_stats.builds += 1;
    const Timed timed(g_stats.boolean_us);
    TopTools_ListOfShape objects;
    objects.Append(solid);
    BRepAlgoAPI_BooleanOperation algo;
    algo.SetArguments(objects);
    algo.SetTools(tools);
    algo.SetOperation(operation);
    algo.SetFuzzyValue(1.0e-7);
    algo.SetNonDestructive(Standard_True);
    algo.SetRunParallel(Standard_True);
    algo.SetToFillHistory(history != nullptr ? Standard_True : Standard_False);
    Handle(Message_ProgressIndicator) watch;
    algo.Build(deadline_range(watch));
    if (!algo.IsDone() || algo.HasErrors() || algo.Shape().IsNull()) {
        error = past_deadline() ? deadline_message() : "Open CASCADE did not complete the boolean";
        return {};
    }
    if (history != nullptr) {
        *history = algo.History();
    }
    return algo.Shape();
}

TopoDS_Shape boolean_op(
    const std::string& op,
    const TopoDS_Shape& solid,
    const TopoDS_Shape& tool,
    std::string& error,
    Handle(BRepTools_History)* history = nullptr) {
    TopTools_ListOfShape tools;
    tools.Append(tool);
    return boolean_list(op, solid, tools, error, history);
}

bool accepted_result(const TopoDS_Shape& shape, double& volume, std::string& error) {
    volume = shape.IsNull() || !has_solid(shape) ? 0.0 : volume_of(shape);
    if (!(volume > 1e-6)) {
        error = "The boolean removed the solid";
        return false;
    }
    return true;
}

/// Outward unit normal at the face midpoint. A reversed face is flipped so the solid's outside stays positive.
void append_face_normal(std::string& out, const TopoDS_Face& face) {
    try {
        BRepAdaptor_Surface surface(face);
        const double u0 = surface.FirstUParameter();
        const double u1 = surface.LastUParameter();
        const double v0 = surface.FirstVParameter();
        const double v1 = surface.LastVParameter();
        if (!std::isfinite(u0) || !std::isfinite(u1) || !std::isfinite(v0) || !std::isfinite(v1)) {
            return;
        }
        gp_Pnt point;
        gp_Vec du;
        gp_Vec dv;
        surface.D1((u0 + u1) * 0.5, (v0 + v1) * 0.5, point, du, dv);
        gp_Vec normal = du.Crossed(dv);
        if (!(normal.SquareMagnitude() > 1e-18)) {
            return;
        }
        if (face.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        normal.Normalize();
        out += ",\"normal\":[";
        append_num(out, normal.X());
        out += ',';
        append_num(out, normal.Y());
        out += ',';
        append_num(out, normal.Z());
        out += ']';
    } catch (const Standard_Failure&) {
    }
}

/// P1. A cylinder, cone, or sphere names its surface and radius, and its axis: a point on it (a sphere's centre) and its
/// direction (a sphere's pole). Anything else, including a plane, adds nothing.
void append_face_radius(std::string& out, const TopoDS_Face& face) {
    try {
        BRepAdaptor_Surface surface(face);
        const GeomAbs_SurfaceType kind = surface.GetType();
        const char* name = nullptr;
        double radius = 0.0;
        gp_Pnt axis_point;
        gp_Dir axis_dir;
        bool axis = false;
        if (kind == GeomAbs_Cylinder) {
            name = "cylinder";
            const gp_Cylinder cyl = surface.Cylinder();
            radius = cyl.Radius();
            axis_point = cyl.Position().Location();
            axis_dir = cyl.Axis().Direction();
            axis = true;
        } else if (kind == GeomAbs_Cone) {
            name = "cone";
            const gp_Cone cone = surface.Cone();
            radius = cone.RefRadius();
            axis_point = cone.Position().Location();
            axis_dir = cone.Axis().Direction();
            axis = true;
        } else if (kind == GeomAbs_Sphere) {
            name = "sphere";
            const gp_Sphere sphere = surface.Sphere();
            radius = sphere.Radius();
            // A sphere's axisPoint is its centre and its axis the pole direction (where its seam meridian turns).
            axis_point = sphere.Location();
            axis_dir = sphere.Position().Direction();
            axis = true;
        } else {
            return;
        }
        if (name == nullptr || !(radius > 1e-9)) {
            return;
        }
        out += ",\"surface\":\"";
        out += name;
        out += "\",\"radiusMm\":";
        append_num(out, radius);
        if (axis) {
            out += ",\"axisPoint\":[";
            append_num(out, axis_point.X());
            out += ',';
            append_num(out, axis_point.Y());
            out += ',';
            append_num(out, axis_point.Z());
            out += "],\"axis\":[";
            append_num(out, axis_dir.X());
            out += ',';
            append_num(out, axis_dir.Y());
            out += ',';
            append_num(out, axis_dir.Z());
            out += ']';
        }
    } catch (const Standard_Failure&) {
    }
}

/// A face that meets no other face: each of its edges is a seam or a pole. On a solid it is a whole closed shell (a
/// sphere, an ellipsoid, a torus), so a push or pull moves all of that surface and Alt has no outline to sweep.
bool face_is_closed(const TopoDS_Face& face) {
    bool any = false;
    for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
        const TopoDS_Edge& edge = TopoDS::Edge(it.Current());
        if (!BRep_Tool::Degenerated(edge) && !BRep_Tool::IsClosed(edge, face)) {
            return false;
        }
        any = true;
    }
    return any;
}

/// How far a closed face moves along its outward normal before the moved surface folds onto itself: in, to just under
/// the radius of its tightest convex curve; out, to just under its tightest concave one. Infinite on a side that never
/// folds, as out on a convex part. Each is to the tenth of a millimetre below, so the number said is one that builds.
struct FoldLimits {
    double in = std::numeric_limits<double>::infinity();
    double out = std::numeric_limits<double>::infinity();
};

/// Samples a side of the face's parameter grid, before the tightest reads are looked at more finely.
constexpr int kFoldSamples = 64;
/// The part of the tightest radius a move may use: the samples can still read the very tightest point a little wide.
constexpr double kFoldShare = 0.95;
/// A curve wider than this (a kilometre) is flat: numerical noise on a sphere is not a concave curve.
constexpr double kFlatCurvature = 1e-6;

double fold_below(double curvature) {
    if (!(curvature > kFlatCurvature)) {
        return std::numeric_limits<double>::infinity();
    }
    return std::floor(kFoldShare / curvature * 10.0 + 1e-9) / 10.0;
}

FoldLimits fold_limits(const TopoDS_Face& face) {
    FoldLimits limits;
    try {
        BRepAdaptor_Surface surface(face);
        const double u0 = surface.FirstUParameter();
        const double u1 = surface.LastUParameter();
        const double v0 = surface.FirstVParameter();
        const double v1 = surface.LastVParameter();
        if (!std::isfinite(u0) || !std::isfinite(u1) || !std::isfinite(v0) || !std::isfinite(v1)) {
            return limits;
        }
        // Open CASCADE's curvature is positive where the surface bends toward its normal. On a reversed face the
        // outward normal is the other way, so a convex curve is negative either way after this flip.
        const double outward = face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
        BRepLProp_SLProps props(surface, 2, 1e-9);
        const double du = (u1 - u0) / kFoldSamples;
        const double dv = (v1 - v0) / kFoldSamples;
        // The tightest curve of each side, and where it was read.
        double convex = 0.0;
        double concave = 0.0;
        gp_Pnt2d convex_at(u0, v0);
        gp_Pnt2d concave_at(u0, v0);
        const auto sample = [&](double u, double v) {
            props.SetParameters(std::clamp(u, u0, u1), std::clamp(v, v0, v1));
            if (!props.IsCurvatureDefined()) {
                return;
            }
            for (const double k : {props.MaxCurvature() * outward, props.MinCurvature() * outward}) {
                if (!std::isfinite(k)) {
                    continue;
                }
                if (-k > convex) {
                    convex = -k;
                    convex_at.SetCoord(u, v);
                }
                if (k > concave) {
                    concave = k;
                    concave_at.SetCoord(u, v);
                }
            }
        };
        // The grid, plus a line just inside each edge of the parameters: a pole is degenerate, so a stretched sphere's
        // tip there is read from beside it rather than skipped.
        std::vector<double> us;
        std::vector<double> vs;
        for (int i = 0; i <= kFoldSamples; ++i) {
            us.push_back(u0 + du * i);
            vs.push_back(v0 + dv * i);
        }
        us.push_back(u0 + du * 1e-4);
        us.push_back(u1 - du * 1e-4);
        vs.push_back(v0 + dv * 1e-4);
        vs.push_back(v1 - dv * 1e-4);
        for (const double u : us) {
            for (const double v : vs) {
                sample(u, v);
            }
        }
        // Then finer, a cell either side of each tightest read, for a tip between grid lines.
        for (const gp_Pnt2d at : {convex_at, concave_at}) {
            for (int i = -kFoldSamples / 4; i <= kFoldSamples / 4; ++i) {
                for (int j = -kFoldSamples / 4; j <= kFoldSamples / 4; ++j) {
                    sample(at.X() + du * i * 4 / kFoldSamples, at.Y() + dv * j * 4 / kFoldSamples);
                }
            }
        }
        limits.in = fold_below(convex);
        limits.out = fold_below(concave);
    } catch (const Standard_Failure&) {
    }
    return limits;
}

/// A closed face says so, with the largest push (`inMaxMm`) and pull (`outMaxMm`) that keep it from folding. A side
/// that never folds is left out. Any other face adds nothing.
void append_face_fold(std::string& out, const TopoDS_Face& face) {
    try {
        if (!face_is_closed(face)) {
            return;
        }
        const FoldLimits limits = fold_limits(face);
        out += ",\"closed\":true";
        if (std::isfinite(limits.in)) {
            out += ",\"inMaxMm\":";
            append_num(out, limits.in);
        }
        if (std::isfinite(limits.out)) {
            out += ",\"outMaxMm\":";
            append_num(out, limits.out);
        }
    } catch (const Standard_Failure&) {
    }
}

/// Unsigned millimetres to `places` decimals, trailing zeros dropped, as the app writes them: 24.9, 10, 0.5, 0.54.
std::string mm_text(double mm, int places) {
    const double scale = std::pow(10.0, places);
    std::ostringstream text;
    text.imbue(std::locale::classic());
    text.setf(std::ios::fixed);
    text.precision(places);
    text << std::round(std::abs(mm) * scale) / scale;
    std::string out = text.str();
    if (out.find('.') != std::string::npos) {
        while (out.back() == '0') {
            out.pop_back();
        }
        if (out.back() == '.') {
            out.pop_back();
        }
    }
    return out;
}

std::string tenths(double mm) {
    return mm_text(mm, 1);
}

/// Why a closed face cannot move `distance`: past `most` it folds onto itself.
std::string fold_refusal(double distance, double most) {
    const bool in = distance < 0.0;
    // A distance that reads as `most` at the tenth (0.54 against 0.5) is written to the hundredth, so the sentence
    // never refuses the number it allows.
    const std::string asked = std::round(std::abs(distance) * 10.0) / 10.0 <= most ? mm_text(distance, 2) : tenths(distance);
    std::string text = std::string(in ? "Pushed in " : "Pulled out ") + asked +
        " mm, this surface would fold onto itself where it curves tightest. ";
    if (most > 0.0) {
        return text + "It can go " + (in ? "in" : "out") + " at most " + tenths(most) + " mm.";
    }
    return text + "It cannot go " + (in ? "in" : "out") + " at all.";
}

/// An edge Open CASCADE will refuse at every size: already tangent-continuous, or a seam on one face.
std::string blend_refusal(const TopoDS_Shape& shape, const std::vector<TopoDS_Edge>& edges, bool chamfer) {
    const char* verb = chamfer ? "chamfered" : "filleted";
    bool smooth = false;
    bool seam = false;
    try {
        TopTools_IndexedDataMapOfShapeListOfShape ancestors;
        TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, ancestors);
        for (const TopoDS_Edge& edge : edges) {
            if (BRep_Tool::Degenerated(edge)) {
                seam = true; // a pole: no length, nothing to round
                continue;
            }
            const TopTools_ListOfShape* faces = ancestors.Seek(edge);
            if (faces == nullptr) {
                continue;
            }
            std::vector<TopoDS_Face> unique;
            for (TopTools_ListIteratorOfListOfShape it(*faces); it.More(); it.Next()) {
                const TopoDS_Face face = TopoDS::Face(it.Value());
                bool seen = false;
                for (const TopoDS_Face& have : unique) {
                    if (face.IsSame(have)) {
                        seen = true;
                        break;
                    }
                }
                if (!seen) {
                    unique.push_back(face);
                }
            }
            if (unique.size() == 1) {
                try {
                    if (BRep_Tool::IsClosed(edge, unique[0])) {
                        seam = true;
                    }
                } catch (const Standard_Failure&) {
                }
            }
            for (size_t a = 0; a < unique.size(); ++a) {
                for (size_t b = a + 1; b < unique.size(); ++b) {
                    try {
                        if (BRep_Tool::Continuity(edge, unique[a], unique[b]) >= GeomAbs_G1) {
                            smooth = true;
                        }
                    } catch (const Standard_Failure&) {
                    }
                }
            }
        }
    } catch (const Standard_Failure&) {
        return "";
    }
    const bool many = edges.size() > 1;
    if (smooth && seam) {
        return std::string("These edges are already smooth or are seams and cannot be ") + verb + ".";
    }
    if (smooth) {
        return many ? std::string("These edges are already smooth and cannot be ") + verb + "."
                    : std::string("This edge is already smooth and cannot be ") + verb + ".";
    }
    if (seam) {
        return many ? std::string("These seam edges cannot be ") + verb + "."
                    : std::string("That edge is the seam of a round face, not a real edge; nothing to round.");
    }
    return "";
}

/// Build a fillet or chamfer on a copy. Every edge is added before the one Build, so corners blend together.
bool blend_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    double size,
    bool chamfer,
    TopoDS_Shape& built,
    double& volume,
    std::string& error) {
    const bool many = edges.size() > 1;
    const char* failed = chamfer
        ? (many ? "The chamfer did not fit these edges" : "The chamfer did not fit this edge")
        : (many ? "The fillet did not fit these edges" : "The fillet did not fit this edge");
    if (edges.empty()) {
        error = failed;
        return false;
    }
    const std::string refused = blend_refusal(current, edges, chamfer);
    if (!refused.empty()) {
        error = refused;
        return false;
    }
    g_stats.builds += 1;
    try {
        TopoDS_Shape shape;
        if (chamfer) {
            BRepFilletAPI_MakeChamfer builder(current);
            for (const TopoDS_Edge& edge : edges) {
                builder.Add(size, edge);
            }
            Handle(Message_ProgressIndicator) watch;
            builder.Build(deadline_range(watch));
            if (!builder.IsDone() || builder.Shape().IsNull()) {
                error = past_deadline() ? deadline_message() : failed;
                return false;
            }
            shape = builder.Shape();
        } else {
            BRepFilletAPI_MakeFillet builder(current);
            for (const TopoDS_Edge& edge : edges) {
                builder.Add(size, edge);
            }
            Handle(Message_ProgressIndicator) watch;
            builder.Build(deadline_range(watch));
            if (!builder.IsDone() || builder.Shape().IsNull()) {
                error = past_deadline() ? deadline_message() : failed;
                return false;
            }
            shape = builder.Shape();
        }
        const TopoDS_Shape solid = as_solid(shape);
        const double solid_volume = solid.IsNull() || !has_solid(solid) ? 0.0 : volume_of(solid);
        if (!(solid_volume > 1e-6)) {
            error = failed;
            return false;
        }
        built = shape;
        volume = solid_volume;
        return true;
    } catch (const Standard_Failure&) {
        error = failed;
        return false;
    }
}

/// Largest size at or under `hi` that still builds, from a handful of trials.
double largest_blend(const TopoDS_Shape& current, const std::vector<TopoDS_Edge>& edges, double hi, bool chamfer) {
    double lo = 0.0;
    double best = 0.0;
    for (int step = 0; step < 6; ++step) {
        const double mid = (lo + hi) * 0.5;
        if (mid + 1e-6 < 0.05) {
            break;
        }
        TopoDS_Shape trial;
        double trial_volume = 0.0;
        std::string ignored;
        if (blend_build(current, edges, mid, chamfer, trial, trial_volume, ignored)) {
            best = mid;
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return best;
}

bool chamfer2_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    const std::vector<TopoDS_Face>& faces,
    double size,
    double second,
    bool by_angle,
    TopoDS_Shape& built,
    double& volume,
    std::string& error) {
    const char* failed = edges.size() > 1 ? "The chamfer did not fit these edges" : "The chamfer did not fit this edge";
    if (edges.empty() || edges.size() != faces.size()) {
        error = failed;
        return false;
    }
    if (!(size > 0.0) || !(second > 0.0)) {
        error = by_angle ? "A chamfer needs a positive distance and an angle above 0°" : "A chamfer needs two positive distances";
        return false;
    }
    if (by_angle && !(second < 90.0)) {
        error = "A chamfer's angle must be under 90°";
        return false;
    }
    const std::string refused = blend_refusal(current, edges, true);
    if (!refused.empty()) {
        error = refused;
        return false;
    }
    g_stats.builds += 1;
    try {
        BRepFilletAPI_MakeChamfer builder(current);
        for (size_t i = 0; i < edges.size(); ++i) {
            if (by_angle) {
                builder.AddDA(size, second * kPi / 180.0, edges[i], faces[i]);
            } else {
                builder.Add(size, second, edges[i], faces[i]);
            }
        }
        Handle(Message_ProgressIndicator) watch;
        builder.Build(deadline_range(watch));
        if (!builder.IsDone() || builder.Shape().IsNull()) {
            error = past_deadline() ? deadline_message() : failed;
            return false;
        }
        const TopoDS_Shape solid = as_solid(builder.Shape());
        const double solid_volume = solid.IsNull() || !has_solid(solid) ? 0.0 : volume_of(solid);
        if (!(solid_volume > 1e-6)) {
            error = failed;
            return false;
        }
        built = builder.Shape();
        volume = solid_volume;
        return true;
    } catch (const Standard_Failure&) {
        error = failed;
        return false;
    }
}

bool chamfer_angles_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    const std::vector<TopoDS_Face>& faces,
    const std::vector<double>& sizes,
    const std::vector<double>& angles_deg,
    TopoDS_Shape& built,
    double& volume,
    std::string& error) {
    const char* failed = edges.size() > 1 ? "The wedge did not fit these edges" : "The wedge did not fit this edge";
    if (edges.empty() || faces.size() != edges.size() || sizes.size() != edges.size() || angles_deg.size() != edges.size()) {
        error = failed;
        return false;
    }
    const std::string refused = blend_refusal(current, edges, true);
    if (!refused.empty()) {
        error = refused;
        return false;
    }
    g_stats.builds += 1;
    try {
        BRepFilletAPI_MakeChamfer builder(current);
        for (size_t i = 0; i < edges.size(); ++i) {
            if (!(sizes[i] > 0.0) || !(angles_deg[i] > 0.0) || !(angles_deg[i] < 180.0)) {
                error = failed;
                return false;
            }
            builder.AddDA(sizes[i], angles_deg[i] * kPi / 180.0, edges[i], faces[i]);
        }
        Handle(Message_ProgressIndicator) watch;
        builder.Build(deadline_range(watch));
        if (!builder.IsDone() || builder.Shape().IsNull()) {
            error = past_deadline() ? deadline_message() : failed;
            return false;
        }
        const TopoDS_Shape solid = as_solid(builder.Shape());
        const double solid_volume = solid.IsNull() || !has_solid(solid) ? 0.0 : volume_of(solid);
        if (!(solid_volume > 1e-6)) {
            error = failed;
            return false;
        }
        built = builder.Shape();
        volume = solid_volume;
        return true;
    } catch (const Standard_Failure&) {
        error = failed;
        return false;
    }
}

TopoDS_Shape merge_same_domain(const TopoDS_Shape& shape, Handle(BRepTools_History)* history) {
    if (shape.IsNull()) {
        return shape;
    }
    try {
        ShapeUpgrade_UnifySameDomain unify(shape, Standard_True, Standard_True, Standard_False);
        unify.Build();
        const TopoDS_Shape merged = unify.Shape();
        if (merged.IsNull()) {
            return shape;
        }
        if (history != nullptr && !history->IsNull() && !unify.History().IsNull()) {
            (*history)->Merge(unify.History());
        }
        return merged;
    } catch (const Standard_Failure&) {
        return shape;
    }
}

/// `current` and `tool` combined, on a copy, with the result's volume. Empty `error` means the result is good.
/// `history`, when set, receives the boolean's face history. Null leaves it unfilled.
TopoDS_Shape combine(
    const TopoDS_Shape& current,
    const std::string& which,
    const TopoDS_Shape& tool,
    double& volume,
    std::string& error,
    Handle(BRepTools_History)* history = nullptr) {
    const TopoDS_Shape result = boolean_op(which, current, tool, error, history);
    if (!error.empty()) {
        return {};
    }
    if (!accepted_result(result, volume, error)) {
        if (which == "common") {
            error = "The solids do not overlap";
        }
        return {};
    }
    return result;
}

/// The boolean Apply runs, on a copy. Empty `error` means `built` is the result.
TopoDS_Shape build_boolean(
    const TopoDS_Shape& current,
    const std::string& which,
    const PrimitiveSpec& spec,
    double& volume,
    std::string& error,
    Handle(BRepTools_History)* history) {
    const TopoDS_Shape tool = make_solid(spec, error);
    if (tool.IsNull()) {
        return {};
    }
    return combine(current, which, tool, volume, error, history);
}

TopoDS_Shape build_wedges(
    const TopoDS_Shape& current,
    const std::vector<std::array<gp_Pnt, 3>>& triangles,
    const std::vector<gp_Vec>& along,
    bool cut,
    double& volume,
    std::string& error) {
    const char* failed = "Open CASCADE did not build the wedge";
    if (triangles.empty() || triangles.size() != along.size()) {
        error = failed;
        return {};
    }
    TopoDS_Shape result = current;
    for (size_t i = 0; i < triangles.size(); ++i) {
        const std::array<gp_Pnt, 3>& corner = triangles[i];
        BRepBuilderAPI_MakePolygon outline(corner[0], corner[1], corner[2], Standard_True);
        if (!outline.IsDone()) {
            error = failed;
            return {};
        }
        BRepBuilderAPI_MakeFace face(outline.Wire(), Standard_True);
        if (!face.IsDone()) {
            error = failed;
            return {};
        }
        BRepPrimAPI_MakePrism prism(face.Face(), along[i]);
        prism.Build();
        if (!prism.IsDone()) {
            error = failed;
            return {};
        }
        result = combine(result, cut ? "cut" : "fuse", prism.Shape(), volume, error);
        if (!error.empty()) {
            return {};
        }
    }
    result = merge_same_domain(result, nullptr);
    volume = volume_of(as_solid(result));
    return result;
}

TopoDS_Shape build_lip_gusset(
    const TopoDS_Shape& current,
    const TopoDS_Face& face,
    const gp_Pnt& at,
    const gp_Dir& keep,
    const gp_Dir& build,
    double depth,
    const gp_Pnt& inside,
    double* out,
    std::string& error) {
    const char* failed = "Open CASCADE did not build the gusset";
    BRepPrimAPI_MakePrism sweep(face, gp_Vec(build) * -depth);
    sweep.Build();
    if (!sweep.IsDone()) {
        error = failed;
        return {};
    }
    // The kept side of the plane: a square on it, large enough to hold the sweep, pushed along `keep`.
    Bnd_Box bounds;
    BRepBndLib::Add(sweep.Shape(), bounds, Standard_False);
    if (bounds.IsVoid()) {
        error = failed;
        return {};
    }
    double lo[3] = {0, 0, 0};
    double hi[3] = {0, 0, 0};
    bounds.Get(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    const double span = gp_Pnt(lo[0], lo[1], lo[2]).Distance(gp_Pnt(hi[0], hi[1], hi[2])) +
                        at.Distance(gp_Pnt(0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2]))) + 1.0;
    BRepBuilderAPI_MakeFace square(gp_Pln(at, keep), -span, span, -span, span);
    if (!square.IsDone()) {
        error = failed;
        return {};
    }
    BRepPrimAPI_MakePrism side(square.Face(), gp_Vec(keep) * (2.0 * span));
    side.Build();
    if (!side.IsDone()) {
        error = failed;
        return {};
    }
    BRepAlgoAPI_Common clipped(sweep.Shape(), side.Shape());
    if (!clipped.IsDone()) {
        error = failed;
        return {};
    }
    BRepAlgoAPI_Cut left(clipped.Shape(), current);
    if (!left.IsDone()) {
        error = failed;
        return {};
    }
    TopoDS_Shape piece;
    for (TopExp_Explorer it(left.Shape(), TopAbs_SOLID); it.More(); it.Next()) {
        BRepClass3d_SolidClassifier classify(it.Current(), inside, 1e-7);
        if (classify.State() == TopAbs_IN) {
            piece = it.Current();
            break;
        }
    }
    if (piece.IsNull()) {
        error = "The part already fills the space under this lip, so there is no gusset to add";
        return {};
    }
    // The gusset's lowest points along the build, and whether each stands on the part.
    double least = 1e300;
    gp_Pnt lowest = at;
    for (TopExp_Explorer it(piece, TopAbs_VERTEX); it.More(); it.Next()) {
        const gp_Pnt p = BRep_Tool::Pnt(TopoDS::Vertex(it.Current()));
        const double reach = gp_Vec(at, p).Dot(gp_Vec(build));
        if (reach < least) {
            least = reach;
            lowest = p;
        }
    }
    std::vector<gp_Pnt> low;
    for (TopExp_Explorer it(piece, TopAbs_EDGE); it.More(); it.Next()) {
        const TopoDS_Edge edge = TopoDS::Edge(it.Current());
        if (BRep_Tool::Degenerated(edge)) {
            continue;
        }
        BRepAdaptor_Curve curve(edge);
        for (int k = 0; k <= 4; ++k) {
            const gp_Pnt p = curve.Value(curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * k / 4.0);
            if (gp_Vec(at, p).Dot(gp_Vec(build)) < least + 1e-4) {
                low.push_back(p);
            }
        }
    }
    bool landed = !low.empty();
    for (const gp_Pnt& p : low) {
        BRepExtrema_DistShapeShape gap(BRepBuilderAPI_MakeVertex(p).Vertex(), current);
        if (!gap.IsDone() || gap.Value() > 1e-3) {
            landed = false;
            break;
        }
    }
    out[0] = volume_of(piece);
    out[1] = least;
    out[2] = landed ? 1.0 : 0.0;
    out[3] = lowest.X();
    out[4] = lowest.Y();
    out[5] = lowest.Z();
    return piece;
}

namespace {

/// The outward normal of `face` where the edge's parameter `t` lies on it, or a zero vector.
gp_Vec normal_on(const TopoDS_Edge& edge, const TopoDS_Face& face, double t) {
    double first = 0.0;
    double last = 0.0;
    const Handle(Geom2d_Curve) on = BRep_Tool::CurveOnSurface(edge, face, first, last);
    if (on.IsNull()) {
        return gp_Vec(0, 0, 0);
    }
    const gp_Pnt2d uv = on->Value(std::min(std::max(t, std::min(first, last)), std::max(first, last)));
    BRepAdaptor_Surface surface(face);
    gp_Pnt point;
    gp_Vec du;
    gp_Vec dv;
    surface.D1(uv.X(), uv.Y(), point, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() <= 1e-12) {
        return gp_Vec(0, 0, 0);
    }
    normal.Normalize();
    if (face.Orientation() == TopAbs_REVERSED) {
        normal.Reverse();
    }
    return normal;
}

/// A closed polygon through `points`, as a planar face.
TopoDS_Face polygon_face(const std::vector<gp_Pnt>& points) {
    BRepBuilderAPI_MakePolygon outline;
    for (const gp_Pnt& p : points) {
        outline.Add(p);
    }
    outline.Close();
    if (!outline.IsDone()) {
        return {};
    }
    BRepBuilderAPI_MakeFace face(outline.Wire(), Standard_True);
    return face.IsDone() ? face.Face() : TopoDS_Face();
}

/// The side of the plane through `at` that `keep` points to, as a slab large enough to hold `around`.
TopoDS_Shape half_slab(const gp_Pnt& at, const gp_Dir& keep, const TopoDS_Shape& around) {
    Bnd_Box bounds;
    BRepBndLib::Add(around, bounds, Standard_False);
    if (bounds.IsVoid()) {
        return {};
    }
    double lo[3] = {0, 0, 0};
    double hi[3] = {0, 0, 0};
    bounds.Get(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    const gp_Pnt mid(0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2]));
    const double span = gp_Pnt(lo[0], lo[1], lo[2]).Distance(gp_Pnt(hi[0], hi[1], hi[2])) + at.Distance(mid) + 1.0;
    BRepBuilderAPI_MakeFace square(gp_Pln(at, keep), -span, span, -span, span);
    if (!square.IsDone()) {
        return {};
    }
    BRepPrimAPI_MakePrism side(square.Face(), gp_Vec(keep) * (2.0 * span));
    side.Build();
    return side.IsDone() ? side.Shape() : TopoDS_Shape();
}

/// `shape` fused with `other`, or `other` alone when `shape` is empty.
TopoDS_Shape fused_with(const TopoDS_Shape& shape, const TopoDS_Shape& other, std::string& error) {
    if (shape.IsNull()) {
        return other;
    }
    double volume = 0.0;
    return combine(shape, "fuse", other, volume, error);
}

/// One print transition's tool, before it meets the solid.
TopoDS_Shape transition_tool(const TransitionTool& spec, const gp_Dir& binormal, std::string& error) {
    const char* failed = "Open CASCADE did not build the wedge";
    BRepAdaptor_Curve curve(spec.edge);
    const bool reversed = spec.edge.Orientation() == TopAbs_REVERSED;
    const double t0 = reversed ? curve.LastParameter() : curve.FirstParameter();
    const double t1 = reversed ? curve.FirstParameter() : curve.LastParameter();
    gp_Pnt p0;
    gp_Pnt p1;
    gp_Vec d0;
    gp_Vec d1;
    curve.D1(t0, p0, d0);
    curve.D1(t1, p1, d1);
    if (reversed) {
        d0.Reverse();
        d1.Reverse();
    }
    if (d0.Magnitude() <= 1e-12 || d1.Magnitude() <= 1e-12) {
        error = failed;
        return {};
    }
    const gp_Vec start_dir = d0.Normalized();
    const gp_Vec end_dir = d1.Normalized();
    TopoDS_Shape tool;
    if (spec.straight) {
        const gp_Vec along(p0, p1);
        std::vector<gp_Pnt> moved;
        for (const gp_Pnt& p : spec.section) {
            moved.push_back(p.Translated(start_dir * -spec.ext[0]));
        }
        const TopoDS_Face face = polygon_face(moved);
        if (face.IsNull()) {
            error = failed;
            return {};
        }
        BRepPrimAPI_MakePrism prism(face, along + start_dir * (spec.ext[0] + spec.ext[1]));
        prism.Build();
        if (!prism.IsDone()) {
            error = failed;
            return {};
        }
        tool = prism.Shape();
    } else {
        const TopoDS_Face face = polygon_face(spec.section);
        if (face.IsNull()) {
            error = failed;
            return {};
        }
        BRepBuilderAPI_MakeWire spine(spec.edge);
        if (!spine.IsDone()) {
            error = failed;
            return {};
        }
        BRepOffsetAPI_MakePipeShell pipe(spine.Wire());
        pipe.SetMode(binormal);
        pipe.Add(BRepTools::OuterWire(face), Standard_False, Standard_False);
        pipe.Build();
        if (!pipe.IsDone() || !pipe.MakeSolid()) {
            error = "Open CASCADE could not sweep the wedge along this curved edge";
            return {};
        }
        tool = pipe.Shape();
        for (int end = 0; end < 2; ++end) {
            if (!(spec.ext[end] > 0.0)) {
                continue;
            }
            const TopoDS_Shape cap = end == 0 ? pipe.FirstShape() : pipe.LastShape();
            TopoDS_Wire wire;
            for (TopExp_Explorer it(cap, TopAbs_WIRE); it.More(); it.Next()) {
                wire = TopoDS::Wire(it.Current());
                break;
            }
            if (wire.IsNull()) {
                error = failed;
                return {};
            }
            BRepBuilderAPI_MakeFace capped(wire, Standard_True);
            if (!capped.IsDone()) {
                error = failed;
                return {};
            }
            BRepPrimAPI_MakePrism grow(capped.Face(), (end == 0 ? -start_dir : end_dir) * spec.ext[end]);
            grow.Build();
            if (!grow.IsDone()) {
                error = failed;
                return {};
            }
            tool = fused_with(tool, grow.Shape(), error);
            if (!error.empty()) {
                return {};
            }
        }
    }
    for (int end = 0; end < 2; ++end) {
        if (!spec.mitre[end]) {
            continue;
        }
        const TopoDS_Shape keep = half_slab(spec.mitre_at[end], spec.mitre_keep[end], tool);
        if (keep.IsNull()) {
            error = failed;
            return {};
        }
        double volume = 0.0;
        tool = combine(tool, "common", keep, volume, error);
        if (!error.empty()) {
            error = "Open CASCADE could not mitre the wedges where these edges meet";
            return {};
        }
    }
    return tool;
}

}  // namespace

bool edge_stations(const TopoDS_Edge& edge, const TopoDS_Face& face_a, const TopoDS_Face& face_b, int count, double* out) {
    if (count < 2 || BRep_Tool::Degenerated(edge)) {
        return false;
    }
    BRepAdaptor_Curve curve(edge);
    const bool reversed = edge.Orientation() == TopAbs_REVERSED;
    const double first = reversed ? curve.LastParameter() : curve.FirstParameter();
    const double last = reversed ? curve.FirstParameter() : curve.LastParameter();
    for (int k = 0; k < count; ++k) {
        const double t = first + (last - first) * k / (count - 1);
        gp_Pnt p;
        gp_Vec d;
        curve.D1(t, p, d);
        if (reversed) {
            d.Reverse();
        }
        if (d.Magnitude() > 1e-12) {
            d.Normalize();
        }
        const gp_Vec na = normal_on(edge, face_a, t);
        const gp_Vec nb = normal_on(edge, face_b, t);
        double* slot = out + 12 * k;
        const double values[12] = {p.X(), p.Y(), p.Z(), d.X(), d.Y(), d.Z(), na.X(), na.Y(), na.Z(), nb.X(), nb.Y(), nb.Z()};
        std::copy(values, values + 12, slot);
    }
    return true;
}

bool face_distances(const TopoDS_Face& face, const double* points, int count, double* out) {
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
    if (surface.IsNull()) {
        return false;
    }
    for (int k = 0; k < count; ++k) {
        const gp_Pnt p(points[3 * k], points[3 * k + 1], points[3 * k + 2]);
        out[k] = std::nan("");
        Standard_Real u = 0.0;
        Standard_Real v = 0.0;
        try {
            GeomAPI_ProjectPointOnSurf one(p, surface);
            if (!one.IsDone() || one.NbPoints() == 0) {
                continue;
            }
            one.LowerDistanceParameters(u, v);
        } catch (const Standard_Failure&) {
            continue;
        }
        gp_Pnt q;
        gp_Vec du;
        gp_Vec dv;
        surface->D1(u, v, q, du, dv);
        gp_Vec normal = du.Crossed(dv);
        if (normal.Magnitude() <= 1e-12) {
            continue;
        }
        normal.Normalize();
        if (face.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        out[k] = gp_Vec(q, p).Dot(normal);
    }
    return true;
}

TopoDS_Shape build_transition_tools(
    const TopoDS_Shape& current,
    const std::vector<TransitionTool>& specs,
    const gp_Dir& binormal,
    bool cut,
    TopoDS_Shape& tools,
    std::vector<TopoDS_Face>& touched,
    double& volume,
    double& tools_volume,
    Handle(BRepTools_History)* history,
    std::string& error) {
    tools.Nullify();
    for (const TransitionTool& spec : specs) {
        const TopoDS_Shape tool = transition_tool(spec, binormal, error);
        if (!error.empty()) {
            return {};
        }
        tools = fused_with(tools, tool, error);
        if (!error.empty()) {
            return {};
        }
    }
    if (tools.IsNull()) {
        error = "Open CASCADE did not build the wedge";
        return {};
    }
    tools = as_solid(tools);
    tools_volume = volume_of(tools);
    Handle(BRepTools_History) made;
    TopoDS_Shape result = combine(current, cut ? "cut" : "fuse", tools, volume, error, &made);
    if (!error.empty()) {
        return {};
    }
    touched.clear();
    if (!made.IsNull()) {
        TopTools_IndexedMapOfShape faces;
        TopExp::MapShapes(current, TopAbs_FACE, faces);
        for (int i = 1; i <= faces.Extent(); ++i) {
            const TopoDS_Shape& face = faces(i);
            if (made->IsRemoved(face) || !made->Modified(face).IsEmpty()) {
                touched.push_back(TopoDS::Face(face));
            }
        }
    }
    if (history != nullptr) {
        *history = made;
    }
    result = merge_same_domain(result, history);
    volume = volume_of(as_solid(result));
    return result;
}

/// The other solid moves by a location, so nothing is copied, and the turn is built as a unit quaternion so the
/// location carries no scale at all: Open CASCADE refuses a location with one.
TopoDS_Shape build_join(
    const TopoDS_Shape& current,
    const TopoDS_Shape& tool,
    const std::string& which,
    const double* place,
    double& volume,
    std::string& error,
    Handle(BRepTools_History)* history) {
    gp_Quaternion turn(gp_Mat(place[0], place[1], place[2], place[3], place[4], place[5], place[6], place[7], place[8]));
    turn.Normalize();
    gp_Trsf trsf;
    trsf.SetRotation(turn);
    trsf.SetTranslationPart(gp_Vec(place[9], place[10], place[11]));
    return combine(current, which, tool.Moved(TopLoc_Location(trsf)), volume, error, history);
}

/// How far past the far side of the part's box a through hole runs, so its end never lies on a face.
constexpr double kThroughMarginMm = 1.0;

/// How far the part reaches from `origin` along the unit `axis`, read from the corners of its box: what a
/// through hole must drill, before its margin. Zero or less when the whole part is behind the origin.
double reach_along(const TopoDS_Shape& current, const gp_Pnt& origin, const gp_Dir& axis) {
    Bnd_Box bounds;
    BRepBndLib::Add(current, bounds, Standard_False);
    if (bounds.IsVoid()) {
        return 0.0;
    }
    double lo[3] = {0, 0, 0};
    double hi[3] = {0, 0, 0};
    bounds.Get(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    double most = -1e300;
    for (int corner = 0; corner < 8; ++corner) {
        const gp_Vec to(
            (corner & 1 ? hi[0] : lo[0]) - origin.X(),
            (corner & 2 ? hi[1] : lo[1]) - origin.Y(),
            (corner & 4 ? hi[2] : lo[2]) - origin.Z());
        most = std::max(most, to.Dot(gp_Vec(axis)));
    }
    return most;
}

/// A cylinder of `radius` from `origin` for `length` along the unit `axis`.
TopoDS_Shape drill(const gp_Pnt& origin, const gp_Dir& axis, double radius, double length, std::string& error) {
    BRepPrimAPI_MakeCylinder cylinder(gp_Ax2(origin, axis), radius, length);
    cylinder.Build();
    if (!cylinder.IsDone()) {
        error = "Open CASCADE did not build the hole";
        return {};
    }
    return cylinder.Shape();
}

/// The hole Apply cuts, on a copy. The cylinder starts at the origin and runs `depth` into the material, or with
/// `through` to the far side of the part's box and a margin past it, measured from the solid this hole is cut
/// from, so a replay after an earlier edit still goes all the way. A counterbore is a wider cylinder from the
/// origin, fused with the hole into one tool, so the part is cut once and its volume integrated once.
/// `before` is the open solid's volume; `volume` gets the result's.
TopoDS_Shape build_hole(const TopoDS_Shape& current, double before, const HoleSpec& hole, double& volume, std::string& error) {
    if (hole.through && !(hole.radius > 0.0)) {
        error = "A hole needs a positive radius";
        return {};
    }
    if (!(hole.radius > 0.0) || (!hole.through && !(hole.depth > 0.0))) {
        error = "A hole needs a positive radius and depth";
        return {};
    }
    if (hole.bore && !(hole.bore_radius > hole.radius)) {
        error = "The counterbore must be wider than the hole";
        return {};
    }
    if (hole.bore && !(hole.bore_depth > 0.0)) {
        error = "The counterbore needs a positive depth";
        return {};
    }
    const double length = std::sqrt(hole.dx * hole.dx + hole.dy * hole.dy + hole.dz * hole.dz);
    const gp_Dir axis = length > 1e-9 ? gp_Dir(hole.dx / length, hole.dy / length, hole.dz / length) : gp_Dir(0.0, 0.0, -1.0);
    const gp_Pnt origin(hole.x, hole.y, hole.z);
    // How far the part runs past the origin: the hole's own length with Through all. None means it misses, said below.
    // The box carries the shape's tolerance, so a bore within 0.001 mm of the far side counts as reaching it.
    const double reach = hole.through ? std::max(reach_along(current, origin, axis), 0.0) : hole.depth;
    const double slack = hole.through ? 1e-3 : 0.0;
    if (hole.bore && reach > 0.0 && !(hole.bore_depth < reach - slack)) {
        error = "The counterbore must be shallower than the hole";
        return {};
    }
    const double depth = hole.through ? reach + kThroughMarginMm : hole.depth;
    TopoDS_Shape tool = drill(origin, axis, hole.radius, depth, error);
    if (tool.IsNull()) {
        return {};
    }
    if (hole.bore) {
        const TopoDS_Shape wide = drill(origin, axis, hole.bore_radius, hole.bore_depth, error);
        if (wide.IsNull()) {
            return {};
        }
        tool = boolean_op("fuse", tool, wide, error);
        if (!error.empty()) {
            return {};
        }
    }
    const TopoDS_Shape cut = boolean_op("cut", current, tool, error);
    if (!error.empty()) {
        return {};
    }
    const double after = volume_of(as_solid(cut));
    if (!(after > 1e-6)) {
        error = "The hole removed the solid";
        return {};
    }
    if (std::abs(after - before) < 1e-4) {
        error = "The hole missed this solid";
        return {};
    }
    volume = after;
    return cut;
}

bool measure_distance(
    const Held& held,
    const char* a_kind,
    int a_index,
    const char* b_kind,
    int b_index,
    double& out,
    std::string& error) {
    TopoDS_Shape a;
    TopoDS_Shape b;
    if (!pick(held, a_kind, a_index, a) || !pick(held, b_kind, b_index, b)) {
        error = "That face or edge is not on this solid";
        return false;
    }
    BRepExtrema_DistShapeShape dist(a, b);
    if (!dist.IsDone()) {
        dist.Perform();
    }
    if (!dist.IsDone()) {
        error = "Open CASCADE could not measure that distance";
        return false;
    }
    out = dist.Value();
    return true;
}

/// The STEP reader and writer share Open CASCADE's global interface state, so no two calls run
/// them at once, whatever lock their caller holds.
std::mutex& step_mutex() {
    static std::mutex mu;
    return mu;
}

#ifdef LIME_OCCT_STEP
// Some legacy exports describe instances only by representation relationships,
// without CONTEXT_DEPENDENT_SHAPE_REPRESENTATION / product occurrences. OCCT's
// product reader ignores these placements. Keep the representation graph, but
// let OCCT transfer each leaf and compute every transform (including units).
TopoDS_Shape representation_assembly(STEPControl_Reader& reader) {
    const auto model = reader.StepModel();
    using Link = Handle(StepRepr_RepresentationRelationshipWithTransformation);
    std::map<int, std::vector<Link>> children;
    std::set<int> components;
    for (int i = 1; i <= model->NbEntities(); ++i) {
        const auto entity = model->Value(i);
        if (!Handle(StepShape_ContextDependentShapeRepresentation)::DownCast(entity).IsNull()) {
            return {}; // Normal product assemblies belong to the standard reader.
        }
        const auto link = Link::DownCast(entity);
        if (!link.IsNull()) {
            children[model->Number(link->Rep2())].push_back(link);
            components.insert(model->Number(link->Rep1()));
        }
    }
    if (children.empty()) return {};
    const auto process = reader.WS()->TransferReader()->TransientProcess();
    STEPControl_ActorRead actor(model);
    BRep_Builder builder;
    std::set<int> visiting;
    std::set<int> completed;
    std::function<TopoDS_Shape(int)> build = [&](int id) -> TopoDS_Shape {
        if (!visiting.insert(id).second) {
            throw Standard_Failure("STEP assembly contains a cycle");
        }
        const auto rep = Handle(StepShape_ShapeRepresentation)::DownCast(model->Value(id));
        if (rep.IsNull()) throw Standard_Failure("STEP assembly has an unsupported representation");
        TopoDS_Compound result;
        builder.MakeCompound(result);
        const auto links = children.find(id);
        if (links == children.end()) {
            if (!reader.TransferEntity(rep)) throw Standard_Failure("STEP assembly component could not be read");
            const auto part = reader.WS()->TransferReader()->ShapeResult(rep);
            if (part.IsNull()) throw Standard_Failure("STEP assembly component is empty");
            builder.Add(result, part);
        } else {
            // Assembly containers normally contain only their coordinate frame.
            // Refuse mixed geometry here rather than silently dropping it.
            for (int item = 1; item <= rep->NbItems(); ++item) {
                if (!rep->ItemsValue(item)->IsKind(STANDARD_TYPE(StepGeom_Axis2Placement3d))) {
                    throw Standard_Failure("STEP assembly mixes geometry and bare representation links");
                }
            }
            for (const auto& link : links->second) {
                gp_Trsf transform;
                actor.ComputeSRRWT(link, process, transform);
                const auto part = build(model->Number(link->Rep1()));
                builder.Add(result, part.Moved(TopLoc_Location(transform)));
            }
        }
        visiting.erase(id);
        completed.insert(id);
        return result;
    };
    TopoDS_Compound result;
    builder.MakeCompound(result);
    bool any = false;
    for (int i = 1; i <= model->NbEntities(); ++i) {
        if (!components.count(i) && !Handle(StepShape_ShapeRepresentation)::DownCast(model->Value(i)).IsNull()) {
            builder.Add(result, build(i));
            any = true;
        }
    }
    if (!any) throw Standard_Failure("STEP assembly contains no root");
    for (int component : components) {
        if (!completed.count(component)) throw Standard_Failure("STEP assembly has an unreachable component");
    }
    return result;
}
#endif

TopoDS_Shape read_step(const char* path, std::string& error) {
#ifndef LIME_OCCT_STEP
    (void)path;
    error = "STEP reader is not linked";
    return {};
#else
    route_occt_log();
    if (path == nullptr || path[0] == '\0') {
        error = "STEP path is empty";
        return {};
    }
    std::lock_guard<std::mutex> step_lock(step_mutex());
    STEPControl_Reader reader;
    if (reader.ReadFile(path) != IFSelect_RetDone) {
        error = "Open CASCADE could not read this STEP file";
        return {};
    }
    if (reader.TransferRoots() < 1) {
        error = "This STEP file has no solid to measure";
        return {};
    }
    TopoDS_Shape shape = representation_assembly(reader);
    if (shape.IsNull()) shape = reader.OneShape();
    if (shape.IsNull()) {
        error = "This STEP file has no solid to measure";
        return {};
    }
    if (!has_solid(shape)) {
        std::vector<TopoDS_Shape> parts;
        for (int index = 1; index <= reader.NbShapes(); ++index) {
            parts.push_back(reader.Shape(index));
        }
        shape = solids_from_shells(parts, shape);
    }
    Handle(ShapeFix_Shape) fixer = new ShapeFix_Shape(shape);
    fixer->Perform();
    if (!fixer->Shape().IsNull()) {
        shape = fixer->Shape();
    }
    return shape;
#endif
}

bool write_step(const TopoDS_Shape& shape, const char* path, std::string& error) {
#ifndef LIME_OCCT_STEP
    (void)shape;
    (void)path;
    error = "STEP writer is not linked";
    return false;
#else
    route_occt_log();
    if (path == nullptr || path[0] == '\0') {
        error = "STEP path is empty";
        return false;
    }
    std::lock_guard<std::mutex> step_lock(step_mutex());
    Interface_Static::SetCVal("write.step.schema", "AP214IS");
    STEPControl_Writer writer;
    // --- 3.1 F17. No p-curves: each edge's 2D copy on every face it bounds is redundant with its 3D curve and the
    // face's surface, every reader rebuilds it, and on a dense lattice it was about 60 % of the file. The writer's
    // constructor registers the STEP parameters, so they are set after it, and on its model as well.
    Interface_Static::SetIVal("write.surfacecurve.mode", 0);
    writer.Model()->InternalParameters.WriteSurfaceCurMode = false;
    if (writer.Transfer(shape, STEPControl_ManifoldSolidBrep) != IFSelect_RetDone ||
        writer.Write(path) != IFSelect_RetDone) {
        error = "Open CASCADE did not write this solid";
        return false;
    }
    return true;
#endif
}

#ifdef LIME_OCCT_STEP
namespace {

/// An XCAF document that is closed on every way out, an exception included.
struct XcafDocument {
    Handle(TDocStd_Document) document;

    XcafDocument() {
        XCAFApp_Application::GetApplication()->NewDocument("MDTV-XCAF", document);
    }

    ~XcafDocument() {
        if (!document.IsNull()) {
            XCAFApp_Application::GetApplication()->Close(document);
        }
    }

    XcafDocument(const XcafDocument&) = delete;
    XcafDocument& operator=(const XcafDocument&) = delete;
};

}  // namespace
#endif

bool write_step_named(
    const std::vector<TopoDS_Shape>& solids,
    const std::vector<std::string>& names,
    const char* path,
    std::string& error) {
#ifndef LIME_OCCT_STEP
    (void)solids;
    (void)names;
    (void)path;
    error = "STEP writer is not linked";
    return false;
#else
    route_occt_log();
    if (path == nullptr || path[0] == '\0') {
        error = "STEP path is empty";
        return false;
    }
    if (solids.size() != names.size()) {
        error = "Each solid needs a name";
        return false;
    }
    std::lock_guard<std::mutex> step_lock(step_mutex());
    XcafDocument held;
    if (held.document.IsNull()) {
        error = "Open CASCADE did not write these solids";
        return false;
    }
    const Handle(XCAFDoc_ShapeTool) shapes = XCAFDoc_DocumentTool::ShapeTool(held.document->Main());
    for (size_t index = 0; index < solids.size(); ++index) {
        const TDF_Label label = shapes->AddShape(solids[index], Standard_False);
        TDataStd_Name::Set(label, TCollection_ExtendedString(names[index].c_str(), Standard_True));
    }
    Interface_Static::SetCVal("write.step.schema", "AP214IS");
    STEPCAFControl_Writer writer;
    writer.SetNameMode(Standard_True);
    Interface_Static::SetIVal("write.surfacecurve.mode", 0);
    writer.ChangeWriter().Model()->InternalParameters.WriteSurfaceCurMode = false;
    if (!writer.Transfer(held.document, STEPControl_ManifoldSolidBrep) ||
        writer.Write(path) != IFSelect_RetDone) {
        error = "Open CASCADE did not write these solids";
        return false;
    }
    return true;
#endif
}

#ifdef LIME_OCCT_STEP
namespace {

std::string label_name_of(const TDF_Label& label) {
    Handle(TDataStd_Name) name;
    if (label.FindAttribute(TDataStd_Name::GetID(), name)) {
        return TCollection_AsciiString(name->Get()).ToCString();
    }
    return {};
}

std::string escape_json_str(const std::string& text) {
    std::string out;
    out.reserve(text.size() + 2);
    out.push_back('"');
    for (unsigned char ch : text) {
        if (ch == '"') out += "\\\"";
        else if (ch == '\\') out += "\\\\";
        else if (ch == '\n') out += "\\n";
        else if (ch == '\r') out += "\\r";
        else if (ch == '\t') out += "\\t";
        else if (ch < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
            out += buf;
        } else {
            out.push_back(static_cast<char>(ch));
        }
    }
    out.push_back('"');
    return out;
}

gp_Trsf rigid_trsf_from(const double* p, double& out_scale) {
    out_scale = std::sqrt(p[0] * p[0] + p[3] * p[3] + p[6] * p[6]);
    gp_Quaternion turn(gp_Mat(
        p[0] / out_scale, p[1] / out_scale, p[2] / out_scale,
        p[3] / out_scale, p[4] / out_scale, p[5] / out_scale,
        p[6] / out_scale, p[7] / out_scale, p[8] / out_scale));
    turn.Normalize();
    gp_Trsf trsf;
    trsf.SetRotation(turn);
    trsf.SetTranslationPart(gp_Vec(p[9], p[10], p[11]));
    return trsf;
}

void collect_named_assembly_solids(
    const Handle(XCAFDoc_ShapeTool)& shapes,
    const TDF_Label& label,
    const TopLoc_Location& parent_loc,
    std::vector<std::pair<std::string, TopoDS_Shape>>& out) {
    TDF_LabelSequence comps;
    shapes->GetComponents(label, comps);
    for (Standard_Integer i = 1; i <= comps.Length(); ++i) {
        const TDF_Label comp = comps.Value(i);
        const TopLoc_Location loc = parent_loc * shapes->GetLocation(comp);
        TDF_Label ref;
        if (!shapes->GetReferredShape(comp, ref)) {
            ref = comp;
        }
        if (shapes->IsAssembly(ref)) {
            collect_named_assembly_solids(shapes, ref, loc, out);
        } else {
            std::string name = label_name_of(comp);
            if (name.empty()) {
                name = label_name_of(ref);
            }
            TopoDS_Shape solid = XCAFDoc_ShapeTool::GetShape(ref);
            if (!loc.IsIdentity()) {
                solid = solid.Moved(loc);
            }
            out.emplace_back("S" + name, solid);
        }
    }
}

}  // namespace
#endif

bool write_step_assembly(
    const std::string& assembly_name,
    const std::vector<TopoDS_Shape>& parts,
    const std::vector<std::string>& part_names,
    const std::vector<StepAssemblyMember>& members,
    const char* path,
    std::string& error) {
#ifndef LIME_OCCT_STEP
    (void)assembly_name;
    (void)parts;
    (void)part_names;
    (void)members;
    (void)path;
    error = "STEP writer is not linked";
    return false;
#else
    route_occt_log();
    if (path == nullptr || path[0] == '\0') {
        error = "STEP path is empty";
        return false;
    }
    if (parts.empty() || parts.size() != part_names.size() || members.empty()) {
        error = "An assembly STEP export needs parts and members";
        return false;
    }
    std::lock_guard<std::mutex> step_lock(step_mutex());
    XcafDocument held;
    if (held.document.IsNull()) {
        error = "Open CASCADE did not write this assembly";
        return false;
    }
    const Handle(XCAFDoc_ShapeTool) shapes = XCAFDoc_DocumentTool::ShapeTool(held.document->Main());
    const Handle(XCAFDoc_ColorTool) colors = XCAFDoc_DocumentTool::ColorTool(held.document->Main());

    // Add each distinct part once (D3: two members of one part share one product).
    std::vector<TDF_Label> part_labels(parts.size());
    std::vector<bool> part_colored(parts.size(), false);
    std::vector<std::array<double, 3>> part_color(parts.size(), {0.0, 0.0, 0.0});
    for (size_t p = 0; p < parts.size(); ++p) {
        part_labels[p] = shapes->AddShape(parts[p], Standard_False);
        TDataStd_Name::Set(part_labels[p], TCollection_ExtendedString(part_names[p].c_str(), Standard_True));
    }

    // Check whether all members of a part share one colour; if so, colour the product directly.
    for (size_t p = 0; p < parts.size(); ++p) {
        bool any = false;
        bool same = true;
        std::array<double, 3> c = {0.0, 0.0, 0.0};
        for (const auto& m : members) {
            if (m.part_index != static_cast<int>(p)) continue;
            if (!m.has_color) {
                same = false;
                break;
            }
            if (!any) {
                c = {m.color[0], m.color[1], m.color[2]};
                any = true;
            } else if (std::abs(c[0] - m.color[0]) > 1e-4 || std::abs(c[1] - m.color[1]) > 1e-4 || std::abs(c[2] - m.color[2]) > 1e-4) {
                same = false;
                break;
            }
        }
        if (any && same) {
            part_colored[p] = true;
            part_color[p] = c;
            colors->SetColor(part_labels[p], Quantity_Color(c[0], c[1], c[2], Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
        }
    }

    const size_t n = members.size();
    std::vector<gp_Trsf> worlds(n);
    std::vector<TDF_Label> proto_for_member(n);
    std::vector<std::vector<int>> children(n);
    std::vector<int> roots;

    for (size_t i = 0; i < n; ++i) {
        const auto& m = members[i];
        if (m.part_index < 0 || static_cast<size_t>(m.part_index) >= parts.size()) {
            error = "Assembly member references an invalid part";
            return false;
        }
        double scale = 1.0;
        worlds[i] = rigid_trsf_from(m.place, scale);
        if (std::abs(scale - 1.0) > 1e-6) {
            gp_Trsf s_trsf;
            s_trsf.SetScaleFactor(scale);
            BRepBuilderAPI_Transform scaled(parts[m.part_index], s_trsf, Standard_True);
            if (!scaled.IsDone() || scaled.Shape().IsNull()) {
                error = "Open CASCADE did not scale a part";
                return false;
            }
            TDF_Label scaled_label = shapes->AddShape(scaled.Shape(), Standard_False);
            TDataStd_Name::Set(scaled_label, TCollection_ExtendedString(m.name.c_str(), Standard_True));
            if (m.has_color) {
                colors->SetColor(scaled_label, Quantity_Color(m.color[0], m.color[1], m.color[2], Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
            }
            proto_for_member[i] = scaled_label;
        } else {
            proto_for_member[i] = part_labels[m.part_index];
        }
        if (m.parent >= 0 && static_cast<size_t>(m.parent) < n && m.parent != static_cast<int>(i)) {
            children[m.parent].push_back(static_cast<int>(i));
        } else {
            roots.push_back(static_cast<int>(i));
        }
    }

    const TDF_Label root_asm = shapes->NewShape();
    TDataStd_Name::Set(root_asm, TCollection_ExtendedString(assembly_name.c_str(), Standard_True));

    auto color_instance = [&](const TDF_Label& inst, size_t i) {
        const auto& m = members[i];
        if (!m.has_color) return;
        if (proto_for_member[i] == part_labels[m.part_index] && part_colored[m.part_index]) return;
        colors->SetColor(inst, Quantity_Color(m.color[0], m.color[1], m.color[2], Quantity_TOC_sRGB), XCAFDoc_ColorSurf);
    };

    std::function<void(int, const TDF_Label&, const gp_Trsf&)> add_node =
        [&](int idx, const TDF_Label& parent_asm, const gp_Trsf& parent_world) {
            const gp_Trsf local_trsf = parent_world.Inverted() * worlds[idx];
            const TopLoc_Location local_loc(local_trsf);
            if (children[idx].empty()) {
                const TDF_Label inst = shapes->AddComponent(parent_asm, proto_for_member[idx], local_loc);
                TDataStd_Name::Set(inst, TCollection_ExtendedString(members[idx].name.c_str(), Standard_True));
                color_instance(inst, static_cast<size_t>(idx));
            } else {
                const TDF_Label sub_asm = shapes->NewShape();
                TDataStd_Name::Set(sub_asm, TCollection_ExtendedString(members[idx].name.c_str(), Standard_True));
                const TDF_Label self_inst = shapes->AddComponent(sub_asm, proto_for_member[idx], TopLoc_Location());
                TDataStd_Name::Set(self_inst, TCollection_ExtendedString(members[idx].name.c_str(), Standard_True));
                color_instance(self_inst, static_cast<size_t>(idx));
                for (int child : children[idx]) {
                    add_node(child, sub_asm, worlds[idx]);
                }
                const TDF_Label sub_comp = shapes->AddComponent(parent_asm, sub_asm, local_loc);
                TDataStd_Name::Set(sub_comp, TCollection_ExtendedString(members[idx].name.c_str(), Standard_True));
            }
        };

    const gp_Trsf identity;
    for (int root : roots) {
        add_node(root, root_asm, identity);
    }
    shapes->UpdateAssemblies();

    STEPCAFControl_Writer writer;
    writer.SetNameMode(Standard_True);
    writer.SetColorMode(Standard_True);
    DESTEP_Parameters params;
    params.WriteSchema = DESTEP_Parameters::WriteMode_StepSchema_AP242DIS;
    params.WriteAssembly = DESTEP_Parameters::WriteMode_Assembly_On;
    params.WriteUnit = UnitsMethods_LengthUnit_Millimeter;
    params.WriteSurfaceCurMode = false;
    params.WriteName = true;
    params.WriteColor = true;
    if (!writer.Transfer(held.document, params, STEPControl_AsIs) ||
        writer.Write(path) != IFSelect_RetDone) {
        error = "Open CASCADE did not write this assembly";
        return false;
    }
    return true;
#endif
}

std::string read_step_assembly_json(const char* path, std::string& error) {
#ifndef LIME_OCCT_STEP
    (void)path;
    error = "STEP reader is not linked";
    return {};
#else
    route_occt_log();
    if (path == nullptr || path[0] == '\0') {
        error = "STEP path is empty";
        return {};
    }
    std::lock_guard<std::mutex> step_lock(step_mutex());
    XcafDocument held;
    STEPCAFControl_Reader reader;
    reader.SetNameMode(Standard_True);
    reader.SetColorMode(Standard_True);
    if (held.document.IsNull() || reader.ReadFile(path) != IFSelect_RetDone ||
        !reader.Transfer(held.document)) {
        error = "Open CASCADE could not read this STEP file";
        return {};
    }
    const Handle(XCAFDoc_ShapeTool) shapes = XCAFDoc_DocumentTool::ShapeTool(held.document->Main());
    const Handle(XCAFDoc_ColorTool) colors = XCAFDoc_DocumentTool::ColorTool(held.document->Main());

    struct ProductInfo { std::string id; std::string name; };
    struct InstanceInfo {
        std::string name;
        std::string parent;
        std::string product_id;
        double pose[12];
        bool has_color = false;
        double color[3] = {0, 0, 0};
    };
    std::map<std::string, size_t> product_map;
    std::vector<ProductInfo> products;
    std::vector<InstanceInfo> instances;

    auto entry_of = [](const TDF_Label& label) -> std::string {
        TCollection_AsciiString entry;
        TDF_Tool::Entry(label, entry);
        return entry.ToCString();
    };
    auto find_color = [&](const TDF_Label& inst, const TDF_Label& ref, double out_rgb[3]) -> bool {
        Quantity_Color qc;
        if (colors->GetColor(inst, XCAFDoc_ColorSurf, qc) ||
            colors->GetColor(inst, XCAFDoc_ColorGen, qc) ||
            colors->GetColor(ref, XCAFDoc_ColorSurf, qc) ||
            colors->GetColor(ref, XCAFDoc_ColorGen, qc)) {
            Standard_Real r = 0, g = 0, b = 0;
            qc.Values(r, g, b, Quantity_TOC_sRGB);
            out_rgb[0] = r;
            out_rgb[1] = g;
            out_rgb[2] = b;
            return true;
        }
        return false;
    };

    std::function<void(const TDF_Label&, const TopLoc_Location&, const std::string&, const std::string&)> walk =
        [&](const TDF_Label& asm_label, const TopLoc_Location& parent_loc, const std::string& asm_name, const std::string& asm_parent) {
            TDF_LabelSequence comps;
            shapes->GetComponents(asm_label, comps);
            for (Standard_Integer i = 1; i <= comps.Length(); ++i) {
                const TDF_Label comp = comps.Value(i);
                const TopLoc_Location rel_loc = shapes->GetLocation(comp);
                const TopLoc_Location loc = parent_loc * rel_loc;
                TDF_Label ref;
                if (!shapes->GetReferredShape(comp, ref)) ref = comp;
                std::string comp_name = label_name_of(comp);
                if (comp_name.empty()) comp_name = label_name_of(ref);
                if (shapes->IsAssembly(ref)) {
                    walk(ref, loc, comp_name, asm_name);
                } else {
                    const std::string pid = entry_of(ref);
                    if (product_map.find(pid) == product_map.end()) {
                        product_map[pid] = products.size();
                        products.push_back({pid, label_name_of(ref)});
                    }
                    const gp_Trsf trsf = loc.Transformation();
                    InstanceInfo info;
                    info.name = comp_name;
                    const gp_Trsf rel_trsf = rel_loc.Transformation();
                    auto is_identity_trsf = [](const gp_Trsf& tr) {
                        if (tr.Form() == gp_Identity) return true;
                        if (tr.TranslationPart().Modulus() > 1e-6) return false;
                        for (int r = 1; r <= 3; ++r) {
                            for (int c = 1; c <= 3; ++c) {
                                if (std::abs(tr.Value(r, c) - (r == c ? 1.0 : 0.0)) > 1e-6) return false;
                            }
                        }
                        return true;
                    };
                    // A member with children is wrapped in a sub-assembly of the same name holding its own solid
                    // at identity; report its enclosing assembly/member as its parent in the joint tree.
                    info.parent = (!asm_parent.empty() && comp_name == asm_name && is_identity_trsf(rel_trsf)) ? asm_parent : asm_name;
                    info.product_id = pid;
                    for (int row = 1; row <= 3; ++row) {
                        for (int col = 1; col <= 3; ++col) {
                            info.pose[(row - 1) * 3 + (col - 1)] = trsf.Value(row, col);
                        }
                    }
                    const gp_XYZ t = trsf.TranslationPart();
                    info.pose[9] = t.X();
                    info.pose[10] = t.Y();
                    info.pose[11] = t.Z();
                    info.has_color = find_color(comp, ref, info.color);
                    instances.push_back(std::move(info));
                }
            }
        };

    TDF_LabelSequence free;
    shapes->GetFreeShapes(free);
    std::string root_name;
    for (Standard_Integer i = 1; i <= free.Length(); ++i) {
        const TDF_Label label = free.Value(i);
        if (shapes->IsAssembly(label)) {
            if (root_name.empty()) root_name = label_name_of(label);
            walk(label, TopLoc_Location(), label_name_of(label), "");
        } else {
            const std::string pid = entry_of(label);
            if (product_map.find(pid) == product_map.end()) {
                product_map[pid] = products.size();
                products.push_back({pid, label_name_of(label)});
            }
            InstanceInfo info;
            info.name = label_name_of(label);
            info.parent = "";
            info.product_id = pid;
            double id[12] = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
            std::memcpy(info.pose, id, sizeof(id));
            info.has_color = find_color(label, label, info.color);
            instances.push_back(std::move(info));
        }
    }

    std::ostringstream js;
    js.imbue(std::locale::classic());
    js.precision(12);
    js << "{\"assemblyName\":" << escape_json_str(root_name) << ",\"products\":[";
    for (size_t i = 0; i < products.size(); ++i) {
        if (i > 0) js << ',';
        js << "{\"id\":" << escape_json_str(products[i].id) << ",\"name\":" << escape_json_str(products[i].name) << '}';
    }
    js << "],\"instances\":[";
    for (size_t i = 0; i < instances.size(); ++i) {
        if (i > 0) js << ',';
        const auto& inst = instances[i];
        js << "{\"name\":" << escape_json_str(inst.name)
           << ",\"parent\":" << escape_json_str(inst.parent)
           << ",\"productId\":" << escape_json_str(inst.product_id)
           << ",\"pose\":{\"m\":["
           << inst.pose[0] << ',' << inst.pose[1] << ',' << inst.pose[2] << ','
           << inst.pose[3] << ',' << inst.pose[4] << ',' << inst.pose[5] << ','
           << inst.pose[6] << ',' << inst.pose[7] << ',' << inst.pose[8]
           << "],\"t\":[" << inst.pose[9] << ',' << inst.pose[10] << ',' << inst.pose[11] << "]}";
        if (inst.has_color) {
            js << ",\"color\":[" << inst.color[0] << ',' << inst.color[1] << ',' << inst.color[2] << ']';
        }
        js << '}';
    }
    js << "]}";
    return js.str();
#endif
}

bool read_step_named(
    const char* path,
    std::vector<std::pair<std::string, TopoDS_Shape>>& out,
    std::string& error) {
#ifndef LIME_OCCT_STEP
    (void)path;
    (void)out;
    error = "STEP reader is not linked";
    return false;
#else
    route_occt_log();
    if (path == nullptr || path[0] == '\0') {
        error = "STEP path is empty";
        return false;
    }
    std::lock_guard<std::mutex> step_lock(step_mutex());
    XcafDocument held;
    STEPCAFControl_Reader reader;
    reader.SetNameMode(Standard_True);
    if (held.document.IsNull() || reader.ReadFile(path) != IFSelect_RetDone ||
        !reader.Transfer(held.document)) {
        error = "Open CASCADE could not read this STEP file";
        return false;
    }
    const Handle(XCAFDoc_ShapeTool) shapes = XCAFDoc_DocumentTool::ShapeTool(held.document->Main());
    TDF_LabelSequence free;
    shapes->GetFreeShapes(free);
    for (Standard_Integer index = 1; index <= free.Length(); ++index) {
        const TDF_Label label = free.Value(index);
        if (shapes->IsAssembly(label)) {
            collect_named_assembly_solids(shapes, label, TopLoc_Location(), out);
        } else {
            out.emplace_back("S" + label_name_of(label), XCAFDoc_ShapeTool::GetShape(label));
        }
    }
    return true;
#endif
}

namespace {

/// Reads bytes in place, with the seeks BinTools uses to follow shared sub-shapes.
struct MemoryBuffer : std::streambuf {
    MemoryBuffer(const char* data, size_t size) {
        char* start = const_cast<char*>(data);
        setg(start, start, start + size);
    }

    pos_type seekoff(off_type offset, std::ios_base::seekdir dir, std::ios_base::openmode) override {
        char* base = dir == std::ios_base::beg ? eback() : dir == std::ios_base::cur ? gptr() : egptr();
        if (offset < eback() - base || offset > egptr() - base) {
            return pos_type(off_type(-1));
        }
        char* to = base + offset;
        setg(eback(), to, egptr());
        return pos_type(to - eback());
    }

    pos_type seekpos(pos_type pos, std::ios_base::openmode mode) override {
        return seekoff(off_type(pos), std::ios_base::beg, mode);
    }
};

}  // namespace

std::string write_brep(const TopoDS_Shape& shape) {
    std::ostringstream out(std::ios::out | std::ios::binary);
    BinTools::Write(shape, out, Standard_False, Standard_False, BinTools_FormatVersion_CURRENT);
    return out.str();
}

TopoDS_Shape read_brep(const char* data, size_t size, std::string& error) {
    MemoryBuffer buffer(data, size);
    std::istream in(&buffer);
    TopoDS_Shape shape;
    BinTools::Read(shape, in);
    // A cut-short stream fails an extraction (failbit) rather than the stream (badbit).
    if (shape.IsNull() || in.fail()) {
        error = "Open CASCADE could not read this solid";
        return {};
    }
    return shape;
}

bool build_split(
    const TopoDS_Shape& current,
    double x,
    double y,
    double z,
    double nx,
    double ny,
    double nz,
    TopoDS_Shape& kept,
    TopoDS_Shape& other,
    double& negative_volume,
    double& positive_volume,
    std::string& error) {
    const double length = std::sqrt(nx * nx + ny * ny + nz * nz);
    if (!(length > 1e-12)) {
        error = "The plane needs a direction";
        return false;
    }
    const gp_Dir normal(nx / length, ny / length, nz / length);
    Bnd_Box bounds;
    BRepBndLib::Add(current, bounds, Standard_False);
    if (bounds.IsVoid()) {
        error = "This solid has no extent";
        return false;
    }
    double xmin = 0;
    double ymin = 0;
    double zmin = 0;
    double xmax = 0;
    double ymax = 0;
    double zmax = 0;
    bounds.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    const gp_Pnt origin(x, y, z);
    if (const char* reject = split_reject(origin, normal, xmin, ymin, zmin, xmax, ymax, zmax)) {
        error = reject;
        return false;
    }
    const gp_Pnt center((xmin + xmax) * 0.5, (ymin + ymax) * 0.5, (zmin + zmax) * 0.5);
    const gp_Vec toward(origin, center);
    const gp_Pnt face_center = center.Translated(gp_Vec(normal).Multiplied(-toward.Dot(gp_Vec(normal))));
    const double span = std::sqrt(
                            (xmax - xmin) * (xmax - xmin) + (ymax - ymin) * (ymax - ymin) + (zmax - zmin) * (zmax - zmin)) +
                        1.0;
    BRepBuilderAPI_MakeFace face(gp_Pln(face_center, normal), -span, span, -span, span);
    face.Build();
    if (!face.IsDone()) {
        error = "Open CASCADE did not build the plane";
        return false;
    }
    TopTools_ListOfShape arguments;
    arguments.Append(current);
    TopTools_ListOfShape tools;
    tools.Append(face.Shape());
    BRepAlgoAPI_Splitter splitter;
    splitter.SetArguments(arguments);
    splitter.SetTools(tools);
    splitter.SetNonDestructive(Standard_True);
    g_stats.builds += 1;
    splitter.Build();
    if (!splitter.IsDone() || splitter.HasErrors() || splitter.Shape().IsNull()) {
        error = "Open CASCADE did not split this solid";
        return false;
    }
    std::vector<TopoDS_Shape> negative;
    std::vector<TopoDS_Shape> positive;
    negative_volume = 0.0;
    positive_volume = 0.0;
    for (TopExp_Explorer explorer(splitter.Shape(), TopAbs_SOLID); explorer.More(); explorer.Next()) {
        const TopoDS_Shape piece = explorer.Current();
        GProp_GProps props;
        integrate(piece, props);
        const double side = gp_Vec(origin, props.CentreOfMass()).Dot(gp_Vec(normal));
        if (side < 0.0) {
            negative.push_back(piece);
            negative_volume += props.Mass();
        } else {
            positive.push_back(piece);
            positive_volume += props.Mass();
        }
    }
    std::string join_error;
    auto unite = [&join_error](const std::vector<TopoDS_Shape>& pieces) -> TopoDS_Shape {
        if (pieces.empty()) {
            return {};
        }
        TopoDS_Shape acc = pieces.front();
        for (size_t index = 1; index < pieces.size(); ++index) {
            // Built once: the two-shape constructor would build it a first time, destructively.
            TopTools_ListOfShape objects;
            objects.Append(acc);
            TopTools_ListOfShape tools;
            tools.Append(pieces[index]);
            BRepAlgoAPI_Fuse fuse;
            fuse.SetArguments(objects);
            fuse.SetTools(tools);
            fuse.SetNonDestructive(Standard_True);
            fuse.SetToFillHistory(Standard_False);
            fuse.Build();
            if (!fuse.IsDone() || fuse.HasErrors() || fuse.Shape().IsNull()) {
                join_error = "Open CASCADE did not join the split pieces";
                return {};
            }
            acc = fuse.Shape();
        }
        return acc;
    };
    kept = as_solid(unite(negative));
    other = as_solid(unite(positive));
    if (!join_error.empty()) {
        error = join_error;
        return false;
    }
    // The pieces on one side are disjoint, so the joined piece holds their summed volume.
    if (kept.IsNull() || other.IsNull() || !(negative_volume > 1e-6) || !(positive_volume > 1e-6)) {
        error = "The plane did not split this solid";
        return false;
    }
    constexpr double kThinnest = 0.25;
    if (depth_along(kept, normal, kThinnest) < kThinnest || depth_along(other, normal, kThinnest) < kThinnest) {
        error = "The plane is too close to a face. Move it into the part.";
        return false;
    }
    return true;
}

bool every_edge_shared_by_two(const TopoDS_Shape& shape) {
    TopTools_IndexedMapOfShape edges;
    std::vector<int> uses;
    for (TopExp_Explorer face(shape, TopAbs_FACE); face.More(); face.Next()) {
        for (TopExp_Explorer edge(face.Current(), TopAbs_EDGE); edge.More(); edge.Next()) {
            if (BRep_Tool::Degenerated(TopoDS::Edge(edge.Current()))) {
                continue;
            }
            const int at = edges.Add(edge.Current());
            if (static_cast<size_t>(at) > uses.size()) {
                uses.resize(static_cast<size_t>(at), 0);
            }
            uses[static_cast<size_t>(at - 1)] += 1;
        }
    }
    return !uses.empty() && std::all_of(uses.begin(), uses.end(), [](int count) { return count == 2; });
}

namespace {

/// A sketched cut (plan section 6), in its own (U, W) from the plane's origin: the chain as a polyline with its ends carried
/// along U past the part, and the region on the chain's −W side, which the pieces with the plane's negative sign fill.
struct ChainSide {
    bool on = false;
    gp_Pnt origin;
    gp_Dir u;
    gp_Dir w;
    std::vector<gp_XY> trace;
    std::vector<gp_XY> region;
};

/// The arc from `a` through `m` to `b` as `steps` + 1 points, `a` first. Empty when the three points lie on one line.
std::vector<gp_XY> arc_points(const gp_XY& a, const gp_XY& m, const gp_XY& b, int steps) {
    const double d = 2 * (a.X() * (m.Y() - b.Y()) + m.X() * (b.Y() - a.Y()) + b.X() * (a.Y() - m.Y()));
    if (std::abs(d) < 1e-12) {
        return {};
    }
    const double a2 = a.SquareModulus();
    const double m2 = m.SquareModulus();
    const double b2 = b.SquareModulus();
    const gp_XY centre((a2 * (m.Y() - b.Y()) + m2 * (b.Y() - a.Y()) + b2 * (a.Y() - m.Y())) / d,
                       (a2 * (b.X() - m.X()) + m2 * (a.X() - b.X()) + b2 * (m.X() - a.X())) / d);
    const double two_pi = 2 * std::acos(-1.0);
    auto angle = [&](const gp_XY& p) { return std::atan2(p.Y() - centre.Y(), p.X() - centre.X()); };
    auto ccw = [&](double from, double to) {
        double sweep = std::fmod(to - from, two_pi);
        return sweep < 0 ? sweep + two_pi : sweep;
    };
    const double start = angle(a);
    // Counter-clockwise from `a`, the arc passes `m` before `b`, or it runs the other way.
    double sweep = ccw(start, angle(b));
    if (ccw(start, angle(m)) > sweep) {
        sweep -= two_pi;
    }
    const double radius = (a - centre).Modulus();
    std::vector<gp_XY> out;
    for (int step = 0; step <= steps; ++step) {
        const double t = start + sweep * step / steps;
        out.emplace_back(centre.X() + radius * std::cos(t), centre.Y() + radius * std::sin(t));
    }
    out.front() = a;
    out.back() = b;
    return out;
}

double cross_xy(const gp_XY& a, const gp_XY& b) { return a.X() * b.Y() - a.Y() * b.X(); }

/// Whether segments `a`–`b` and `c`–`d` cross or touch.
bool segments_meet(const gp_XY& a, const gp_XY& b, const gp_XY& c, const gp_XY& d) {
    constexpr double kEps = 1e-9;
    const double d1 = cross_xy(b - a, c - a);
    const double d2 = cross_xy(b - a, d - a);
    const double d3 = cross_xy(d - c, a - c);
    const double d4 = cross_xy(d - c, b - c);
    if (((d1 > kEps && d2 < -kEps) || (d1 < -kEps && d2 > kEps)) && ((d3 > kEps && d4 < -kEps) || (d3 < -kEps && d4 > kEps))) {
        return true;
    }
    auto on = [&](const gp_XY& p, const gp_XY& q, const gp_XY& r, double side) {
        return std::abs(side) <= kEps && r.X() >= std::min(p.X(), q.X()) - kEps && r.X() <= std::max(p.X(), q.X()) + kEps &&
               r.Y() >= std::min(p.Y(), q.Y()) - kEps && r.Y() <= std::max(p.Y(), q.Y()) + kEps;
    };
    return on(a, b, c, d1) || on(a, b, d, d2) || on(c, d, a, d3) || on(c, d, b, d4);
}

bool inside_xy(const gp_XY& p, const std::vector<gp_XY>& ring) {
    bool inside = false;
    for (size_t i = 0, j = ring.size() - 1; i < ring.size(); j = i++) {
        const gp_XY& a = ring[i];
        const gp_XY& b = ring[j];
        if ((a.Y() > p.Y()) != (b.Y() > p.Y()) && p.X() < (b.X() - a.X()) * (p.Y() - a.Y()) / (b.Y() - a.Y()) + a.X()) {
            inside = !inside;
        }
    }
    return inside;
}

double distance_to_trace(const gp_XY& p, const std::vector<gp_XY>& trace) {
    double best = std::numeric_limits<double>::max();
    for (size_t i = 1; i < trace.size(); ++i) {
        const gp_XY along = trace[i] - trace[i - 1];
        const double length2 = along.SquareModulus();
        const double t = length2 > 0 ? std::clamp((p - trace[i - 1]).Dot(along) / length2, 0.0, 1.0) : 0.0;
        best = std::min(best, (p - (trace[i - 1] + along * t)).Modulus());
    }
    return best;
}

/// The sign of the side of a sketched cut `piece` is on: 0 on the chain's −W side, else 1. Read from the piece's vertices
/// that are off the chain, since a piece that wraps a tooth can have its centre of mass on the other side.
int chain_sign(const ChainSide& side, const TopoDS_Shape& piece, const gp_Pnt& centre) {
    auto uw = [&](const gp_Pnt& p) {
        const gp_Vec d(side.origin, p);
        return gp_XY(d.Dot(gp_Vec(side.u)), d.Dot(gp_Vec(side.w)));
    };
    int below = 0;
    int above = 0;
    for (TopExp_Explorer vertex(piece, TopAbs_VERTEX); vertex.More(); vertex.Next()) {
        const gp_XY at = uw(BRep_Tool::Pnt(TopoDS::Vertex(vertex.Current())));
        if (distance_to_trace(at, side.trace) < 1e-3) {
            continue;
        }
        (inside_xy(at, side.region) ? below : above) += 1;
    }
    if (below + above == 0) {
        return inside_xy(uw(centre), side.region) ? 0 : 1;
    }
    return below >= above ? 0 : 1;
}

}  // namespace

bool build_partition(
    const TopoDS_Shape& current,
    const std::vector<std::array<double, 6>>& planes,
    std::vector<PartitionPiece>& pieces,
    std::string& error,
    const std::vector<PartitionProfile>& profiles) {
    pieces.clear();
    if (planes.empty()) {
        error = "A partition needs at least one plane";
        return false;
    }
    if (planes.size() >= kMaxPartitionPieces) {
        error = "A partition makes at most 24 pieces";
        return false;
    }
    Bnd_Box bounds;
    BRepBndLib::Add(current, bounds, Standard_False);
    if (bounds.IsVoid()) {
        error = "This solid has no extent";
        return false;
    }
    double xmin = 0;
    double ymin = 0;
    double zmin = 0;
    double xmax = 0;
    double ymax = 0;
    double zmax = 0;
    bounds.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    const gp_Pnt center((xmin + xmax) * 0.5, (ymin + ymax) * 0.5, (zmin + zmax) * 0.5);
    const double span = std::sqrt(
                            (xmax - xmin) * (xmax - xmin) + (ymax - ymin) * (ymax - ymin) + (zmax - zmin) * (zmax - zmin)) +
                        1.0;
    std::vector<gp_Pnt> origins;
    std::vector<gp_Dir> normals;
    std::vector<ChainSide> sides(planes.size());
    TopTools_ListOfShape tools;
    for (const std::array<double, 6>& plane : planes) {
        const double length = std::sqrt(plane[3] * plane[3] + plane[4] * plane[4] + plane[5] * plane[5]);
        if (!(length > 1e-12)) {
            error = "The plane needs a direction";
            return false;
        }
        const gp_Dir normal(plane[3] / length, plane[4] / length, plane[5] / length);
        const gp_Pnt origin(plane[0], plane[1], plane[2]);
        if (const char* reject = split_reject(origin, normal, xmin, ymin, zmin, xmax, ymax, zmax)) {
            error = reject;
            return false;
        }
        const size_t at = origins.size();
        const PartitionProfile* shaped = at < profiles.size() && profiles[at].kind == 1 ? &profiles[at] : nullptr;
        if (shaped != nullptr) {
            // A lap: the polyline (V, W) = (-far, 0), (step, 0), (step, a), (far, a), swept along U as a shell, which the
            // splitter takes as it takes a plane. The side of each piece is read from the plane between the two flats.
            gp_Vec across(shaped->u[0], shaped->u[1], shaped->u[2]);
            across -= gp_Vec(normal).Multiplied(across.Dot(gp_Vec(normal)));
            if (!(across.Magnitude() > 1e-9)) {
                error = "A lap needs the cut's U";
                return false;
            }
            const gp_Dir u(across);
            const gp_Dir v(gp_Vec(normal).Crossed(gp_Vec(u)));
            const gp_Vec w(normal);
            const gp_Pnt start = origin.Translated(gp_Vec(u).Multiplied(-span));
            auto at_vw = [&](double along, double up) { return start.Translated(gp_Vec(v).Multiplied(along) + w.Multiplied(up)); };
            BRepBuilderAPI_MakePolygon line;
            line.Add(at_vw(-span, 0));
            line.Add(at_vw(shaped->b, 0));
            line.Add(at_vw(shaped->b, shaped->a));
            line.Add(at_vw(span, shaped->a));
            if (!line.IsDone()) {
                error = "Open CASCADE did not build the lap";
                return false;
            }
            BRepPrimAPI_MakePrism sweep(line.Wire(), gp_Vec(u).Multiplied(2 * span));
            sweep.Build();
            if (!sweep.IsDone()) {
                error = "Open CASCADE did not build the lap";
                return false;
            }
            tools.Append(sweep.Shape());
            origins.push_back(origin.Translated(w.Multiplied(shaped->a / 2)));
            normals.push_back(normal);
            continue;
        }
        if (at < profiles.size() && profiles[at].kind == kProfileSketch) {
            // A sketch: the open chain of lines and arcs drawn in (U, W), its ends carried along U to the part's box, swept
            // along V as a shell. Each piece's side is read against the chain itself, not a plane.
            const PartitionProfile& drawn = profiles[at];
            gp_Vec across(drawn.u[0], drawn.u[1], drawn.u[2]);
            across -= gp_Vec(normal).Multiplied(across.Dot(gp_Vec(normal)));
            const size_t segments = drawn.chain.size() / kChainStride;
            if (!(across.Magnitude() > 1e-9) || segments == 0 || drawn.chain.size() % kChainStride != 0) {
                error = "A sketch profile needs a chain of lines and arcs and the cut's U";
                return false;
            }
            const gp_Dir u(across);
            const gp_Dir v(gp_Vec(normal).Crossed(gp_Vec(u)));
            const gp_Vec w(normal);
            const gp_Pnt start = origin.Translated(gp_Vec(v).Multiplied(-span));
            auto at_uw = [&](const gp_XY& p) { return start.Translated(gp_Vec(u).Multiplied(p.X()) + w.Multiplied(p.Y())); };
            std::vector<gp_XY> corners{gp_XY(drawn.c, drawn.d)};
            for (size_t index = 0; index < segments; ++index) {
                corners.emplace_back(drawn.chain[kChainStride * index + 3], drawn.chain[kChainStride * index + 4]);
            }
            const gp_XY first = corners.front();
            const gp_XY last = corners.back();
            // The ends go on along U, away from the chain, to the box: a chain drawn past the section's sides cuts it all.
            const double outward = last.X() >= first.X() ? 1.0 : -1.0;
            const gp_XY lead(-outward * span, first.Y());
            const gp_XY tail(outward * span, last.Y());
            const bool leads = (first.X() - lead.X()) * outward > kTinyMm;
            const bool tails = (tail.X() - last.X()) * outward > kTinyMm;
            BRepBuilderAPI_MakeWire wire;
            std::vector<gp_XY> trace;
            auto line = [&](const gp_XY& from, const gp_XY& to) {
                if ((to - from).Modulus() <= kTinyMm) {
                    return true;
                }
                BRepBuilderAPI_MakeEdge edge(at_uw(from), at_uw(to));
                if (!edge.IsDone()) {
                    return false;
                }
                wire.Add(edge.Edge());
                trace.push_back(to);
                return wire.IsDone();
            };
            bool built = true;
            if (leads) {
                trace.push_back(lead);
                built = line(lead, first);
            } else {
                trace.push_back(first);
            }
            for (size_t index = 0; built && index < segments; ++index) {
                const double* row = drawn.chain.data() + kChainStride * index;
                const gp_XY from = corners[index];
                const gp_XY to = corners[index + 1];
                if (row[0] == 0.0) {
                    built = line(from, to);
                    continue;
                }
                const gp_XY through(row[1], row[2]);
                const std::vector<gp_XY> sampled = arc_points(from, through, to, 48);
                if (sampled.empty()) {
                    built = line(from, to);
                    continue;
                }
                Handle(Geom_TrimmedCurve) arc = GC_MakeArcOfCircle(at_uw(from), at_uw(through), at_uw(to));
                BRepBuilderAPI_MakeEdge edge(arc);
                if (arc.IsNull() || !edge.IsDone()) {
                    built = false;
                    break;
                }
                wire.Add(edge.Edge());
                built = wire.IsDone();
                trace.insert(trace.end(), sampled.begin() + 1, sampled.end());
            }
            if (built && tails) {
                built = line(last, tail);
            }
            if (!built) {
                error = "Open CASCADE did not build the sketch profile";
                return false;
            }
            // Segments that meet anywhere but at their shared corner cross: the profile would not part the solid in two.
            for (size_t i = 1; i < trace.size(); ++i) {
                for (size_t j = i + 2; j < trace.size(); ++j) {
                    if (segments_meet(trace[i - 1], trace[i], trace[j - 1], trace[j])) {
                        error = "The profile crosses itself.";
                        return false;
                    }
                }
            }
            BRepPrimAPI_MakePrism sweep(wire.Wire(), gp_Vec(v).Multiplied(2 * span));
            sweep.Build();
            if (!sweep.IsDone()) {
                error = "Open CASCADE did not build the sketch profile";
                return false;
            }
            tools.Append(sweep.Shape());
            ChainSide& side = sides[at];
            side.on = true;
            side.origin = origin;
            side.u = u;
            side.w = gp_Dir(w);
            side.trace = trace;
            side.region = trace;
            const double floor = -4 * span;
            side.region.emplace_back(trace.back().X(), floor);
            side.region.emplace_back(trace.front().X(), floor);
            origins.push_back(origin);
            normals.push_back(normal);
            continue;
        }
        if (at < profiles.size() && profiles[at].kind == 3) {
            // A zig-zag: a square wave in (U, W), swept along V as a shell. Each period starts with the low flat, then the
            // tooth, whose flanks lean inward by half of depth × tan(angle) each, so its tip is that much the narrower.
            const PartitionProfile& wave = profiles[at];
            gp_Vec across(wave.u[0], wave.u[1], wave.u[2]);
            across -= gp_Vec(normal).Multiplied(across.Dot(gp_Vec(normal)));
            if (!(across.Magnitude() > 1e-9) || !positive(wave.b) || !positive(wave.a)) {
                error = "A zig-zag needs a pitch, a depth and the cut's U";
                return false;
            }
            const gp_Dir u(across);
            const gp_Dir v(gp_Vec(normal).Crossed(gp_Vec(u)));
            const gp_Vec w(normal);
            const double pitch = wave.b;
            const double depth = wave.a;
            const double lean = std::abs(depth) * std::tan(wave.c * std::acos(-1.0) / 180.0) / 2;
            if (!(pitch / 2 - 2 * lean > 1e-6)) {
                error = "This zig-zag's tooth has no tip. Widen the pitch or lower the angle";
                return false;
            }
            const gp_Pnt start = origin.Translated(gp_Vec(v).Multiplied(-span));
            auto at_uw = [&](double along, double up) { return start.Translated(gp_Vec(u).Multiplied(along) + w.Multiplied(up)); };
            BRepBuilderAPI_MakePolygon line;
            const double first = wave.d - pitch;
            const int periods = static_cast<int>(std::ceil((2 * span + 2 * pitch) / pitch));
            if (periods > 4000) {
                error = "This zig-zag has too many teeth for the part. Widen the pitch";
                return false;
            }
            line.Add(at_uw(first, 0));
            for (int period = 0; period < periods; ++period) {
                const double x = first + period * pitch;
                line.Add(at_uw(x + pitch / 2, 0));
                line.Add(at_uw(x + pitch / 2 + lean, depth));
                line.Add(at_uw(x + pitch - lean, depth));
                line.Add(at_uw(x + pitch, 0));
            }
            if (!line.IsDone()) {
                error = "Open CASCADE did not build the zig-zag";
                return false;
            }
            BRepPrimAPI_MakePrism sweep(line.Wire(), gp_Vec(v).Multiplied(2 * span));
            sweep.Build();
            if (!sweep.IsDone()) {
                error = "Open CASCADE did not build the zig-zag";
                return false;
            }
            tools.Append(sweep.Shape());
            origins.push_back(origin.Translated(w.Multiplied(depth / 2)));
            normals.push_back(normal);
            continue;
        }
        const gp_Vec toward(origin, center);
        const gp_Pnt face_center = center.Translated(gp_Vec(normal).Multiplied(-toward.Dot(gp_Vec(normal))));
        BRepBuilderAPI_MakeFace face(gp_Pln(face_center, normal), -span, span, -span, span);
        face.Build();
        if (!face.IsDone()) {
            error = "Open CASCADE did not build the plane";
            return false;
        }
        tools.Append(face.Shape());
        origins.push_back(origin);
        normals.push_back(normal);
    }
    constexpr double kThinnest = 0.25;
    for (size_t a = 0; a < planes.size(); ++a) {
        for (size_t b = a + 1; b < planes.size(); ++b) {
            if (std::abs(gp_Vec(normals[a]).Dot(gp_Vec(normals[b]))) > 1.0 - 1e-9 &&
                std::abs(gp_Vec(origins[a], origins[b]).Dot(gp_Vec(normals[a]))) < kThinnest) {
                error = "Two planes are too close together. Move them apart.";
                return false;
            }
        }
    }
    TopTools_ListOfShape arguments;
    arguments.Append(current);
    BRepAlgoAPI_Splitter splitter;
    splitter.SetArguments(arguments);
    splitter.SetTools(tools);
    splitter.SetNonDestructive(Standard_True);
    g_stats.builds += 1;
    Handle(Message_ProgressIndicator) watch;
    splitter.Build(deadline_range(watch));
    if (!splitter.IsDone() || splitter.HasErrors() || splitter.Shape().IsNull()) {
        error = past_deadline() ? deadline_message() : "Open CASCADE did not split this solid";
        return false;
    }
    struct Part {
        TopoDS_Shape shape;
        std::vector<int> signs;
        double along;
    };
    std::vector<Part> parts;
    for (TopExp_Explorer explorer(splitter.Shape(), TopAbs_SOLID); explorer.More(); explorer.Next()) {
        GProp_GProps props;
        integrate(explorer.Current(), props);
        Part part{explorer.Current(), {}, gp_Vec(origins[0], props.CentreOfMass()).Dot(gp_Vec(normals[0]))};
        for (size_t index = 0; index < planes.size(); ++index) {
            if (sides[index].on) {
                part.signs.push_back(chain_sign(sides[index], explorer.Current(), props.CentreOfMass()));
                continue;
            }
            part.signs.push_back(gp_Vec(origins[index], props.CentreOfMass()).Dot(gp_Vec(normals[index])) < 0.0 ? 0 : 1);
        }
        parts.push_back(part);
    }
    std::stable_sort(parts.begin(), parts.end(), [](const Part& a, const Part& b) {
        return a.signs != b.signs ? a.signs < b.signs : a.along < b.along;
    });
    // Every plane spans the whole part, so each solid the splitter returns is one connected piece. Two solids on the
    // same side of every plane (the arms of a U cut across) do not touch, so each stays a piece of its own.
    for (const Part& part : parts) {
        TopoDS_Shape solid = as_solid(part.shape);
        if (solid.IsNull() || solid.ShapeType() != TopAbs_SOLID) {
            error = "The planes did not cut this solid into whole pieces";
            return false;
        }
        if (!BRepCheck_Analyzer(solid).IsValid()) {
            ShapeFix_Solid fix;
            fix.Init(TopoDS::Solid(solid));
            fix.Perform();
            solid = fix.Solid();
        }
        if (!BRepCheck_Analyzer(solid).IsValid() || !every_edge_shared_by_two(solid)) {
            error = "The planes did not cut this solid into closed pieces";
            return false;
        }
        const double volume = volume_of(solid);
        if (!(volume > 1e-6)) {
            error = "The planes did not cut this solid into whole pieces";
            return false;
        }
        pieces.push_back({solid, volume});
    }
    if (pieces.size() < 2) {
        pieces.clear();
        const bool sketched = std::any_of(sides.begin(), sides.end(), [](const ChainSide& side) { return side.on; });
        error = sketched ? "The sketch profile does not cross the part. Draw it from one side of the section to the other."
                         : "The planes did not split this solid";
        return false;
    }
    if (pieces.size() > kMaxPartitionPieces) {
        pieces.clear();
        error = "A partition makes at most 24 pieces";
        return false;
    }
    return true;
}

namespace {

/// A label's frame on a flat face: the point it is centred on, U along the reading direction, V = N × U up the
/// letters, and N the face's outward normal, so the number reads from outside the piece.
struct LabelFrame {
    gp_Pnt origin;
    gp_Dir u;
    gp_Dir v;
    gp_Dir n;
};

gp_Pnt label_point(const LabelFrame& frame, double u, double v) {
    return frame.origin.Translated(gp_Vec(frame.u).Multiplied(u) + gp_Vec(frame.v).Multiplied(v));
}

/// A stroke's corners in the label's U, V, the label turned a quarter when `turned`.
std::array<gp_XY, 4> stroke_corners(const NumberStroke& stroke, double width, bool turned) {
    const double angle = stroke.angle_deg * (std::acos(-1.0) / 180.0);
    const gp_XY along(std::cos(angle) * stroke.length / 2, std::sin(angle) * stroke.length / 2);
    const gp_XY across(-std::sin(angle) * width / 2, std::cos(angle) * width / 2);
    const gp_XY centre(stroke.u, stroke.v);
    std::array<gp_XY, 4> corners = {centre - along - across, centre + along - across, centre + along + across, centre - along + across};
    if (turned) {
        for (gp_XY& corner : corners) {
            corner = gp_XY(-corner.Y(), corner.X());
        }
    }
    return corners;
}

/// Whether the rectangle `lo`..`hi` around the frame's origin lies inside `face`: its centre is on the face, its
/// outline keeps clear of every edge of the face, and no wire of the face (a hole's) lies inside it.
bool rectangle_inside(const TopoDS_Face& face, const LabelFrame& frame, const gp_XY& lo, const gp_XY& hi) {
    BRepClass_FaceClassifier classify(face, label_point(frame, (lo.X() + hi.X()) / 2, (lo.Y() + hi.Y()) / 2), 1e-7);
    if (classify.State() != TopAbs_IN) {
        return false;
    }
    BRepBuilderAPI_MakePolygon outline(
        label_point(frame, lo.X(), lo.Y()),
        label_point(frame, hi.X(), lo.Y()),
        label_point(frame, hi.X(), hi.Y()),
        label_point(frame, lo.X(), hi.Y()),
        Standard_True);
    if (!outline.IsDone()) {
        return false;
    }
    for (TopExp_Explorer wire(face, TopAbs_WIRE); wire.More(); wire.Next()) {
        BRepExtrema_DistShapeShape distance(outline.Wire(), wire.Current());
        if (!distance.IsDone() || distance.Value() < 1e-6) {
            return false;
        }
        TopExp_Explorer vertex(wire.Current(), TopAbs_VERTEX);
        if (vertex.More()) {
            const gp_Vec offset(frame.origin, BRep_Tool::Pnt(TopoDS::Vertex(vertex.Current())));
            const double u = offset.Dot(gp_Vec(frame.u));
            const double v = offset.Dot(gp_Vec(frame.v));
            if (u > lo.X() && u < hi.X() && v > lo.Y() && v < hi.Y()) {
                return false;
            }
        }
    }
    return true;
}

/// The flat face's outward normal, or false for a face that is not flat.
bool outward_normal(const TopoDS_Face& face, gp_Dir& normal, gp_Pln& plane) {
    BRepAdaptor_Surface surface(face);
    if (surface.GetType() != GeomAbs_Plane) {
        return false;
    }
    plane = surface.Plane();
    normal = plane.Axis().Direction();
    if (face.Orientation() == TopAbs_REVERSED) {
        normal.Reverse();
    }
    return true;
}

/// Finds a spot on `face` for the strokes, from its centre of area outward on a grid, reading along `hint` and then
/// turned a quarter. On success the stroke prisms join `tools`, cut `depth` into the solid.
bool place_number(
    const TopoDS_Face& face,
    const gp_Dir& hint,
    const std::vector<NumberStroke>& strokes,
    const PartitionNumbers& numbers,
    TopTools_ListOfShape& tools,
    NumberPlace& place) {
    gp_Dir normal;
    gp_Pln plane;
    if (!outward_normal(face, normal, plane)) {
        return false;
    }
    gp_Vec along = gp_Vec(hint) - gp_Vec(normal).Multiplied(gp_Vec(hint).Dot(gp_Vec(normal)));
    if (along.Magnitude() < 1e-6) {
        along = gp_Vec(plane.XAxis().Direction());
    }
    GProp_GProps area;
    BRepGProp::SurfaceProperties(face, area);
    LabelFrame frame{area.CentreOfMass(), gp_Dir(along), gp_Dir(gp_Vec(normal).Crossed(along)), normal};
    Bnd_Box box;
    BRepBndLib::Add(face, box, Standard_False);
    double x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
    box.Get(x0, y0, z0, x1, y1, z1);
    gp_XY face_lo(1e300, 1e300);
    gp_XY face_hi(-1e300, -1e300);
    for (int corner = 0; corner < 8; ++corner) {
        const gp_Vec offset(frame.origin, gp_Pnt(corner & 1 ? x1 : x0, corner & 2 ? y1 : y0, corner & 4 ? z1 : z0));
        const gp_XY at(offset.Dot(gp_Vec(frame.u)), offset.Dot(gp_Vec(frame.v)));
        face_lo.SetCoord(std::min(face_lo.X(), at.X()), std::min(face_lo.Y(), at.Y()));
        face_hi.SetCoord(std::max(face_hi.X(), at.X()), std::max(face_hi.Y(), at.Y()));
    }
    for (const bool turned : {false, true}) {
        gp_XY lo(1e300, 1e300);
        gp_XY hi(-1e300, -1e300);
        for (const NumberStroke& stroke : strokes) {
            for (const gp_XY& corner : stroke_corners(stroke, numbers.width, turned)) {
                lo.SetCoord(std::min(lo.X(), corner.X()), std::min(lo.Y(), corner.Y()));
                hi.SetCoord(std::max(hi.X(), corner.X()), std::max(hi.Y(), corner.Y()));
            }
        }
        lo -= gp_XY(numbers.inset, numbers.inset);
        hi += gp_XY(numbers.inset, numbers.inset);
        const gp_XY first(face_lo.X() - lo.X(), face_lo.Y() - lo.Y());
        const gp_XY last(face_hi.X() - hi.X(), face_hi.Y() - hi.Y());
        if (first.X() > last.X() || first.Y() > last.Y()) {
            continue;
        }
        constexpr int kSteps = 8;
        std::vector<gp_XY> spots = {gp_XY(0, 0)};
        for (int i = 0; i <= kSteps; ++i) {
            for (int j = 0; j <= kSteps; ++j) {
                spots.emplace_back(
                    first.X() + (last.X() - first.X()) * i / kSteps, first.Y() + (last.Y() - first.Y()) * j / kSteps);
            }
        }
        std::stable_sort(spots.begin(), spots.end(), [](const gp_XY& a, const gp_XY& b) {
            return a.SquareModulus() < b.SquareModulus();
        });
        for (const gp_XY& spot : spots) {
            if (!rectangle_inside(face, frame, lo + spot, hi + spot)) {
                continue;
            }
            constexpr double kLift = 0.05;
            for (const NumberStroke& stroke : strokes) {
                const std::array<gp_XY, 4> corners = stroke_corners(stroke, numbers.width, turned);
                BRepBuilderAPI_MakePolygon outline;
                for (const gp_XY& corner : corners) {
                    outline.Add(label_point(frame, corner.X() + spot.X(), corner.Y() + spot.Y())
                                    .Translated(gp_Vec(normal).Multiplied(kLift)));
                }
                outline.Close();
                BRepBuilderAPI_MakeFace base(outline.Wire(), Standard_True);
                if (!base.IsDone()) {
                    return false;
                }
                BRepPrimAPI_MakePrism prism(base.Face(), gp_Vec(normal).Multiplied(-(numbers.depth + kLift)));
                if (!prism.IsDone()) {
                    return false;
                }
                tools.Append(prism.Shape());
            }
            const gp_Pnt at = label_point(frame, spot.X(), spot.Y());
            place.at[0] = at.X();
            place.at[1] = at.Y();
            place.at[2] = at.Z();
            place.normal[0] = normal.X();
            place.normal[1] = normal.Y();
            place.normal[2] = normal.Z();
            return true;
        }
    }
    return false;
}

/// The faces of `shape` on the plane through `origin` square to `normal`, largest first.
std::vector<TopoDS_Face> faces_on_plane(const TopoDS_Shape& shape, const gp_Pnt& origin, const gp_Dir& normal) {
    std::vector<std::pair<double, TopoDS_Face>> found;
    for (TopExp_Explorer explorer(shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
        const TopoDS_Face& face = TopoDS::Face(explorer.Current());
        gp_Dir outward;
        gp_Pln plane;
        if (!outward_normal(face, outward, plane) || std::abs(gp_Vec(outward).Dot(gp_Vec(normal))) < 1.0 - 1e-9 ||
            std::abs(gp_Vec(origin, plane.Location()).Dot(gp_Vec(normal))) > 1e-6) {
            continue;
        }
        GProp_GProps area;
        BRepGProp::SurfaceProperties(face, area);
        found.emplace_back(area.Mass(), face);
    }
    std::stable_sort(found.begin(), found.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
    std::vector<TopoDS_Face> faces;
    for (const auto& [area, face] : found) {
        faces.push_back(face);
    }
    return faces;
}

}  // namespace

void engrave_numbers(
    std::vector<PartitionPiece>& pieces,
    const std::vector<std::array<double, 6>>& planes,
    const PartitionNumbers& numbers,
    std::vector<std::vector<NumberPlace>>& placed) {
    placed.assign(pieces.size(), {});
    if (planes.empty() || !(numbers.depth > 0.0) || !(numbers.width > 0.0)) {
        return;
    }
    std::vector<gp_Pnt> origins;
    std::vector<gp_Dir> normals;
    std::vector<gp_Dir> us;
    for (size_t index = 0; index < planes.size(); ++index) {
        const std::array<double, 6>& plane = planes[index];
        origins.emplace_back(plane[0], plane[1], plane[2]);
        normals.emplace_back(plane[3], plane[4], plane[5]);
        const std::array<double, 3> u = index < numbers.us.size() ? numbers.us[index] : std::array<double, 3>{0, 0, 0};
        const gp_Vec hint(u[0], u[1], u[2]);
        us.push_back(hint.Magnitude() > 1e-9 ? gp_Dir(hint) : gp_Pln(origins.back(), normals.back()).XAxis().Direction());
    }
    for (size_t index = 0; index < pieces.size(); ++index) {
        if (index >= numbers.digits.size() || numbers.digits[index].empty()) {
            continue;
        }
        const std::vector<NumberStroke>& strokes = numbers.digits[index];
        PartitionPiece& piece = pieces[index];
        TopTools_ListOfShape tools;
        std::vector<NumberPlace> here;
        for (size_t cut = 0; cut < planes.size(); ++cut) {
            for (const TopoDS_Face& face : faces_on_plane(piece.shape, origins[cut], normals[cut])) {
                NumberPlace place;
                place.cut = static_cast<int>(cut);
                if (place_number(face, us[cut], strokes, numbers, tools, place)) {
                    here.push_back(place);
                    break;
                }
            }
        }
        if (here.empty()) {
            std::vector<std::pair<double, TopoDS_Face>> sides;
            for (TopExp_Explorer explorer(piece.shape, TopAbs_FACE); explorer.More(); explorer.Next()) {
                const TopoDS_Face& face = TopoDS::Face(explorer.Current());
                gp_Dir outward;
                gp_Pln plane;
                if (!outward_normal(face, outward, plane)) {
                    continue;
                }
                bool on_cut = false;
                for (size_t cut = 0; cut < planes.size() && !on_cut; ++cut) {
                    on_cut = std::abs(gp_Vec(outward).Dot(gp_Vec(normals[cut]))) > 1.0 - 1e-9 &&
                             std::abs(gp_Vec(origins[cut], plane.Location()).Dot(gp_Vec(normals[cut]))) < 1e-6;
                }
                if (on_cut) {
                    continue;
                }
                GProp_GProps area;
                BRepGProp::SurfaceProperties(face, area);
                sides.emplace_back(area.Mass(), face);
            }
            std::stable_sort(sides.begin(), sides.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
            for (const auto& [area, face] : sides) {
                NumberPlace place;
                if (place_number(face, normals[0], strokes, numbers, tools, place)) {
                    here.push_back(place);
                    break;
                }
            }
        }
        if (here.empty()) {
            continue;
        }
        TopTools_ListOfShape arguments;
        arguments.Append(piece.shape);
        BRepAlgoAPI_Cut cut;
        cut.SetArguments(arguments);
        cut.SetTools(tools);
        cut.SetNonDestructive(Standard_True);
        cut.SetToFillHistory(Standard_False);
        g_stats.builds += 1;
        Handle(Message_ProgressIndicator) watch;
        cut.Build(deadline_range(watch));
        if (!cut.IsDone() || cut.HasErrors() || cut.Shape().IsNull()) {
            continue;
        }
        const TopoDS_Shape engraved = as_solid(cut.Shape());
        if (engraved.IsNull() || engraved.ShapeType() != TopAbs_SOLID || !BRepCheck_Analyzer(engraved).IsValid() ||
            !every_edge_shared_by_two(engraved)) {
            continue;
        }
        piece.shape = engraved;
        piece.volume = volume_of(engraved);
        placed[index] = here;
    }
}

namespace {

/// One closed, valid solid with every edge on two faces, or null.
TopoDS_Shape whole_solid(const TopoDS_Shape& shape) {
    if (shape.IsNull()) {
        return {};
    }
    const TopoDS_Shape solid = as_solid(shape);
    if (solid.IsNull() || solid.ShapeType() != TopAbs_SOLID || !BRepCheck_Analyzer(solid).IsValid() ||
        !every_edge_shared_by_two(solid)) {
        return {};
    }
    return solid;
}

/// `piece` less `tool`, or `piece` with `tool`, as one checked solid; null when either fails.
TopoDS_Shape joint_boolean(const TopoDS_Shape& piece, const TopoDS_Shape& tool, bool fuse) {
    TopTools_ListOfShape arguments;
    arguments.Append(piece);
    TopTools_ListOfShape tools;
    tools.Append(tool);
    g_stats.builds += 1;
    Handle(Message_ProgressIndicator) watch;
    if (fuse) {
        BRepAlgoAPI_Fuse op;
        op.SetArguments(arguments);
        op.SetTools(tools);
        op.SetNonDestructive(Standard_True);
        op.SetToFillHistory(Standard_False);
        op.Build(deadline_range(watch));
        return op.IsDone() && !op.HasErrors() ? whole_solid(op.Shape()) : TopoDS_Shape();
    }
    BRepAlgoAPI_Cut op;
    op.SetArguments(arguments);
    op.SetTools(tools);
    op.SetNonDestructive(Standard_True);
    op.SetToFillHistory(Standard_False);
    op.Build(deadline_range(watch));
    return op.IsDone() && !op.HasErrors() ? whole_solid(op.Shape()) : TopoDS_Shape();
}

/// A round bar of `radius` from `from` along `axis` for `length`, and, with `roof`, the 45° roof that makes it a
/// teardrop: a prism of the two tangents from the apex `radius × √2` along `roof`, fused onto the cylinder.
TopoDS_Shape hole_tool(const gp_Pnt& from, const gp_Dir& axis, double radius, double length, const gp_Dir* roof) {
    BRepPrimAPI_MakeCylinder cylinder(gp_Ax2(from, axis), radius, length);
    cylinder.Build();
    if (!cylinder.IsDone()) {
        return {};
    }
    if (roof == nullptr) {
        return cylinder.Shape();
    }
    const gp_Vec up(*roof);
    const gp_Vec across = gp_Vec(axis).Crossed(up);
    const double half = radius / std::sqrt(2.0);
    BRepBuilderAPI_MakePolygon outline(
        from,
        from.Translated(across.Multiplied(half) + up.Multiplied(half)),
        from.Translated(up.Multiplied(radius * std::sqrt(2.0))),
        from.Translated(across.Multiplied(-half) + up.Multiplied(half)),
        Standard_True);
    if (!outline.IsDone()) {
        return {};
    }
    BRepBuilderAPI_MakeFace base(outline.Wire(), Standard_True);
    if (!base.IsDone()) {
        return {};
    }
    BRepPrimAPI_MakePrism prism(base.Face(), gp_Vec(axis).Multiplied(length));
    if (!prism.IsDone()) {
        return {};
    }
    const TopoDS_Shape joined = joint_boolean(cylinder.Shape(), prism.Shape(), true);
    return joined;
}

/// A key: a prism whose cross-section, square to `slide`, is a trapezoid standing from `centre` toward `toward`, `root_half`
/// wide each side at the plane and widening by `slope` for each millimetre it goes, from `overlap` inside the piece that
/// carries it to `reach` past the plane; `slide_half` long each way along `slide`. A tongue (slope 0), a key, and a dovetail
/// (slope tan of its angle) are this one builder; the groove is the same grown.
TopoDS_Shape key_prism(
    const gp_Pnt& centre,
    const gp_Dir& toward,
    const gp_Dir& slide,
    double slide_half,
    double root_half,
    double slope,
    double reach,
    double overlap) {
    const gp_Dir cross(gp_Vec(toward).Crossed(gp_Vec(slide)));
    auto at = [&](double along, double across, double depth) {
        return centre.Translated(gp_Vec(slide).Multiplied(along) + gp_Vec(cross).Multiplied(across) + gp_Vec(toward).Multiplied(depth));
    };
    const double near_half = std::max(1e-6, root_half - slope * overlap);
    const double far_half = std::max(1e-6, root_half + slope * reach);
    BRepBuilderAPI_MakePolygon outline;
    outline.Add(at(-slide_half, -near_half, -overlap));
    outline.Add(at(-slide_half, near_half, -overlap));
    outline.Add(at(-slide_half, far_half, reach));
    outline.Add(at(-slide_half, -far_half, reach));
    outline.Close();
    if (!outline.IsDone()) {
        return {};
    }
    BRepBuilderAPI_MakeFace face(outline.Wire(), Standard_True);
    if (!face.IsDone()) {
        return {};
    }
    BRepPrimAPI_MakePrism prism(face.Face(), gp_Vec(slide).Multiplied(2 * slide_half));
    prism.Build();
    return prism.IsDone() ? prism.Shape() : TopoDS_Shape();
}

/// The box of cut `plane`'s section in its own U, V from its origin: every face of the pieces on that plane that faces
/// along its normal, the negative side's caps. False when no piece has one.
bool section_box(
    const std::vector<PartitionPiece>& pieces,
    const gp_Pnt& origin,
    const gp_Dir& normal,
    const gp_Dir& u,
    double& u0,
    double& v0,
    double& u1,
    double& v1) {
    gp_Trsf into;
    into.SetTransformation(gp_Ax3(origin, normal, u));
    Bnd_Box box;
    for (const PartitionPiece& piece : pieces) {
        for (const TopoDS_Face& face : faces_on_plane(piece.shape, origin, normal)) {
            gp_Dir outward;
            gp_Pln plane;
            if (!outward_normal(face, outward, plane) || gp_Vec(outward).Dot(gp_Vec(normal)) < 0.0) {
                continue;
            }
            BRepBuilderAPI_Transform moved(face, into, Standard_True);
            if (moved.IsDone()) {
                BRepBndLib::AddOptimal(moved.Shape(), box, Standard_False, Standard_False);
            }
        }
    }
    if (box.IsVoid()) {
        return false;
    }
    double z0 = 0;
    double z1 = 0;
    box.Get(u0, v0, z0, u1, v1, z1);
    return true;
}

/// The piece that holds `point` inside, or -1.
int piece_at(const std::vector<PartitionPiece>& pieces, const gp_Pnt& point) {
    for (size_t index = 0; index < pieces.size(); ++index) {
        BRepClass3d_SolidClassifier classify(pieces[index].shape, point, 1e-7);
        if (classify.State() == TopAbs_IN) {
            return static_cast<int>(index);
        }
    }
    return -1;
}

/// Whether `more` and `less` differ by exactly the tool's volume: the tool lies inside the piece, so the hole breaks
/// through nothing. Both are measured about the connector's centre, so the faces the tool left alone cancel; measured
/// each about its own vertices, a piece of many curved faces drifts by more than the tolerance.
bool took(const TopoDS_Shape& more, const TopoDS_Shape& less, double tool, const gp_Pnt& about) {
    const double before = volume_about(more, about);
    const double after = volume_about(less, about);
    return std::abs((before - after) - tool) <= 1e-6 * std::max(1.0, tool) + 1e-9 * std::abs(before);
}

}  // namespace

TopoDS_Shape make_pin(const gp_Pnt& base, const gp_Dir& axis, double radius, double length) {
    const double chamfer = std::min({kPinChamfer, radius / 2, length / 4});
    gp_Dir side = std::abs(axis.X()) < 0.9 ? gp_Dir(1, 0, 0) : gp_Dir(0, 1, 0);
    side = gp_Dir(gp_Vec(side) - gp_Vec(axis).Multiplied(gp_Vec(side).Dot(gp_Vec(axis))));
    const gp_Vec out(side);
    const gp_Vec along(axis);
    auto at = [&](double r, double h) { return base.Translated(out.Multiplied(r) + along.Multiplied(h)); };
    BRepBuilderAPI_MakePolygon outline;
    outline.Add(at(0, 0));
    outline.Add(at(radius - chamfer, 0));
    outline.Add(at(radius, chamfer));
    outline.Add(at(radius, length - chamfer));
    outline.Add(at(radius - chamfer, length));
    outline.Add(at(0, length));
    outline.Close();
    if (!outline.IsDone()) {
        return {};
    }
    BRepBuilderAPI_MakeFace face(outline.Wire(), Standard_True);
    if (!face.IsDone()) {
        return {};
    }
    BRepPrimAPI_MakeRevol revol(face.Face(), gp_Ax1(base, axis), 2 * std::acos(-1.0), Standard_True);
    revol.Build();
    if (!revol.IsDone()) {
        return {};
    }
    return whole_solid(revol.Shape());
}

void build_joints(
    std::vector<PartitionPiece>& pieces,
    const std::vector<std::array<double, 6>>& planes,
    const std::vector<std::array<double, 3>>& us,
    const std::vector<JointSpec>& joints,
    const gp_Dir& up,
    std::vector<JointResult>& results,
    TopoDS_Shape& pins) {
    results.assign(joints.size(), {});
    pins.Nullify();
    struct Frame {
        gp_Pnt origin;
        gp_Dir w, u, v;
        bool boxed = false;
        double u0 = 0, v0 = 0, u1 = 0, v1 = 0;
    };
    std::vector<Frame> frames;
    for (size_t index = 0; index < planes.size(); ++index) {
        const std::array<double, 6>& plane = planes[index];
        Frame frame;
        frame.origin = gp_Pnt(plane[0], plane[1], plane[2]);
        frame.w = gp_Dir(plane[3], plane[4], plane[5]);
        const std::array<double, 3> hint = index < us.size() ? us[index] : std::array<double, 3>{0, 0, 0};
        gp_Vec u = gp_Vec(hint[0], hint[1], hint[2]);
        u -= gp_Vec(frame.w).Multiplied(u.Dot(gp_Vec(frame.w)));
        frame.u = u.Magnitude() > 1e-9 ? gp_Dir(u) : gp_Pln(frame.origin, frame.w).XAxis().Direction();
        frame.v = gp_Dir(gp_Vec(frame.w).Crossed(gp_Vec(frame.u)));
        frames.push_back(frame);
    }
    struct Pin {
        double radius, length;
    };
    std::vector<Pin> made;
    const double tilt = std::cos(std::acos(-1.0) / 4);
    for (size_t index = 0; index < joints.size(); ++index) {
        const JointSpec& joint = joints[index];
        JointResult& result = results[index];
        result.status = kJointOutside;
        if (joint.cut < 0 || static_cast<size_t>(joint.cut) >= frames.size() || !(joint.radius > 0) || !(joint.depth > 0)) {
            continue;
        }
        Frame own;
        if (joint.flat) {
            // A flat of a shaped cut: its plane through (flat_u, flat_w) of the cut's U and W, its normal W turned toward U
            // by the tilt, its U along the flat, and V the cut's own.
            const Frame& cut = frames[static_cast<size_t>(joint.cut)];
            const double tilt = joint.flat_tilt * std::acos(-1.0) / 180.0;
            own.origin = cut.origin.Translated(gp_Vec(cut.u).Multiplied(joint.flat_u) + gp_Vec(cut.w).Multiplied(joint.flat_w));
            own.w = gp_Dir(gp_Vec(cut.w).Multiplied(std::cos(tilt)) + gp_Vec(cut.u).Multiplied(std::sin(tilt)));
            own.u = gp_Dir(gp_Vec(cut.u).Multiplied(std::cos(tilt)) - gp_Vec(cut.w).Multiplied(std::sin(tilt)));
            own.v = gp_Dir(gp_Vec(own.w).Crossed(gp_Vec(own.u)));
        }
        Frame& frame = joint.flat ? own : frames[static_cast<size_t>(joint.cut)];
        if (joint.fraction && !frame.boxed) {
            if (!section_box(pieces, frame.origin, frame.w, frame.u, frame.u0, frame.v0, frame.u1, frame.v1)) {
                continue;
            }
            frame.boxed = true;
        }
        const double a = joint.fraction ? frame.u0 + joint.a * (frame.u1 - frame.u0) : joint.a;
        const double b = joint.fraction ? frame.v0 + joint.b * (frame.v1 - frame.v0) : joint.b;
        const gp_Pnt centre = frame.origin.Translated(gp_Vec(frame.u).Multiplied(a) + gp_Vec(frame.v).Multiplied(b));
        result.at[0] = centre.X();
        result.at[1] = centre.Y();
        result.at[2] = centre.Z();
        const gp_Vec w(frame.w);
        const int below = piece_at(pieces, centre.Translated(w.Multiplied(-1e-3)));
        const int above = piece_at(pieces, centre.Translated(w.Multiplied(1e-3)));
        if (below < 0 || above < 0 || below == above) {
            continue;
        }
        result.status = kJointBreaks;
        gp_Vec roof = gp_Vec(up) - w.Multiplied(gp_Vec(up).Dot(w));
        const bool flat = std::abs(gp_Vec(up).Dot(w)) <= tilt + 1e-9 && roof.Magnitude() > 1e-9;
        const gp_Dir roof_dir = flat ? gp_Dir(roof) : gp_Dir(0, 0, 1);
        result.teardrop = joint.teardrop && flat;
        const gp_Dir* shaped = result.teardrop ? &roof_dir : nullptr;
        const double hole = joint.radius + joint.clearance;
        PartitionPiece& low = pieces[static_cast<size_t>(below)];
        PartitionPiece& high = pieces[static_cast<size_t>(above)];
        if (joint.type == kJointKey || joint.type == kJointDovetail) {
            // A key or a dovetail (plan section 8): a prism fused to the piece that carries it, its groove cut from the mate.
            const bool dovetail = joint.type == kJointDovetail;
            const gp_Dir slide = dovetail && joint.slide == 1 ? frame.v : frame.u;
            const double lean = std::tan(joint.angle * std::acos(-1.0) / 180.0);
            const double wide = joint.radius / 2;
            const double slope = dovetail ? lean : 0.0;
            const double root = dovetail ? wide - joint.depth * lean : joint.height / 2;
            if (!(root > 1e-6)) {
                continue;
            }
            // The groove grows by the clearance square to a flank, so by clearance / cos(angle) across the key.
            const double grow = dovetail ? joint.clearance / std::cos(std::atan(lean)) : joint.clearance;
            PartitionPiece& carrier = joint.side >= 0 ? high : low;
            PartitionPiece& mate = joint.side >= 0 ? low : high;
            const gp_Dir toward = joint.side >= 0 ? frame.w.Reversed() : frame.w;
            constexpr double kOverlap = 0.001;
            const TopoDS_Shape peg = key_prism(centre, toward, slide, wide, root, slope, joint.depth, kOverlap);
            const TopoDS_Shape groove = key_prism(centre, toward, slide, wide + joint.clearance, root + grow, slope, joint.depth + joint.end_gap, kOverlap);
            // What each takes is the prism past the plane: the part of it inside the carrier is not counted.
            const TopoDS_Shape peg_out = key_prism(centre, toward, slide, wide, root, slope, joint.depth, 0.0);
            const TopoDS_Shape groove_out = key_prism(centre, toward, slide, wide + joint.clearance, root + grow, slope, joint.depth + joint.end_gap, 0.0);
            if (peg.IsNull() || groove.IsNull() || peg_out.IsNull() || groove_out.IsNull()) {
                continue;
            }
            const TopoDS_Shape fused = joint_boolean(carrier.shape, peg, true);
            const TopoDS_Shape cut = joint_boolean(mate.shape, groove, false);
            if (fused.IsNull() || cut.IsNull() || !took(fused, carrier.shape, volume_of(peg_out), centre) ||
                !took(mate.shape, cut, volume_of(groove_out), centre)) {
                continue;
            }
            const double fused_volume = volume_of(fused);
            const double cut_volume = volume_of(cut);
            carrier.shape = fused;
            carrier.volume = fused_volume;
            mate.shape = cut;
            mate.volume = cut_volume;
            result.status = kJointPlaced;
            continue;
        }
        if (joint.type == kJointPlug) {
            PartitionPiece& carrier = joint.side >= 0 ? high : low;
            PartitionPiece& mate = joint.side >= 0 ? low : high;
            const gp_Dir into_mate = joint.side >= 0 ? frame.w.Reversed() : frame.w;
            const gp_Vec toward(into_mate);
            constexpr double kOverlap = 0.001;
            const TopoDS_Shape plug = hole_tool(centre.Translated(toward.Multiplied(-kOverlap)), into_mate, joint.radius, joint.depth + kOverlap, nullptr);
            const TopoDS_Shape socket = hole_tool(centre.Translated(toward.Multiplied(-kOverlap)), into_mate, hole, joint.depth + joint.end_gap + kOverlap, shaped);
            if (plug.IsNull() || socket.IsNull()) {
                continue;
            }
            const double pi = std::acos(-1.0);
            const double socket_volume = volume_of(socket) * (joint.depth + joint.end_gap) / (joint.depth + joint.end_gap + kOverlap);
            const TopoDS_Shape fused = joint_boolean(carrier.shape, plug, true);
            const TopoDS_Shape cut = joint_boolean(mate.shape, socket, false);
            if (fused.IsNull() || cut.IsNull()) {
                continue;
            }
            if (!took(fused, carrier.shape, pi * joint.radius * joint.radius * joint.depth, centre) ||
                !took(mate.shape, cut, socket_volume, centre)) {
                continue;
            }
            const double fused_volume = volume_of(fused);
            const double cut_volume = volume_of(cut);
            carrier.shape = fused;
            carrier.volume = fused_volume;
            mate.shape = cut;
            mate.volume = cut_volume;
        } else {
            const double reach = joint.depth / 2 + joint.end_gap;
            const TopoDS_Shape tool = hole_tool(centre.Translated(w.Multiplied(-reach)), frame.w, hole, 2 * reach, shaped);
            if (tool.IsNull()) {
                continue;
            }
            const double half = volume_of(tool) / 2;
            const TopoDS_Shape cut_low = joint_boolean(low.shape, tool, false);
            const TopoDS_Shape cut_high = joint_boolean(high.shape, tool, false);
            if (cut_low.IsNull() || cut_high.IsNull()) {
                continue;
            }
            if (!took(low.shape, cut_low, half, centre) || !took(high.shape, cut_high, half, centre)) {
                continue;
            }
            const double low_volume = volume_of(cut_low);
            const double high_volume = volume_of(cut_high);
            low.shape = cut_low;
            low.volume = low_volume;
            high.shape = cut_high;
            high.volume = high_volume;
            if (joint.type == kJointDowel) {
                made.push_back({joint.radius, joint.depth});
            }
        }
        result.status = kJointPlaced;
    }
    if (made.empty()) {
        return;
    }
    // The pins stand along `up` in a row beside the part, past its far side, on the floor it stands on.
    gp_Dir row = frames.empty() ? gp_Dir(1, 0, 0) : frames.front().u;
    gp_Vec flat = gp_Vec(row) - gp_Vec(up).Multiplied(gp_Vec(row).Dot(gp_Vec(up)));
    if (flat.Magnitude() < 1e-6) {
        flat = gp_Vec(gp_Pln(gp_Pnt(0, 0, 0), up).XAxis().Direction());
    }
    row = gp_Dir(flat);
    const gp_Dir away(gp_Vec(up).Crossed(gp_Vec(row)));
    gp_Trsf into;
    into.SetTransformation(gp_Ax3(gp_Pnt(0, 0, 0), up, row));
    Bnd_Box whole;
    for (const PartitionPiece& piece : pieces) {
        BRepBuilderAPI_Transform moved(piece.shape, into, Standard_True);
        if (moved.IsDone()) {
            BRepBndLib::AddOptimal(moved.Shape(), whole, Standard_False, Standard_False);
        }
    }
    double x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
    if (!whole.IsVoid()) {
        whole.Get(x0, y0, z0, x1, y1, z1);
    }
    constexpr double kPinGap = 3.0;
    const gp_Pnt start = gp_Pnt(0, 0, 0)
                             .Translated(gp_Vec(row).Multiplied(x0) + gp_Vec(away).Multiplied(y1 + kPinGap) +
                                         gp_Vec(up).Multiplied(z0));
    BRep_Builder builder;
    TopoDS_Compound all;
    builder.MakeCompound(all);
    double along = 0;
    int count = 0;
    TopoDS_Shape single;
    for (const Pin& pin : made) {
        along += pin.radius;
        const gp_Pnt base = start.Translated(gp_Vec(row).Multiplied(along) + gp_Vec(away).Multiplied(pin.radius));
        const TopoDS_Shape one = make_pin(base, up, pin.radius, pin.length);
        along += pin.radius + kPinGap;
        if (one.IsNull()) {
            continue;
        }
        builder.Add(all, one);
        single = one;
        count += 1;
    }
    if (count == 1) {
        pins = single;
    } else if (count > 1) {
        pins = all;
    }
}

bool build_tongues(
    std::vector<PartitionPiece>& pieces,
    const std::vector<std::array<double, 6>>& planes,
    const std::vector<PartitionProfile>& profiles,
    std::string& error) {
    constexpr double kOverlap = 0.001;
    for (size_t index = 0; index < profiles.size() && index < planes.size(); ++index) {
        const PartitionProfile& key = profiles[index];
        if (key.kind != 2 && key.kind != 4) {
            continue;
        }
        const bool dovetail = key.kind == 4;
        const std::string name = std::string(dovetail ? "The dovetail" : "The tongue") + " of cut " + std::to_string(index + 1);
        const std::array<double, 6>& plane = planes[index];
        const gp_Pnt origin(plane[0], plane[1], plane[2]);
        const gp_Dir normal(plane[3], plane[4], plane[5]);
        gp_Vec across(key.u[0], key.u[1], key.u[2]);
        across -= gp_Vec(normal).Multiplied(across.Dot(gp_Vec(normal)));
        if (!(across.Magnitude() > 1e-9) || !positive(key.a) || !positive(key.b) || !(key.g - key.f > kTinyMm)) {
            error = name + " needs a width, a depth, a length and the cut's U";
            return false;
        }
        const gp_Dir u(across);
        const gp_Dir v(gp_Vec(normal).Crossed(gp_Vec(u)));
        // A tongue runs along U; a dovetail slides along U or V, and its cross-section lies across the other.
        const bool along_v = dovetail && key.slide == 1;
        const gp_Dir slide = along_v ? v : u;
        const gp_Dir square = along_v ? u : v;
        const double lean = dovetail ? std::tan(key.angle * std::acos(-1.0) / 180.0) : 0.0;
        const double wide = key.a / 2;
        const double root = wide - key.b * lean;
        if (!(root > 1e-6)) {
            error = name + " has no neck at this depth and angle. Lower the angle or widen it.";
            return false;
        }
        const gp_Pnt middle = origin.Translated(gp_Vec(slide).Multiplied((key.f + key.g) / 2) + gp_Vec(square).Multiplied(key.h));
        const gp_Vec w(normal);
        const int below = piece_at(pieces, middle.Translated(w.Multiplied(-0.05)));
        const int above = piece_at(pieces, middle.Translated(w.Multiplied(0.05)));
        if (below < 0 || above < 0 || below == above) {
            error = name + " is outside the section, so it was not built";
            return false;
        }
        const bool positive_side = key.e >= 0.0;
        const int carries = positive_side ? above : below;
        const int takes = positive_side ? below : above;
        const gp_Dir toward = positive_side ? gp_Dir(w.Reversed()) : gp_Dir(w);
        const double half = (key.g - key.f) / 2;
        const double grow = dovetail ? key.c / std::cos(std::atan(lean)) : key.c;
        const TopoDS_Shape peg = key_prism(middle, toward, slide, half, root, lean, key.b, kOverlap);
        const TopoDS_Shape groove = key_prism(middle, toward, slide, half + key.c, root + grow, lean, key.b + key.d, kOverlap);
        if (peg.IsNull() || groove.IsNull()) {
            error = name + " did not build";
            return false;
        }
        const TopoDS_Shape fused = joint_boolean(pieces[carries].shape, peg, true);
        const TopoDS_Shape cut = joint_boolean(pieces[takes].shape, groove, false);
        if (fused.IsNull() || cut.IsNull()) {
            error = name + " did not fit the pieces. Make it narrower or shallower.";
            return false;
        }
        pieces[carries].shape = fused;
        pieces[carries].volume = volume_of(fused);
        pieces[takes].shape = cut;
        pieces[takes].volume = volume_of(cut);
    }
    return true;
}

bool build_fit_coupon(const FitCoupon& coupon, FitCouponResult& made, std::string& error) {
    made = FitCouponResult();
    if (!positive(coupon.size[0]) || !positive(coupon.size[1]) || !positive(coupon.size[2])) {
        error = "The coupon's plate needs a positive size on each side";
        return false;
    }
    if (coupon.holes.empty()) {
        error = "The coupon needs at least one hole";
        return false;
    }
    constexpr double kLead = 0.5;
    BRepPrimAPI_MakeBox box(gp_Pnt(0, 0, 0), coupon.size[0], coupon.size[1], coupon.size[2]);
    box.Build();
    TopoDS_Shape plate = box.IsDone() ? whole_solid(box.Shape()) : TopoDS_Shape();
    if (plate.IsNull()) {
        error = "Open CASCADE did not build the coupon's plate";
        return false;
    }
    const gp_Dir bore(0, 1, 0);
    const gp_Dir roof(0, 0, 1);
    for (size_t index = 0; index < coupon.holes.size(); ++index) {
        const CouponHole& hole = coupon.holes[index];
        const std::string name = "hole " + std::to_string(index + 1);
        if (!positive(hole.radius) || !positive(hole.depth)) {
            error = "The coupon's " + name + " needs a radius and a depth above 0";
            return false;
        }
        const double reach = hole.teardrop ? hole.radius * std::sqrt(2.0) : hole.radius;
        if (hole.x - hole.radius < 0 || hole.x + hole.radius > coupon.size[0] || hole.z - hole.radius < 0 ||
            hole.z + reach > coupon.size[2] || hole.depth >= coupon.size[1]) {
            error = "The coupon's " + name + " reaches outside the plate";
            return false;
        }
        const TopoDS_Shape tool = hole_tool(
            gp_Pnt(hole.x, -kLead, hole.z), bore, hole.radius, hole.depth + kLead, hole.teardrop ? &roof : nullptr);
        const TopoDS_Shape bored = tool.IsNull() ? TopoDS_Shape() : joint_boolean(plate, tool, false);
        if (bored.IsNull()) {
            error = "Open CASCADE did not bore the coupon's " + name;
            return false;
        }
        plate = bored;
    }
    const double bored_volume = volume_of(plate);
    if (!coupon.strokes.empty() && positive(coupon.stroke_width) && positive(coupon.engrave_depth)) {
        TopTools_ListOfShape tools;
        for (const NumberStroke& stroke : coupon.strokes) {
            BRepBuilderAPI_MakePolygon outline;
            for (const gp_XY& corner : stroke_corners(stroke, coupon.stroke_width, false)) {
                outline.Add(gp_Pnt(corner.X(), -kLead, corner.Y()));
            }
            outline.Close();
            BRepBuilderAPI_MakeFace base(outline.Wire(), Standard_True);
            if (!outline.IsDone() || !base.IsDone()) {
                error = "Open CASCADE did not draw the coupon's labels";
                return false;
            }
            BRepPrimAPI_MakePrism prism(base.Face(), gp_Vec(0, coupon.engrave_depth + kLead, 0));
            if (!prism.IsDone()) {
                error = "Open CASCADE did not draw the coupon's labels";
                return false;
            }
            tools.Append(prism.Shape());
        }
        TopTools_ListOfShape arguments;
        arguments.Append(plate);
        BRepAlgoAPI_Cut cut;
        cut.SetArguments(arguments);
        cut.SetTools(tools);
        cut.SetNonDestructive(Standard_True);
        cut.SetToFillHistory(Standard_False);
        g_stats.builds += 1;
        Handle(Message_ProgressIndicator) watch;
        cut.Build(deadline_range(watch));
        const TopoDS_Shape engraved = cut.IsDone() && !cut.HasErrors() ? whole_solid(cut.Shape()) : TopoDS_Shape();
        if (engraved.IsNull()) {
            error = "Open CASCADE did not engrave the coupon's labels";
            return false;
        }
        plate = engraved;
    }
    made.plate = plate;
    made.plate_volume = volume_of(plate);
    made.engraved = bored_volume - made.plate_volume;
    BRep_Builder builder;
    TopoDS_Compound all;
    builder.MakeCompound(all);
    int count = 0;
    TopoDS_Shape single;
    for (const CouponPin& pin : coupon.pins) {
        const TopoDS_Shape one = make_pin(gp_Pnt(pin.x, pin.y, 0), gp_Dir(0, 0, 1), pin.radius, pin.length);
        if (one.IsNull()) {
            error = "Open CASCADE did not build the coupon's pin";
            return false;
        }
        builder.Add(all, one);
        single = one;
        count += 1;
    }
    if (count > 0) {
        made.pins = count == 1 ? single : TopoDS_Shape(all);
        made.pins_volume = volume_of(made.pins);
    }
    return true;
}

TopoDS_Shape build_scale(const TopoDS_Shape& current, double factor, std::string& error) {
    if (!(factor > 0.0)) {
        error = "Scale needs a positive factor";
        return {};
    }
    if (std::abs(factor - 1.0) < 1e-9) {
        error = "Scale needs a factor other than 1";
        return {};
    }
    Bnd_Box bounds;
    BRepBndLib::Add(current, bounds, Standard_False);
    if (bounds.IsVoid()) {
        error = "This solid has no extent";
        return {};
    }
    double xmin = 0;
    double ymin = 0;
    double zmin = 0;
    double xmax = 0;
    double ymax = 0;
    double zmax = 0;
    bounds.Get(xmin, ymin, zmin, xmax, ymax, zmax);
    gp_Trsf trsf;
    trsf.SetScale(gp_Pnt((xmin + xmax) * 0.5, (ymin + ymax) * 0.5, (zmin + zmax) * 0.5), factor);
    BRepBuilderAPI_Transform builder(current, trsf, Standard_True, Standard_False);
    builder.Build();
    if (!builder.IsDone() || builder.Shape().IsNull()) {
        error = "Open CASCADE did not scale this solid";
        return {};
    }
    return builder.Shape();
}

int count_of(const TopoDS_Shape& shape, TopAbs_ShapeEnum kind) {
    TopTools_IndexedMapOfShape found;
    TopExp::MapShapes(shape, kind, found);
    return found.Extent();
}

/// A profile's plane: its origin and its U, V, W, turned as a primitive and a workplane turn.
struct ProfileFrame {
    gp_Pnt origin;
    gp_Dir u;
    gp_Dir v;
    gp_Dir w;

    gp_Pnt at(double pu, double pv, double pw = 0.0) const {
        return origin.Translated(gp_Vec(u) * pu + gp_Vec(v) * pv + gp_Vec(w) * pw);
    }
};

ProfileFrame frame_of(const ProfileSpec& spec) {
    const double rad = kPi / 180.0;
    gp_Trsf tx;
    gp_Trsf ty;
    gp_Trsf tz;
    tx.SetRotation(gp::OX(), spec.turn[0] * rad);
    ty.SetRotation(gp::OY(), spec.turn[1] * rad);
    tz.SetRotation(gp::OZ(), spec.turn[2] * rad);
    gp_Trsf total = tz;
    total.Multiply(ty);
    total.Multiply(tx);
    ProfileFrame frame;
    frame.origin = gp_Pnt(spec.origin[0], spec.origin[1], spec.origin[2]);
    frame.u = gp::DX().Transformed(total);
    frame.v = gp::DY().Transformed(total);
    frame.w = gp::DZ().Transformed(total);
    return frame;
}

/// Below this two profile points are one, in millimetres.
constexpr double kProfileMm = 1e-6;

/// The most loops one profile takes: outlines and holes together, a lattice of cells in one extrude.
constexpr size_t kMaxLoops = 1000;

double cross2(double ax, double ay, double bx, double by) { return ax * by - ay * bx; }

/// Whether the closed segments ab and cd share a point.
bool segments_meet(const double* a, const double* b, const double* c, const double* d) {
    const double d1 = cross2(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]);
    const double d2 = cross2(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1]);
    const double d3 = cross2(d[0] - c[0], d[1] - c[1], a[0] - c[0], a[1] - c[1]);
    const double d4 = cross2(d[0] - c[0], d[1] - c[1], b[0] - c[0], b[1] - c[1]);
    const double scale = std::max({std::abs(b[0] - a[0]), std::abs(b[1] - a[1]), std::abs(d[0] - c[0]), std::abs(d[1] - c[1]), 1.0});
    const double eps = kProfileMm * scale;
    if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) {
        return true;
    }
    // A point on the other segment, collinear within the tolerance.
    auto on = [eps](const double* p, const double* q, const double* r, double side) {
        if (std::abs(side) > eps) {
            return false;
        }
        return std::min(p[0], q[0]) - eps <= r[0] && r[0] <= std::max(p[0], q[0]) + eps &&
               std::min(p[1], q[1]) - eps <= r[1] && r[1] <= std::max(p[1], q[1]) + eps;
    };
    return on(a, b, c, d1) || on(a, b, d, d2) || on(c, d, a, d3) || on(c, d, b, d4);
}

/// The profile's points, counter-clockwise about W, a repeated closing point dropped. Empty, with `error`, when the
/// profile is not a simple closed outline.
std::vector<double> profile_points(const ProfileSpec& spec, std::string& error, bool* reversed = nullptr) {
    if (reversed != nullptr) {
        *reversed = false;
    }
    std::vector<double> p = spec.points;
    for (double value : p) {
        if (!std::isfinite(value)) {
            error = "A profile point is not a number.";
            return {};
        }
    }
    if (p.size() % 2 != 0) {
        error = "A profile point needs both its u and v.";
        return {};
    }
    auto same = [&p](size_t i, size_t j) {
        return std::abs(p[2 * i] - p[2 * j]) <= kProfileMm && std::abs(p[2 * i + 1] - p[2 * j + 1]) <= kProfileMm;
    };
    if (p.size() >= 8 && same(0, p.size() / 2 - 1)) {
        p.resize(p.size() - 2);
    }
    const size_t n = p.size() / 2;
    if (n < 3) {
        error = "A profile needs at least 3 points.";
        return {};
    }
    for (size_t i = 0; i < n; ++i) {
        if (same(i, (i + 1) % n)) {
            error = "Two profile points in a row are in the same place.";
            return {};
        }
    }
    for (size_t i = 0; i < n; ++i) {
        for (size_t j = i + 1; j < n; ++j) {
            // Neighbours share a corner, which is no crossing.
            if (j == i + 1 || (i == 0 && j == n - 1)) {
                continue;
            }
            if (segments_meet(&p[2 * i], &p[2 * ((i + 1) % n)], &p[2 * j], &p[2 * ((j + 1) % n)])) {
                error = "The profile crosses itself.";
                return {};
            }
        }
    }
    double area = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const size_t j = (i + 1) % n;
        area += cross2(p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]);
    }
    if (!(std::abs(area) * 0.5 > 1e-6)) {
        error = "The profile has no area.";
        return {};
    }
    if (area < 0.0) {
        std::vector<double> turned;
        turned.reserve(p.size());
        for (size_t i = n; i-- > 0;) {
            turned.push_back(p[2 * i]);
            turned.push_back(p[2 * i + 1]);
        }
        p = std::move(turned);
        if (reversed != nullptr) {
            *reversed = true;
        }
    }
    return p;
}

/// The corners of `spec` as indexes into its points as `profile_points` returned them, sorted, each once.
std::vector<int> profile_corners(const ProfileSpec& spec, size_t n, bool reversed, std::string& error) {
    std::vector<int> out;
    for (int corner : spec.corners) {
        if (corner < 0 || static_cast<size_t>(corner) >= n) {
            error = "A corner is not the index of a profile point.";
            return {};
        }
        out.push_back(reversed ? static_cast<int>(n) - 1 - corner : corner);
    }
    std::sort(out.begin(), out.end());
    out.erase(std::unique(out.begin(), out.end()), out.end());
    return out;
}

/// A spline edge through `pts` in order, closed into a loop with `periodic`.
TopoDS_Edge spline_edge(const std::vector<gp_Pnt>& pts, bool periodic, std::string& error) {
    Handle(TColgp_HArray1OfPnt) array = new TColgp_HArray1OfPnt(1, static_cast<int>(pts.size()));
    for (size_t i = 0; i < pts.size(); ++i) {
        array->SetValue(static_cast<int>(i) + 1, pts[i]);
    }
    GeomAPI_Interpolate interpolate(array, periodic ? Standard_True : Standard_False, 1e-7);
    interpolate.Perform();
    if (!interpolate.IsDone()) {
        error = "Open CASCADE did not draw a smooth curve through these profile points.";
        return {};
    }
    BRepBuilderAPI_MakeEdge edge(interpolate.Curve());
    if (!edge.IsDone()) {
        error = "Open CASCADE did not draw a smooth curve through these profile points.";
        return {};
    }
    return edge.Edge();
}

/// The closed outline through `p` (u, v pairs, counter-clockwise), `lift` along W: straight edges, or with `smooth`
/// splines broken at `corners`.
TopoDS_Wire profile_wire(const ProfileFrame& frame, const std::vector<double>& p, bool smooth, const std::vector<int>& corners, double lift, std::string& error) {
    const size_t n = p.size() / 2;
    std::vector<gp_Pnt> pts;
    pts.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        pts.push_back(frame.at(p[2 * i], p[2 * i + 1], lift));
    }
    if (!smooth) {
        BRepBuilderAPI_MakePolygon outline;
        for (const gp_Pnt& pt : pts) {
            outline.Add(pt);
        }
        outline.Close();
        if (!outline.IsDone()) {
            error = "Open CASCADE did not build the profile";
            return {};
        }
        return outline.Wire();
    }
    BRepBuilderAPI_MakeWire wire;
    if (corners.empty()) {
        const TopoDS_Edge loop = spline_edge(pts, true, error);
        if (loop.IsNull()) {
            return {};
        }
        wire.Add(loop);
    } else {
        // Each run goes from one corner to the next, round the loop: a straight edge between neighbours, else a spline.
        for (size_t k = 0; k < corners.size(); ++k) {
            const size_t from = static_cast<size_t>(corners[k]);
            const size_t to = static_cast<size_t>(corners[(k + 1) % corners.size()]);
            std::vector<gp_Pnt> run;
            size_t i = from;
            run.push_back(pts[i]);
            do {
                i = (i + 1) % n;
                run.push_back(pts[i]);
            } while (i != to);
            TopoDS_Edge edge;
            if (run.size() == 2) {
                BRepBuilderAPI_MakeEdge straight(run[0], run[1]);
                if (straight.IsDone()) {
                    edge = straight.Edge();
                }
            } else {
                edge = spline_edge(run, false, error);
            }
            if (edge.IsNull()) {
                if (error.empty()) {
                    error = "Open CASCADE did not build the profile";
                }
                return {};
            }
            wire.Add(edge);
        }
    }
    if (!wire.IsDone()) {
        error = "Open CASCADE did not join the profile's curves into one outline.";
        return {};
    }
    return wire.Wire();
}

/// The profile's points and its outline, checked: the points counter-clockwise, the corners mapped to match.
TopoDS_Wire checked_wire(const ProfileFrame& frame, const ProfileSpec& spec, double lift, std::vector<double>& points, std::string& error) {
    bool reversed = false;
    points = profile_points(spec, error, &reversed);
    if (points.empty()) {
        return {};
    }
    const std::vector<int> corners = profile_corners(spec, points.size() / 2, reversed, error);
    if (!error.empty()) {
        return {};
    }
    // A closed run with one corner is one spline from that corner round to itself.
    return profile_wire(frame, points, spec.smooth, corners, lift, error);
}

/// The profile as a planar face whose normal is W, `lift` along W from the plane.
TopoDS_Face profile_face(const ProfileFrame& frame, const ProfileSpec& spec, double lift, std::string& error) {
    std::vector<double> points;
    const TopoDS_Wire outline = checked_wire(frame, spec, lift, points, error);
    if (outline.IsNull()) {
        return {};
    }
    const gp_Pln plane(gp_Ax3(frame.at(0.0, 0.0, lift), frame.w, frame.u));
    BRepBuilderAPI_MakeFace face(plane, outline, Standard_True);
    if (!face.IsDone()) {
        error = "Open CASCADE did not build the profile";
        return {};
    }
    return face.Face();
}

/// A swept tool combined with `current`. Beyond `combine`'s refusals, an extrude or revolve that changes nothing, or
/// a fuse that leaves a body apart from the part, is refused, since the step would do nothing the user meant.
/// A null `current` is a feature root (K2): the tool is the solid, after the same kind and volume checks.
TopoDS_Shape combine_profile(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const TopoDS_Shape& tool,
    const char* noun,
    double& volume,
    std::string& error) {
    // --- K2 feature root. No solid under the tool: the tool is the new solid. ---
    if (current.IsNull()) {
        if (which != "fuse" && which != "cut" && which != "common") {
            error = "The boolean is fuse, cut, or common";
            return {};
        }
        if (which != "fuse") {
            error = std::string("A new solid is the ") + noun + " itself. Cut and intersect need a part that is already there.";
            return {};
        }
        TopoDS_Shape solid = tool;
        volume = volume_of(solid);
        if (volume < 0.0) {
            solid.Reverse();
            volume = -volume;
        }
        if (!(volume > 1e-6)) {
            error = std::string("The ") + noun + " has no volume.";
            return {};
        }
        return solid;
    }
    if (which != "fuse" && which != "cut" && which != "common") {
        error = "The boolean is fuse, cut, or common";
        return {};
    }
    const int bodies = count_of(current, TopAbs_SOLID);
    TopoDS_Shape result = combine(current, which, tool, volume, error);
    if (!error.empty()) {
        return {};
    }
    if (which != "common" && std::abs(volume - before) <= 1e-6 * std::max(1.0, before)) {
        error = std::string("The ") + noun + " does not change the part.";
        return {};
    }
    if (which == "fuse" && count_of(result, TopAbs_SOLID) > bodies) {
        error = "This would add a separate body; place it touching the part.";
        try {
            BRepExtrema_DistShapeShape gap(current, tool);
            if (gap.IsDone() && gap.NbSolution() > 0 && gap.Value() < 0.005) {
                error = "This would add a body that only touches the part, at a face, an edge, or a point. Push it further in so the two overlap.";
            } else if (gap.IsDone() && gap.NbSolution() > 0) {
                std::ostringstream text;
                text.imbue(std::locale::classic());
                text.setf(std::ios::fixed);
                text.precision(2);
                text << "This would add a separate body " << gap.Value() << " mm from the part. Move it that far toward the part, plus a little overlap.";
                error = text.str();
            }
        } catch (const Standard_Failure&) {
        }
        return {};
    }
    return result;
}

/// `combine_profile` for several tools at once: one boolean of every tool, checked as one tool is. With no solid under
/// them, the tools fused together are the new solid.
TopoDS_Shape combine_profile_tools(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const std::vector<TopoDS_Shape>& tools,
    const char* noun,
    double& volume,
    std::string& error) {
    if (tools.empty()) {
        error = std::string("The ") + noun + " has no volume.";
        return {};
    }
    if (tools.size() == 1) {
        return combine_profile(current, before, which, tools.front(), noun, volume, error);
    }
    if (current.IsNull()) {
        TopTools_ListOfShape rest;
        for (size_t i = 1; i < tools.size(); ++i) {
            rest.Append(tools[i]);
        }
        const TopoDS_Shape fused = which == "fuse" ? boolean_list("fuse", tools.front(), rest, error) : TopoDS_Shape();
        if (which == "fuse" && fused.IsNull()) {
            if (error.empty()) {
                error = "Open CASCADE did not complete the boolean";
            }
            return {};
        }
        return combine_profile(current, before, which, fused.IsNull() ? tools.front() : fused, noun, volume, error);
    }
    if (which != "fuse" && which != "cut" && which != "common") {
        error = "The boolean is fuse, cut, or common";
        return {};
    }
    const int bodies = count_of(current, TopAbs_SOLID);
    TopTools_ListOfShape list;
    for (const TopoDS_Shape& tool : tools) {
        list.Append(tool);
    }
    const TopoDS_Shape result = boolean_list(which, current, list, error);
    if (!error.empty()) {
        return {};
    }
    if (!accepted_result(result, volume, error)) {
        if (which == "common") {
            error = "The solids do not overlap";
        }
        return {};
    }
    if (which != "common" && std::abs(volume - before) <= 1e-6 * std::max(1.0, before)) {
        error = std::string("The ") + noun + " does not change the part.";
        return {};
    }
    if (which == "fuse" && count_of(result, TopAbs_SOLID) > bodies) {
        error = "This would add a separate body; place it touching the part.";
        return {};
    }
    return result;
}

TopoDS_Shape combine_tools_checked(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const std::vector<TopoDS_Shape>& tools,
    bool merge,
    double& volume,
    std::string& error,
    std::vector<int>& missed) {
    missed.assign(tools.size(), 0);
    if (tools.empty() || current.IsNull()) {
        error = "A queued boolean needs a solid and at least one tool.";
        return {};
    }
    if (which != "fuse" && which != "cut") {
        error = "A queued boolean is a fuse or a cut";
        return {};
    }
    const int bodies = count_of(current, TopAbs_SOLID);
    TopTools_ListOfShape list;
    for (const TopoDS_Shape& tool : tools) {
        list.Append(tool);
    }
    Handle(BRepTools_History) history;
    TopoDS_Shape result = boolean_list(which, current, list, error, &history);
    if (!error.empty()) {
        return {};
    }
    if (!accepted_result(result, volume, error)) {
        return {};
    }
    if (std::abs(volume - before) <= 1e-6 * std::max(1.0, before)) {
        error = std::string("The ") + which + " does not change the part.";
        return {};
    }
    if (which == "fuse" && count_of(result, TopAbs_SOLID) > bodies) {
        error = "This would add a separate body; place it touching the part.";
        return {};
    }
    // Plain booleans merge the faces left on one surface after each step; after the group, once, as they would have.
    if (merge) {
        result = merge_same_domain(result, &history);
    }
    // A tool that met the solid leaves at least one of its faces, whole or split, in the result: a cut's inside the
    // part as the hole's walls, a fuse's outside it. A tool whose every face is gone changed nothing, and alone it
    // would have been refused.
    if (!history.IsNull()) {
        for (size_t i = 0; i < tools.size(); ++i) {
            bool left = false;
            for (TopExp_Explorer face(tools[i], TopAbs_FACE); face.More() && !left; face.Next()) {
                left = !history->IsRemoved(face.Current());
            }
            missed[i] = left ? 0 : 1;
        }
    }
    return result;
}

TopoDS_Wire section_wire(const LoftSection& section, std::string& error) {
    const ProfileFrame frame = frame_of(section.profile);
    if (section.radius > 0.0) {
        const double a = section.radius;
        const double b = section.radius_v > 0.0 ? section.radius_v : section.radius;
        if (!std::isfinite(a) || !std::isfinite(b) || a > 1e5 || b > 1e5) {
            error = "A loft section's radius is out of range.";
            return {};
        }
        TopoDS_Edge edge;
        if (std::abs(a - b) <= kTinyMm) {
            edge = BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(frame.origin, frame.w, frame.u), a)).Edge();
        } else if (a > b) {
            edge = BRepBuilderAPI_MakeEdge(gp_Elips(gp_Ax2(frame.origin, frame.w, frame.u), a, b)).Edge();
        } else {
            // An ellipse's major axis is its X: along V here, the seam still starting on U's side is not needed.
            edge = BRepBuilderAPI_MakeEdge(gp_Elips(gp_Ax2(frame.origin, frame.w, frame.v), b, a)).Edge();
        }
        BRepBuilderAPI_MakeWire wire(edge);
        if (!wire.IsDone()) {
            error = "Open CASCADE did not build a loft section";
            return {};
        }
        return wire.Wire();
    }
    std::vector<double> points;
    return checked_wire(frame, section.profile, 0.0, points, error);
}

TopoDS_Shape build_loft(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const std::vector<LoftSection>& sections,
    bool ruled,
    double& volume,
    std::string& error) {
    if (sections.size() < 2) {
        error = "A loft needs at least 2 sections.";
        return {};
    }
    if (sections.size() > 200) {
        error = "A loft takes at most 200 sections.";
        return {};
    }
    BRepOffsetAPI_ThruSections loft(Standard_True, ruled ? Standard_True : Standard_False, 1e-6);
    loft.CheckCompatibility(Standard_True);
    for (size_t i = 0; i < sections.size(); ++i) {
        const TopoDS_Wire wire = section_wire(sections[i], error);
        if (wire.IsNull()) {
            error = "Section " + std::to_string(i) + ": " + (error.empty() ? std::string("it could not be built.") : error);
            return {};
        }
        loft.AddWire(wire);
    }
    TopoDS_Shape tool;
    try {
        loft.Build();
        if (!loft.IsDone() || loft.Shape().IsNull()) {
            error = "Open CASCADE could not loft through these sections. Check that each one is a simple outline and that they do not cross.";
            return {};
        }
        tool = loft.Shape();
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not loft through these sections. Check that each one is a simple outline and that they do not cross.";
        return {};
    }
    if (!has_solid(tool)) {
        error = "The loft did not close into a solid.";
        return {};
    }
    tool = as_solid(tool);
    GProp_GProps props;
    integrate(tool, props);
    if (std::abs(props.Mass()) <= 1e-6) {
        error = "The loft has no volume: its sections lie in one plane. Turn them so each section's plane crosses the way between them (W along the path).";
        return {};
    }
    if (props.Mass() < 0.0) {
        tool.Reverse();
    }
    if (!BRepCheck_Analyzer(tool).IsValid()) {
        ShapeFix_Solid fix;
        fix.Init(TopoDS::Solid(tool));
        fix.Perform();
        tool = fix.Solid();
        if (!BRepCheck_Analyzer(tool).IsValid()) {
            error = "The loft twists through itself. Space the sections further apart, or make tight bends gentler.";
            return {};
        }
    }
    return combine_profile(current, before, which, tool, "loft", volume, error);
}

namespace {

struct BoxRow {
    double lo[3];
    double hi[3];
};

bool box_row(const TopoDS_Shape& shape, BoxRow& out) {
    // The tight box: a spline surface's quick box spans its control points, well past the surface.
    Bnd_Box box;
    BRepBndLib::AddOptimal(shape, box, Standard_False, Standard_False);
    if (box.IsVoid()) {
        return false;
    }
    box.Get(out.lo[0], out.lo[1], out.lo[2], out.hi[0], out.hi[1], out.hi[2]);
    return true;
}

bool same_box(const BoxRow& a, const BoxRow& b) {
    for (int i = 0; i < 3; ++i) {
        if (std::abs(a.lo[i] - b.lo[i]) > 1e-3 || std::abs(a.hi[i] - b.hi[i]) > 1e-3) {
            return false;
        }
    }
    return true;
}

/// Every shell inside a solid that is not its outer skin: a sealed hollow.
std::vector<BoxRow> void_boxes(const TopoDS_Shape& shape) {
    std::vector<BoxRow> out;
    for (TopExp_Explorer solids(shape, TopAbs_SOLID); solids.More(); solids.Next()) {
        const TopoDS_Solid& solid = TopoDS::Solid(solids.Current());
        const TopoDS_Shell outer = BRepClass3d::OuterShell(solid);
        for (TopExp_Explorer shells(solid, TopAbs_SHELL); shells.More(); shells.Next()) {
            if (!outer.IsNull() && shells.Current().IsSame(outer)) {
                continue;
            }
            BoxRow row;
            if (box_row(shells.Current(), row)) {
                out.push_back(row);
            }
        }
    }
    return out;
}

void box_json(std::ostringstream& out, const BoxRow& row) {
    out << "\"min\":[" << row.lo[0] << "," << row.lo[1] << "," << row.lo[2] << "],\"max\":[" << row.hi[0] << "," << row.hi[1] << ","
        << row.hi[2] << "]";
}

}  // namespace

std::string piece_report(const TopoDS_Shape& from, const TopoDS_Shape& built) {
    try {
        std::ostringstream out;
        out.imbue(std::locale::classic());
        out.precision(9);
        const std::vector<BoxRow> had = void_boxes(from);
        std::vector<BoxRow> voids;
        for (const BoxRow& row : void_boxes(built)) {
            if (std::none_of(had.begin(), had.end(), [&row](const BoxRow& old) { return same_box(old, row); })) {
                voids.push_back(row);
            }
        }
        std::vector<std::pair<double, TopoDS_Shape>> solids;
        for (TopExp_Explorer it(built, TopAbs_SOLID); it.More(); it.Next()) {
            solids.emplace_back(volume_of(it.Current()), it.Current());
        }
        std::sort(solids.begin(), solids.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
        const bool loose = static_cast<int>(solids.size()) > count_of(from, TopAbs_SOLID);
        bool first = true;
        if (!voids.empty()) {
            out << "\"voids\":[";
            for (size_t i = 0; i < voids.size() && i < 8; ++i) {
                out << (i ? ",{" : "{");
                box_json(out, voids[i]);
                out << "}";
            }
            out << "]";
            first = false;
        }
        if (loose && solids.size() > 1) {
            out << (first ? "" : ",") << "\"pieces\":[";
            for (size_t i = 1; i < solids.size() && i < 9; ++i) {
                BoxRow row;
                if (!box_row(solids[i].second, row)) {
                    continue;
                }
                double gap = -1.0;
                BRepExtrema_DistShapeShape distance(solids[0].second, solids[i].second);
                if (distance.IsDone() && distance.NbSolution() > 0) {
                    gap = distance.Value();
                }
                out << (i > 1 ? ",{" : "{");
                box_json(out, row);
                out << ",\"volumeMm3\":" << solids[i].first << ",\"gapMm\":" << gap << "}";
            }
            out << "]";
        }
        return out.str();
    } catch (const Standard_Failure&) {
        return {};
    }
}

TopoDS_Shape build_extrude(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileSpec& profile,
    double depth,
    bool symmetric,
    double& volume,
    std::string& error) {
    const std::vector<double> points = profile_points(profile, error);
    if (points.empty()) {
        return {};
    }
    if (!std::isfinite(depth) || !(std::abs(depth) > kTinyMm)) {
        error = "An extrude needs a depth other than 0.";
        return {};
    }
    const ProfileFrame frame = frame_of(profile);
    const double length = std::abs(depth);
    // Always swept along +W from its lower end, so the solid comes out the right way round.
    const double start = symmetric ? -length / 2.0 : std::min(depth, 0.0);
    const TopoDS_Face face = profile_face(frame, profile, start, error);
    if (face.IsNull()) {
        return {};
    }
    BRepPrimAPI_MakePrism prism(face, gp_Vec(frame.w) * length);
    const TopoDS_Shape tool = built(prism, "extrude", error);
    if (tool.IsNull()) {
        return {};
    }
    return combine_profile(current, before, which, tool, "extrude", volume, error);
}

// --- K3: two-sided depth, draft, and up to a face. `build_extrude` above is the plain prism and is not used
// when one of these is set. A request with none of them never enters this block. ---

namespace {

/// One solid, turned so its volume is positive. `fail` is the sentence when it is not one solid with volume.
TopoDS_Shape k3_solid(TopoDS_Shape shape, std::string& error, const char* fail) {
    if (!shape.IsNull()) {
        shape = as_solid(shape);
    }
    if (shape.IsNull() || !has_solid(shape) || count_of(shape, TopAbs_SOLID) != 1) {
        error = fail;
        return {};
    }
    const double mass = volume_of(shape);
    if (!(std::abs(mass) > 1e-6)) {
        error = fail;
        return {};
    }
    if (mass < 0.0) {
        shape.Reverse();
    }
    return shape;
}

/// The prism `BRepFeat_MakeDPrism::Perform(Height)` builds before it fuses: the height is divided by cos(angle),
/// and `LocOpe_DPrism` then puts the far end `Height` along the normal, inset by `Height * tan(angle)`.
/// Perform's own fuse is not used. It can rewrite the solid it was given, and this extrude still has to fuse, cut,
/// or intersect with the same checks as a plain one.
TopoDS_Shape k3_draft_prism(const TopoDS_Face& face, double height, double angle, std::string& error) {
    if (!(height > kTinyMm) || !std::isfinite(height) || !(std::cos(angle) > 1e-6)) {
        error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
        return {};
    }
    try {
        const double along = height / std::cos(angle);
        LocOpe_DPrism prism(face, along, angle);
        if (!prism.IsDone()) {
            error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
            return {};
        }
        return k3_solid(prism.Shape(), error, "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.");
    } catch (const Standard_Failure&) {
        error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
        return {};
    }
}

/// The same prism to both sides of the profile. `BRepFeat_MakeDPrism` has no two-height Perform; its two-sided
/// form (`Perform` from a face to a face) builds this `LocOpe_DPrism`. A positive angle shrinks the +W end and
/// grows the −W end, so the wall is one plane at that angle to W.
TopoDS_Shape k3_draft_both(const TopoDS_Face& face, double hi, double lo, double angle, std::string& error) {
    const double along_hi = hi / std::cos(angle);
    const double along_lo = (-lo) / std::cos(angle);
    if (!(along_hi >= 0.0) || !(along_lo >= 0.0) || !std::isfinite(along_hi) || !std::isfinite(along_lo)) {
        error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
        return {};
    }
    try {
        LocOpe_DPrism prism(face, along_hi, along_lo, angle);
        if (!prism.IsDone()) {
            error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
            return {};
        }
        return k3_solid(prism.Shape(), error, "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.");
    } catch (const Standard_Failure&) {
        error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
        return {};
    }
}

/// The plane of `face`, unbounded. `Perform` trims against an infinite plane; a finite face is glued instead,
/// and that glue only works when the profile is already a face of the solid.
TopoDS_Face k3_stop_plane(const TopoDS_Face& face, std::string& error) {
    const char* miss = "The extrude does not reach that face. Move the profile so its direction meets the face.";
    try {
        BRepAdaptor_Surface surface(face);
        if (surface.GetType() != GeomAbs_Plane) {
            error = "An extrude can stop on a flat face. This face is not flat.";
            return {};
        }
        BRepBuilderAPI_MakeFace made(surface.Plane());
        if (!made.IsDone()) {
            error = miss;
            return {};
        }
        TopoDS_Face plane = made.Face();
        // The adaptor's plane follows the surface, not the face's place in the solid. Match the outward normal.
        if (face.Orientation() == TopAbs_REVERSED) {
            plane.Reverse();
        }
        return plane;
    } catch (const Standard_Failure&) {
        error = miss;
        return {};
    }
}

/// `BRepFeat_MakePrism::Perform(until)`, mode 2: the prism trimmed where it meets `until`, not yet combined.
/// The basis is a copy, so Perform cannot rewrite the solid this step is built on.
class K3Prism : public BRepFeat_MakePrism {
public:
    using BRepFeat_MakePrism::BRepFeat_MakePrism;
};

TopoDS_Shape k3_up_to(const TopoDS_Shape& current, const TopoDS_Face& face, const gp_Dir& direction, const TopoDS_Face& until, std::string& error) {
    const char* miss = "The extrude does not reach that face. Move the profile so its direction meets the face.";
    const TopoDS_Face plane = k3_stop_plane(until, error);
    if (plane.IsNull()) {
        return {};
    }
    try {
        BRepBuilderAPI_Copy copied(current);
        if (!copied.IsDone()) {
            error = miss;
            return {};
        }
        // Mode 2 keeps the trimmed prism. Mode 0 and 1 would cut or fuse it into the copy.
        K3Prism feat(copied.Shape(), face, face, direction, 2, Standard_False);
        feat.Perform(plane);
        if (!feat.IsDone() || feat.Shape().IsNull()) {
            error = miss;
            return {};
        }
        return k3_solid(feat.Shape(), error, miss);
    } catch (const Standard_Failure&) {
        error = miss;
        return {};
    }
}

/// Where the prism runs along W. `depth2` is the other side of the plane.
bool k3_span(double depth, bool symmetric, bool has_depth2, double depth2, double& lo, double& hi, std::string& error) {
    if (!std::isfinite(depth)) {
        error = "An extrude needs a depth other than 0.";
        return false;
    }
    if (has_depth2) {
        if (!std::isfinite(depth2) || !(depth2 > kTinyMm) || depth2 > 1e5) {
            error = "The second depth is a distance on the other side of the plane, above 0.";
            return false;
        }
        if (symmetric) {
            error = "An extrude is centred, or it has a second depth, not both.";
            return false;
        }
        if (depth >= 0.0) {
            lo = -depth2;
            hi = depth;
        } else {
            lo = depth;
            hi = depth2;
        }
    } else if (symmetric) {
        const double length = std::abs(depth);
        lo = -length / 2.0;
        hi = length / 2.0;
    } else {
        lo = std::min(depth, 0.0);
        hi = std::max(depth, 0.0);
    }
    if (!(hi - lo > kTinyMm)) {
        error = "An extrude needs a depth other than 0.";
        return false;
    }
    return true;
}

/// The narrower end of a draft. The smaller side of the profile's box is what a square or a rectangle closes across.
bool k3_draft_closes(const std::vector<double>& points, double shrink) {
    if (!(shrink > 0.0)) {
        return false;
    }
    double min_u = points[0];
    double max_u = points[0];
    double min_v = points[1];
    double max_v = points[1];
    for (size_t i = 0; i + 1 < points.size(); i += 2) {
        min_u = std::min(min_u, points[i]);
        max_u = std::max(max_u, points[i]);
        min_v = std::min(min_v, points[i + 1]);
        max_v = std::max(max_v, points[i + 1]);
    }
    const double across = std::min(max_u - min_u, max_v - min_v);
    return shrink * 2.0 >= across - 1e-9;
}

}  // namespace

namespace {

/// The profile's face, lifted `lift` along W. Null with `error` set when the outline does not make a face.
using ProfileFaceAt = std::function<TopoDS_Face(double lift, std::string& error)>;

/// K3 for any planar profile: a point outline or K1 loops. `closes` says whether a draft that narrows the far end by
/// `shrink` closes the outline before the depth.
TopoDS_Shape extent_from_face(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileFrame& frame,
    const ProfileFaceAt& face_at,
    const std::function<bool(double shrink)>& closes,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    double& volume,
    std::string& error) {
    const bool has_draft = extent.has_draft && std::abs(extent.draft_deg) > 1e-9;
    const bool has_depth2 = extent.has_depth2;
    const bool has_up_to = extent.has_up_to;
    if (which != "fuse" && which != "cut" && which != "common") {
        error = "The boolean is fuse, cut, or common";
        return {};
    }
    if (has_up_to && has_depth2) {
        error = "An extrude up to a face starts at the profile. Drop the second depth.";
        return {};
    }
    if (has_up_to && symmetric) {
        error = "An extrude up to a face starts at the profile. Leave centred off.";
        return {};
    }
    if (has_up_to && extent.up_to.IsNull()) {
        error = "That face is not on this solid.";
        return {};
    }
    if (has_up_to && has_draft) {
        error = "A draft up to a face is not available yet. Drop the draft, or drop the face and set a depth.";
        return {};
    }
    double draft_rad = 0.0;
    if (has_draft) {
        if (!std::isfinite(extent.draft_deg) || std::abs(extent.draft_deg) >= 89.0) {
            error = "A draft angle must be between -89 and 89 degrees.";
            return {};
        }
        draft_rad = extent.draft_deg * kPi / 180.0;
    }
    // Up to a face: depth only says which way to go, and may be 0 (+W).
    if (!has_up_to && !std::isfinite(depth)) {
        error = "An extrude needs a depth other than 0.";
        return {};
    }
    double lo = 0.0;
    double hi = 0.0;
    if (!has_up_to && !k3_span(depth, symmetric, has_depth2, extent.depth2, lo, hi, error)) {
        return {};
    }
    if (has_draft && !has_up_to) {
        const double taper = std::tan(std::abs(draft_rad));
        double shrink = 0.0;
        if (has_depth2 || symmetric) {
            // The wall leans one way: the +W end shrinks when the angle is positive, the −W end when it is negative.
            shrink = draft_rad >= 0.0 ? hi * taper : (-lo) * taper;
        } else if (draft_rad > 0.0) {
            // One side: a positive angle shrinks the far end, whichever way the depth points.
            shrink = std::abs(depth) * taper;
        }
        if (closes(shrink)) {
            error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
            return {};
        }
    }
    const char* closed = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";

    if (has_up_to) {
        TopoDS_Face face = face_at(0.0, error);
        if (face.IsNull()) {
            return {};
        }
        // A negative depth asks for −W. The feature still turns toward the face when that is the other way.
        gp_Dir direction(frame.w);
        if (depth < 0.0) {
            face.Reverse();
            direction.Reverse();
        }
        TopoDS_Shape tool = k3_up_to(current, face, direction, extent.up_to, error);
        if (tool.IsNull()) {
            return {};
        }
        return combine_profile(current, before, which, tool, "extrude", volume, error);
    }

    if (!has_draft) {
        // Two-sided, straight walls: the same prism as a plain extrude, from the lower end along +W.
        const TopoDS_Face face = face_at(lo, error);
        if (face.IsNull()) {
            return {};
        }
        BRepPrimAPI_MakePrism prism(face, gp_Vec(frame.w) * (hi - lo));
        const TopoDS_Shape tool = built(prism, "extrude", error);
        if (tool.IsNull()) {
            return {};
        }
        return combine_profile(current, before, which, tool, "extrude", volume, error);
    }

    TopoDS_Face face = face_at(0.0, error);
    if (face.IsNull()) {
        return {};
    }
    TopoDS_Shape tool;
    if (has_depth2 || symmetric) {
        tool = k3_draft_both(face, hi, lo, draft_rad, error);
    } else if (depth < 0.0) {
        // The profile stays the section on the plane. The prism runs along −W and a positive angle shrinks that end.
        // LocOpe_DPrism grows along the face's surface normal whatever the face's orientation, so the prism is built
        // along +W and mirrored through the profile's plane.
        tool = k3_draft_prism(face, std::abs(depth), draft_rad, error);
        if (!tool.IsNull()) {
            gp_Trsf mirror;
            mirror.SetMirror(gp_Ax2(frame.origin, frame.w));
            tool = BRepBuilderAPI_Transform(tool, mirror, Standard_True).Shape();
            GProp_GProps props;
            integrate(tool, props);
            if (props.Mass() < 0.0) {
                tool.Reverse();
            }
        }
    } else {
        tool = k3_draft_prism(face, depth, draft_rad, error);
    }
    if (tool.IsNull()) {
        if (error.empty()) {
            error = closed;
        }
        return {};
    }
    return combine_profile(current, before, which, tool, "extrude", volume, error);
}

}  // namespace

TopoDS_Shape build_extrude_extent(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileSpec& profile,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    double& volume,
    std::string& error) {
    const std::vector<double> points = profile_points(profile, error);
    if (points.empty()) {
        return {};
    }
    const bool has_draft = extent.has_draft && std::abs(extent.draft_deg) > 1e-9;
    if (!has_draft && !extent.has_depth2 && !extent.has_up_to) {
        return build_extrude(current, before, which, profile, depth, symmetric, volume, error);
    }
    const ProfileFrame frame = frame_of(profile);
    return extent_from_face(
        current,
        before,
        which,
        frame,
        [&](double lift, std::string& message) { return profile_face(frame, profile, lift, message); },
        [&](double shrink) { return k3_draft_closes(points, shrink); },
        depth,
        symmetric,
        extent,
        volume,
        error);
}

TopoDS_Shape build_revolve(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileSpec& profile,
    const double* axis,
    double angle_deg,
    double& volume,
    std::string& error) {
    const std::vector<double> points = profile_points(profile, error);
    if (points.empty()) {
        return {};
    }
    if (!std::isfinite(angle_deg) || !(angle_deg > 1e-6) || angle_deg > 360.0 + 1e-9) {
        error = "A revolve needs an angle above 0 and at most 360 degrees.";
        return {};
    }
    const double length = std::hypot(axis[2], axis[3]);
    if (!std::isfinite(length) || !(length > 1e-9) || !std::isfinite(axis[0]) || !std::isfinite(axis[1])) {
        error = "The revolve axis needs a direction in the profile's plane.";
        return {};
    }
    const double du = axis[2] / length;
    const double dv = axis[3] / length;
    double lo = 0.0;
    double hi = 0.0;
    for (size_t i = 0; i + 1 < points.size(); i += 2) {
        const double side = cross2(du, dv, points[i] - axis[0], points[i + 1] - axis[1]);
        lo = std::min(lo, side);
        hi = std::max(hi, side);
    }
    if (lo < -kProfileMm && hi > kProfileMm) {
        error = "The profile crosses the revolve axis. Keep it on one side.";
        return {};
    }
    const ProfileFrame frame = frame_of(profile);
    const TopoDS_Face face = profile_face(frame, profile, 0.0, error);
    if (face.IsNull()) {
        return {};
    }
    const gp_Vec along = gp_Vec(frame.u) * du + gp_Vec(frame.v) * dv;
    const gp_Ax1 turn_axis(frame.at(axis[0], axis[1]), gp_Dir(along));
    const double angle = std::min(angle_deg, 360.0) * kPi / 180.0;
    BRepPrimAPI_MakeRevol revol(face, turn_axis, angle, Standard_True);
    TopoDS_Shape tool = built(revol, "revolve", error);
    if (tool.IsNull()) {
        return {};
    }
    // A profile on the other side of its axis turns the solid inside out.
    GProp_GProps props;
    integrate(tool, props);
    if (props.Mass() < 0.0) {
        tool.Reverse();
    }
    return combine_profile(current, before, which, tool, "revolve", volume, error);
}

// =============================================================================
// K1 profile v2: loops, arcs, and holes.
// The first loop is the outline; the rest are holes. Lines, three-point arcs, and splines.
// The point-list profile path above does not call into this block.
// =============================================================================

namespace {

struct Circle2 {
    double c[2] = {0, 0};
    double r = 0;
    bool ok = false;
};

bool finite2(const double* p) { return std::isfinite(p[0]) && std::isfinite(p[1]); }

bool same_point(const double* a, const double* b) {
    return std::abs(a[0] - b[0]) <= kProfileMm && std::abs(a[1] - b[1]) <= kProfileMm;
}

Circle2 circle_of(const double* a, const double* b, const double* c) {
    Circle2 out;
    const double d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (!(std::abs(d) > 1e-12)) {
        return out;
    }
    const double a2 = a[0] * a[0] + a[1] * a[1];
    const double b2 = b[0] * b[0] + b[1] * b[1];
    const double c2 = c[0] * c[0] + c[1] * c[1];
    out.c[0] = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    out.c[1] = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    out.r = std::hypot(a[0] - out.c[0], a[1] - out.c[1]);
    out.ok = std::isfinite(out.r) && out.r > kProfileMm;
    return out;
}

double ccw_delta(double from, double to) {
    double d = to - from;
    const double turn = 2.0 * kPi;
    while (d < 0.0) {
        d += turn;
    }
    while (d >= turn) {
        d -= turn;
    }
    return d;
}

/// Signed sweep of the arc a → b passing through m, CCW positive, in (−2π, 2π).
double arc_sweep(const Circle2& circle, const double* a, const double* m, const double* b) {
    const auto ang = [&circle](const double* p) { return std::atan2(p[1] - circle.c[1], p[0] - circle.c[0]); };
    const double a0 = ang(a);
    const double through = ccw_delta(a0, ang(m));
    const double end = ccw_delta(a0, ang(b));
    return through <= end ? end : end - 2.0 * kPi;
}

void reverse_pairs(std::vector<double>& through) {
    std::vector<double> rev;
    rev.reserve(through.size());
    for (size_t i = through.size(); i >= 2;) {
        i -= 2;
        rev.push_back(through[i]);
        rev.push_back(through[i + 1]);
        if (i == 0) {
            break;
        }
    }
    through.swap(rev);
}

/// The `Geom_BSplineCurve` an edge is built from. Knot generation matches `src/modeling/nurbs-eval.ts`.
Handle(Geom_BSplineCurve) bspline_curve(
    const std::vector<gp_Pnt>& poles,
    const std::vector<double>& weights,
    int requested_degree,
    const std::vector<double>& in_knots,
    const std::vector<int>& in_mults,
    bool periodic,
    std::string& error) {
    const int n = static_cast<int>(poles.size());
    if (n < (periodic ? 3 : 2)) {
        error = periodic ? "A periodic NURBS curve needs at least 3 poles." : "A NURBS curve needs at least 2 poles.";
        return {};
    }
    // A degree that was asked for must fit the poles; only the default (3) is lowered to fit a short curve.
    const int most = periodic ? n : (n - 1);
    if (requested_degree > 10) {
        error = "A NURBS degree can be at most 10.";
        return {};
    }
    if (requested_degree > most) {
        error = "A NURBS curve of degree " + std::to_string(requested_degree) + " needs at least " +
            std::to_string(periodic ? requested_degree : requested_degree + 1) + " poles; it has " + std::to_string(n) + ".";
        return {};
    }
    const int deg = std::clamp(requested_degree > 0 ? requested_degree : 3, 1, most);
    if (in_knots.size() != in_mults.size()) {
        error = "NURBS knots and multiplicities must be the same length.";
        return {};
    }
    TColgp_Array1OfPnt p_arr(1, n);
    for (int i = 0; i < n; ++i) {
        p_arr.SetValue(i + 1, poles[static_cast<size_t>(i)]);
    }

    const bool has_weights = !weights.empty();
    if (has_weights && static_cast<int>(weights.size()) != n) {
        error = "NURBS weights count must match the number of poles.";
        return {};
    }
    TColStd_Array1OfReal w_arr(1, n);
    if (has_weights) {
        for (int i = 0; i < n; ++i) {
            const double w = weights[static_cast<size_t>(i)];
            if (!std::isfinite(w) || !(w > 1e-9)) {
                error = "Every NURBS weight must be a positive number.";
                return {};
            }
            w_arr.SetValue(i + 1, w);
        }
    }

    std::vector<double> knots;
    std::vector<int> mults;
    if (!in_knots.empty() && in_knots.size() == in_mults.size()) {
        knots = in_knots;
        mults = in_mults;
    } else if (periodic) {
        knots.resize(static_cast<size_t>(n + 1));
        mults.assign(static_cast<size_t>(n + 1), 1);
        for (int i = 0; i <= n; ++i) {
            knots[static_cast<size_t>(i)] = static_cast<double>(i);
        }
    } else {
        const int spans = n - deg;
        knots.resize(static_cast<size_t>(spans + 1));
        mults.resize(static_cast<size_t>(spans + 1));
        for (int i = 0; i <= spans; ++i) {
            knots[static_cast<size_t>(i)] = static_cast<double>(i) / static_cast<double>(spans);
            mults[static_cast<size_t>(i)] = (i == 0 || i == spans) ? (deg + 1) : 1;
        }
    }

    const int nk = static_cast<int>(knots.size());
    if (nk < 2) {
        error = "A NURBS curve needs at least 2 distinct knots.";
        return {};
    }
    TColStd_Array1OfReal k_arr(1, nk);
    TColStd_Array1OfInteger m_arr(1, nk);
    for (int i = 0; i < nk; ++i) {
        if (i > 0 && !(knots[static_cast<size_t>(i)] > knots[static_cast<size_t>(i - 1)] + 1e-12)) {
            error = "NURBS knots must be strictly increasing.";
            return {};
        }
        if (mults[static_cast<size_t>(i)] < 1) {
            error = "NURBS knot multiplicities must be at least 1.";
            return {};
        }
        k_arr.SetValue(i + 1, knots[static_cast<size_t>(i)]);
        m_arr.SetValue(i + 1, mults[static_cast<size_t>(i)]);
    }

    try {
        return has_weights
            ? new Geom_BSplineCurve(p_arr, w_arr, k_arr, m_arr, deg, periodic ? Standard_True : Standard_False)
            : new Geom_BSplineCurve(p_arr, k_arr, m_arr, deg, periodic ? Standard_True : Standard_False);
    } catch (const Standard_Failure& failure) {
        const char* msg = failure.GetMessageString();
        error = (msg != nullptr && msg[0] != '\0') ? std::string("NURBS curve failed: ") + msg : "Open CASCADE did not build the NURBS curve.";
        return {};
    }
}

/// --- Organic surfaces S2: build an exact OCCT `Geom_BSplineCurve` edge from poles, optional rational weights,
/// degree (default min(3, N-1)), and optional explicit knots/mults. Knot generation matches `src/modeling/nurbs-eval.ts`.
TopoDS_Edge nurbs_edge(
    const std::vector<gp_Pnt>& poles,
    const std::vector<double>& weights,
    int requested_degree,
    const std::vector<double>& in_knots,
    const std::vector<int>& in_mults,
    bool periodic,
    std::string& error) {
    const Handle(Geom_BSplineCurve) curve = bspline_curve(poles, weights, requested_degree, in_knots, in_mults, periodic, error);
    if (curve.IsNull()) {
        return {};
    }
    try {
        BRepBuilderAPI_MakeEdge edge(curve);
        if (!edge.IsDone()) {
            error = "Open CASCADE did not build the NURBS curve edge.";
            return {};
        }
        return edge.Edge();
    } catch (const Standard_Failure& failure) {
        const char* msg = failure.GetMessageString();
        error = (msg != nullptr && msg[0] != '\0') ? std::string("NURBS curve failed: ") + msg : "Open CASCADE did not build the NURBS curve.";
        return {};
    }
}

/// Walk the loop backwards. An arc's through point stays, so the arc is the same curve.
void reverse_loop(ProfileLoop& loop) {
    if (loop.segments.empty()) {
        return;
    }
    std::vector<std::array<double, 2>> pts;
    pts.push_back({loop.start[0], loop.start[1]});
    for (const ProfileSeg& seg : loop.segments) {
        pts.push_back({seg.to[0], seg.to[1]});
    }
    std::vector<ProfileSeg> rev;
    rev.reserve(loop.segments.size());
    for (size_t i = loop.segments.size(); i-- > 0;) {
        ProfileSeg seg = loop.segments[i];
        seg.to[0] = pts[i][0];
        seg.to[1] = pts[i][1];
        if (seg.kind == ProfileSegKind::Spline || seg.kind == ProfileSegKind::Nurbs) {
            reverse_pairs(seg.through);
        }
        if (seg.kind == ProfileSegKind::Nurbs) {
            if (!seg.weights.empty()) {
                const bool closed = loop.segments.size() == 1 && same_point(pts[i].data(), loop.segments[i].to);
                if (closed && seg.weights.size() > 1) {
                    std::reverse(seg.weights.begin() + 1, seg.weights.end());
                } else {
                    std::reverse(seg.weights.begin(), seg.weights.end());
                }
            }
            if (!seg.knots.empty() && seg.knots.size() == seg.mults.size()) {
                const double u_min = seg.knots.front();
                const double u_max = seg.knots.back();
                std::reverse(seg.knots.begin(), seg.knots.end());
                std::reverse(seg.mults.begin(), seg.mults.end());
                for (double& k : seg.knots) {
                    k = u_min + u_max - k;
                }
            }
        }
        rev.push_back(std::move(seg));
    }
    loop.segments = std::move(rev);
}

/// A spline or NURBS that ends where it starts, through at least two points between: one smooth periodic curve.
bool closed_spline(const double* from, const ProfileSeg& seg) {
    return (seg.kind == ProfileSegKind::Spline || seg.kind == ProfileSegKind::Nurbs) && seg.through.size() >= 4 && same_point(from, seg.to);
}

double spline_area2(const double* from, const ProfileSeg& seg) {
    const bool closed = closed_spline(from, seg);
    std::vector<gp_Pnt> pts;
    pts.emplace_back(from[0], from[1], 0.0);
    for (size_t i = 0; i + 1 < seg.through.size(); i += 2) {
        pts.emplace_back(seg.through[i], seg.through[i + 1], 0.0);
    }
    if (!closed) {
        pts.emplace_back(seg.to[0], seg.to[1], 0.0);
    }
    std::string ignored;
    const TopoDS_Edge edge = seg.kind == ProfileSegKind::Nurbs
        ? nurbs_edge(pts, seg.weights, seg.degree, seg.knots, seg.mults, closed, ignored)
        : spline_edge(pts, closed, ignored);
    if (edge.IsNull()) {
        return cross2(from[0], from[1], seg.to[0], seg.to[1]);
    }
    BRepAdaptor_Curve curve(edge);
    GCPnts_QuasiUniformDeflection sampler(curve, 0.05);
    if (!sampler.IsDone() || sampler.NbPoints() < 2) {
        return cross2(from[0], from[1], seg.to[0], seg.to[1]);
    }
    double area2 = 0.0;
    gp_Pnt prev = sampler.Value(1);
    for (int i = 2; i <= sampler.NbPoints(); ++i) {
        const gp_Pnt p = sampler.Value(i);
        area2 += cross2(prev.X(), prev.Y(), p.X(), p.Y());
        prev = p;
    }
    return area2;
}

double signed_area(const ProfileLoop& loop) {
    double area2 = 0.0;
    double from[2] = {loop.start[0], loop.start[1]};
    for (const ProfileSeg& seg : loop.segments) {
        if (seg.kind == ProfileSegKind::Arc && seg.through.size() >= 2) {
            const Circle2 circle = circle_of(from, seg.through.data(), seg.to);
            area2 += cross2(from[0], from[1], seg.to[0], seg.to[1]);
            if (circle.ok) {
                const double theta = arc_sweep(circle, from, seg.through.data(), seg.to);
                area2 += circle.r * circle.r * (theta - std::sin(theta));
            }
        } else if (seg.kind == ProfileSegKind::Spline || seg.kind == ProfileSegKind::Nurbs) {
            area2 += spline_area2(from, seg);
        } else {
            area2 += cross2(from[0], from[1], seg.to[0], seg.to[1]);
        }
        from[0] = seg.to[0];
        from[1] = seg.to[1];
    }
    return area2 * 0.5;
}

/// Closed, no zero-length segment, arcs not collinear. Snaps a closing point that is within tolerance.
bool loops_readable(std::vector<ProfileLoop>& loops, std::string& error) {
    if (loops.empty()) {
        error = "A profile needs a loop.";
        return false;
    }
    if (loops.size() > kMaxLoops) {
        error = "A profile takes at most 1000 loops.";
        return false;
    }
    for (ProfileLoop& loop : loops) {
        if (loop.segments.empty()) {
            error = "A loop needs a segment.";
            return false;
        }
        if (loop.segments.size() > 1000) {
            error = "A loop takes at most 1000 segments.";
            return false;
        }
        if (!finite2(loop.start)) {
            error = "A loop point is not a number.";
            return false;
        }
        double from[2] = {loop.start[0], loop.start[1]};
        for (ProfileSeg& seg : loop.segments) {
            if (!finite2(seg.to)) {
                error = "A loop point is not a number.";
                return false;
            }
            for (size_t i = 0; i + 1 < seg.through.size(); i += 2) {
                if (!std::isfinite(seg.through[i]) || !std::isfinite(seg.through[i + 1])) {
                    error = "A loop point is not a number.";
                    return false;
                }
            }
            // A closed spline is the loop's only segment; any other segment that comes back to its start has no length.
            if (same_point(from, seg.to) && !(loop.segments.size() == 1 && closed_spline(from, seg))) {
                error = "A loop segment ends where it starts. Give it some length.";
                return false;
            }
            if (seg.kind == ProfileSegKind::Arc) {
                if (seg.through.size() != 2) {
                    error = "An arc needs one point between its ends.";
                    return false;
                }
                if (same_point(from, seg.through.data()) || same_point(seg.to, seg.through.data())) {
                    error = "An arc's three points are in a straight line. Move the middle point off that line.";
                    return false;
                }
                const double span = std::max({std::hypot(seg.through[0] - from[0], seg.through[1] - from[1]),
                                               std::hypot(seg.to[0] - from[0], seg.to[1] - from[1]), 1.0});
                const double turn = cross2(seg.through[0] - from[0], seg.through[1] - from[1], seg.to[0] - from[0], seg.to[1] - from[1]);
                if (std::abs(turn) <= kProfileMm * span) {
                    error = "An arc's three points are in a straight line. Move the middle point off that line.";
                    return false;
                }
            } else if (seg.kind == ProfileSegKind::Spline && seg.through.size() < 2) {
                error = "A spline needs a point between its ends.";
                return false;
            }
            from[0] = seg.to[0];
            from[1] = seg.to[1];
        }
        ProfileSeg& last = loop.segments.back();
        if (same_point(last.to, loop.start)) {
            last.to[0] = loop.start[0];
            last.to[1] = loop.start[1];
        } else {
            error = "A loop is open. Its end must meet its start.";
            return false;
        }
        const double area = signed_area(loop);
        if (!(std::abs(area) > 1e-6)) {
            error = &loop == &loops.front() ? "The outline has no area." : "A hole has no area.";
            return false;
        }
    }
    return true;
}

/// Outline counter-clockwise about W, holes clockwise, so a face's holes cut.
void orient_loops(std::vector<ProfileLoop>& loops) {
    for (size_t i = 0; i < loops.size(); ++i) {
        const double area = signed_area(loops[i]);
        const bool ccw = area > 0.0;
        const bool want_ccw = i == 0;
        if (ccw != want_ccw) {
            reverse_loop(loops[i]);
        }
    }
}

TopoDS_Edge loop_edge(const ProfileFrame& frame, const double* from, const ProfileSeg& seg, double lift, std::string& error) {
    const gp_Pnt a = frame.at(from[0], from[1], lift);
    const gp_Pnt b = frame.at(seg.to[0], seg.to[1], lift);
    if (seg.kind == ProfileSegKind::Line) {
        BRepBuilderAPI_MakeEdge edge(a, b);
        if (!edge.IsDone()) {
            error = "Open CASCADE did not build the profile";
            return {};
        }
        return edge.Edge();
    }
    if (seg.kind == ProfileSegKind::Arc) {
        const gp_Pnt mid = frame.at(seg.through[0], seg.through[1], lift);
        GC_MakeArcOfCircle arc(a, mid, b);
        if (!arc.IsDone()) {
            error = "Open CASCADE did not draw this arc.";
            return {};
        }
        BRepBuilderAPI_MakeEdge edge(arc.Value());
        if (!edge.IsDone()) {
            error = "Open CASCADE did not draw this arc.";
            return {};
        }
        return edge.Edge();
    }
    if (seg.kind == ProfileSegKind::Nurbs) {
        const bool closed = closed_spline(from, seg);
        std::vector<gp_Pnt> poles;
        poles.push_back(a);
        for (size_t i = 0; i + 1 < seg.through.size(); i += 2) {
            poles.push_back(frame.at(seg.through[i], seg.through[i + 1], lift));
        }
        if (!closed) {
            poles.push_back(b);
        }
        return nurbs_edge(poles, seg.weights, seg.degree, seg.knots, seg.mults, closed, error);
    }
    const bool closed = closed_spline(from, seg);
    std::vector<gp_Pnt> pts;
    pts.push_back(a);
    for (size_t i = 0; i + 1 < seg.through.size(); i += 2) {
        pts.push_back(frame.at(seg.through[i], seg.through[i + 1], lift));
    }
    if (!closed) {
        pts.push_back(b);
    }
    return spline_edge(pts, closed, error);
}

TopoDS_Wire wire_of(const std::vector<TopoDS_Edge>& edges, std::string& error) {
    BRepBuilderAPI_MakeWire maker;
    for (const TopoDS_Edge& edge : edges) {
        maker.Add(edge);
    }
    if (maker.IsDone()) {
        return maker.Wire();
    }
    // An arc's end and the next edge's start are the same point but two vertices. Join those.
    BRep_Builder builder;
    TopoDS_Wire wire;
    builder.MakeWire(wire);
    for (const TopoDS_Edge& edge : edges) {
        builder.Add(wire, edge);
    }
    ShapeFix_Wire fixer;
    fixer.Load(wire);
    fixer.SetPrecision(1e-5);
    fixer.ClosedWireMode() = Standard_True;
    fixer.FixReorder();
    fixer.FixConnected(1e-5);
    fixer.FixClosed(1e-5);
    if (fixer.Wire().IsNull()) {
        error = "Open CASCADE did not join the loop into one outline.";
        return {};
    }
    return fixer.Wire();
}

bool edges_cross(const std::vector<std::vector<TopoDS_Edge>>& groups, std::string& error) {
    struct Item {
        TopoDS_Edge edge;
        int loop = 0;
        int index = 0;
        int count = 0;
        Bnd_Box box;
        double from = 0.0;
        double to = 0.0;
    };
    std::vector<Item> all;
    Bnd_Box whole;
    for (int loop = 0; loop < static_cast<int>(groups.size()); ++loop) {
        const int count = static_cast<int>(groups[static_cast<size_t>(loop)].size());
        for (int index = 0; index < count; ++index) {
            Item item;
            item.edge = groups[static_cast<size_t>(loop)][static_cast<size_t>(index)];
            item.loop = loop;
            item.index = index;
            item.count = count;
            BRepBndLib::Add(item.edge, item.box);
            item.box.Enlarge(2e-5);
            whole.Add(item.box);
            all.push_back(item);
        }
    }
    if (all.size() < 2 || whole.IsVoid()) {
        return false;
    }
    // Sweep along the longest side of the whole box: only edges whose boxes overlap are measured, so a lattice of a
    // thousand cells costs about what its neighbours do, not every pair.
    double lo[3];
    double hi[3];
    whole.Get(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    int axis = 0;
    for (int k = 1; k < 3; ++k) {
        if (hi[k] - lo[k] > hi[axis] - lo[axis]) {
            axis = k;
        }
    }
    for (Item& item : all) {
        double a[3];
        double b[3];
        item.box.Get(a[0], a[1], a[2], b[0], b[1], b[2]);
        item.from = a[axis];
        item.to = b[axis];
    }
    std::sort(all.begin(), all.end(), [](const Item& x, const Item& y) { return x.from < y.from; });
    for (size_t i = 0; i < all.size(); ++i) {
        for (size_t j = i + 1; j < all.size() && all[j].from <= all[i].to; ++j) {
            if (all[i].loop == all[j].loop) {
                const int apart = std::abs(all[i].index - all[j].index);
                if (apart == 1 || apart == all[i].count - 1) {
                    continue;
                }
            }
            if (all[i].box.IsOut(all[j].box)) {
                continue;
            }
            BRepExtrema_DistShapeShape dist(all[i].edge, all[j].edge);
            if (dist.IsDone() && dist.Value() <= 1e-5) {
                error = "These loops cross.";
                return true;
            }
        }
    }
    return false;
}

/// The loop's edges on the plane lifted `lift` along W. Empty with `error` set when one does not build.
std::vector<TopoDS_Edge> loop_edges(const ProfileFrame& frame, const ProfileLoop& loop, double lift, std::string& error) {
    std::vector<TopoDS_Edge> edges;
    double from[2] = {loop.start[0], loop.start[1]};
    for (const ProfileSeg& seg : loop.segments) {
        TopoDS_Edge edge = loop_edge(frame, from, seg, lift, error);
        if (edge.IsNull()) {
            if (error.empty()) {
                error = "Open CASCADE did not build the profile";
            }
            return {};
        }
        edges.push_back(edge);
        from[0] = seg.to[0];
        from[1] = seg.to[1];
    }
    return edges;
}

/// Loops sorted by nesting. A loop inside an even number of others is an outline and starts a group; one inside an
/// odd number is a hole of the innermost loop around it. Each group comes back outline first, the outline turning
/// counter-clockwise about W and its holes the other way. `deepest` is the deepest nesting seen. Every loop is checked,
/// and no two may cross.
bool group_loops(
    const ProfileFrame& frame,
    std::vector<ProfileLoop> loops,
    std::vector<std::vector<ProfileLoop>>& groups,
    int& deepest,
    std::string& error) {
    groups.clear();
    deepest = 0;
    if (!loops_readable(loops, error)) {
        return false;
    }
    std::vector<std::vector<TopoDS_Edge>> edges;
    edges.reserve(loops.size());
    for (const ProfileLoop& loop : loops) {
        std::vector<TopoDS_Edge> built = loop_edges(frame, loop, 0.0, error);
        if (built.empty()) {
            return false;
        }
        edges.push_back(std::move(built));
    }
    if (edges_cross(edges, error)) {
        return false;
    }
    const size_t n = loops.size();
    std::vector<int> depth(n, 0);
    std::vector<int> parent(n, -1);
    if (n > 1) {
        const gp_Pln plane(gp_Ax3(frame.at(0.0, 0.0), frame.w, frame.u));
        std::vector<TopoDS_Face> faces(n);
        std::vector<Bnd_Box> boxes(n);
        for (size_t i = 0; i < n; ++i) {
            const TopoDS_Wire wire = wire_of(edges[i], error);
            if (wire.IsNull()) {
                if (error.empty()) {
                    error = "Open CASCADE did not join the loop into one outline.";
                }
                return false;
            }
            BRepBuilderAPI_MakeFace maker(plane, wire, Standard_True);
            if (!maker.IsDone()) {
                error = "Open CASCADE did not build the profile";
                return false;
            }
            faces[i] = maker.Face();
            BRepBndLib::Add(wire, boxes[i]);
            boxes[i].Enlarge(1e-6);
        }
        std::vector<std::vector<int>> around(n);
        for (size_t j = 0; j < n; ++j) {
            const gp_Pnt at = frame.at(loops[j].start[0], loops[j].start[1]);
            for (size_t i = 0; i < n; ++i) {
                if (i == j || boxes[i].IsOut(at)) {
                    continue;
                }
                BRepClass_FaceClassifier inside(faces[i], at, 1e-7);
                if (inside.State() == TopAbs_IN) {
                    around[j].push_back(static_cast<int>(i));
                }
            }
            depth[j] = static_cast<int>(around[j].size());
            deepest = std::max(deepest, depth[j]);
        }
        for (size_t j = 0; j < n; ++j) {
            for (const int i : around[j]) {
                if (depth[static_cast<size_t>(i)] == depth[j] - 1) {
                    parent[j] = i;
                }
            }
        }
    }
    std::vector<int> group_of(n, -1);
    for (size_t i = 0; i < n; ++i) {
        if (depth[i] % 2 == 0) {
            group_of[i] = static_cast<int>(groups.size());
            groups.push_back(std::vector<ProfileLoop>{loops[i]});
        }
    }
    for (size_t i = 0; i < n; ++i) {
        if (depth[i] % 2 == 1 && parent[i] >= 0 && group_of[static_cast<size_t>(parent[i])] >= 0) {
            groups[static_cast<size_t>(group_of[static_cast<size_t>(parent[i])])].push_back(loops[i]);
        }
    }
    for (std::vector<ProfileLoop>& group : groups) {
        orient_loops(group);
    }
    return true;
}

/// One group's face on the plane lifted `lift` along W: an outline and its holes, as `group_loops` sorted and turned
/// them. The face's normal points along W.
TopoDS_Face group_face(const ProfileFrame& frame, const std::vector<ProfileLoop>& loops, double lift, std::string& error) {
    std::vector<TopoDS_Wire> wires;
    for (const ProfileLoop& loop : loops) {
        const std::vector<TopoDS_Edge> edges = loop_edges(frame, loop, lift, error);
        if (edges.empty()) {
            return {};
        }
        TopoDS_Wire wire = wire_of(edges, error);
        if (wire.IsNull()) {
            if (error.empty()) {
                error = "Open CASCADE did not join the loop into one outline.";
            }
            return {};
        }
        wires.push_back(wire);
    }
    if (wires.empty()) {
        error = "A profile needs a loop.";
        return {};
    }
    const gp_Pln plane(gp_Ax3(frame.at(0.0, 0.0, lift), frame.w, frame.u));
    BRepBuilderAPI_MakeFace maker(plane, wires.front(), Standard_True);
    if (!maker.IsDone()) {
        error = "Open CASCADE did not build the profile";
        return {};
    }
    for (size_t h = 1; h < wires.size(); ++h) {
        maker.Add(wires[h]);
    }
    TopoDS_Face face = maker.Face();
    if (face.IsNull()) {
        error = "Open CASCADE did not build the profile";
        return {};
    }
    try {
        ShapeFix_Face fixer(face);
        fixer.SetPrecision(1e-6);
        fixer.FixOrientationMode() = 1;
        if (fixer.Perform() && !fixer.Face().IsNull()) {
            face = fixer.Face();
        }
    } catch (const Standard_Failure&) {
    }
    BRepAdaptor_Surface surface(face);
    if (surface.GetType() == GeomAbs_Plane) {
        gp_Dir normal = surface.Plane().Axis().Direction();
        if (face.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        if (normal.Dot(frame.w) < 0.0) {
            face.Reverse();
        }
    }
    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props);
    if (!(std::abs(props.Mass()) > 1e-6)) {
        error = "The outline has no area.";
        return {};
    }
    return face;
}

/// One outline and its holes as a face, for the ops that take a single outline (a revolve, a loft section, a draft).
/// `loops` is turned here: the outline counter-clockwise about W, holes the other way.
TopoDS_Face profile_loops_face(const ProfileFrame& frame, std::vector<ProfileLoop> loops, double lift, std::string& error) {
    std::vector<std::vector<ProfileLoop>> groups;
    int deepest = 0;
    if (!group_loops(frame, std::move(loops), groups, deepest, error)) {
        return {};
    }
    if (groups.size() != 1) {
        error = deepest > 1 ? "A hole lies inside another hole. Keep each hole inside the outline only."
                            : "A revolve takes one outline with its holes, and these loops make " + std::to_string(groups.size()) +
                                  " outlines. Revolve each outline in its own op; model_apply_batch with combine applies them in one step.";
        return {};
    }
    return group_face(frame, groups.front(), lift, error);
}

ProfileFrame frame_from(const double origin[3], const double turn[3]) {
    ProfileSpec spec;
    for (int i = 0; i < 3; ++i) {
        spec.origin[i] = origin[i];
        spec.turn[i] = turn[i];
    }
    return frame_of(spec);
}

bool crosses_axis(const ProfileFrame& frame, const TopoDS_Face& face, const double* axis) {
    const double du = axis[2];
    const double dv = axis[3];
    double lo = 0.0;
    double hi = 0.0;
    for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
        BRepAdaptor_Curve curve(TopoDS::Edge(it.Current()));
        GCPnts_QuasiUniformDeflection sampler(curve, 0.01);
        if (!sampler.IsDone()) {
            continue;
        }
        for (int i = 1; i <= sampler.NbPoints(); ++i) {
            const gp_Pnt p = sampler.Value(i);
            const gp_Vec d(frame.origin, p);
            const double u = d.Dot(gp_Vec(frame.u));
            const double v = d.Dot(gp_Vec(frame.v));
            const double side = cross2(du, dv, u - axis[0], v - axis[1]);
            lo = std::min(lo, side);
            hi = std::max(hi, side);
        }
    }
    return lo < -kProfileMm && hi > kProfileMm;
}

/// The solid through `wires` in order, before it is combined with the part. Shared by an outline and each hole.
TopoDS_Shape loft_wires(const std::vector<TopoDS_Wire>& wires, bool ruled, std::string& error) {
    BRepOffsetAPI_ThruSections loft(Standard_True, ruled ? Standard_True : Standard_False, 1e-6);
    loft.CheckCompatibility(Standard_True);
    for (const TopoDS_Wire& wire : wires) {
        loft.AddWire(wire);
    }
    TopoDS_Shape tool;
    try {
        loft.Build();
        if (!loft.IsDone() || loft.Shape().IsNull()) {
            error = "Open CASCADE could not loft through these sections. Check that each one is a simple outline and that they do not cross.";
            return {};
        }
        tool = loft.Shape();
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not loft through these sections. Check that each one is a simple outline and that they do not cross.";
        return {};
    }
    if (!has_solid(tool)) {
        error = "The loft did not close into a solid.";
        return {};
    }
    tool = as_solid(tool);
    GProp_GProps props;
    integrate(tool, props);
    if (std::abs(props.Mass()) <= 1e-6) {
        error = "The loft has no volume: its sections lie in one plane. Turn them so each section's plane crosses the way between them (W along the path).";
        return {};
    }
    if (props.Mass() < 0.0) {
        tool.Reverse();
    }
    if (!BRepCheck_Analyzer(tool).IsValid()) {
        ShapeFix_Solid fix;
        fix.Init(TopoDS::Solid(tool));
        fix.Perform();
        tool = fix.Solid();
        if (!BRepCheck_Analyzer(tool).IsValid()) {
            error = "The loft twists through itself. Space the sections further apart, or make tight bends gentler.";
            return {};
        }
    }
    return tool;
}

}  // namespace

#ifdef LIME_OCCT_TEST_HOOKS

namespace {

/// Clamped open-uniform knots, the same sequence `clampedKnots` builds in `src/modeling/nurbs-eval.ts`.
bool fill_clamped_knots(int count, int degree, std::vector<double>& knots, std::vector<int>& mults) {
    const int spans = count - degree;
    if (spans < 1) {
        return false;
    }
    knots.resize(static_cast<size_t>(spans + 1));
    mults.resize(static_cast<size_t>(spans + 1));
    for (int i = 0; i <= spans; ++i) {
        knots[static_cast<size_t>(i)] = static_cast<double>(i) / static_cast<double>(spans);
        mults[static_cast<size_t>(i)] = (i == 0 || i == spans) ? (degree + 1) : 1;
    }
    return true;
}

}  // namespace

bool eval_nurbs_curve(
    const double* poles_xyz,
    int npoles,
    const double* weights,
    int degree,
    const double* knots,
    const int* mults,
    int nknots,
    bool periodic,
    const double* params,
    int nparams,
    double* out_xyz,
    std::string& error) {
    if (poles_xyz == nullptr || npoles < 2 || params == nullptr || nparams < 1 || out_xyz == nullptr) {
        error = "A NURBS evaluation needs poles and parameters.";
        return false;
    }
    std::vector<gp_Pnt> poles;
    poles.reserve(static_cast<size_t>(npoles));
    for (int i = 0; i < npoles; ++i) {
        const double x = poles_xyz[i * 3];
        const double y = poles_xyz[i * 3 + 1];
        const double z = poles_xyz[i * 3 + 2];
        if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) {
            error = "A NURBS pole is not a number.";
            return false;
        }
        poles.emplace_back(x, y, z);
    }
    std::vector<double> weight_vec;
    if (weights != nullptr) {
        weight_vec.assign(weights, weights + npoles);
    }
    std::vector<double> knot_vec;
    std::vector<int> mult_vec;
    if (nknots > 0) {
        if (knots == nullptr || mults == nullptr) {
            error = "NURBS knots and multiplicities must be given together.";
            return false;
        }
        knot_vec.assign(knots, knots + nknots);
        mult_vec.assign(mults, mults + nknots);
    }
    const Handle(Geom_BSplineCurve) curve = bspline_curve(poles, weight_vec, degree, knot_vec, mult_vec, periodic, error);
    if (curve.IsNull()) {
        return false;
    }
    for (int i = 0; i < nparams; ++i) {
        const double u = params[i];
        if (!std::isfinite(u)) {
            error = "A NURBS parameter is not a number.";
            return false;
        }
        gp_Pnt point;
        curve->D0(u, point);
        out_xyz[i * 3] = point.X();
        out_xyz[i * 3 + 1] = point.Y();
        out_xyz[i * 3 + 2] = point.Z();
    }
    return true;
}

bool eval_nurbs_surface(
    const double* poles_xyz,
    int nu,
    int nv,
    const double* weights,
    int degree_u,
    int degree_v,
    const double* knots_u,
    const int* mults_u,
    int nknots_u,
    const double* knots_v,
    const int* mults_v,
    int nknots_v,
    const double* params_uv,
    int nparams,
    double* out_xyz,
    std::string& error) {
    if (poles_xyz == nullptr || nu < 2 || nv < 2 || params_uv == nullptr || nparams < 1 || out_xyz == nullptr) {
        error = "A NURBS surface evaluation needs a pole grid and parameters.";
        return false;
    }
    const int deg_u = std::clamp(degree_u > 0 ? degree_u : 3, 1, nu - 1);
    const int deg_v = std::clamp(degree_v > 0 ? degree_v : 3, 1, nv - 1);
    std::vector<double> ku;
    std::vector<int> mu;
    std::vector<double> kv;
    std::vector<int> mv;
    if (nknots_u > 0) {
        if (knots_u == nullptr || mults_u == nullptr) {
            error = "NURBS U knots and multiplicities must be given together.";
            return false;
        }
        ku.assign(knots_u, knots_u + nknots_u);
        mu.assign(mults_u, mults_u + nknots_u);
    } else if (!fill_clamped_knots(nu, deg_u, ku, mu)) {
        error = "A NURBS surface could not build its U knots.";
        return false;
    }
    if (nknots_v > 0) {
        if (knots_v == nullptr || mults_v == nullptr) {
            error = "NURBS V knots and multiplicities must be given together.";
            return false;
        }
        kv.assign(knots_v, knots_v + nknots_v);
        mv.assign(mults_v, mults_v + nknots_v);
    } else if (!fill_clamped_knots(nv, deg_v, kv, mv)) {
        error = "A NURBS surface could not build its V knots.";
        return false;
    }
    TColgp_Array2OfPnt poles(1, nu, 1, nv);
    for (int iu = 0; iu < nu; ++iu) {
        for (int iv = 0; iv < nv; ++iv) {
            const int at = (iu * nv + iv) * 3;
            const double x = poles_xyz[at];
            const double y = poles_xyz[at + 1];
            const double z = poles_xyz[at + 2];
            if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) {
                error = "A NURBS surface pole is not a number.";
                return false;
            }
            poles.SetValue(iu + 1, iv + 1, gp_Pnt(x, y, z));
        }
    }
    const bool has_weights = weights != nullptr;
    TColStd_Array2OfReal w_arr(1, nu, 1, nv);
    if (has_weights) {
        for (int iu = 0; iu < nu; ++iu) {
            for (int iv = 0; iv < nv; ++iv) {
                const double w = weights[iu * nv + iv];
                if (!std::isfinite(w) || !(w > 1e-9)) {
                    error = "Every NURBS weight must be a positive number.";
                    return false;
                }
                w_arr.SetValue(iu + 1, iv + 1, w);
            }
        }
    }
    const int nku = static_cast<int>(ku.size());
    const int nkv = static_cast<int>(kv.size());
    TColStd_Array1OfReal uk(1, nku);
    TColStd_Array1OfInteger um(1, nku);
    TColStd_Array1OfReal vk(1, nkv);
    TColStd_Array1OfInteger vm(1, nkv);
    for (int i = 0; i < nku; ++i) {
        uk.SetValue(i + 1, ku[static_cast<size_t>(i)]);
        um.SetValue(i + 1, mu[static_cast<size_t>(i)]);
    }
    for (int i = 0; i < nkv; ++i) {
        vk.SetValue(i + 1, kv[static_cast<size_t>(i)]);
        vm.SetValue(i + 1, mv[static_cast<size_t>(i)]);
    }
    Handle(Geom_BSplineSurface) surface;
    try {
        surface = has_weights
            ? new Geom_BSplineSurface(poles, w_arr, uk, vk, um, vm, deg_u, deg_v, Standard_False, Standard_False)
            : new Geom_BSplineSurface(poles, uk, vk, um, vm, deg_u, deg_v, Standard_False, Standard_False);
    } catch (const Standard_Failure& failure) {
        const char* msg = failure.GetMessageString();
        error = (msg != nullptr && msg[0] != '\0') ? std::string("NURBS surface failed: ") + msg : "Open CASCADE did not build the NURBS surface.";
        return false;
    }
    for (int i = 0; i < nparams; ++i) {
        const double u = params_uv[i * 2];
        const double v = params_uv[i * 2 + 1];
        if (!std::isfinite(u) || !std::isfinite(v)) {
            error = "A NURBS surface parameter is not a number.";
            return false;
        }
        gp_Pnt point;
        surface->D0(u, v, point);
        out_xyz[i * 3] = point.X();
        out_xyz[i * 3 + 1] = point.Y();
        out_xyz[i * 3 + 2] = point.Z();
    }
    return true;
}

#endif

bool decode_profile_loops(const double* data, int count, std::vector<ProfileLoop>& loops, int& used, std::string& error) {
    used = 0;
    loops.clear();
    if (data == nullptr || count < 1) {
        error = "A profile needs a loop.";
        return false;
    }
    size_t at = 0;
    auto take = [&](size_t n) { return at + n <= static_cast<size_t>(count); };
    if (!take(1) || !std::isfinite(data[0])) {
        error = "A profile needs a loop.";
        return false;
    }
    const int nloops = static_cast<int>(std::llround(data[at++]));
    if (nloops < 1 || nloops > static_cast<int>(kMaxLoops)) {
        error = nloops < 1 ? "A profile needs a loop." : "A profile takes at most 1000 loops.";
        return false;
    }
    for (int i = 0; i < nloops; ++i) {
        if (!take(3)) {
            error = "A loop is incomplete.";
            return false;
        }
        ProfileLoop loop;
        loop.start[0] = data[at++];
        loop.start[1] = data[at++];
        const int nseg = static_cast<int>(std::llround(data[at++]));
        if (nseg < 1 || nseg > 1000) {
            error = nseg < 1 ? "A loop needs a segment." : "A loop takes at most 1000 segments.";
            return false;
        }
        for (int s = 0; s < nseg; ++s) {
            if (!take(4)) {
                error = "A loop segment is incomplete.";
                return false;
            }
            const int kind = static_cast<int>(std::llround(data[at++]));
            ProfileSeg seg;
            seg.to[0] = data[at++];
            seg.to[1] = data[at++];
            const int nthrough = static_cast<int>(std::llround(data[at++]));
            if (kind < 0 || kind > 3) {
                error = "A segment kind is line, arc, spline, or nurbs.";
                return false;
            }
            if (nthrough < 0 || nthrough > 200 || !take(static_cast<size_t>(nthrough) * 2)) {
                error = "A loop segment is incomplete.";
                return false;
            }
            seg.kind = static_cast<ProfileSegKind>(kind);
            for (int t = 0; t < nthrough; ++t) {
                seg.through.push_back(data[at++]);
                seg.through.push_back(data[at++]);
            }
            if (seg.kind == ProfileSegKind::Nurbs) {
                if (!take(3)) {
                    error = "A NURBS segment is incomplete.";
                    return false;
                }
                seg.degree = static_cast<int>(std::llround(data[at++]));
                const int nw = static_cast<int>(std::llround(data[at++]));
                const int nk = static_cast<int>(std::llround(data[at++]));
                if (nw < 0 || nw > 204 || nk < 0 || nk > 220 || !take(static_cast<size_t>(nw) + static_cast<size_t>(nk) * 2)) {
                    error = "A NURBS segment is incomplete.";
                    return false;
                }
                seg.weights.reserve(static_cast<size_t>(nw));
                for (int w = 0; w < nw; ++w) {
                    seg.weights.push_back(data[at++]);
                }
                seg.knots.reserve(static_cast<size_t>(nk));
                seg.mults.reserve(static_cast<size_t>(nk));
                for (int k = 0; k < nk; ++k) {
                    seg.knots.push_back(data[at++]);
                }
                for (int k = 0; k < nk; ++k) {
                    seg.mults.push_back(static_cast<int>(std::llround(data[at++])));
                }
            }
            if (seg.kind == ProfileSegKind::Line && nthrough != 0) {
                error = "A line has no point between its ends.";
                return false;
            }
            if (seg.kind == ProfileSegKind::Arc && nthrough != 1) {
                error = "An arc needs one point between its ends.";
                return false;
            }
            if (seg.kind == ProfileSegKind::Spline && nthrough < 1) {
                error = "A spline needs a point between its ends.";
                return false;
            }
            loop.segments.push_back(std::move(seg));
        }
        loops.push_back(std::move(loop));
    }
    used = static_cast<int>(at);
    return true;
}

TopoDS_Shape build_extrude_loops(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    double depth,
    bool symmetric,
    double& volume,
    std::string& error) {
    const ProfileFrame frame = frame_from(origin, turn);
    std::vector<std::vector<ProfileLoop>> groups;
    int deepest = 0;
    if (!group_loops(frame, loops, groups, deepest, error)) {
        return {};
    }
    if (!std::isfinite(depth) || !(std::abs(depth) > kTinyMm)) {
        error = "An extrude needs a depth other than 0.";
        return {};
    }
    const double length = std::abs(depth);
    const double start = symmetric ? -length / 2.0 : std::min(depth, 0.0);
    // Each outline with its holes is its own prism; every prism meets the part in one boolean.
    std::vector<TopoDS_Shape> tools;
    tools.reserve(groups.size());
    for (const std::vector<ProfileLoop>& group : groups) {
        const TopoDS_Face face = group_face(frame, group, start, error);
        if (face.IsNull()) {
            return {};
        }
        BRepPrimAPI_MakePrism prism(face, gp_Vec(frame.w) * length);
        const TopoDS_Shape tool = built(prism, "extrude", error);
        if (tool.IsNull()) {
            return {};
        }
        tools.push_back(tool);
    }
    return combine_profile_tools(current, before, which, tools, "extrude", volume, error);
}

namespace {

/// The face's boundary on the profile plane as [u, v] pairs, from its drawn curves: what a draft's closing check reads.
std::vector<double> face_outline_uv(const ProfileFrame& frame, const TopoDS_Shape& face) {
    std::vector<double> outline;
    for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
        BRepAdaptor_Curve curve(TopoDS::Edge(it.Current()));
        GCPnts_QuasiUniformDeflection sampler(curve, 0.01);
        if (!sampler.IsDone()) {
            continue;
        }
        for (int i = 1; i <= sampler.NbPoints(); ++i) {
            const gp_Vec at(frame.origin, sampler.Value(i));
            outline.push_back(at.Dot(gp_Vec(frame.u)));
            outline.push_back(at.Dot(gp_Vec(frame.v)));
        }
    }
    return outline;
}

/// A face on the profile plane pushed by `extent` as one tool, before it meets the part: a draft, two depths, or a
/// plain prism. A face with holes is drafted outline first, each hole the other way, and the holes cut in one boolean.
TopoDS_Shape face_tool(
    const ProfileFrame& frame,
    const TopoDS_Face& face,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    std::string& error) {
    const bool has_draft = extent.has_draft && std::abs(extent.draft_deg) > 1e-9;
    const auto lifted = [&](const TopoDS_Shape& shape, double lift) {
        if (std::abs(lift) <= 1e-15) {
            return TopoDS::Face(shape);
        }
        gp_Trsf move;
        move.SetTranslation(gp_Vec(frame.w) * lift);
        return TopoDS::Face(BRepBuilderAPI_Transform(shape, move, Standard_True).Shape());
    };
    std::vector<TopoDS_Wire> wires;
    const TopoDS_Wire outer = BRepTools::OuterWire(face);
    for (TopExp_Explorer it(face, TopAbs_WIRE); it.More(); it.Next()) {
        const TopoDS_Wire wire = TopoDS::Wire(it.Current());
        if (!wire.IsSame(outer)) {
            wires.push_back(wire);
        }
    }
    const gp_Pln plane(gp_Ax3(frame.origin, frame.w, frame.u));
    const auto one = [&](const TopoDS_Face& shape, const ExtrudeExtent& with) {
        const std::vector<double> outline = face_outline_uv(frame, shape);
        double ignored = 0.0;
        return extent_from_face(
            TopoDS_Shape(),
            0.0,
            "fuse",
            frame,
            [&](double lift, std::string&) { return lifted(shape, lift); },
            [&](double shrink) { return outline.size() >= 2 && k3_draft_closes(outline, shrink); },
            depth,
            symmetric,
            with,
            ignored,
            error);
    };
    if (!has_draft || wires.empty()) {
        return one(face, extent);
    }
    BRepBuilderAPI_MakeFace outline_face(plane, outer, Standard_True);
    if (!outline_face.IsDone()) {
        error = "Open CASCADE did not build the profile";
        return {};
    }
    TopoDS_Shape tool = one(outline_face.Face(), extent);
    if (tool.IsNull()) {
        return {};
    }
    ExtrudeExtent inward = extent;
    inward.draft_deg = -extent.draft_deg;
    std::vector<TopoDS_Shape> holes;
    for (const TopoDS_Wire& wire : wires) {
        BRepBuilderAPI_MakeFace hole_face(plane, wire, Standard_True);
        if (!hole_face.IsDone()) {
            error = "Open CASCADE did not build the profile";
            return {};
        }
        TopoDS_Face hole = hole_face.Face();
        BRepAdaptor_Surface surface(hole);
        gp_Dir normal = surface.Plane().Axis().Direction();
        if (hole.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        if (normal.Dot(frame.w) < 0.0) {
            hole.Reverse();
        }
        const TopoDS_Shape drafted = one(hole, inward);
        if (drafted.IsNull()) {
            if (error == "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.") {
                error = "This draft closes a hole before the depth. Use a smaller angle or a shorter depth.";
            }
            return {};
        }
        holes.push_back(drafted);
    }
    double tool_volume = volume_of(tool);
    double cut_volume = 0.0;
    return combine_profile_tools(tool, tool_volume, "cut", holes, "extrude", cut_volume, error);
}

}  // namespace

TopoDS_Shape build_extrude_loops_extent(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    double& volume,
    std::string& error) {
    const bool has_draft = extent.has_draft && std::abs(extent.draft_deg) > 1e-9;
    if (!has_draft && !extent.has_depth2 && !extent.has_up_to) {
        return build_extrude_loops(current, before, which, origin, turn, loops, depth, symmetric, volume, error);
    }
    const ProfileFrame frame = frame_from(origin, turn);
    std::vector<std::vector<ProfileLoop>> groups;
    int deepest = 0;
    if (!group_loops(frame, loops, groups, deepest, error)) {
        return {};
    }
    if (extent.has_up_to && groups.size() > 1) {
        error = "An extrude up to a face takes one outline. Give each outline its own extrude.";
        return {};
    }
    if (extent.has_up_to) {
        const std::vector<ProfileLoop>& group = groups.front();
        return extent_from_face(
            current,
            before,
            which,
            frame,
            [&](double lift, std::string& message) { return group_face(frame, group, lift, message); },
            [&](double) { return false; },
            depth,
            symmetric,
            extent,
            volume,
            error);
    }
    if (which != "fuse" && which != "cut" && which != "common") {
        error = "The boolean is fuse, cut, or common";
        return {};
    }
    std::vector<TopoDS_Shape> tools;
    tools.reserve(groups.size());
    for (const std::vector<ProfileLoop>& group : groups) {
        const TopoDS_Face face = group_face(frame, group, 0.0, error);
        if (face.IsNull()) {
            return {};
        }
        const TopoDS_Shape tool = face_tool(frame, face, depth, symmetric, extent, error);
        if (tool.IsNull()) {
            if (error.empty()) {
                error = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
            }
            return {};
        }
        tools.push_back(tool);
    }
    return combine_profile_tools(current, before, which, tools, "extrude", volume, error);
}

namespace {

/// The unit tangent of `edge` leaving `vertex`, and the edge's length. False when the vertex is not one of its ends.
bool leaving(const TopoDS_Edge& edge, const TopoDS_Vertex& vertex, gp_Vec& along, double& length) {
    BRepAdaptor_Curve curve(edge);
    const double t0 = curve.FirstParameter();
    const double t1 = curve.LastParameter();
    if (!std::isfinite(t0) || !std::isfinite(t1)) {
        return false;
    }
    const double t = BRep_Tool::Parameter(vertex, edge);
    gp_Pnt point;
    gp_Vec d1;
    curve.D1(t, point, d1);
    if (!(d1.SquareMagnitude() > 1e-18)) {
        return false;
    }
    along = std::abs(t - t0) <= std::abs(t - t1) ? d1 : -d1;
    along.Normalize();
    GProp_GProps props;
    BRepGProp::LinearProperties(edge, props);
    length = props.Mass();
    return true;
}

/// The face with every corner rounded to `radius`. A corner whose edges are too short for it gets the largest radius
/// that leaves 10 % of the shorter edge straight on each side, and one that still does not fit stays sharp. Each
/// corner is counted in `counts`. A rounding the kernel cannot build gives the face back as it was.
TopoDS_Face round_corners(const TopoDS_Face& face, double radius, CellCounts& counts) {
    TopTools_IndexedDataMapOfShapeListOfShape ancestors;
    TopExp::MapShapesAndAncestors(face, TopAbs_VERTEX, TopAbs_EDGE, ancestors);
    BRepFilletAPI_MakeFillet2d maker;
    try {
        maker.Init(face);
    } catch (const Standard_Failure&) {
        return face;
    }
    int full = 0;
    int reduced = 0;
    int sharp = 0;
    for (int i = 1; i <= ancestors.Extent(); ++i) {
        const TopoDS_Vertex vertex = TopoDS::Vertex(ancestors.FindKey(i));
        const TopTools_ListOfShape& edges = ancestors.FindFromIndex(i);
        if (edges.Extent() != 2) {
            continue;
        }
        const TopoDS_Edge a = TopoDS::Edge(edges.First());
        const TopoDS_Edge b = TopoDS::Edge(edges.Last());
        gp_Vec da;
        gp_Vec db;
        double la = 0.0;
        double lb = 0.0;
        if (!leaving(a, vertex, da, la) || !leaving(b, vertex, db, lb)) {
            continue;
        }
        const double angle = da.Angle(db);
        if (angle > kPi - 1e-3) {
            continue;
        }
        double r = std::min(radius, 0.45 * std::min(la, lb) * std::tan(angle / 2.0));
        bool done = false;
        for (int attempt = 0; attempt < 3 && r >= 0.05; ++attempt) {
            try {
                maker.AddFillet(vertex, r);
                if (maker.Status() == ChFi2d_IsDone) {
                    done = true;
                    break;
                }
            } catch (const Standard_Failure&) {
            }
            r *= 0.5;
        }
        if (!done) {
            sharp += 1;
        } else if (r < radius - 1e-9) {
            reduced += 1;
        } else {
            full += 1;
        }
    }
    if (full + reduced == 0) {
        counts.sharp += sharp;
        return face;
    }
    TopoDS_Face rounded;
    try {
        maker.Build();
        if (maker.IsDone()) {
            for (TopExp_Explorer it(maker.Shape(), TopAbs_FACE); it.More(); it.Next()) {
                rounded = TopoDS::Face(it.Current());
                break;
            }
        }
    } catch (const Standard_Failure&) {
        rounded.Nullify();
    }
    if (rounded.IsNull() || !BRepCheck_Analyzer(rounded).IsValid()) {
        counts.sharp += full + reduced + sharp;
        return face;
    }
    counts.full += full;
    counts.reduced += reduced;
    counts.sharp += sharp;
    return rounded;
}

/// The face turned so its normal points along W, as a profile's face does.
TopoDS_Face facing(const TopoDS_Face& face, const gp_Dir& w) {
    TopoDS_Face out = face;
    BRepAdaptor_Surface surface(out);
    if (surface.GetType() == GeomAbs_Plane) {
        gp_Dir normal = surface.Plane().Axis().Direction();
        if (out.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        if (normal.Dot(w) < 0.0) {
            out.Reverse();
        }
    }
    return out;
}

double face_area(const TopoDS_Shape& face) {
    GProp_GProps props;
    BRepGProp::SurfaceProperties(face, props);
    return std::abs(props.Mass());
}

}  // namespace

TopoDS_Shape build_extrude_cells(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    const std::vector<ProfileLoop>& clip,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    double corner_radius,
    double min_area,
    CellCounts& counts,
    double& volume,
    std::string& error) {
    counts = CellCounts();
    if (extent.has_up_to) {
        error = "Cells stop at a depth, not at a face.";
        return {};
    }
    if (!std::isfinite(corner_radius) || corner_radius < 0.0 || !std::isfinite(min_area) || min_area < 0.0) {
        error = "A cell's corner radius and smallest area are 0 or more.";
        return {};
    }
    if (which != "fuse" && which != "cut" && which != "common") {
        error = "The boolean is fuse, cut, or common";
        return {};
    }
    const ProfileFrame frame = frame_from(origin, turn);
    std::vector<std::vector<ProfileLoop>> groups;
    int deepest = 0;
    if (!group_loops(frame, loops, groups, deepest, error)) {
        return {};
    }
    // The region the cells are clipped to: its faces, and the box of each of its edges, so a cell well inside or well
    // outside is told by one point and only a cell across the boundary is clipped.
    std::vector<TopoDS_Face> region;
    std::vector<Bnd_Box> boundary;
    TopTools_ListOfShape region_list;
    if (!clip.empty()) {
        std::vector<std::vector<ProfileLoop>> clip_groups;
        int clip_deepest = 0;
        std::string message;
        if (!group_loops(frame, clip, clip_groups, clip_deepest, message)) {
            error = "The region to clip to: " + message;
            return {};
        }
        for (const std::vector<ProfileLoop>& group : clip_groups) {
            const TopoDS_Face face = group_face(frame, group, 0.0, message);
            if (face.IsNull()) {
                error = "The region to clip to: " + message;
                return {};
            }
            region.push_back(face);
            region_list.Append(face);
            for (TopExp_Explorer it(face, TopAbs_EDGE); it.More(); it.Next()) {
                Bnd_Box box;
                BRepBndLib::Add(it.Current(), box);
                box.Enlarge(1e-5);
                boundary.push_back(box);
            }
        }
    }
    const auto in_region = [&](const gp_Pnt& at) {
        for (const TopoDS_Face& face : region) {
            BRepClass_FaceClassifier inside(face, at, 1e-7);
            if (inside.State() == TopAbs_IN) {
                return true;
            }
        }
        return false;
    };
    std::vector<TopoDS_Shape> tools;
    tools.reserve(groups.size());
    for (const std::vector<ProfileLoop>& group : groups) {
        const TopoDS_Face face = group_face(frame, group, 0.0, error);
        if (face.IsNull()) {
            return {};
        }
        std::vector<TopoDS_Face> pieces;
        bool clipped = false;
        if (region.empty()) {
            pieces.push_back(face);
        } else {
            Bnd_Box box;
            BRepBndLib::Add(face, box);
            const bool across = std::any_of(boundary.begin(), boundary.end(), [&](const Bnd_Box& edge) { return !edge.IsOut(box); });
            if (!across) {
                if (in_region(frame.at(group.front().start[0], group.front().start[1]))) {
                    pieces.push_back(face);
                } else {
                    counts.outside += 1;
                }
            } else {
                BRepAlgoAPI_Common common;
                TopTools_ListOfShape objects;
                objects.Append(face);
                common.SetArguments(objects);
                common.SetTools(region_list);
                common.SetFuzzyValue(1.0e-7);
                common.SetNonDestructive(Standard_True);
                common.Build();
                if (common.IsDone() && !common.HasErrors()) {
                    for (TopExp_Explorer it(common.Shape(), TopAbs_FACE); it.More(); it.Next()) {
                        pieces.push_back(TopoDS::Face(it.Current()));
                    }
                }
                clipped = true;
                if (pieces.empty()) {
                    counts.outside += 1;
                }
            }
        }
        for (const TopoDS_Face& piece : pieces) {
            if (face_area(piece) < std::max(min_area, 1e-6)) {
                counts.small += 1;
                continue;
            }
            TopoDS_Face shaped = corner_radius > 0.0 ? round_corners(piece, corner_radius, counts) : piece;
            shaped = facing(shaped, frame.w);
            std::string message;
            const TopoDS_Shape tool = face_tool(frame, shaped, depth, symmetric, extent, message);
            if (tool.IsNull()) {
                counts.failed += 1;
                if (counts.first_failure.empty()) {
                    counts.first_failure = message.empty() ? "Open CASCADE did not build the cell." : message;
                }
                continue;
            }
            tools.push_back(tool);
            counts.cells += 1;
            if (clipped) {
                counts.clipped += 1;
            }
        }
    }
    if (tools.empty()) {
        error = counts.failed > 0 ? "No cell could be built: " + counts.first_failure
                                  : "No cell is left inside the region. Use smaller cells, a smaller margin, or a smaller minArea.";
        return {};
    }
    return combine_profile_tools(current, before, which, tools, "extrude", volume, error);
}

TopoDS_Shape build_revolve_loops(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    const double* axis,
    double angle_deg,
    double& volume,
    std::string& error) {
    const ProfileFrame frame = frame_from(origin, turn);
    const TopoDS_Face face = profile_loops_face(frame, loops, 0.0, error);
    if (face.IsNull()) {
        return {};
    }
    if (!std::isfinite(angle_deg) || !(angle_deg > 1e-6) || angle_deg > 360.0 + 1e-9) {
        error = "A revolve needs an angle above 0 and at most 360 degrees.";
        return {};
    }
    const double length = std::hypot(axis[2], axis[3]);
    if (!std::isfinite(length) || !(length > 1e-9) || !std::isfinite(axis[0]) || !std::isfinite(axis[1])) {
        error = "The revolve axis needs a direction in the profile's plane.";
        return {};
    }
    double unit[4] = {axis[0], axis[1], axis[2] / length, axis[3] / length};
    if (crosses_axis(frame, face, unit)) {
        error = "The profile crosses the revolve axis. Keep it on one side.";
        return {};
    }
    const gp_Vec along = gp_Vec(frame.u) * unit[2] + gp_Vec(frame.v) * unit[3];
    const gp_Ax1 turn_axis(frame.at(axis[0], axis[1]), gp_Dir(along));
    const double angle = std::min(angle_deg, 360.0) * kPi / 180.0;
    BRepPrimAPI_MakeRevol revol(face, turn_axis, angle, Standard_True);
    TopoDS_Shape tool = built(revol, "revolve", error);
    if (tool.IsNull()) {
        return {};
    }
    GProp_GProps props;
    integrate(tool, props);
    if (props.Mass() < 0.0) {
        tool.Reverse();
    }
    return combine_profile(current, before, which, tool, "revolve", volume, error);
}

TopoDS_Shape build_loft_loops(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const std::vector<LoftSection>& sections,
    bool ruled,
    double& volume,
    std::string& error) {
    if (sections.size() < 2) {
        error = "A loft needs at least 2 sections.";
        return {};
    }
    if (sections.size() > 200) {
        error = "A loft takes at most 200 sections.";
        return {};
    }
    struct Wires {
        TopoDS_Wire outer;
        std::vector<TopoDS_Wire> holes;
    };
    std::vector<Wires> built_sections;
    for (size_t i = 0; i < sections.size(); ++i) {
        const LoftSection& section = sections[i];
        const std::string prefix = "Section " + std::to_string(i) + ": ";
        Wires wires;
        if (!section.loops.empty()) {
            if (section.radius > 0.0 || !section.profile.points.empty()) {
                error = prefix + "A section takes a radius, a profile, or loops, not more than one.";
                return {};
            }
            const ProfileFrame frame = frame_of(section.profile);
            std::vector<ProfileLoop> loops = section.loops;
            if (!loops_readable(loops, error)) {
                error = prefix + error;
                return {};
            }
            orient_loops(loops);
            std::vector<std::vector<TopoDS_Edge>> groups;
            for (const ProfileLoop& loop : loops) {
                std::vector<TopoDS_Edge> edges;
                double from[2] = {loop.start[0], loop.start[1]};
                for (const ProfileSeg& seg : loop.segments) {
                    TopoDS_Edge edge = loop_edge(frame, from, seg, 0.0, error);
                    if (edge.IsNull()) {
                        error = prefix + (error.empty() ? "Open CASCADE did not build the profile" : error);
                        return {};
                    }
                    edges.push_back(edge);
                    from[0] = seg.to[0];
                    from[1] = seg.to[1];
                }
                groups.push_back(std::move(edges));
            }
            if (edges_cross(groups, error)) {
                error = prefix + error;
                return {};
            }
            for (size_t w = 0; w < groups.size(); ++w) {
                TopoDS_Wire wire = wire_of(groups[w], error);
                if (wire.IsNull()) {
                    error = prefix + (error.empty() ? "Open CASCADE did not join the loop into one outline." : error);
                    return {};
                }
                if (w == 0) {
                    wires.outer = wire;
                } else {
                    wires.holes.push_back(wire);
                }
            }
            const gp_Pln plane(gp_Ax3(frame.origin, frame.w, frame.u));
            BRepBuilderAPI_MakeFace outer_face(plane, wires.outer, Standard_True);
            if (!outer_face.IsDone()) {
                error = prefix + "Open CASCADE did not build the profile";
                return {};
            }
            for (size_t h = 0; h < wires.holes.size(); ++h) {
                const gp_Pnt at = frame.at(loops[h + 1].start[0], loops[h + 1].start[1]);
                BRepClass_FaceClassifier inside(outer_face.Face(), at, 1e-7);
                if (inside.State() != TopAbs_IN) {
                    error = prefix + "A loop lies outside the first one. A loft section takes one outline (its first loop) with "
                                     "its holes inside it: loft each outline in its own op; model_apply_batch with combine "
                                     "applies them in one step.";
                    return {};
                }
            }
        } else {
            wires.outer = section_wire(section, error);
            if (wires.outer.IsNull()) {
                error = prefix + (error.empty() ? "it could not be built." : error);
                return {};
            }
        }
        built_sections.push_back(std::move(wires));
    }
    const size_t holes = built_sections.front().holes.size();
    for (const Wires& wires : built_sections) {
        if (wires.holes.size() != holes) {
            error = "Each loft section needs the same number of holes.";
            return {};
        }
    }
    std::vector<TopoDS_Wire> outers;
    for (const Wires& wires : built_sections) {
        outers.push_back(wires.outer);
    }
    TopoDS_Shape tool = loft_wires(outers, ruled, error);
    if (tool.IsNull()) {
        return {};
    }
    for (size_t h = 0; h < holes; ++h) {
        std::vector<TopoDS_Wire> channel;
        for (const Wires& wires : built_sections) {
            channel.push_back(wires.holes[h]);
        }
        std::string hole_error;
        const TopoDS_Shape hole = loft_wires(channel, ruled, hole_error);
        if (hole.IsNull()) {
            error = hole_error.empty() ? "A hole could not be lofted through these sections." : "A hole could not be lofted. " + hole_error;
            return {};
        }
        tool = boolean_op("cut", tool, hole, error);
        if (!error.empty() || tool.IsNull()) {
            if (error.empty()) {
                error = "A lofted hole did not cut the outline.";
            }
            return {};
        }
        if (!has_solid(tool)) {
            error = "A lofted hole did not leave a solid.";
            return {};
        }
        tool = as_solid(tool);
    }
    return combine_profile(current, before, which, tool, "loft", volume, error);
}

/// Open CASCADE's thick solid, joined at `join`. Null when it fails or the result is not a valid solid.
TopoDS_Shape thick_solid(const TopoDS_Shape& solid, const TopTools_ListOfShape& open, double thickness, GeomAbs_JoinType join) {
    try {
        BRepOffsetAPI_MakeThickSolid maker;
        maker.MakeThickSolidByJoin(solid, open, -thickness, 1.0e-4, BRepOffset_Skin, Standard_False, Standard_False, join);
        maker.Build();
        if (!maker.IsDone() || maker.Shape().IsNull()) {
            return {};
        }
        const TopoDS_Shape out = maker.Shape();
        if (!has_solid(out) || !BRepCheck_Analyzer(out).IsValid()) {
            return {};
        }
        return out;
    } catch (const Standard_Failure&) {
        return {};
    }
}

/// A closed part hollowed with no face open: the part's own shell, and the shell offset inward, turned to face the void.
TopoDS_Shape closed_shell(const TopoDS_Shape& solid, double thickness, GeomAbs_JoinType join) {
    try {
        BRepOffsetAPI_MakeOffsetShape offset;
        offset.PerformByJoin(solid, -thickness, 1.0e-4, BRepOffset_Skin, Standard_False, Standard_False, join);
        if (!offset.IsDone() || offset.Shape().IsNull()) {
            return {};
        }
        TopoDS_Shape outer;
        TopoDS_Shape inner;
        for (TopExp_Explorer it(solid, TopAbs_SHELL); it.More(); it.Next()) {
            if (!outer.IsNull()) {
                return {};
            }
            outer = it.Current();
        }
        for (TopExp_Explorer it(offset.Shape(), TopAbs_SHELL); it.More(); it.Next()) {
            if (!inner.IsNull()) {
                return {};
            }
            inner = it.Current();
        }
        if (outer.IsNull() || inner.IsNull()) {
            return {};
        }
        TopoDS_Solid hollow;
        BRep_Builder builder;
        builder.MakeSolid(hollow);
        builder.Add(hollow, outer);
        builder.Add(hollow, inner.Reversed());
        if (!BRepCheck_Analyzer(hollow).IsValid()) {
            return {};
        }
        return hollow;
    } catch (const Standard_Failure&) {
        return {};
    }
}

TopoDS_Shape build_shell(
    const TopoDS_Shape& current,
    double before,
    const std::vector<TopoDS_Face>& open,
    double thickness,
    double& volume,
    std::string& error) {
    if (!std::isfinite(thickness) || !(thickness > kTinyMm)) {
        error = "A shell needs a wall thickness above 0.";
        return {};
    }
    if (count_of(current, TopAbs_SOLID) != 1) {
        error = "Shell works on a part of one body.";
        return {};
    }
    const TopoDS_Shape solid = as_solid(current);
    if (count_of(solid, TopAbs_SHELL) != 1) {
        error = "This part is hollow already.";
        return {};
    }
    if (!open.empty() && static_cast<int>(open.size()) >= count_of(solid, TopAbs_FACE)) {
        error = "A shell needs at least one face left closed.";
        return {};
    }
    TopTools_ListOfShape faces;
    for (const TopoDS_Face& face : open) {
        faces.Append(face);
    }
    g_stats.builds += 1;
    // Sharp inner corners first, as a CAD shell makes them; rounded ones when Open CASCADE cannot intersect the walls.
    TopoDS_Shape out;
    for (GeomAbs_JoinType join : {GeomAbs_Intersection, GeomAbs_Arc}) {
        out = open.empty() ? closed_shell(solid, thickness, join) : thick_solid(solid, faces, thickness, join);
        if (!out.IsNull()) {
            out = as_solid(out);
            volume = volume_of(out);
            if (volume > 1e-6 && volume < before - 1e-6) {
                return out;
            }
        }
    }
    error = "This wall is too thick for the part's smallest feature.";
    return {};
}

std::vector<int> edge_kinds(const TopoDS_Shape& shape, const std::vector<TopoDS_Edge>& edges) {
    std::vector<int> kinds(edges.size(), 0);
    TopTools_IndexedDataMapOfShapeListOfShape ancestors;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, ancestors);
    for (size_t i = 0; i < edges.size(); ++i) {
        const TopTools_ListOfShape* faces = ancestors.Seek(edges[i]);
        if (faces == nullptr || BRep_Tool::Degenerated(edges[i])) {
            continue;
        }
        std::vector<TopoDS_Face> unique;
        for (TopTools_ListIteratorOfListOfShape it(*faces); it.More(); it.Next()) {
            const TopoDS_Face face = TopoDS::Face(it.Value());
            if (std::none_of(unique.begin(), unique.end(), [&face](const TopoDS_Face& have) { return face.IsSame(have); })) {
                unique.push_back(face);
            }
        }
        if (unique.size() != 2) {
            continue;
        }
        try {
            if (BRep_Tool::Continuity(edges[i], unique[0], unique[1]) >= GeomAbs_G1) {
                continue;
            }
            const ChFiDS_TypeOfConcavity kind = ChFi3d::DefineConnectType(edges[i], unique[0], unique[1], 1.0e-4, Standard_False);
            kinds[i] = kind == ChFiDS_Convex ? 1 : kind == ChFiDS_Concave ? 2 : 0;
        } catch (const Standard_Failure&) {
        }
    }
    return kinds;
}

// --- K4: faceExtrude, moveFaces, faceLoops. Keep this block together. ---

/// How far a positive prism is pushed into the solid so the fuse overlaps instead of only touching.
constexpr double kFaceOverlapMm = 1e-3;

const char* kCannotMove =
    "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt.";

/// Alt on a face that is a whole closed shell: a prism sweeps a face's outline, and this one has none.
const char* kWholePartPrism =
    "Alt adds a prism on a face's outline, and this face is the whole part, so it has none. Drag without Alt to grow or "
    "shrink the part all round.";

/// Alt on a closed face that is not the whole part, such as a ball-shaped void's wall.
const char* kClosedPrism =
    "Alt adds a prism on a face's outline, and this closed surface has none. Drag without Alt to move all of it.";

/// Closed faces, moved as whole surfaces, that Open CASCADE could still not offset. `only` when the face is the part.
std::string closed_failed(double distance, bool only) {
    const std::string mm = tenths(distance);
    if (only) {
        return "This face is the whole part, and Open CASCADE could not move all of it " + mm + " mm. Try a smaller distance.";
    }
    return "Open CASCADE could not move this closed surface " + mm + " mm as one.";
}

/// The only face of a solid offset as one surface. Open CASCADE's simple offset handles a closed freeform face (a
/// stretched sphere) that the joined offset cannot. Null when it fails or the result is not a valid solid.
TopoDS_Shape simple_offset(const TopoDS_Shape& solid, double distance) {
    try {
        BRepOffsetAPI_MakeOffsetShape offset;
        offset.PerformBySimple(solid, distance);
        if (!offset.IsDone() || offset.Shape().IsNull() || !has_solid(offset.Shape())) {
            return {};
        }
        const TopoDS_Shape out = as_solid(offset.Shape());
        if (!BRepCheck_Analyzer(out).IsValid()) {
            return {};
        }
        return out;
    } catch (const Standard_Failure&) {
        return {};
    }
}

/// Outward unit normal at the face midpoint. A reversed face is flipped so the solid's outside stays positive.
bool outward_normal(const TopoDS_Face& face, gp_Dir& normal) {
    try {
        BRepAdaptor_Surface surface(face);
        const double u0 = surface.FirstUParameter();
        const double u1 = surface.LastUParameter();
        const double v0 = surface.FirstVParameter();
        const double v1 = surface.LastVParameter();
        if (!std::isfinite(u0) || !std::isfinite(u1) || !std::isfinite(v0) || !std::isfinite(v1)) {
            return false;
        }
        gp_Pnt point;
        gp_Vec du;
        gp_Vec dv;
        surface.D1((u0 + u1) * 0.5, (v0 + v1) * 0.5, point, du, dv);
        gp_Vec crossed = du.Crossed(dv);
        if (!(crossed.SquareMagnitude() > 1e-18)) {
            return false;
        }
        if (face.Orientation() == TopAbs_REVERSED) {
            crossed.Reverse();
        }
        crossed.Normalize();
        normal = gp_Dir(crossed);
        return true;
    } catch (const Standard_Failure&) {
        return false;
    }
}

bool face_is_plane(const TopoDS_Face& face) {
    try {
        return BRepAdaptor_Surface(face).GetType() == GeomAbs_Plane;
    } catch (const Standard_Failure&) {
        return false;
    }
}

/// A feature prism's result, or the refusal. `before` is the solid's volume.
template <typename Maker>
TopoDS_Shape feature_result(Maker& maker, double before, double& volume, std::string& error) {
    if (!maker.IsDone() || maker.Shape().IsNull() || !has_solid(maker.Shape())) {
        error = "Open CASCADE could not extrude this face.";
        return {};
    }
    TopoDS_Shape out = as_solid(maker.Shape());
    try {
        if (!BRepCheck_Analyzer(out).IsValid()) {
            error = "Open CASCADE could not extrude this face.";
            return {};
        }
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not extrude this face.";
        return {};
    }
    volume = volume_of(out);
    if (!(volume > 1e-6) || std::abs(volume - before) <= 1e-6 * std::max(1.0, before)) {
        error = "The face extrude does not change the part.";
        return {};
    }
    return out;
}

TopoDS_Shape build_face_extrude(
    const TopoDS_Shape& current,
    double before,
    const TopoDS_Face& face,
    double distance,
    double draft_deg,
    const TopoDS_Face* up_to,
    double& volume,
    std::string& error) {
    if (!std::isfinite(distance) || !(std::abs(distance) > kTinyMm)) {
        error = "A face extrude needs a distance other than 0.";
        return {};
    }
    if (!std::isfinite(draft_deg) || draft_deg < -89.0 || draft_deg > 89.0) {
        error = "The draft angle must be between -89 and 89 degrees.";
        return {};
    }
    if (up_to != nullptr && up_to->IsSame(face)) {
        error = "A face cannot stop at itself.";
        return {};
    }
    if (count_of(current, TopAbs_SOLID) != 1) {
        error = "Push or pull works on a part of one body.";
        return {};
    }
    if (face_is_closed(face)) {
        error = count_of(current, TopAbs_FACE) == 1 ? kWholePartPrism : kClosedPrism;
        return {};
    }
    gp_Dir normal;
    if (!outward_normal(face, normal)) {
        error = "This face has no direction to extrude along.";
        return {};
    }
    const bool drafted = std::abs(draft_deg) > 1e-9;
    const TopoDS_Shape base = as_solid(current);
    gp_Dir direction(normal);
    if (distance < 0.0) {
        direction.Reverse();
    }
    const int fuse = distance > 0.0 ? 1 : 0;
    if (drafted || up_to != nullptr) {
        g_stats.builds += 1;
        try {
            if (drafted) {
                BRepFeat_MakeDPrism maker(base, face, face, draft_deg * kPi / 180.0, fuse, Standard_False);
                if (up_to != nullptr) {
                    maker.Perform(*up_to);
                } else {
                    maker.Perform(std::abs(distance));
                }
                return feature_result(maker, before, volume, error);
            }
            BRepFeat_MakePrism maker(base, face, face, direction, fuse, Standard_False);
            if (up_to != nullptr) {
                maker.Perform(*up_to);
            } else {
                maker.Perform(std::abs(distance));
            }
            return feature_result(maker, before, volume, error);
        } catch (const Standard_Failure&) {
            error = "Open CASCADE could not extrude this face.";
            return {};
        }
    }
    // A forward copy, so a reversed face of the solid still sweeps the way its outward normal points.
    TopoDS_Face profile = face;
    profile.Orientation(TopAbs_FORWARD);
    double length = std::abs(distance);
    if (distance > 0.0 && face_is_plane(face)) {
        gp_Trsf shift;
        shift.SetTranslation(gp_Vec(normal) * -kFaceOverlapMm);
        profile = TopoDS::Face(profile.Moved(TopLoc_Location(shift)));
        length += kFaceOverlapMm;
    }
    const gp_Vec along = gp_Vec(normal) * (distance > 0.0 ? length : -length);
    try {
        BRepPrimAPI_MakePrism prism(profile, along);
        prism.Build();
        if (!prism.IsDone() || prism.Shape().IsNull()) {
            error = "Open CASCADE could not extrude this face.";
            return {};
        }
        TopoDS_Shape tool = prism.Shape();
        GProp_GProps props;
        integrate(tool, props);
        if (props.Mass() < 0.0) {
            tool.Reverse();
        }
        return combine_profile(current, before, distance > 0.0 ? "fuse" : "cut", tool, "face extrude", volume, error);
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not extrude this face.";
        return {};
    }
}

TopoDS_Shape build_move_faces(
    const TopoDS_Shape& current,
    double before,
    const std::vector<FaceOffset>& faces,
    double& volume,
    std::string& error) {
    if (faces.empty()) {
        error = "Pick a face to move.";
        return {};
    }
    for (const FaceOffset& row : faces) {
        if (!std::isfinite(row.distance) || !(std::abs(row.distance) > kTinyMm)) {
            error = "A face move needs a distance other than 0.";
            return {};
        }
    }
    if (count_of(current, TopAbs_SOLID) != 1) {
        error = "Push or pull works on a part of one body.";
        return {};
    }
    // A face that is a whole closed shell has no neighbours to follow it: it moves as one surface, up to where it folds.
    bool whole = true;
    for (const FaceOffset& row : faces) {
        if (!face_is_closed(row.face)) {
            whole = false;
            continue;
        }
        const FoldLimits limits = fold_limits(row.face);
        const double most = row.distance < 0.0 ? limits.in : limits.out;
        if (std::abs(row.distance) > most + 1e-9) {
            error = fold_refusal(row.distance, most);
            return {};
        }
    }
    const TopoDS_Shape solid = as_solid(current);
    const bool only = count_of(solid, TopAbs_FACE) == 1;
    const std::string failed = whole ? closed_failed(faces[0].distance, only) : std::string(kCannotMove);
    g_stats.builds += 1;
    TopoDS_Shape out;
    try {
        // Offset 0 on every face, then the moved ones. Intersection joins let the neighbours extend or trim.
        BRepOffset_MakeOffset maker;
        maker.Initialize(solid, 0.0, 1.0e-4, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Intersection);
        for (const FaceOffset& row : faces) {
            maker.SetOffsetOnFace(row.face, row.distance);
        }
        maker.MakeOffsetShape();
        if (maker.IsDone() && !maker.Shape().IsNull() && has_solid(maker.Shape())) {
            out = as_solid(maker.Shape());
            if (!BRepCheck_Analyzer(out).IsValid()) {
                out.Nullify();
            }
        }
    } catch (const Standard_Failure&) {
        out.Nullify();
    }
    // The joined offset gives up on a closed freeform face, such as an ellipsoid's. Alone on its solid, that face
    // moves as one surface, which the simple offset builds.
    if (out.IsNull() && whole && faces.size() == 1 && only) {
        out = simple_offset(solid, faces[0].distance);
    }
    if (out.IsNull()) {
        error = failed;
        return {};
    }
    try {
        volume = volume_of(out);
    } catch (const Standard_Failure&) {
        volume = 0.0;
    }
    if (!(volume > 1e-6) || std::abs(volume - before) <= 1e-6 * std::max(1.0, before)) {
        error = failed;
        return {};
    }
    // One closed surface moved out must grow the part (a void's wall moved out shrinks the void), and moved in must
    // shrink it; anything else has turned inside out. Several, moved different ways, may net either way.
    if (whole && faces.size() == 1 && (faces[0].distance > 0.0) != (volume > before)) {
        error = failed;
        return {};
    }
    return out;
}

/// What `Draft_ErrorStatus` means, without an Open CASCADE class name.
const char* draft_problem(Draft_ErrorStatus status) {
    switch (status) {
        case Draft_FaceRecomputation:
            return "Open CASCADE could not recompute that face for this draft";
        case Draft_EdgeRecomputation:
            return "Open CASCADE could not recompute an edge of that face for this draft";
        case Draft_VertexRecomputation:
            return "Open CASCADE could not recompute a corner of that face for this draft";
        default:
            return "Open CASCADE could not draft that face";
    }
}

GeomAbs_SurfaceType face_surface(const TopoDS_Face& face) {
    try {
        return BRepAdaptor_Surface(face).GetType();
    } catch (const Standard_Failure&) {
        return GeomAbs_OtherSurface;
    }
}

/// The lowest point of `faces` along `pull`: a vertex when the faces have one, else a corner of their box.
bool lowest_along(const std::vector<TopoDS_Face>& faces, const gp_Dir& pull, gp_Pnt& at) {
    bool any = false;
    double best = 0.0;
    const auto consider = [&](const gp_Pnt& point) {
        const double along = pull.X() * point.X() + pull.Y() * point.Y() + pull.Z() * point.Z();
        if (!any || along < best) {
            any = true;
            best = along;
            at = point;
        }
    };
    for (const TopoDS_Face& face : faces) {
        for (TopExp_Explorer exp(face, TopAbs_VERTEX); exp.More(); exp.Next()) {
            consider(BRep_Tool::Pnt(TopoDS::Vertex(exp.Current())));
        }
    }
    if (any) {
        return true;
    }
    Bnd_Box box;
    for (const TopoDS_Face& face : faces) {
        BRepBndLib::Add(face, box);
    }
    if (box.IsVoid()) {
        return false;
    }
    double x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
    box.Get(x0, y0, z0, x1, y1, z1);
    for (const double x : {x0, x1}) {
        for (const double y : {y0, y1}) {
            for (const double z : {z0, z1}) {
                consider(gp_Pnt(x, y, z));
            }
        }
    }
    return any;
}

TopoDS_Shape build_draft(
    const TopoDS_Shape& current,
    double before,
    const std::vector<TopoDS_Face>& faces,
    const std::vector<int>& names,
    double angle_deg,
    const gp_Dir& pull,
    const TopoDS_Face* neutral,
    const gp_Pnt* plane_origin,
    const gp_Dir* plane_normal,
    double& volume,
    std::string& error) {
    if (faces.empty()) {
        error = "Pick a face to draft.";
        return {};
    }
    if (faces.size() > 50) {
        error = "Draft takes at most 50 faces.";
        return {};
    }
    if (!std::isfinite(angle_deg) || angle_deg == 0.0 || angle_deg < -30.0 || angle_deg > 30.0) {
        error = "The draft angle must be between -30 and 30 degrees, and not 0.";
        return {};
    }
    if (count_of(current, TopAbs_SOLID) != 1) {
        error = "Draft works on a part of one body.";
        return {};
    }
    // A refusal names the face as the caller picked it: its index on the solid, not its place in the list.
    const auto face_name = [&](size_t i) {
        return "Face " + std::to_string(names.size() == faces.size() ? names[i] : static_cast<int>(i));
    };
    // A floor faces along the pull. Draft tilts walls, and a face this close to the pull is a floor.
    const double floor_cos = std::cos(1.0 * kPi / 180.0);
    for (size_t i = 0; i < faces.size(); ++i) {
        const GeomAbs_SurfaceType kind = face_surface(faces[i]);
        if (kind != GeomAbs_Plane && kind != GeomAbs_Cylinder && kind != GeomAbs_Cone) {
            error = face_name(i) + " is not a flat, cylindrical, or conical face. Draft tilts walls, not this surface.";
            return {};
        }
        if (kind == GeomAbs_Plane) {
            gp_Dir outward;
            if (!outward_normal(faces[i], outward)) {
                error = face_name(i) + " has no direction, so it cannot be drafted.";
                return {};
            }
            if (std::abs(outward.Dot(pull)) > floor_cos) {
                error = face_name(i) + " is a floor, parallel to the pull. Draft tilts walls, not floors.";
                return {};
            }
        }
    }
    gp_Pln plane;
    if (neutral != nullptr) {
        if (face_surface(*neutral) != GeomAbs_Plane) {
            error = "The neutral face must be flat.";
            return {};
        }
        for (const TopoDS_Face& face : faces) {
            if (face.IsSame(*neutral)) {
                error = "The neutral face is one of the faces being drafted.";
                return {};
            }
        }
        try {
            plane = BRepAdaptor_Surface(*neutral).Plane();
        } catch (const Standard_Failure&) {
            error = "The neutral face must be flat.";
            return {};
        }
        // A floor used as the neutral plane points out of the part. The pull names which side loses matter.
        gp_Dir normal = plane.Axis().Direction();
        if (neutral->Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        if (normal.Dot(pull) < -0.5) {
            plane = gp_Pln(plane.Location(), normal.Reversed());
        }
    } else if (plane_origin != nullptr && plane_normal != nullptr) {
        plane = gp_Pln(*plane_origin, *plane_normal);
    } else {
        gp_Pnt lowest;
        if (!lowest_along(faces, pull, lowest)) {
            error = "Open CASCADE could not find the neutral plane for these faces.";
            return {};
        }
        plane = gp_Pln(lowest, pull);
    }
    const TopoDS_Shape solid = as_solid(current);
    g_stats.builds += 1;
    try {
        BRepOffsetAPI_DraftAngle draft(solid);
        for (size_t i = 0; i < faces.size(); ++i) {
            try {
                draft.Add(faces[i], pull, angle_deg * kPi / 180.0, plane, Standard_True);
            } catch (const Standard_Failure&) {
                error = face_name(i) + ": Open CASCADE could not draft that face.";
                return {};
            }
            if (!draft.AddDone()) {
                const Draft_ErrorStatus status = draft.Status();
                try {
                    const TopoDS_Shape bad = draft.ProblematicShape();
                    if (!bad.IsNull() && bad.ShapeType() == TopAbs_FACE) {
                        draft.Remove(TopoDS::Face(bad));
                    } else {
                        draft.Remove(faces[i]);
                    }
                } catch (const Standard_Failure&) {
                }
                error = face_name(i) + ": " + draft_problem(status) + ".";
                return {};
            }
        }
        draft.Build();
        if (!draft.IsDone() || draft.Shape().IsNull() || !has_solid(draft.Shape())) {
            error = "Open CASCADE could not build this draft: " + std::string(draft_problem(draft.Status())) + ".";
            return {};
        }
        TopoDS_Shape out = as_solid(draft.Shape());
        if (count_of(out, TopAbs_SOLID) != 1 || !BRepCheck_Analyzer(out).IsValid()) {
            error = "Open CASCADE could not build this draft.";
            return {};
        }
        volume = volume_of(out);
        if (!(volume > 1e-6)) {
            error = "Open CASCADE could not build this draft.";
            return {};
        }
        // A draft about a plane through the middle of a wall removes as much as it adds, so the volume alone cannot
        // tell. A tilted face is longer than it was (1 / cos of the angle), so the surface area changes whenever a
        // face really tilts. Nothing changed only when both stay.
        const bool same_volume = std::abs(volume - before) <= 1e-6 * std::max(1.0, before);
        const double area_before = face_area(current);
        const double area_after = face_area(out);
        const bool same_area = std::abs(area_after - area_before) <= 1e-7 * std::max(1.0, area_before);
        if (same_volume && same_area) {
            error = "The draft does not change the part.";
            return {};
        }
        return out;
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not build this draft.";
        return {};
    }
}

namespace {

double clean_mm(double value) {
    return std::isfinite(value) && std::abs(value) >= 1e-9 ? value : 0.0;
}

/// Degrees into −180..180, with a half turn shown as 180, as `wrapDeg`.
double wrap_deg(double deg) {
    if (!std::isfinite(deg)) {
        return 0.0;
    }
    double wrapped = std::fmod(deg + 180.0, 360.0);
    if (wrapped < 0.0) {
        wrapped += 360.0;
    }
    wrapped -= 180.0;
    if (wrapped == -180.0) {
        return 180.0;
    }
    return wrapped == 0.0 ? 0.0 : wrapped;
}

int dominant_axis(const gp_Dir& normal) {
    const double ax = std::abs(normal.X());
    const double ay = std::abs(normal.Y());
    const double az = std::abs(normal.Z());
    if (ax >= ay && ax >= az) {
        return 0;
    }
    return ay >= az ? 1 : 2;
}

gp_Vec world_axis(int index) {
    return index == 0 ? gp_Vec(1, 0, 0) : index == 1 ? gp_Vec(0, 1, 0) : gp_Vec(0, 0, 1);
}

/// U and V of a face that looks up or down: the world axis after the normal's nearest one, made square to it.
void in_plane_axes(const gp_Dir& normal, gp_Vec& u, gp_Vec& v) {
    const gp_Vec n(normal);
    gp_Vec raw = world_axis((dominant_axis(normal) + 1) % 3);
    raw -= n * raw.Dot(n);
    if (!(raw.SquareMagnitude() > 1e-18)) {
        raw = gp_Vec(1, 0, 0);
    }
    raw.Normalize();
    u = raw;
    v = n.Crossed(u);
    if (v.SquareMagnitude() > 1e-18) {
        v.Normalize();
    }
}

/// U and V of a side face: V is world-up made square to W, U = V × W.
void side_axes(const gp_Dir& w, gp_Vec& u, gp_Vec& v) {
    gp_Vec raw(-w.X() * w.Z(), -w.Y() * w.Z(), 1.0 - w.Z() * w.Z());
    if (!(raw.SquareMagnitude() > 1e-18)) {
        raw = gp_Vec(0, 0, 1);
    }
    raw.Normalize();
    v = raw;
    u = v.Crossed(gp_Vec(w));
    if (u.SquareMagnitude() > 1e-18) {
        u.Normalize();
    }
}

/// Rx, Ry, Rz of the columns U, V, W, as `orientEuler` reads that matrix.
void euler_of(const gp_Vec& u, const gp_Vec& v, const gp_Vec& w, double turn[3]) {
    const double sy = -u.Z();
    const double cy = std::hypot(u.X(), u.Y());
    const double to_deg = 180.0 / kPi;
    double rx = 0.0;
    double rz = 0.0;
    if (cy > 1e-6) {
        rx = std::atan2(v.Z(), w.Z()) * to_deg;
        rz = std::atan2(u.Y(), u.X()) * to_deg;
    } else {
        rx = std::atan2(-w.Y(), v.Y()) * to_deg;
    }
    turn[0] = wrap_deg(rx);
    turn[1] = wrap_deg(std::atan2(sy, cy) * to_deg);
    turn[2] = wrap_deg(rz);
}

struct LoopSeg {
    /// 0 line, 1 arc, 2 spline.
    int kind = 0;
    gp_Pnt2d to;
    std::vector<gp_Pnt2d> through;
};

gp_Pnt2d project_point(const gp_Pnt& point, const gp_Pnt& origin, const gp_Vec& u, const gp_Vec& v) {
    const gp_Vec from(origin, point);
    return gp_Pnt2d(clean_mm(from.Dot(u)), clean_mm(from.Dot(v)));
}

double loop_area(const gp_Pnt2d& start, const std::vector<LoopSeg>& segs) {
    double area = 0.0;
    gp_Pnt2d prev = start;
    const auto add = [&](const gp_Pnt2d& point) {
        area += prev.X() * point.Y() - point.X() * prev.Y();
        prev = point;
    };
    for (const LoopSeg& seg : segs) {
        for (const gp_Pnt2d& point : seg.through) {
            add(point);
        }
        add(seg.to);
    }
    return area * 0.5;
}

void reverse_loop(gp_Pnt2d& start, std::vector<LoopSeg>& segs) {
    std::vector<gp_Pnt2d> froms;
    froms.push_back(start);
    for (const LoopSeg& seg : segs) {
        froms.push_back(seg.to);
    }
    std::vector<LoopSeg> reversed;
    reversed.reserve(segs.size());
    for (int i = static_cast<int>(segs.size()) - 1; i >= 0; --i) {
        LoopSeg seg = segs[static_cast<size_t>(i)];
        std::reverse(seg.through.begin(), seg.through.end());
        seg.to = froms[static_cast<size_t>(i)];
        reversed.push_back(seg);
    }
    start = froms.back();
    segs = std::move(reversed);
}

/// The wire's segments in its plane. False when the wire has no usable edge.
bool wire_segments(
    const TopoDS_Wire& wire,
    const TopoDS_Face& face,
    const gp_Pnt& origin,
    const gp_Vec& u,
    const gp_Vec& v,
    gp_Pnt2d& start,
    std::vector<LoopSeg>& segs) {
    const auto project = [&](const gp_Pnt& point) { return project_point(point, origin, u, v); };
    bool have_start = false;
    for (BRepTools_WireExplorer explorer(wire, face); explorer.More(); explorer.Next()) {
        const TopoDS_Edge edge = explorer.Current();
        if (BRep_Tool::Degenerated(edge)) {
            continue;
        }
        TopoDS_Vertex first;
        TopoDS_Vertex last;
        TopExp::Vertices(edge, first, last);
        if (first.IsNull() || last.IsNull()) {
            return false;
        }
        const gp_Pnt pa = BRep_Tool::Pnt(first);
        const gp_Pnt pb = BRep_Tool::Pnt(last);
        BRepAdaptor_Curve curve(edge);
        const double t0 = curve.FirstParameter();
        const double t1 = curve.LastParameter();
        if (!std::isfinite(t0) || !std::isfinite(t1)) {
            return false;
        }
        // Vertices are the curve's ends. A reversed edge is walked from its last vertex.
        const bool reversed = edge.Orientation() == TopAbs_REVERSED;
        const gp_Pnt from_pt = reversed ? pb : pa;
        const gp_Pnt to_pt = reversed ? pa : pb;
        const double span = t1 - t0;
        const auto at = [&](double t) { return project(curve.Value(t)); };
        if (!have_start) {
            start = project(from_pt);
            have_start = true;
        }
        const bool closed = pa.Distance(pb) <= 1e-4;
        if (curve.GetType() == GeomAbs_Circle && closed && std::abs(span) > 1.5 * kPi) {
            const double from = reversed ? t1 : t0;
            const double step = reversed ? -span : span;
            LoopSeg first_half;
            first_half.kind = 1;
            first_half.through.push_back(at(from + step * 0.25));
            first_half.to = at(from + step * 0.5);
            LoopSeg second_half;
            second_half.kind = 1;
            second_half.through.push_back(at(from + step * 0.75));
            second_half.to = at(from + step);
            segs.push_back(first_half);
            segs.push_back(second_half);
            continue;
        }
        LoopSeg seg;
        seg.to = project(to_pt);
        if (curve.GetType() == GeomAbs_Line || std::abs(span) <= 1e-9) {
            seg.kind = 0;
        } else if (curve.GetType() == GeomAbs_Circle) {
            seg.kind = 1;
            const double mid = reversed ? t1 - span * 0.5 : t0 + span * 0.5;
            seg.through.push_back(at(mid));
        } else {
            std::vector<gp_Pnt2d> points;
            GCPnts_QuasiUniformDeflection sampled(curve, 0.05);
            if (sampled.IsDone() && sampled.NbPoints() >= 2) {
                points.reserve(static_cast<size_t>(sampled.NbPoints()));
                for (int i = 1; i <= sampled.NbPoints(); ++i) {
                    points.push_back(project(sampled.Value(i)));
                }
            } else {
                for (int i = 0; i <= 8; ++i) {
                    points.push_back(at(t0 + span * (static_cast<double>(i) / 8.0)));
                }
            }
            if (reversed) {
                std::reverse(points.begin(), points.end());
            }
            if (points.size() >= 2) {
                seg.to = points.back();
            }
            if (points.size() > 2) {
                seg.kind = 2;
                seg.through.assign(points.begin() + 1, points.end() - 1);
            }
        }
        segs.push_back(seg);
    }
    return have_start && !segs.empty();
}

void write_point(std::ostream& out, const gp_Pnt2d& point) {
    out << '[' << point.X() << ',' << point.Y() << ']';
}

/// One loop as `extrude.loops` takes it: `{start, segments}`.
void write_loop(std::ostream& out, const gp_Pnt2d& start, const std::vector<LoopSeg>& segs) {
    out << "{\"start\":";
    write_point(out, start);
    out << ",\"segments\":[";
    for (size_t s = 0; s < segs.size(); ++s) {
        const LoopSeg& seg = segs[s];
        if (s > 0) {
            out << ',';
        }
        const char* kind = seg.kind == 1 ? "arc" : seg.kind == 2 ? "spline" : "line";
        out << "{\"kind\":\"" << kind << '"';
        if (seg.kind == 1 && !seg.through.empty()) {
            out << ",\"through\":";
            write_point(out, seg.through[0]);
        } else if (seg.kind == 2 && !seg.through.empty()) {
            out << ",\"through\":[";
            for (size_t p = 0; p < seg.through.size(); ++p) {
                if (p > 0) {
                    out << ',';
                }
                write_point(out, seg.through[p]);
            }
            out << ']';
        }
        out << ",\"to\":";
        write_point(out, seg.to);
        out << '}';
    }
    out << "]}";
}

/// The wire as points on the frame's plane, each curve sampled to `chord` mm, without the closing point.
std::vector<gp_Pnt2d> sampled_wire(
    const TopoDS_Wire& wire,
    const TopoDS_Face& face,
    const gp_Pnt& origin,
    const gp_Vec& u,
    const gp_Vec& v,
    double chord) {
    std::vector<gp_Pnt2d> out;
    for (BRepTools_WireExplorer explorer(wire, face); explorer.More(); explorer.Next()) {
        const TopoDS_Edge edge = explorer.Current();
        if (BRep_Tool::Degenerated(edge)) {
            continue;
        }
        BRepAdaptor_Curve curve(edge);
        std::vector<gp_Pnt2d> points;
        const double t0 = curve.FirstParameter();
        const double t1 = curve.LastParameter();
        if (curve.GetType() == GeomAbs_Line) {
            points.push_back(project_point(curve.Value(t0), origin, u, v));
            points.push_back(project_point(curve.Value(t1), origin, u, v));
        } else {
            GCPnts_QuasiUniformDeflection sampler(curve, chord);
            if (sampler.IsDone() && sampler.NbPoints() >= 2) {
                for (int i = 1; i <= sampler.NbPoints(); ++i) {
                    points.push_back(project_point(sampler.Value(i), origin, u, v));
                }
            } else {
                for (int i = 0; i <= 16; ++i) {
                    points.push_back(project_point(curve.Value(t0 + (t1 - t0) * i / 16.0), origin, u, v));
                }
            }
        }
        if (edge.Orientation() == TopAbs_REVERSED) {
            std::reverse(points.begin(), points.end());
        }
        for (const gp_Pnt2d& point : points) {
            if (!out.empty() && out.back().Distance(point) < 1e-7) {
                continue;
            }
            out.push_back(point);
        }
    }
    if (out.size() > 1 && out.front().Distance(out.back()) < 1e-6) {
        out.pop_back();
    }
    return out;
}

double polygon_area(const std::vector<gp_Pnt2d>& points) {
    double area = 0.0;
    for (size_t i = 0; i < points.size(); ++i) {
        const gp_Pnt2d& a = points[i];
        const gp_Pnt2d& b = points[(i + 1) % points.size()];
        area += a.X() * b.Y() - b.X() * a.Y();
    }
    return area * 0.5;
}

/// Faces on one plane in the frame (`origin`, `u`, `v`): the frame and the `extrude` origin and turn that draw in it,
/// each face's loops as `extrude.loops` takes them (outline counter-clockwise, then its holes), each face as sampled
/// points (`regions`: an outer loop and its holes), and the area.
std::string region_json(
    const std::vector<TopoDS_Face>& faces,
    const gp_Pnt& origin,
    const gp_Vec& u,
    const gp_Vec& v,
    double chord,
    std::string& error) {
    const gp_Vec w = u.Crossed(v);
    double turn[3] = {0, 0, 0};
    euler_of(u, v, w, turn);
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out.precision(9);
    const auto vec = [&](const gp_XYZ& p, bool point) {
        out << '[' << (point ? clean_mm(p.X()) : p.X()) << ',' << (point ? clean_mm(p.Y()) : p.Y()) << ','
            << (point ? clean_mm(p.Z()) : p.Z()) << ']';
    };
    out << "{\"frame\":{\"origin\":";
    vec(origin.XYZ(), true);
    out << ",\"u\":";
    vec(u.XYZ(), false);
    out << ",\"v\":";
    vec(v.XYZ(), false);
    out << ",\"w\":";
    vec(w.XYZ(), false);
    out << "},\"origin\":";
    vec(origin.XYZ(), true);
    out << ",\"turn\":[" << turn[0] << ',' << turn[1] << ',' << turn[2] << "]";
    std::ostringstream loops;
    loops.imbue(std::locale::classic());
    loops.precision(9);
    std::ostringstream regions;
    regions.imbue(std::locale::classic());
    regions.precision(9);
    double total = 0.0;
    size_t loop_count = 0;
    size_t region_count = 0;
    try {
        for (const TopoDS_Face& face : faces) {
            if (past_deadline()) {
                error = section_overran();
                return {};
            }
            const TopoDS_Wire outer = BRepTools::OuterWire(face);
            if (outer.IsNull()) {
                continue;
            }
            std::vector<TopoDS_Wire> wires{outer};
            for (TopExp_Explorer it(face, TopAbs_WIRE); it.More(); it.Next()) {
                const TopoDS_Wire wire = TopoDS::Wire(it.Current());
                if (!wire.IsSame(outer)) {
                    wires.push_back(wire);
                }
            }
            if (region_count++ > 0) {
                regions << ',';
            }
            regions << "{\"outer\":";
            for (size_t i = 0; i < wires.size(); ++i) {
                gp_Pnt2d start;
                std::vector<LoopSeg> segs;
                if (!wire_segments(wires[i], face, origin, u, v, start, segs)) {
                    error = "Open CASCADE could not read this outline.";
                    return {};
                }
                const bool hole = i > 0;
                const double area = loop_area(start, segs);
                if ((hole && area > 0.0) || (!hole && area < 0.0)) {
                    reverse_loop(start, segs);
                }
                if (loop_count++ > 0) {
                    loops << ',';
                }
                write_loop(loops, start, segs);
                std::vector<gp_Pnt2d> points = sampled_wire(wires[i], face, origin, u, v, chord);
                const double sampled = polygon_area(points);
                if ((hole && sampled > 0.0) || (!hole && sampled < 0.0)) {
                    std::reverse(points.begin(), points.end());
                }
                if (i == 1) {
                    regions << ",\"holes\":[";
                } else if (i > 1) {
                    regions << ',';
                }
                regions << '[';
                for (size_t p = 0; p < points.size(); ++p) {
                    if (p > 0) {
                        regions << ',';
                    }
                    regions << '[' << clean_mm(points[p].X()) << ',' << clean_mm(points[p].Y()) << ']';
                }
                regions << ']';
            }
            regions << (wires.size() > 1 ? "]}" : ",\"holes\":[]}");
            total += face_area(face);
        }
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not read this outline.";
        return {};
    }
    out << ",\"loops\":[" << loops.str() << "],\"regions\":[" << regions.str() << "],\"areaMm2\":" << total << '}';
    return out.str();
}

/// Origin, U and V from nine numbers, U and V made unit and V square to U. False when they are not a frame.
bool frame_from_numbers(const double* frame, gp_Pnt& origin, gp_Vec& u, gp_Vec& v) {
    for (int i = 0; i < 9; ++i) {
        if (!std::isfinite(frame[i])) {
            return false;
        }
    }
    origin = gp_Pnt(frame[0], frame[1], frame[2]);
    u = gp_Vec(frame[3], frame[4], frame[5]);
    v = gp_Vec(frame[6], frame[7], frame[8]);
    if (!(u.Magnitude() > 1e-9) || !(v.Magnitude() > 1e-9)) {
        return false;
    }
    u.Normalize();
    v -= u * v.Dot(u);
    if (!(v.Magnitude() > 1e-9)) {
        return false;
    }
    v.Normalize();
    return true;
}

}  // namespace

std::string face_region_json(const TopoDS_Face& face, const double* frame, double inset, double chord, std::string& error) {
    if (!face_is_plane(face)) {
        error = "A face outline is for a flat face. Section the part with a plane instead.";
        return {};
    }
    gp_Dir normal;
    if (!outward_normal(face, normal)) {
        error = "Open CASCADE could not read this face's outline.";
        return {};
    }
    if (!std::isfinite(inset) || inset < 0.0 || !std::isfinite(chord)) {
        error = "An inset is 0 or more millimetres.";
        return {};
    }
    chord = chord > 0.0 ? std::min(std::max(chord, 0.001), 5.0) : 0.05;
    gp_Pnt origin;
    gp_Vec u;
    gp_Vec v;
    if (frame != nullptr) {
        if (!frame_from_numbers(frame, origin, u, v)) {
            error = "The frame needs an origin and two directions.";
            return {};
        }
        if (std::abs(u.Dot(gp_Vec(normal))) > 1e-6 || std::abs(v.Dot(gp_Vec(normal))) > 1e-6) {
            error = "The frame does not lie in the face's plane.";
            return {};
        }
        if (u.Crossed(v).Dot(gp_Vec(normal)) < 0.0) {
            v.Reverse();
        }
    } else {
        GProp_GProps props;
        BRepGProp::SurfaceProperties(face, props);
        origin = props.CentreOfMass();
        const bool looking_up = std::abs(normal.Z()) >= std::abs(normal.X()) && std::abs(normal.Z()) >= std::abs(normal.Y());
        if (looking_up) {
            in_plane_axes(normal, u, v);
        } else {
            side_axes(normal, u, v);
        }
    }
    std::vector<TopoDS_Face> faces;
    if (inset <= 1e-9) {
        faces.push_back(face);
    } else {
        // The face's own boundary offset inward. An inset that leaves nothing is an empty region, not a refusal.
        TopoDS_Shape offset;
        try {
            BRepOffsetAPI_MakeOffset maker(face, GeomAbs_Arc);
            maker.Perform(-inset);
            if (maker.IsDone()) {
                offset = maker.Shape();
            }
        } catch (const Standard_Failure&) {
            offset.Nullify();
        }
        if (!offset.IsNull()) {
            ProfileFrame plane;
            plane.origin = origin;
            plane.u = gp_Dir(u);
            plane.v = gp_Dir(v);
            plane.w = gp_Dir(u.Crossed(v));
            const gp_Pln base(gp_Ax3(origin, plane.w, plane.u));
            std::vector<ProfileLoop> loops;
            for (TopExp_Explorer it(offset, TopAbs_WIRE); it.More(); it.Next()) {
                const TopoDS_Wire wire = TopoDS::Wire(it.Current());
                BRepBuilderAPI_MakeFace on(base, wire, Standard_True);
                if (!on.IsDone()) {
                    continue;
                }
                gp_Pnt2d start;
                std::vector<LoopSeg> segs;
                if (!wire_segments(wire, on.Face(), origin, u, v, start, segs)) {
                    continue;
                }
                ProfileLoop loop;
                loop.start[0] = start.X();
                loop.start[1] = start.Y();
                for (const LoopSeg& seg : segs) {
                    ProfileSeg out;
                    out.kind = seg.kind == 1 ? ProfileSegKind::Arc : seg.kind == 2 ? ProfileSegKind::Spline : ProfileSegKind::Line;
                    out.to[0] = seg.to.X();
                    out.to[1] = seg.to.Y();
                    for (const gp_Pnt2d& p : seg.through) {
                        out.through.push_back(p.X());
                        out.through.push_back(p.Y());
                    }
                    loop.segments.push_back(std::move(out));
                }
                loops.push_back(std::move(loop));
            }
            std::vector<std::vector<ProfileLoop>> groups;
            int deepest = 0;
            std::string ignored;
            if (!loops.empty() && group_loops(plane, loops, groups, deepest, ignored)) {
                for (const std::vector<ProfileLoop>& group : groups) {
                    const TopoDS_Face inner = group_face(plane, group, 0.0, ignored);
                    if (!inner.IsNull()) {
                        faces.push_back(inner);
                    }
                }
            }
        }
    }
    return region_json(faces, origin, u, v, chord, error);
}

std::string section_json(const TopoDS_Shape& shape, const double* plane, const double* frame, double chord, std::string& error) {
    for (int i = 0; i < 6; ++i) {
        if (!std::isfinite(plane[i])) {
            error = "A section needs an origin and a normal.";
            return {};
        }
    }
    gp_Vec normal(plane[3], plane[4], plane[5]);
    if (!(normal.Magnitude() > 1e-9)) {
        error = "A section's normal needs a length.";
        return {};
    }
    normal.Normalize();
    chord = std::isfinite(chord) && chord > 0.0 ? std::min(std::max(chord, 0.001), 5.0) : 0.05;
    gp_Pnt origin;
    gp_Vec u;
    gp_Vec v;
    if (!frame_from_numbers(frame, origin, u, v)) {
        error = "The frame needs an origin and two directions.";
        return {};
    }
    if (std::abs(u.Dot(normal)) > 1e-6 || std::abs(v.Dot(normal)) > 1e-6) {
        error = "The frame does not lie in the section's plane.";
        return {};
    }
    if (u.Crossed(v).Dot(normal) < 0.0) {
        v.Reverse();
    }
    Bnd_Box box;
    BRepBndLib::Add(shape, box);
    if (box.IsVoid()) {
        error = "This solid has no size.";
        return {};
    }
    double lo[3];
    double hi[3];
    box.Get(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    const gp_Pnt centre((lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0);
    const gp_Pnt at(plane[0], plane[1], plane[2]);
    const double reach = gp_Pnt(lo[0], lo[1], lo[2]).Distance(gp_Pnt(hi[0], hi[1], hi[2])) + at.Distance(centre) + 10.0;
    const gp_Pln cut(gp_Ax3(at, gp_Dir(normal), gp_Dir(u)));
    std::vector<TopoDS_Face> faces;
    try {
        const TopoDS_Face sheet = BRepBuilderAPI_MakeFace(cut, -reach, reach, -reach, reach).Face();
        TopTools_ListOfShape objects;
        objects.Append(shape);
        TopTools_ListOfShape tools;
        tools.Append(sheet);
        BRepAlgoAPI_Common common;
        common.SetArguments(objects);
        common.SetTools(tools);
        common.SetFuzzyValue(1.0e-7);
        common.SetNonDestructive(Standard_True);
        common.SetRunParallel(Standard_True);
        // A damaged solid (faces that meet only along a line, walls a few hundredths thin) could keep this cut
        // working for many minutes. The caller's deadline stops it with a sentence wherever Open CASCADE looks at it;
        // on the damaged part that sent us here it never did, so the MCP session also caps the whole call.
        Handle(Message_ProgressIndicator) watch;
        common.Build(deadline_range(watch));
        if (past_deadline()) {
            error = section_overran();
            return {};
        }
        if (!common.IsDone() || common.HasErrors()) {
            error = "Open CASCADE did not cut this section.";
            return {};
        }
        for (TopExp_Explorer it(common.Shape(), TopAbs_FACE); it.More(); it.Next()) {
            faces.push_back(facing(TopoDS::Face(it.Current()), gp_Dir(normal)));
        }
    } catch (const Standard_Failure&) {
        error = "Open CASCADE did not cut this section.";
        return {};
    }
    return region_json(faces, origin, u, v, chord, error);
}

std::string face_loops_json(const TopoDS_Face& face, std::string& error) {
    if (!face_is_plane(face)) {
        error = "Face loops are for a flat face.";
        return {};
    }
    gp_Dir normal;
    if (!outward_normal(face, normal)) {
        error = "Open CASCADE could not read this face's outline.";
        return {};
    }
    gp_Pnt origin;
    try {
        GProp_GProps props;
        BRepGProp::SurfaceProperties(face, props);
        origin = props.CentreOfMass();
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not read this face's outline.";
        return {};
    }
    gp_Vec u;
    gp_Vec v;
    const bool looking_up = std::abs(normal.Z()) >= std::abs(normal.X()) && std::abs(normal.Z()) >= std::abs(normal.Y());
    if (looking_up) {
        in_plane_axes(normal, u, v);
    } else {
        side_axes(normal, u, v);
    }
    double turn[3] = {0, 0, 0};
    euler_of(u, v, gp_Vec(normal), turn);
    TopoDS_Wire outer;
    try {
        outer = BRepTools::OuterWire(face);
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not read this face's outline.";
        return {};
    }
    if (outer.IsNull()) {
        error = "Open CASCADE could not read this face's outline.";
        return {};
    }
    std::vector<TopoDS_Wire> wires;
    wires.push_back(outer);
    for (TopExp_Explorer it(face, TopAbs_WIRE); it.More(); it.Next()) {
        const TopoDS_Wire wire = TopoDS::Wire(it.Current());
        if (!wire.IsSame(outer)) {
            wires.push_back(wire);
        }
    }
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out.precision(9);
    out << "{\"origin\":[" << clean_mm(origin.X()) << ',' << clean_mm(origin.Y()) << ',' << clean_mm(origin.Z())
        << "],\"turn\":[" << turn[0] << ',' << turn[1] << ',' << turn[2] << "],\"loops\":[";
    try {
        for (size_t i = 0; i < wires.size(); ++i) {
            gp_Pnt2d start;
            std::vector<LoopSeg> segs;
            if (!wire_segments(wires[i], face, origin, u, v, start, segs)) {
                error = "Open CASCADE could not read this face's outline.";
                return {};
            }
            const double area = loop_area(start, segs);
            const bool hole = i > 0;
            if ((hole && area > 0.0) || (!hole && area < 0.0)) {
                reverse_loop(start, segs);
            }
            if (i > 0) {
                out << ',';
            }
            out << "{\"start\":";
            write_point(out, start);
            out << ",\"segments\":[";
            for (size_t s = 0; s < segs.size(); ++s) {
                const LoopSeg& seg = segs[s];
                if (s > 0) {
                    out << ',';
                }
                const char* kind = seg.kind == 1 ? "arc" : seg.kind == 2 ? "spline" : "line";
                out << "{\"kind\":\"" << kind << '"';
                if (seg.kind == 1 && !seg.through.empty()) {
                    out << ",\"through\":";
                    write_point(out, seg.through[0]);
                } else if (seg.kind == 2 && !seg.through.empty()) {
                    out << ",\"through\":[";
                    for (size_t p = 0; p < seg.through.size(); ++p) {
                        if (p > 0) {
                            out << ',';
                        }
                        write_point(out, seg.through[p]);
                    }
                    out << ']';
                }
                out << ",\"to\":";
                write_point(out, seg.to);
                out << '}';
            }
            out << "]}";
        }
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not read this face's outline.";
        return {};
    }
    out << "]}";
    return out.str();
}

/// --- Organic surfaces S1: lazy surface inspection (per-vertex curvature buffers, trimmed UV isoparms,
/// shared-edge G0/G1/G2 continuity, and per-face NURBS & bend-radius health).
SurfaceInspect surface_inspect(Held& held, double chord, bool want_curvature, bool want_isoparms, int iso_count, bool display) {
    SurfaceInspect result;
    chord = chord_of(chord);
    const int n_faces = held.faces.Extent();
    const int n_edges = held.edges.Extent();

    // Ensure the faces are meshed at `chord` when curvature buffers are requested so vertex ordering
    // matches `tessellate(held, chord, display)` 1-to-1.
    if (want_curvature && display) {
        display_faces(held, chord);
    } else if (want_curvature && held.meshed != chord) {
        if (g_whole_meshes.load() || !mesh_around_made(held, chord)) {
            mesh_faces(held.shape, chord);
        }
        held.meshed = chord;
    }

    static constexpr float kFlatRadius = 1.0e9f;
    static constexpr double kCurvEps = 1.0e-9;

    // 1) Per-vertex curvature scalars (minRadiusMm, gaussian, mean) matching `tessellate()` corner order.
    if (want_curvature) {
        struct CurvPiece {
            Handle(Poly_Triangulation) tri;
            bool reversed = false;
            bool constant = false;
            float const_r = kFlatRadius;
            float const_k = 0.0f;
            float const_h = 0.0f;
            std::vector<float> r_nodes;
            std::vector<float> k_nodes;
            std::vector<float> h_nodes;
        };
        std::vector<CurvPiece> pieces(static_cast<size_t>(n_faces));
        size_t total_tris = 0;
        const auto face_of = [&held, display](int f) {
            return display ? held.display_faces[static_cast<size_t>(f - 1)] : TopoDS::Face(held.faces(f));
        };
        for (int f = 1; f <= n_faces; ++f) {
            const TopoDS_Face face = face_of(f);
            TopLoc_Location loc;
            CurvPiece& p = pieces[static_cast<size_t>(f - 1)];
            p.tri = BRep_Tool::Triangulation(face, loc);
            p.reversed = face.Orientation() == TopAbs_REVERSED;
            if (!p.tri.IsNull()) {
                total_tris += static_cast<size_t>(p.tri->NbTriangles());
            }
        }
        OSD_Parallel::For(0, n_faces, [&face_of, &pieces](int idx) {
            CurvPiece& p = pieces[static_cast<size_t>(idx)];
            if (p.tri.IsNull() || p.tri->NbTriangles() == 0) {
                return;
            }
            const TopoDS_Face face = face_of(idx + 1);
            const double outward = p.reversed ? -1.0 : 1.0;
            try {
                BRepAdaptor_Surface surf(face);
                const GeomAbs_SurfaceType kind = surf.GetType();
                if (kind == GeomAbs_Plane) {
                    p.constant = true;
                    p.const_r = kFlatRadius;
                    p.const_k = 0.0f;
                    p.const_h = 0.0f;
                    return;
                }
                if (kind == GeomAbs_Sphere) {
                    const double rad = surf.Sphere().Radius();
                    const double k = rad > kCurvEps ? (-outward / rad) : 0.0;
                    p.constant = true;
                    p.const_r = rad > kCurvEps ? static_cast<float>(rad) : kFlatRadius;
                    p.const_k = static_cast<float>(k * k);
                    p.const_h = static_cast<float>(k);
                    return;
                }
                if (kind == GeomAbs_Cylinder) {
                    const double rad = surf.Cylinder().Radius();
                    const double k = rad > kCurvEps ? (-outward / rad) : 0.0;
                    p.constant = true;
                    p.const_r = rad > kCurvEps ? static_cast<float>(rad) : kFlatRadius;
                    p.const_k = 0.0f;
                    p.const_h = static_cast<float>(0.5 * k);
                    return;
                }
                if (!p.tri->HasUVNodes()) {
                    p.constant = true;
                    return;
                }
                const int nb = p.tri->NbNodes();
                p.r_nodes.assign(static_cast<size_t>(nb), kFlatRadius);
                p.k_nodes.assign(static_cast<size_t>(nb), 0.0f);
                p.h_nodes.assign(static_cast<size_t>(nb), 0.0f);
                BRepLProp_SLProps props(surf, 2, 1e-9);
                for (int n = 1; n <= nb; ++n) {
                    const gp_Pnt2d uv = p.tri->UVNode(n);
                    props.SetParameters(uv.X(), uv.Y());
                    if (!props.IsCurvatureDefined()) {
                        continue;
                    }
                    const double k1 = props.MaxCurvature() * outward;
                    const double k2 = props.MinCurvature() * outward;
                    if (!std::isfinite(k1) || !std::isfinite(k2)) {
                        continue;
                    }
                    const double kmax = std::max(std::abs(k1), std::abs(k2));
                    const double rmin = kmax > kCurvEps ? std::min(1.0 / kmax, static_cast<double>(kFlatRadius)) : static_cast<double>(kFlatRadius);
                    const size_t slot = static_cast<size_t>(n - 1);
                    p.r_nodes[slot] = static_cast<float>(rmin);
                    p.k_nodes[slot] = static_cast<float>(k1 * k2);
                    p.h_nodes[slot] = static_cast<float>(0.5 * (k1 + k2));
                }
            } catch (const Standard_Failure&) {
                p.constant = true;
            }
        });

        result.min_radius_mm.reserve(total_tris * 3);
        result.gaussian.reserve(total_tris * 3);
        result.mean.reserve(total_tris * 3);
        for (size_t at = 0; at < pieces.size(); ++at) {
            const size_t face_idx = held.order.empty() ? at : static_cast<size_t>(held.order[at] - 1);
            const CurvPiece& p = pieces[face_idx];
            if (p.tri.IsNull()) {
                continue;
            }
            for (int ti = 1; ti <= p.tri->NbTriangles(); ++ti) {
                int n1 = 0, n2 = 0, n3 = 0;
                p.tri->Triangle(ti).Get(n1, n2, n3);
                if (p.reversed) {
                    std::swap(n2, n3);
                }
                if (p.constant || p.r_nodes.empty()) {
                    for (int k = 0; k < 3; ++k) {
                        result.min_radius_mm.push_back(p.const_r);
                        result.gaussian.push_back(p.const_k);
                        result.mean.push_back(p.const_h);
                    }
                } else {
                    const int nodes[3] = {n1, n2, n3};
                    for (int k = 0; k < 3; ++k) {
                        const size_t slot = static_cast<size_t>(nodes[k] - 1);
                        result.min_radius_mm.push_back(slot < p.r_nodes.size() ? p.r_nodes[slot] : kFlatRadius);
                        result.gaussian.push_back(slot < p.k_nodes.size() ? p.k_nodes[slot] : 0.0f);
                        result.mean.push_back(slot < p.h_nodes.size() ? p.h_nodes[slot] : 0.0f);
                    }
                }
            }
        }
    }

    // 2) Real UV isoparametric curves on curved and freeform faces, trimmed to each face via FClass2d.
    if (want_isoparms) {
        const int lines = std::clamp(iso_count <= 0 ? 6 : iso_count, 2, 24);
        const int samples_per_iso = 28;
        for (int f = 1; f <= n_faces; ++f) {
            const TopoDS_Face face = TopoDS::Face(held.faces(f));
            try {
                BRepAdaptor_Surface adaptor(face);
                const GeomAbs_SurfaceType kind = adaptor.GetType();
                if (kind == GeomAbs_Plane) {
                    continue;
                }
                double u0 = 0.0, u1 = 0.0, v0 = 0.0, v1 = 0.0;
                BRepTools::UVBounds(face, u0, u1, v0, v1);
                if (!std::isfinite(u0) || !std::isfinite(u1) || !std::isfinite(v0) || !std::isfinite(v1)
                    || !(u1 > u0 + 1e-9) || !(v1 > v0 + 1e-9)) {
                    continue;
                }
                TopLoc_Location loc;
                const Handle(Geom_Surface) gsurf = BRep_Tool::Surface(face, loc);
                if (gsurf.IsNull()) {
                    continue;
                }
                const gp_Trsf trsf = loc.Transformation();
                BRepTopAdaptor_FClass2d classifier(face, 1e-6);

                auto emit_iso = [&](bool is_u, double fixed_param, double t0, double t1) {
                    Handle(Geom_Curve) iso = is_u ? gsurf->UIso(fixed_param) : gsurf->VIso(fixed_param);
                    if (iso.IsNull()) {
                        return;
                    }
                    bool have_prev = false;
                    gp_Pnt prev_pt;
                    for (int s = 0; s <= samples_per_iso; ++s) {
                        const double t = t0 + (t1 - t0) * (static_cast<double>(s) / samples_per_iso);
                        const double u = is_u ? fixed_param : t;
                        const double v = is_u ? t : fixed_param;
                        const TopAbs_State st = classifier.Perform(gp_Pnt2d(u, v));
                        if (st == TopAbs_IN || st == TopAbs_ON) {
                            const gp_Pnt pt = iso->Value(t).Transformed(trsf);
                            if (have_prev) {
                                push_point(result.iso_points, prev_pt);
                                push_point(result.iso_points, pt);
                            }
                            prev_pt = pt;
                            have_prev = true;
                        } else {
                            have_prev = false;
                        }
                    }
                };

                for (int i = 1; i <= lines; ++i) {
                    const double frac = static_cast<double>(i) / (lines + 1);
                    emit_iso(true, u0 + (u1 - u0) * frac, v0, v1);
                    emit_iso(false, v0 + (v1 - v0) * frac, u0, u1);
                }
            } catch (const Standard_Failure&) {
            }
        }
    }

    // 3) Per-face NURBS & tightest-bend health summary.
    int kind_plane = 0, kind_cyl = 0, kind_cone = 0, kind_sphere = 0, kind_torus = 0, kind_bspline = 0, kind_bezier = 0, kind_other = 0;
    int max_u_deg = 0, max_v_deg = 0, max_poles = 0, max_u_spans = 0, max_v_spans = 0, rational_faces = 0, high_deg_faces = 0, heavy_faces = 0;
    double tightest_radius = std::numeric_limits<double>::infinity();
    int tightest_face = -1;
    gp_Pnt tightest_at(0.0, 0.0, 0.0);

    for (int f = 1; f <= n_faces; ++f) {
        const TopoDS_Face face = TopoDS::Face(held.faces(f));
        try {
            BRepAdaptor_Surface surf(face);
            const GeomAbs_SurfaceType kind = surf.GetType();
            switch (kind) {
                case GeomAbs_Plane: kind_plane += 1; break;
                case GeomAbs_Cylinder: kind_cyl += 1; break;
                case GeomAbs_Cone: kind_cone += 1; break;
                case GeomAbs_Sphere: kind_sphere += 1; break;
                case GeomAbs_Torus: kind_torus += 1; break;
                case GeomAbs_BSplineSurface: kind_bspline += 1; break;
                case GeomAbs_BezierSurface: kind_bezier += 1; break;
                default: kind_other += 1; break;
            }
            if (kind == GeomAbs_BSplineSurface) {
                const Handle(Geom_BSplineSurface) bs = surf.BSpline();
                if (!bs.IsNull()) {
                    const int ud = bs->UDegree();
                    const int vd = bs->VDegree();
                    const int poles = bs->NbUPoles() * bs->NbVPoles();
                    max_u_deg = std::max(max_u_deg, ud);
                    max_v_deg = std::max(max_v_deg, vd);
                    max_poles = std::max(max_poles, poles);
                    max_u_spans = std::max(max_u_spans, std::max(0, bs->NbUKnots() - 1));
                    max_v_spans = std::max(max_v_spans, std::max(0, bs->NbVKnots() - 1));
                    if (bs->IsURational() || bs->IsVRational()) rational_faces += 1;
                    if (ud > 5 || vd > 5) high_deg_faces += 1;
                    if (poles > 400) heavy_faces += 1;
                }
            } else if (kind == GeomAbs_BezierSurface) {
                const Handle(Geom_BezierSurface) bz = surf.Bezier();
                if (!bz.IsNull()) {
                    const int ud = bz->UDegree();
                    const int vd = bz->VDegree();
                    const int poles = bz->NbUPoles() * bz->NbVPoles();
                    max_u_deg = std::max(max_u_deg, ud);
                    max_v_deg = std::max(max_v_deg, vd);
                    max_poles = std::max(max_poles, poles);
                    if (bz->IsURational() || bz->IsVRational()) rational_faces += 1;
                    if (ud > 5 || vd > 5) high_deg_faces += 1;
                    if (poles > 400) heavy_faces += 1;
                }
            } else if (kind == GeomAbs_SurfaceOfExtrusion || kind == GeomAbs_SurfaceOfRevolution) {
                const Handle(Adaptor3d_Curve) basis = surf.BasisCurve();
                if (!basis.IsNull()) {
                    const GeomAbs_CurveType btype = basis->GetType();
                    if (btype == GeomAbs_BSplineCurve) {
                        const Handle(Geom_BSplineCurve) bc = basis->BSpline();
                        if (!bc.IsNull()) {
                            const int deg = bc->Degree();
                            const int poles = bc->NbPoles();
                            max_u_deg = std::max(max_u_deg, deg);
                            max_poles = std::max(max_poles, poles);
                            if (bc->IsRational()) rational_faces += 1;
                            if (deg > 5) high_deg_faces += 1;
                            if (poles > 400) heavy_faces += 1;
                        }
                    } else if (btype == GeomAbs_BezierCurve) {
                        const Handle(Geom_BezierCurve) bz = basis->Bezier();
                        if (!bz.IsNull()) {
                            const int deg = bz->Degree();
                            const int poles = bz->NbPoles();
                            max_u_deg = std::max(max_u_deg, deg);
                            max_poles = std::max(max_poles, poles);
                            if (bz->IsRational()) rational_faces += 1;
                            if (deg > 5) high_deg_faces += 1;
                            if (poles > 400) heavy_faces += 1;
                        }
                    }
                }
            }

            if (kind == GeomAbs_Plane) {
                continue;
            }
            double u0 = 0.0, u1 = 0.0, v0 = 0.0, v1 = 0.0;
            BRepTools::UVBounds(face, u0, u1, v0, v1);
            if (!std::isfinite(u0) || !std::isfinite(u1) || !std::isfinite(v0) || !std::isfinite(v1)) {
                continue;
            }
            if (kind == GeomAbs_Cylinder) {
                const double r = surf.Cylinder().Radius();
                if (r > kCurvEps && r < tightest_radius) {
                    tightest_radius = r;
                    tightest_face = f - 1;
                    tightest_at = surf.Value(0.5 * (u0 + u1), 0.5 * (v0 + v1));
                }
                continue;
            }
            if (kind == GeomAbs_Sphere) {
                const double r = surf.Sphere().Radius();
                if (r > kCurvEps && r < tightest_radius) {
                    tightest_radius = r;
                    tightest_face = f - 1;
                    tightest_at = surf.Value(0.5 * (u0 + u1), 0.5 * (v0 + v1));
                }
                continue;
            }
            BRepLProp_SLProps props(surf, 2, 1e-9);
            const int grid = 6;
            for (int iu = 1; iu < grid; ++iu) {
                const double u = u0 + (u1 - u0) * (static_cast<double>(iu) / grid);
                for (int iv = 1; iv < grid; ++iv) {
                    const double v = v0 + (v1 - v0) * (static_cast<double>(iv) / grid);
                    props.SetParameters(u, v);
                    if (!props.IsCurvatureDefined()) continue;
                    const double kmax = std::max(std::abs(props.MaxCurvature()), std::abs(props.MinCurvature()));
                    if (std::isfinite(kmax) && kmax > kCurvEps) {
                        const double r = 1.0 / kmax;
                        if (r < tightest_radius) {
                            tightest_radius = r;
                            tightest_face = f - 1;
                            tightest_at = props.Value();
                        }
                    }
                }
            }
        } catch (const Standard_Failure&) {
        }
    }

    // 4) Shared-edge G0 / G1 / G2 continuity analysis across all 2-face non-seam edges.
    TopTools_IndexedDataMapOfShapeListOfShape edge_to_faces;
    TopExp::MapShapesAndAncestors(held.shape, TopAbs_EDGE, TopAbs_FACE, edge_to_faces);

    struct SeamRow {
        int edge = 0;
        int face_a = 0;
        int face_b = 0;
        const char* kind = "G0";
        double gap_mm = 0.0;
        double angle_deg = 0.0;
        double curvature_jump = 0.0;
        gp_Pnt mid;
    };
    int shared_total = 0, cnt_g2 = 0, cnt_g1 = 0, cnt_g0 = 0, cnt_gaps = 0;
    double max_gap_mm = 0.0;
    double worst_smooth_angle_deg = 0.0;
    double worst_curvature_jump = 0.0;
    std::vector<SeamRow> notable;
    std::vector<SeamRow> edges_all;

    auto normal_curvature_perp = [](BRepLProp_SLProps& props, double outward, const gp_Vec& edge_tan) -> double {
        if (!props.IsCurvatureDefined() || !props.IsNormalDefined()) {
            return 0.0;
        }
        gp_Dir n = props.Normal();
        if (outward < 0.0) n.Reverse();
        gp_Vec perp = gp_Vec(n).Crossed(edge_tan);
        const double plen = perp.Magnitude();
        if (!(plen > 1e-12)) {
            return 0.5 * (props.MaxCurvature() + props.MinCurvature()) * outward;
        }
        perp.Divide(plen);
        gp_Dir dmax, dmin;
        props.CurvatureDirections(dmax, dmin);
        const double c = perp.Dot(gp_Vec(dmax));
        const double s = perp.Dot(gp_Vec(dmin));
        return (props.MaxCurvature() * c * c + props.MinCurvature() * s * s) * outward;
    };

    for (int e = 1; e <= n_edges; ++e) {
        const TopoDS_Edge edge = TopoDS::Edge(held.edges(e));
        if (BRep_Tool::Degenerated(edge)) {
            continue;
        }
        const int map_idx = edge_to_faces.FindIndex(edge);
        if (map_idx <= 0) {
            continue;
        }
        const TopTools_ListOfShape& flist = edge_to_faces(map_idx);
        TopoDS_Face fa, fb;
        int ia = -1, ib = -1;
        for (TopTools_ListIteratorOfListOfShape it(flist); it.More(); it.Next()) {
            const TopoDS_Face cand = TopoDS::Face(it.Value());
            const int fi = held.faces.FindIndex(cand);
            if (fi <= 0) continue;
            if (ia < 0) {
                fa = cand;
                ia = fi - 1;
            } else if (fi - 1 != ia) {
                fb = cand;
                ib = fi - 1;
                break;
            }
        }
        if (ia < 0 || ib < 0) {
            continue;
        }
        shared_total += 1;
        try {
            Standard_Real p1a = 0.0, p2a = 0.0, p1b = 0.0, p2b = 0.0;
            const Handle(Geom2d_Curve) ca = BRep_Tool::CurveOnSurface(edge, fa, p1a, p2a);
            const Handle(Geom2d_Curve) cb = BRep_Tool::CurveOnSurface(edge, fb, p1b, p2b);
            if (ca.IsNull() || cb.IsNull() || !(p2a > p1a + 1e-9) || !(p2b > p1b + 1e-9)) {
                continue;
            }
            BRepAdaptor_Surface sa(fa);
            BRepAdaptor_Surface sb(fb);
            BRepAdaptor_Curve ec(edge);
            BRepLProp_SLProps pa(sa, 2, 1e-9);
            BRepLProp_SLProps pb(sb, 2, 1e-9);
            const double out_a = fa.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
            const double out_b = fb.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;

            double edge_gap = 0.0;
            double edge_ang = 0.0;
            double edge_kjump = 0.0;
            bool ok_samples = false;
            constexpr int kStations = 5;
            for (int s = 0; s < kStations; ++s) {
                const double frac = 0.1 + 0.8 * (static_cast<double>(s) / (kStations - 1));
                const double ta = p1a + (p2a - p1a) * frac;
                const double tb = p1b + (p2b - p1b) * frac;
                const gp_Pnt2d uva = ca->Value(ta);
                const gp_Pnt2d uvb = cb->Value(tb);
                pa.SetParameters(uva.X(), uva.Y());
                pb.SetParameters(uvb.X(), uvb.Y());
                if (!pa.IsNormalDefined() || !pb.IsNormalDefined()) {
                    continue;
                }
                ok_samples = true;
                edge_gap = std::max(edge_gap, pa.Value().Distance(pb.Value()));
                gp_Dir na = pa.Normal();
                gp_Dir nb = pb.Normal();
                if (out_a < 0.0) na.Reverse();
                if (out_b < 0.0) nb.Reverse();
                const double dot = std::clamp(na.Dot(nb), -1.0, 1.0);
                const double ang = std::acos(dot) * (180.0 / M_PI);
                edge_ang = std::max(edge_ang, ang);
                // Measured at every station, so a row reports the jump whatever its class.
                {
                    gp_Pnt ep;
                    gp_Vec et;
                    ec.D1(ec.FirstParameter() + (ec.LastParameter() - ec.FirstParameter()) * frac, ep, et);
                    const double ka = normal_curvature_perp(pa, out_a, et);
                    const double kb = normal_curvature_perp(pb, out_b, et);
                    if (std::isfinite(ka) && std::isfinite(kb)) {
                        edge_kjump = std::max(edge_kjump, std::abs(ka - kb));
                    }
                }
            }
            if (!ok_samples) {
                continue;
            }
            max_gap_mm = std::max(max_gap_mm, edge_gap);
            const char* cls = "G0";
            // The same bounds the builders accept by (kernel.h).
            if (edge_gap >= kContinuityGapMm) {
                cls = "gap";
                cnt_gaps += 1;
            } else if (edge_ang >= kContinuityAngleDeg) {
                cls = "G0";
                cnt_g0 += 1;
            } else if (edge_kjump > kContinuityJump) {
                cls = "G1";
                cnt_g1 += 1;
                worst_smooth_angle_deg = std::max(worst_smooth_angle_deg, edge_ang);
                worst_curvature_jump = std::max(worst_curvature_jump, edge_kjump);
            } else {
                cls = "G2";
                cnt_g2 += 1;
                worst_smooth_angle_deg = std::max(worst_smooth_angle_deg, edge_ang);
                worst_curvature_jump = std::max(worst_curvature_jump, edge_kjump);
            }
            const gp_Pnt mid = ec.Value(0.5 * (ec.FirstParameter() + ec.LastParameter()));
            const SeamRow row{e - 1, ia, ib, cls, edge_gap, edge_ang, edge_kjump, mid};
            edges_all.push_back(row);
            if (cls[0] != 'G' || cls[1] == '1') {
                // Report gaps and G1-only smooth transitions (where G2 curvature breaks).
                notable.push_back(row);
            }
        } catch (const Standard_Failure&) {
        }
    }

    std::sort(notable.begin(), notable.end(), [](const SeamRow& a, const SeamRow& b) {
        if ((a.kind[0] == 'g') != (b.kind[0] == 'g')) return a.kind[0] == 'g';
        return a.curvature_jump > b.curvature_jump;
    });
    if (notable.size() > 16) {
        notable.resize(16);
    }
    if (edges_all.size() > 256) {
        std::partial_sort(edges_all.begin(), edges_all.begin() + 256, edges_all.end(), [](const SeamRow& a, const SeamRow& b) {
            if (a.gap_mm != b.gap_mm) return a.gap_mm > b.gap_mm;
            if (a.angle_deg != b.angle_deg) return a.angle_deg > b.angle_deg;
            return a.curvature_jump > b.curvature_jump;
        });
        edges_all.resize(256);
    }
    std::sort(edges_all.begin(), edges_all.end(), [](const SeamRow& a, const SeamRow& b) { return a.edge < b.edge; });

    struct SharpVertex {
        gp_Pnt at;
        int face_a = -1;
        int face_b = -1;
        double angle_deg = 0.0;
    };
    std::vector<SharpVertex> sharp_vertices;
    {
        TopTools_IndexedMapOfShape smooth_verts;
        for (const SeamRow& row : edges_all) {
            if (std::strcmp(row.kind, "G1") != 0 && std::strcmp(row.kind, "G2") != 0) continue;
            if (row.edge < 0 || row.edge >= held.edges.Extent()) continue;
            const TopoDS_Edge edge = TopoDS::Edge(held.edges(row.edge + 1));
            for (TopExp_Explorer vx(edge, TopAbs_VERTEX); vx.More(); vx.Next()) smooth_verts.Add(vx.Current());
        }
        TopTools_IndexedDataMapOfShapeListOfShape vert_to_faces;
        TopExp::MapShapesAndAncestors(held.shape, TopAbs_VERTEX, TopAbs_FACE, vert_to_faces);
        for (int vi = 1; vi <= smooth_verts.Extent(); ++vi) {
            const TopoDS_Vertex vertex = TopoDS::Vertex(smooth_verts(vi));
            const int map_i = vert_to_faces.FindIndex(vertex);
            if (map_i <= 0) continue;
            const gp_Pnt at = BRep_Tool::Pnt(vertex);
            struct FaceN {
                int index;
                gp_Dir normal;
            };
            std::vector<FaceN> locals;
            for (TopTools_ListIteratorOfListOfShape it(vert_to_faces(map_i)); it.More(); it.Next()) {
                const TopoDS_Face face = TopoDS::Face(it.Value());
                const int fi = held.faces.FindIndex(face);
                if (fi <= 0) continue;
                try {
                    double u = 0.0;
                    double v = 0.0;
                    TopLoc_Location loc;
                    const Handle(Geom_Surface) surf = BRep_Tool::Surface(face, loc);
                    if (surf.IsNull()) continue;
                    gp_Pnt local = at;
                    if (!loc.IsIdentity()) local.Transform(loc.Transformation().Inverted());
                    GeomAPI_ProjectPointOnSurf proj(local, surf);
                    if (proj.NbPoints() < 1) continue;
                    proj.LowerDistanceParameters(u, v);
                    BRepAdaptor_Surface adapt(face);
                    BRepLProp_SLProps props(adapt, u, v, 1, 1e-9);
                    if (!props.IsNormalDefined()) continue;
                    gp_Dir n = props.Normal();
                    if (face.Orientation() == TopAbs_REVERSED) n.Reverse();
                    locals.push_back(FaceN{fi - 1, n});
                } catch (const Standard_Failure&) {
                }
            }
            auto joined_smooth = [&](int a, int b) {
                for (const SeamRow& row : edges_all) {
                    if (std::strcmp(row.kind, "G1") != 0 && std::strcmp(row.kind, "G2") != 0) continue;
                    if ((row.face_a == a && row.face_b == b) || (row.face_a == b && row.face_b == a)) return true;
                }
                return false;
            };
            double worst = 0.0;
            int ba = -1;
            int bb = -1;
            for (size_t a = 0; a < locals.size(); ++a) {
                for (size_t b = a + 1; b < locals.size(); ++b) {
                    // A G1 or G2 seam is the edge the fill was asked to smooth. The sharp
                    // corner is the other pair: the two support faces meeting at Vi.
                    if (joined_smooth(locals[a].index, locals[b].index)) continue;
                    const double ang = std::acos(std::clamp(locals[a].normal.Dot(locals[b].normal), -1.0, 1.0)) * (180.0 / M_PI);
                    if (ang > worst) {
                        worst = ang;
                        ba = locals[a].index;
                        bb = locals[b].index;
                    }
                }
            }
            // Sharp by the same bound an edge is G1 by, so a vertex is sharp exactly where no edge class says smooth.
            if (!(worst >= kContinuityAngleDeg) || ba < 0) continue;
            if (ba > bb) std::swap(ba, bb);
            bool merged = false;
            for (SharpVertex& existing : sharp_vertices) {
                if (existing.face_a == ba && existing.face_b == bb && existing.at.Distance(at) < 1e-5) {
                    existing.angle_deg = std::max(existing.angle_deg, worst);
                    merged = true;
                    break;
                }
            }
            if (merged) continue;
            sharp_vertices.push_back(SharpVertex{at, ba, bb, worst});
        }
    }

    std::ostringstream js;
    js.imbue(std::locale::classic());
    js.precision(6);
    js << "{\"continuity\":{"
       << "\"sharedEdges\":" << shared_total
       << ",\"g2\":" << cnt_g2
       << ",\"g1\":" << cnt_g1
       << ",\"g0\":" << cnt_g0
       << ",\"gaps\":" << cnt_gaps
       << ",\"maxGapMm\":" << max_gap_mm
       << ",\"worstSmoothAngleDeg\":" << worst_smooth_angle_deg
       << ",\"worstCurvatureJump\":" << worst_curvature_jump
       << ",\"notable\":[";
    for (size_t i = 0; i < notable.size(); ++i) {
        if (i > 0) js << ',';
        const SeamRow& r = notable[i];
        js << "{\"edge\":" << r.edge
           << ",\"faces\":[" << r.face_a << ',' << r.face_b << ']'
           << ",\"kind\":\"" << r.kind << '"'
           << ",\"gapMm\":" << r.gap_mm
           << ",\"angleDeg\":" << r.angle_deg
           << ",\"curvatureJump\":" << r.curvature_jump
           << ",\"mid\":[" << r.mid.X() << ',' << r.mid.Y() << ',' << r.mid.Z() << "]}";
    }
    js << "],\"edges\":[";
    for (size_t i = 0; i < edges_all.size(); ++i) {
        if (i > 0) js << ',';
        const SeamRow& r = edges_all[i];
        js << "{\"edge\":" << r.edge
           << ",\"faces\":[" << r.face_a << ',' << r.face_b << ']'
           << ",\"kind\":\"" << r.kind << '"'
           << ",\"gapMm\":" << r.gap_mm
           << ",\"angleDeg\":" << r.angle_deg
           << ",\"curvatureJump\":" << r.curvature_jump
           << ",\"mid\":[" << r.mid.X() << ',' << r.mid.Y() << ',' << r.mid.Z() << "]}";
    }
    js << "],\"sharpVertices\":[";
    for (size_t i = 0; i < sharp_vertices.size(); ++i) {
        if (i > 0) js << ',';
        const SharpVertex& v = sharp_vertices[i];
        js << "{\"at\":[" << v.at.X() << ',' << v.at.Y() << ',' << v.at.Z() << ']'
           << ",\"faces\":[" << v.face_a << ',' << v.face_b << ']'
           << ",\"angleDeg\":" << v.angle_deg << '}';
    }
    js << "]},\"surfaceHealth\":{"
       << "\"faces\":" << n_faces
       << ",\"kinds\":{\"plane\":" << kind_plane
       << ",\"cylinder\":" << kind_cyl
       << ",\"cone\":" << kind_cone
       << ",\"sphere\":" << kind_sphere
       << ",\"torus\":" << kind_torus
       << ",\"bspline\":" << kind_bspline
       << ",\"bezier\":" << kind_bezier
       << ",\"other\":" << kind_other << '}'
       << ",\"maxUDegree\":" << max_u_deg
       << ",\"maxVDegree\":" << max_v_deg
       << ",\"maxPoles\":" << max_poles
       << ",\"maxUSpans\":" << max_u_spans
       << ",\"maxVSpans\":" << max_v_spans
       << ",\"rationalFaces\":" << rational_faces
       << ",\"highDegreeFaces\":" << high_deg_faces
       << ",\"heavyFaces\":" << heavy_faces;
    if (std::isfinite(tightest_radius) && tightest_face >= 0) {
        js << ",\"minRadiusMm\":" << tightest_radius
           << ",\"tightestFace\":" << tightest_face
           << ",\"tightestAt\":[" << tightest_at.X() << ',' << tightest_at.Y() << ',' << tightest_at.Z() << ']';
    }
    js << "}}";
    result.meta = js.str();
    return result;
}

/// --- Organic surfaces S2: decode `Curve3DSpec` and build exact 3D wire + real kernel `Op::Sweep` (`BRepOffsetAPI_MakePipeShell`).
bool decode_curve3d(const double* data, int count, Curve3DSpec& out, int& used, std::string& error) {
    used = 0;
    out = Curve3DSpec{};
    if (data == nullptr || count < 2) {
        error = "A 3D curve specification is incomplete.";
        return false;
    }
    size_t at = 0;
    auto take = [&](size_t n) { return at + n <= static_cast<size_t>(count); };
    out.kind = static_cast<int>(std::llround(data[at++]));
    out.closed = std::llround(data[at++]) != 0;
    if (out.kind == 0 || out.kind == 1) {
        // Polyline or Spline: [npts, x0,y0,z0, ...]
        if (!take(1)) { error = "A 3D curve is incomplete."; return false; }
        const int npts = static_cast<int>(std::llround(data[at++]));
        if (npts < 2 || npts > 1000 || !take(static_cast<size_t>(npts) * 3)) {
            error = "A 3D curve needs between 2 and 1000 points.";
            return false;
        }
        out.pts.reserve(static_cast<size_t>(npts) * 3);
        for (int i = 0; i < npts * 3; ++i) {
            if (!std::isfinite(data[at])) { error = "A 3D curve point is not a number."; return false; }
            out.pts.push_back(data[at++]);
        }
    } else if (out.kind == 2) {
        // Exact 3D NURBS: [degree, npoles, nw, nk, poles..., weights..., knots..., mults...]
        if (!take(4)) { error = "A 3D NURBS curve is incomplete."; return false; }
        out.degree = static_cast<int>(std::llround(data[at++]));
        const int np = static_cast<int>(std::llround(data[at++]));
        const int nw = static_cast<int>(std::llround(data[at++]));
        const int nk = static_cast<int>(std::llround(data[at++]));
        if (np < 2 || np > 500 || nw < 0 || nw > 500 || nk < 0 || nk > 520
            || !take(static_cast<size_t>(np) * 3 + static_cast<size_t>(nw) + static_cast<size_t>(nk) * 2)) {
            error = "A 3D NURBS curve is incomplete.";
            return false;
        }
        out.pts.reserve(static_cast<size_t>(np) * 3);
        for (int i = 0; i < np * 3; ++i) {
            if (!std::isfinite(data[at])) { error = "A NURBS pole is not a number."; return false; }
            out.pts.push_back(data[at++]);
        }
        for (int i = 0; i < nw; ++i) out.weights.push_back(data[at++]);
        for (int i = 0; i < nk; ++i) out.knots.push_back(data[at++]);
        for (int i = 0; i < nk; ++i) out.mults.push_back(static_cast<int>(std::llround(data[at++])));
    } else if (out.kind == 3) {
        // Mixed 3D segments: [start3, nseg, seg...]
        if (!take(4)) { error = "A 3D segment chain is incomplete."; return false; }
        out.start[0] = data[at++];
        out.start[1] = data[at++];
        out.start[2] = data[at++];
        const int nseg = static_cast<int>(std::llround(data[at++]));
        if (nseg < 1 || nseg > 500) { error = "A 3D curve needs at least one segment."; return false; }
        out.segments.reserve(static_cast<size_t>(nseg));
        for (int s = 0; s < nseg; ++s) {
            if (!take(5)) { error = "A 3D segment is incomplete."; return false; }
            Curve3DSeg seg;
            const int sk = static_cast<int>(std::llround(data[at++]));
            if (sk < 0 || sk > 3) { error = "Unknown 3D segment kind."; return false; }
            seg.kind = static_cast<Curve3DSegKind>(sk);
            seg.to[0] = data[at++];
            seg.to[1] = data[at++];
            seg.to[2] = data[at++];
            const int npts = static_cast<int>(std::llround(data[at++]));
            if (npts < 0 || npts > 200 || !take(static_cast<size_t>(npts) * 3)) {
                error = "A 3D segment is incomplete.";
                return false;
            }
            seg.pts.reserve(static_cast<size_t>(npts) * 3);
            for (int i = 0; i < npts * 3; ++i) seg.pts.push_back(data[at++]);
            if (seg.kind == Curve3DSegKind::Nurbs) {
                if (!take(3)) { error = "A 3D NURBS segment is incomplete."; return false; }
                seg.degree = static_cast<int>(std::llround(data[at++]));
                const int nw = static_cast<int>(std::llround(data[at++]));
                const int nk = static_cast<int>(std::llround(data[at++]));
                if (nw < 0 || nw > 204 || nk < 0 || nk > 220 || !take(static_cast<size_t>(nw) + static_cast<size_t>(nk) * 2)) {
                    error = "A 3D NURBS segment is incomplete.";
                    return false;
                }
                for (int i = 0; i < nw; ++i) seg.weights.push_back(data[at++]);
                for (int i = 0; i < nk; ++i) seg.knots.push_back(data[at++]);
                for (int i = 0; i < nk; ++i) seg.mults.push_back(static_cast<int>(std::llround(data[at++])));
            }
            out.segments.push_back(std::move(seg));
        }
    } else if (out.kind == 4) {
        // Solid edges: [nedges, e0, e1, ...]
        if (!take(1)) { error = "Edge spine is incomplete."; return false; }
        const int ne = static_cast<int>(std::llround(data[at++]));
        if (ne < 1 || ne > 500 || !take(static_cast<size_t>(ne))) {
            error = "An edge spine needs at least one edge.";
            return false;
        }
        for (int i = 0; i < ne; ++i) out.edge_indices.push_back(static_cast<int>(std::llround(data[at++])));
    } else {
        error = "Unknown 3D curve kind.";
        return false;
    }
    used = static_cast<int>(at);
    return true;
}

namespace {

TopoDS_Wire curve3d_wire(const Curve3DSpec& spec, const Held* held_for_edges, std::string& error) {
    if (spec.kind == 0) {
        BRepBuilderAPI_MakePolygon poly;
        for (size_t i = 0; i + 2 < spec.pts.size(); i += 3) {
            poly.Add(gp_Pnt(spec.pts[i], spec.pts[i + 1], spec.pts[i + 2]));
        }
        if (spec.closed) poly.Close();
        if (!poly.IsDone()) {
            error = "Open CASCADE could not build the polyline spine.";
            return {};
        }
        return poly.Wire();
    }
    if (spec.kind == 1) {
        std::vector<gp_Pnt> pts;
        for (size_t i = 0; i + 2 < spec.pts.size(); i += 3) {
            pts.emplace_back(spec.pts[i], spec.pts[i + 1], spec.pts[i + 2]);
        }
        const TopoDS_Edge edge = spline_edge(pts, spec.closed, error);
        if (edge.IsNull()) return {};
        BRepBuilderAPI_MakeWire mw(edge);
        if (!mw.IsDone()) { error = "Open CASCADE could not build the spline spine wire."; return {}; }
        return mw.Wire();
    }
    if (spec.kind == 2) {
        std::vector<gp_Pnt> poles;
        for (size_t i = 0; i + 2 < spec.pts.size(); i += 3) {
            poles.emplace_back(spec.pts[i], spec.pts[i + 1], spec.pts[i + 2]);
        }
        const TopoDS_Edge edge = nurbs_edge(poles, spec.weights, spec.degree, spec.knots, spec.mults, spec.closed, error);
        if (edge.IsNull()) return {};
        BRepBuilderAPI_MakeWire mw(edge);
        if (!mw.IsDone()) { error = "Open CASCADE could not build the NURBS spine wire."; return {}; }
        return mw.Wire();
    }
    if (spec.kind == 3) {
        std::vector<TopoDS_Edge> edges;
        gp_Pnt from(spec.start[0], spec.start[1], spec.start[2]);
        for (const Curve3DSeg& seg : spec.segments) {
            const gp_Pnt to(seg.to[0], seg.to[1], seg.to[2]);
            TopoDS_Edge edge;
            if (seg.kind == Curve3DSegKind::Line) {
                if (from.Distance(to) <= 1e-6) {
                    error = "A 3D spine segment has zero length.";
                    return {};
                }
                BRepBuilderAPI_MakeEdge me(from, to);
                if (!me.IsDone()) { error = "Open CASCADE could not build a line segment in the spine."; return {}; }
                edge = me.Edge();
            } else if (seg.kind == Curve3DSegKind::Arc) {
                if (seg.pts.size() != 3) { error = "A 3D arc segment needs one through point."; return {}; }
                const gp_Pnt mid(seg.pts[0], seg.pts[1], seg.pts[2]);
                GC_MakeArcOfCircle arc(from, mid, to);
                if (!arc.IsDone()) { error = "Open CASCADE could not build an arc segment in the spine."; return {}; }
                BRepBuilderAPI_MakeEdge me(arc.Value());
                if (!me.IsDone()) { error = "Open CASCADE could not build an arc edge in the spine."; return {}; }
                edge = me.Edge();
            } else if (seg.kind == Curve3DSegKind::Spline) {
                std::vector<gp_Pnt> pts;
                pts.push_back(from);
                for (size_t i = 0; i + 2 < seg.pts.size(); i += 3) {
                    pts.emplace_back(seg.pts[i], seg.pts[i + 1], seg.pts[i + 2]);
                }
                const bool closed = spec.segments.size() == 1 && from.Distance(to) <= 1e-6 && pts.size() >= 3;
                if (!closed) pts.push_back(to);
                edge = spline_edge(pts, closed, error);
            } else {
                std::vector<gp_Pnt> poles;
                poles.push_back(from);
                for (size_t i = 0; i + 2 < seg.pts.size(); i += 3) {
                    poles.emplace_back(seg.pts[i], seg.pts[i + 1], seg.pts[i + 2]);
                }
                const bool closed = spec.segments.size() == 1 && from.Distance(to) <= 1e-6 && poles.size() >= 3;
                if (!closed) poles.push_back(to);
                edge = nurbs_edge(poles, seg.weights, seg.degree, seg.knots, seg.mults, closed, error);
            }
            if (edge.IsNull()) return {};
            edges.push_back(edge);
            from = to;
        }
        return wire_of(edges, error);
    }
    if (spec.kind == 4) {
        if (held_for_edges == nullptr) {
            error = "An edge spine needs an existing solid.";
            return {};
        }
        std::vector<TopoDS_Edge> edges;
        for (const int idx : spec.edge_indices) {
            if (idx < 0 || idx >= held_for_edges->edges.Extent()) {
                error = "The spine names an edge that is not on this solid.";
                return {};
            }
            edges.push_back(TopoDS::Edge(held_for_edges->edges(idx + 1)));
        }
        return wire_of(edges, error);
    }
    error = "Unknown 3D spine kind.";
    return {};
}

/// Extract the outer wire and optional hole wires of one `LoftSection`.
bool sweep_section_wires(const LoftSection& section, TopoDS_Wire& outer, std::vector<TopoDS_Wire>& holes, std::string& error) {
    holes.clear();
    if (!section.loops.empty()) {
        const ProfileFrame frame = frame_of(section.profile);
        std::vector<std::vector<ProfileLoop>> groups;
        int deepest = 0;
        if (!group_loops(frame, section.loops, groups, deepest, error)) {
            return false;
        }
        if (groups.size() != 1) {
            error = "A sweep section needs one closed outline (holes allowed).";
            return false;
        }
        for (size_t i = 0; i < groups[0].size(); ++i) {
            const std::vector<TopoDS_Edge> edges = loop_edges(frame, groups[0][i], 0.0, error);
            if (edges.empty()) return false;
            const TopoDS_Wire w = wire_of(edges, error);
            if (w.IsNull()) return false;
            if (i == 0) outer = w;
            else holes.push_back(w);
        }
        return true;
    }
    outer = section_wire(section, error);
    return !outer.IsNull();
}

/// Build an offset helical auxiliary spine wire rotating smoothly by `twist_deg` along `spine`.
TopoDS_Wire twist_aux_wire(const TopoDS_Wire& spine, double twist_deg, std::string& error) {
    BRepAdaptor_CompCurve cc(spine);
    const double u0 = cc.FirstParameter();
    const double u1 = cc.LastParameter();
    if (!(u1 > u0 + 1e-9)) {
        error = "The sweep spine is too short to twist.";
        return {};
    }
    constexpr int kSamples = 32;
    gp_Pnt p0;
    gp_Vec t0;
    cc.D1(u0, p0, t0);
    if (t0.Magnitude() <= 1e-9) {
        error = "The sweep spine has no tangent at its start.";
        return {};
    }
    t0.Normalize();
    gp_Vec up(0.0, 0.0, 1.0);
    if (std::abs(t0.Dot(up)) > 0.92) up = gp_Vec(0.0, 1.0, 0.0);
    gp_Vec u_dir = up.Crossed(t0);
    u_dir.Normalize();

    const double twist_rad = twist_deg * (kPi / 180.0);
    const double offset = 5.0;
    std::vector<gp_Pnt> pts;
    pts.reserve(kSamples + 1);
    for (int i = 0; i <= kSamples; ++i) {
        const double frac = static_cast<double>(i) / kSamples;
        const double u = u0 + (u1 - u0) * frac;
        gp_Pnt p;
        gp_Vec t;
        cc.D1(u, p, t);
        if (t.Magnitude() > 1e-9) {
            t.Normalize();
            // Parallel-transport u_dir smoothly before applying twist.
            const double along = u_dir.Dot(t);
            u_dir = u_dir - t * along;
            if (u_dir.Magnitude() > 1e-9) u_dir.Normalize();
            gp_Vec v_dir = t.Crossed(u_dir);
            v_dir.Normalize();
            const double a = twist_rad * frac;
            gp_Vec radial = u_dir * std::cos(a) + v_dir * std::sin(a);
            pts.push_back(p.Translated(radial * offset));
        }
    }
    const TopoDS_Edge edge = spline_edge(pts, false, error);
    if (edge.IsNull()) return {};
    BRepBuilderAPI_MakeWire mw(edge);
    if (!mw.IsDone()) { error = "Open CASCADE could not build the twist guide."; return {}; }
    return mw.Wire();
}

/// True when `solid` is not a clean closed solid: BRepCheck finds a fault, an edge is not shared by exactly two faces,
/// or the solid intersects itself (BOPAlgo_ArgumentAnalyzer's self-interference test, the faults a later boolean trips
/// on).
bool sweep_damaged(const TopoDS_Shape& solid) {
    if (!BRepCheck_Analyzer(solid).IsValid()) return true;
    TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
    TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, edge_faces);
    for (int i = 1; i <= edge_faces.Extent(); ++i) {
        const TopoDS_Edge edge = TopoDS::Edge(edge_faces.FindKey(i));
        if (BRep_Tool::Degenerated(edge)) continue;
        TopTools_IndexedMapOfShape distinct;
        for (const TopoDS_Shape& face : edge_faces(i)) distinct.Add(face);
        const bool seam = distinct.Extent() == 1 && BRep_Tool::IsClosed(edge, TopoDS::Face(distinct(1)));
        if (distinct.Extent() != 2 && !seam) return true;
    }
    try {
        BOPAlgo_ArgumentAnalyzer analyzer;
        analyzer.SetShape1(solid);
        analyzer.SelfInterMode() = Standard_True;
        analyzer.Perform();
        if (analyzer.HasFaulty()) return true;
    } catch (const Standard_Failure&) {
        return true;
    }
    return false;
}

TopoDS_Shape pipe_solid_from_wires(
    const TopoDS_Wire& spine,
    const std::vector<TopoDS_Wire>& section_wires,
    const SweepSpec& spec,
    const TopoDS_Wire& aux_wire,
    std::string& error) {
    BRepOffsetAPI_MakePipeShell pipe(spine);
    if (!aux_wire.IsNull()) {
        // Mode 3 (mode {kind: "auxSpine"}) carries its flags in the binormal's numbers: curvilinear, keep contact.
        const bool curvilinear = spec.mode != 3 || spec.binormal[0] != 0.0;
        const bool keep_contact = spec.mode == 3 && spec.binormal[1] != 0.0;
        pipe.SetMode(aux_wire, curvilinear ? Standard_True : Standard_False,
                     keep_contact ? BRepFill_ContactOnBorder : BRepFill_NoContact);
    } else if (spec.mode == 2) {
        const gp_Vec bv(spec.binormal[0], spec.binormal[1], spec.binormal[2]);
        if (bv.Magnitude() <= 1e-9) {
            error = "Fixed binormal direction cannot be zero.";
            return {};
        }
        pipe.SetMode(gp_Dir(bv));
    } else if (spec.mode == 1) {
        pipe.SetMode(Standard_True);
    } else {
        pipe.SetMode(Standard_False);
    }

    if (spec.transition == 1) {
        pipe.SetTransitionMode(BRepBuilderAPI_RightCorner);
    } else if (spec.transition == 2) {
        pipe.SetTransitionMode(BRepBuilderAPI_Transformed);
    } else {
        pipe.SetTransitionMode(BRepBuilderAPI_RoundCorner);
    }

    if (section_wires.size() > 1 && spec.scale_stations.size() >= 4) {
        error = "Scale stations take a sweep of one section. With several sections, each section sets the size where it stands.";
        return {};
    }
    if (section_wires.size() == 1 && spec.scale_stations.size() >= 4) {
        const int nst = static_cast<int>(spec.scale_stations.size() / 2);
        BRepAdaptor_CompCurve cc(spine);
        const double u0 = cc.FirstParameter();
        const double u1 = cc.LastParameter();
        TColgp_Array1OfPnt2d pts(1, nst);
        for (int i = 0; i < nst; ++i) {
            const double t = std::clamp(spec.scale_stations[static_cast<size_t>(i * 2)], 0.0, 1.0);
            const double s = spec.scale_stations[static_cast<size_t>(i * 2 + 1)];
            if (!std::isfinite(s) || !(s > 1e-4)) {
                error = "Every sweep scale factor must be positive.";
                return {};
            }
            pts.SetValue(i + 1, gp_Pnt2d(u0 + (u1 - u0) * t, s));
        }
        Handle(Law_Interpol) law = new Law_Interpol();
        law->Set(pts, Standard_False);
        pipe.SetLaw(section_wires[0], law, Standard_False, Standard_False);
    } else {
        for (const TopoDS_Wire& w : section_wires) {
            pipe.Add(w, Standard_False, Standard_False);
        }
    }

    TopoDS_Shape tool;
    try {
        Handle(Message_ProgressIndicator) watch;
        pipe.Build(deadline_range(watch));
        if (!pipe.IsDone() || !pipe.MakeSolid() || pipe.Shape().IsNull()) {
            error = past_deadline() ? deadline_message()
                                    : "Open CASCADE could not sweep this profile along the path. Make tight bends gentler or reduce the profile size.";
            return {};
        }
        tool = pipe.Shape();
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not sweep this profile along the path. Make tight bends gentler or reduce the profile size.";
        return {};
    }
    if (!has_solid(tool)) {
        error = "The sweep did not close into a solid.";
        return {};
    }
    tool = as_solid(tool);
    GProp_GProps props;
    integrate(tool, props);
    if (std::abs(props.Mass()) <= 1e-6) {
        error = "The sweep has no volume.";
        return {};
    }
    if (props.Mass() < 0.0) {
        tool.Reverse();
    }
    if (!BRepCheck_Analyzer(tool).IsValid()) {
        ShapeFix_Solid fix;
        fix.Init(TopoDS::Solid(tool));
        fix.Perform();
        tool = fix.Solid();
        if (!BRepCheck_Analyzer(tool).IsValid()) {
            error = "The swept solid intersects itself. Make bends gentler or use a smaller profile.";
            return {};
        }
    }
    // Open CASCADE's transformed corner can leave a solid that is valid face by face but touches itself at a sharp bend
    // (a 90 degree elbow gave 115 edges where pieces meet only along a line). Measured, not assumed: such a result is
    // refused, and a transformed corner that builds clean is kept.
    if (spec.transition == 2 && sweep_damaged(tool)) {
        error = "A transformed corner left a damaged solid at a bend of this spine. Use a right or round corner there.";
        return {};
    }
    return tool;
}

}  // namespace

TopoDS_Shape build_sweep(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const SweepSpec& spec,
    const Held* held_for_edges,
    double& volume,
    std::string& error) {
    if (spec.sections.empty()) {
        error = "A sweep needs at least one profile section.";
        return {};
    }
    if (spec.sections.size() > 64) {
        error = "A sweep takes at most 64 sections.";
        return {};
    }
    const TopoDS_Wire spine = curve3d_wire(spec.spine, held_for_edges, error);
    if (spine.IsNull()) {
        return {};
    }
    TopoDS_Wire aux_wire;
    if (spec.has_aux_spine) {
        aux_wire = curve3d_wire(spec.aux_spine, held_for_edges, error);
        if (aux_wire.IsNull()) return {};
    } else if (std::abs(spec.twist_deg) > 1e-6) {
        aux_wire = twist_aux_wire(spine, spec.twist_deg, error);
        if (aux_wire.IsNull()) return {};
    }

    std::vector<TopoDS_Wire> outer_wires;
    std::vector<std::vector<TopoDS_Wire>> hole_chains;
    for (size_t i = 0; i < spec.sections.size(); ++i) {
        TopoDS_Wire outer;
        std::vector<TopoDS_Wire> holes;
        if (!sweep_section_wires(spec.sections[i], outer, holes, error)) {
            error = "Section " + std::to_string(i) + ": " + error;
            return {};
        }
        outer_wires.push_back(outer);
        if (i == 0) {
            hole_chains.resize(holes.size());
        } else if (holes.size() != hole_chains.size()) {
            error = "Every sweep section needs the same number of holes.";
            return {};
        }
        for (size_t h = 0; h < holes.size(); ++h) {
            hole_chains[h].push_back(holes[h]);
        }
    }

    TopoDS_Shape tool = pipe_solid_from_wires(spine, outer_wires, spec, aux_wire, error);
    if (tool.IsNull()) {
        return {};
    }
    for (const std::vector<TopoDS_Wire>& hole_wires : hole_chains) {
        TopoDS_Shape hole_solid = pipe_solid_from_wires(spine, hole_wires, spec, aux_wire, error);
        if (hole_solid.IsNull()) {
            return {};
        }
        double cut_vol = 0.0;
        tool = combine(tool, "cut", hole_solid, cut_vol, error);
        if (tool.IsNull() || !error.empty()) {
            if (error.empty()) error = "Open CASCADE could not hollow the swept pipe.";
            return {};
        }
    }

    if (current.IsNull()) {
        GProp_GProps props;
        integrate(tool, props);
        volume = std::abs(props.Mass());
        return tool;
    }
    return combine_profile_tools(current, before, which, {tool}, "sweep", volume, error);
}

// --- Organic surfaces S3: Variable-radius, exact G2 quintic NURBS, & exact Conic-rho fillets + Controlled Loft v2 ---

namespace {

double eval_variable_radius(const std::vector<double>& variable, double fallback_r, double u) {
    if (variable.size() < 4) return fallback_r;
    const size_t n = variable.size() / 2;
    const double t = std::clamp(u, 0.0, 1.0);
    if (t <= variable[0]) return variable[1];
    if (t >= variable[(n - 1) * 2]) return variable[(n - 1) * 2 + 1];
    for (size_t i = 0; i + 1 < n; ++i) {
        const double u0 = variable[i * 2];
        const double u1 = variable[(i + 1) * 2];
        if (t >= u0 && t <= u1 && u1 > u0 + 1e-12) {
            const double s = (t - u0) / (u1 - u0);
            // Smoothstep Hermite blend between variable-radius stations for C1/G2 transitions along the edge.
            const double h = s * s * (3.0 - 2.0 * s);
            return variable[i * 2 + 1] * (1.0 - h) + variable[(i + 1) * 2 + 1] * h;
        }
    }
    return fallback_r;
}

/// Outward normal and normal curvature of `face` at 3D point `p` along tangent direction `dir_in_face`.
bool face_frame_at(
    const TopoDS_Face& face,
    const gp_Pnt& p,
    const gp_Vec& dir_hint,
    gp_Vec& out_normal,
    double& out_kn) {
    out_kn = 0.0;
    try {
        const Handle(Geom_Surface) surf = BRep_Tool::Surface(face);
        if (surf.IsNull()) return false;
        ShapeAnalysis_Surface sas(surf);
        const gp_Pnt2d uv = sas.ValueOfUV(p, 1e-6);
        BRepAdaptor_Surface bas(face);
        BRepLProp_SLProps props(bas, uv.X(), uv.Y(), 2, 1e-7);
        if (!props.IsNormalDefined()) return false;
        gp_Dir n = props.Normal();
        if (face.Orientation() == TopAbs_REVERSED) n.Reverse();
        out_normal = gp_Vec(n);
        if (bas.GetType() != GeomAbs_Plane && props.IsCurvatureDefined()) {
            // Directional normal curvature along dir_hint via Euler's formula: kn = k1 cos²θ + k2 sin²θ.
            gp_Dir d1, d2;
            props.CurvatureDirections(d1, d2);
            double k1 = props.MaxCurvature();
            double k2 = props.MinCurvature();
            if (face.Orientation() == TopAbs_REVERSED) {
                k1 = -k1;
                k2 = -k2;
            }
            gp_Vec t = dir_hint - out_normal * dir_hint.Dot(out_normal);
            if (t.Magnitude() > 1e-9) {
                t.Normalize();
                const double c = t.Dot(gp_Vec(d1));
                const double s = t.Dot(gp_Vec(d2));
                out_kn = k1 * c * c + k2 * s * s;
            }
        }
        return true;
    } catch (const Standard_Failure&) {
        return false;
    }
}

/// The plane of the face that ends a filleted edge at `corner`: the one planar face there besides `f1`, `f2` and faces
/// in their planes. False when there is none, more than one, or it is not planar.
bool end_plane_at(
    const TopTools_IndexedDataMapOfShapeListOfShape& vertex_faces,
    const TopoDS_Vertex& corner,
    const TopoDS_Face& f1,
    const TopoDS_Face& f2,
    gp_Pln& out) {
    const int at = vertex_faces.FindIndex(corner);
    if (at <= 0) return false;
    const auto same_plane = [](const gp_Pln& a, const gp_Pln& b) {
        return std::abs(a.Axis().Direction().Dot(b.Axis().Direction())) > 1.0 - 1e-9 && a.Distance(b.Location()) < 1e-6;
    };
    const gp_Pln p1 = BRepAdaptor_Surface(f1).Plane();
    const gp_Pln p2 = BRepAdaptor_Surface(f2).Plane();
    int found = 0;
    for (const TopoDS_Shape& shape : vertex_faces.FindFromIndex(at)) {
        const TopoDS_Face face = TopoDS::Face(shape);
        if (face.IsSame(f1) || face.IsSame(f2)) continue;
        const BRepAdaptor_Surface surface(face);
        if (surface.GetType() != GeomAbs_Plane) return false;
        const gp_Pln plane = surface.Plane();
        if (same_plane(plane, p1) || same_plane(plane, p2)) continue;
        if (found > 0 && !same_plane(plane, out)) return false;
        out = plane;
        found += 1;
    }
    return found > 0;
}

/// `tool` cut back to the side of `plane` that holds `keep`: a slab `size` across on the plane, `size` deep.
TopoDS_Shape keep_side(const TopoDS_Shape& tool, const gp_Pln& plane, const gp_Pnt& keep, double size) {
    gp_Vec normal(plane.Axis().Direction());
    if (gp_Vec(plane.Location(), keep).Dot(normal) < 0.0) normal.Reverse();
    const gp_Pnt origin = plane.Location().Translated(normal * plane.Distance(keep) * 0.0);
    gp_Pln centred(plane.Location(), plane.Axis().Direction());
    // Centre the slab's face on the foot of `keep`, so `size` covers the tool whatever the plane's own origin.
    const gp_Pnt foot = keep.Translated(gp_Vec(normal) * -plane.Distance(keep));
    centred.SetLocation(foot);
    (void)origin;
    BRepBuilderAPI_MakeFace face(centred, -size, size, -size, size);
    if (!face.IsDone()) return {};
    BRepPrimAPI_MakePrism slab(face.Face(), normal * size);
    if (!slab.IsDone()) return {};
    BRepAlgoAPI_Common common(tool, slab.Shape());
    common.SetFuzzyValue(1e-7);
    common.Build();
    if (!common.IsDone() || common.Shape().IsNull()) return {};
    return common.Shape();
}

/// Build an exact G2 quintic NURBS (continuity==1) or rational quadratic Conic-rho (continuity==2) cutter solid
/// for a convex edge between two faces, and subtract it cleanly from `shape`. The cutter is cut back to the planes of the
/// faces that end the edge, so it removes no material past either end (a wall the edge runs into, a boss beside the
/// end), and the volume taken must be the fillet's own cross-section swept along the edge, or nothing is kept.
bool try_exact_edge_surface_fillet(
    const TopoDS_Shape& shape,
    const TopoDS_Edge& edge,
    const FilletV2Spec& spec,
    TopoDS_Shape& out_shape) {
    TopTools_IndexedDataMapOfShapeListOfShape ef_map;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, ef_map);
    if (!ef_map.Contains(edge)) return false;
    const TopTools_ListOfShape& adj = ef_map.FindFromKey(edge);
    if (adj.Extent() != 2) return false;
    const TopoDS_Face f1 = TopoDS::Face(adj.First());
    const TopoDS_Face f2 = TopoDS::Face(adj.Last());
    if (f1.IsSame(f2)) return false;

    BRepAdaptor_Curve ecurve(edge);
    const double u_first = ecurve.FirstParameter();
    const double u_last = ecurve.LastParameter();
    if (!(u_last > u_first + 1e-7)) return false;

    const bool is_line = ecurve.GetType() == GeomAbs_Line;
    const bool is_const = spec.variable.size() < 4;
    const bool is_planar_pair = BRepAdaptor_Surface(f1).GetType() == GeomAbs_Plane
        && BRepAdaptor_Surface(f2).GetType() == GeomAbs_Plane;
    // Exact prism/loft cutter works cleanest on straight edges between planar faces (and straight variable edges).
    if (!is_line || !is_planar_pair) return false;

    const gp_Pnt q_start = ecurve.Value(u_first);
    const gp_Pnt q_end = ecurve.Value(u_last);
    gp_Vec e_vec(q_start, q_end);
    const double e_len = e_vec.Magnitude();
    if (!(e_len > 1e-4)) return false;
    const gp_Vec e_dir = e_vec / e_len;

    gp_Vec n1, n2;
    double kn1 = 0.0, kn2 = 0.0;
    const gp_Pnt q_mid = ecurve.Value(0.5 * (u_first + u_last));
    if (!face_frame_at(f1, q_mid, e_dir, n1, kn1) || !face_frame_at(f2, q_mid, e_dir, n2, kn2)) {
        return false;
    }

    // Determine inward face tangent directions pointing from edge into each face interior.
    gp_Vec t1 = e_dir.Crossed(n1);
    gp_Vec t2 = e_dir.Crossed(n2);
    if (t1.Magnitude() < 1e-6 || t2.Magnitude() < 1e-6) return false;
    t1.Normalize();
    t2.Normalize();
    // Orient t1/t2 toward each face's centre of mass so we strictly point into the face.
    GProp_GProps gp1, gp2;
    BRepGProp::SurfaceProperties(f1, gp1);
    BRepGProp::SurfaceProperties(f2, gp2);
    if (gp_Vec(q_mid, gp1.CentreOfMass()).Dot(t1) < 0.0) t1.Reverse();
    if (gp_Vec(q_mid, gp2.CentreOfMass()).Dot(t2) < 0.0) t2.Reverse();

    // Convexity check: for a convex edge, outward normal n1 points AWAY from f2 (so n1 · t2 < 0).
    if (n1.Dot(t2) >= -1e-3 || n2.Dot(t1) >= -1e-3) return false;
    const double cos_dihedral = std::clamp(t1.Dot(t2), -0.99, 0.99);
    const double half_ang = 0.5 * std::acos(cos_dihedral);
    const double tan_half = std::tan(half_ang);
    if (!(tan_half > 1e-4)) return false;

    const double pad = 0.5;
    const double out_eps = 0.5;
    const double rho = std::clamp(spec.rho, 0.05, 0.95);
    const double w_mid = rho / (1.0 - rho);

    // `outer`: the cutter's section, reaching out_eps past both faces. Otherwise the material the fillet removes only:
    // the region between the fillet curve and the corner, bounded by the two faces.
    auto make_section_wire = [&](const gp_Pnt& q, double r, bool outer = true) -> TopoDS_Wire {
        const double d = (spec.continuity == 1 ? 1.25 : 1.0) * r / tan_half;
        const gp_Pnt p0 = q.Translated(t1 * d);
        const gp_Pnt p_end = q.Translated(t2 * d);

        Handle(Geom_BSplineCurve) blend_curve;
        if (spec.continuity == 1) {
            // Exact G2 degree-5 (quintic) Bezier cross-section:
            // P0, P1, P2 lie on f1's tangent line (k(0)=0 exact G2 with planar f1);
            // P5, P4, P3 lie on f2's tangent line (k(1)=0 exact G2 with planar f2).
            TColgp_Array1OfPnt poles(1, 6);
            poles.SetValue(1, p0);
            poles.SetValue(2, p0.Translated(t1 * (-0.35 * d)));
            poles.SetValue(3, p0.Translated(t1 * (-0.72 * d)));
            poles.SetValue(4, p_end.Translated(t2 * (-0.72 * d)));
            poles.SetValue(5, p_end.Translated(t2 * (-0.35 * d)));
            poles.SetValue(6, p_end);
            TColStd_Array1OfReal knots(1, 2);
            knots.SetValue(1, 0.0);
            knots.SetValue(2, 1.0);
            TColStd_Array1OfInteger mults(1, 2);
            mults.SetValue(1, 6);
            mults.SetValue(2, 6);
            blend_curve = new Geom_BSplineCurve(poles, knots, mults, 5, Standard_False);
        } else {
            // Exact rational quadratic Conic-rho Bezier: poles [P0, Q, Pend], weights [1, rho/(1-rho), 1].
            TColgp_Array1OfPnt poles(1, 3);
            poles.SetValue(1, p0);
            poles.SetValue(2, q);
            poles.SetValue(3, p_end);
            TColStd_Array1OfReal weights(1, 3);
            weights.SetValue(1, 1.0);
            weights.SetValue(2, w_mid);
            weights.SetValue(3, 1.0);
            TColStd_Array1OfReal knots(1, 2);
            knots.SetValue(1, 0.0);
            knots.SetValue(2, 1.0);
            TColStd_Array1OfInteger mults(1, 2);
            mults.SetValue(1, 3);
            mults.SetValue(2, 3);
            blend_curve = new Geom_BSplineCurve(poles, weights, knots, mults, 2, Standard_False);
        }

        const gp_Pnt p_end_out = p_end.Translated(n2 * out_eps);
        const gp_Pnt q_out = q.Translated((n1 + n2) * out_eps);
        const gp_Pnt p0_out = p0.Translated(n1 * out_eps);

        BRepBuilderAPI_MakeWire mw;
        mw.Add(BRepBuilderAPI_MakeEdge(blend_curve));
        if (!outer) {
            mw.Add(BRepBuilderAPI_MakeEdge(p_end, q));
            mw.Add(BRepBuilderAPI_MakeEdge(q, p0));
            return mw.IsDone() ? mw.Wire() : TopoDS_Wire();
        }
        mw.Add(BRepBuilderAPI_MakeEdge(p_end, p_end_out));
        mw.Add(BRepBuilderAPI_MakeEdge(p_end_out, q_out));
        mw.Add(BRepBuilderAPI_MakeEdge(q_out, p0_out));
        mw.Add(BRepBuilderAPI_MakeEdge(p0_out, p0));
        return mw.IsDone() ? mw.Wire() : TopoDS_Wire();
    };

    // The faces that end the edge, when each is one plane: the tools are cut back to them.
    TopTools_IndexedDataMapOfShapeListOfShape vertex_faces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, vertex_faces);
    TopoDS_Vertex v_first;
    TopoDS_Vertex v_last;
    TopExp::Vertices(edge, v_first, v_last);
    if (!v_first.IsNull() && !v_last.IsNull() && BRep_Tool::Pnt(v_first).Distance(q_start) > BRep_Tool::Pnt(v_last).Distance(q_start)) {
        std::swap(v_first, v_last);
    }
    gp_Pln start_plane;
    gp_Pln end_plane;
    const bool trim_start = !v_first.IsNull() && end_plane_at(vertex_faces, v_first, f1, f2, start_plane);
    const bool trim_end = !v_last.IsNull() && end_plane_at(vertex_faces, v_last, f1, f2, end_plane);
    const double reach = 4.0 * (e_len + 2.0 * pad + 4.0 * spec.size + 4.0 * out_eps + 1.0);
    const auto trimmed = [&](TopoDS_Shape tool) -> TopoDS_Shape {
        if (!tool.IsNull() && trim_start) tool = keep_side(tool, start_plane, q_mid, reach);
        if (!tool.IsNull() && trim_end) tool = keep_side(tool, end_plane, q_mid, reach);
        return tool;
    };

    // One tool along the edge from `wire_at(q, r, outer)` sections, padded past both ends.
    const auto along = [&](bool outer) -> TopoDS_Shape {
        if (is_const) {
            const gp_Pnt q0 = q_start.Translated(e_dir * (-pad));
            const TopoDS_Wire w = make_section_wire(q0, spec.size, outer);
            if (w.IsNull()) return {};
            BRepBuilderAPI_MakeFace mf(w, Standard_True);
            if (!mf.IsDone()) return {};
            BRepPrimAPI_MakePrism prism(mf.Face(), e_dir * (e_len + 2.0 * pad), Standard_False, Standard_True);
            if (!prism.IsDone() || prism.Shape().IsNull()) return {};
            return prism.Shape();
        }
        BRepOffsetAPI_ThruSections loft(Standard_True, Standard_False, 1e-6);
        loft.CheckCompatibility(Standard_True);
        loft.SetSmoothing(Standard_True);
        loft.SetContinuity(GeomAbs_C2);
        const int n_steps = 12;
        // Extend slightly past both ends with constant end radii so end faces trim cleanly.
        const double r0 = eval_variable_radius(spec.variable, spec.size, 0.0);
        const double r1 = eval_variable_radius(spec.variable, spec.size, 1.0);
        const TopoDS_Wire w_pre = make_section_wire(q_start.Translated(e_dir * (-pad)), r0, outer);
        if (w_pre.IsNull()) return {};
        loft.AddWire(w_pre);
        for (int i = 0; i <= n_steps; ++i) {
            const double t = static_cast<double>(i) / static_cast<double>(n_steps);
            const gp_Pnt qt = q_start.Translated(e_dir * (e_len * t));
            const double rt = eval_variable_radius(spec.variable, spec.size, t);
            const TopoDS_Wire wt = make_section_wire(qt, rt, outer);
            if (wt.IsNull()) return {};
            loft.AddWire(wt);
        }
        const TopoDS_Wire w_post = make_section_wire(q_end.Translated(e_dir * pad), r1, outer);
        if (w_post.IsNull()) return {};
        loft.AddWire(w_post);
        loft.Build();
        if (!loft.IsDone() || loft.Shape().IsNull()) return {};
        return loft.Shape();
    };

    try {
        const TopoDS_Shape cutter = trimmed(along(true));
        const TopoDS_Shape region = trimmed(along(false));
        if (cutter.IsNull() || region.IsNull()) return false;
        BRepAlgoAPI_Cut cut(shape, cutter);
        cut.SetFuzzyValue(1e-5);
        Handle(Message_ProgressIndicator) watch;
        cut.Build(deadline_range(watch));
        if (!cut.IsDone() || cut.Shape().IsNull()) return false;
        const TopoDS_Shape solid = as_solid(cut.Shape());
        if (solid.IsNull() || !has_solid(solid)) return false;
        const double vol = volume_of(solid);
        if (!(vol > 1e-6) || !BRepCheck_Analyzer(solid).IsValid()) return false;
        // The fillet takes its own cross-section along the edge and nothing else: a cutter that reached a wall past an
        // end, or a boss beside the edge, removed more; one whose faces were not where it assumed, less.
        const double removed = volume_of(shape) - vol;
        const double expected = volume_of(region);
        if (!(expected > 0.0) || std::abs(removed - expected) > 1e-4 * expected + 1e-6) return false;
        out_shape = solid;
        return true;
    } catch (const Standard_Failure&) {
        return false;
    }
}

}  // namespace

/// The worst curvature jump, per mm, across the smooth seams a fillet made on `solid`: each edge between a face that is
/// not in `before` and a face beside it whose normals meet within 1 degree, measured as model_check measures it (the
/// normal curvature across the edge on each side, at the fractions 0.1 to 0.9 of the edge). -1 when no seam is read.
/// A fillet's own seams are told from the creases beside them by an angle of at most this: it finds the seams to measure,
/// it is not the G1 bound (that is kContinuityAngleDeg, which the seams found must then meet).
constexpr double kFilletSeamDeg = 1.0;

double worst_fillet_seam_jump(const TopoDS_Shape& solid, const TopoDS_Shape& before, double& worst_angle) {
    worst_angle = 0.0;
    TopTools_IndexedMapOfShape old_faces;
    TopExp::MapShapes(before, TopAbs_FACE, old_faces);
    TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
    TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, edge_faces);
    const auto across = [](BRepLProp_SLProps& props, double outward, const gp_Vec& tangent) {
        if (!props.IsCurvatureDefined()) return 0.0;
        gp_Dir n = props.Normal();
        if (outward < 0.0) n.Reverse();
        gp_Vec perp = gp_Vec(n).Crossed(tangent);
        if (!(perp.Magnitude() > 1e-12)) return 0.5 * (props.MaxCurvature() + props.MinCurvature()) * outward;
        perp.Normalize();
        gp_Dir dmax;
        gp_Dir dmin;
        props.CurvatureDirections(dmax, dmin);
        const double c = perp.Dot(gp_Vec(dmax));
        const double sn = perp.Dot(gp_Vec(dmin));
        return (props.MaxCurvature() * c * c + props.MinCurvature() * sn * sn) * outward;
    };
    double worst = -1.0;
    for (int e = 1; e <= edge_faces.Extent(); ++e) {
        const TopoDS_Edge edge = TopoDS::Edge(edge_faces.FindKey(e));
        const TopTools_ListOfShape& faces = edge_faces(e);
        if (BRep_Tool::Degenerated(edge) || faces.Extent() != 2) continue;
        const TopoDS_Face fa = TopoDS::Face(faces.First());
        const TopoDS_Face fb = TopoDS::Face(faces.Last());
        if (fa.IsSame(fb) || (old_faces.Contains(fa) && old_faces.Contains(fb))) continue;
        Standard_Real a0 = 0.0, a1 = 0.0, b0 = 0.0, b1 = 0.0;
        const Handle(Geom2d_Curve) ca = BRep_Tool::CurveOnSurface(edge, fa, a0, a1);
        const Handle(Geom2d_Curve) cb = BRep_Tool::CurveOnSurface(edge, fb, b0, b1);
        if (ca.IsNull() || cb.IsNull()) continue;
        BRepAdaptor_Surface sa(fa);
        BRepAdaptor_Surface sb(fb);
        BRepAdaptor_Curve ec(edge);
        BRepLProp_SLProps pa(sa, 2, 1e-9);
        BRepLProp_SLProps pb(sb, 2, 1e-9);
        const double out_a = fa.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
        const double out_b = fb.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
        for (int st = 0; st < 5; ++st) {
            const double frac = 0.1 + 0.2 * st;
            const gp_Pnt2d uva = ca->Value(a0 + (a1 - a0) * frac);
            const gp_Pnt2d uvb = cb->Value(b0 + (b1 - b0) * frac);
            pa.SetParameters(uva.X(), uva.Y());
            pb.SetParameters(uvb.X(), uvb.Y());
            if (!pa.IsNormalDefined() || !pb.IsNormalDefined()) continue;
            gp_Dir na = pa.Normal();
            gp_Dir nb = pb.Normal();
            if (out_a < 0.0) na.Reverse();
            if (out_b < 0.0) nb.Reverse();
            const double angle = std::acos(std::clamp(na.Dot(nb), -1.0, 1.0)) * (180.0 / M_PI);
            if (angle > kFilletSeamDeg) continue;
            worst_angle = std::max(worst_angle, angle);
            gp_Pnt point;
            gp_Vec tangent;
            ec.D1(ec.FirstParameter() + (ec.LastParameter() - ec.FirstParameter()) * frac, point, tangent);
            const double jump = std::abs(across(pa, out_a, tangent) - across(pb, out_b, tangent));
            if (std::isfinite(jump)) worst = std::max(worst, jump);
        }
    }
    return worst;
}

bool fillet_v2_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    const FilletV2Spec& spec,
    TopoDS_Shape& built,
    double& volume,
    std::string& error) {
    const bool many = edges.size() > 1;
    const char* failed = many ? "The fillet did not fit these edges" : "The fillet did not fit this edge";
    if (edges.empty()) {
        error = failed;
        return false;
    }
    const bool is_var = spec.variable.size() >= 4;
    if (!is_var && !(spec.size > 0.0)) {
        error = "A fillet needs a positive radius";
        return false;
    }
    if (is_var) {
        for (size_t i = 0; i + 1 < spec.variable.size(); i += 2) {
            if (!std::isfinite(spec.variable[i]) || !std::isfinite(spec.variable[i + 1]) || !(spec.variable[i + 1] > 0.0)) {
                error = "Every variable fillet radius must be positive.";
                return false;
            }
        }
    }
    const std::string refused = blend_refusal(current, edges, false);
    if (!refused.empty()) {
        error = refused;
        return false;
    }
    g_stats.builds += 1;

    // Exact G2 quintic NURBS / exact rational Conic-rho path when continuity is G2 or Conic.
    if (spec.continuity == 1 || spec.continuity == 2) {
        TopoDS_Shape running = current;
        bool all_exact = true;
        for (const TopoDS_Edge& e : edges) {
            // Re-locate edge on running solid when applying sequentially to multiple edges.
            TopoDS_Edge target = e;
            if (!running.IsSame(current)) {
                BRepAdaptor_Curve orig_c(e);
                const gp_Pnt orig_mid = orig_c.Value(0.5 * (orig_c.FirstParameter() + orig_c.LastParameter()));
                double best_d = 1e-2;
                TopoDS_Edge found;
                for (TopExp_Explorer ex(running, TopAbs_EDGE); ex.More(); ex.Next()) {
                    const TopoDS_Edge cand = TopoDS::Edge(ex.Current());
                    BRepAdaptor_Curve cc(cand);
                    const gp_Pnt cm = cc.Value(0.5 * (cc.FirstParameter() + cc.LastParameter()));
                    const double d = cm.Distance(orig_mid);
                    if (d < best_d) {
                        best_d = d;
                        found = cand;
                    }
                }
                if (found.IsNull()) {
                    all_exact = false;
                    break;
                }
                target = found;
            }
            TopoDS_Shape next_shape;
            if (!try_exact_edge_surface_fillet(running, target, spec, next_shape)) {
                all_exact = false;
                break;
            }
            running = next_shape;
        }
        if (all_exact) {
            const double vol = volume_of(running);
            if (vol > 1e-6) {
                built = running;
                volume = vol;
                return true;
            }
        }
    }

    // Standard OCCT BRepFilletAPI_MakeFillet (G1 constant/variable, and fallback for curved/multi-edge G2/Conic).
    try {
        const ChFi3d_FilletShape fshape = spec.continuity == 1 ? ChFi3d_Polynomial
            : spec.continuity == 2 ? ChFi3d_QuasiAngular
            : ChFi3d_Rational;
        BRepFilletAPI_MakeFillet builder(current, fshape);
        builder.SetContinuity(spec.continuity == 1 ? GeomAbs_C2 : GeomAbs_C1, 1e-4);
        if (is_var) {
            const int n = static_cast<int>(spec.variable.size() / 2);
            TColgp_Array1OfPnt2d u_and_r(1, n);
            for (int i = 0; i < n; ++i) {
                u_and_r.SetValue(
                    i + 1,
                    gp_Pnt2d(
                        std::clamp(spec.variable[static_cast<size_t>(i * 2)], 0.0, 1.0),
                        spec.variable[static_cast<size_t>(i * 2 + 1)]));
            }
            for (const TopoDS_Edge& edge : edges) {
                builder.Add(u_and_r, edge);
            }
        } else {
            for (const TopoDS_Edge& edge : edges) {
                builder.Add(spec.size, edge);
            }
        }
        Handle(Message_ProgressIndicator) watch;
        builder.Build(deadline_range(watch));
        if (!builder.IsDone() || builder.Shape().IsNull()) {
            error = past_deadline() ? deadline_message() : failed;
            return false;
        }
        const TopoDS_Shape solid = as_solid(builder.Shape());
        const double solid_volume = solid.IsNull() || !has_solid(solid) ? 0.0 : volume_of(solid);
        if (!(solid_volume > 1e-6)) {
            error = failed;
            return false;
        }
        // The exact G2 and conic sections are built only on a straight edge between two flat faces. Anything else came
        // here, to Open CASCADE's own fillet: it has no rho, so a conic is refused, and a G2 result is kept only when
        // its seams measure G2 as model_check does.
        // Picked edges that meet at a corner: each exact cutter is cut back to the flat faces that end its edge, so the
        // corner where two fillets meet is a blend of its own that the exact path does not build.
        bool corner = false;
        for (size_t i = 0; i < edges.size() && !corner; ++i) {
            for (size_t j = i + 1; j < edges.size() && !corner; ++j) {
                TopoDS_Vertex a0, a1, b0, b1;
                TopExp::Vertices(edges[i], a0, a1);
                TopExp::Vertices(edges[j], b0, b1);
                corner = a0.IsSame(b0) || a0.IsSame(b1) || a1.IsSame(b0) || a1.IsSame(b1);
            }
        }
        if ((spec.continuity == 1 || spec.continuity == 2) && corner) {
            error = std::string(spec.continuity == 2 ? "A conic" : "A G2") +
                " fillet is built only on straight edges between two flat faces that do not meet each other: picked "
                "edges that meet at a corner need a corner blend it does not build. Pick edges that do not touch, or use G1.";
            return false;
        }
        if (spec.continuity == 2) {
            error = "A conic fillet is built only on straight edges between two flat faces, as a convex corner.";
            return false;
        }
        if (spec.continuity == 1) {
            double angle = 0.0;
            const double jump = worst_fillet_seam_jump(solid, current, angle);
            // The same G2 bounds model_check classes by (kernel.h).
            if (!(jump >= 0.0) || jump > kContinuityJump || angle >= kContinuityAngleDeg) {
                std::ostringstream out;
                out.setf(std::ios::fixed);
                out.precision(6);
                out << "A G2 fillet is exact only on straight edges between two flat faces, as a convex corner. Here the "
                       "seams reach " << (jump >= 0.0 ? jump : 0.0) << " per mm of curvature jump and " << angle
                    << " degrees, over 0.001 per mm or 0.1 degrees.";
                error = out.str();
                return false;
            }
        }
        built = solid;
        volume = solid_volume;
        return true;
    } catch (const Standard_Failure&) {
        error = failed;
        return false;
    }
}

namespace {

gp_Pnt wire_centroid(const TopoDS_Wire& wire) {
    GProp_GProps props;
    BRepGProp::LinearProperties(wire, props);
    if (props.Mass() > 1e-9) return props.CentreOfMass();
    Bnd_Box box;
    BRepBndLib::Add(wire, box);
    if (box.IsVoid()) return gp_Pnt(0, 0, 0);
    double x0, y0, z0, x1, y1, z1;
    box.Get(x0, y0, z0, x1, y1, z1);
    return gp_Pnt(0.5 * (x0 + x1), 0.5 * (y0 + y1), 0.5 * (z0 + z1));
}

TopoDS_Wire transform_wire_affine(const TopoDS_Wire& wire, const gp_Pnt& from_c, const gp_Pnt& to_c, double scale) {
    gp_Trsf t1;
    t1.SetTranslation(gp_Vec(from_c, gp_Pnt(0, 0, 0)));
    gp_Trsf ts;
    ts.SetScale(gp_Pnt(0, 0, 0), std::max(scale, 1e-3));
    gp_Trsf t2;
    t2.SetTranslation(gp_Vec(gp_Pnt(0, 0, 0), to_c));
    gp_Trsf full = t2 * ts * t1;
    BRepBuilderAPI_Transform xf(wire, full, Standard_True);
    return TopoDS::Wire(xf.Shape());
}

TopoDS_Wire offset_wire_along(const TopoDS_Wire& wire, const gp_Vec& shift) {
    gp_Trsf tr;
    tr.SetTranslation(shift);
    BRepBuilderAPI_Transform xf(wire, tr, Standard_True);
    return TopoDS::Wire(xf.Shape());
}

}  // namespace

TopoDS_Shape build_loft_v2(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const LoftV2Spec& spec,
    const Held* held_for_edges,
    double& volume,
    std::string& error) {
    if (spec.sections.size() < 2) {
        error = "A loft needs at least 2 sections.";
        return {};
    }
    if (spec.sections.size() > 200) {
        error = "A loft takes at most 200 sections.";
        return {};
    }
    if (spec.closed && spec.sections.size() < 3) {
        error = "A closed periodic loft needs at least 3 sections.";
        return {};
    }

    // Build section wires / vertices.
    struct BuiltSec {
        bool is_apex = false;
        TopoDS_Vertex apex;
        TopoDS_Wire outer;
        std::vector<TopoDS_Wire> holes;
        gp_Pnt centre;
        gp_Dir normal;
    };
    std::vector<BuiltSec> built_secs;
    built_secs.reserve(spec.sections.size());
    size_t hole_count = 0;
    for (size_t i = 0; i < spec.sections.size(); ++i) {
        const LoftSection& sec = spec.sections[i];
        BuiltSec bs;
        if (sec.has_apex) {
            if (i != 0 && i + 1 != spec.sections.size()) {
                error = "A point apex section can only be the first or last section of a loft.";
                return {};
            }
            if (spec.closed) {
                error = "A closed periodic loft cannot have a point apex section.";
                return {};
            }
            bs.is_apex = true;
            bs.centre = gp_Pnt(sec.apex[0], sec.apex[1], sec.apex[2]);
            bs.apex = BRepBuilderAPI_MakeVertex(bs.centre);
            bs.normal = gp_Dir(0, 0, 1);
            built_secs.push_back(std::move(bs));
            continue;
        }
        if (!sweep_section_wires(sec, bs.outer, bs.holes, error)) {
            error = "Section " + std::to_string(i) + ": " + error;
            return {};
        }
        bs.centre = wire_centroid(bs.outer);
        const ProfileFrame fr = frame_of(sec.profile);
        bs.normal = fr.w;
        if (built_secs.empty() || (built_secs.size() == 1 && built_secs[0].is_apex)) {
            hole_count = bs.holes.size();
        } else if (bs.holes.size() != hole_count) {
            error = "Every loft section needs the same number of holes.";
            return {};
        }
        built_secs.push_back(std::move(bs));
    }

    // Build optional 3D guide rail adaptors.
    std::vector<TopoDS_Wire> guide_wires;
    for (const Curve3DSpec& g : spec.guides) {
        TopoDS_Wire gw = curve3d_wire(g, held_for_edges, error);
        if (gw.IsNull()) return {};
        guide_wires.push_back(gw);
    }

    // Build the ordered list of outer wires (inserting guide-driven intermediate wires & boundary tangency wires).
    auto run_loft_chain = [&](bool is_hole, size_t hole_idx) -> TopoDS_Shape {
        const bool want_solid = !spec.closed;
        BRepOffsetAPI_ThruSections loft(want_solid ? Standard_True : Standard_False, spec.ruled ? Standard_True : Standard_False, 1e-6);
        loft.CheckCompatibility(Standard_True);
        const bool need_smooth = spec.smoothing || !guide_wires.empty()
            || spec.start_cond.kind != 0 || spec.end_cond.kind != 0;
        if (need_smooth && !spec.ruled) {
            loft.SetSmoothing(Standard_True);
            loft.SetContinuity(GeomAbs_C2);
            loft.SetParType(Approx_Centripetal);
        }
        if (spec.max_degree >= 2 && spec.max_degree <= 10) {
            loft.SetMaxDegree(spec.max_degree);
        }

        // Case A: Guide-rail driven loft between sections (when guides provided and no apexes).
        if (!is_hole && !guide_wires.empty() && built_secs.size() >= 2 && !built_secs.front().is_apex && !built_secs.back().is_apex) {
            const TopoDS_Wire& w0 = built_secs.front().outer;
            const TopoDS_Wire& w1 = built_secs.back().outer;
            const gp_Pnt c0 = built_secs.front().centre;
            const gp_Pnt c1 = built_secs.back().centre;

            std::vector<BRepAdaptor_CompCurve> rails;
            rails.reserve(guide_wires.size());
            std::vector<double> r0_dist;
            for (const TopoDS_Wire& gw : guide_wires) {
                rails.emplace_back(gw);
                const gp_Pnt rp0 = rails.back().Value(rails.back().FirstParameter());
                r0_dist.push_back(std::max(c0.Distance(rp0), 1e-3));
            }
            const int n_mid = 10;
            loft.AddWire(w0);
            for (int k = 1; k < n_mid; ++k) {
                const double t = static_cast<double>(k) / static_cast<double>(n_mid);
                const gp_Pnt base_c(
                    c0.X() + (c1.X() - c0.X()) * t,
                    c0.Y() + (c1.Y() - c0.Y()) * t,
                    c0.Z() + (c1.Z() - c0.Z()) * t);
                double scale = 1.0;
                gp_Pnt target_c = base_c;
                if (rails.size() == 1) {
                    const double u = rails[0].FirstParameter() + (rails[0].LastParameter() - rails[0].FirstParameter()) * t;
                    const gp_Pnt rp = rails[0].Value(u);
                    const gp_Pnt rp0 = rails[0].Value(rails[0].FirstParameter());
                    const gp_Pnt rp1 = rails[0].Value(rails[0].LastParameter());
                    // Measure radial bulge relative to the chord connecting rail start & end.
                    const gp_Pnt chord_p(
                        rp0.X() + (rp1.X() - rp0.X()) * t,
                        rp0.Y() + (rp1.Y() - rp0.Y()) * t,
                        rp0.Z() + (rp1.Z() - rp0.Z()) * t);
                    const double base_rad = std::max(base_c.Distance(chord_p), 1e-3);
                    const double rail_rad = std::max(base_c.Distance(rp), 1e-3);
                    scale = rail_rad / base_rad;
                } else {
                    // Multi-rail: average center of rail points and average radial scale ratio.
                    double cx = 0, cy = 0, cz = 0;
                    std::vector<gp_Pnt> rpts;
                    for (const BRepAdaptor_CompCurve& rail : rails) {
                        const double u = rail.FirstParameter() + (rail.LastParameter() - rail.FirstParameter()) * t;
                        const gp_Pnt rp = rail.Value(u);
                        rpts.push_back(rp);
                        cx += rp.X();
                        cy += rp.Y();
                        cz += rp.Z();
                    }
                    const double inv = 1.0 / static_cast<double>(rpts.size());
                    target_c = gp_Pnt(cx * inv, cy * inv, cz * inv);
                    double ratio_sum = 0.0;
                    for (size_t r = 0; r < rpts.size(); ++r) {
                        ratio_sum += std::max(target_c.Distance(rpts[r]), 1e-3) / r0_dist[r];
                    }
                    scale = ratio_sum * inv;
                }
                loft.AddWire(transform_wire_affine(w0, c0, target_c, scale));
            }
            loft.AddWire(w1);
        } else {
            // Case B: Standard / Apex / Boundary-Condition / Closed Periodic loft.
            for (size_t i = 0; i < built_secs.size(); ++i) {
                const BuiltSec& bs = built_secs[i];
                if (bs.is_apex) {
                    if (!is_hole) loft.AddVertex(bs.apex);
                    continue;
                }
                const TopoDS_Wire& w = is_hole ? bs.holes[hole_idx] : bs.outer;

                // End boundary condition BEFORE the last section.
                if (i + 1 == built_secs.size() && spec.end_cond.kind != 0 && !spec.ruled && built_secs.size() >= 2) {
                    const gp_Vec span(built_secs[i - 1].centre, bs.centre);
                    const double span_len = span.Magnitude();
                    gp_Vec dir = spec.end_cond.has_dir
                        ? gp_Vec(spec.end_cond.dir[0], spec.end_cond.dir[1], spec.end_cond.dir[2])
                        : gp_Vec(bs.normal);
                    if (dir.Magnitude() > 1e-9 && span_len > 1e-4) {
                        dir.Normalize();
                        if (dir.Dot(span) < 0.0) dir.Reverse();
                        const double tension = std::clamp(spec.end_cond.tension, 0.1, 3.0);
                        const double step = std::clamp(0.06 * tension * span_len, 0.05, 0.25 * span_len);
                        loft.AddWire(offset_wire_along(w, dir * (-step)));
                    }
                }

                loft.AddWire(w);

                // Start boundary condition AFTER the first section.
                if (i == 0 && spec.start_cond.kind != 0 && !spec.ruled && built_secs.size() >= 2) {
                    const gp_Vec span(bs.centre, built_secs[1].centre);
                    const double span_len = span.Magnitude();
                    gp_Vec dir = spec.start_cond.has_dir
                        ? gp_Vec(spec.start_cond.dir[0], spec.start_cond.dir[1], spec.start_cond.dir[2])
                        : gp_Vec(bs.normal);
                    if (dir.Magnitude() > 1e-9 && span_len > 1e-4) {
                        dir.Normalize();
                        if (dir.Dot(span) < 0.0) dir.Reverse();
                        const double tension = std::clamp(spec.start_cond.tension, 0.1, 3.0);
                        const double step = std::clamp(0.06 * tension * span_len, 0.05, 0.25 * span_len);
                        loft.AddWire(offset_wire_along(w, dir * step));
                    }
                }
            }
            if (spec.closed && !built_secs.empty() && !built_secs[0].is_apex) {
                loft.AddWire(is_hole ? built_secs[0].holes[hole_idx] : built_secs[0].outer);
            }
        }

        TopoDS_Shape tool;
        try {
            loft.Build();
            if (!loft.IsDone() || loft.Shape().IsNull()) {
                error = "Open CASCADE could not loft through these sections. Check that each one is a simple outline and that they do not cross.";
                return {};
            }
            tool = loft.Shape();
        } catch (const Standard_Failure&) {
            error = "Open CASCADE could not loft through these sections. Check that each one is a simple outline and that they do not cross.";
            return {};
        }

        if (spec.closed) {
            // Closed periodic loft produces a closed shell -> sew & promote to watertight solid.
            BRepBuilderAPI_Sewing sew(1e-4);
            sew.Add(tool);
            sew.Perform();
            TopoDS_Shape sewed = sew.SewedShape();
            TopoDS_Shell shell;
            for (TopExp_Explorer ex(sewed, TopAbs_SHELL); ex.More(); ex.Next()) {
                shell = TopoDS::Shell(ex.Current());
                break;
            }
            if (shell.IsNull()) {
                BRep_Builder bb;
                bb.MakeShell(shell);
                int face_count = 0;
                for (TopExp_Explorer ex(sewed, TopAbs_FACE); ex.More(); ex.Next()) {
                    bb.Add(shell, ex.Current());
                    ++face_count;
                }
                if (face_count == 0) {
                    error = "The closed loft did not form a closed shell.";
                    return {};
                }
                shell.Closed(Standard_True);
            }
            BRepBuilderAPI_MakeSolid ms(shell);
            if (!ms.IsDone() || ms.Solid().IsNull()) {
                error = "The closed loft did not form a watertight solid.";
                return {};
            }
            tool = ms.Solid();
        }
        if (!has_solid(tool)) {
            error = "The loft did not close into a solid.";
            return {};
        }
        tool = as_solid(tool);
        GProp_GProps props;
        integrate(tool, props);
        if (std::abs(props.Mass()) <= 1e-6) {
            error = "The loft has no volume.";
            return {};
        }
        if (props.Mass() < 0.0) {
            tool.Reverse();
        }
        if (!BRepCheck_Analyzer(tool).IsValid()) {
            ShapeFix_Solid fix;
            fix.Init(TopoDS::Solid(tool));
            fix.Perform();
            tool = fix.Solid();
            if (!BRepCheck_Analyzer(tool).IsValid()) {
                error = "The loft twists through itself. Space the sections further apart, or make tight bends gentler.";
                return {};
            }
        }
        return tool;
    };

    TopoDS_Shape tool = run_loft_chain(false, 0);
    if (tool.IsNull()) return {};
    for (size_t h = 0; h < hole_count; ++h) {
        TopoDS_Shape hole_solid = run_loft_chain(true, h);
        if (hole_solid.IsNull()) return {};
        double cut_vol = 0.0;
        tool = combine(tool, "cut", hole_solid, cut_vol, error);
        if (tool.IsNull() || !error.empty()) {
            if (error.empty()) error = "Open CASCADE could not hollow the loft.";
            return {};
        }
    }

    if (current.IsNull()) {
        GProp_GProps props;
        integrate(tool, props);
        volume = std::abs(props.Mass());
        return tool;
    }
    return combine_profile_tools(current, before, which, {tool}, "loft", volume, error);
}

// =================================================================================================
// Organic surfaces S4: Open Sheets & Surface-to-Solid Workflow
// (`Sheet`, `Sew`, `Thicken`, `TrimSplit`, `ReplaceFace`, `SplitFace`)
// =================================================================================================

namespace {

int count_naked_edges(const TopoDS_Shape& shape) {
    if (shape.IsNull()) return 0;
    TopTools_IndexedDataMapOfShapeListOfShape ancestors;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, ancestors);
    int naked = 0;
    for (int i = 1; i <= ancestors.Extent(); ++i) {
        const TopoDS_Edge edge = TopoDS::Edge(ancestors.FindKey(i));
        if (BRep_Tool::Degenerated(edge)) continue;
        const TopTools_ListOfShape& flist = ancestors.FindFromIndex(i);
        bool closed_on_face = false;
        for (const TopoDS_Shape& f : flist) {
            if (BRep_Tool::IsClosed(edge, TopoDS::Face(f))) {
                closed_on_face = true;
                break;
            }
        }
        if (!closed_on_face && flist.Extent() < 2) {
            ++naked;
        }
    }
    return naked;
}

gp_Vec average_shape_normal(const TopoDS_Shape& shape) {
    gp_Vec sum(0, 0, 0);
    for (TopExp_Explorer ex(shape, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face face = TopoDS::Face(ex.Current());
        Standard_Real u1 = 0, u2 = 0, v1 = 0, v2 = 0;
        BRepTools::UVBounds(face, u1, u2, v1, v2);
        const Standard_Real u = 0.5 * (u1 + u2);
        const Standard_Real v = 0.5 * (v1 + v2);
        BRepAdaptor_Surface surf(face, Standard_True);
        BRepLProp_SLProps props(surf, u, v, 1, 1e-7);
        if (props.IsNormalDefined()) {
            gp_Dir n = props.Normal();
            if (face.Orientation() == TopAbs_REVERSED) n.Reverse();
            GProp_GProps gp;
            BRepGProp::SurfaceProperties(face, gp);
            sum += gp_Vec(n) * std::max(gp.Mass(), 1e-3);
        }
    }
    if (sum.Magnitude() <= 1e-9) return gp_Vec(0, 0, 1);
    sum.Normalize();
    return sum;
}

gp_Pnt shape_centroid(const TopoDS_Shape& shape) {
    GProp_GProps props;
    if (has_solid(shape)) {
        BRepGProp::VolumeProperties(shape, props);
    } else {
        BRepGProp::SurfaceProperties(shape, props);
    }
    return props.CentreOfMass();
}

TopoDS_Shape promote_shell_to_solid(const TopoDS_Shape& sewn, double& volume) {
    volume = 0.0;
    TopoDS_Shell shell;
    for (TopExp_Explorer ex(sewn, TopAbs_SHELL); ex.More(); ex.Next()) {
        shell = TopoDS::Shell(ex.Current());
        break;
    }
    if (shell.IsNull()) {
        BRep_Builder bb;
        bb.MakeShell(shell);
        int faces = 0;
        for (TopExp_Explorer ex(sewn, TopAbs_FACE); ex.More(); ex.Next()) {
            bb.Add(shell, ex.Current());
            ++faces;
        }
        if (faces == 0) return {};
        shell.Closed(Standard_True);
    }
    {
        ShapeFix_Shape sf(shell);
        sf.Perform();
        const TopoDS_Shape fixed_sh = sf.Shape();
        for (TopExp_Explorer ex(fixed_sh, TopAbs_SHELL); ex.More(); ex.Next()) {
            shell = TopoDS::Shell(ex.Current());
            break;
        }
    }
    shell.Closed(Standard_True);
    ShapeFix_Solid fix_from_shell;
    TopoDS_Solid solid = fix_from_shell.SolidFromShell(shell);
    if (solid.IsNull()) {
        BRepBuilderAPI_MakeSolid ms(shell);
        if (!ms.IsDone() || ms.Solid().IsNull()) return {};
        solid = ms.Solid();
    }
    BRepLib::OrientClosedSolid(solid);
    GProp_GProps props;
    integrate(solid, props);
    if (props.Mass() < 0.0) {
        solid.Reverse();
        integrate(solid, props);
    }
    if (std::abs(props.Mass()) <= 1e-6) return {};
    if (!BRepCheck_Analyzer(solid).IsValid()) {
        ShapeFix_Solid fix;
        fix.Init(solid);
        fix.Perform();
        if (!fix.Solid().IsNull() && has_solid(fix.Solid())) {
            solid = TopoDS::Solid(as_solid(fix.Solid()));
            BRepLib::OrientClosedSolid(solid);
            integrate(solid, props);
            if (props.Mass() < 0.0) {
                solid.Reverse();
                integrate(solid, props);
            }
        }
    }
    if (!BRepCheck_Analyzer(solid).IsValid()) return {};
    volume = std::abs(props.Mass());
    return solid;
}

TopoDS_Shape build_sheet_only(const SheetSpec& spec, const Held* held_for_edges, std::string& error) {
    if (spec.curves.empty()) {
        error = "A sheet needs at least one 3D curve.";
        return {};
    }
    try {
        if (spec.mode == 0) {
            // Extrude an open 3D curve along dir * distance -> exact open sheet.
            const gp_Vec raw_dir(spec.dir[0], spec.dir[1], spec.dir[2]);
            if (raw_dir.Magnitude() <= 1e-9 || !std::isfinite(spec.distance) || std::abs(spec.distance) <= 1e-6) {
                error = "Sheet extrude needs a non-zero direction and distance.";
                return {};
            }
            gp_Vec vec = raw_dir.Normalized() * spec.distance;
            TopoDS_Wire w = curve3d_wire(spec.curves[0], held_for_edges, error);
            if (w.IsNull()) return {};
            if (spec.symmetric) {
                gp_Trsf shift;
                shift.SetTranslation(vec * -0.5);
                w = TopoDS::Wire(BRepBuilderAPI_Transform(w, shift, Standard_True).Shape());
            }
            BRepPrimAPI_MakePrism prism(w, vec, Standard_True);
            prism.Build();
            if (!prism.IsDone() || prism.Shape().IsNull() || count_of(prism.Shape(), TopAbs_FACE) == 0) {
                error = "Open CASCADE could not extrude this curve into a sheet.";
                return {};
            }
            return prism.Shape();
        }
        if (spec.mode == 1) {
            // Revolve an open 3D curve about axis -> exact open revolved sheet.
            const gp_Vec raw_dir(spec.dir[0], spec.dir[1], spec.dir[2]);
            if (raw_dir.Magnitude() <= 1e-9 || !std::isfinite(spec.angle_deg) || std::abs(spec.angle_deg) <= 1e-6 || std::abs(spec.angle_deg) > 360.0 + 1e-6) {
                error = "Sheet revolve needs a non-zero axis direction and angle (up to 360°).";
                return {};
            }
            TopoDS_Wire w = curve3d_wire(spec.curves[0], held_for_edges, error);
            if (w.IsNull()) return {};
            const gp_Ax1 axis(gp_Pnt(spec.axis_origin[0], spec.axis_origin[1], spec.axis_origin[2]), gp_Dir(raw_dir));
            const double angle = spec.angle_deg * (kPi / 180.0);
            BRepPrimAPI_MakeRevol rev(w, axis, angle, Standard_True);
            rev.Build();
            if (!rev.IsDone() || rev.Shape().IsNull() || count_of(rev.Shape(), TopAbs_FACE) == 0) {
                error = "Open CASCADE could not revolve this curve into a sheet.";
                return {};
            }
            return rev.Shape();
        }
        if (spec.mode == 2) {
            // Loft through 2+ open (or closed) 3D curves -> exact smooth/ruled open NURBS sheet.
            if (spec.curves.size() < 2) {
                error = "Sheet loft needs at least two 3D curves.";
                return {};
            }
            BRepOffsetAPI_ThruSections loft(Standard_False, spec.ruled ? Standard_True : Standard_False, 1e-6);
            loft.CheckCompatibility(Standard_True);
            if (!spec.ruled) {
                loft.SetSmoothing(Standard_True);
                loft.SetContinuity(GeomAbs_C2);
                loft.SetParType(Approx_Centripetal);
            }
            for (const Curve3DSpec& c : spec.curves) {
                TopoDS_Wire w = curve3d_wire(c, held_for_edges, error);
                if (w.IsNull()) return {};
                loft.AddWire(w);
            }
            loft.Build();
            if (!loft.IsDone() || loft.Shape().IsNull() || count_of(loft.Shape(), TopAbs_FACE) == 0) {
                error = "Open CASCADE could not loft these curves into a sheet.";
                return {};
            }
            return loft.Shape();
        }
        if (spec.mode == 3) {
            // Planar face bounded by a closed 3D curve.
            TopoDS_Wire w = curve3d_wire(spec.curves[0], held_for_edges, error);
            if (w.IsNull()) return {};
            BRepBuilderAPI_MakeFace mf(w, Standard_True);
            if (!mf.IsDone() || mf.Face().IsNull()) {
                error = "The boundary curve is not a closed planar loop.";
                return {};
            }
            return mf.Face();
        }
        error = "Unknown sheet mode.";
        return {};
    } catch (const Standard_Failure& f) {
        error = f.GetMessageString() ? f.GetMessageString() : "Open CASCADE could not build this sheet.";
        return {};
    }
}

TopoDS_Shape transform_placed(const TopoDS_Shape& shape, const std::array<double, 12>& place) {
    gp_Trsf trsf;
    trsf.SetValues(
        place[0], place[1], place[2], place[9],
        place[3], place[4], place[5], place[10],
        place[6], place[7], place[8], place[11]);
    return BRepBuilderAPI_Transform(shape, trsf, Standard_True).Shape();
}

/// Build an offset copy of a single face or shell without thickening, used as fallback skin builder.
TopoDS_Shape build_offset_skin(const TopoDS_Shape& base, double dist, double tol) {
    if (std::abs(dist) <= 1e-9) {
        return BRepBuilderAPI_Copy(base).Shape();
    }
    try {
        BRepOffset_MakeOffset off;
        off.Initialize(base, dist, tol, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Arc, Standard_False);
        off.MakeOffsetShape();
        if (off.IsDone() && !off.Shape().IsNull() && count_of(off.Shape(), TopAbs_FACE) > 0) {
            return off.Shape();
        }
    } catch (...) {
    }
    // A shift along the normal is that offset exactly only when every face is a plane with the same outward normal.
    // Anything curved gets no skin: shifting it would give a wall of uneven thickness.
    gp_Dir common;
    bool first = true;
    for (TopExp_Explorer ex(base, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face face = TopoDS::Face(ex.Current());
        const BRepAdaptor_Surface surface(face);
        if (surface.GetType() != GeomAbs_Plane) return {};
        const gp_Pln plane = surface.Plane();
        gp_Dir normal = plane.Axis().Direction();
        if (!plane.Position().Direct()) normal.Reverse();
        if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
        if (first) {
            common = normal;
            first = false;
        } else if (normal.Dot(common) < 1.0 - 1e-9) {
            return {};
        }
    }
    if (first) return {};
    gp_Trsf tr;
    tr.SetTranslation(gp_Vec(common) * dist);
    return BRepBuilderAPI_Transform(base, tr, Standard_True).Shape();
}

}  // namespace

TopoDS_Shape build_sheet(
    const TopoDS_Shape& current,
    const Held* held_for_edges,
    const SheetSpec& spec,
    std::string& error) {
    TopoDS_Shape sheet = build_sheet_only(spec, held_for_edges, error);
    if (sheet.IsNull()) return {};
    if (current.IsNull()) {
        return sheet;
    }
    TopoDS_Compound comp;
    BRep_Builder bb;
    bb.MakeCompound(comp);
    for (TopExp_Explorer ex(current, TopAbs_FACE); ex.More(); ex.Next()) {
        bb.Add(comp, ex.Current());
    }
    for (TopExp_Explorer ex(sheet, TopAbs_FACE); ex.More(); ex.Next()) {
        bb.Add(comp, ex.Current());
    }
    return comp;
}

TopoDS_Shape build_sew(
    const TopoDS_Shape& current,
    const std::vector<const TopoDS_Shape*>& extra_tools,
    const std::vector<std::array<double, 12>>& tool_places,
    double tolerance,
    bool make_solid,
    bool cap_planar,
    double& volume,
    bool& promoted_to_solid,
    int& naked_after,
    std::string& error) {
    volume = 0.0;
    promoted_to_solid = false;
    naked_after = 0;
    const double tol = std::clamp(tolerance > 0.0 ? tolerance : 1e-3, 1e-6, 1.0);
    try {
        BRepBuilderAPI_Sewing sew(tol);
        sew.SetNonManifoldMode(Standard_False);
        for (TopExp_Explorer ex(current, TopAbs_FACE); ex.More(); ex.Next()) {
            sew.Add(ex.Current());
        }
        for (size_t i = 0; i < extra_tools.size(); ++i) {
            if (extra_tools[i] == nullptr || extra_tools[i]->IsNull()) continue;
            TopoDS_Shape ts = i < tool_places.size()
                ? transform_placed(*extra_tools[i], tool_places[i])
                : *extra_tools[i];
            for (TopExp_Explorer ex(ts, TopAbs_FACE); ex.More(); ex.Next()) {
                sew.Add(ex.Current());
            }
        }
        sew.Perform();
        TopoDS_Shape sewn = sew.SewedShape();
        if (sewn.IsNull() || count_of(sewn, TopAbs_FACE) == 0) {
            error = "Sewing produced no faces.";
            return {};
        }
        if (cap_planar && count_naked_edges(sewn) > 0) {
            Handle(TopTools_HSequenceOfShape) free_edges = new TopTools_HSequenceOfShape();
            TopTools_IndexedDataMapOfShapeListOfShape anc;
            TopExp::MapShapesAndAncestors(sewn, TopAbs_EDGE, TopAbs_FACE, anc);
            for (int i = 1; i <= anc.Extent(); ++i) {
                const TopoDS_Edge e = TopoDS::Edge(anc.FindKey(i));
                if (BRep_Tool::Degenerated(e)) continue;
                if (anc.FindFromIndex(i).Extent() < 2) {
                    free_edges->Append(e);
                }
            }
            Handle(TopTools_HSequenceOfShape) wires;
            ShapeAnalysis_FreeBounds::ConnectEdgesToWires(free_edges, tol * 10.0, Standard_False, wires);
            if (!wires.IsNull() && wires->Length() > 0) {
                BRepBuilderAPI_Sewing sew2(tol);
                sew2.Add(sewn);
                int caps_added = 0;
                for (int w = 1; w <= wires->Length(); ++w) {
                    const TopoDS_Wire wire = TopoDS::Wire(wires->Value(w));
                    if (!wire.Closed() && !BRep_Tool::IsClosed(wire)) continue;
                    BRepBuilderAPI_MakeFace cap(wire, Standard_True);
                    if (cap.IsDone() && !cap.Face().IsNull()) {
                        sew2.Add(cap.Face());
                        ++caps_added;
                    }
                }
                if (caps_added > 0) {
                    sew2.Perform();
                    if (!sew2.SewedShape().IsNull()) {
                        sewn = sew2.SewedShape();
                    }
                }
            }
        }

        naked_after = count_naked_edges(sewn);
        if (make_solid && naked_after == 0) {
            double solid_vol = 0.0;
            TopoDS_Shape solid = promote_shell_to_solid(sewn, solid_vol);
            if (!solid.IsNull()) {
                volume = solid_vol;
                promoted_to_solid = true;
                return solid;
            }
        }
        if (has_solid(sewn)) {
            GProp_GProps props;
            integrate(sewn, props);
            volume = std::abs(props.Mass());
            promoted_to_solid = true;
        }
        return sewn;
    } catch (const Standard_Failure& f) {
        error = f.GetMessageString() ? f.GetMessageString() : "Open CASCADE could not sew these surfaces.";
        return {};
    }
}

TopoDS_Shape build_thicken(
    const TopoDS_Shape& current,
    double thickness,
    int direction,
    double tolerance,
    double& volume,
    std::string& error) {
    volume = 0.0;
    if (!std::isfinite(thickness) || !(thickness > 1e-4)) {
        error = "Thicken needs a thickness above 0 mm.";
        return {};
    }
    if (count_of(current, TopAbs_FACE) == 0) {
        error = "Thicken needs a surface or shell with at least one face.";
        return {};
    }
    const double tol = std::clamp(tolerance > 0.0 ? tolerance : 1e-3, 1e-5, 0.1);
    try {
        // Pre-sew touching faces in a compound so OCCT sees one connected shell.
        TopoDS_Shape base = current;
        if (count_of(current, TopAbs_FACE) > 1) {
            BRepBuilderAPI_Sewing pre(tol);
            pre.Add(current);
            pre.Perform();
            if (!pre.SewedShape().IsNull() && count_of(pre.SewedShape(), TopAbs_FACE) > 0) {
                base = pre.SewedShape();
            }
        }

        const double d_lo = direction == 2 ? -0.5 * thickness : (direction == 1 ? -thickness : 0.0);
        const double d_hi = direction == 2 ? 0.5 * thickness : (direction == 1 ? 0.0 : thickness);

        // Path 1: Native OCCT BRepOffset_MakeOffset with Thickening = true.
        try {
            TopoDS_Shape start_skin = std::abs(d_lo) > 1e-9 ? build_offset_skin(base, d_lo, tol) : base;
            const double signed_t = d_hi - d_lo;
            if (!start_skin.IsNull()) {
                BRepOffset_MakeOffset off;
                off.Initialize(start_skin, signed_t, tol, BRepOffset_Skin, Standard_False, Standard_False, GeomAbs_Arc, Standard_True);
                off.MakeOffsetShape();
                if (off.IsDone() && !off.Shape().IsNull()) {
                    TopoDS_Shape cand = off.Shape();
                    if (!has_solid(cand) && count_naked_edges(cand) == 0) {
                        double sv = 0.0;
                        TopoDS_Shape prom = promote_shell_to_solid(cand, sv);
                        if (!prom.IsNull()) cand = prom;
                    }
                    if (has_solid(cand)) {
                        cand = as_solid(cand);
                        BRepLib::OrientClosedSolid(TopoDS::Solid(cand));
                        GProp_GProps props;
                        integrate(cand, props);
                        if (props.Mass() < 0.0) {
                            cand.Reverse();
                            integrate(cand, props);
                        }
                        if (std::abs(props.Mass()) > 1e-6 && count_naked_edges(cand) == 0 && BRepCheck_Analyzer(cand).IsValid()) {
                            volume = std::abs(props.Mass());
                            return cand;
                        }
                    }
                }
            }
        } catch (...) {
        }

        // Path 2: Explicit two-skin offset + ruled side-wall ribbon + sewing + solid promotion.
        TopoDS_Shape skin_a = build_offset_skin(base, d_lo, tol);
        TopoDS_Shape skin_b = build_offset_skin(base, d_hi, tol);
        if (skin_a.IsNull() || skin_b.IsNull()) {
            std::ostringstream out;
            out << "Open CASCADE could not offset this sheet by " << thickness << " mm. Try a thinner wall or the other direction.";
            error = out.str();
            return {};
        }
        // Collect ordered naked edges on skin_a and skin_b and pair them by nearest midpoint.
        auto naked_edges_of = [](const TopoDS_Shape& s) -> std::vector<TopoDS_Edge> {
            std::vector<TopoDS_Edge> out;
            TopTools_IndexedDataMapOfShapeListOfShape anc;
            TopExp::MapShapesAndAncestors(s, TopAbs_EDGE, TopAbs_FACE, anc);
            for (int i = 1; i <= anc.Extent(); ++i) {
                const TopoDS_Edge e = TopoDS::Edge(anc.FindKey(i));
                if (BRep_Tool::Degenerated(e)) continue;
                if (anc.FindFromIndex(i).Extent() < 2) out.push_back(e);
            }
            return out;
        };
        auto edge_mid = [](const TopoDS_Edge& e) -> gp_Pnt {
            BRepAdaptor_Curve c(e);
            return c.Value(0.5 * (c.FirstParameter() + c.LastParameter()));
        };
        const std::vector<TopoDS_Edge> ea = naked_edges_of(skin_a);
        const std::vector<TopoDS_Edge> eb = naked_edges_of(skin_b);
        if (ea.size() != eb.size() || ea.empty()) {
            error = "Open CASCADE could not close the thickened side walls of this surface.";
            return {};
        }
        std::vector<bool> used(eb.size(), false);
        BRepBuilderAPI_Sewing sew(tol * 2.0);
        sew.Add(skin_a);
        sew.Add(skin_b);
        for (const TopoDS_Edge& e1 : ea) {
            const gp_Pnt m1 = edge_mid(e1);
            size_t best = eb.size();
            double best_d = 1e30;
            for (size_t j = 0; j < eb.size(); ++j) {
                if (used[j]) continue;
                const double d = m1.Distance(edge_mid(eb[j]));
                if (d < best_d) {
                    best_d = d;
                    best = j;
                }
            }
            if (best == eb.size()) continue;
            used[best] = true;
            TopoDS_Edge e2 = eb[best];
            BRepAdaptor_Curve c1(e1), c2(e2);
            const gp_Pnt p1s = c1.Value(c1.FirstParameter());
            const gp_Pnt p2s = c2.Value(c2.FirstParameter());
            const gp_Pnt p2e = c2.Value(c2.LastParameter());
            if (p1s.Distance(p2e) < p1s.Distance(p2s)) {
                e2.Reverse();
            }
            TopoDS_Face wall = BRepFill::Face(e1, e2);
            if (!wall.IsNull()) sew.Add(wall);
        }
        sew.Perform();
        TopoDS_Shape sewn = sew.SewedShape();
        double sv = 0.0;
        TopoDS_Shape solid = promote_shell_to_solid(sewn, sv);
        if (solid.IsNull() || count_naked_edges(solid) != 0) {
            error = "Thickening did not produce a watertight solid. Try a smaller thickness.";
            return {};
        }
        volume = sv;
        return solid;
    } catch (const Standard_Failure& f) {
        error = f.GetMessageString() ? f.GetMessageString() : "Open CASCADE could not thicken this surface.";
        return {};
    }
}

TopoDS_Shape build_trim_split(
    const TopoDS_Shape& current,
    const TopoDS_Shape& cutter,
    int keep_mode,
    TopoDS_Shape* other_out,
    double& volume,
    std::string& error) {
    volume = 0.0;
    if (other_out != nullptr) *other_out = TopoDS_Shape();
    if (current.IsNull() || cutter.IsNull()) {
        error = "Trim/Split needs both a target shape and a cutting surface.";
        return {};
    }
    try {
        BRepAlgoAPI_Splitter splitter;
        TopTools_ListOfShape args, tools;
        args.Append(current);
        tools.Append(cutter);
        splitter.SetArguments(args);
        splitter.SetTools(tools);
        splitter.SetNonDestructive(Standard_True);
        splitter.Build();
        if (!splitter.IsDone() || splitter.Shape().IsNull()) {
            error = "Open CASCADE could not split this shape with the cutting surface.";
            return {};
        }

        const bool is_solid = has_solid(current);
        std::vector<TopoDS_Shape> pieces;
        if (is_solid) {
            for (TopExp_Explorer ex(splitter.Shape(), TopAbs_SOLID); ex.More(); ex.Next()) {
                TopoDS_Shape s = ex.Current();
                GProp_GProps gp;
                integrate(s, gp);
                if (std::abs(gp.Mass()) > 1e-6) {
                    if (gp.Mass() < 0.0) s.Reverse();
                    pieces.push_back(s);
                }
            }
        } else {
            for (TopExp_Explorer ex(splitter.Shape(), TopAbs_FACE); ex.More(); ex.Next()) {
                TopoDS_Shape f = ex.Current();
                GProp_GProps gp;
                BRepGProp::SurfaceProperties(f, gp);
                if (gp.Mass() > 1e-6) pieces.push_back(f);
            }
        }
        if (pieces.size() < 2) {
            error = "The surface does not split the shape into two pieces. Extend the surface past its edges.";
            return {};
        }

        const gp_Vec n = average_shape_normal(cutter);
        const gp_Pnt origin = shape_centroid(cutter);
        auto score = [&](const TopoDS_Shape& s) -> double {
            const gp_Pnt c = shape_centroid(s);
            return gp_Vec(origin, c).Dot(n);
        };
        std::sort(pieces.begin(), pieces.end(), [&](const TopoDS_Shape& a, const TopoDS_Shape& b) {
            return score(a) > score(b);
        });

        // pieces.front() is the "above" (+normal) side; pieces.back() is the "below" (-normal) side.
        TopoDS_Shape above = pieces.front();
        TopoDS_Shape below = pieces.back();
        // If splitter produced >2 fragments (e.g. a curved wave cutting multiple lobes), group by sign of score.
        if (pieces.size() > 2) {
            TopoDS_Compound above_c, below_c;
            BRep_Builder bb;
            bb.MakeCompound(above_c);
            bb.MakeCompound(below_c);
            int na = 0, nb = 0;
            for (const TopoDS_Shape& p : pieces) {
                if (score(p) >= 0.0) {
                    bb.Add(above_c, p);
                    ++na;
                } else {
                    bb.Add(below_c, p);
                    ++nb;
                }
            }
            if (na > 0 && nb > 0) {
                above = na == 1 ? pieces.front() : TopoDS_Shape(above_c);
                below = nb == 1 ? pieces.back() : TopoDS_Shape(below_c);
            }
        }

        TopoDS_Shape kept = (keep_mode == 1) ? below : above;
        TopoDS_Shape other = (keep_mode == 1) ? above : below;
        if (keep_mode == 2 && other_out != nullptr) {
            *other_out = other;
        }
        if (is_solid) {
            GProp_GProps gp;
            integrate(kept, gp);
            volume = std::abs(gp.Mass());
        }
        return kept;
    } catch (const Standard_Failure& f) {
        error = f.GetMessageString() ? f.GetMessageString() : "Open CASCADE could not trim/split with this surface.";
        return {};
    }
}

TopoDS_Shape build_replace_face(
    const TopoDS_Shape& current,
    const TopoDS_Face& target_face,
    const TopoDS_Shape& replacement,
    double& volume,
    std::string& error) {
    volume = 0.0;
    if (current.IsNull() || !has_solid(current) || target_face.IsNull() || replacement.IsNull()) {
        error = "ReplaceFace needs a solid, a target face, and a replacement surface.";
        return {};
    }
    try {
        // Compute target face outward normal and centroid, plus bounding boxes.
        const gp_Vec target_n = average_shape_normal(target_face);
        const gp_Pnt target_c = shape_centroid(target_face);
        const gp_Pnt solid_c = shape_centroid(current);

        // Determine if replacement extends past target_face along +target_n; if so, extend the face outward first
        // so the replacement surface cleanly slices the extended solid body.
        Bnd_Box solid_box, rep_box;
        BRepBndLib::Add(current, solid_box);
        BRepBndLib::Add(replacement, rep_box);
        Standard_Real sx1, sy1, sz1, sx2, sy2, sz2;
        Standard_Real rx1, ry1, rz1, rx2, ry2, rz2;
        solid_box.Get(sx1, sy1, sz1, sx2, sy2, sz2);
        rep_box.Get(rx1, ry1, rz1, rx2, ry2, rz2);

        double max_proj = 0.0;
        const double rxs[2] = {rx1, rx2}, rys[2] = {ry1, ry2}, rzs[2] = {rz1, rz2};
        for (double x : rxs) for (double y : rys) for (double z : rzs) {
            max_proj = std::max(max_proj, gp_Vec(target_c, gp_Pnt(x, y, z)).Dot(target_n));
        }

        TopoDS_Shape working = current;
        if (max_proj > 1e-4) {
            const double pad = max_proj + 5.0;
            BRepPrimAPI_MakePrism ext(target_face, target_n * pad, Standard_True);
            ext.Build();
            if (ext.IsDone() && !ext.Shape().IsNull() && has_solid(ext.Shape())) {
                double fused_vol = 0.0;
                std::string fuse_err;
                TopoDS_Shape fused = combine(current, "fuse", ext.Shape(), fused_vol, fuse_err);
                if (!fused.IsNull() && has_solid(fused)) {
                    working = fused;
                }
            }
        }

        BRepAlgoAPI_Splitter splitter;
        TopTools_ListOfShape args, tools;
        args.Append(working);
        tools.Append(replacement);
        splitter.SetArguments(args);
        splitter.SetTools(tools);
        splitter.SetNonDestructive(Standard_True);
        splitter.Build();
        if (!splitter.IsDone() || splitter.Shape().IsNull()) {
            error = "Open CASCADE could not replace this face with the given surface.";
            return {};
        }

        std::vector<TopoDS_Shape> pieces;
        for (TopExp_Explorer ex(splitter.Shape(), TopAbs_SOLID); ex.More(); ex.Next()) {
            TopoDS_Shape s = ex.Current();
            GProp_GProps gp;
            integrate(s, gp);
            if (std::abs(gp.Mass()) > 1e-6) {
                if (gp.Mass() < 0.0) s.Reverse();
                pieces.push_back(s);
            }
        }
        if (pieces.size() < 2) {
            error = "The replacement surface does not span across the face's adjacent walls. Extend the surface slightly past the face.";
            return {};
        }

        // Keep the solid piece on the interior (-target_n) side of the target face (closest to the solid's body).
        TopoDS_Shape kept = pieces[0];
        double best_score = 1e30;
        for (const TopoDS_Shape& p : pieces) {
            const gp_Pnt pc = shape_centroid(p);
            // Prefer the piece whose centroid is furthest in the -target_n direction (the solid interior) and closest to solid_c.
            const double s = gp_Vec(solid_c, pc).Dot(target_n);
            if (s < best_score) {
                best_score = s;
                kept = p;
            }
        }
        if (!BRepCheck_Analyzer(kept).IsValid()) {
            ShapeFix_Solid fix;
            fix.Init(TopoDS::Solid(as_solid(kept)));
            fix.Perform();
            if (!fix.Solid().IsNull() && has_solid(fix.Solid())) kept = fix.Solid();
        }
        GProp_GProps gp;
        integrate(kept, gp);
        volume = std::abs(gp.Mass());
        return kept;
    } catch (const Standard_Failure& f) {
        error = f.GetMessageString() ? f.GetMessageString() : "Open CASCADE could not replace this face.";
        return {};
    }
}

TopoDS_Shape build_split_face(
    const TopoDS_Shape& current,
    const Held* held_for_edges,
    const std::vector<TopoDS_Face>& target_faces,
    const Curve3DSpec& curve,
    bool has_dir,
    const double dir[3],
    double& volume,
    std::string& error) {
    volume = 0.0;
    if (current.IsNull() || target_faces.empty()) {
        error = "SplitFace needs a shape and at least one target face.";
        return {};
    }
    TopoDS_Wire cw = curve3d_wire(curve, held_for_edges, error);
    if (cw.IsNull()) return {};

    try {
        const int faces_before = count_of(current, TopAbs_FACE);
        TopTools_ListOfShape projected_tools;
        for (const TopoDS_Face& face : target_faces) {
            int added = 0;
            if (has_dir) {
                const gp_Vec dv(dir[0], dir[1], dir[2]);
                if (dv.Magnitude() <= 1e-9) {
                    error = "SplitFace projection direction cannot be zero.";
                    return {};
                }
                const gp_Dir pd(dv);
                for (int sign : {1, -1}) {
                    BRepProj_Projection proj(cw, face, sign > 0 ? pd : pd.Reversed());
                    for (; proj.More(); proj.Next()) {
                        const TopoDS_Wire pw = proj.Current();
                        if (!pw.IsNull()) {
                            projected_tools.Append(pw);
                            ++added;
                        }
                    }
                    if (added > 0) break;
                }
            } else {
                try {
                    BRepOffsetAPI_NormalProjection np(face);
                    np.Add(cw);
                    np.Build();
                    if (np.IsDone() && !np.Shape().IsNull() && count_of(np.Shape(), TopAbs_EDGE) > 0) {
                        projected_tools.Append(np.Shape());
                        ++added;
                    }
                } catch (...) {
                }
                if (added == 0) {
                    const gp_Vec fn = average_shape_normal(face);
                    const gp_Dir pd(fn);
                    for (int sign : {1, -1}) {
                        BRepProj_Projection proj(cw, face, sign > 0 ? pd : pd.Reversed());
                        for (; proj.More(); proj.Next()) {
                            const TopoDS_Wire pw = proj.Current();
                            if (!pw.IsNull()) {
                                projected_tools.Append(pw);
                                ++added;
                            }
                        }
                        if (added > 0) break;
                    }
                }
            }
        }
        if (projected_tools.IsEmpty()) {
            error = "The curve did not project onto the selected face(s).";
            return {};
        }

        BRepAlgoAPI_Splitter splitter;
        TopTools_ListOfShape args;
        args.Append(current);
        splitter.SetArguments(args);
        splitter.SetTools(projected_tools);
        splitter.SetNonDestructive(Standard_True);
        splitter.Build();
        if (!splitter.IsDone() || splitter.Shape().IsNull()) {
            error = "Open CASCADE could not split the face along the projected curve.";
            return {};
        }
        TopoDS_Shape out = splitter.Shape();
        const int faces_after = count_of(out, TopAbs_FACE);
        if (faces_after <= faces_before) {
            error = "The projected curve did not divide any face. Make sure the curve crosses from edge to edge or forms a closed loop on the face.";
            return {};
        }
        if (has_solid(current)) {
            if (!has_solid(out)) {
                error = "Splitting the face broke the solid.";
                return {};
            }
            out = as_solid(out);
            GProp_GProps gp;
            integrate(out, gp);
            volume = std::abs(gp.Mass());
        }
        return out;
    } catch (const Standard_Failure& f) {
        error = f.GetMessageString() ? f.GetMessageString() : "Open CASCADE could not split this face.";
        return {};
    }
}

// Test-only, and only in a debug build. The app and the MCP never set this:
// there is no op field for it. -1 leaves every ribbon alone. 0 or 1 reverses
// that blend side's cross derivative.
#ifdef LIME_OCCT_TEST_HOOKS
thread_local int g_blend_reverse_side = -1;
#endif

namespace {

constexpr double kPatchJoinMm = 0.05;

Handle(Geom_BSplineCurve) edge_to_bspline(const TopoDS_Edge& edge, std::string& error) {
    TopoDS_Edge built = edge;
    Standard_Real first = 0.0;
    Standard_Real last = 0.0;
    // This form of BRep_Tool::Curve already applies the edge's location: the curve is where the edge is.
    Handle(Geom_Curve) curve = BRep_Tool::Curve(built, first, last);
    if (curve.IsNull()) {
        // BuildCurve3d writes the curve into the edge, which the held shape shares: build it on a copy.
        built = TopoDS::Edge(BRepBuilderAPI_Copy(edge, Standard_True, Standard_False).Shape());
        BRepLib::BuildCurve3d(built);
        curve = BRep_Tool::Curve(built, first, last);
    }
    if (curve.IsNull() || !(last > first + 1e-12)) {
        error = "These edges do not form a closed opening. Pick the edges around one opening, in order.";
        return {};
    }
    Handle(Geom_Curve) trimmed = new Geom_TrimmedCurve(curve, first, last);
    Handle(Geom_BSplineCurve) bs = GeomConvert::CurveToBSplineCurve(trimmed);
    if (bs.IsNull()) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    // CurveToBSplineCurve can hand back the edge's own curve. Reverse that and the sheet's edge moves.
    bs = Handle(Geom_BSplineCurve)::DownCast(bs->Copy());
    if (bs.IsNull()) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    if (built.Orientation() == TopAbs_REVERSED) bs->Reverse();
    return bs;
}

Handle(Geom_BSplineCurve) chain_to_bspline(const std::vector<TopoDS_Edge>& edges, std::string& error) {
    if (edges.empty()) {
        error = "A patch side needs a curve or an edge of the sheet.";
        return {};
    }
    std::vector<Handle(Geom_BSplineCurve)> pieces;
    for (const TopoDS_Edge& edge : edges) {
        Handle(Geom_BSplineCurve) piece = edge_to_bspline(edge, error);
        if (piece.IsNull()) return {};
        pieces.push_back(piece);
    }
    if (pieces.size() == 1) return pieces[0];
    // Join the pieces end to start, whatever order and direction they were picked in: start from the first, turn it so
    // its end meets another piece, then take the piece that meets the running end each time.
    Handle(Geom_BSplineCurve) first = pieces[0];
    const auto nearest_end = [&pieces](const gp_Pnt& point, size_t skip) {
        double best = 1e300;
        for (size_t i = 0; i < pieces.size(); ++i) {
            if (i == skip) continue;
            best = std::min(best, std::min(point.Distance(pieces[i]->StartPoint()), point.Distance(pieces[i]->EndPoint())));
        }
        return best;
    };
    if (nearest_end(first->StartPoint(), 0) < nearest_end(first->EndPoint(), 0)) first->Reverse();
    GeomConvert_CompCurveToBSplineCurve concat(first);
    std::vector<char> used(pieces.size(), 0);
    used[0] = 1;
    for (size_t step = 1; step < pieces.size(); ++step) {
        const gp_Pnt end = concat.BSplineCurve()->EndPoint();
        size_t pick = pieces.size();
        double best = 1e300;
        for (size_t i = 0; i < pieces.size(); ++i) {
            if (used[i]) continue;
            const double d = std::min(end.Distance(pieces[i]->StartPoint()), end.Distance(pieces[i]->EndPoint()));
            if (d < best) {
                best = d;
                pick = i;
            }
        }
        Handle(Geom_BSplineCurve) next = pieces[pick];
        used[pick] = 1;
        if (end.Distance(next->EndPoint()) < end.Distance(next->StartPoint())) next->Reverse();
        if (!concat.Add(next, kPatchJoinMm, Standard_True)) {
            error = "These boundary curves do not meet. Move each end so it starts where the previous curve ends.";
            return {};
        }
    }
    return concat.BSplineCurve();
}

bool collect_bound_edges(
    const PatchBoundSpec& bound,
    const Held* held,
    std::vector<TopoDS_Edge>& edges,
    std::string& error) {
    edges.clear();
    if (!bound.edges.empty()) {
        if (held == nullptr) {
            error = "A patch side needs a curve or an edge of the sheet.";
            return false;
        }
        for (int index : bound.edges) {
            TopoDS_Shape raw;
            if (!pick(*held, "edge", index, raw)) {
                error = "That edge is not on this sheet.";
                return false;
            }
            edges.push_back(TopoDS::Edge(raw));
        }
        return !edges.empty();
    }
    if (!bound.has_curve) {
        error = "A patch side needs a curve or an edge of the sheet.";
        return false;
    }
    const TopoDS_Wire wire = curve3d_wire(bound.curve, held, error);
    if (wire.IsNull()) return false;
    for (BRepTools_WireExplorer explorer(wire); explorer.More(); explorer.Next()) {
        edges.push_back(explorer.Current());
    }
    if (edges.empty()) {
        error = "A patch side needs a curve or an edge of the sheet.";
        return false;
    }
    return true;
}

TopoDS_Face face_beside(
    const PatchBoundSpec& bound,
    const std::vector<TopoDS_Edge>& edges,
    const TopoDS_Shape& shape,
    const Held* held) {
    if (bound.face >= 0 && held != nullptr && bound.face < held->faces.Extent()) {
        return TopoDS::Face(held->faces(bound.face + 1));
    }
    if (shape.IsNull() || edges.empty()) return {};
    TopTools_IndexedDataMapOfShapeListOfShape ancestors;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, ancestors);
    const int at = ancestors.FindIndex(edges.front());
    if (at <= 0 || ancestors.FindFromIndex(at).IsEmpty()) return {};
    return TopoDS::Face(ancestors.FindFromIndex(at).First());
}

int continuity_of(int asked, bool has_face, bool blend, std::string& error) {
    if (blend) {
        if (asked <= 0) {
            error = "A blend is G1 or G2. Set the seam to g1 or g2.";
            return -2;
        }
        if (!has_face) {
            error = "G1 and G2 need the face beside the edge. Pick an edge of the sheet, or set that side to G0.";
            return -2;
        }
        return asked >= 2 ? 2 : 1;
    }
    // Left out, an edge that touches a face is G1 and a free curve is G0.
    if (asked < 0) return has_face ? 1 : 0;
    if (asked > 0 && !has_face) {
        error = "G1 and G2 need the face beside the edge. Pick an edge of the sheet, or set that side to G0.";
        return -2;
    }
    if (asked >= 2) return 2;
    return asked > 0 ? 1 : 0;
}

bool orient_loop(std::vector<Handle(Geom_BSplineCurve)>& curves, std::string& error) {
    if (curves.size() < 2) return true;
    const bool closed = curves.size() >= 3;
    // The first edge keeps the face's orientation, which may walk the opening backwards.
    // Point it at the next curve before the rest of the chain follows its end.
    if (closed) {
        const gp_Pnt a0 = curves[0]->StartPoint();
        const gp_Pnt a1 = curves[0]->EndPoint();
        const double at_end = std::min(a1.Distance(curves[1]->StartPoint()), a1.Distance(curves[1]->EndPoint()));
        const double at_start = std::min(a0.Distance(curves[1]->StartPoint()), a0.Distance(curves[1]->EndPoint()));
        if (at_start + 1e-9 < at_end) curves[0]->Reverse();
    }
    for (size_t i = 1; i < curves.size(); ++i) {
        const gp_Pnt prev = curves[i - 1]->EndPoint();
        const double to_start = prev.Distance(curves[i]->StartPoint());
        const double to_end = prev.Distance(curves[i]->EndPoint());
        if (closed && to_end + 1e-9 < to_start) curves[i]->Reverse();
        else if (!closed && to_end + 1e-9 < to_start && to_end <= kPatchJoinMm) curves[i]->Reverse();
        if (closed && prev.Distance(curves[i]->StartPoint()) > kPatchJoinMm) {
            error = "These boundary curves do not meet. Move each end so it starts where the previous curve ends.";
            return false;
        }
    }
    if (closed && curves.back()->EndPoint().Distance(curves.front()->StartPoint()) > kPatchJoinMm) {
        error = "These boundary curves do not meet. Move each end so it starts where the previous curve ends.";
        return false;
    }
    return true;
}

bool meets_both_ends(const Handle(Geom_BSplineCurve)& a, const Handle(Geom_BSplineCurve)& b) {
    const double a0b0 = a->StartPoint().Distance(b->StartPoint());
    const double a0b1 = a->StartPoint().Distance(b->EndPoint());
    const double a1b0 = a->EndPoint().Distance(b->StartPoint());
    const double a1b1 = a->EndPoint().Distance(b->EndPoint());
    const bool start_meets = std::min(a0b0, a0b1) <= kPatchJoinMm;
    const bool end_meets = std::min(a1b0, a1b1) <= kPatchJoinMm;
    return start_meets && end_meets;
}

TopoDS_Face face_from_surface(const Handle(Geom_BSplineSurface)& surface, std::string& error) {
    if (surface.IsNull()) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    BRepBuilderAPI_MakeFace face(surface, 1e-6);
    if (!face.IsDone() || face.Face().IsNull()) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    ShapeFix_Face fix(face.Face());
    fix.Perform();
    return fix.Face().IsNull() ? face.Face() : fix.Face();
}

TopoDS_Face fill_geomfill(const std::vector<Handle(Geom_BSplineCurve)>& curves, std::string& error) {
    try {
        Handle(Geom_BSplineSurface) surface;
        if (curves.size() == 4) {
            bool constrained = false;
            try {
                Handle(GeomFill_SimpleBound) b1 = new GeomFill_SimpleBound(new GeomAdaptor_Curve(curves[0]), 1e-5, 0.01);
                Handle(GeomFill_SimpleBound) b2 = new GeomFill_SimpleBound(new GeomAdaptor_Curve(curves[1]), 1e-5, 0.01);
                Handle(GeomFill_SimpleBound) b3 = new GeomFill_SimpleBound(new GeomAdaptor_Curve(curves[2]), 1e-5, 0.01);
                Handle(GeomFill_SimpleBound) b4 = new GeomFill_SimpleBound(new GeomAdaptor_Curve(curves[3]), 1e-5, 0.01);
                GeomFill_ConstrainedFilling filling(8, 12);
                filling.Init(b1, b2, b3, b4, Standard_False);
                surface = filling.Surface();
                constrained = !surface.IsNull();
            } catch (const Standard_Failure&) {
                constrained = false;
            }
            if (!constrained) {
                GeomFill_BSplineCurves filling(curves[0], curves[1], curves[2], curves[3], GeomFill_CoonsStyle);
                surface = filling.Surface();
            }
        } else if (curves.size() == 3) {
            GeomFill_BSplineCurves filling(curves[0], curves[1], curves[2], GeomFill_CoonsStyle);
            surface = filling.Surface();
        } else if (curves.size() == 2) {
            GeomFill_BSplineCurves filling(curves[0], curves[1], GeomFill_StretchStyle);
            surface = filling.Surface();
        }
        return face_from_surface(surface, error);
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
}

TopoDS_Shape compound_with(const TopoDS_Shape& current, const TopoDS_Shape& added) {
    if (current.IsNull()) return added;
    TopoDS_Compound compound;
    BRep_Builder builder;
    builder.MakeCompound(compound);
    for (TopExp_Explorer explorer(current, TopAbs_FACE); explorer.More(); explorer.Next()) {
        builder.Add(compound, explorer.Current());
    }
    for (TopExp_Explorer explorer(added, TopAbs_FACE); explorer.More(); explorer.Next()) {
        builder.Add(compound, explorer.Current());
    }
    return compound;
}

#include "organic_fill.inc"

}  // namespace

TopoDS_Shape build_patch(
    const TopoDS_Shape& current,
    const Held* held,
    const PatchBuildSpec& spec,
    std::string& error) {
    const int count = static_cast<int>(spec.bounds.size());
    if (count < 2 || count > 20) {
        error = "A patch needs between 2 and 20 boundary curves or edges.";
        return {};
    }
    if (!spec.guides.empty()) {
        error = "An interior guide curve is not part of this fill. Use a guide point, or leave the guides empty.";
        return {};
    }
    if (!current.IsNull() && has_solid(current)) {
        error = "Patch fills an opening on a sheet. This part is already a closed solid.";
        return {};
    }
    std::vector<std::vector<TopoDS_Edge>> side_edges(static_cast<size_t>(count));
    std::vector<TopoDS_Face> faces(static_cast<size_t>(count));
    std::vector<int> orders(static_cast<size_t>(count), 0);
    int max_order = 0;
    for (int i = 0; i < count; ++i) {
        if (!collect_bound_edges(spec.bounds[static_cast<size_t>(i)], held, side_edges[static_cast<size_t>(i)], error)) return {};
        faces[static_cast<size_t>(i)] = face_beside(spec.bounds[static_cast<size_t>(i)], side_edges[static_cast<size_t>(i)], current, held);
        const int order = continuity_of(spec.bounds[static_cast<size_t>(i)].continuity, !faces[static_cast<size_t>(i)].IsNull(), false, error);
        if (order < 0) return {};
        orders[static_cast<size_t>(i)] = order;
        max_order = std::max(max_order, order);
    }
    std::vector<Handle(Geom_BSplineCurve)> curves;
    curves.reserve(static_cast<size_t>(count));
    for (const std::vector<TopoDS_Edge>& side : side_edges) {
        Handle(Geom_BSplineCurve) curve = chain_to_bspline(side, error);
        if (curve.IsNull()) return {};
        curves.push_back(curve);
    }
    if (!orient_loop(curves, error)) return {};
    if (count == 2 && meets_both_ends(curves[0], curves[1])) {
        error = "These two curves meet at both ends. A patch of two sides needs them to meet at one end each.";
        return {};
    }
    if (count == 2 && (max_order > 0 || !spec.points.empty())) {
        error = "A patch of two sides is a G0 fill. Use a blend to join two edges at G1 or G2.";
        return {};
    }
    if (count <= 4 && max_order <= 0 && spec.points.empty()) {
        const TopoDS_Face patch = fill_geomfill(curves, error);
        if (patch.IsNull()) return {};
        return compound_with(current, patch);
    }
    std::vector<std::vector<int>> edge_ids;
    edge_ids.reserve(static_cast<size_t>(count));
    for (const PatchBoundSpec& bound : spec.bounds) edge_ids.push_back(bound.edges);
    return fill_hermite_patch(current, curves, faces, orders, edge_ids, spec.points, error);
}

TopoDS_Shape build_blend(
    const TopoDS_Shape& current,
    const Held* held,
    const BlendBuildSpec& spec,
    std::string& error) {
    if (!current.IsNull() && has_solid(current)) {
        error = "A blend joins two edges of a sheet. This part is already a closed solid.";
        return {};
    }
    const double tension_a = tension_value(spec.tension_a, "Side A", error);
    if (tension_a < 0.0) return {};
    const double tension_b = tension_value(spec.tension_b, "Side B", error);
    if (tension_b < 0.0) return {};
    std::vector<TopoDS_Edge> edges_a;
    std::vector<TopoDS_Edge> edges_b;
    if (!collect_bound_edges(spec.a, held, edges_a, error)) return {};
    if (!collect_bound_edges(spec.b, held, edges_b, error)) return {};
    const TopoDS_Face face_a = face_beside(spec.a, edges_a, current, held);
    const TopoDS_Face face_b = face_beside(spec.b, edges_b, current, held);
    const int asked_a = spec.a.continuity >= 0 ? spec.a.continuity : spec.continuity;
    const int asked_b = spec.b.continuity >= 0 ? spec.b.continuity : spec.continuity;
    const int order_a = continuity_of(asked_a, !face_a.IsNull(), true, error);
    if (order_a < 0) return {};
    const int order_b = continuity_of(asked_b, !face_b.IsNull(), true, error);
    if (order_b < 0) return {};
    Handle(Geom_BSplineCurve) curve_a = chain_to_bspline(edges_a, error);
    Handle(Geom_BSplineCurve) curve_b = chain_to_bspline(edges_b, error);
    if (curve_a.IsNull() || curve_b.IsNull()) return {};
    TopTools_IndexedDataMapOfShapeListOfShape beside;
    if (!current.IsNull()) TopExp::MapShapesAndAncestors(current, TopAbs_EDGE, TopAbs_FACE, beside);
    const auto faces_beside = [&beside](const std::vector<TopoDS_Edge>& edges) {
        std::vector<TopoDS_Face> faces;
        for (const TopoDS_Edge& edge : edges) {
            const int at = beside.FindIndex(edge);
            if (at <= 0) continue;
            for (const TopoDS_Shape& face : beside.FindFromIndex(at)) {
                const bool seen = std::any_of(faces.begin(), faces.end(), [&face](const TopoDS_Face& have) { return have.IsSame(face); });
                if (!seen) faces.push_back(TopoDS::Face(face));
            }
        }
        return faces;
    };
    return fill_hermite_blend(current, curve_a, curve_b, face_a, face_b, faces_beside(edges_a), faces_beside(edges_b),
                              spec.a.edges, spec.b.edges, order_a, order_b, tension_a, tension_b, error);
}

namespace {

/// S6 blob header. See `encode_nurbs_blob` in k1.rs.
constexpr int kNurbsHeader = 13;
constexpr int kNurbsMaxDegree = 8;
constexpr int kNurbsMaxPoles = 64;
constexpr int kNurbsMaxInserts = 32;

/// A knot multiplicity from the blob: a whole number from 0 to 1000, else 0 (which knots_match refuses).
int small_int(double value) {
    if (!std::isfinite(value) || value < 0.0 || value > 1000.0 || value != std::floor(value)) return 0;
    return static_cast<int>(value);
}

std::string knot_sentence(const char* axis) {
    return std::string("The ") + axis + " knots do not match this surface. They must increase, and their multiplicities must add up to the poles and the degree.";
}

std::string pole_sentence(const char* axis, int degree) {
    return std::string("This surface needs at least ") + std::to_string(degree + 1) + " poles in " + axis + " for degree " + std::to_string(degree) + ".";
}

bool knots_match(const std::vector<double>& knots, const std::vector<int>& mults, int npoles, int degree, bool periodic, const char* axis, std::string& error) {
    const std::string sentence = knot_sentence(axis);
    if (knots.size() != mults.size() || knots.empty()) {
        error = sentence;
        return false;
    }
    // Each multiplicity is checked before it is added, and the sum is 64-bit, so no input can overflow it.
    long long sum = 0;
    for (size_t i = 0; i < knots.size(); ++i) {
        if (!std::isfinite(knots[i]) || mults[i] < 1 || mults[i] > degree + 1) {
            error = sentence;
            return false;
        }
        if (i > 0 && !(knots[i] > knots[i - 1])) {
            error = sentence;
            return false;
        }
        sum += mults[i];
    }
    if (periodic) {
        if (mults.front() != mults.back()) {
            error = sentence;
            return false;
        }
        for (int mult : mults) {
            if (mult > degree) {
                error = sentence;
                return false;
            }
        }
        if (sum - mults.front() != static_cast<long long>(npoles)) {
            error = sentence;
            return false;
        }
        return true;
    }
    if (mults.front() > degree + 1 || mults.back() > degree + 1) {
        error = sentence;
        return false;
    }
    for (size_t i = 1; i + 1 < mults.size(); ++i) {
        if (mults[i] > degree) {
            error = sentence;
            return false;
        }
    }
    if (sum != static_cast<long long>(npoles) + degree + 1) {
        error = sentence;
        return false;
    }
    return true;
}

void default_clamped_knots(int npoles, int degree, std::vector<double>& knots, std::vector<int>& mults) {
    const int spans = std::max(1, npoles - degree);
    knots.clear();
    mults.clear();
    for (int i = 0; i <= spans; ++i) {
        knots.push_back(static_cast<double>(i) / static_cast<double>(spans));
        mults.push_back(i == 0 || i == spans ? degree + 1 : 1);
    }
}

void default_periodic_knots(int npoles, std::vector<double>& knots, std::vector<int>& mults) {
    knots.clear();
    mults.clear();
    for (int i = 0; i <= npoles; ++i) {
        knots.push_back(static_cast<double>(i));
        mults.push_back(1);
    }
}

}  // namespace

TopoDS_Shape build_nurbs_surface(const TopoDS_Shape& current, const double* blob, int len, std::string& error) {
    error.clear();
    if (blob == nullptr || len < kNurbsHeader) {
        error = "This NURBS surface could not be built.";
        return {};
    }
    auto take_int = [&](int at) {
        const double value = blob[at];
        if (!std::isfinite(value) || value < 0.0 || value > 1000000.0) return -1;
        return static_cast<int>(std::lround(value));
    };
    const int nu = take_int(0);
    const int nv = take_int(1);
    int degree_u = take_int(2);
    int degree_v = take_int(3);
    const bool periodic_u = blob[4] != 0.0;
    const bool periodic_v = blob[5] != 0.0;
    const int nknots_u = take_int(6);
    const int nknots_v = take_int(7);
    const int nweights = take_int(8);
    const int ninsert_u = take_int(9);
    const int ninsert_v = take_int(10);
    const int elevate_u = take_int(11);
    const int elevate_v = take_int(12);
    if (nu < 1 || nv < 1 || degree_u < 0 || degree_v < 0 || nknots_u < 0 || nknots_v < 0 || nweights < 0 || ninsert_u < 0 || ninsert_v < 0 || elevate_u < 0 || elevate_v < 0) {
        error = "This NURBS surface could not be built.";
        return {};
    }
    if (degree_u == 0) degree_u = 3;
    if (degree_v == 0) degree_v = 3;
    // The same limits the app and the MCP check, so no path builds past them.
    for (const auto& [axis, degree, count, periodic, inserts, elevate] :
         {std::make_tuple("U", degree_u, nu, periodic_u, ninsert_u, elevate_u),
          std::make_tuple("V", degree_v, nv, periodic_v, ninsert_v, elevate_v)}) {
        if (degree > kNurbsMaxDegree) {
            error = std::string("A NURBS surface's degree in ") + axis + " is 1 to 8; it was " + std::to_string(degree) + ".";
            return {};
        }
        if (count > kNurbsMaxPoles) {
            error = std::string("A NURBS surface has at most 64 poles in ") + axis + "; it has " + std::to_string(count) + ".";
            return {};
        }
        if (periodic && count < 3) {
            error = std::string("A surface closed in ") + axis + " needs at least 3 poles in " + axis + ".";
            return {};
        }
        if (inserts > kNurbsMaxInserts) {
            error = std::string("A NURBS surface takes at most 32 knot inserts in ") + axis + "; it has " + std::to_string(inserts) + ".";
            return {};
        }
        if (elevate > kNurbsMaxDegree) {
            error = std::string("A NURBS surface's degree in ") + axis + " can be raised to at most 8; it asked for " + std::to_string(elevate) + ".";
            return {};
        }
    }
    if (nu < degree_u + 1) {
        error = pole_sentence("U", degree_u);
        return {};
    }
    if (nv < degree_v + 1) {
        error = pole_sentence("V", degree_v);
        return {};
    }
    const int need = kNurbsHeader + nu * nv * 3 + nweights + nknots_u * 2 + nknots_v * 2 + ninsert_u * 2 + ninsert_v * 2;
    if (len < need) {
        error = "This NURBS surface could not be built.";
        return {};
    }
    int at = kNurbsHeader;
    TColgp_Array2OfPnt poles(1, nu, 1, nv);
    for (int iu = 0; iu < nu; ++iu) {
        for (int iv = 0; iv < nv; ++iv) {
            const double x = blob[at++];
            const double y = blob[at++];
            const double z = blob[at++];
            if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)) {
                error = "A pole on this surface is not a number.";
                return {};
            }
            poles.SetValue(iu + 1, iv + 1, gp_Pnt(x, y, z));
        }
    }
    const bool rational = nweights > 0;
    if (rational && nweights != nu * nv) {
        error = "The weights do not match this surface's poles.";
        return {};
    }
    TColStd_Array2OfReal weights(1, nu, 1, nv);
    if (rational) {
        for (int iu = 0; iu < nu; ++iu) {
            for (int iv = 0; iv < nv; ++iv) {
                const double w = blob[at++];
                if (!std::isfinite(w) || !(w > 0.0)) {
                    error = "A weight on this surface is 0 or less. Every weight has to be greater than 0.";
                    return {};
                }
                weights.SetValue(iu + 1, iv + 1, w);
            }
        }
    }
    std::vector<double> ku;
    std::vector<int> mu;
    std::vector<double> kv;
    std::vector<int> mv;
    if (nknots_u == 0) {
        if (periodic_u) default_periodic_knots(nu, ku, mu);
        else default_clamped_knots(nu, degree_u, ku, mu);
    } else {
        ku.resize(static_cast<size_t>(nknots_u));
        mu.resize(static_cast<size_t>(nknots_u));
        for (int i = 0; i < nknots_u; ++i) ku[static_cast<size_t>(i)] = blob[at++];
        for (int i = 0; i < nknots_u; ++i) mu[static_cast<size_t>(i)] = small_int(blob[at++]);
    }
    if (nknots_v == 0) {
        if (periodic_v) default_periodic_knots(nv, kv, mv);
        else default_clamped_knots(nv, degree_v, kv, mv);
    } else {
        kv.resize(static_cast<size_t>(nknots_v));
        mv.resize(static_cast<size_t>(nknots_v));
        for (int i = 0; i < nknots_v; ++i) kv[static_cast<size_t>(i)] = blob[at++];
        for (int i = 0; i < nknots_v; ++i) mv[static_cast<size_t>(i)] = small_int(blob[at++]);
    }
    if (!knots_match(ku, mu, nu, degree_u, periodic_u, "U", error)) return {};
    if (!knots_match(kv, mv, nv, degree_v, periodic_v, "V", error)) return {};
    std::vector<std::pair<double, int>> insert_u;
    std::vector<std::pair<double, int>> insert_v;
    // Each insert: a parameter strictly inside the knot range, `times` a whole number from 1 to the degree, and never
    // past a knot's full multiplicity (the degree inside the range), counting the inserts before it.
    const auto read_inserts = [&](int count, const char* axis, int degree, const std::vector<double>& knots,
                                  const std::vector<int>& mults, std::vector<std::pair<double, int>>& out) {
        std::vector<std::pair<double, int>> have;
        for (size_t i = 0; i < knots.size(); ++i) have.emplace_back(knots[i], mults[i]);
        for (int i = 0; i < count; ++i) {
            const double param = blob[at++];
            const double raw_times = blob[at++];
            if (!std::isfinite(raw_times) || raw_times != std::floor(raw_times) || raw_times < 1.0 || raw_times > degree) {
                error = std::string("A knot insert in ") + axis + " is 1 to " + std::to_string(degree) + " times, a whole number.";
                return false;
            }
            const int times = static_cast<int>(raw_times);
            if (!std::isfinite(param) || !(param > knots.front()) || !(param < knots.back())) {
                std::ostringstream text;
                text << "A knot insert in " << axis << " must lie strictly inside the knot range, " << knots.front() << " to "
                     << knots.back() << ".";
                error = text.str();
                return false;
            }
            auto found = std::find_if(have.begin(), have.end(), [param](const std::pair<double, int>& k) {
                return std::abs(k.first - param) <= 1e-9;
            });
            const int already = found == have.end() ? 0 : found->second;
            if (already + times > degree) {
                std::ostringstream text;
                text << "Inserting the " << axis << " knot " << param << " " << times << " times would give it multiplicity "
                     << already + times << ", past its full multiplicity " << degree << ".";
                error = text.str();
                return false;
            }
            if (found == have.end()) have.emplace_back(param, times);
            else found->second += times;
            out.emplace_back(param, times);
        }
        return true;
    };
    if (!read_inserts(ninsert_u, "U", degree_u, ku, mu, insert_u)) return {};
    if (!read_inserts(ninsert_v, "V", degree_v, kv, mv, insert_v)) return {};
    const int nku = static_cast<int>(ku.size());
    const int nkv = static_cast<int>(kv.size());
    TColStd_Array1OfReal uk(1, nku);
    TColStd_Array1OfInteger um(1, nku);
    TColStd_Array1OfReal vk(1, nkv);
    TColStd_Array1OfInteger vm(1, nkv);
    for (int i = 0; i < nku; ++i) {
        uk.SetValue(i + 1, ku[static_cast<size_t>(i)]);
        um.SetValue(i + 1, mu[static_cast<size_t>(i)]);
    }
    for (int i = 0; i < nkv; ++i) {
        vk.SetValue(i + 1, kv[static_cast<size_t>(i)]);
        vm.SetValue(i + 1, mv[static_cast<size_t>(i)]);
    }
    Handle(Geom_BSplineSurface) surface;
    try {
        surface = rational
            ? new Geom_BSplineSurface(poles, weights, uk, vk, um, vm, degree_u, degree_v, periodic_u, periodic_v)
            : new Geom_BSplineSurface(poles, uk, vk, um, vm, degree_u, degree_v, periodic_u, periodic_v);
        for (const auto& hit : insert_u) {
            TColStd_Array1OfReal ks(1, 1);
            TColStd_Array1OfInteger ms(1, 1);
            ks.SetValue(1, hit.first);
            ms.SetValue(1, hit.second);
            surface->InsertUKnots(ks, ms, 1e-9, Standard_True);
        }
        for (const auto& hit : insert_v) {
            TColStd_Array1OfReal ks(1, 1);
            TColStd_Array1OfInteger ms(1, 1);
            ks.SetValue(1, hit.first);
            ms.SetValue(1, hit.second);
            surface->InsertVKnots(ks, ms, 1e-9, Standard_True);
        }
        const int want_u = std::max(surface->UDegree(), elevate_u);
        const int want_v = std::max(surface->VDegree(), elevate_v);
        if (want_u > surface->UDegree() || want_v > surface->VDegree()) {
            surface->IncreaseDegree(want_u, want_v);
        }
    } catch (const Standard_Failure&) {
        error = "This NURBS surface could not be built.";
        return {};
    }
    if (surface.IsNull()) {
        error = "This NURBS surface could not be built.";
        return {};
    }
    BRepBuilderAPI_MakeFace maker(surface, 1e-7);
    if (!maker.IsDone()) {
        error = "This NURBS surface could not be built.";
        return {};
    }
    TopoDS_Face face = maker.Face();
    ShapeFix_Face fixer(face);
    fixer.Perform();
    face = fixer.Face();
    if (current.IsNull()) return face;
    if (has_solid(current)) {
        error = "A NURBS surface is a sheet. This part is already a closed solid.";
        return {};
    }
    return compound_with(current, face);
}

}  // namespace lime_occt

using namespace lime_occt;

/// The linked Open CASCADE version and the kernel work counted since the library loaded, for tests.
extern "C" char* lime_model_occt_stats() {
    std::string out = "{\"version\":\"";
    out += escape(OCCT_Version_String_Complete());
    out += "\",\"builds\":";
    out += std::to_string(g_stats.builds.load());
    out += ",\"volumes\":";
    out += std::to_string(g_stats.volumes.load());
    out += ",\"tessellations\":";
    out += std::to_string(g_stats.tessellations.load());
    out += ",\"meshes\":";
    out += std::to_string(g_stats.meshes.load());
    out += ",\"descriptions\":";
    out += std::to_string(g_stats.descriptions.load());
    out += ",\"fullMeshes\":";
    out += std::to_string(g_stats.full_meshes.load());
    const std::pair<const char*, const std::atomic<long long>*> timings[] = {
        {"booleanUs", &g_stats.boolean_us},
        {"volumeUs", &g_stats.volume_us},
        {"meshUs", &g_stats.mesh_us},
        {"readoutUs", &g_stats.readout_us},
        {"describeUs", &g_stats.describe_us},
    };
    for (const auto& [name, total] : timings) {
        out += ",\"";
        out += name;
        out += "\":";
        out += std::to_string(total->load());
    }
    out += '}';
    return alloc(out);
}

extern "C" void lime_model_occt_string_free(char* text) { std::free(text); }

/// Non-zero meshes every face of a solid, as before a step meshed only around the faces it made. For tests.
extern "C" void lime_model_occt_whole_meshes(int on) { g_whole_meshes = on != 0; }

/// Non-zero meshes with the Watson triangulation the bridge used before Delabella. For tests and measurements.
extern "C" void lime_model_occt_watson_mesher(int on) { g_watson_mesher = on != 0; }

/// Non-zero leaves the faces Delabella could not mesh empty, instead of meshing them with Watson. For tests.
extern "C" void lime_model_occt_mesher_fallback(int on) { g_no_mesher_fallback = on == 0; }

/// Reverses one blend ribbon. Debug tests only. Not an op, and not in a release build.
#ifdef LIME_OCCT_TEST_HOOKS
extern "C" void lime_model_occt_test_reverse_blend_ribbon(int side) {
    lime_occt::g_blend_reverse_side = side;
}
#endif
