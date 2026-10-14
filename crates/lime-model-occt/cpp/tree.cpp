// Shapes for the Model history tree. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.
//
// The tree itself lives in Rust (src/tree.rs). Each node owns one LimeShape, built once and kept
// until the node is evicted. Nothing here locks: the Rust store serialises every call.

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepGProp.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
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

/// Everything a node keeps about its solid. The volume comes from the op that built it; edge
/// midpoints are computed when a fillet or chamfer first asks for them.
struct LimeShape {
    Held held;
    std::vector<EdgeInfo> edges;
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

/// The accepted result of an edit: one solid with volume. `volume` is what the op integrated.
/// `empty` is the refusal when there is no solid.
LimeShape* adopt(const TopoDS_Shape& result, double volume, const std::string& empty, char** error) {
    const TopoDS_Shape solid = as_solid(result);
    if (solid.IsNull() || !has_solid(solid) || !(volume > 1e-6)) {
        set_error(error, empty);
        return nullptr;
    }
    auto* out = new LimeShape();
    out->held = hold_of(solid, volume);
    out->edges.resize(static_cast<size_t>(out->held.edges.Extent()));
    return out;
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

LimeShape* lime_tree_box(double x, double y, double z, char** error) {
    try {
        if (!(x > 0.0) || !(y > 0.0) || !(z > 0.0)) {
            set_error(error, "A box needs a positive length on each side");
            return nullptr;
        }
        BRepPrimAPI_MakeBox box(x, y, z);
        box.Build();
        if (!box.IsDone()) {
            set_error(error, "Open CASCADE did not build the box");
            return nullptr;
        }
        return adopt(box.Shape(), x * y * z, "Open CASCADE did not build the box", error);
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
        const TopoDS_Shape solid = as_solid(shape);
        return adopt(solid, volume_of(solid), "This STEP file has no solid to measure", error);
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is x, y, z, dx, dy, dz, radius, height, rx, ry, rz.
LimeShape* lime_tree_boolean(const LimeShape* from, const char* op, const char* primitive, const double* p, char** error) {
    try {
        std::string message;
        const std::string which = op == nullptr ? "" : op;
        double volume = 0.0;
        const TopoDS_Shape result = build_boolean(
            from->held.shape, which, primitive, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], volume,
            message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The boolean removed the solid", error);
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is x, y, z, dx, dy, dz, radius, depth.
LimeShape* lime_tree_hole(const LimeShape* from, const double* p, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape cut = build_hole(
            from->held.shape, from->held.volume, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(cut, volume, "The hole removed the solid", error);
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
        return adopt(built, volume, blend_failed(is_chamfer, found.size()), error);
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
        LimeShape* out = adopt(kept, kept_volume, "The plane did not split this solid", error);
        if (out == nullptr) {
            return nullptr;
        }
        LimeShape* piece = adopt(rest, rest_volume, "The plane did not split this solid", error);
        if (piece == nullptr) {
            delete out;
            return nullptr;
        }
        *other = piece;
        return out;
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
        return adopt(scaled, volume, "Open CASCADE did not scale this solid", error);
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
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
        } catch (const Standard_Failure&) {
            info.mid[0] = info.mid[1] = info.mid[2] = std::nan("");
            info.length = std::nan("");
        }
        info.ready = true;
    }
    std::memcpy(mid, info.mid, sizeof(info.mid));
    *length = info.length;
    return 1;
}

/// The Model reply for this solid: triangles, faces, and edges. Freed with lime_model_occt_string_free.
char* lime_tree_reply(const LimeShape* shape, int id, double chord) {
    try {
        return alloc(tessellate(id, shape->held, chord));
    } catch (const Standard_Failure& failure) {
        const char* message = failure.GetMessageString();
        return alloc(std::string("{\"error\":\"") + escape(message != nullptr ? message : "Open CASCADE failed") + "\"}");
    } catch (...) {
        return alloc("{\"error\":\"Open CASCADE failed\"}");
    }
}

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
