// Open CASCADE session for Model mode. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
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
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Splitter.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <ShapeFix_Shape.hxx>
#include <Standard_Failure.hxx>
#include <Standard_VersionInfo.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

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

namespace {

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

struct Held {
    TopoDS_Shape shape;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
};

std::mutex g_mu;
std::vector<Held> g_held;
std::vector<TopoDS_Shape> g_undo;
std::vector<TopoDS_Shape> g_redo;

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

char* error_json(const std::string& message) {
    return alloc(std::string("{\"error\":\"") + escape(message) + "\"}");
}

void append_num(std::string& out, double value) {
    std::ostringstream stream;
    stream.setf(std::ios::fixed);
    stream.precision(6);
    stream << value;
    out += stream.str();
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

Held hold_of(const TopoDS_Shape& shape) {
    Held held;
    held.shape = shape;
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

int store(const TopoDS_Shape& shape) {
    g_held.clear();
    g_undo.clear();
    g_redo.clear();
    g_held.push_back(hold_of(as_solid(shape)));
    return 1;
}

bool held_at(int id, Held& out) {
    if (id < 1 || static_cast<size_t>(id) > g_held.size()) {
        return false;
    }
    out = g_held.at(static_cast<size_t>(id - 1));
    return true;
}

void push_capped(std::vector<TopoDS_Shape>& stack, const TopoDS_Shape& shape) {
    stack.push_back(shape);
    if (stack.size() > 32) {
        stack.erase(stack.begin());
    }
}

void checkpoint(const TopoDS_Shape& shape) {
    g_redo.clear();
    push_capped(g_undo, shape);
}

void replace_held(int id, const TopoDS_Shape& shape) {
    g_held.at(static_cast<size_t>(id - 1)) = hold_of(shape);
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
            BRepGProp::VolumeProperties(explorer.Current(), props);
            total += props.Mass();
            count += 1;
        }
        if (count > 0) {
            return total;
        }
    }
    GProp_GProps props;
    BRepGProp::VolumeProperties(shape, props);
    return props.Mass();
}

bool has_solid(const TopoDS_Shape& shape) {
    TopExp_Explorer explorer(shape, TopAbs_SOLID);
    return explorer.More();
}

void append_point(std::string& out, bool& first, const gp_Pnt& point) {
    if (!first) {
        out += ',';
    }
    first = false;
    append_num(out, point.X());
    out += ',';
    append_num(out, point.Y());
    out += ',';
    append_num(out, point.Z());
}

void append_face_normal(std::string& out, const TopoDS_Face& face);

std::string tessellate(int id, const Held& held, double chord) {
    chord = chord_of(chord);
    const TopoDS_Shape& shape = held.shape;
    BRepMesh_IncrementalMesh mesh(shape, chord, Standard_False, 0.5, Standard_False);
    mesh.Perform();

    GProp_GProps volume_props;
    BRepGProp::VolumeProperties(shape, volume_props);

    std::string out = "{\"id\":";
    out += std::to_string(id);
    out += ",\"kernel\":\"occt\",\"version\":\"";
    out += escape(OCCT_Version_String_Complete());
    out += "\",\"volumeMm3\":";
    append_num(out, volume_props.Mass());
    out += ",\"positions\":[";

    bool first_position = true;
    std::string faces_json = ",\"triangles\":[";
    bool first_triangle = true;
    for (int face_index = 1; face_index <= held.faces.Extent(); ++face_index) {
        const TopoDS_Face face = TopoDS::Face(held.faces(face_index));
        TopLoc_Location location;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, location);
        if (tri.IsNull()) {
            continue;
        }
        const gp_Trsf trsf = location.Transformation();
        const bool reversed = face.Orientation() == TopAbs_REVERSED;
        for (int triangle_index = 1; triangle_index <= tri->NbTriangles(); ++triangle_index) {
            int n1 = 0;
            int n2 = 0;
            int n3 = 0;
            tri->Triangle(triangle_index).Get(n1, n2, n3);
            if (reversed) {
                std::swap(n2, n3);
            }
            const gp_Pnt points[3] = {
                tri->Node(n1).Transformed(trsf),
                tri->Node(n2).Transformed(trsf),
                tri->Node(n3).Transformed(trsf),
            };
            for (const gp_Pnt& point : points) {
                append_point(out, first_position, point);
            }
            if (!first_triangle) {
                faces_json += ',';
            }
            first_triangle = false;
            faces_json += std::to_string(face_index - 1);
        }
    }
    out += "]";
    out += faces_json;
    out += "],\"faces\":[";
    for (int face_index = 1; face_index <= held.faces.Extent(); ++face_index) {
        if (face_index > 1) {
            out += ',';
        }
        GProp_GProps props;
        BRepGProp::SurfaceProperties(held.faces(face_index), props);
        out += "{\"id\":";
        out += std::to_string(face_index - 1);
        out += ",\"areaMm2\":";
        append_num(out, props.Mass());
        append_face_normal(out, TopoDS::Face(held.faces(face_index)));
        out += '}';
    }
    out += "],\"edges\":[";
    for (int edge_index = 1; edge_index <= held.edges.Extent(); ++edge_index) {
        if (edge_index > 1) {
            out += ',';
        }
        const TopoDS_Edge edge = TopoDS::Edge(held.edges(edge_index));
        GProp_GProps props;
        BRepGProp::LinearProperties(edge, props);
        out += "{\"id\":";
        out += std::to_string(edge_index - 1);
        out += ",\"lengthMm\":";
        append_num(out, props.Mass());
        out += ",\"points\":[";
        BRepAdaptor_Curve curve(edge);
        GCPnts_QuasiUniformDeflection sampler(curve, chord);
        bool first_point = true;
        if (sampler.IsDone() && sampler.NbPoints() >= 2) {
            for (int point_index = 1; point_index <= sampler.NbPoints(); ++point_index) {
                append_point(out, first_point, sampler.Value(point_index));
            }
        } else {
            append_point(out, first_point, curve.Value(curve.FirstParameter()));
            append_point(out, first_point, curve.Value(curve.LastParameter()));
        }
        out += "]}";
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

char* finish(int id, double chord) {
    return alloc(tessellate(id, g_held.at(static_cast<size_t>(id - 1)), chord));
}

TopoDS_Shape make_primitive(
    const char* kind,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double height,
    std::string& error) {
    const std::string which = kind == nullptr ? "" : kind;
    if (which == "box") {
        if (!(dx > 0.0) || !(dy > 0.0) || !(dz > 0.0)) {
            error = "A box needs a positive length on each side";
            return {};
        }
        BRepPrimAPI_MakeBox box(gp_Pnt(x, y, z), dx, dy, dz);
        box.Build();
        if (!box.IsDone()) {
            error = "Open CASCADE did not build the box";
            return {};
        }
        return box.Shape();
    }
    if (which == "cylinder") {
        if (!(radius > 0.0) || !(height > 0.0)) {
            error = "A cylinder needs a positive radius and height";
            return {};
        }
        BRepPrimAPI_MakeCylinder cylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), radius, height);
        cylinder.Build();
        if (!cylinder.IsDone()) {
            error = "Open CASCADE did not build the cylinder";
            return {};
        }
        return cylinder.Shape();
    }
    if (which == "sphere") {
        if (!(radius > 0.0)) {
            error = "A sphere needs a positive radius";
            return {};
        }
        BRepPrimAPI_MakeSphere sphere(gp_Pnt(x, y, z), radius);
        sphere.Build();
        if (!sphere.IsDone()) {
            error = "Open CASCADE did not build the sphere";
            return {};
        }
        return sphere.Shape();
    }
    error = "The primitive is box, cylinder, or sphere";
    return {};
}

/// Turn a primitive about its own centre by X, then Y, then Z degrees. A sphere is left alone.
TopoDS_Shape turn_primitive(
    const TopoDS_Shape& shape,
    const char* kind,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double height,
    double rx,
    double ry,
    double rz) {
    const std::string which = kind == nullptr ? "" : kind;
    if (which == "sphere" || (rx == 0.0 && ry == 0.0 && rz == 0.0)) {
        return shape;
    }
    const gp_Pnt centre = which == "box" ? gp_Pnt(x + dx / 2.0, y + dy / 2.0, z + dz / 2.0)
                                         : gp_Pnt(x, y, z + height / 2.0);
    const double rad = 3.14159265358979323846 / 180.0;
    gp_Trsf tx;
    gp_Trsf ty;
    gp_Trsf tz;
    tx.SetRotation(gp_Ax1(centre, gp_Dir(1, 0, 0)), rx * rad);
    ty.SetRotation(gp_Ax1(centre, gp_Dir(0, 1, 0)), ry * rad);
    tz.SetRotation(gp_Ax1(centre, gp_Dir(0, 0, 1)), rz * rad);
    gp_Trsf total = tz;
    total.Multiply(ty);
    total.Multiply(tx);
    BRepBuilderAPI_Transform builder(shape, total, Standard_True);
    return builder.Shape();
}

TopoDS_Shape boolean_op(const std::string& op, const TopoDS_Shape& solid, const TopoDS_Shape& tool, std::string& error) {
    if (op == "fuse") {
        BRepAlgoAPI_Fuse algo(solid, tool);
        algo.SetFuzzyValue(1.0e-7);
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

bool accepted_result(const TopoDS_Shape& shape, std::string& error) {
    if (shape.IsNull() || !has_solid(shape) || !(volume_of(shape) > 1e-6)) {
        error = "The boolean removed the solid";
        return false;
    }
    return true;
}

char* commit_edit(
    int id,
    const TopoDS_Shape& current,
    const TopoDS_Shape& result,
    double chord,
    const std::string& empty_message) {
    const TopoDS_Shape solid = as_solid(result);
    if (solid.IsNull() || !has_solid(solid) || !(volume_of(solid) > 1e-6)) {
        return error_json(empty_message);
    }
    std::lock_guard<std::mutex> lock(g_mu);
    Held held;
    if (!held_at(id, held) || !held.shape.IsSame(current)) {
        return error_json("That solid is no longer open");
    }
    checkpoint(current);
    replace_held(id, solid);
    return finish(id, chord);
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

/// Every index, once, in the order given. An empty list is the same refusal as an unpicked edge.
bool copy_edges(
    int id,
    const int* edges,
    int count,
    const char* verb,
    TopoDS_Shape& current,
    std::vector<TopoDS_Edge>& found,
    std::string& error) {
    std::lock_guard<std::mutex> lock(g_mu);
    Held held;
    if (!held_at(id, held)) {
        error = "That solid is no longer open";
        return false;
    }
    if (edges == nullptr || count <= 0) {
        error = std::string("Pick an edge to ") + verb + ".";
        return false;
    }
    current = held.shape;
    found.clear();
    for (int i = 0; i < count; ++i) {
        const int edge = edges[i];
        if (edge < 0) {
            error = count == 1 ? std::string("Pick an edge to ") + verb + "." : "That edge is not on this solid";
            return false;
        }
        if (edge >= held.edges.Extent()) {
            error = "That edge is not on this solid";
            return false;
        }
        bool duplicate = false;
        for (int earlier = 0; earlier < i; ++earlier) {
            if (edges[earlier] == edge) {
                duplicate = true;
                break;
            }
        }
        if (duplicate) {
            continue;
        }
        found.push_back(TopoDS::Edge(held.edges(edge + 1)));
    }
    if (found.empty()) {
        error = std::string("Pick an edge to ") + verb + ".";
        return false;
    }
    return true;
}

bool copy_shape(int id, TopoDS_Shape& current, std::string& error) {
    std::lock_guard<std::mutex> lock(g_mu);
    Held held;
    if (!held_at(id, held)) {
        error = "That solid is no longer open";
        return false;
    }
    current = held.shape;
    return true;
}

/// Build a fillet or chamfer on a copy. Every edge is added before the one Build, so corners blend together.
bool blend_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    double size,
    bool chamfer,
    TopoDS_Shape& built,
    std::string& error) {
    const bool many = edges.size() > 1;
    const char* failed = chamfer
        ? (many ? "The chamfer did not fit these edges" : "The chamfer did not fit this edge")
        : (many ? "The fillet did not fit these edges" : "The fillet did not fit this edge");
    if (edges.empty()) {
        error = failed;
        return false;
    }
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
        if (solid.IsNull() || !has_solid(solid) || !(volume_of(solid) > 1e-6)) {
            error = failed;
            return false;
        }
        built = shape;
        return true;
    } catch (const Standard_Failure&) {
        error = failed;
        return false;
    }
}

char* probe_json(bool ok, const std::string& error, double max_mm) {
    if (ok) {
        return alloc("{\"ok\":true}");
    }
    std::string text = std::string("{\"ok\":false,\"error\":\"") + escape(error) + "\"";
    if (max_mm > 0.05) {
        text += ",\"maxMm\":";
        append_num(text, max_mm);
    }
    text += "}";
    return alloc(text);
}

/// Largest size at or under `hi` that still builds, from a handful of trials.
double largest_blend(const TopoDS_Shape& current, const std::vector<TopoDS_Edge>& edges, double hi, bool chamfer) {
    double lo = 0.0;
    double best = 0.0;
    for (int step = 0; step < 6; ++step) {
        const double mid = (lo + hi) * 0.5;
        if (!(mid > 0.05)) {
            break;
        }
        TopoDS_Shape trial;
        std::string ignored;
        if (blend_build(current, edges, mid, chamfer, trial, ignored)) {
            (void)trial;
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
    const char* primitive,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double height,
    double rx,
    double ry,
    double rz,
    std::string& error) {
    const TopoDS_Shape made = make_primitive(primitive, x, y, z, dx, dy, dz, radius, height, error);
    if (made.IsNull()) {
        if (error.empty()) {
            error = "Open CASCADE did not build the primitive";
        }
        return {};
    }
    const TopoDS_Shape tool = turn_primitive(made, primitive, x, y, z, dx, dy, dz, height, rx, ry, rz);
    const TopoDS_Shape result = boolean_op(which, current, tool, error);
    if (!error.empty()) {
        return {};
    }
    if (!accepted_result(result, error)) {
        if (which == "common") {
            error = "The solids do not overlap";
        }
        return {};
    }
    return result;
}

/// The hole Apply cuts, on a copy. `direction` points into the material. Empty means straight down, toward −Z.
/// The cylinder stands `depth` along that direction and ends at the origin, matching a −Z drill from `(x, y, z)`.
TopoDS_Shape build_hole(
    const TopoDS_Shape& current,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double depth,
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
    const double before = volume_of(current);
    const double after = volume_of(as_solid(cut));
    if (!(after > 1e-6)) {
        error = "The hole removed the solid";
        return {};
    }
    if (std::abs(after - before) < 1e-4) {
        error = "The hole missed this solid";
        return {};
    }
    return cut;
}

}  // namespace

extern "C" char* lime_model_occt_open_box(double x_mm, double y_mm, double z_mm) {
    try {
        if (!(x_mm > 0.0) || !(y_mm > 0.0) || !(z_mm > 0.0)) {
            return error_json("A box needs a positive length on each side");
        }
        BRepPrimAPI_MakeBox box(x_mm, y_mm, z_mm);
        box.Build();
        if (!box.IsDone()) {
            return error_json("Open CASCADE did not build the box");
        }
        const TopoDS_Shape shape = box.Shape();
        std::lock_guard<std::mutex> lock(g_mu);
        const int id = store(shape);
        return finish(id, 0.1);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_open_step(const char* path, double chord) {
    try {
#ifndef LIME_OCCT_STEP
        (void)path;
        (void)chord;
        return error_json("STEP reader is not linked");
#else
        route_occt_log();
        if (path == nullptr || path[0] == '\0') {
            return error_json("STEP path is empty");
        }
        STEPControl_Reader reader;
        if (reader.ReadFile(path) != IFSelect_RetDone) {
            return error_json("Open CASCADE could not read this STEP file");
        }
        if (reader.TransferRoots() < 1) {
            return error_json("This STEP file has no solid to measure");
        }
        TopoDS_Shape shape = reader.OneShape();
        if (shape.IsNull()) {
            return error_json("This STEP file has no solid to measure");
        }
        Handle(ShapeFix_Shape) fixer = new ShapeFix_Shape(shape);
        fixer->Perform();
        if (!fixer->Shape().IsNull()) {
            shape = fixer->Shape();
        }
        std::lock_guard<std::mutex> lock(g_mu);
        const int id = store(shape);
        return finish(id, chord);
#endif
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_distance(
    int id,
    const char* a_kind,
    int a_index,
    const char* b_kind,
    int b_index) {
    try {
        TopoDS_Shape a;
        TopoDS_Shape b;
        {
            std::lock_guard<std::mutex> lock(g_mu);
            if (id < 1 || static_cast<size_t>(id) > g_held.size()) {
                return error_json("That solid is no longer open");
            }
            const Held& held = g_held.at(static_cast<size_t>(id - 1));
            if (!pick(held, a_kind, a_index, a) || !pick(held, b_kind, b_index, b)) {
                return error_json("That face or edge is not on this solid");
            }
        }
        BRepExtrema_DistShapeShape dist(a, b);
        if (!dist.IsDone()) {
            dist.Perform();
        }
        if (!dist.IsDone()) {
            return error_json("Open CASCADE could not measure that distance");
        }
        std::string out = "{\"id\":";
        out += std::to_string(id);
        out += ",\"distanceMm\":";
        append_num(out, dist.Value());
        out += '}';
        return alloc(out);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_boolean(
    int id,
    const char* op,
    const char* primitive,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double height,
    double rx,
    double ry,
    double rz,
    double chord) {
    try {
        const std::string which = op == nullptr ? "" : op;
        TopoDS_Shape current;
        {
            std::lock_guard<std::mutex> lock(g_mu);
            Held held;
            if (!held_at(id, held)) {
                return error_json("That solid is no longer open");
            }
            current = held.shape;
        }
        std::string error;
        const TopoDS_Shape result =
            build_boolean(current, which, primitive, x, y, z, dx, dy, dz, radius, height, rx, ry, rz, error);
        if (!error.empty()) {
            return error_json(error);
        }
        std::lock_guard<std::mutex> lock(g_mu);
        Held held;
        if (!held_at(id, held) || !held.shape.IsSame(current)) {
            return error_json("That solid is no longer open");
        }
        checkpoint(current);
        replace_held(id, as_solid(result));
        return finish(id, chord);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_split(
    int id,
    double x,
    double y,
    double z,
    double nx,
    double ny,
    double nz,
    double chord) {
    try {
        const double length = std::sqrt(nx * nx + ny * ny + nz * nz);
        if (!(length > 1e-12)) {
            return error_json("The plane needs a direction");
        }
        const gp_Dir normal(nx / length, ny / length, nz / length);
        TopoDS_Shape current;
        {
            std::lock_guard<std::mutex> lock(g_mu);
            Held held;
            if (!held_at(id, held)) {
                return error_json("That solid is no longer open");
            }
            current = held.shape;
        }
        Bnd_Box bounds;
        BRepBndLib::Add(current, bounds, Standard_False);
        if (bounds.IsVoid()) {
            return error_json("This solid has no extent");
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
            return error_json(reject);
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
            return error_json("Open CASCADE did not build the plane");
        }
        TopTools_ListOfShape arguments;
        arguments.Append(current);
        TopTools_ListOfShape tools;
        tools.Append(face.Shape());
        BRepAlgoAPI_Splitter splitter;
        splitter.SetArguments(arguments);
        splitter.SetTools(tools);
        splitter.Build();
        if (!splitter.IsDone() || splitter.HasErrors() || splitter.Shape().IsNull()) {
            return error_json("Open CASCADE did not split this solid");
        }
        std::vector<TopoDS_Shape> negative;
        std::vector<TopoDS_Shape> positive;
        for (TopExp_Explorer explorer(splitter.Shape(), TopAbs_SOLID); explorer.More(); explorer.Next()) {
            const TopoDS_Shape piece = explorer.Current();
            GProp_GProps props;
            BRepGProp::VolumeProperties(piece, props);
            const double side = gp_Vec(origin, props.CentreOfMass()).Dot(gp_Vec(normal));
            if (side < 0.0) {
                negative.push_back(piece);
            } else {
                positive.push_back(piece);
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
        const TopoDS_Shape kept = as_solid(unite(negative));
        const TopoDS_Shape other = as_solid(unite(positive));
        if (!join_error.empty()) {
            return error_json(join_error);
        }
        if (kept.IsNull() || other.IsNull() || !(volume_of(kept) > 1e-6) || !(volume_of(other) > 1e-6)) {
            return error_json("The plane did not split this solid");
        }
        if (depth_along(kept, normal) < 0.25 || depth_along(other, normal) < 0.25) {
            return error_json("The plane is too close to a face. Move it into the part.");
        }
        const Held other_held = hold_of(other);
        std::lock_guard<std::mutex> lock(g_mu);
        Held held;
        if (!held_at(id, held) || !held.shape.IsSame(current)) {
            return error_json("That solid is no longer open");
        }
        checkpoint(current);
        replace_held(id, kept);
        std::string text = tessellate(id, g_held.at(static_cast<size_t>(id - 1)), chord);
        const std::string other_json = tessellate(0, other_held, chord);
        if (!text.empty() && text.back() == '}') {
            text.pop_back();
            text += ",\"other\":";
            text += other_json;
            text += '}';
        }
        return alloc(text);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_undo(int id, double chord) {
    try {
        std::lock_guard<std::mutex> lock(g_mu);
        Held held;
        if (!held_at(id, held)) {
            return error_json("That solid is no longer open");
        }
        if (g_undo.empty()) {
            return error_json("There is no edit to undo");
        }
        const TopoDS_Shape current = held.shape;
        const TopoDS_Shape previous = g_undo.back();
        g_undo.pop_back();
        push_capped(g_redo, current);
        replace_held(id, previous);
        return finish(id, chord);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_redo(int id, double chord) {
    try {
        std::lock_guard<std::mutex> lock(g_mu);
        Held held;
        if (!held_at(id, held)) {
            return error_json("That solid is no longer open");
        }
        if (g_redo.empty()) {
            return error_json("There is no edit to redo");
        }
        const TopoDS_Shape current = held.shape;
        const TopoDS_Shape next = g_redo.back();
        g_redo.pop_back();
        push_capped(g_undo, current);
        replace_held(id, next);
        return finish(id, chord);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

char* blend_commit(int id, const int* edges, int count, double size, double chord, bool chamfer) {
    const char* verb = chamfer ? "chamfer" : "fillet";
    const char* need = chamfer ? "A chamfer needs a positive distance" : "A fillet needs a positive radius";
    if (!(size > 0.0)) {
        return error_json(need);
    }
    TopoDS_Shape current;
    std::vector<TopoDS_Edge> found;
    std::string error;
    if (!copy_edges(id, edges, count, verb, current, found, error)) {
        return error_json(error);
    }
    TopoDS_Shape built;
    if (!blend_build(current, found, size, chamfer, built, error)) {
        return error_json(error);
    }
    const char* empty = chamfer
        ? (found.size() > 1 ? "The chamfer did not fit these edges" : "The chamfer did not fit this edge")
        : (found.size() > 1 ? "The fillet did not fit these edges" : "The fillet did not fit this edge");
    return commit_edit(id, current, built, chord, empty);
}

extern "C" char* lime_model_occt_fillet(int id, int edge, double radius, double chord) {
    try {
        const int edges[1] = {edge};
        return blend_commit(id, edges, 1, radius, chord, false);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_chamfer(int id, int edge, double distance, double chord) {
    try {
        const int edges[1] = {edge};
        return blend_commit(id, edges, 1, distance, chord, true);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

/// Try a fillet or chamfer on a copy. The open solid stays as it was.
char* blend_probe_edges(int id, const int* edges, int count, double size, int chamfer) {
    const bool is_chamfer = chamfer != 0;
    if (!(size > 0.0)) {
        return probe_json(
            false,
            is_chamfer ? "A chamfer needs a positive distance" : "A fillet needs a positive radius",
            0.0);
    }
    TopoDS_Shape current;
    std::vector<TopoDS_Edge> found;
    std::string error;
    if (!copy_edges(id, edges, count, is_chamfer ? "chamfer" : "fillet", current, found, error)) {
        return probe_json(false, error, 0.0);
    }
    TopoDS_Shape built;
    if (blend_build(current, found, size, is_chamfer, built, error)) {
        (void)built;
        return probe_json(true, "", 0.0);
    }
    double max_mm = 0.0;
    if (error.find("did not fit") != std::string::npos) {
        max_mm = largest_blend(current, found, size, is_chamfer);
    }
    return probe_json(false, error, max_mm);
}

extern "C" char* lime_model_occt_blend_probe(int id, int edge, double size, int chamfer) {
    try {
        const int edges[1] = {edge};
        return blend_probe_edges(id, edges, 1, size, chamfer);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return probe_json(false, message != nullptr ? message : "Open CASCADE failed", 0.0);
    } catch (...) {
        return probe_json(false, "Open CASCADE failed", 0.0);
    }
}

extern "C" char* lime_model_occt_hole(
    int id,
    double x,
    double y,
    double z,
    double radius,
    double depth,
    double chord) {
    try {
        if (!(radius > 0.0) || !(depth > 0.0)) {
            return error_json("A hole needs a positive radius and depth");
        }
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return error_json(error);
        }
        const TopoDS_Shape cut = build_hole(current, x, y, z, 0.0, 0.0, -1.0, radius, depth, error);
        if (!error.empty()) {
            return error_json(error);
        }
        return commit_edit(id, current, cut, chord, "The hole removed the solid");
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

/// Try a hole on a copy. The open solid stays as it was.
extern "C" char* lime_model_occt_hole_probe(int id, double x, double y, double z, double radius, double depth) {
    try {
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return probe_json(false, error, 0.0);
        }
        const TopoDS_Shape cut = build_hole(current, x, y, z, 0.0, 0.0, -1.0, radius, depth, error);
        (void)cut;
        return probe_json(error.empty(), error, 0.0);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return probe_json(false, message != nullptr ? message : "Open CASCADE failed", 0.0);
    } catch (...) {
        return probe_json(false, "Open CASCADE failed", 0.0);
    }
}

/// Try a boolean on a copy. The open solid stays as it was.
extern "C" char* lime_model_occt_boolean_probe(
    int id,
    const char* op,
    const char* primitive,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double height,
    double rx,
    double ry,
    double rz) {
    try {
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return probe_json(false, error, 0.0);
        }
        const std::string which = op == nullptr ? "" : op;
        const TopoDS_Shape result =
            build_boolean(current, which, primitive, x, y, z, dx, dy, dz, radius, height, rx, ry, rz, error);
        (void)result;
        return probe_json(error.empty(), error, 0.0);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return probe_json(false, message != nullptr ? message : "Open CASCADE failed", 0.0);
    } catch (...) {
        return probe_json(false, "Open CASCADE failed", 0.0);
    }
}

extern "C" char* lime_model_occt_fillet_many(int id, const int* edges, int count, double radius, double chord) {
    try {
        return blend_commit(id, edges, count, radius, chord, false);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_chamfer_many(int id, const int* edges, int count, double distance, double chord) {
    try {
        return blend_commit(id, edges, count, distance, chord, true);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_blend_probe_many(int id, const int* edges, int count, double size, int chamfer) {
    try {
        return blend_probe_edges(id, edges, count, size, chamfer);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return probe_json(false, message != nullptr ? message : "Open CASCADE failed", 0.0);
    } catch (...) {
        return probe_json(false, "Open CASCADE failed", 0.0);
    }
}

extern "C" char* lime_model_occt_hole_axis(
    int id,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double depth,
    double chord) {
    try {
        if (!(radius > 0.0) || !(depth > 0.0)) {
            return error_json("A hole needs a positive radius and depth");
        }
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return error_json(error);
        }
        const TopoDS_Shape cut = build_hole(current, x, y, z, dx, dy, dz, radius, depth, error);
        if (!error.empty()) {
            return error_json(error);
        }
        return commit_edit(id, current, cut, chord, "The hole removed the solid");
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

/// Try a hole along `direction` on a copy. The open solid stays as it was.
extern "C" char* lime_model_occt_hole_axis_probe(
    int id,
    double x,
    double y,
    double z,
    double dx,
    double dy,
    double dz,
    double radius,
    double depth) {
    try {
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return probe_json(false, error, 0.0);
        }
        const TopoDS_Shape cut = build_hole(current, x, y, z, dx, dy, dz, radius, depth, error);
        (void)cut;
        return probe_json(error.empty(), error, 0.0);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return probe_json(false, message != nullptr ? message : "Open CASCADE failed", 0.0);
    } catch (...) {
        return probe_json(false, "Open CASCADE failed", 0.0);
    }
}

extern "C" char* lime_model_occt_scale(int id, double factor, double chord) {
    try {
        if (!(factor > 0.0)) {
            return error_json("Scale needs a positive factor");
        }
        if (std::abs(factor - 1.0) < 1e-9) {
            return error_json("Scale needs a factor other than 1");
        }
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return error_json(error);
        }
        Bnd_Box bounds;
        BRepBndLib::Add(current, bounds, Standard_False);
        if (bounds.IsVoid()) {
            return error_json("This solid has no extent");
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
            return error_json("Open CASCADE did not scale this solid");
        }
        return commit_edit(id, current, builder.Shape(), chord, "Open CASCADE did not scale this solid");
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_write_step(int id, const char* path) {
    try {
#ifndef LIME_OCCT_STEP
        (void)id;
        (void)path;
        return error_json("STEP writer is not linked");
#else
        route_occt_log();
        if (path == nullptr || path[0] == '\0') {
            return error_json("STEP path is empty");
        }
        TopoDS_Shape current;
        std::string error;
        if (!copy_shape(id, current, error)) {
            return error_json(error);
        }
        Interface_Static::SetCVal("write.step.schema", "AP214IS");
        STEPControl_Writer writer;
        if (writer.Transfer(current, STEPControl_ManifoldSolidBrep) != IFSelect_RetDone) {
            return error_json("Open CASCADE did not write this solid");
        }
        if (writer.Write(path) != IFSelect_RetDone) {
            return error_json("Open CASCADE did not write this solid");
        }
        return alloc("{\"ok\":true}");
#endif
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" void lime_model_occt_string_free(char* text) { std::free(text); }
