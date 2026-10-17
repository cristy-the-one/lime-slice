// Shapes for the Model history tree. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.
//
// The tree itself lives in Rust (src/tree.rs). Each node owns one LimeShape, built once and kept
// until the node is evicted. Nothing here locks: the Rust store serialises every call.

#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <Standard_Failure.hxx>
#include <TopoDS.hxx>

#include "kernel.h"

using namespace lime_occt;

struct EdgeInfo {
    bool ready = false;
    double mid[3] = {0, 0, 0};
    double length = 0;
};

struct FaceInfo {
    bool ready = false;
    double mid[3] = {0, 0, 0};
    double area = 0;
};

/// Everything a node keeps about its solid. The volume comes from the op that built it; edge
/// midpoints are computed when a fillet or chamfer first asks for them, face middles when a shell does.
/// `created` is the edges the op that built it made or changed: those not on the solid it was built from.
struct LimeShape {
    Held held;
    std::vector<EdgeInfo> edges;
    std::vector<FaceInfo> faces;
    std::vector<int> created;
};

/// A Mesh's arrays as bytes in this machine's order, and the shape's description as JSON.
struct LimeMeshView {
    const unsigned char* positions;
    size_t positions_bytes;
    const unsigned char* triangles;
    size_t triangles_bytes;
    const unsigned char* edge_points;
    size_t edge_points_bytes;
    const unsigned char* edge_offsets;
    size_t edge_offsets_bytes;
    const char* meta;
};

namespace {

void set_error(char** out, const std::string& message) {
    if (out != nullptr) {
        *out = alloc(message);
    }
}

void set_failure(char** out, const Standard_Failure& failure) {
    const char* message = failure.GetMessageString();
    set_error(out, message != nullptr && message[0] != '\0' ? message : "Open CASCADE failed");
}

std::unique_ptr<LimeShape> hold(const TopoDS_Shape& shape, double volume) {
    auto out = std::make_unique<LimeShape>();
    out->held = hold_of(shape, volume);
    out->edges.resize(static_cast<size_t>(out->held.edges.Extent()));
    out->faces.resize(static_cast<size_t>(out->held.faces.Extent()));
    // A solid with no parent made every edge it has.
    out->created.resize(out->edges.size());
    for (size_t i = 0; i < out->created.size(); ++i) {
        out->created[i] = static_cast<int>(i);
    }
    return out;
}

/// The accepted result of an edit: one solid with volume. `volume` is what the op integrated.
/// `empty` is the refusal when there is no solid. Released to the caller only once nothing can throw.
/// `from` is the solid it was built from: an edge still on it, the same edge, was not made by this op.
std::unique_ptr<LimeShape> adopt(const TopoDS_Shape& result, double volume, const std::string& empty, char** error, const LimeShape* from) {
    const TopoDS_Shape solid = as_solid(result);
    if (solid.IsNull() || !has_solid(solid) || !(volume > 1e-6)) {
        set_error(error, empty);
        return nullptr;
    }
    std::unique_ptr<LimeShape> out = hold(solid, volume);
    if (from != nullptr) {
        out->created.clear();
        for (int index = 1; index <= out->held.edges.Extent(); ++index) {
            if (!from->held.edges.Contains(out->held.edges(index))) {
                out->created.push_back(index - 1);
            }
        }
    }
    return out;
}

/// `p` is the plane's origin and turn, then the op's own numbers. `points` is `count` u, v pairs.
ProfileSpec profile_of(const double* p, const double* points, int count) {
    ProfileSpec spec;
    for (int i = 0; i < 3; ++i) {
        spec.origin[i] = p[i];
        spec.turn[i] = p[3 + i];
    }
    spec.points.assign(points, points + 2 * static_cast<size_t>(std::max(count, 0)));
    return spec;
}

/// `p` is x, y, z, dx, dy, dz, radius, height, rx, ry, rz, top radius, tube radius, inner radius, top X,
/// sides, across, and flats (non-zero for across flats), in the order `Solid::numbers` in src/tree.rs writes them.
PrimitiveSpec spec_of(const char* kind, const double* p) {
    PrimitiveSpec spec;
    spec.kind = kind == nullptr ? "" : kind;
    spec.x = p[0];
    spec.y = p[1];
    spec.z = p[2];
    spec.dx = p[3];
    spec.dy = p[4];
    spec.dz = p[5];
    spec.radius = p[6];
    spec.height = p[7];
    spec.rx = p[8];
    spec.ry = p[9];
    spec.rz = p[10];
    spec.top_radius = p[11];
    spec.tube_radius = p[12];
    spec.inner_radius = p[13];
    spec.top_x = p[14];
    spec.sides = p[15];
    spec.across = p[16];
    spec.flats = p[17] != 0.0;
    return spec;
}

const char* blend_failed(bool chamfer, size_t count) {
    if (chamfer) {
        return count > 1 ? "The chamfer did not fit these edges" : "The chamfer did not fit this edge";
    }
    return count > 1 ? "The fillet did not fit these edges" : "The fillet did not fit this edge";
}

}  // namespace

extern "C" {

void lime_tree_free(LimeShape* shape) { delete shape; }

/// A primitive root: the solid built from its numbers, with its volume integrated once.
LimeShape* lime_tree_primitive(const char* kind, const double* p, char** error) {
    try {
        std::string message;
        const TopoDS_Shape made = make_solid(spec_of(kind, p), message);
        if (made.IsNull()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(made, volume_of(made), "Open CASCADE did not build the primitive", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

LimeShape* lime_tree_read_step(const char* path, char** error) {
    try {
        std::string message;
        const TopoDS_Shape shape = read_step(path, message);
        if (shape.IsNull()) {
            set_error(error, message);
            return nullptr;
        }
        // Surfaces with no closed solid still open, to be measured; every edit on them is refused.
        const TopoDS_Shape solid = as_solid(shape);
        return hold(solid, volume_of(solid)).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

LimeShape* lime_tree_boolean(const LimeShape* from, const char* op, const char* primitive, const double* p, char** error) {
    try {
        std::string message;
        const std::string which = op == nullptr ? "" : op;
        double volume = 0.0;
        const TopoDS_Shape result = build_boolean(from->held.shape, which, spec_of(primitive, p), volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The boolean removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// Another tree's solid, placed by `place` (the 3×3 turn row by row, then the move), combined with `from`.
/// The Rust side has checked that `tool` is a solid and `place` rigid.
LimeShape* lime_tree_join(const LimeShape* from, const LimeShape* tool, const char* op, const double* place, char** error) {
    try {
        std::string message;
        const std::string which = op == nullptr ? "" : op;
        double volume = 0.0;
        const TopoDS_Shape result = build_join(from->held.shape, tool->held.shape, which, place, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The boolean removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is x, y, z, dx, dy, dz, radius, depth, through (0 or 1), counterbore (0 or 1), its radius, its depth.
LimeShape* lime_tree_hole(const LimeShape* from, const double* p, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        HoleSpec hole;
        hole.x = p[0];
        hole.y = p[1];
        hole.z = p[2];
        hole.dx = p[3];
        hole.dy = p[4];
        hole.dz = p[5];
        hole.radius = p[6];
        hole.depth = p[7];
        hole.through = p[8] != 0.0;
        hole.bore = p[9] != 0.0;
        hole.bore_radius = p[10];
        hole.bore_depth = p[11];
        const TopoDS_Shape cut = build_hole(from->held.shape, from->held.volume, hole, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(cut, volume, "The hole removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// Every index must be on `from` and listed once; the Rust side resolves picks before this.
/// On a fit failure with `max_mm` set, it receives the largest size that still builds.
LimeShape* lime_tree_blend(
    const LimeShape* from,
    const int* edges,
    int count,
    double size,
    int chamfer,
    double* max_mm,
    char** error) {
    try {
        const bool is_chamfer = chamfer != 0;
        if (!(size > 0.0)) {
            set_error(error, is_chamfer ? "A chamfer needs a positive distance" : "A fillet needs a positive radius");
            return nullptr;
        }
        std::vector<TopoDS_Edge> found;
        for (int i = 0; i < count; ++i) {
            if (edges[i] < 0 || edges[i] >= from->held.edges.Extent()) {
                set_error(error, "That edge is not on this solid");
                return nullptr;
            }
            found.push_back(TopoDS::Edge(from->held.edges(edges[i] + 1)));
        }
        if (found.empty()) {
            set_error(error, std::string("Pick an edge to ") + (is_chamfer ? "chamfer." : "fillet."));
            return nullptr;
        }
        std::string message;
        TopoDS_Shape built;
        double volume = 0.0;
        if (!blend_build(from->held.shape, found, size, is_chamfer, built, volume, message)) {
            if (max_mm != nullptr && message.find("did not fit") != std::string::npos) {
                *max_mm = largest_blend(from->held.shape, found, size, is_chamfer);
            }
            set_error(error, message);
            return nullptr;
        }
        return adopt(built, volume, blend_failed(is_chamfer, found.size()), error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is x, y, z, nx, ny, nz. The result is the negative side; `other` receives the positive side.
LimeShape* lime_tree_split(const LimeShape* from, const double* p, LimeShape** other, char** error) {
    try {
        std::string message;
        TopoDS_Shape kept;
        TopoDS_Shape rest;
        double kept_volume = 0.0;
        double rest_volume = 0.0;
        if (!build_split(
                from->held.shape, p[0], p[1], p[2], p[3], p[4], p[5], kept, rest, kept_volume, rest_volume, message)) {
            set_error(error, message);
            return nullptr;
        }
        std::unique_ptr<LimeShape> out = adopt(kept, kept_volume, "The plane did not split this solid", error, from);
        if (out == nullptr) {
            return nullptr;
        }
        std::unique_ptr<LimeShape> piece = adopt(rest, rest_volume, "The plane did not split this solid", error, nullptr);
        if (piece == nullptr) {
            return nullptr;
        }
        *other = piece.release();
        return out.release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

LimeShape* lime_tree_scale(const LimeShape* from, double factor, char** error) {
    try {
        std::string message;
        const TopoDS_Shape scaled = build_scale(from->held.shape, factor, message);
        if (scaled.IsNull()) {
            set_error(error, message);
            return nullptr;
        }
        const double volume = from->held.volume * factor * factor * factor;
        return adopt(scaled, volume, "Open CASCADE did not scale this solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is the plane's origin and turn, the depth, and symmetric (0 or 1).
LimeShape* lime_tree_extrude(const LimeShape* from, const char* op, const double* p, const double* points, int count, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_extrude(
            from->held.shape, from->held.volume, op == nullptr ? "" : op, profile_of(p, points, count), p[6], p[7] != 0.0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The extrude removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is the plane's origin and turn, the axis's point (u, v) and direction (u, v), and the angle in degrees.
LimeShape* lime_tree_revolve(const LimeShape* from, const char* op, const double* p, const double* points, int count, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_revolve(
            from->held.shape, from->held.volume, op == nullptr ? "" : op, profile_of(p, points, count), p + 6, p[10], volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The revolve removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// Every index must be a face of `from`; the Rust side resolves picks before this.
LimeShape* lime_tree_shell(const LimeShape* from, const int* faces, int count, double thickness, char** error) {
    try {
        std::vector<TopoDS_Face> open;
        for (int i = 0; i < count; ++i) {
            if (faces[i] < 0 || faces[i] >= from->held.faces.Extent()) {
                set_error(error, "That face is not on this solid.");
                return nullptr;
            }
            open.push_back(TopoDS::Face(from->held.faces(faces[i] + 1)));
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_shell(from->held.shape, from->held.volume, open, thickness, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "This wall is too thick for the part's smallest feature.", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// The edges the op that built `shape` made or changed, as indexes, read through `out` while the shape lives.
int lime_tree_created(const LimeShape* shape, const int** out) {
    *out = shape->created.data();
    return static_cast<int>(shape->created.size());
}

/// Each of `edges` as convex (1), concave (2), or neither (0). 0 when an index is not on this solid or Open CASCADE fails.
int lime_tree_edge_kinds(const LimeShape* shape, const int* edges, int count, int* out) {
    try {
        std::vector<TopoDS_Edge> found;
        for (int i = 0; i < count; ++i) {
            if (edges[i] < 0 || edges[i] >= shape->held.edges.Extent()) {
                return 0;
            }
            found.push_back(TopoDS::Edge(shape->held.edges(edges[i] + 1)));
        }
        const std::vector<int> kinds = edge_kinds(shape->held.shape, found);
        std::copy(kinds.begin(), kinds.end(), out);
        return 1;
    } catch (...) {
        return 0;
    }
}

/// How many separate solids and closed shells the shape has: a hollow body is one solid of two shells.
void lime_tree_counts(const LimeShape* shape, int* solids, int* shells) {
    *solids = count_of(shape->held.shape, TopAbs_SOLID);
    *shells = count_of(shape->held.shape, TopAbs_SHELL);
}

/// The face's centre of area and its area. 0 when the index is not on this solid.
int lime_tree_face(LimeShape* shape, int index, double* mid, double* area) {
    if (index < 0 || static_cast<size_t>(index) >= shape->faces.size()) {
        return 0;
    }
    FaceInfo& info = shape->faces[static_cast<size_t>(index)];
    if (!info.ready) {
        try {
            GProp_GProps props;
            BRepGProp::SurfaceProperties(shape->held.faces(index + 1), props);
            const gp_Pnt centre = props.CentreOfMass();
            info.mid[0] = centre.X();
            info.mid[1] = centre.Y();
            info.mid[2] = centre.Z();
            info.area = props.Mass();
        } catch (...) {
            info.mid[0] = info.mid[1] = info.mid[2] = std::nan("");
            info.area = std::nan("");
        }
        info.ready = true;
    }
    std::memcpy(mid, info.mid, sizeof(info.mid));
    *area = info.area;
    return 1;
}

/// 1 when the shape can be edited, else 0 and the refusal every edit answers.
int lime_tree_editable(const LimeShape* shape, char** error) {
    std::string message;
    if (editable(shape->held.shape, message)) {
        return 1;
    }
    set_error(error, message);
    return 0;
}

void lime_tree_fingerprint(const LimeShape* shape, double* volume, int* faces, int* edges) {
    *volume = shape->held.volume;
    *faces = shape->held.faces.Extent();
    *edges = shape->held.edges.Extent();
}

/// The point at the middle of the edge's parameter range, and its length. 0 when the index is not on this solid.
int lime_tree_edge(LimeShape* shape, int index, double* mid, double* length) {
    if (index < 0 || static_cast<size_t>(index) >= shape->edges.size()) {
        return 0;
    }
    EdgeInfo& info = shape->edges[static_cast<size_t>(index)];
    if (!info.ready) {
        try {
            const TopoDS_Edge edge = TopoDS::Edge(shape->held.edges(index + 1));
            BRepAdaptor_Curve curve(edge);
            const gp_Pnt point = curve.Value((curve.FirstParameter() + curve.LastParameter()) * 0.5);
            GProp_GProps props;
            BRepGProp::LinearProperties(edge, props);
            info.mid[0] = point.X();
            info.mid[1] = point.Y();
            info.mid[2] = point.Z();
            info.length = props.Mass();
        } catch (...) {
            info.mid[0] = info.mid[1] = info.mid[2] = std::nan("");
            info.length = std::nan("");
        }
        info.ready = true;
    }
    std::memcpy(mid, info.mid, sizeof(info.mid));
    *length = info.length;
    return 1;
}

/// The tessellation for the Model reply, read through `view` until lime_tree_mesh_free, and the
/// shape's description, which lives as long as the shape. Null, and `error` set, when Open CASCADE fails.
Mesh* lime_tree_mesh(LimeShape* shape, double chord, LimeMeshView* view, char** error) {
    try {
        auto mesh = std::make_unique<Mesh>(tessellate(shape->held, chord));
        if (shape->held.about.empty()) {
            shape->held.about = describe(shape->held);
        }
        view->positions = reinterpret_cast<const unsigned char*>(mesh->positions.data());
        view->positions_bytes = mesh->positions.size() * sizeof(float);
        view->triangles = reinterpret_cast<const unsigned char*>(mesh->triangles.data());
        view->triangles_bytes = mesh->triangles.size() * sizeof(uint32_t);
        view->edge_points = reinterpret_cast<const unsigned char*>(mesh->edge_points.data());
        view->edge_points_bytes = mesh->edge_points.size() * sizeof(float);
        view->edge_offsets = reinterpret_cast<const unsigned char*>(mesh->edge_offsets.data());
        view->edge_offsets_bytes = mesh->edge_offsets.size() * sizeof(uint32_t);
        view->meta = shape->held.about.c_str();
        return mesh.release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

void lime_tree_mesh_free(Mesh* mesh) { delete mesh; }

/// 1 and `out` set, or 0 and `error` set.
int lime_tree_distance(
    const LimeShape* shape,
    const char* a_kind,
    int a_index,
    const char* b_kind,
    int b_index,
    double* out,
    char** error) {
    try {
        std::string message;
        if (!measure_distance(shape->held, a_kind, a_index, b_kind, b_index, *out, message)) {
            set_error(error, message);
            return 0;
        }
        return 1;
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return 0;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return 0;
    }
}

int lime_tree_write_step(const LimeShape* shape, const char* path, char** error) {
    try {
        std::string message;
        if (!write_step(shape->held.shape, path, message)) {
            set_error(error, message);
            return 0;
        }
        return 1;
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return 0;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return 0;
    }
}

}  // extern "C"
