// Lettering on a flat face (docs/plan-text-on-curves-and-fonts.md, milestone 1). This file is Lime Slice (MIT).
// It calls the LGPL library; the notice is third_party/occt/NOTICE.md.
//
// The glyph outlines arrive laid out in millimetres on a plane (src/text). Two ways to turn them into raised or cut letters:
//
//  - Direct build, with no boolean. The face the text lies on gets each letter's outline as a hole, each counter (the inside
//    of an O) becomes a face of its own, every outline edge gets a wall (ruled from the edge on the face to the same curve
//    one depth off it), and the top (or the floor of a cut) is the loop on that plane. Those new faces are sewn among
//    themselves and put in the place of the old face. Every other face of the part is the same face as before.
//  - Boolean build, as the fallback: every letter a prism, all of them meeting the part in one boolean.
//
// The direct build needs the text wholly inside one face and clear of its edges, and for a cut, material under every
// letter. Otherwise the boolean build runs, or the text is refused with a sentence.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepGProp_Face.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepFill.hxx>
#include <BRepLib.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BOPTools_AlgoTools3D.hxx>
#include <ElSLib.hxx>
#include <GCE2d_MakeSegment.hxx>
#include <Geom2d_BezierCurve.hxx>
#include <Geom_ConicalSurface.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_OffsetSurface.hxx>
#include <Geom_Plane.hxx>
#include <Geom_SphericalSurface.hxx>
#include <Geom_ToroidalSurface.hxx>
#include <IntCurvesFace_ShapeIntersector.hxx>
#include <IntTools_Context.hxx>
#include <ShapeFix_Face.hxx>
#include <Standard_Failure.hxx>
#include <TColgp_Array1OfPnt2d.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Cone.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Sphere.hxx>
#include <gp_Torus.hxx>
#include <gp_Trsf.hxx>

#include "kernel.h"

namespace lime_occt {

/// The face a text is on when it is a sphere, a torus or a freeform face, held while the text is laid out so Rust can ask the surface for
/// points (`skin_d1`) (milestone 3).
struct SkinHandle {
    TopoDS_Face face;
    Handle(Geom_Surface) surface;
    GeomAbs_SurfaceType type = GeomAbs_OtherSurface;
    double u0 = 0.0;
    double v0 = 0.0;
    double umin = 0.0;
    double umax = 0.0;
    double vmin = 0.0;
    double vmax = 0.0;
    double sigma = 1.0;
    double distance = 0.0;
    /// 0 when the surface is not periodic that way.
    double u_period = 0.0;
    double v_period = 0.0;
    bool full_u = false;
    bool full_v = false;
    /// The surface's own parameter box.
    double bu1 = 0.0;
    double bu2 = 0.0;
    double bv1 = 0.0;
    double bv2 = 0.0;

    /// The point and Su, Sv at (u, v); false outside a non-periodic surface's box.
    bool d1(double u, double v, gp_Pnt& p, gp_Vec& su, gp_Vec& sv) const {
        const double slack = 1e-9;
        if (u_period <= 0.0 && (u < bu1 - slack || u > bu2 + slack)) {
            return false;
        }
        if (v_period <= 0.0 && (v < bv1 - slack || v > bv2 + slack)) {
            return false;
        }
        surface->D1(u_period > 0.0 ? u : std::min(std::max(u, bu1), bu2), v_period > 0.0 ? v : std::min(std::max(v, bv1), bv2), p, su, sv);
        return true;
    }

    gp_Dir outward(double u, double v) const {
        gp_Pnt p;
        gp_Vec su;
        gp_Vec sv;
        if (!d1(u, v, p, su, sv)) {
            throw Standard_Failure("The text runs off this face.");
        }
        gp_Vec n = su.Crossed(sv);
        if (sigma < 0.0) {
            n.Reverse();
        }
        return gp_Dir(n);
    }
};

namespace {

constexpr double kPi = 3.14159265358979323846;

// TEMP-TRACE
inline void trace(const char* what) {
    static auto last = std::chrono::steady_clock::now();
    const auto now = std::chrono::steady_clock::now();
    std::fprintf(stderr, "TRACE %-28s %8.3f s\n", what, std::chrono::duration<double>(now - last).count());
    last = now;
}
// END-TEMP

/// The glyph's character as the sentence shows it.
std::string utf8(unsigned code) {
    std::string out;
    if (code < 0x80) {
        out += static_cast<char>(code);
    } else if (code < 0x800) {
        out += static_cast<char>(0xC0 | (code >> 6));
        out += static_cast<char>(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
        out += static_cast<char>(0xE0 | (code >> 12));
        out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (code & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (code >> 18));
        out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (code & 0x3F));
    }
    return out;
}

struct Frame {
    gp_Pnt origin;
    gp_Dir u;
    gp_Dir v;
    gp_Dir w;
};

/// The plane an op is typed on: its turn about X, then Y, then Z, whose columns are U, V and W (as a profile's plane is).
Frame frame_from_turn(const double origin[3], const double turn[3]) {
    const double rad = kPi / 180.0;
    gp_Trsf tx;
    gp_Trsf ty;
    gp_Trsf tz;
    tx.SetRotation(gp::OX(), turn[0] * rad);
    ty.SetRotation(gp::OY(), turn[1] * rad);
    tz.SetRotation(gp::OZ(), turn[2] * rad);
    gp_Trsf total = tz;
    total.Multiply(ty);
    total.Multiply(tx);
    Frame frame;
    frame.origin = gp_Pnt(origin[0], origin[1], origin[2]);
    frame.u = gp::DX().Transformed(total);
    frame.v = gp::DY().Transformed(total);
    frame.w = gp::DZ().Transformed(total);
    return frame;
}

enum class SegKind { Line = 1, Quad = 2, Cubic = 3 };

struct Seg {
    SegKind kind;
    double p[6];
};

struct LoopIn {
    double start[2];
    std::vector<Seg> segs;
};

struct GlyphIn {
    unsigned code = 0;
    std::vector<LoopIn> loops;
};

/// The blob `text::encode` writes. False, with a sentence, when it is cut short.
bool decode(const double* d, int len, std::vector<GlyphIn>& out, std::string& error) {
    int at = 0;
    const auto have = [&](int n) { return at + n <= len; };
    if (!have(1)) {
        error = "The text has no letters.";
        return false;
    }
    const int faces = static_cast<int>(d[at++]);
    for (int f = 0; f < faces; ++f) {
        if (!have(2)) {
            error = "The text's letters are incomplete.";
            return false;
        }
        GlyphIn glyph;
        glyph.code = static_cast<unsigned>(d[at++]);
        const int loops = static_cast<int>(d[at++]);
        for (int l = 0; l < loops; ++l) {
            if (!have(3)) {
                error = "The text's letters are incomplete.";
                return false;
            }
            LoopIn loop;
            loop.start[0] = d[at++];
            loop.start[1] = d[at++];
            const int segs = static_cast<int>(d[at++]);
            for (int s = 0; s < segs; ++s) {
                if (!have(1)) {
                    error = "The text's letters are incomplete.";
                    return false;
                }
                const int kind = static_cast<int>(d[at++]);
                if (kind < 1 || kind > 3 || !have(2 * kind)) {
                    error = "The text's letters are incomplete.";
                    return false;
                }
                Seg seg{static_cast<SegKind>(kind), {0, 0, 0, 0, 0, 0}};
                for (int k = 0; k < 2 * kind; ++k) {
                    seg.p[k] = d[at++];
                }
                loop.segs.push_back(seg);
            }
            glyph.loops.push_back(std::move(loop));
        }
        out.push_back(std::move(glyph));
    }
    return true;
}

TopoDS_Edge edge_on(const Handle(Geom2d_Curve)& curve, const Handle(Geom_Surface)& surface) {
    BRepBuilderAPI_MakeEdge make(curve, surface);
    if (!make.IsDone()) {
        throw Standard_Failure("The text's outline did not become an edge.");
    }
    TopoDS_Edge edge = make.Edge();
    BRepLib::BuildCurves3d(edge, 1e-5, GeomAbs_C1, 14, 200);
    return edge;
}

/// One letter as a face on the plane: its outer loop, then its holes.
TopoDS_Face glyph_face(const GlyphIn& glyph, const Handle(Geom_Surface)& plane) {
    std::vector<TopoDS_Wire> wires;
    for (const LoopIn& loop : glyph.loops) {
        BRepBuilderAPI_MakeWire wire;
        gp_Pnt2d at(loop.start[0], loop.start[1]);
        for (const Seg& seg : loop.segs) {
            Handle(Geom2d_Curve) curve;
            gp_Pnt2d to;
            if (seg.kind == SegKind::Line) {
                to = gp_Pnt2d(seg.p[0], seg.p[1]);
                if (at.Distance(to) < 1e-9) {
                    continue;
                }
                curve = GCE2d_MakeSegment(at, to).Value();
            } else if (seg.kind == SegKind::Quad) {
                TColgp_Array1OfPnt2d poles(1, 3);
                poles(1) = at;
                poles(2) = gp_Pnt2d(seg.p[0], seg.p[1]);
                to = gp_Pnt2d(seg.p[2], seg.p[3]);
                poles(3) = to;
                curve = new Geom2d_BezierCurve(poles);
            } else {
                TColgp_Array1OfPnt2d poles(1, 4);
                poles(1) = at;
                poles(2) = gp_Pnt2d(seg.p[0], seg.p[1]);
                poles(3) = gp_Pnt2d(seg.p[2], seg.p[3]);
                to = gp_Pnt2d(seg.p[4], seg.p[5]);
                poles(4) = to;
                curve = new Geom2d_BezierCurve(poles);
            }
            wire.Add(edge_on(curve, plane));
            if (!wire.IsDone()) {
                throw Standard_Failure("The text's outline did not close.");
            }
            at = to;
        }
        wires.push_back(wire.Wire());
    }
    if (wires.empty()) {
        throw Standard_Failure("A letter has no outline.");
    }
    BRepBuilderAPI_MakeFace face(plane, wires[0], Standard_True);
    for (size_t k = 1; k < wires.size(); ++k) {
        face.Add(wires[k]);
    }
    if (!face.IsDone()) {
        throw Standard_Failure("A letter did not become a face.");
    }
    ShapeFix_Face fix(face.Face());
    fix.Perform();
    return fix.Face();
}

/// The coplanar face of `current` that holds `origin`, facing along `w`: the face the text is on. Null with none.
TopoDS_Face face_under(const TopoDS_Shape& current, const Frame& frame) {
    for (TopExp_Explorer it(current, TopAbs_FACE); it.More(); it.Next()) {
        const TopoDS_Face face = TopoDS::Face(it.Current());
        BRepAdaptor_Surface surface(face);
        if (surface.GetType() != GeomAbs_Plane) {
            continue;
        }
        const gp_Pln plane = surface.Plane();
        gp_Dir normal = plane.Axis().Direction();
        if (face.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        if (normal.Dot(frame.w) < 1.0 - 1e-9) {
            continue;
        }
        if (std::abs(gp_Vec(plane.Location(), frame.origin).Dot(gp_Vec(frame.w))) > 1e-6) {
            continue;
        }
        BRepClass_FaceClassifier classify(face, frame.origin, 1e-6);
        if (classify.State() == TopAbs_IN || classify.State() == TopAbs_ON) {
            return face;
        }
    }
    return TopoDS_Face();
}

/// Points along every loop of every glyph, for the in-face and the material checks.
std::vector<gp_Pnt> outline_points(const std::vector<GlyphIn>& glyphs, const Frame& frame) {
    std::vector<gp_Pnt> out;
    const auto at = [&](double x, double y) {
        return frame.origin.Translated(gp_Vec(frame.u) * x + gp_Vec(frame.v) * y);
    };
    for (const GlyphIn& glyph : glyphs) {
        for (const LoopIn& loop : glyph.loops) {
            out.push_back(at(loop.start[0], loop.start[1]));
            for (const Seg& seg : loop.segs) {
                const int n = static_cast<int>(seg.kind);
                out.push_back(at(seg.p[2 * n - 2], seg.p[2 * n - 1]));
            }
        }
    }
    return out;
}

/// How far from `from` along `dir` the part's surface is, with the ray starting `nudge` off the plane. A large number when
/// the ray meets nothing.
double reach(const TopoDS_Shape& current, const gp_Pnt& from, const gp_Dir& dir) {
    IntCurvesFace_ShapeIntersector hit;
    hit.Load(current, 1e-7);
    hit.PerformNearest(gp_Lin(from.Translated(gp_Vec(dir) * 1e-3), dir), 0.0, 1e6);
    if (hit.NbPnt() < 1) {
        return 1e9;
    }
    return hit.WParameter(1) + 1e-3;
}

/// The part with `face` taken out and `fresh` put in its place, every other face the same face as before.
TopoDS_Shape splice(const TopoDS_Shape& current, const TopoDS_Face& face, const std::vector<TopoDS_Face>& fresh) {
    BRep_Builder builder;
    for (TopExp_Explorer solids(current, TopAbs_SOLID); solids.More(); solids.Next()) {
        const TopoDS_Solid old = TopoDS::Solid(solids.Current());
        bool holds = false;
        for (TopExp_Explorer faces(old, TopAbs_FACE); faces.More(); faces.Next()) {
            if (faces.Current().IsSame(face)) {
                holds = true;
                break;
            }
        }
        if (!holds) {
            continue;
        }
        TopoDS_Solid solid;
        builder.MakeSolid(solid);
        for (TopoDS_Iterator shells(old); shells.More(); shells.Next()) {
            if (shells.Value().ShapeType() != TopAbs_SHELL) {
                builder.Add(solid, shells.Value());
                continue;
            }
            bool here = false;
            for (TopoDS_Iterator faces(shells.Value()); faces.More(); faces.Next()) {
                if (faces.Value().IsSame(face)) {
                    here = true;
                    break;
                }
            }
            if (!here) {
                builder.Add(solid, shells.Value());
                continue;
            }
            TopoDS_Shell shell;
            builder.MakeShell(shell);
            for (TopoDS_Iterator faces(shells.Value()); faces.More(); faces.Next()) {
                if (!faces.Value().IsSame(face)) {
                    builder.Add(shell, faces.Value());
                }
            }
            for (const TopoDS_Face& one : fresh) {
                builder.Add(shell, one);
            }
            shell.Closed(Standard_True);
            builder.Add(solid, shell);
        }
        if (current.ShapeType() == TopAbs_SOLID) {
            return solid;
        }
        TopoDS_Compound whole;
        builder.MakeCompound(whole);
        for (TopExp_Explorer other(current, TopAbs_SOLID); other.More(); other.Next()) {
            builder.Add(whole, other.Current().IsSame(old) ? static_cast<TopoDS_Shape>(solid) : other.Current());
        }
        return whole;
    }
    return TopoDS_Shape();
}

/// Whether every edge of `shape` lies on exactly two faces (a seam's two sides count as two).
bool closed_shape(const TopoDS_Shape& shape) {
    TopTools_IndexedDataMapOfShapeListOfShape edges;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edges);
    for (int i = 1; i <= edges.Extent(); ++i) {
        if (BRep_Tool::Degenerated(TopoDS::Edge(edges.FindKey(i)))) {
            continue;
        }
        if (edges.FindFromIndex(i).Extent() != 2) {
            return false;
        }
    }
    return true;
}

/// A letter's walls and its top: every outline edge of `glyph` (on its surface) gets a wall, ruled to the same (u, v) curve on
/// `top`, and the loops on `top` close in a cap. Everything goes into `sewing`.
void add_walls_and_cap(const TopoDS_Face& glyph, const Handle(Geom_Surface)& top, BRepBuilderAPI_Sewing& sewing) {
    std::vector<TopoDS_Wire> tops;
    for (TopExp_Explorer w(glyph, TopAbs_WIRE); w.More(); w.Next()) {
        BRepBuilderAPI_MakeWire top_wire;
        for (BRepTools_WireExplorer we(TopoDS::Wire(w.Current()), glyph); we.More(); we.Next()) {
            const TopoDS_Edge edge = we.Current();
            double first = 0.0;
            double last = 0.0;
            const Handle(Geom2d_Curve) curve = BRep_Tool::CurveOnSurface(edge, glyph, first, last);
            TopoDS_Edge up = BRepBuilderAPI_MakeEdge(curve, top, first, last).Edge();
            BRepLib::BuildCurves3d(up, 1e-5, GeomAbs_C1, 14, 200);
            up.Orientation(edge.Orientation());
            top_wire.Add(up);
            TopoDS_Edge below = edge;
            TopoDS_Edge above = up;
            below.Orientation(TopAbs_FORWARD);
            above.Orientation(TopAbs_FORWARD);
            sewing.Add(BRepFill::Face(below, above));
        }
        tops.push_back(top_wire.Wire());
    }
    BRepBuilderAPI_MakeFace cap(top, tops[0], Standard_True);
    for (size_t k = 1; k < tops.size(); ++k) {
        cap.Add(tops[k]);
    }
    ShapeFix_Face fix_cap(cap.Face());
    fix_cap.Perform();
    sewing.Add(fix_cap.Face());
}

/// The direct build. Null shape, with `why` set, when the text does not suit it.
TopoDS_Shape build_direct(
    const TopoDS_Shape& current,
    const TopoDS_Face& target,
    const std::vector<TopoDS_Face>& glyph_faces,
    const Handle(Geom_Surface)& plane,
    const Handle(Geom_Surface)& top,
    const std::function<bool(const TopoDS_Face&)>& looks_wrong,
    Handle(BRepTools_History)& history,
    std::string& why) {
    BRepBuilderAPI_Sewing sewing(1e-4);
    // The face the text is on keeps every letter's outer loop as a hole; each counter is a face of its own.
    const TopoDS_Face base = TopoDS::Face(target.Oriented(TopAbs_FORWARD));
    BRepBuilderAPI_MakeFace rest(base);
    std::vector<TopoDS_Face> counters;
    for (const TopoDS_Face& glyph : glyph_faces) {
        const TopoDS_Wire outer = BRepTools::OuterWire(glyph);
        rest.Add(TopoDS::Wire(outer.Reversed()));
        for (TopExp_Explorer w(glyph, TopAbs_WIRE); w.More(); w.Next()) {
            const TopoDS_Wire hole = TopoDS::Wire(w.Current());
            if (hole.IsSame(outer)) {
                continue;
            }
            BRepBuilderAPI_MakeFace counter(plane, TopoDS::Wire(hole.Reversed()), Standard_True);
            ShapeFix_Face fix(counter.Face());
            fix.Perform();
            counters.push_back(fix.Face());
        }
    }
    trace("counters+rest built");
    ShapeFix_Face fix_rest(rest.Face());
    fix_rest.Perform();
    TopoDS_Face rest_face = fix_rest.Face();
    if (target.Orientation() == TopAbs_REVERSED) {
        rest_face.Reverse();
    }
    sewing.Add(rest_face);
    for (const TopoDS_Face& counter : counters) {
        sewing.Add(counter);
    }
    for (const TopoDS_Face& glyph : glyph_faces) {
        add_walls_and_cap(glyph, top, sewing);
    }
    trace("walls+caps added");
    sewing.Perform();
    trace("sewing");
    TopoDS_Shape sewn = sewing.SewedShape();
    std::vector<TopoDS_Face> fresh;
    for (TopExp_Explorer f(sewn, TopAbs_FACE); f.More(); f.Next()) {
        fresh.push_back(TopoDS::Face(f.Current()));
    }
    // The sewn faces face the way the first one did. The part's face looks along W, so the one standing in its place must.
    TopoDS_Shape rest_sewn = sewing.IsModified(rest_face) ? sewing.Modified(rest_face) : static_cast<TopoDS_Shape>(rest_face);
    for (TopExp_Explorer f(rest_sewn, TopAbs_FACE); f.More(); f.Next()) {
        if (looks_wrong(TopoDS::Face(f.Current()))) {
            for (TopoDS_Face& other : fresh) {
                other.Reverse();
            }
        }
        break;
    }
    const TopoDS_Shape spliced = splice(current, target, fresh);
    if (spliced.IsNull()) {
        why = "The face the text is on is not part of the solid.";
        return TopoDS_Shape();
    }
    trace("spliced");
    if (!closed_shape(spliced)) {
        why = "The letters did not sew onto the face.";
        return TopoDS_Shape();
    }
    TopoDS_Shape result = spliced;
    if (result.ShapeType() == TopAbs_SOLID) {
        TopoDS_Solid solid = TopoDS::Solid(result);
        BRepLib::OrientClosedSolid(solid);
        result = solid;
    }
    trace("orient");
    if (!BRepCheck_Analyzer(result).IsValid()) {
        why = "The letters did not make a valid solid.";
        return TopoDS_Shape();
    }
    history = new BRepTools_History();
    history->AddModified(target, rest_sewn);
    return result;
}

/// The boolean build: a prism for every letter, all of them one boolean with the part. Each prism starts a little inside the
/// part (a raise) or past its face (a cut) so the letters meet it cleanly.
TopoDS_Shape build_boolean(
    const TopoDS_Shape& current,
    double before,
    const std::vector<TopoDS_Face>& glyph_faces,
    const Frame& frame,
    bool cut,
    double depth,
    double& volume,
    std::string& error) {
    const double sink = 0.2;
    gp_Trsf start;
    start.SetTranslation(gp_Vec(frame.w) * (cut ? sink : -sink));
    std::vector<TopoDS_Shape> tools;
    for (const TopoDS_Face& glyph : glyph_faces) {
        const TopoDS_Shape moved = glyph.Moved(TopLoc_Location(start));
        BRepPrimAPI_MakePrism prism(moved, gp_Vec(frame.w) * (cut ? -(depth + sink) : (depth + sink)));
        if (!prism.IsDone()) {
            error = "Open CASCADE did not build a letter.";
            return TopoDS_Shape();
        }
        tools.push_back(prism.Shape());
    }
    return combine_profile_tools(current, before, cut ? "cut" : "fuse", tools, "text", volume, error);
}

// --- Lettering on a cylinder or a cone (milestone 2). The loops arrive already mapped into the surface's (u, v) (src/text/wrap.rs),
// so every letter is a face on the surface itself; its top (or the floor of a cut) is the same (u, v) loop on the surface moved
// the depth along the normal. Depth is constant, square to the surface, by construction.

/// The round face under the anchor, with the surface it lies on.
struct Curved {
    TopoDS_Face face;
    GeomAbs_SurfaceType type = GeomAbs_Cylinder;
    gp_Cylinder cylinder;
    gp_Cone cone;
    gp_Ax3 pos;
    double radius = 0.0;
    double semi = 0.0;
    double u0 = 0.0;
    double v0 = 0.0;
    double umin = 0.0;
    double umax = 0.0;
    double vmin = 0.0;
    double vmax = 0.0;
    bool full_ring = false;
    double sigma = 1.0;
    double distance = 0.0;
    Handle(Geom_Surface) surface;

    /// The point and Su, Sv at (u, v).
    void d1(double u, double v, gp_Pnt& p, gp_Vec& su, gp_Vec& sv) const {
        if (type == GeomAbs_Cone) {
            ElSLib::ConeD1(u, v, pos, radius, semi, p, su, sv);
        } else {
            ElSLib::CylinderD1(u, v, pos, radius, p, su, sv);
        }
    }

    /// The face's outward normal at (u, v), unit.
    gp_Dir outward(double u, double v) const {
        gp_Pnt p;
        gp_Vec su;
        gp_Vec sv;
        d1(u, v, p, su, sv);
        gp_Vec n = su.Crossed(sv);
        if (sigma < 0.0) {
            n.Reverse();
        }
        return gp_Dir(n);
    }

    /// (u, v) of the point of the surface nearest `p`.
    void parameters(const gp_Pnt& p, double& u, double& v) const {
        if (type == GeomAbs_Cone) {
            ElSLib::Parameters(cone, p, u, v);
        } else {
            ElSLib::Parameters(cylinder, p, u, v);
        }
    }
};

const char* surface_name(GeomAbs_SurfaceType type) {
    switch (type) {
        case GeomAbs_Plane: return "plane";
        case GeomAbs_Cylinder: return "cylinder";
        case GeomAbs_Cone: return "cone";
        case GeomAbs_Sphere: return "sphere";
        case GeomAbs_Torus: return "torus";
        default: return "freeform";
    }
}

/// Which face of `shape` the point is on: 1 a flat one (within a micron), 2 a cylinder or a cone within `tol` (`out` filled),
/// 3 a face of another kind (named in `what`), 0 none.
int find_face(const TopoDS_Shape& shape, const gp_Pnt& p, double tol, Curved& out, std::string& what) {
    double best = 1e30;
    double best_other = 1e30;
    for (TopExp_Explorer it(shape, TopAbs_FACE); it.More(); it.Next()) {
        const TopoDS_Face face = TopoDS::Face(it.Current());
        BRepAdaptor_Surface surface(face);
        const GeomAbs_SurfaceType type = surface.GetType();
        if (type == GeomAbs_Plane) {
            const gp_Pln plane = surface.Plane();
            if (std::abs(gp_Vec(plane.Location(), p).Dot(gp_Vec(plane.Axis().Direction()))) > 1e-6) {
                continue;
            }
            BRepClass_FaceClassifier classify(face, p, 1e-6);
            if (classify.State() == TopAbs_IN || classify.State() == TopAbs_ON) {
                return 1;
            }
            continue;
        }
        if (type != GeomAbs_Cylinder && type != GeomAbs_Cone) {
            BRepBuilderAPI_MakeVertex vertex(p);
            BRepExtrema_DistShapeShape distance(vertex.Vertex(), face);
            if (distance.IsDone() && distance.Value() <= tol && distance.Value() < best_other) {
                best_other = distance.Value();
                what = surface_name(type);
            }
            continue;
        }
        double u = 0.0;
        double v = 0.0;
        gp_Cylinder cylinder;
        gp_Cone cone;
        gp_Pnt on;
        if (type == GeomAbs_Cone) {
            cone = surface.Cone();
            ElSLib::Parameters(cone, p, u, v);
            on = ElSLib::Value(u, v, cone);
        } else {
            cylinder = surface.Cylinder();
            ElSLib::Parameters(cylinder, p, u, v);
            on = ElSLib::Value(u, v, cylinder);
        }
        const double distance = p.Distance(on);
        if (distance > tol || distance >= best) {
            continue;
        }
        BRepClass_FaceClassifier classify(face, on, 1e-6);
        if (classify.State() != TopAbs_IN && classify.State() != TopAbs_ON) {
            continue;
        }
        best = distance;
        out.face = face;
        out.type = type;
        out.cylinder = cylinder;
        out.cone = cone;
        out.pos = type == GeomAbs_Cone ? cone.Position() : cylinder.Position();
        out.radius = type == GeomAbs_Cone ? cone.RefRadius() : cylinder.Radius();
        out.semi = type == GeomAbs_Cone ? cone.SemiAngle() : 0.0;
        out.u0 = u;
        out.v0 = v;
        out.distance = distance;
    }
    if (best < 1e29) {
        BRepTools::UVBounds(out.face, out.umin, out.umax, out.vmin, out.vmax);
        const double turn = 2.0 * kPi;
        while (out.u0 < out.umin - 1e-9) {
            out.u0 += turn;
        }
        while (out.u0 > out.umax + 1e-9) {
            out.u0 -= turn;
        }
        out.full_ring = out.umax - out.umin >= turn - 1e-6;
        out.sigma = out.face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
        if (out.type == GeomAbs_Cone) {
            out.surface = new Geom_ConicalSurface(out.pos, out.semi, out.radius);
        } else {
            out.surface = new Geom_CylindricalSurface(out.pos, out.radius);
        }
        return 2;
    }
    return best_other < 1e29 ? 3 : 0;
}

/// The surface moved `out` along the face's outward normal, with the same (u, v), so a loop in (u, v) is the same loop on it.
Handle(Geom_Surface) offset_surface(const Curved& c, double out) {
    const double d = out * c.sigma;  // along Su x Sv
    gp_Pnt p;
    gp_Vec su;
    gp_Vec sv;
    c.d1(c.u0, c.v0, p, su, sv);
    const gp_Vec normal = su.Crossed(sv);
    const gp_Vec radial = gp_Vec(c.pos.XDirection()) * std::cos(c.u0) + gp_Vec(c.pos.YDirection()) * std::sin(c.u0);
    if (c.type == GeomAbs_Cylinder) {
        const double along = normal.Dot(radial) >= 0.0 ? 1.0 : -1.0;
        const double radius = c.radius + d * along;
        if (radius > 1e-6) {
            return new Geom_CylindricalSurface(c.pos, radius);
        }
    } else {
        const double sin_a = std::sin(c.semi);
        const double cos_a = std::cos(c.semi);
        const gp_Vec across = radial * cos_a - gp_Vec(c.pos.Direction()) * sin_a;
        const double along = normal.Dot(across) >= 0.0 ? 1.0 : -1.0;
        const double radius = c.radius + d * along * cos_a;
        if (radius >= 0.0) {
            gp_Ax3 moved = c.pos;
            moved.Translate(gp_Vec(c.pos.Direction()) * (-d * along * sin_a));
            return new Geom_ConicalSurface(moved, c.semi, radius);
        }
    }
    // The offset would turn the surface inside out (an engraving past the axis): leave it to Open CASCADE.
    return new Geom_OffsetSurface(c.surface, d);
}

/// A letter as a solid between two surfaces with the same (u, v): its face on `low`, walls, its cap on `high`.
TopoDS_Shape glyph_tool(const GlyphIn& glyph, const Handle(Geom_Surface)& low, const Handle(Geom_Surface)& high) {
    const TopoDS_Face bottom = glyph_face(glyph, low);
    BRepBuilderAPI_Sewing sewing(1e-4);
    sewing.Add(bottom);
    add_walls_and_cap(bottom, high, sewing);
    sewing.Perform();
    BRepBuilderAPI_MakeSolid make;
    int shells = 0;
    for (TopExp_Explorer e(sewing.SewedShape(), TopAbs_SHELL); e.More(); e.Next()) {
        make.Add(TopoDS::Shell(e.Current()));
        ++shells;
    }
    if (shells != 1) {
        throw Standard_Failure("A letter did not close into a solid.");
    }
    TopoDS_Solid solid = make.Solid();
    BRepLib::OrientClosedSolid(solid);
    return solid;
}

/// A letter's points in (u, v): the starts and ends of its pieces, for the in-face and the material checks.
std::vector<gp_Pnt2d> uv_points(const std::vector<GlyphIn>& glyphs) {
    std::vector<gp_Pnt2d> out;
    for (const GlyphIn& glyph : glyphs) {
        for (const LoopIn& loop : glyph.loops) {
            out.emplace_back(loop.start[0], loop.start[1]);
            for (const Seg& seg : loop.segs) {
                const int n = static_cast<int>(seg.kind);
                out.emplace_back(seg.p[2 * n - 2], seg.p[2 * n - 1]);
            }
        }
    }
    return out;
}

/// What the direct and the boolean build need of the face the text is on: the face, its surface, which way is out, the surface moved
/// out by a distance (with the same (u, v)), and the (u, v) of a point on it.
struct Ground {
    TopoDS_Face face;
    Handle(Geom_Surface) surface;
    std::function<gp_Dir(double, double)> outward;
    std::function<Handle(Geom_Surface)(double)> offset;
    std::function<void(const gp_Pnt&, double&, double&)> parameters;
};

/// Lettering on a curved face, the letters already in its (u, v): the direct build when the text lies inside the face, the boolean
/// build otherwise or when `force_boolean` says the text crosses a seam.
TopoDS_Shape build_on_ground(
    const Ground& ground,
    const TopoDS_Shape& current,
    double before,
    bool cut,
    double depth,
    bool force_boolean,
    const std::vector<GlyphIn>& glyphs,
    double& volume,
    int& path,
    Handle(BRepTools_History)& history,
    std::string& note,
    std::string& error) {
    const Handle(Geom_Surface) surface = ground.surface;
    std::vector<TopoDS_Face> faces;
    faces.reserve(glyphs.size());
    for (const GlyphIn& glyph : glyphs) {
        faces.push_back(glyph_face(glyph, surface));
    }
    const std::vector<gp_Pnt2d> marks = uv_points(glyphs);
    bool direct_ok = !force_boolean;
    if (force_boolean) {
        note = "The text crosses the seam of the face.";
    }
    for (const gp_Pnt2d& uv : marks) {
        BRepClass_FaceClassifier classify(ground.face, surface->Value(uv.X(), uv.Y()), 1e-6);
        const bool off = classify.State() == TopAbs_OUT || (direct_ok && classify.State() != TopAbs_IN);
        if (off) {
            error = "The text runs off this face. Move it, make it smaller, or put it on one face.";
            return TopoDS_Shape();
        }
    }
    if (direct_ok && !ground.face.Location().IsIdentity()) {
        direct_ok = false;
        note = "The face carries a location.";
    }
    if (direct_ok) {
        TopoDS_Compound inks;
        BRep_Builder builder;
        builder.MakeCompound(inks);
        for (const TopoDS_Face& face : faces) {
            for (TopExp_Explorer w(face, TopAbs_WIRE); w.More(); w.Next()) {
                builder.Add(inks, w.Current());
            }
        }
        TopoDS_Compound edges;
        builder.MakeCompound(edges);
        for (TopExp_Explorer w(ground.face, TopAbs_WIRE); w.More(); w.Next()) {
            builder.Add(edges, w.Current());
        }
        BRepExtrema_DistShapeShape distance(inks, edges);
        if (distance.IsDone() && distance.Value() < 0.02) {
            direct_ok = false;
            note = "The text is within 0.02 mm of the face's edge.";
        }
    }
    if (cut) {
        // The material under every letter, along the normal where it stands.
        for (size_t g = 0; g < glyphs.size(); ++g) {
            std::vector<gp_Pnt2d> mine;
            Handle(IntTools_Context) context = new IntTools_Context;
            gp_Pnt inside;
            gp_Pnt2d uv;
            if (BOPTools_AlgoTools3D::PointInFace(faces[g], inside, uv, context) == 0) {
                mine.push_back(uv);
            }
            for (const LoopIn& loop : glyphs[g].loops) {
                mine.emplace_back(loop.start[0], loop.start[1]);
            }
            double thickness = 1e9;
            for (const gp_Pnt2d& at : mine) {
                const gp_Pnt on = surface->Value(at.X(), at.Y());
                const gp_Dir down = ground.outward(at.X(), at.Y()).Reversed();
                thickness = std::min(thickness, reach(current, on, down));
            }
            if (thickness <= depth + 1e-6) {
                direct_ok = false;
                note = "The cut goes through the wall.";
                if (glyphs[g].loops.size() > 1) {
                    error = "The middle of ‘" + utf8(glyphs[g].code) + "’ would fall out. Use the Stencil font, or engrave less deep.";
                    return TopoDS_Shape();
                }
            }
        }
    }
    if (direct_ok) {
        std::string why;
        TopoDS_Shape result;
        try {
            const Handle(Geom_Surface) top = ground.offset(cut ? -depth : depth);
            const auto looks_wrong = [&](const TopoDS_Face& one) {
                double u_lo = 0.0;
                double u_hi = 0.0;
                double v_lo = 0.0;
                double v_hi = 0.0;
                BRepTools::UVBounds(one, u_lo, u_hi, v_lo, v_hi);
                BRepAdaptor_Surface adaptor(one);
                const double um = (u_lo + u_hi) / 2.0;
                const double vm = (v_lo + v_hi) / 2.0;
                const gp_Pnt p = adaptor.Value(um, vm);
                gp_Pnt on;
                gp_Vec n;
                BRepGProp_Face(one).Normal(um, vm, on, n);
                double u = 0.0;
                double v = 0.0;
                ground.parameters(p, u, v);
                return n.Dot(gp_Vec(ground.outward(u, v))) < 0.0;
            };
            result = build_direct(current, ground.face, faces, surface, top, looks_wrong, history, why);
        } catch (const Standard_Failure& failure) {
            why = failure.GetMessageString() == nullptr ? "Open CASCADE failed" : failure.GetMessageString();
        }
        if (!result.IsNull()) {
            trace("analyzer");
            volume = volume_of(result);
            trace("volume");
            if (volume > 1e-6 && std::abs(volume - before) > 1e-9) {
                path = 1;
                return result;
            }
        }
        history.Nullify();
        note = why;
    }
    path = 2;
    // The boolean build: a solid for every letter from a little inside the part (a raise) or past its face (a cut) to the depth.
    const double sink = 0.2;
    std::vector<TopoDS_Shape> tools;
    try {
        const Handle(Geom_Surface) low = ground.offset(cut ? sink : -sink);
        const Handle(Geom_Surface) high = ground.offset(cut ? -depth : depth);
        for (const GlyphIn& glyph : glyphs) {
            tools.push_back(glyph_tool(glyph, low, high));
        }
    } catch (const Standard_Failure& failure) {
        error = failure.GetMessageString() == nullptr ? "Open CASCADE did not build a letter." : failure.GetMessageString();
        return TopoDS_Shape();
    }
    return combine_profile_tools(current, before, cut ? "cut" : "fuse", tools, "text", volume, error);
}



// --- Lettering on a sphere, a torus or a freeform face (milestone 3). The same builds as the cylinder and the cone (`build_on_ground`),
// on a face whose surface is read through Geom_Surface: the letters arrive in its (u, v) already (src/text/skin.rs, which asks
// `skin_d1` for the surface's points as it walks), and the top is the surface moved by the depth along its normal.

/// The face under the anchor when it is a sphere, a torus or any other curved face that is not a plane, a cylinder or a cone.
bool find_skin(const TopoDS_Shape& shape, const gp_Pnt& p, double tol, SkinHandle& out) {
    double best = 1e30;
    for (TopExp_Explorer it(shape, TopAbs_FACE); it.More(); it.Next()) {
        const TopoDS_Face face = TopoDS::Face(it.Current());
        BRepAdaptor_Surface adaptor(face);
        const GeomAbs_SurfaceType type = adaptor.GetType();
        if (type == GeomAbs_Plane || type == GeomAbs_Cylinder || type == GeomAbs_Cone) {
            continue;
        }
        const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
        if (surface.IsNull()) {
            continue;
        }
        GeomAPI_ProjectPointOnSurf project(p, surface);
        if (project.NbPoints() < 1) {
            continue;
        }
        const double distance = project.LowerDistance();
        if (!(distance <= tol) || distance >= best) {
            continue;
        }
        double u = 0.0;
        double v = 0.0;
        project.LowerDistanceParameters(u, v);
        BRepClass_FaceClassifier classify(face, project.NearestPoint(), 1e-6);
        if (classify.State() != TopAbs_IN && classify.State() != TopAbs_ON) {
            continue;
        }
        best = distance;
        out.face = face;
        out.surface = surface;
        out.type = type;
        out.u0 = u;
        out.v0 = v;
        out.distance = distance;
    }
    if (best >= 1e29) {
        return false;
    }
    BRepTools::UVBounds(out.face, out.umin, out.umax, out.vmin, out.vmax);
    out.u_period = out.surface->IsUPeriodic() ? out.surface->UPeriod() : 0.0;
    out.v_period = out.surface->IsVPeriodic() ? out.surface->VPeriod() : 0.0;
    if (out.u_period > 0.0) {
        while (out.u0 < out.umin - 1e-9) {
            out.u0 += out.u_period;
        }
        while (out.u0 > out.umax + 1e-9) {
            out.u0 -= out.u_period;
        }
    }
    if (out.v_period > 0.0) {
        while (out.v0 < out.vmin - 1e-9) {
            out.v0 += out.v_period;
        }
        while (out.v0 > out.vmax + 1e-9) {
            out.v0 -= out.v_period;
        }
    }
    out.full_u = out.u_period > 0.0 && out.umax - out.umin >= out.u_period - 1e-6;
    out.full_v = out.v_period > 0.0 && out.vmax - out.vmin >= out.v_period - 1e-6;
    out.sigma = out.face.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
    out.surface->Bounds(out.bu1, out.bu2, out.bv1, out.bv2);
    return true;
}

/// The surface moved `out` along the face's outward normal, with the same (u, v): a sphere and a torus stay one, another surface is
/// an offset surface.
Handle(Geom_Surface) skin_offset(const SkinHandle& c, double out) {
    const double d = out * c.sigma;  // along Su x Sv
    gp_Pnt p;
    gp_Vec su;
    gp_Vec sv;
    if (!c.d1(c.u0, c.v0, p, su, sv)) {
        throw Standard_Failure("The anchor is off the surface.");
    }
    const gp_Vec normal = su.Crossed(sv);
    BRepAdaptor_Surface adaptor(c.face);
    if (c.type == GeomAbs_Sphere) {
        const gp_Sphere sphere = adaptor.Sphere();
        const double along = normal.Dot(gp_Vec(sphere.Location(), p)) >= 0.0 ? 1.0 : -1.0;
        const double radius = sphere.Radius() + d * along;
        if (radius > 1e-6) {
            return new Geom_SphericalSurface(sphere.Position(), radius);
        }
    } else if (c.type == GeomAbs_Torus) {
        const gp_Torus torus = adaptor.Torus();
        // The tube's centre under (u, v): the major circle's point in the direction of u.
        const gp_Ax3 pos = torus.Position();
        const gp_Vec radial = gp_Vec(pos.XDirection()) * std::cos(c.u0) + gp_Vec(pos.YDirection()) * std::sin(c.u0);
        const gp_Pnt centre = pos.Location().Translated(radial * torus.MajorRadius());
        const double along = normal.Dot(gp_Vec(centre, p)) >= 0.0 ? 1.0 : -1.0;
        const double minor = torus.MinorRadius() + d * along;
        if (minor > 1e-6) {
            return new Geom_ToroidalSurface(pos, torus.MajorRadius(), minor);
        }
    }
    return new Geom_OffsetSurface(c.surface, d);
}

const char* skin_kind(GeomAbs_SurfaceType type) {
    return type == GeomAbs_Sphere ? "sphere" : (type == GeomAbs_Torus ? "torus" : "freeform");
}

}  // namespace

TopoDS_Shape build_lettering(
    const TopoDS_Shape& current,
    double before,
    bool cut,
    const double origin[3],
    const double turn[3],
    double depth,
    const double* data,
    int len,
    double& volume,
    int& path,
    Handle(BRepTools_History)& history,
    std::string& note,
    std::string& error) {
    path = 0;
    if (!std::isfinite(depth) || !(depth > 1e-6)) {
        error = "Text needs a depth above 0, in millimetres.";
        return TopoDS_Shape();
    }
    std::vector<GlyphIn> glyphs;
    if (!decode(data, len, glyphs, error)) {
        return TopoDS_Shape();
    }
    if (glyphs.empty()) {
        error = "The text has no letters to build. Spaces leave no ink.";
        return TopoDS_Shape();
    }
    const Frame frame = frame_from_turn(origin, turn);
    const Handle(Geom_Surface) plane = new Geom_Plane(gp_Pln(gp_Ax3(frame.origin, frame.w, frame.u)));
    std::vector<TopoDS_Face> faces;
    faces.reserve(glyphs.size());
    for (const GlyphIn& glyph : glyphs) {
        faces.push_back(glyph_face(glyph, plane));
    }
    const TopoDS_Face target = face_under(current, frame);
    const std::vector<gp_Pnt> samples = outline_points(glyphs, frame);
    bool direct_ok = false;
    if (!target.IsNull()) {
        // Every letter inside the face, and clear of its edges.
        direct_ok = true;
        for (const gp_Pnt& point : samples) {
            BRepClass_FaceClassifier classify(target, point, 1e-6);
            if (classify.State() != TopAbs_IN) {
                error = "The text runs off this face. Move it, make it smaller, or put it on one face.";
                return TopoDS_Shape();
            }
        }
        TopoDS_Compound inks;
        BRep_Builder builder;
        builder.MakeCompound(inks);
        for (const TopoDS_Face& face : faces) {
            for (TopExp_Explorer w(face, TopAbs_WIRE); w.More(); w.Next()) {
                builder.Add(inks, w.Current());
            }
        }
        TopoDS_Compound edges;
        builder.MakeCompound(edges);
        for (TopExp_Explorer w(target, TopAbs_WIRE); w.More(); w.Next()) {
            builder.Add(edges, w.Current());
        }
        BRepExtrema_DistShapeShape distance(inks, edges);
        if (distance.IsDone() && distance.Value() < 0.02) {
            direct_ok = false;
            note = "The text is within 0.02 mm of the face's edge.";
        }
    }
    if (cut) {
        // The material under every letter: a deeper cut than the wall goes through, and a letter with a counter would lose the
        // middle of it.
        const gp_Dir down = frame.w.Reversed();
        for (size_t g = 0; g < glyphs.size(); ++g) {
            std::vector<gp_Pnt> mine;
            Handle(IntTools_Context) context = new IntTools_Context;
            gp_Pnt inside;
            gp_Pnt2d uv;
            if (BOPTools_AlgoTools3D::PointInFace(faces[g], inside, uv, context) == 0) {
                mine.push_back(inside);
            }
            for (const LoopIn& loop : glyphs[g].loops) {
                mine.push_back(frame.origin.Translated(gp_Vec(frame.u) * loop.start[0] + gp_Vec(frame.v) * loop.start[1]));
            }
            double thickness = 1e9;
            for (const gp_Pnt& point : mine) {
                thickness = std::min(thickness, reach(current, point, down));
            }
            if (thickness <= depth + 1e-6) {
                direct_ok = false;
                note = "The cut goes through the wall.";
                if (glyphs[g].loops.size() > 1) {
                    error = "The middle of ‘" + utf8(glyphs[g].code) + "’ would fall out. Use the Stencil font, or engrave less deep.";
                    return TopoDS_Shape();
                }
            }
        }
    }
    if (direct_ok) {
        std::string why;
        TopoDS_Shape result;
        try {
            gp_Trsf lift;
            lift.SetTranslation(gp_Vec(frame.w) * (cut ? -depth : depth));
            const Handle(Geom_Surface) top = Handle(Geom_Surface)::DownCast(plane->Transformed(lift));
            const auto looks_wrong = [&](const TopoDS_Face& one) {
                BRepAdaptor_Surface surface(one);
                gp_Dir normal = surface.Plane().Axis().Direction();
                if (one.Orientation() == TopAbs_REVERSED) {
                    normal.Reverse();
                }
                return normal.Dot(frame.w) < 0.0;
            };
            result = build_direct(current, target, faces, plane, top, looks_wrong, history, why);
        } catch (const Standard_Failure& failure) {
            why = failure.GetMessageString() == nullptr ? "Open CASCADE failed" : failure.GetMessageString();
        }
        if (!result.IsNull()) {
            trace("analyzer");
            volume = volume_of(result);
            trace("volume");
            if (volume > 1e-6 && std::abs(volume - before) > 1e-9) {
                path = 1;
                return result;
            }
        }
        history.Nullify();
        note = why;
    }
    path = 2;
    return build_boolean(current, before, faces, frame, cut, depth, volume, error);
}

std::string text_face_json(const TopoDS_Shape& current, const double point[3]) {
    Curved c;
    std::string what;
    const int found = find_face(current, gp_Pnt(point[0], point[1], point[2]), 0.5, c, what);
    std::ostringstream out;
    out.precision(17);
    if (found == 1) {
        out << "{\"kind\":\"plane\"}";
        return out.str();
    }
    if (found == 3) {
        out << "{\"kind\":\"other\",\"surface\":\"" << what << "\"}";
        return out.str();
    }
    if (found == 0) {
        out << "{\"kind\":\"none\"}";
        return out.str();
    }
    out << "{\"kind\":\"" << (c.type == GeomAbs_Cone ? "cone" : "cylinder") << "\"";
    const auto at = [&](const char* name, double x, double y, double z) { out << ",\"" << name << "\":[" << x << "," << y << "," << z << "]"; };
    const gp_Pnt o = c.pos.Location();
    at("origin", o.X(), o.Y(), o.Z());
    at("xdir", c.pos.XDirection().X(), c.pos.XDirection().Y(), c.pos.XDirection().Z());
    at("ydir", c.pos.YDirection().X(), c.pos.YDirection().Y(), c.pos.YDirection().Z());
    at("zdir", c.pos.Direction().X(), c.pos.Direction().Y(), c.pos.Direction().Z());
    out << ",\"radius\":" << c.radius << ",\"semiAngle\":" << c.semi << ",\"sigma\":" << c.sigma << ",\"u0\":" << c.u0 << ",\"v0\":" << c.v0
        << ",\"uMin\":" << c.umin << ",\"uMax\":" << c.umax << ",\"vMin\":" << c.vmin << ",\"vMax\":" << c.vmax
        << ",\"fullRing\":" << (c.full_ring ? "true" : "false") << ",\"distance\":" << c.distance << "}";
    return out.str();
}

TopoDS_Shape build_lettering_curved(
    const TopoDS_Shape& current,
    double before,
    bool cut,
    const double point[3],
    double depth,
    bool force_boolean,
    const double* data,
    int len,
    double& volume,
    int& path,
    Handle(BRepTools_History)& history,
    std::string& note,
    std::string& error) {
    path = 0;
    if (!std::isfinite(depth) || !(depth > 1e-6)) {
        error = "Text needs a depth above 0, in millimetres.";
        return TopoDS_Shape();
    }
    std::vector<GlyphIn> glyphs;
    if (!decode(data, len, glyphs, error)) {
        return TopoDS_Shape();
    }
    if (glyphs.empty()) {
        error = "The text has no letters to build. Spaces leave no ink.";
        return TopoDS_Shape();
    }
    Curved round;
    std::string what;
    if (find_face(current, gp_Pnt(point[0], point[1], point[2]), 0.5, round, what) != 2) {
        error = "The anchor is not on a cylinder or a cone face.";
        return TopoDS_Shape();
    }
    Ground ground;
    ground.face = round.face;
    ground.surface = round.surface;
    ground.outward = [&](double u, double v) { return round.outward(u, v); };
    ground.offset = [&](double out) { return offset_surface(round, out); };
    ground.parameters = [&](const gp_Pnt& p, double& u, double& v) { round.parameters(p, u, v); };
    return build_on_ground(ground, current, before, cut, depth, force_boolean, glyphs, volume, path, history, note, error);
}

SkinHandle* skin_open(const TopoDS_Shape& current, const double point[3], std::string& info) {
    std::unique_ptr<SkinHandle> skin(new SkinHandle);
    if (!find_skin(current, gp_Pnt(point[0], point[1], point[2]), 0.5, *skin)) {
        return nullptr;
    }
    std::ostringstream out;
    out.precision(17);
    out << "{\"kind\":\"" << skin_kind(skin->type) << "\",\"sigma\":" << skin->sigma << ",\"u0\":" << skin->u0 << ",\"v0\":" << skin->v0
        << ",\"uMin\":" << skin->umin << ",\"uMax\":" << skin->umax << ",\"vMin\":" << skin->vmin << ",\"vMax\":" << skin->vmax
        << ",\"uPeriod\":" << skin->u_period << ",\"vPeriod\":" << skin->v_period << ",\"fullU\":" << (skin->full_u ? "true" : "false")
        << ",\"fullV\":" << (skin->full_v ? "true" : "false") << ",\"distance\":" << skin->distance << "}";
    info = out.str();
    return skin.release();
}

bool skin_d1(const SkinHandle* skin, double u, double v, double out[9]) {
    try {
        gp_Pnt p;
        gp_Vec su;
        gp_Vec sv;
        if (!skin->d1(u, v, p, su, sv)) {
            return false;
        }
        const double values[9] = {p.X(), p.Y(), p.Z(), su.X(), su.Y(), su.Z(), sv.X(), sv.Y(), sv.Z()};
        for (int k = 0; k < 9; ++k) {
            if (!std::isfinite(values[k])) {
                return false;
            }
            out[k] = values[k];
        }
        return true;
    } catch (...) {
        return false;
    }
}

void skin_close(SkinHandle* skin) {
    delete skin;
}

TopoDS_Shape build_lettering_skin(
    const TopoDS_Shape& current,
    double before,
    bool cut,
    const double point[3],
    double depth,
    bool force_boolean,
    const double* data,
    int len,
    double& volume,
    int& path,
    Handle(BRepTools_History)& history,
    std::string& note,
    std::string& error) {
    path = 0;
    if (!std::isfinite(depth) || !(depth > 1e-6)) {
        error = "Text needs a depth above 0, in millimetres.";
        return TopoDS_Shape();
    }
    std::vector<GlyphIn> glyphs;
    if (!decode(data, len, glyphs, error)) {
        return TopoDS_Shape();
    }
    if (glyphs.empty()) {
        error = "The text has no letters to build. Spaces leave no ink.";
        return TopoDS_Shape();
    }
    SkinHandle skin;
    if (!find_skin(current, gp_Pnt(point[0], point[1], point[2]), 0.5, skin)) {
        error = "The anchor is not on a sphere, a torus or a freeform face.";
        return TopoDS_Shape();
    }
    Ground ground;
    ground.face = skin.face;
    ground.surface = skin.surface;
    ground.outward = [&](double u, double v) { return skin.outward(u, v); };
    ground.offset = [&](double out) { return skin_offset(skin, out); };
    ground.parameters = [&](const gp_Pnt& p, double& u, double& v) {
        GeomAPI_ProjectPointOnSurf project(p, skin.surface);
        if (project.NbPoints() < 1) {
            throw Standard_Failure("A point of the text is off the surface.");
        }
        project.LowerDistanceParameters(u, v);
    };
    return build_on_ground(ground, current, before, cut, depth, force_boolean, glyphs, volume, path, history, note, error);
}


}  // namespace lime_occt
