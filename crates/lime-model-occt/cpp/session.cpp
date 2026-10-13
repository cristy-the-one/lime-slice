// Open CASCADE session for Model mode. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
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

namespace {

struct Held {
    TopoDS_Shape shape;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
};

std::mutex g_mu;
std::vector<Held> g_held;
std::vector<TopoDS_Shape> g_undo;

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

void checkpoint(const TopoDS_Shape& shape) {
    g_undo.push_back(shape);
    if (g_undo.size() > 32) {
        g_undo.erase(g_undo.begin());
    }
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

bool copy_edge(
    int id,
    int edge,
    const char* verb,
    TopoDS_Shape& current,
    TopoDS_Edge& found,
    std::string& error) {
    std::lock_guard<std::mutex> lock(g_mu);
    Held held;
    if (!held_at(id, held)) {
        error = "That solid is no longer open";
        return false;
    }
    if (edge < 0) {
        error = std::string("Pick an edge to ") + verb + ".";
        return false;
    }
    if (edge >= held.edges.Extent()) {
        error = "That edge is not on this solid";
        return false;
    }
    current = held.shape;
    found = TopoDS::Edge(held.edges(edge + 1));
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
        const TopoDS_Shape tool = make_primitive(primitive, x, y, z, dx, dy, dz, radius, height, error);
        if (tool.IsNull()) {
            return error_json(error.empty() ? "Open CASCADE did not build the primitive" : error);
        }
        const TopoDS_Shape result = boolean_op(which, current, tool, error);
        if (!error.empty()) {
            return error_json(error);
        }
        if (!accepted_result(result, error)) {
            if (which == "common") {
                error = "The solids do not overlap";
            }
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
        const TopoDS_Shape previous = g_undo.back();
        g_undo.pop_back();
        replace_held(id, previous);
        return finish(id, chord);
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_fillet(int id, int edge, double radius, double chord) {
    try {
        if (!(radius > 0.0)) {
            return error_json("A fillet needs a positive radius");
        }
        TopoDS_Shape current;
        TopoDS_Edge found;
        std::string error;
        if (!copy_edge(id, edge, "fillet", current, found, error)) {
            return error_json(error);
        }
        TopoDS_Shape built;
        try {
            BRepFilletAPI_MakeFillet fillet(current);
            fillet.Add(radius, found);
            fillet.Build();
            if (!fillet.IsDone() || fillet.Shape().IsNull()) {
                return error_json("The fillet did not fit this edge");
            }
            built = fillet.Shape();
        } catch (const Standard_Failure&) {
            return error_json("The fillet did not fit this edge");
        }
        return commit_edit(id, current, built, chord, "The fillet did not fit this edge");
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
    }
}

extern "C" char* lime_model_occt_chamfer(int id, int edge, double distance, double chord) {
    try {
        if (!(distance > 0.0)) {
            return error_json("A chamfer needs a positive distance");
        }
        TopoDS_Shape current;
        TopoDS_Edge found;
        std::string error;
        if (!copy_edge(id, edge, "chamfer", current, found, error)) {
            return error_json(error);
        }
        TopoDS_Shape built;
        try {
            BRepFilletAPI_MakeChamfer chamfer(current);
            chamfer.Add(distance, found);
            chamfer.Build();
            if (!chamfer.IsDone() || chamfer.Shape().IsNull()) {
                return error_json("The chamfer did not fit this edge");
            }
            built = chamfer.Shape();
        } catch (const Standard_Failure&) {
            return error_json("The chamfer did not fit this edge");
        }
        return commit_edit(id, current, built, chord, "The chamfer did not fit this edge");
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
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
        BRepPrimAPI_MakeCylinder cylinder(gp_Ax2(gp_Pnt(x, y, z - depth), gp_Dir(0, 0, 1)), radius, depth);
        cylinder.Build();
        if (!cylinder.IsDone()) {
            return error_json("Open CASCADE did not build the hole");
        }
        const TopoDS_Shape cut = boolean_op("cut", current, cylinder.Shape(), error);
        if (!error.empty()) {
            return error_json(error);
        }
        const double before = volume_of(current);
        const double after = volume_of(as_solid(cut));
        if (!(after > 1e-6)) {
            return error_json("The hole removed the solid");
        }
        if (std::abs(after - before) < 1e-4) {
            return error_json("The hole missed this solid");
        }
        return commit_edit(id, current, cut, chord, "The hole removed the solid");
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return error_json(message != nullptr ? message : "Open CASCADE failed");
    } catch (...) {
        return error_json("Open CASCADE failed");
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
