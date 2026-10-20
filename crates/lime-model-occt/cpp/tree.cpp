// Shapes for the Model history tree. This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.
//
// The tree itself lives in Rust (src/tree.rs). Each node owns one LimeShape, built once and kept
// until the node is evicted. Nothing here locks: the Rust store serialises every call.

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <BRepAdaptor_Curve.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <Standard_Failure.hxx>
#include <Standard_VersionInfo.hxx>
#include <TopoDS.hxx>
#include <TopTools_ListIteratorOfListOfShape.hxx>

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
/// `from_face` is, for each face, the parent face it descends from, or -1 when this step made it.
struct LimeShape {
    Held held;
    std::vector<EdgeInfo> edges;
    std::vector<FaceInfo> faces;
    std::vector<int> created;
    std::vector<int> from_face;
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
    // A solid with no parent made every edge it has, and every face.
    out->created.resize(out->edges.size());
    for (size_t i = 0; i < out->created.size(); ++i) {
        out->created[i] = static_cast<int>(i);
    }
    out->from_face.assign(out->faces.size(), -1);
    return out;
}

/// A result face still equal to a parent face keeps that parent's index. A boolean's history then
/// fills the rest: a face it only trimmed is `Modified` (or `Generated`) from a parent face, and
/// stays that parent's. Tool faces and anything else stay -1, made by this step. IsSame wins, so
/// history never reassigns a face the parent still has.
void note_lineage(LimeShape& out, const LimeShape& from, const Handle(BRepTools_History)& history) {
    const int count = static_cast<int>(out.faces.size());
    out.from_face.assign(static_cast<size_t>(count), -1);
    for (int index = 0; index < count; ++index) {
        const int parent = from.held.faces.FindIndex(out.held.faces(index + 1));
        if (parent > 0) {
            out.from_face[static_cast<size_t>(index)] = parent - 1;
        }
    }
    if (history.IsNull()) {
        return;
    }
    const auto claim = [&](int parent_index, const TopoDS_Shape& made) {
        const int found = out.held.faces.FindIndex(made);
        if (found <= 0) {
            return;
        }
        int& slot = out.from_face[static_cast<size_t>(found - 1)];
        if (slot < 0) {
            slot = parent_index;
        }
    };
    for (int parent = 0; parent < from.held.faces.Extent(); ++parent) {
        const TopoDS_Shape face = from.held.faces(parent + 1);
        for (TopTools_ListIteratorOfListOfShape it(history->Modified(face)); it.More(); it.Next()) {
            claim(parent, it.Value());
        }
    }
    for (int parent = 0; parent < from.held.faces.Extent(); ++parent) {
        const TopoDS_Shape face = from.held.faces(parent + 1);
        for (TopTools_ListIteratorOfListOfShape it(history->Generated(face)); it.More(); it.Next()) {
            claim(parent, it.Value());
        }
    }
}

/// The accepted result of an edit: one solid with volume. `volume` is what the op integrated.
/// `empty` is the refusal when there is no solid. Released to the caller only once nothing can throw.
/// `from` is the solid it was built from: an edge still on it, the same edge, was not made by this op.
std::unique_ptr<LimeShape> adopt(
    const TopoDS_Shape& result,
    double volume,
    const std::string& empty,
    char** error,
    const LimeShape* from,
    const Handle(BRepTools_History)& history = Handle(BRepTools_History)()) {
    const TopoDS_Shape solid = as_solid(result);
    if (solid.IsNull() || !has_solid(solid) || !(volume > 1e-6)) {
        set_error(error, empty);
        return nullptr;
    }
    std::unique_ptr<LimeShape> out = hold(solid, volume);
    if (from != nullptr) {
        inherit_about(out->held, from->held);
        out->held.built_on = true;
        for (int index = 1; index <= out->held.faces.Extent(); ++index) {
            if (!from->held.faces.Contains(out->held.faces(index))) {
                out->held.made.push_back(index);
            }
        }
        out->created.clear();
        for (int index = 1; index <= out->held.edges.Extent(); ++index) {
            if (!from->held.edges.Contains(out->held.edges(index))) {
                out->created.push_back(index - 1);
            }
        }
        note_lineage(*out, *from, history);
    }
    return out;
}

/// `p` is the plane's origin and turn, then the op's own numbers. `points` is `count` u, v pairs. `shape` points at
/// smooth (0 or 1), the number of corners, and the corners' indexes.
ProfileSpec profile_of(const double* p, const double* points, int count, const double* shape = nullptr) {
    ProfileSpec spec;
    for (int i = 0; i < 3; ++i) {
        spec.origin[i] = p[i];
        spec.turn[i] = p[3 + i];
    }
    spec.points.assign(points, points + 2 * static_cast<size_t>(std::max(count, 0)));
    if (shape != nullptr) {
        spec.smooth = shape[0] != 0.0;
        const int corners = static_cast<int>(shape[1]);
        for (int i = 0; i < corners; ++i) {
            spec.corners.push_back(static_cast<int>(shape[2 + i]));
        }
    }
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

/// A solid `lime_tree_write_brep` wrote. `volume` is the one its step integrated, kept with the bytes; 0 integrates it.
/// `created` is the edges its step made, `count` of them; a negative count leaves every edge, as for a root.
LimeShape* lime_tree_read_brep(const char* data, size_t size, double volume, const int* created, int count, char** error) {
    try {
        std::string message;
        const TopoDS_Shape shape = read_brep(data, size, message);
        if (shape.IsNull()) {
            set_error(error, message);
            return nullptr;
        }
        std::unique_ptr<LimeShape> out = hold(shape, volume > 0.0 ? volume : volume_of(shape));
        if (count >= 0) {
            out->created.clear();
            for (int i = 0; i < count; ++i) {
                if (created[i] < 0 || static_cast<size_t>(created[i]) >= out->edges.size()) {
                    set_error(error, "This saved solid is damaged");
                    return nullptr;
                }
                out->created.push_back(created[i]);
            }
        }
        return out.release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE could not read this solid");
        return nullptr;
    }
}

/// The solid in Open CASCADE's binary format, for the caller to free with lime_model_occt_string_free.
/// Null, and `error` set, when Open CASCADE fails.
char* lime_tree_write_brep(const LimeShape* shape, size_t* size, char** error) {
    try {
        const std::string bytes = write_brep(shape->held.shape);
        char* out = static_cast<char*>(std::malloc(bytes.empty() ? 1 : bytes.size()));
        if (out == nullptr) {
            set_error(error, "Out of memory writing this solid");
            return nullptr;
        }
        std::memcpy(out, bytes.data(), bytes.size());
        *size = bytes.size();
        return out;
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE did not write this solid");
        return nullptr;
    }
}

/// The linked Open CASCADE version, as `lime_model_occt_stats` reports it. Static: never freed.
const char* lime_tree_occt_version() { return OCCT_Version_String_Complete(); }

/// --- 3.1 F9. The step about to be built stops after `budget_ms`; 0 clears the limit.
void lime_tree_set_deadline(long long budget_ms) { set_deadline(budget_ms); }

LimeShape* lime_tree_boolean(const LimeShape* from, const char* op, const char* primitive, const double* p, char** error) {
    try {
        std::string message;
        const std::string which = op == nullptr ? "" : op;
        double volume = 0.0;
        Handle(BRepTools_History) history;
        const TopoDS_Shape result =
            build_boolean(from->held.shape, which, spec_of(primitive, p), volume, message, &history);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The boolean removed the solid", error, from, history).release();
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
        Handle(BRepTools_History) history;
        const TopoDS_Shape result =
            build_join(from->held.shape, tool->held.shape, which, place, volume, message, &history);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The boolean removed the solid", error, from, history).release();
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

/// `p` is the plane's origin and turn, the depth, symmetric (0 or 1), then smooth, the corner count, and the corners.
LimeShape* lime_tree_extrude(const LimeShape* from, const char* op, const double* p, const double* points, int count, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_extrude(
            from->held.shape, from->held.volume, op == nullptr ? "" : op, profile_of(p, points, count, p + 8), p[6], p[7] != 0.0, volume, message);
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

// --- K3. A second depth, a draft angle, or a face to stop at. `p` is the same plane, depth, and symmetric
// a plain extrude reads. `flags` bit 0 is depth2, bit 1 is draft, bit 2 is up to `face` (an index on `from`). ---
LimeShape* lime_tree_extrude_extent(
    const LimeShape* from, const char* op, const double* p, const double* points, int count, double depth2, double draft_deg, int face, int flags, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        ExtrudeExtent extent;
        extent.has_depth2 = (flags & 1) != 0;
        extent.depth2 = depth2;
        extent.has_draft = (flags & 2) != 0;
        extent.draft_deg = draft_deg;
        extent.has_up_to = (flags & 4) != 0;
        if (extent.has_up_to) {
            if (face < 0 || face >= from->held.faces.Extent()) {
                set_error(error, "That face is not on this solid.");
                return nullptr;
            }
            extent.up_to = TopoDS::Face(from->held.faces(face + 1));
        }
        const TopoDS_Shape result = build_extrude_extent(
            from->held.shape,
            from->held.volume,
            op == nullptr ? "" : op,
            profile_of(p, points, count, p + 8),
            p[6],
            p[7] != 0.0,
            extent,
            volume,
            message);
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

/// `p` is the plane's origin and turn, the axis's point (u, v) and direction (u, v), the angle in degrees, then smooth,
/// the corner count, and the corners.
LimeShape* lime_tree_revolve(const LimeShape* from, const char* op, const double* p, const double* points, int count, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_revolve(
            from->held.shape, from->held.volume, op == nullptr ? "" : op, profile_of(p, points, count, p + 11), p + 6, p[10], volume, message);
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

// --- K2 feature root. An extrude, revolve, or loft built against no solid. The tool is the solid. ---

/// `p` is the plane's origin and turn, the depth, symmetric (0 or 1), then smooth, the corner count, and the corners.
LimeShape* lime_tree_feature_extrude(const char* op, const double* p, const double* points, int count, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape none;
        const TopoDS_Shape result = build_extrude(
            none, 0.0, op == nullptr ? "" : op, profile_of(p, points, count, p + 8), p[6], p[7] != 0.0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The extrude did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

// K3 on a feature root. `p` matches lime_tree_feature_extrude. There is no solid, so a face to stop at is not on one.
LimeShape* lime_tree_feature_extrude_extent(
    const char* op, const double* p, const double* points, int count, double depth2, double draft_deg, int flags, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        ExtrudeExtent extent;
        extent.has_depth2 = (flags & 1) != 0;
        extent.depth2 = depth2;
        extent.has_draft = (flags & 2) != 0;
        extent.draft_deg = draft_deg;
        extent.has_up_to = (flags & 4) != 0;
        const TopoDS_Shape none;
        const TopoDS_Shape result = build_extrude_extent(
            none, 0.0, op == nullptr ? "" : op, profile_of(p, points, count, p + 8), p[6], p[7] != 0.0, extent, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The extrude did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is the plane's origin and turn, the axis's point (u, v) and direction (u, v), the angle in degrees, then smooth,
/// the corner count, and the corners.
LimeShape* lime_tree_feature_revolve(const char* op, const double* p, const double* points, int count, char** error) {
    try {
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape none;
        const TopoDS_Shape result = build_revolve(
            none, 0.0, op == nullptr ? "" : op, profile_of(p, points, count, p + 11), p + 6, p[10], volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The revolve did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `head` is 11 numbers a section, as `lime_tree_loft`. `data` is each section's points and corners.
LimeShape* lime_tree_feature_loft(const char* op, const double* head, int count, const double* data, int ruled, char** error) {
    try {
        std::vector<LoftSection> sections;
        size_t at = 0;
        for (int s = 0; s < count; ++s) {
            const double* h = head + 11 * static_cast<size_t>(s);
            const int points = std::max(static_cast<int>(h[9]), 0);
            const int corners = std::max(static_cast<int>(h[10]), 0);
            LoftSection section;
            for (int i = 0; i < 3; ++i) {
                section.profile.origin[i] = h[i];
                section.profile.turn[i] = h[3 + i];
            }
            section.radius = h[6];
            section.radius_v = h[7];
            section.profile.smooth = h[8] != 0.0;
            section.profile.points.assign(data + at, data + at + 2 * static_cast<size_t>(points));
            at += 2 * static_cast<size_t>(points);
            for (int i = 0; i < corners; ++i) {
                section.profile.corners.push_back(static_cast<int>(data[at + static_cast<size_t>(i)]));
            }
            at += static_cast<size_t>(corners);
            sections.push_back(std::move(section));
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape none;
        const TopoDS_Shape result = build_loft(none, 0.0, op == nullptr ? "" : op, sections, ruled != 0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The loft did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

// --- K1 loops on a K2 feature root. Built against no solid. The point-profile feature entry points above stay as they are. ---

/// `p` is the plane's origin and turn, the depth, and symmetric (0 or 1). `loops` is one encode_loops blob.
LimeShape* lime_tree_feature_extrude_loops(const char* op, const double* p, const double* loops, int loops_len, char** error) {
    try {
        std::vector<ProfileLoop> decoded;
        int used = 0;
        std::string message;
        if (!decode_profile_loops(loops, loops_len, decoded, used, message) || used != loops_len) {
            set_error(error, message.empty() ? "A loop is incomplete." : message);
            return nullptr;
        }
        double volume = 0.0;
        const TopoDS_Shape none;
        const double origin[3] = {p[0], p[1], p[2]};
        const double turn[3] = {p[3], p[4], p[5]};
        const TopoDS_Shape result = build_extrude_loops(
            none, 0.0, op == nullptr ? "" : op, origin, turn, decoded, p[6], p[7] != 0.0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The extrude did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `p` is the plane's origin and turn, the axis point (u, v) and direction (u, v), and the angle in degrees.
LimeShape* lime_tree_feature_revolve_loops(const char* op, const double* p, const double* loops, int loops_len, char** error) {
    try {
        std::vector<ProfileLoop> decoded;
        int used = 0;
        std::string message;
        if (!decode_profile_loops(loops, loops_len, decoded, used, message) || used != loops_len) {
            set_error(error, message.empty() ? "A loop is incomplete." : message);
            return nullptr;
        }
        double volume = 0.0;
        const TopoDS_Shape none;
        const double origin[3] = {p[0], p[1], p[2]};
        const double turn[3] = {p[3], p[4], p[5]};
        const TopoDS_Shape result = build_revolve_loops(
            none, 0.0, op == nullptr ? "" : op, origin, turn, decoded, p + 6, p[10], volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The revolve did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// Like `lime_tree_loft_loops`, against no solid. `loop_at[s]` is the blob index, or −1 for a radius or a profile.
LimeShape* lime_tree_feature_loft_loops(
    const char* op,
    const double* head,
    int count,
    const double* data,
    int ruled,
    const int* loop_at,
    const double* loops,
    int loops_len,
    char** error) {
    try {
        std::vector<LoftSection> sections;
        size_t at = 0;
        for (int s = 0; s < count; ++s) {
            const double* h = head + 11 * static_cast<size_t>(s);
            const int points = std::max(static_cast<int>(h[9]), 0);
            const int corners = std::max(static_cast<int>(h[10]), 0);
            LoftSection section;
            for (int i = 0; i < 3; ++i) {
                section.profile.origin[i] = h[i];
                section.profile.turn[i] = h[3 + i];
            }
            section.radius = h[6];
            section.radius_v = h[7];
            section.profile.smooth = h[8] != 0.0;
            if (data != nullptr && points > 0) {
                section.profile.points.assign(data + at, data + at + 2 * static_cast<size_t>(points));
            }
            at += 2 * static_cast<size_t>(points);
            for (int i = 0; i < corners; ++i) {
                section.profile.corners.push_back(static_cast<int>(data[at + static_cast<size_t>(i)]));
            }
            at += static_cast<size_t>(corners);
            if (loop_at != nullptr && loop_at[s] >= 0) {
                const int start = loop_at[s];
                if (start >= loops_len) {
                    set_error(error, "A loop is incomplete.");
                    return nullptr;
                }
                int used = 0;
                std::string message;
                if (!decode_profile_loops(loops + start, loops_len - start, section.loops, used, message)) {
                    set_error(error, message.empty() ? "A loop is incomplete." : message);
                    return nullptr;
                }
            }
            sections.push_back(std::move(section));
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape none;
        const TopoDS_Shape result = build_loft_loops(none, 0.0, op == nullptr ? "" : op, sections, ruled != 0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The loft did not make a solid", error, nullptr).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `head` is 11 numbers a section: the plane's origin and turn, the radius, the radius along V, smooth, the point
/// count, and the corner count. `data` is each section's u, v pairs and then its corners, one section after another.
LimeShape* lime_tree_loft(const LimeShape* from, const char* op, const double* head, int count, const double* data, int ruled, char** error) {
    try {
        std::vector<LoftSection> sections;
        size_t at = 0;
        for (int s = 0; s < count; ++s) {
            const double* h = head + 11 * static_cast<size_t>(s);
            const int points = std::max(static_cast<int>(h[9]), 0);
            const int corners = std::max(static_cast<int>(h[10]), 0);
            LoftSection section;
            for (int i = 0; i < 3; ++i) {
                section.profile.origin[i] = h[i];
                section.profile.turn[i] = h[3 + i];
            }
            section.radius = h[6];
            section.radius_v = h[7];
            section.profile.smooth = h[8] != 0.0;
            section.profile.points.assign(data + at, data + at + 2 * static_cast<size_t>(points));
            at += 2 * static_cast<size_t>(points);
            for (int i = 0; i < corners; ++i) {
                section.profile.corners.push_back(static_cast<int>(data[at + static_cast<size_t>(i)]));
            }
            at += static_cast<size_t>(corners);
            sections.push_back(std::move(section));
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_loft(from->held.shape, from->held.volume, op == nullptr ? "" : op, sections, ruled != 0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The loft removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

// --- K1 profile v2. The point-list entry points above are unchanged. ---

/// `p` is the plane's origin and turn, the depth, and symmetric (0 or 1). `loops` is one encode_loops blob.
LimeShape* lime_tree_extrude_loops(const LimeShape* from, const char* op, const double* p, const double* loops, int loops_len, char** error) {
    try {
        std::vector<ProfileLoop> decoded;
        int used = 0;
        std::string message;
        if (!decode_profile_loops(loops, loops_len, decoded, used, message) || used != loops_len) {
            set_error(error, message.empty() ? "A loop is incomplete." : message);
            return nullptr;
        }
        double volume = 0.0;
        const double origin[3] = {p[0], p[1], p[2]};
        const double turn[3] = {p[3], p[4], p[5]};
        const TopoDS_Shape result = build_extrude_loops(
            from->held.shape, from->held.volume, op == nullptr ? "" : op, origin, turn, decoded, p[6], p[7] != 0.0, volume, message);
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

/// `p` is the plane's origin and turn, the axis point (u, v) and direction (u, v), and the angle in degrees.
LimeShape* lime_tree_revolve_loops(const LimeShape* from, const char* op, const double* p, const double* loops, int loops_len, char** error) {
    try {
        std::vector<ProfileLoop> decoded;
        int used = 0;
        std::string message;
        if (!decode_profile_loops(loops, loops_len, decoded, used, message) || used != loops_len) {
            set_error(error, message.empty() ? "A loop is incomplete." : message);
            return nullptr;
        }
        double volume = 0.0;
        const double origin[3] = {p[0], p[1], p[2]};
        const double turn[3] = {p[3], p[4], p[5]};
        const TopoDS_Shape result = build_revolve_loops(
            from->held.shape, from->held.volume, op == nullptr ? "" : op, origin, turn, decoded, p + 6, p[10], volume, message);
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

/// Like `lime_tree_loft`. `loop_at[s]` is the index in `loops` where section s's blob starts, or −1 when that section
/// uses a radius or a profile. Each blob is one encode_loops value.
LimeShape* lime_tree_loft_loops(
    const LimeShape* from,
    const char* op,
    const double* head,
    int count,
    const double* data,
    int ruled,
    const int* loop_at,
    const double* loops,
    int loops_len,
    char** error) {
    try {
        std::vector<LoftSection> sections;
        size_t at = 0;
        for (int s = 0; s < count; ++s) {
            const double* h = head + 11 * static_cast<size_t>(s);
            const int points = std::max(static_cast<int>(h[9]), 0);
            const int corners = std::max(static_cast<int>(h[10]), 0);
            LoftSection section;
            for (int i = 0; i < 3; ++i) {
                section.profile.origin[i] = h[i];
                section.profile.turn[i] = h[3 + i];
            }
            section.radius = h[6];
            section.radius_v = h[7];
            section.profile.smooth = h[8] != 0.0;
            if (data != nullptr && points > 0) {
                section.profile.points.assign(data + at, data + at + 2 * static_cast<size_t>(points));
            }
            at += 2 * static_cast<size_t>(points);
            for (int i = 0; i < corners; ++i) {
                section.profile.corners.push_back(static_cast<int>(data[at + static_cast<size_t>(i)]));
            }
            at += static_cast<size_t>(corners);
            if (loop_at != nullptr && loop_at[s] >= 0) {
                const int start = loop_at[s];
                if (start >= loops_len) {
                    set_error(error, "A loop is incomplete.");
                    return nullptr;
                }
                int used = 0;
                std::string message;
                if (!decode_profile_loops(loops + start, loops_len - start, section.loops, used, message)) {
                    set_error(error, message.empty() ? "A loop is incomplete." : message);
                    return nullptr;
                }
            }
            sections.push_back(std::move(section));
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result =
            build_loft_loops(from->held.shape, from->held.volume, op == nullptr ? "" : op, sections, ruled != 0, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "The loft removed the solid", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `piece_report` of the two shapes, for the caller to free. Null when there is nothing to report.
char* lime_tree_pieces(const LimeShape* from, const LimeShape* built) {
    try {
        const std::string text = piece_report(from->held.shape, built->held.shape);
        return text.empty() ? nullptr : alloc(text);
    } catch (...) {
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

/// --- A10 face provenance. Each face's parent face, or -1 when this step made it. Read through `out` while the shape lives.
int lime_tree_face_from(const LimeShape* shape, const int** out) {
    *out = shape->from_face.data();
    return static_cast<int>(shape->from_face.size());
}

/// Replace `from_face`. A group composes lineage across its internal steps so the vector indexes the solid the group started from.
void lime_tree_set_face_from(LimeShape* shape, const int* indexes, int count) {
    if (indexes == nullptr || count < 0) {
        shape->from_face.clear();
        return;
    }
    shape->from_face.assign(indexes, indexes + count);
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

// --- K4: faceExtrude, moveFaces, faceLoops. Keep this block together. ---

/// `up_to` below 0 is no stop face. Every index is a face of `from`; the Rust side resolves picks first.
LimeShape* lime_tree_face_extrude(
    const LimeShape* from,
    int face,
    double distance,
    double draft_deg,
    int up_to,
    char** error) {
    try {
        if (face < 0 || face >= from->held.faces.Extent()) {
            set_error(error, "That face is not on this solid.");
            return nullptr;
        }
        const TopoDS_Face picked = TopoDS::Face(from->held.faces(face + 1));
        TopoDS_Face until_face;
        const TopoDS_Face* until = nullptr;
        if (up_to >= 0) {
            if (up_to >= from->held.faces.Extent()) {
                set_error(error, "That face is not on this solid.");
                return nullptr;
            }
            until_face = TopoDS::Face(from->held.faces(up_to + 1));
            until = &until_face;
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_face_extrude(
            from->held.shape, from->held.volume, picked, distance, draft_deg, until, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "Open CASCADE could not extrude this face.", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// `indexes` and `distances` are `count` faces of `from` and how far each moves along its outward normal.
LimeShape* lime_tree_move_faces(
    const LimeShape* from,
    const int* indexes,
    const double* distances,
    int count,
    char** error) {
    try {
        std::vector<FaceOffset> rows;
        rows.reserve(static_cast<size_t>(std::max(count, 0)));
        for (int i = 0; i < count; ++i) {
            if (indexes[i] < 0 || indexes[i] >= from->held.faces.Extent()) {
                set_error(error, "That face is not on this solid.");
                return nullptr;
            }
            FaceOffset row;
            row.face = TopoDS::Face(from->held.faces(indexes[i] + 1));
            row.distance = distances[i];
            rows.push_back(row);
        }
        std::string message;
        double volume = 0.0;
        const TopoDS_Shape result = build_move_faces(from->held.shape, from->held.volume, rows, volume, message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return adopt(result, volume, "This face cannot move with its neighbours here. Push or pull adds material instead: hold Alt.", error, from).release();
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
    }
}

/// The face's outline in its plane, as JSON `{origin, turn, loops}`, for the caller to free.
char* lime_tree_face_loops(const LimeShape* shape, int face, char** error) {
    try {
        if (face < 0 || face >= shape->held.faces.Extent()) {
            set_error(error, "That face is not on this solid.");
            return nullptr;
        }
        std::string message;
        const std::string text = face_loops_json(TopoDS::Face(shape->held.faces(face + 1)), message);
        if (!message.empty()) {
            set_error(error, message);
            return nullptr;
        }
        return alloc(text);
    } catch (const Standard_Failure& failure) {
        set_failure(error, failure);
        return nullptr;
    } catch (...) {
        set_error(error, "Open CASCADE failed");
        return nullptr;
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
