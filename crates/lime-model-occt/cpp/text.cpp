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
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
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
#include <GCE2d_MakeSegment.hxx>
#include <Geom2d_BezierCurve.hxx>
#include <Geom_Plane.hxx>
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
#include <gp_Lin.hxx>
#include <gp_Pln.hxx>
#include <gp_Trsf.hxx>

#include "kernel.h"

namespace lime_occt {

namespace {

constexpr double kPi = 3.14159265358979323846;

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

/// The direct build. Null shape, with `why` set, when the text does not suit it.
TopoDS_Shape build_direct(
    const TopoDS_Shape& current,
    const TopoDS_Face& target,
    const std::vector<TopoDS_Face>& glyph_faces,
    const Handle(Geom_Surface)& plane,
    const Frame& frame,
    bool cut,
    double depth,
    Handle(BRepTools_History)& history,
    std::string& why) {
    gp_Trsf lift;
    lift.SetTranslation(gp_Vec(frame.w) * (cut ? -depth : depth));
    const Handle(Geom_Surface) top = Handle(Geom_Surface)::DownCast(plane->Transformed(lift));
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
    sewing.Perform();
    TopoDS_Shape sewn = sewing.SewedShape();
    std::vector<TopoDS_Face> fresh;
    for (TopExp_Explorer f(sewn, TopAbs_FACE); f.More(); f.Next()) {
        fresh.push_back(TopoDS::Face(f.Current()));
    }
    // The sewn faces face the way the first one did. The part's face looks along W, so the one standing in its place must.
    TopoDS_Shape rest_sewn = sewing.IsModified(rest_face) ? sewing.Modified(rest_face) : static_cast<TopoDS_Shape>(rest_face);
    for (TopExp_Explorer f(rest_sewn, TopAbs_FACE); f.More(); f.Next()) {
        const TopoDS_Face one = TopoDS::Face(f.Current());
        BRepAdaptor_Surface surface(one);
        gp_Dir normal = surface.Plane().Axis().Direction();
        if (one.Orientation() == TopAbs_REVERSED) {
            normal.Reverse();
        }
        if (normal.Dot(frame.w) < 0.0) {
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
            result = build_direct(current, target, faces, plane, frame, cut, depth, history, why);
        } catch (const Standard_Failure& failure) {
            why = failure.GetMessageString() == nullptr ? "Open CASCADE failed" : failure.GetMessageString();
        }
        if (!result.IsNull()) {
            volume = volume_of(result);
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

}  // namespace lime_occt
