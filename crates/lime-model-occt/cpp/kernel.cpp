// Open CASCADE operations for the Model history tree (tree.cpp). This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <locale>
#include <mutex>
#include <sstream>
#include <string>
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
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <gp_GTrsf.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass3d.hxx>
#include <BRepClass3d_SolidClassifier.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <GC_MakeEllipse.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <Geom_TrimmedCurve.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <ShapeFix_Face.hxx>
#include <ShapeFix_Wire.hxx>
#include <Geom_BSplineCurve.hxx>
#include <Geom_Circle.hxx>
#include <TColgp_HArray1OfPnt.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Circ.hxx>
#include <gp_Elips.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffset_Mode.hxx>
#include <ChFi3d.hxx>
#include <ChFiDS_TypeOfConcavity.hxx>
#include <GeomAbs_JoinType.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepGProp_Domain.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepGProp_Vinert.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
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
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
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
    const BRepMesh_IncrementalMesh mesher(around, chord, Standard_False, 0.5, Standard_True);
    return true;
}

Mesh tessellate(Held& held, double chord) {
    g_stats.tessellations += 1;
    chord = chord_of(chord);
    // Open CASCADE keeps a finer mesh it already has, so a face shared with a solid meshed finer
    // since is what meshing again would leave too.
    if (held.meshed != chord) {
        g_stats.meshes += 1;
        const Timed timed(g_stats.mesh_us);
        if (g_whole_meshes.load() || !mesh_around_made(held, chord)) {
            g_stats.full_meshes += 1;
            // In parallel: faces mesh apart, after their shared edges, so the mesh is the same as one thread's.
            // The constructor meshes; a second `Perform` only checked every face again.
            const BRepMesh_IncrementalMesh mesher(held.shape, chord, Standard_False, 0.5, Standard_True);
        }
        held.meshed = chord;
    }
    const Timed timed(g_stats.readout_us);

    struct Piece {
        Handle(Poly_Triangulation) tri;
        gp_Trsf trsf;
        bool reversed;
    };
    std::vector<Piece> pieces(static_cast<size_t>(held.faces.Extent()));
    size_t count = 0;
    for (int face_index = 1; face_index <= held.faces.Extent(); ++face_index) {
        const TopoDS_Face face = TopoDS::Face(held.faces(face_index));
        TopLoc_Location location;
        Piece& piece = pieces[static_cast<size_t>(face_index - 1)];
        piece.tri = BRep_Tool::Triangulation(face, location);
        piece.trsf = location.Transformation();
        piece.reversed = face.Orientation() == TopAbs_REVERSED;
        if (!piece.tri.IsNull()) {
            count += static_cast<size_t>(piece.tri->NbTriangles());
        }
    }

    Mesh out;
    out.positions.reserve(count * 9);
    out.triangles.reserve(count);
    for (size_t at = 0; at < pieces.size(); ++at) {
        const size_t face = held.order.empty() ? at : static_cast<size_t>(held.order[at] - 1);
        const Piece& piece = pieces[face];
        if (piece.tri.IsNull()) {
            continue;
        }
        for (int triangle_index = 1; triangle_index <= piece.tri->NbTriangles(); ++triangle_index) {
            int n1 = 0;
            int n2 = 0;
            int n3 = 0;
            piece.tri->Triangle(triangle_index).Get(n1, n2, n3);
            if (piece.reversed) {
                std::swap(n2, n3);
            }
            push_point(out.positions, piece.tri->Node(n1).Transformed(piece.trsf));
            push_point(out.positions, piece.tri->Node(n2).Transformed(piece.trsf));
            push_point(out.positions, piece.tri->Node(n3).Transformed(piece.trsf));
            out.triangles.push_back(static_cast<uint32_t>(face));
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
    out += "]}";
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
TopoDS_Shape boolean_op(
    const std::string& op,
    const TopoDS_Shape& solid,
    const TopoDS_Shape& tool,
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
    TopTools_ListOfShape tools;
    tools.Append(tool);
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

/// P1. A cylinder, cone, or sphere names its surface and radius. Anything else, including a plane, adds nothing.
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
            radius = surface.Sphere().Radius();
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
                    : std::string("This seam edge cannot be ") + verb + ".";
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
        Handle(TDataStd_Name) name;
        std::string text;
        if (free.Value(index).FindAttribute(TDataStd_Name::GetID(), name)) {
            text = TCollection_AsciiString(name->Get()).ToCString();
        }
        // The first character says what the free shape is: A for an assembly of components, S for a simple shape (one solid,
        // or a compound of them such as a split to print's pins).
        out.emplace_back((shapes->IsAssembly(free.Value(index)) ? "A" : "S") + text, XCAFDoc_ShapeTool::GetShape(free.Value(index)));
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
        face.Reverse();
        tool = k3_draft_prism(face, std::abs(depth), draft_rad, error);
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
        if (seg.kind == ProfileSegKind::Spline) {
            reverse_pairs(seg.through);
        }
        rev.push_back(std::move(seg));
    }
    loop.segments = std::move(rev);
}

/// A spline that ends where it starts, through at least two points between: the sketch's closed spline, one smooth
/// periodic curve with no corner at its start.
bool closed_spline(const double* from, const ProfileSeg& seg) {
    return seg.kind == ProfileSegKind::Spline && seg.through.size() >= 4 && same_point(from, seg.to);
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
    const TopoDS_Edge edge = spline_edge(pts, closed, ignored);
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
        } else if (seg.kind == ProfileSegKind::Spline) {
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
    if (loops.size() > 32) {
        error = "A profile takes at most 32 loops.";
        return false;
    }
    for (ProfileLoop& loop : loops) {
        if (loop.segments.empty()) {
            error = "A loop needs a segment.";
            return false;
        }
        if (loop.segments.size() > 200) {
            error = "A loop takes at most 200 segments.";
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
    };
    std::vector<Item> all;
    for (int loop = 0; loop < static_cast<int>(groups.size()); ++loop) {
        const int count = static_cast<int>(groups[loop].size());
        for (int index = 0; index < count; ++index) {
            all.push_back(Item{groups[static_cast<size_t>(loop)][static_cast<size_t>(index)], loop, index, count});
        }
    }
    for (size_t i = 0; i < all.size(); ++i) {
        for (size_t j = i + 1; j < all.size(); ++j) {
            if (all[i].loop == all[j].loop) {
                const int apart = std::abs(all[i].index - all[j].index);
                if (apart == 1 || apart == all[i].count - 1) {
                    continue;
                }
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

/// `loops` is oriented here: the outline turns counter-clockwise about W, holes the other way.
TopoDS_Face profile_loops_face(const ProfileFrame& frame, std::vector<ProfileLoop> loops, double lift, std::string& error) {
    if (!loops_readable(loops, error)) {
        return {};
    }
    orient_loops(loops);
    std::vector<std::vector<TopoDS_Edge>> groups;
    groups.reserve(loops.size());
    for (const ProfileLoop& loop : loops) {
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
        groups.push_back(std::move(edges));
    }
    if (edges_cross(groups, error)) {
        return {};
    }
    std::vector<TopoDS_Wire> wires;
    for (const std::vector<TopoDS_Edge>& edges : groups) {
        TopoDS_Wire wire = wire_of(edges, error);
        if (wire.IsNull()) {
            if (error.empty()) {
                error = "Open CASCADE did not join the loop into one outline.";
            }
            return {};
        }
        wires.push_back(wire);
    }
    const gp_Pln plane(gp_Ax3(frame.at(0.0, 0.0, lift), frame.w, frame.u));
    BRepBuilderAPI_MakeFace maker(plane, wires.front(), Standard_True);
    if (!maker.IsDone()) {
        error = "Open CASCADE did not build the profile";
        return {};
    }
    TopoDS_Face outer = maker.Face();
    for (size_t h = 1; h < loops.size(); ++h) {
        const gp_Pnt at = frame.at(loops[h].start[0], loops[h].start[1], lift);
        BRepClass_FaceClassifier inside(outer, at, 1e-7);
        if (inside.State() != TopAbs_IN) {
            error = "A hole lies outside the outline. Keep each hole inside.";
            return {};
        }
    }
    for (size_t i = 1; i < wires.size(); ++i) {
        const TopoDS_Wire interior = TopoDS::Wire(wires[i].Reversed());
        BRepBuilderAPI_MakeFace hole_face(plane, interior, Standard_True);
        if (!hole_face.IsDone()) {
            continue;
        }
        for (size_t j = 1; j < loops.size(); ++j) {
            if (j == i) {
                continue;
            }
            const gp_Pnt at = frame.at(loops[j].start[0], loops[j].start[1], lift);
            BRepClass_FaceClassifier inside(hole_face.Face(), at, 1e-7);
            if (inside.State() == TopAbs_IN) {
                error = "A hole lies inside another hole. Keep each hole inside the outline only.";
                return {};
            }
        }
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
    if (nloops < 1 || nloops > 32) {
        error = nloops < 1 ? "A profile needs a loop." : "A profile takes at most 32 loops.";
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
        if (nseg < 1 || nseg > 200) {
            error = nseg < 1 ? "A loop needs a segment." : "A loop takes at most 200 segments.";
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
            if (kind < 0 || kind > 2) {
                error = "A segment kind is line, arc, or spline.";
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
    const TopoDS_Face check = profile_loops_face(frame, loops, 0.0, error);
    if (check.IsNull()) {
        return {};
    }
    if (!std::isfinite(depth) || !(std::abs(depth) > kTinyMm)) {
        error = "An extrude needs a depth other than 0.";
        return {};
    }
    const double length = std::abs(depth);
    const double start = symmetric ? -length / 2.0 : std::min(depth, 0.0);
    TopoDS_Face face = check;
    if (std::abs(start) > 1e-15) {
        face = profile_loops_face(frame, loops, start, error);
        if (face.IsNull()) {
            return {};
        }
    }
    BRepPrimAPI_MakePrism prism(face, gp_Vec(frame.w) * length);
    const TopoDS_Shape tool = built(prism, "extrude", error);
    if (tool.IsNull()) {
        return {};
    }
    return combine_profile(current, before, which, tool, "extrude", volume, error);
}

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
    if (profile_loops_face(frame, loops, 0.0, error).IsNull()) {
        return {};
    }
    const char* closes_profile = "This draft closes the profile before the depth. Use a smaller angle or a shorter depth.";
    if (has_draft && loops.size() > 1 && !extent.has_up_to) {
        // LocOpe_DPrism does not draft a face with a round hole. The outline is drafted alone, and each hole is drafted
        // the other way (a positive angle narrows the material, so it widens the hole) and cut from it.
        std::string message;
        double tool_volume = 0.0;
        TopoDS_Shape tool = build_extrude_loops_extent(
            TopoDS_Shape(), 0.0, "fuse", origin, turn, std::vector<ProfileLoop>{loops.front()}, depth, symmetric, extent, tool_volume, message);
        if (tool.IsNull()) {
            error = message;
            return {};
        }
        ExtrudeExtent inward = extent;
        inward.draft_deg = -extent.draft_deg;
        for (size_t i = 1; i < loops.size(); ++i) {
            double hole_volume = 0.0;
            const TopoDS_Shape hole = build_extrude_loops_extent(
                TopoDS_Shape(), 0.0, "fuse", origin, turn, std::vector<ProfileLoop>{loops[i]}, depth, symmetric, inward, hole_volume, message);
            if (hole.IsNull()) {
                error = message == closes_profile ? "This draft closes a hole before the depth. Use a smaller angle or a shorter depth." : message;
                return {};
            }
            double cut_volume = 0.0;
            tool = combine_profile(tool, tool_volume, "cut", hole, "extrude", cut_volume, message);
            if (tool.IsNull()) {
                error = message;
                return {};
            }
            tool_volume = cut_volume;
        }
        return combine_profile(current, before, which, tool, "extrude", volume, error);
    }
    // The outline's box on the plane, from its drawn curves, as the point profile's check reads its corners.
    std::vector<double> outline;
    if (!loops.empty()) {
        const ProfileLoop& outer = loops.front();
        double from[2] = {outer.start[0], outer.start[1]};
        for (const ProfileSeg& seg : outer.segments) {
            std::string ignored;
            const TopoDS_Edge edge = loop_edge(frame, from, seg, 0.0, ignored);
            from[0] = seg.to[0];
            from[1] = seg.to[1];
            if (edge.IsNull()) {
                continue;
            }
            BRepAdaptor_Curve curve(edge);
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
    }
    return extent_from_face(
        current,
        before,
        which,
        frame,
        [&](double lift, std::string& message) { return profile_loops_face(frame, loops, lift, message); },
        [&](double shrink) { return outline.size() >= 2 && k3_draft_closes(outline, shrink); },
        depth,
        symmetric,
        extent,
        volume,
        error);
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
                    error = prefix + "A hole lies outside the outline. Keep each hole inside.";
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

}  // namespace

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
