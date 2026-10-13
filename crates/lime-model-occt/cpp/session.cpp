// Open CASCADE session for Model mode. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRep_Tool.hxx>
#include <GCPnts_QuasiUniformDeflection.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_Failure.hxx>
#include <Standard_VersionInfo.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>

#ifdef LIME_OCCT_STEP
#include <IFSelect_ReturnStatus.hxx>
#include <STEPControl_Reader.hxx>
#endif

namespace {

struct Held {
    TopoDS_Shape shape;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
};

std::mutex g_mu;
std::vector<Held> g_held;

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

int store(const TopoDS_Shape& shape) {
    Held held;
    held.shape = shape;
    TopExp::MapShapes(shape, TopAbs_FACE, held.faces);
    TopExp::MapShapes(shape, TopAbs_EDGE, held.edges);
    g_held.clear();
    g_held.push_back(std::move(held));
    return 1;
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

std::string tessellate(int id, const TopoDS_Shape& shape, double chord) {
    chord = chord_of(chord);
    BRepMesh_IncrementalMesh mesh(shape, chord, Standard_False, 0.5, Standard_False);
    mesh.Perform();

    const Held& held = g_held.at(static_cast<size_t>(id - 1));

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

char* finish(int id, const TopoDS_Shape& shape, double chord) {
    return alloc(tessellate(id, shape, chord));
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
        return finish(id, shape, 0.1);
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
        const TopoDS_Shape shape = reader.OneShape();
        if (shape.IsNull()) {
            return error_json("This STEP file has no solid to measure");
        }
        std::lock_guard<std::mutex> lock(g_mu);
        const int id = store(shape);
        return finish(id, shape, chord);
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

extern "C" void lime_model_occt_string_free(char* text) { std::free(text); }
