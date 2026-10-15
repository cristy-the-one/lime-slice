// Open CASCADE operations for the Model history tree (tree.cpp). This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <locale>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_Printer.hxx>
#include <Message_PrinterOStream.hxx>
#include <TCollection_AsciiString.hxx>

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Check.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
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
#include <ShapeFix_Shape.hxx>
#include <ShapeFix_Solid.hxx>
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
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include "kernel.h"

#ifdef LIME_OCCT_STEP
#include <IFSelect_ReturnStatus.hxx>
#include <Interface_Static.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_StepModelType.hxx>
#include <STEPControl_Writer.hxx>
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

double depth_along(const TopoDS_Shape& shape, const gp_Dir& normal) {
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

/// Kernel work done since load. Tests read it to prove a probe's result was reused.
struct Stats {
    std::atomic<long> builds{0};
    std::atomic<long> volumes{0};
    std::atomic<long> tessellations{0};
    std::atomic<long> meshes{0};
    std::atomic<long> descriptions{0};
};

Stats g_stats;

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
    BRepGProp::VolumeProperties(shape, props);
}

double volume_of(const TopoDS_Shape& shape) {
    if (shape.IsNull()) {
        return 0;
    }
    if (shape.ShapeType() == TopAbs_COMPOUND || shape.ShapeType() == TopAbs_COMPSOLID) {
        double total = 0;
        int count = 0;
        for (TopExp_Explorer explorer(shape, TopAbs_SOLID); explorer.More(); explorer.Next()) {
            GProp_GProps props;
            integrate(explorer.Current(), props);
            total += props.Mass();
            count += 1;
        }
        if (count > 0) {
            return total;
        }
    }
    GProp_GProps props;
    integrate(shape, props);
    return props.Mass();
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

Mesh tessellate(Held& held, double chord) {
    g_stats.tessellations += 1;
    chord = chord_of(chord);
    // Open CASCADE keeps a finer mesh it already has, so a face shared with a solid meshed finer
    // since is what meshing again would leave too.
    if (held.meshed != chord) {
        g_stats.meshes += 1;
        BRepMesh_IncrementalMesh mesher(held.shape, chord, Standard_False, 0.5, Standard_False);
        mesher.Perform();
        held.meshed = chord;
    }

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
    for (size_t face = 0; face < pieces.size(); ++face) {
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

std::string describe(const Held& held) {
    g_stats.descriptions += 1;
    std::string out = "{\"volumeMm3\":";
    append_num(out, held.volume);
    out += has_solid(held.shape) ? ",\"solid\":true" : ",\"solid\":false";
    out += ",\"faces\":[";
    for (int face_index = 1; face_index <= held.faces.Extent(); ++face_index) {
        if (face_index > 1) {
            out += ',';
        }
        GProp_GProps props;
        BRepGProp::SurfaceProperties(held.faces(face_index), props);
        out += "{\"areaMm2\":";
        append_num(out, props.Mass());
        append_face_normal(out, TopoDS::Face(held.faces(face_index)));
        out += '}';
    }
    out += "],\"edgeLengths\":[";
    for (int edge_index = 1; edge_index <= held.edges.Extent(); ++edge_index) {
        if (edge_index > 1) {
            out += ',';
        }
        GProp_GProps props;
        BRepGProp::LinearProperties(held.edges(edge_index), props);
        append_num(out, props.Mass());
    }
    out += "]}";
    return out;
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

/// The primitive as it stands, before any turn. Every size is checked here, in the words the readout shows.
TopoDS_Shape make_primitive(const PrimitiveSpec& p, std::string& error) {
    const std::string& which = p.kind;
    const gp_Ax2 up(gp_Pnt(p.x, p.y, p.z), gp_Dir(0, 0, 1));
    if (which == "box") {
        if (!(p.dx > 0.0) || !(p.dy > 0.0) || !(p.dz > 0.0)) {
            error = "A box needs a positive length on each side";
            return {};
        }
        BRepPrimAPI_MakeBox box(gp_Pnt(p.x, p.y, p.z), p.dx, p.dy, p.dz);
        return built(box, "box", error);
    }
    if (which == "cylinder") {
        if (!(p.radius > 0.0) || !(p.height > 0.0)) {
            error = "A cylinder needs a positive radius and height";
            return {};
        }
        BRepPrimAPI_MakeCylinder cylinder(up, p.radius, p.height);
        return built(cylinder, "cylinder", error);
    }
    if (which == "sphere") {
        if (!(p.radius > 0.0)) {
            error = "A sphere needs a positive radius";
            return {};
        }
        BRepPrimAPI_MakeSphere sphere(gp_Pnt(p.x, p.y, p.z), p.radius);
        return built(sphere, "sphere", error);
    }
    if (which == "cone") {
        if (!(p.height > 0.0)) {
            error = "A cone needs a height above 0";
            return {};
        }
        if (!(p.radius >= 0.0) || !(p.top_radius >= 0.0)) {
            error = "A cone's radii cannot be below 0";
            return {};
        }
        if (!(p.radius > 0.0) && !(p.top_radius > 0.0)) {
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
        if (!(p.radius > 0.0)) {
            error = "A torus needs a ring radius above 0";
            return {};
        }
        if (!(p.tube_radius > 0.0)) {
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
        if (!(p.dx > 0.0) || !(p.dy > 0.0) || !(p.dz > 0.0)) {
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
        if (!(p.across > 0.0)) {
            error = "A polygon needs a width across above 0";
            return {};
        }
        if (!(p.height > 0.0)) {
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
        if (!(p.height > 0.0)) {
            error = "A tube needs a height above 0";
            return {};
        }
        if (!(p.radius > 0.0)) {
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
        BRepBuilderAPI_MakeFace face(section.Wire(), Standard_True);
        if (!face.IsDone()) {
            error = "Open CASCADE did not build the tube";
            return {};
        }
        BRepPrimAPI_MakeRevol tube(face.Face(), gp_Ax1(gp_Pnt(p.x, p.y, p.z), gp_Dir(0, 0, 1)), 2.0 * kPi);
        return built(tube, "tube", error);
    }
    error = "The primitive is box, cylinder, sphere, cone, torus, wedge, polygon, or tube";
    return {};
}

/// Where a primitive turns: a box's or a wedge's centre, a torus's centre, the middle of any other one's axis.
gp_Pnt turn_centre(const PrimitiveSpec& p) {
    if (p.kind == "box" || p.kind == "wedge") {
        return gp_Pnt(p.x + p.dx / 2.0, p.y + p.dy / 2.0, p.z + p.dz / 2.0);
    }
    if (p.kind == "torus") {
        return gp_Pnt(p.x, p.y, p.z);
    }
    return gp_Pnt(p.x, p.y, p.z + p.height / 2.0);
}

TopoDS_Shape make_solid(const PrimitiveSpec& spec, std::string& error) {
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

TopoDS_Shape boolean_op(const std::string& op, const TopoDS_Shape& solid, const TopoDS_Shape& tool, std::string& error) {
    g_stats.builds += 1;
    if (op == "fuse") {
        BRepAlgoAPI_Fuse algo(solid, tool);
        algo.SetFuzzyValue(1.0e-7);
        algo.SetNonDestructive(Standard_True);
        algo.Build();
        if (!algo.IsDone() || algo.HasErrors() || algo.Shape().IsNull()) {
            error = "Open CASCADE did not complete the boolean";
            return {};
        }
        return algo.Shape();
    }
    if (op == "cut") {
        BRepAlgoAPI_Cut algo(solid, tool);
        algo.SetFuzzyValue(1.0e-7);
        algo.SetNonDestructive(Standard_True);
        algo.Build();
        if (!algo.IsDone() || algo.HasErrors() || algo.Shape().IsNull()) {
            error = "Open CASCADE did not complete the boolean";
            return {};
        }
        return algo.Shape();
    }
    if (op == "common") {
        BRepAlgoAPI_Common algo(solid, tool);
        algo.SetFuzzyValue(1.0e-7);
        algo.SetNonDestructive(Standard_True);
        algo.Build();
        if (!algo.IsDone() || algo.HasErrors() || algo.Shape().IsNull()) {
            error = "Open CASCADE did not complete the boolean";
            return {};
        }
        return algo.Shape();
    }
    error = "The boolean is fuse, cut, or common";
    return {};
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
            builder.Build();
            if (!builder.IsDone() || builder.Shape().IsNull()) {
                error = failed;
                return false;
            }
            shape = builder.Shape();
        } else {
            BRepFilletAPI_MakeFillet builder(current);
            for (const TopoDS_Edge& edge : edges) {
                builder.Add(size, edge);
            }
            builder.Build();
            if (!builder.IsDone() || builder.Shape().IsNull()) {
                error = failed;
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

/// The boolean Apply runs, on a copy. Empty `error` means `built` is the result.
TopoDS_Shape build_boolean(
    const TopoDS_Shape& current,
    const std::string& which,
    const PrimitiveSpec& spec,
    double& volume,
    std::string& error) {
    const TopoDS_Shape tool = make_solid(spec, error);
    if (tool.IsNull()) {
        return {};
    }
    const TopoDS_Shape result = boolean_op(which, current, tool, error);
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

/// The hole Apply cuts, on a copy. `direction` points into the material. Empty means straight down, toward −Z.
/// The cylinder stands `depth` along that direction and ends at the origin, matching a −Z drill from `(x, y, z)`.
/// `before` is the open solid's volume; `volume` gets the result's.
TopoDS_Shape build_hole(
    const TopoDS_Shape& current,
    double before,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double depth,
    double& volume,
    std::string& error) {
    if (!(radius > 0.0) || !(depth > 0.0)) {
        error = "A hole needs a positive radius and depth";
        return {};
    }
    const double length = std::sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 1e-9)) {
        dx = 0.0;
        dy = 0.0;
        dz = -1.0;
    } else {
        dx /= length;
        dy /= length;
        dz /= length;
    }
    const gp_Pnt base(x + dx * depth, y + dy * depth, z + dz * depth);
    const gp_Dir axis(-dx, -dy, -dz);
    BRepPrimAPI_MakeCylinder cylinder(gp_Ax2(base, axis), radius, depth);
    cylinder.Build();
    if (!cylinder.IsDone()) {
        error = "Open CASCADE did not build the hole";
        return {};
    }
    const TopoDS_Shape cut = boolean_op("cut", current, cylinder.Shape(), error);
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
    TopoDS_Shape shape = reader.OneShape();
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
    if (writer.Transfer(shape, STEPControl_ManifoldSolidBrep) != IFSelect_RetDone ||
        writer.Write(path) != IFSelect_RetDone) {
        error = "Open CASCADE did not write this solid";
        return false;
    }
    return true;
#endif
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
            BRepAlgoAPI_Fuse fuse(acc, pieces[index]);
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
    if (depth_along(kept, normal) < 0.25 || depth_along(other, normal) < 0.25) {
        error = "The plane is too close to a face. Move it into the part.";
        return false;
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
    out += '}';
    return alloc(out);
}

extern "C" void lime_model_occt_string_free(char* text) { std::free(text); }
