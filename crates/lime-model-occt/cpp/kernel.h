// Open CASCADE operations (kernel.cpp) that the history tree (tree.cpp) builds its nodes with.
// This file is Lime Slice (MIT). It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Shape.hxx>

namespace lime_occt {

/// One shape with what was computed from it once. A shape never changes, so its volume, its face
/// and edge numbering, and its description stay valid for as long as a tree node holds it.
struct Held {
    TopoDS_Shape shape;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
    double volume = 0;
    /// The chord the faces were last meshed at. A reply at that chord meshes nothing again.
    double meshed = 0;
    /// `describe`'s JSON, written by the first reply.
    std::string about;
};

/// One tessellation as the reply sends it, as binary arrays.
struct Mesh {
    /// Nine per triangle: the corners of a triangle soup, wound outward.
    std::vector<float> positions;
    /// The face index of each triangle.
    std::vector<uint32_t> triangles;
    /// Every edge's polyline, one after another, three per point.
    std::vector<float> edge_points;
    /// Edge `i` is points `edge_offsets[i]` up to `edge_offsets[i + 1]`.
    std::vector<uint32_t> edge_offsets;
};

char* alloc(const std::string& text);
void route_occt_log();

Held hold_of(const TopoDS_Shape& shape, double volume);
TopoDS_Shape as_solid(const TopoDS_Shape& shape);
bool has_solid(const TopoDS_Shape& shape);
/// False, with the refusal every edit answers, for a shape of surfaces with no closed solid.
bool editable(const TopoDS_Shape& shape, std::string& error);
double volume_of(const TopoDS_Shape& shape);
/// Mesh the faces unless they are meshed at this chord already, and read the mesh out.
Mesh tessellate(Held& held, double chord);
/// What a reply says of the shape whatever the chord, as a JSON object: `volumeMm3`, `solid`,
/// `faces` (area and outward normal), and `edgeLengths`.
std::string describe(const Held& held);
bool measure_distance(
    const Held& held,
    const char* a_kind,
    int a_index,
    const char* b_kind,
    int b_index,
    double& out,
    std::string& error);

TopoDS_Shape read_step(const char* path, std::string& error);
bool write_step(const TopoDS_Shape& shape, const char* path, std::string& error);

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
    double& volume,
    std::string& error);
/// `before` is the volume of `current`; `volume` gets the result's.
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
    std::string& error);
bool blend_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    double size,
    bool chamfer,
    TopoDS_Shape& built,
    double& volume,
    std::string& error);
double largest_blend(const TopoDS_Shape& current, const std::vector<TopoDS_Edge>& edges, double hi, bool chamfer);
/// `kept` is the negative side of the plane, `other` the positive side. Both are solids on success,
/// and each volume is integrated once, while the pieces are sorted.
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
    double& kept_volume,
    double& other_volume,
    std::string& error);
/// A uniform scale about the centre. The result's volume is the original's times `factor` cubed.
TopoDS_Shape build_scale(const TopoDS_Shape& current, double factor, std::string& error);

}  // namespace lime_occt
