// Open CASCADE operations shared by the one-solid session (session.cpp) and the history tree (tree.cpp).
// This file is Lime Slice (MIT). It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#pragma once

#include <string>
#include <vector>

#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Shape.hxx>

namespace lime_occt {

/// A solid with its faces and edges numbered once. Every index in a reply is into these maps.
struct Held {
    TopoDS_Shape shape;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
};

char* alloc(const std::string& text);
std::string escape(const std::string& text);
void route_occt_log();

Held hold_of(const TopoDS_Shape& shape);
TopoDS_Shape as_solid(const TopoDS_Shape& shape);
bool has_solid(const TopoDS_Shape& shape);
double volume_of(const TopoDS_Shape& shape);
std::string tessellate(int id, const Held& held, double chord);
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
    std::string& error);
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
    std::string& error);
bool blend_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    double size,
    bool chamfer,
    TopoDS_Shape& built,
    std::string& error);
double largest_blend(const TopoDS_Shape& current, const std::vector<TopoDS_Edge>& edges, double hi, bool chamfer);
/// `kept` is the negative side of the plane, `other` the positive side. Both are solids on success.
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
    std::string& error);
TopoDS_Shape build_scale(const TopoDS_Shape& current, double factor, std::string& error);

}  // namespace lime_occt
