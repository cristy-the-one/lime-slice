// Hermite–Coons fill for G1/G2 patches and blends. Included inside kernel.cpp's
// anonymous namespace. No GeomPlate.
//
// Step 8 governs the shared split. The cross field at s=0 is that piece's
// outer-half tangent at M_i, projected perpendicular to the shared normal
// n(s). It is not the step 6 transverse ribbon; that ribbon is the split's
// departure tangent, already stored on the shared cubic.

constexpr double kHermiteGapMm = 1e-4;
constexpr double kHermiteAngleDeg = 0.1;
constexpr double kHermiteJump = 1e-3;
constexpr int kHermiteStations = 5;
constexpr int kHermiteRefineCap = 24;

double clamp_unit(double v) {
    return std::clamp(v, -1.0, 1.0);
}

gp_Vec hermite_vec(double s, const gp_Vec& a, const gp_Vec& b) {
    const double h0 = (2.0 * s - 3.0) * s * s + 1.0;
    const double h1 = (-2.0 * s + 3.0) * s * s;
    return a.Multiplied(h0).Added(b.Multiplied(h1));
}

bool solve_linear(std::vector<std::vector<double>>& a, std::vector<double>& b) {
    const int n = static_cast<int>(b.size());
    for (int col = 0; col < n; ++col) {
        int pivot = col;
        for (int row = col + 1; row < n; ++row) {
            if (std::abs(a[static_cast<size_t>(row)][static_cast<size_t>(col)])
                > std::abs(a[static_cast<size_t>(pivot)][static_cast<size_t>(col)])) {
                pivot = row;
            }
        }
        if (!(std::abs(a[static_cast<size_t>(pivot)][static_cast<size_t>(col)]) > 1e-14)) return false;
        if (pivot != col) {
            std::swap(a[static_cast<size_t>(col)], a[static_cast<size_t>(pivot)]);
            std::swap(b[static_cast<size_t>(col)], b[static_cast<size_t>(pivot)]);
        }
        const double div = a[static_cast<size_t>(col)][static_cast<size_t>(col)];
        for (int c = col; c < n; ++c) a[static_cast<size_t>(col)][static_cast<size_t>(c)] /= div;
        b[static_cast<size_t>(col)] /= div;
        for (int row = 0; row < n; ++row) {
            if (row == col) continue;
            const double f = a[static_cast<size_t>(row)][static_cast<size_t>(col)];
            if (f == 0.0) continue;
            for (int c = col; c < n; ++c) {
                a[static_cast<size_t>(row)][static_cast<size_t>(c)] -= f * a[static_cast<size_t>(col)][static_cast<size_t>(c)];
            }
            b[static_cast<size_t>(row)] -= f * b[static_cast<size_t>(col)];
        }
    }
    return true;
}

std::vector<double> flat_knots(const Handle(Geom_BSplineCurve)& curve) {
    std::vector<double> flat;
    flat.reserve(static_cast<size_t>(curve->NbPoles() + curve->Degree() + 1));
    for (int i = 1; i <= curve->NbKnots(); ++i) {
        for (int m = 0; m < curve->Multiplicity(i); ++m) flat.push_back(curve->Knot(i));
    }
    return flat;
}

double greville_of(const std::vector<double>& flat, int degree, int pole) {
    double sum = 0.0;
    for (int k = 1; k <= degree; ++k) sum += flat[static_cast<size_t>(pole + k)];
    return sum / static_cast<double>(degree);
}

void bspline_basis(const std::vector<double>& u, int degree, int npoles, double t, std::vector<double>& basis) {
    basis.assign(static_cast<size_t>(npoles), 0.0);
    if (npoles <= 0 || degree < 1 || static_cast<int>(u.size()) < npoles + degree + 1) return;
    int span = degree;
    const double last = u[static_cast<size_t>(npoles)];
    if (t >= last - 1e-15) {
        span = npoles - 1;
        t = last;
    } else if (t <= u[static_cast<size_t>(degree)]) {
        span = degree;
        t = u[static_cast<size_t>(degree)];
    } else {
        for (int i = degree; i < npoles; ++i) {
            if (t >= u[static_cast<size_t>(i)] && t < u[static_cast<size_t>(i + 1)]) {
                span = i;
                break;
            }
        }
    }
    std::vector<double> N(static_cast<size_t>(degree + 1), 0.0);
    std::vector<double> left(static_cast<size_t>(degree + 1), 0.0);
    std::vector<double> right(static_cast<size_t>(degree + 1), 0.0);
    N[0] = 1.0;
    for (int j = 1; j <= degree; ++j) {
        left[static_cast<size_t>(j)] = t - u[static_cast<size_t>(span + 1 - j)];
        right[static_cast<size_t>(j)] = u[static_cast<size_t>(span + j)] - t;
        double saved = 0.0;
        for (int r = 0; r < j; ++r) {
            const double denom = right[static_cast<size_t>(r + 1)] + left[static_cast<size_t>(j - r)];
            const double temp = std::abs(denom) < 1e-18 ? 0.0 : N[static_cast<size_t>(r)] / denom;
            N[static_cast<size_t>(r)] = saved + right[static_cast<size_t>(r + 1)] * temp;
            saved = left[static_cast<size_t>(j - r)] * temp;
        }
        N[static_cast<size_t>(j)] = saved;
    }
    for (int r = 0; r <= degree; ++r) {
        const int idx = span - degree + r;
        if (idx >= 0 && idx < npoles) basis[static_cast<size_t>(idx)] = N[static_cast<size_t>(r)];
    }
}

struct EndScale {
    double alpha0 = 1.0;
    double alpha1 = 1.0;
    double beta = 1.0;
    bool ok = false;
};

EndScale scales_from_flat(const std::vector<double>& flat, int degree) {
    EndScale s;
    if (degree < 2 || static_cast<int>(flat.size()) < degree + 3) return s;
    const double d0 = flat[static_cast<size_t>(degree + 1)] - flat[1];
    const double d1 = flat[static_cast<size_t>(degree + 2)] - flat[2];
    const double db = flat[static_cast<size_t>(degree + 1)] - flat[2];
    if (!(std::abs(d0) > 1e-12) || !(std::abs(d1) > 1e-12) || !(std::abs(db) > 1e-12)) return s;
    s.alpha0 = static_cast<double>(degree) / d0;
    s.alpha1 = static_cast<double>(degree) / d1;
    s.beta = static_cast<double>(degree - 1) / db;
    s.ok = true;
    return s;
}

EndScale end_scales(const std::vector<double>& flat, int degree) {
    std::vector<double> rev(flat.size());
    const double last = flat.empty() ? 0.0 : flat.back();
    for (size_t i = 0; i < flat.size(); ++i) rev[i] = last - flat[flat.size() - 1 - i];
    return scales_from_flat(rev, degree);
}

bool interpolate_controls(
    const std::vector<double>& flat,
    int degree,
    int npoles,
    const std::vector<gp_Vec>& samples,
    bool lock_ends,
    gp_Vec q_first,
    gp_Vec q_last,
    std::vector<gp_Vec>& controls,
    std::string& error) {
    controls.assign(static_cast<size_t>(npoles), gp_Vec(0, 0, 0));
    if (npoles < 2) {
        error = "Open CASCADE could not fill this opening.";
        return false;
    }
    const int begin = lock_ends ? 1 : 0;
    const int end = lock_ends ? npoles - 1 : npoles;
    const int m = end - begin;
    if (m <= 0) {
        controls[0] = q_first;
        controls[static_cast<size_t>(npoles - 1)] = q_last;
        return true;
    }
    std::vector<double> basis;
    std::vector<std::vector<double>> matrix(static_cast<size_t>(m), std::vector<double>(static_cast<size_t>(m), 0.0));
    std::vector<double> rhs[3] = {
        std::vector<double>(static_cast<size_t>(m), 0.0),
        std::vector<double>(static_cast<size_t>(m), 0.0),
        std::vector<double>(static_cast<size_t>(m), 0.0),
    };
    for (int row = 0; row < m; ++row) {
        const int pole = begin + row;
        const double xi = greville_of(flat, degree, pole);
        bspline_basis(flat, degree, npoles, xi, basis);
        const gp_Vec target = samples[static_cast<size_t>(pole)];
        gp_Vec known(0, 0, 0);
        if (lock_ends) known = q_first.Multiplied(basis[0]).Added(q_last.Multiplied(basis[static_cast<size_t>(npoles - 1)]));
        const gp_Vec rest = target.Subtracted(known);
        rhs[0][static_cast<size_t>(row)] = rest.X();
        rhs[1][static_cast<size_t>(row)] = rest.Y();
        rhs[2][static_cast<size_t>(row)] = rest.Z();
        for (int col = 0; col < m; ++col) matrix[static_cast<size_t>(row)][static_cast<size_t>(col)] = basis[static_cast<size_t>(begin + col)];
    }
    for (int axis = 0; axis < 3; ++axis) {
        auto a = matrix;
        if (!solve_linear(a, rhs[axis])) {
            error = "Open CASCADE could not fill this opening.";
            return false;
        }
    }
    if (lock_ends) {
        controls[0] = q_first;
        controls[static_cast<size_t>(npoles - 1)] = q_last;
    }
    for (int row = 0; row < m; ++row) {
        controls[static_cast<size_t>(begin + row)] = gp_Vec(
            rhs[0][static_cast<size_t>(row)],
            rhs[1][static_cast<size_t>(row)],
            rhs[2][static_cast<size_t>(row)]);
    }
    return true;
}

double curve_length(const Handle(Geom_BSplineCurve)& curve) {
    try {
        GeomAdaptor_Curve adapt(curve);
        const double len = GCPnts_AbscissaPoint::Length(adapt);
        if (len > 1e-12) return len;
    } catch (const Standard_Failure&) {
    }
    return 0.0;
}

double param_at_fraction(const Handle(Geom_BSplineCurve)& curve, double frac) {
    const double a = curve->FirstParameter();
    const double b = curve->LastParameter();
    const double clamped = std::clamp(frac, 0.0, 1.0);
    try {
        GeomAdaptor_Curve adapt(curve);
        const double len = GCPnts_AbscissaPoint::Length(adapt);
        if (len > 1e-9) {
            GCPnts_AbscissaPoint tool(adapt, len * clamped, a);
            if (tool.IsDone()) return tool.Parameter();
        }
    } catch (const Standard_Failure&) {
    }
    return a + clamped * (b - a);
}

void reparam_01(const Handle(Geom_BSplineCurve)& curve) {
    const double a = curve->FirstParameter();
    const double b = curve->LastParameter();
    const double span = b - a;
    if (!(span > 1e-15)) return;
    if (std::abs(a) < 1e-14 && std::abs(span - 1.0) < 1e-14) return;
    const int n = curve->NbKnots();
    TColStd_Array1OfReal knots(1, n);
    curve->Knots(knots);
    for (int i = 1; i <= n; ++i) knots.SetValue(i, (knots.Value(i) - a) / span);
    curve->SetKnots(knots);
}

Handle(Geom_BSplineCurve) copy_curve(const Handle(Geom_BSplineCurve)& curve) {
    return Handle(Geom_BSplineCurve)::DownCast(curve->Copy());
}

Handle(Geom_BSplineCurve) with_extra_knots(
    const Handle(Geom_BSplineCurve)& source,
    const std::vector<double>& extra,
    int min_degree) {
    Handle(Geom_BSplineCurve) curve = copy_curve(source);
    reparam_01(curve);
    if (curve->Degree() < min_degree) curve->IncreaseDegree(min_degree);
    for (double t : extra) {
        if (t > 1e-5 && t < 1.0 - 1e-5) curve->InsertKnot(t, 1, 1e-9, Standard_False);
    }
    return curve;
}

bool unify_pair(Handle(Geom_BSplineCurve)& a, Handle(Geom_BSplineCurve)& b, std::string& error) {
    const int deg = std::max(a->Degree(), b->Degree());
    if (a->Degree() < deg) a->IncreaseDegree(deg);
    if (b->Degree() < deg) b->IncreaseDegree(deg);
    for (int pass = 0; pass < 2; ++pass) {
        TColStd_Array1OfReal ka(1, a->NbKnots());
        TColStd_Array1OfInteger ma(1, a->NbKnots());
        a->Knots(ka);
        a->Multiplicities(ma);
        b->InsertKnots(ka, ma, 1e-10, Standard_False);
        TColStd_Array1OfReal kb(1, b->NbKnots());
        TColStd_Array1OfInteger mb(1, b->NbKnots());
        b->Knots(kb);
        b->Multiplicities(mb);
        a->InsertKnots(kb, mb, 1e-10, Standard_False);
    }
    if (a->NbPoles() != b->NbPoles() || a->Degree() != b->Degree()) {
        error = "The fill could not give the opposite edges one knot vector.";
        return false;
    }
    return true;
}

Handle(Geom_BSplineCurve) half_curve(const Handle(Geom_BSplineCurve)& full, bool from_start, std::string& error) {
    const double mid = param_at_fraction(full, 0.5);
    Handle(Geom_BSplineCurve) curve = copy_curve(full);
    const double a = curve->FirstParameter();
    const double b = curve->LastParameter();
    try {
        if (from_start) {
            if (!(mid > a + 1e-8)) {
                error = "Open CASCADE could not fill this opening.";
                return {};
            }
            curve->Segment(a, mid);
        } else {
            if (!(mid < b - 1e-8)) {
                error = "Open CASCADE could not fill this opening.";
                return {};
            }
            curve->Segment(mid, b);
            curve->Reverse();
        }
    } catch (const Standard_Failure&) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    reparam_01(curve);
    return curve;
}

Handle(Geom_BSplineCurve) cubic_bezier(const gp_Pnt& q0, const gp_Pnt& q1, const gp_Pnt& q2, const gp_Pnt& q3) {
    TColgp_Array1OfPnt poles(1, 4);
    poles.SetValue(1, q0);
    poles.SetValue(2, q1);
    poles.SetValue(3, q2);
    poles.SetValue(4, q3);
    TColStd_Array1OfReal knots(1, 2);
    knots.SetValue(1, 0.0);
    knots.SetValue(2, 1.0);
    TColStd_Array1OfInteger mults(1, 2);
    mults.SetValue(1, 4);
    mults.SetValue(2, 4);
    return new Geom_BSplineCurve(poles, knots, mults, 3);
}

bool face_parameters(const TopoDS_Face& face, const gp_Pnt& world, double& u, double& v) {
    if (face.IsNull()) return false;
    TopLoc_Location loc;
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(face, loc);
    if (surface.IsNull()) return false;
    gp_Pnt local = world;
    if (!loc.IsIdentity()) local.Transform(loc.Transformation().Inverted());
    try {
        ShapeAnalysis_Surface analysis(surface);
        const gp_Pnt2d uv = analysis.ValueOfUV(local, 1e-7);
        u = uv.X();
        v = uv.Y();
        return true;
    } catch (const Standard_Failure&) {
    }
    try {
        GeomAPI_ProjectPointOnSurf proj(local, surface);
        if (proj.NbPoints() < 1) return false;
        proj.LowerDistanceParameters(u, v);
        return true;
    } catch (const Standard_Failure&) {
        return false;
    }
}

bool point_on_face(const TopoDS_Face& face, const gp_Pnt& point, double tol) {
    if (face.IsNull()) return false;
    double u = 0.0;
    double v = 0.0;
    if (!face_parameters(face, point, u, v)) return false;
    try {
        BRepAdaptor_Surface adapt(face);
        if (adapt.Value(u, v).Distance(point) > tol) return false;
        const BRepClass_FaceClassifier cls(face, gp_Pnt2d(u, v), tol);
        const TopAbs_State state = cls.State();
        return state == TopAbs_IN || state == TopAbs_ON;
    } catch (const Standard_Failure&) {
        return false;
    }
}

// A rim chain can lie on more than one face. An exact circle extruded from two
// arcs is two half-cylinders; the first edge's face does not contain the other
// half. Projecting that half onto the first face flips the cross derivative.
// `faces` are the faces beside the rim's own edges: only those are searched.
TopoDS_Face face_touching(const std::vector<TopoDS_Face>& faces, const TopoDS_Face& hint, const gp_Pnt& point) {
    constexpr double tol = 1e-4;
    if (point_on_face(hint, point, tol)) return hint;
    for (const TopoDS_Face& face : faces) {
        if (face.IsSame(hint)) continue;
        if (point_on_face(face, point, tol)) return face;
    }
    return hint;
}

// A seam vertex lies on two faces, so the hint classifies there and its outward
// B can point into the wall. The curve's tangent leaves that vertex on one face.
TopoDS_Face face_along(const std::vector<TopoDS_Face>& faces, const TopoDS_Face& hint, const gp_Pnt& point, const gp_Vec& tangent) {
    const TopoDS_Face touching = face_touching(faces, hint, point);
    if (faces.empty() || tangent.Magnitude() < 1e-12) return touching;
    bool shared = false;
    for (const TopoDS_Face& face : faces) {
        if (face.IsSame(touching)) continue;
        if (point_on_face(face, point, 1e-4)) {
            shared = true;
            break;
        }
    }
    if (!shared) return touching;
    gp_Vec dir = tangent;
    dir.Normalize();
    for (double step : {0.2, 0.05, 1.0}) {
        for (double sign : {1.0, -1.0}) {
            const gp_Pnt ahead(point.XYZ() + dir.XYZ() * (sign * step));
            TopoDS_Face found;
            int hits = 0;
            if (point_on_face(touching, ahead, 1e-4)) {
                found = touching;
                ++hits;
            }
            for (const TopoDS_Face& face : faces) {
                if (face.IsSame(touching)) continue;
                if (!point_on_face(face, ahead, 1e-4)) continue;
                found = face;
                ++hits;
            }
            if (hits == 1) return found;
        }
    }
    return touching;
}

struct Transverse {
    bool ok = false;
    gp_Vec Ds;
    gp_Vec Dss;
    // Outward unit transverse of the face that was sampled (plan step 6).
    gp_Vec B;
    gp_Dir normal;
    std::string error;
};

Transverse transverse_at(const TopoDS_Face& face, const gp_Pnt& point, const gp_Vec& edge_tangent, int side_index) {
    Transverse out;
    if (face.IsNull()) {
        out.error = "G1 and G2 need the face beside the edge. Pick an edge of the sheet, or set that side to G0.";
        return out;
    }
    double u = 0.0;
    double v = 0.0;
    if (!face_parameters(face, point, u, v)) {
        out.error = "G1 and G2 need the face beside the edge. Pick an edge of the sheet, or set that side to G0.";
        return out;
    }
    try {
        BRepAdaptor_Surface adapt(face);
        BRepLProp_SLProps props(adapt, 2, 1e-9);
        props.SetParameters(u, v);
        if (!props.IsNormalDefined()) {
            out.error = "The face beside side " + std::to_string(side_index) + " is singular, so its tangent plane is not defined.";
            return out;
        }
        gp_Dir normal = props.Normal();
        if (face.Orientation() == TopAbs_REVERSED) normal.Reverse();
        gp_Vec tangent = edge_tangent;
        if (tangent.Magnitude() < 1e-12) {
            out.error = "The face beside side " + std::to_string(side_index) + " is singular, so its tangent plane is not defined.";
            return out;
        }
        tangent.Normalize();
        gp_Vec B = gp_Vec(normal).Crossed(tangent);
        if (B.Magnitude() < 1e-12) {
            out.error = "The face beside side " + std::to_string(side_index) + " is singular, so its tangent plane is not defined.";
            return out;
        }
        B.Normalize();
        // A short step from a boundary point often classifies ON. Walk farther until
        // the point is clearly in the face or clearly outside it, so every station
        // on one edge picks the same side. A seam is itself a straight edge, so a
        // step along B stays ON it; only then step off that edge.
        auto classify_step = [&](const gp_Pnt& stepped) -> TopAbs_State {
            double su = 0.0;
            double sv = 0.0;
            if (!face_parameters(face, stepped, su, sv)) return TopAbs_UNKNOWN;
            try {
                const BRepClass_FaceClassifier cls(face, gp_Pnt2d(su, sv), 1e-6);
                return cls.State();
            } catch (const Standard_Failure&) {
                return TopAbs_UNKNOWN;
            }
        };
        auto walk = [&]() -> int {
            double step = 0.5;
            for (int attempt = 0; attempt < 5; ++attempt) {
                const TopAbs_State state = classify_step(gp_Pnt(point.XYZ() + B.XYZ() * step));
                if (state == TopAbs_IN) return -1;
                // The first step that leaves the face says B points out. A later
                // OUT, after steps that stayed ON, has walked through the face
                // and out the other side. That is not a direction.
                if (state == TopAbs_OUT) return attempt == 0 ? 1 : 0;
                if (state == TopAbs_UNKNOWN) return 0;
                step *= 3.0;
            }
            return 0;
        };
        int side = walk();
        // A vertical seam classifies ON for every step along B. A step that also
        // leaves the seam, into the face, tells which way B points.
        if (side == 0) {
            gp_Vec rim = gp_Vec(normal).Crossed(B);
            if (rim.Magnitude() > 1e-12) {
                rim.Normalize();
                double step = 0.5;
                for (int attempt = 0; attempt < 4 && side == 0; ++attempt) {
                    for (double sign_b : {1.0, -1.0}) {
                        if (side != 0) break;
                        for (double sign_r : {1.0, -1.0}) {
                            const gp_Vec offset = B.Multiplied(sign_b * step) + rim.Multiplied(sign_r * 0.05);
                            if (classify_step(gp_Pnt(point.XYZ() + offset.XYZ())) != TopAbs_IN) continue;
                            side = sign_b > 0.0 ? -1 : 1;
                            break;
                        }
                    }
                    step *= 3.0;
                }
            }
        }
        if (side < 0) B.Reverse();
        const gp_Vec Su = props.D1U();
        const gp_Vec Sv = props.D1V();
        const double E = Su.Dot(Su);
        const double F = Su.Dot(Sv);
        const double G = Sv.Dot(Sv);
        const double delta = E * G - F * F;
        if (!(delta > 1e-18)) {
            out.error = "The face beside side " + std::to_string(side_index) + " is singular, so its tangent plane is not defined.";
            return out;
        }
        const double a = (G * Su.Dot(B) - F * Sv.Dot(B)) / delta;
        const double b = (E * Sv.Dot(B) - F * Su.Dot(B)) / delta;
        out.Ds = Su.Multiplied(a).Added(Sv.Multiplied(b));
        out.Dss = props.D2U().Multiplied(a * a).Added(props.DUV().Multiplied(2.0 * a * b)).Added(props.D2V().Multiplied(b * b));
        // Ds is the face derivative along B. If a seam sample comes back against
        // that outward direction, turn it around. Dss is even in B, so it stays.
        if (out.Ds.Dot(B) < 0.0) out.Ds.Reverse();
        out.B = B;
        out.normal = normal;
        out.ok = true;
        return out;
    } catch (const Standard_Failure&) {
        out.error = "The face beside side " + std::to_string(side_index) + " is singular, so its tangent plane is not defined.";
        return out;
    }
}

double curvature_perp(BRepLProp_SLProps& props, double outward, const gp_Vec& edge_tan) {
    if (!props.IsCurvatureDefined() || !props.IsNormalDefined()) return 0.0;
    gp_Dir n = props.Normal();
    if (outward < 0.0) n.Reverse();
    gp_Vec perp = gp_Vec(n).Crossed(edge_tan);
    const double plen = perp.Magnitude();
    if (!(plen > 1e-12)) return 0.5 * (props.MaxCurvature() + props.MinCurvature()) * outward;
    perp.Divide(plen);
    gp_Dir dmax;
    gp_Dir dmin;
    props.CurvatureDirections(dmax, dmin);
    const double c = perp.Dot(gp_Vec(dmax));
    const double s = perp.Dot(gp_Vec(dmin));
    return (props.MaxCurvature() * c * c + props.MinCurvature() * s * s) * outward;
}

struct StationStat {
    double gap = 0.0;
    double angle = 0.0;
    double jump = 0.0;
    bool samples = false;
};

StationStat measure_faces(
    const TopoDS_Face& a,
    const Handle(Geom_Surface)& sa,
    double ua,
    double va,
    const TopoDS_Face& b,
    const Handle(Geom_Surface)& sb,
    double ub,
    double vb,
    const gp_Vec& edge_tan) {
    StationStat stat;
    try {
        BRepAdaptor_Surface aa(a);
        BRepAdaptor_Surface bb(b);
        BRepLProp_SLProps pa(aa, 2, 1e-9);
        BRepLProp_SLProps pb(bb, 2, 1e-9);
        pa.SetParameters(ua, va);
        pb.SetParameters(ub, vb);
        if (!pa.IsNormalDefined() || !pb.IsNormalDefined()) return stat;
        stat.samples = true;
        stat.gap = pa.Value().Distance(pb.Value());
        gp_Dir na = pa.Normal();
        gp_Dir nb = pb.Normal();
        const double out_a = a.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
        const double out_b = b.Orientation() == TopAbs_REVERSED ? -1.0 : 1.0;
        if (out_a < 0.0) na.Reverse();
        if (out_b < 0.0) nb.Reverse();
        stat.angle = std::acos(clamp_unit(na.Dot(nb))) * (180.0 / M_PI);
        if (stat.angle <= 1.0) {
            const double ka = curvature_perp(pa, out_a, edge_tan);
            const double kb = curvature_perp(pb, out_b, edge_tan);
            if (std::isfinite(ka) && std::isfinite(kb)) stat.jump = std::abs(ka - kb);
        }
        (void)sa;
        (void)sb;
    } catch (const Standard_Failure&) {
    }
    return stat;
}

struct EdgeReport {
    const char* which = "outer";
    int side = 0;
    int asked = 0;
    double gap = 0.0;
    double angle = 0.0;
    // How far the tangent planes are from the asked match. 180° is the same
    // plane with the normal reversed, which the blend reads before Sew flips
    // one wall. The largest raw angle hides that: a side at 180° and a side
    // at 179.685° report 180°.
    double angle_dev = 0.0;
    double jump = 0.0;
    double worst_frac = 0.5;
    double score = -1.0;
    bool fail = false;
    bool short_span = false;
};

double plane_deviation(double angle) {
    if (!(angle >= 0.0) || !(angle <= 180.0)) return angle;
    return angle > 90.0 ? 180.0 - angle : angle;
}

void note_station(EdgeReport& edge, const StationStat& stat, double frac) {
    const double gap_s = stat.gap / kHermiteGapMm;
    const double ang_s = edge.asked >= 1 ? stat.angle / kHermiteAngleDeg : 0.0;
    const double jmp_s = edge.asked >= 2 ? stat.jump / kHermiteJump : 0.0;
    const double score = std::max(gap_s, std::max(ang_s, jmp_s));
    if (score >= edge.score) {
        edge.score = score;
        edge.worst_frac = frac;
    }
    edge.gap = std::max(edge.gap, stat.gap);
    edge.angle = std::max(edge.angle, stat.angle);
    edge.angle_dev = std::max(edge.angle_dev, plane_deviation(stat.angle));
    edge.jump = std::max(edge.jump, stat.jump);
}

bool edge_fails(const EdgeReport& edge) {
    if (edge.gap >= kHermiteGapMm) return true;
    if (edge.asked >= 1 && !(edge.angle < kHermiteAngleDeg)) return true;
    if (edge.asked >= 2 && edge.jump > kHermiteJump) return true;
    return false;
}

// Gap is the G0 measure. Angle is the G1 measure, already the deviation from
// the asked tangent plane. Jump is the G2 measure. A refusal names only the
// measures the failing edges asked for.
std::string asked_measures(double gap, double angle, double jump, int asked) {
    std::ostringstream out;
    out.setf(std::ios::fixed);
    out.precision(6);
    out << "The largest gap is " << gap << " mm";
    if (asked >= 2) {
        out << ", the largest angle is " << angle
            << " degrees, and the largest curvature jump is " << jump << " per mm.";
    } else if (asked >= 1) {
        out << " and the largest angle is " << angle << " degrees.";
    } else {
        out << ".";
    }
    return out.str();
}

struct AskedWorst {
    double gap = 0.0;
    double angle = 0.0;
    double jump = 0.0;
    int asked = 0;
    bool any = false;
};

AskedWorst worst_of(const std::vector<EdgeReport>& reports, bool failing_only) {
    AskedWorst worst;
    for (const EdgeReport& report : reports) {
        if (failing_only && !report.fail) continue;
        worst.any = true;
        worst.gap = std::max(worst.gap, report.gap);
        worst.asked = std::max(worst.asked, report.asked);
        if (report.asked >= 1) worst.angle = std::max(worst.angle, report.angle_dev);
        if (report.asked >= 2) worst.jump = std::max(worst.jump, report.jump);
    }
    return worst;
}

std::string miss_sentence(const std::vector<EdgeReport>& reports) {
    AskedWorst worst = worst_of(reports, true);
    if (!worst.any) worst = worst_of(reports, false);
    return std::string("The fill cannot reach the continuity you asked for. ")
        + asked_measures(worst.gap, worst.angle, worst.jump, worst.asked);
}

gp_Vec project_off(const gp_Vec& v, const gp_Vec& unit_n) {
    return v.Subtracted(unit_n.Multiplied(v.Dot(unit_n)));
}

/// The last Hermite fill's own measure, as JSON, for the tests (lime_tree_test_last_fill): each asked edge's largest gap,
/// angle and curvature jump at the op's stations, how many refinement rounds it took, and whether it was refused. Per
/// thread: an op runs on the thread that called, so a test reads its own op's measure.
thread_local std::string g_last_fill;
/// The farthest a guide point is from the patch the op kept, by the op's own projection; -1 with no guide.
thread_local double g_guide_off = -1.0;

void note_last_fill(const std::vector<EdgeReport>& reports, int refinements, bool refused) {
    std::ostringstream out;
    out.precision(9);
    out << "{\"refinements\":" << refinements << ",\"refused\":" << (refused ? "true" : "false") << ",\"edges\":[";
    for (size_t i = 0; i < reports.size(); ++i) {
        const EdgeReport& report = reports[i];
        out << (i ? "," : "") << "{\"which\":\"" << report.which << "\",\"side\":" << report.side
            << ",\"asked\":" << report.asked << ",\"gapMm\":" << report.gap << ",\"angleDeg\":" << report.angle
            << ",\"curvatureJump\":" << report.jump << "}";
    }
    out << "],\"guideMm\":" << g_guide_off << "}";
    g_last_fill = out.str();
}

}  // namespace

std::string last_fill_report() {
    return g_last_fill;
}

namespace {

/// "Edge 5", "Edges 5 and 6", or `fallback` when the side came from a curve.
std::string edges_phrase(const std::vector<int>& ids, const char* fallback) {
    if (ids.empty()) return fallback;
    std::ostringstream out;
    out << (ids.size() == 1 ? "Edge " : "Edges ") << ids[0];
    for (size_t i = 1; i < ids.size(); ++i) out << (i + 1 == ids.size() ? " and " : ", ") << ids[i];
    return out.str();
}

/// A blend's own measure at one station of its rim `v_rim` (0 or 1) against the wall it meets there (the face beside
/// the rim edge that holds that point, from `faces`):
/// - the gap from the rim point to the wall;
/// - the angle between the blend's direction across the rim, continued past it, and the direction from the edge into
///   the wall. A blend that carries on smoothly into the wall reads 0; one that folds back over the wall reads 180.
///   This is the angle the oriented normals make once the sheets are sewn into one consistently oriented shell,
///   whichever way each wall was oriented before, so it is the bound itself at every station;
/// - the jump in normal curvature across the edge, both sides read against the blend's own normal. Always measured.
StationStat measure_rim(
    const Handle(Geom_BSplineSurface)& surface,
    const TopoDS_Face& face,
    double u,
    double v_rim,
    const TopoDS_Face& hint,
    const std::vector<TopoDS_Face>& faces,
    int side) {
    StationStat stat;
    try {
        gp_Pnt point;
        gp_Vec du;
        gp_Vec dv;
        surface->D1(u, v_rim, point, du, dv);
        const double du_len = du.Magnitude();
        if (!(du_len > 1e-12)) return stat;
        const gp_Vec tangent = du / du_len;
        gp_Vec across = v_rim > 0.5 ? dv : dv.Reversed();
        across = project_off(across, tangent);
        if (!(across.Magnitude() > 1e-12)) return stat;
        across.Normalize();
        const TopoDS_Face wall = face_along(faces, hint, point, tangent);
        double su = 0.0;
        double sv = 0.0;
        if (!face_parameters(wall, point, su, sv)) return stat;
        BRepAdaptor_Surface wall_adapt(wall);
        BRepLProp_SLProps wall_props(wall_adapt, 2, 1e-9);
        wall_props.SetParameters(su, sv);
        if (!wall_props.IsNormalDefined()) return stat;
        const Transverse out_of = transverse_at(wall, wall_props.Value(), tangent, side);
        if (!out_of.ok || !(out_of.B.Magnitude() > 1e-12)) return stat;
        gp_Vec inward = project_off(out_of.B.Reversed(), tangent);
        if (!(inward.Magnitude() > 1e-12)) return stat;
        inward.Normalize();
        stat.samples = true;
        stat.gap = point.Distance(wall_props.Value());
        stat.angle = std::acos(clamp_unit(across.Dot(inward))) * (180.0 / M_PI);
        BRepAdaptor_Surface blend_adapt(face);
        BRepLProp_SLProps blend_props(blend_adapt, 2, 1e-9);
        blend_props.SetParameters(u, v_rim);
        if (!blend_props.IsNormalDefined()) return stat;
        const gp_Vec blend_normal(blend_props.Normal());
        const double align = gp_Vec(wall_props.Normal()).Dot(blend_normal) < 0.0 ? -1.0 : 1.0;
        const double ks = curvature_perp(blend_props, 1.0, tangent);
        const double kw = curvature_perp(wall_props, align, tangent);
        if (std::isfinite(ks) && std::isfinite(kw)) stat.jump = std::abs(ks - kw);
    } catch (const Standard_Failure&) {
        stat.samples = false;
    }
    return stat;
}

/// True when the blend folds back on itself somewhere between its two rims at one of the stations: its normal
/// vanishes, or turns over between two neighbouring samples across the span. A blend that bends round a U (two walls
/// of one extrusion) turns its normal gradually through 180 degrees and is not a fold.
bool blend_folds(const Handle(Geom_BSplineSurface)& surface) {
    constexpr int kAcross = 32;
    for (int s = 0; s < kHermiteStations; ++s) {
        const double u = 0.1 + 0.8 * (static_cast<double>(s) / (kHermiteStations - 1));
        gp_Vec previous;
        for (int k = 0; k <= kAcross; ++k) {
            gp_Pnt point;
            gp_Vec du;
            gp_Vec dv;
            surface->D1(u, static_cast<double>(k) / kAcross, point, du, dv);
            gp_Vec normal = du.Crossed(dv);
            const double scale = du.Magnitude() * dv.Magnitude();
            if (!(scale > 1e-18) || normal.Magnitude() < 1e-9 * scale) return true;
            normal.Normalize();
            if (k > 0 && normal.Dot(previous) <= 0.0) return true;
            previous = normal;
        }
    }
    return false;
}

int need_degree(int order) {
    return order >= 2 ? 5 : 3;
}

/// The tension a side was sent, or 1 when it was sent none (NaN from Rust). A tension of 0 or less is a refusal.
double tension_value(double raw, const char* side, std::string& error) {
    if (std::isnan(raw)) {
        return 1.0;
    }
    if (!(raw > 0.0) || !std::isfinite(raw)) {
        error = std::string(side) + " tension must be greater than 0.";
        return -1.0;
    }
    return raw;
}

struct SidePrep {
    Handle(Geom_BSplineCurve) full;
    Handle(Geom_BSplineCurve) from_start;
    Handle(Geom_BSplineCurve) from_end;
    TopoDS_Face face;
    int order = 0;
    double tension = 1.0;
    gp_Pnt mid;
    gp_Dir normal;
    bool has_normal = false;
    gp_Vec Ds;
    gp_Vec Dss;
    std::vector<double> extra_start;
    std::vector<double> extra_end;
    std::vector<int> edges;
};

struct SplitPrep {
    Handle(Geom_BSplineCurve) curve;
    gp_Vec Tm;
    gp_Vec Tc;
    gp_Vec A_end;
    std::vector<double> extra;
    gp_Vec R0_here;
    gp_Vec R1_here;
    gp_Vec R0_next;
    gp_Vec R1_next;
    gp_Vec A0;
    gp_Vec A1_here;
    gp_Vec A1_next;
};


bool shared_normal(
    const SplitPrep& split,
    const SidePrep& side,
    const gp_Dir& centre_normal,
    double s,
    gp_Dir& out,
    gp_Vec& tangent,
    std::string& error) {
    gp_Pnt point;
    gp_Vec d1;
    split.curve->D1(s, point, d1);
    if (d1.Magnitude() < 1e-12) {
        error = "The split on side " + std::to_string(side.order) + " is too short.";
        return false;
    }
    tangent = d1.Normalized();
    gp_Vec n0 = side.has_normal ? gp_Vec(side.normal) : gp_Vec(centre_normal);
    gp_Vec n1(centre_normal);
    if (n0.Magnitude() < 1e-12) n0 = n1;
    n0.Normalize();
    n1.Normalize();
    const double dot = clamp_unit(n0.Dot(n1));
    const double theta = std::acos(dot);
    gp_Vec raw = n0;
    if (theta >= 1e-9) {
        if (M_PI - theta < 1e-9) {
            error = "The normals on side " + std::to_string(&side - &side) + " point opposite ways, so the split has no shared plane.";
            return false;
        }
        const double denom = std::sin(theta);
        raw = n0.Multiplied(std::sin((1.0 - s) * theta) / denom).Added(n1.Multiplied(std::sin(s * theta) / denom));
    }
    gp_Vec n = project_off(raw, tangent);
    if (n.Magnitude() < 1e-9) {
        std::ostringstream msg;
        msg.setf(std::ios::fixed);
        msg.precision(3);
        msg << "The split tangent is parallel to the interpolated normal at s=" << s << ".";
        error = msg.str();
        return false;
    }
    n.Normalize();
    out = gp_Dir(n);
    return true;
}

bool cross_at(
    const SplitPrep& split,
    const SidePrep& side,
    const gp_Dir& centre_normal,
    double s,
    bool next_piece,
    bool want_a,
    gp_Vec& R,
    gp_Vec& A,
    std::string& error) {
    gp_Dir n;
    gp_Vec tangent;
    std::string local;
    if (!shared_normal(split, side, centre_normal, s, n, tangent, local)) {
        // shared_normal's opposite-normal sentence is rewritten by the caller with the side index.
        error = local;
        return false;
    }
    const gp_Vec r0 = next_piece ? split.R0_next : split.R0_here;
    const gp_Vec r1 = next_piece ? split.R1_next : split.R1_here;
    R = project_off(hermite_vec(s, r0, r1), gp_Vec(n));
    if (!want_a) {
        A = gp_Vec(0, 0, 0);
        return true;
    }
    const gp_Vec a0 = split.A0;
    const gp_Vec a1 = next_piece ? split.A1_next : split.A1_here;
    A = hermite_vec(s, a0, a1);
    const gp_Vec r_perp = project_off(R, tangent);
    const double rp2 = r_perp.SquareMagnitude();
    if (!(rp2 > 1e-18)) {
        std::ostringstream msg;
        msg.setf(std::ios::fixed);
        msg.precision(3);
        msg << "The cross field on side " << 0 << " vanished at s=" << s << ".";
        error = msg.str();
        return false;
    }
    (void)rp2;
    return true;
}

// κ match is applied by the caller once both pieces' A are known. This helper
// rewrites the normal part of A and leaves the tangential part with the piece.
gp_Vec match_kappa(const gp_Vec& A, const gp_Vec& R, const gp_Vec& tangent, const gp_Dir& n, double kappa_star, std::string& error, int side, double s) {
    const gp_Vec r_perp = project_off(R, tangent);
    const double rp2 = r_perp.SquareMagnitude();
    if (!(rp2 > 1e-18)) {
        std::ostringstream msg;
        msg.setf(std::ios::fixed);
        msg.precision(3);
        msg << "The cross field on side " << side << " vanished at s=" << s << ".";
        error = msg.str();
        return A;
    }
    const gp_Vec nn(n);
    return project_off(A, nn).Added(nn.Multiplied(kappa_star * rp2));
}

double kappa_of(const gp_Vec& A, const gp_Vec& R, const gp_Vec& tangent, const gp_Dir& n, bool& ok) {
    const gp_Vec r_perp = project_off(R, tangent);
    const double rp2 = r_perp.SquareMagnitude();
    if (!(rp2 > 1e-18)) {
        ok = false;
        return 0.0;
    }
    ok = true;
    return A.Dot(gp_Vec(n)) / rp2;
}

struct BuiltPiece {
    TopoDS_Face face;
    Handle(Geom_BSplineSurface) surface;
    Handle(Geom_BSplineCurve) u0;
    Handle(Geom_BSplineCurve) u1;
    Handle(Geom_BSplineCurve) v0;
    Handle(Geom_BSplineCurve) v1;
};

std::vector<double> flat_knots_surface_u(const Handle(Geom_BSplineSurface)& surface) {
    std::vector<double> flat;
    for (int i = 1; i <= surface->NbUKnots(); ++i) {
        for (int m = 0; m < surface->UMultiplicity(i); ++m) flat.push_back(surface->UKnot(i));
    }
    return flat;
}

std::vector<double> flat_knots_surface_v(const Handle(Geom_BSplineSurface)& surface) {
    std::vector<double> flat;
    for (int i = 1; i <= surface->NbVKnots(); ++i) {
        for (int m = 0; m < surface->VMultiplicity(i); ++m) flat.push_back(surface->VKnot(i));
    }
    return flat;
}

bool push_knot(std::vector<double>& extra, const Handle(Geom_BSplineCurve)& curve, double frac, bool& too_short) {
    const double t = std::clamp(frac, 0.0, 1.0);
    double lo = 0.0;
    double hi = 1.0;
    for (int i = 1; i < curve->NbKnots(); ++i) {
        const double a = curve->Knot(i);
        const double b = curve->Knot(i + 1);
        if (b <= a + 1e-15) continue;
        if (t >= a - 1e-12 && t <= b + 1e-12) {
            lo = a;
            hi = b;
            break;
        }
    }
    const double mid = 0.5 * (lo + hi);
    const double total = std::max(curve_length(curve), 1e-9);
    gp_Pnt p0;
    gp_Pnt p1;
    curve->D0(lo, p0);
    curve->D0(hi, p1);
    const double span = std::max(p0.Distance(p1), (hi - lo) * total);
    if (span < 1e-3 * total) {
        too_short = true;
        return false;
    }
    for (double have : extra) {
        if (std::abs(have - mid) < 1e-4) return false;
    }
    if (static_cast<int>(extra.size()) >= 24) {
        too_short = true;
        return false;
    }
    extra.push_back(mid);
    return true;
}

gp_Vec end_derivative(const Handle(Geom_BSplineCurve)& curve, bool at_end) {
    gp_Pnt point;
    gp_Vec d1;
    curve->D1(at_end ? curve->LastParameter() : curve->FirstParameter(), point, d1);
    return d1;
}

BuiltPiece build_one_piece(
    int index,
    int count,
    std::vector<SidePrep>& sides,
    std::vector<SplitPrep>& splits,
    const gp_Pnt& centre,
    const gp_Dir& centre_normal,
    int min_degree,
    const std::vector<std::array<double, 3>>& points,
    double max_radius,
    std::string& error) {
    BuiltPiece built;
    const int prev = (index + count - 1) % count;
    Handle(Geom_BSplineCurve) v0 = with_extra_knots(sides[static_cast<size_t>(index)].from_start, sides[static_cast<size_t>(index)].extra_start, min_degree);
    Handle(Geom_BSplineCurve) u0 = with_extra_knots(sides[static_cast<size_t>(prev)].from_end, sides[static_cast<size_t>(prev)].extra_end, min_degree);
    Handle(Geom_BSplineCurve) u1 = with_extra_knots(splits[static_cast<size_t>(index)].curve, splits[static_cast<size_t>(index)].extra, min_degree);
    Handle(Geom_BSplineCurve) v1 = with_extra_knots(splits[static_cast<size_t>(prev)].curve, splits[static_cast<size_t>(prev)].extra, min_degree);
    if (!unify_pair(u0, u1, error) || !unify_pair(v0, v1, error)) return {};
    const int nu = u0->NbPoles() > 0 ? v0->NbPoles() : 0;
    const int nv = u0->NbPoles();
    if (v0->NbPoles() < 4 || u0->NbPoles() < 4) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    const int n_u = v0->NbPoles();
    const int n_v = u0->NbPoles();
    (void)nu;
    (void)nv;
    std::vector<std::vector<gp_Pnt>> poles(static_cast<size_t>(n_u), std::vector<gp_Pnt>(static_cast<size_t>(n_v), centre));
    std::vector<std::vector<char>> locked(static_cast<size_t>(n_u), std::vector<char>(static_cast<size_t>(n_v), 0));
    std::vector<std::vector<int>> claims(static_cast<size_t>(n_u), std::vector<int>(static_cast<size_t>(n_v), 0));
    auto set_locked = [&](int i, int j, const gp_Pnt& point) {
        poles[static_cast<size_t>(i)][static_cast<size_t>(j)] = point;
        locked[static_cast<size_t>(i)][static_cast<size_t>(j)] = 1;
    };
    for (int i = 0; i < n_u; ++i) set_locked(i, 0, v0->Pole(i + 1));
    for (int i = 0; i < n_u; ++i) set_locked(i, n_v - 1, v1->Pole(i + 1));
    for (int j = 0; j < n_v; ++j) set_locked(0, j, u0->Pole(j + 1));
    for (int j = 0; j < n_v; ++j) set_locked(n_u - 1, j, u1->Pole(j + 1));
    const gp_Pnt corners[4] = {poles[0][0], poles[static_cast<size_t>(n_u - 1)][0], poles[0][static_cast<size_t>(n_v - 1)], poles[static_cast<size_t>(n_u - 1)][static_cast<size_t>(n_v - 1)]};
    (void)corners;
    const double corner_tol = 1e-3;
    if (v0->StartPoint().Distance(u0->StartPoint()) > corner_tol
        || v0->EndPoint().Distance(u1->StartPoint()) > corner_tol
        || u0->EndPoint().Distance(v1->StartPoint()) > corner_tol
        || u1->EndPoint().Distance(v1->EndPoint()) > corner_tol) {
        error = "The boundary curves of a piece do not meet.";
        return {};
    }
    const std::vector<double> flat_u = flat_knots(v0);
    const std::vector<double> flat_v = flat_knots(u0);
    const int deg_u = v0->Degree();
    const int deg_v = u0->Degree();
    for (int i = 1; i < n_u - 1; ++i) {
        for (int j = 1; j < n_v - 1; ++j) {
            const double su = greville_of(flat_u, deg_u, i);
            const double sv = greville_of(flat_v, deg_v, j);
            const gp_Pnt south = v0->Value(su);
            const gp_Pnt north = v1->Value(su);
            const gp_Pnt west = u0->Value(sv);
            const gp_Pnt east = u1->Value(sv);
            const gp_XYZ blend = south.XYZ() * (1.0 - sv) + north.XYZ() * sv + west.XYZ() * (1.0 - su) + east.XYZ() * su
                - (poles[0][0].XYZ() * (1.0 - su) * (1.0 - sv) + poles[static_cast<size_t>(n_u - 1)][0].XYZ() * su * (1.0 - sv)
                   + poles[0][static_cast<size_t>(n_v - 1)].XYZ() * (1.0 - su) * sv
                   + poles[static_cast<size_t>(n_u - 1)][static_cast<size_t>(n_v - 1)].XYZ() * su * sv);
            poles[static_cast<size_t>(i)][static_cast<size_t>(j)] = gp_Pnt(blend);
        }
    }

    const EndScale v_start = scales_from_flat(flat_v, deg_v);
    const EndScale v_end = end_scales(flat_v, deg_v);
    const EndScale u_start = scales_from_flat(flat_u, deg_u);
    const EndScale u_end = end_scales(flat_u, deg_u);
    if (!v_start.ok || !v_end.ok || !u_start.ok || !u_end.ok) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }

    auto sample_outer = [&](const SidePrep& side, const Handle(Geom_BSplineCurve)& curve, double t, gp_Vec& outv) -> bool {
        gp_Pnt point;
        gp_Vec tangent;
        curve->D1(t, point, tangent);
        if (side.order <= 0 || side.face.IsNull()) {
            outv = gp_Vec(point, centre);
            return true;
        }
        const Transverse got = transverse_at(side.face, point, tangent, 0);
        if (!got.ok) {
            error = got.error;
            return false;
        }
        const double g = std::max(point.Distance(centre), 1e-6);
        outv = got.Ds.Multiplied(side.tension * g);
        return true;
    };
    auto sample_second = [&](const SidePrep& side, const Handle(Geom_BSplineCurve)& curve, double t, gp_Vec& outv) -> bool {
        gp_Pnt point;
        gp_Vec tangent;
        curve->D1(t, point, tangent);
        if (side.order < 2 || side.face.IsNull()) {
            outv = gp_Vec(0, 0, 0);
            return true;
        }
        const Transverse got = transverse_at(side.face, point, tangent, 0);
        if (!got.ok) {
            error = got.error;
            return false;
        }
        const double g = std::max(point.Distance(centre), 1e-6);
        const double lambda = side.tension * g;
        outv = got.Dss.Multiplied(lambda * lambda);
        return true;
    };

    auto write_first = [&](int fixed, bool row, bool at_start, double alpha, auto&& sampler) -> bool {
        const int n = row ? n_u : n_v;
        const std::vector<double>& flat = row ? flat_u : flat_v;
        const int degree = row ? deg_u : deg_v;
        const int boundary = at_start ? 0 : (row ? n_v - 1 : n_u - 1);
        const int ribbon = at_start ? boundary + 1 : boundary - 1;
        std::vector<gp_Vec> samples(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) {
            if (!sampler(greville_of(flat, degree, i), samples[static_cast<size_t>(i)])) return false;
        }
        const bool lock = true;
        gp_Vec q0;
        gp_Vec qn;
        auto pole_at = [&](int along, int cross) -> gp_Pnt& {
            if (row) return poles[static_cast<size_t>(along)][static_cast<size_t>(cross)];
            return poles[static_cast<size_t>(cross)][static_cast<size_t>(along)];
        };
        auto locked_at = [&](int along, int cross) -> bool {
            if (row) return locked[static_cast<size_t>(along)][static_cast<size_t>(cross)] != 0;
            return locked[static_cast<size_t>(cross)][static_cast<size_t>(along)] != 0;
        };
        const gp_Vec d0(pole_at(0, boundary), pole_at(0, ribbon));
        const gp_Vec dn(pole_at(n - 1, boundary), pole_at(n - 1, ribbon));
        q0 = at_start ? d0.Multiplied(alpha) : d0.Multiplied(-alpha);
        qn = at_start ? dn.Multiplied(alpha) : dn.Multiplied(-alpha);
        std::vector<gp_Vec> controls;
        if (!interpolate_controls(flat, degree, n, samples, lock, q0, qn, controls, error)) return false;
        for (int i = 0; i < n; ++i) {
            if (locked_at(i, ribbon)) continue;
            gp_Pnt next = at_start
                ? gp_Pnt(pole_at(i, boundary).XYZ() + controls[static_cast<size_t>(i)].XYZ() / alpha)
                : gp_Pnt(pole_at(i, boundary).XYZ() - controls[static_cast<size_t>(i)].XYZ() / alpha);
            auto& claim = row ? claims[static_cast<size_t>(i)][static_cast<size_t>(ribbon)]
                              : claims[static_cast<size_t>(ribbon)][static_cast<size_t>(i)];
            auto& slot = pole_at(i, ribbon);
            if (claim == 0) {
                slot = next;
                claim = 1;
            } else {
                slot = gp_Pnt(0.5 * (slot.XYZ() + next.XYZ()));
                claim += 1;
            }
        }
        (void)fixed;
        return true;
    };

    SidePrep& side_i = sides[static_cast<size_t>(index)];
    SidePrep& side_prev = sides[static_cast<size_t>(prev)];
    if (!write_first(0, true, true, v_start.alpha0, [&](double t, gp_Vec& o) { return sample_outer(side_i, v0, t, o); })) return {};
    if (!write_first(0, false, true, u_start.alpha0, [&](double t, gp_Vec& o) { return sample_outer(side_prev, u0, t, o); })) return {};

    auto sample_split = [&](int split_index, bool next_piece, double t, gp_Vec& outv) -> bool {
        std::string local;
        gp_Vec A;
        const bool want = false;
        if (!cross_at(splits[static_cast<size_t>(split_index)], sides[static_cast<size_t>(split_index)], centre_normal, t, next_piece, want, outv, A, local)) {
            if (local.find("opposite") != std::string::npos) {
                error = "The normals on side " + std::to_string(split_index) + " point opposite ways, so the split has no shared plane.";
            } else if (local.find("parallel") != std::string::npos || local.find("vanished") != std::string::npos) {
                std::ostringstream msg;
                msg.setf(std::ios::fixed);
                msg.precision(3);
                msg << "The split tangent on side " << split_index << " is parallel to the interpolated normal at s=" << t << ".";
                error = msg.str();
            } else {
                error = local.empty() ? "Open CASCADE could not fill this opening." : local;
            }
            return false;
        }
        return true;
    };
    // Piece i stores ∂S/∂u along its u=1 split (split index). The next piece stores ∂S/∂v along its v=1, which is the same split.
    if (!write_first(0, false, false, u_end.alpha0, [&](double t, gp_Vec& o) { return sample_split(index, false, t, o); })) return {};
    if (!write_first(0, true, false, v_end.alpha0, [&](double t, gp_Vec& o) { return sample_split(prev, true, t, o); })) return {};

    if (min_degree >= 5 && n_v >= 6 && n_u >= 6) {
        auto write_second = [&](bool row, bool at_start, const EndScale& scale, auto&& sampler) -> bool {
            const int n = row ? n_u : n_v;
            const std::vector<double>& flat = row ? flat_u : flat_v;
            const int degree = row ? deg_u : deg_v;
            const int last = row ? n_v : n_u;
            const int boundary = at_start ? 0 : last - 1;
            const int first = at_start ? 1 : last - 2;
            const int second = at_start ? 2 : last - 3;
            std::vector<gp_Vec> samples(static_cast<size_t>(n));
            for (int i = 0; i < n; ++i) {
                if (!sampler(greville_of(flat, degree, i), samples[static_cast<size_t>(i)])) return false;
            }
            auto pole_at = [&](int along, int cross) -> gp_Pnt& {
                if (row) return poles[static_cast<size_t>(along)][static_cast<size_t>(cross)];
                return poles[static_cast<size_t>(cross)][static_cast<size_t>(along)];
            };
            auto locked_at = [&](int along, int cross) -> bool {
                if (row) return locked[static_cast<size_t>(along)][static_cast<size_t>(cross)] != 0;
                return locked[static_cast<size_t>(cross)][static_cast<size_t>(along)] != 0;
            };
            std::vector<gp_Vec> known(static_cast<size_t>(n));
            for (int i = 0; i < n; ++i) {
                const gp_Vec d01(pole_at(i, boundary), pole_at(i, first));
                const double signed_d = at_start ? scale.alpha0 : -scale.alpha0;
                known[static_cast<size_t>(i)] = d01.Multiplied(signed_d);
            }
            // C = beta * (alpha1 * (P2 - P1) - Q0) at the start, rearranged after the solve.
            gp_Vec c0;
            gp_Vec cn;
            auto second_of = [&](int i) -> gp_Vec {
                const gp_Vec q0 = known[static_cast<size_t>(i)];
                const gp_Vec d12(pole_at(i, first), pole_at(i, second));
                const double signed_a = at_start ? scale.alpha1 : -scale.alpha1;
                const gp_Vec q1 = d12.Multiplied(signed_a);
                return at_start ? q1.Subtracted(q0).Multiplied(scale.beta) : q0.Subtracted(q1).Multiplied(scale.beta);
            };
            c0 = second_of(0);
            cn = second_of(n - 1);
            std::vector<gp_Vec> controls;
            if (!interpolate_controls(flat, degree, n, samples, true, c0, cn, controls, error)) return false;
            for (int i = 0; i < n; ++i) {
                if (locked_at(i, second)) continue;
                const gp_Vec q0 = known[static_cast<size_t>(i)];
                gp_Pnt next;
                if (at_start) {
                    const gp_Vec q1 = q0.Added(controls[static_cast<size_t>(i)].Multiplied(1.0 / scale.beta));
                    next = gp_Pnt(pole_at(i, first).XYZ() + q1.XYZ() / scale.alpha1);
                } else {
                    const gp_Vec q1 = q0.Subtracted(controls[static_cast<size_t>(i)].Multiplied(1.0 / scale.beta));
                    next = gp_Pnt(pole_at(i, first).XYZ() - q1.XYZ() / scale.alpha1);
                }
                auto& claim = row ? claims[static_cast<size_t>(i)][static_cast<size_t>(second)]
                                  : claims[static_cast<size_t>(second)][static_cast<size_t>(i)];
                auto& slot = pole_at(i, second);
                if (claim == 0) {
                    slot = next;
                    claim = 1;
                } else {
                    slot = gp_Pnt(0.5 * (slot.XYZ() + next.XYZ()));
                    claim += 1;
                }
            }
            return true;
        };
        if (!write_second(true, true, v_start, [&](double t, gp_Vec& o) { return sample_second(side_i, v0, t, o); })) return {};
        if (!write_second(false, true, u_start, [&](double t, gp_Vec& o) { return sample_second(side_prev, u0, t, o); })) return {};
        {
            auto second_split = [&](int split_index, bool next_piece, double t, gp_Vec& outv) -> bool {
                if (sides[static_cast<size_t>(split_index)].order < 2) {
                    outv = gp_Vec(0, 0, 0);
                    return true;
                }
                gp_Vec R;
                gp_Vec A;
                gp_Dir n;
                gp_Vec tangent;
                std::string local;
                if (!shared_normal(splits[static_cast<size_t>(split_index)].curve.IsNull() ? splits[static_cast<size_t>(split_index)] : splits[static_cast<size_t>(split_index)], sides[static_cast<size_t>(split_index)], centre_normal, t, n, tangent, local)) {
                    error = "The normals on side " + std::to_string(split_index) + " point opposite ways, so the split has no shared plane.";
                    if (local.find("parallel") != std::string::npos) {
                        std::ostringstream msg;
                        msg.setf(std::ios::fixed);
                        msg.precision(3);
                        msg << "The split tangent on side " << split_index << " is parallel to the interpolated normal at s=" << t << ".";
                        error = msg.str();
                    }
                    return false;
                }
                if (!cross_at(splits[static_cast<size_t>(split_index)], sides[static_cast<size_t>(split_index)], centre_normal, t, next_piece, true, R, A, local)) {
                    error = local;
                    return false;
                }
                gp_Vec R_other;
                gp_Vec A_other;
                if (!cross_at(splits[static_cast<size_t>(split_index)], sides[static_cast<size_t>(split_index)], centre_normal, t, !next_piece, true, R_other, A_other, local)) {
                    error = local;
                    return false;
                }
                bool ok_a = true;
                bool ok_b = true;
                const double ka = kappa_of(A, R, tangent, n, ok_a);
                const double kb = kappa_of(A_other, R_other, tangent, n, ok_b);
                if (!ok_a || !ok_b) {
                    std::ostringstream msg;
                    msg.setf(std::ios::fixed);
                    msg.precision(3);
                    msg << "The cross field on side " << split_index << " vanished at s=" << t << ".";
                    error = msg.str();
                    return false;
                }
                outv = match_kappa(A, R, tangent, n, 0.5 * (ka + kb), error, split_index, t);
                return error.empty() || error.find("vanished") == std::string::npos;
            };
            if (!write_second(false, false, u_end, [&](double t, gp_Vec& o) { return second_split(index, false, t, o); })) return {};
            if (!write_second(true, false, v_end, [&](double t, gp_Vec& o) { return second_split(prev, true, t, o); })) return {};
        }
    }

    for (int i = 1; i < n_u - 1; ++i) {
        int lo = 0;
        int hi = n_v - 1;
        for (int j = 1; j < n_v - 1; ++j) {
            if (claims[static_cast<size_t>(i)][static_cast<size_t>(j)] == 0 && locked[static_cast<size_t>(i)][static_cast<size_t>(j)] == 0) {
                int a = j - 1;
                while (a > 0 && claims[static_cast<size_t>(i)][static_cast<size_t>(a)] == 0 && locked[static_cast<size_t>(i)][static_cast<size_t>(a)] == 0) --a;
                int b = j + 1;
                while (b < n_v - 1 && claims[static_cast<size_t>(i)][static_cast<size_t>(b)] == 0 && locked[static_cast<size_t>(i)][static_cast<size_t>(b)] == 0) ++b;
                const double t = static_cast<double>(j - a) / static_cast<double>(b - a);
                poles[static_cast<size_t>(i)][static_cast<size_t>(j)] = gp_Pnt(
                    poles[static_cast<size_t>(i)][static_cast<size_t>(a)].XYZ() * (1.0 - t)
                    + poles[static_cast<size_t>(i)][static_cast<size_t>(b)].XYZ() * t);
                (void)lo;
                (void)hi;
            }
        }
    }

    TColgp_Array2OfPnt grid(1, n_u, 1, n_v);
    for (int i = 0; i < n_u; ++i) {
        for (int j = 0; j < n_v; ++j) grid.SetValue(i + 1, j + 1, poles[static_cast<size_t>(i)][static_cast<size_t>(j)]);
    }
    TColStd_Array1OfReal uk(1, v0->NbKnots());
    TColStd_Array1OfInteger um(1, v0->NbKnots());
    v0->Knots(uk);
    v0->Multiplicities(um);
    TColStd_Array1OfReal vk(1, u0->NbKnots());
    TColStd_Array1OfInteger vm(1, u0->NbKnots());
    u0->Knots(vk);
    u0->Multiplicities(vm);
    Handle(Geom_BSplineSurface) surface;
    try {
        const bool rational = v0->IsRational() || v1->IsRational() || u0->IsRational() || u1->IsRational();
        if (rational) {
            TColStd_Array2OfReal weights(1, n_u, 1, n_v);
            for (int i = 1; i <= n_u; ++i) {
                for (int j = 1; j <= n_v; ++j) weights.SetValue(i, j, 1.0);
            }
            for (int i = 1; i <= n_u; ++i) {
                weights.SetValue(i, 1, v0->Weight(i));
                weights.SetValue(i, n_v, v1->Weight(i));
            }
            for (int j = 1; j <= n_v; ++j) {
                weights.SetValue(1, j, u0->Weight(j));
                weights.SetValue(n_u, j, u1->Weight(j));
            }
            surface = new Geom_BSplineSurface(grid, weights, uk, vk, um, vm, deg_u, deg_v);
        } else {
            surface = new Geom_BSplineSurface(grid, uk, vk, um, vm, deg_u, deg_v);
        }
    } catch (const Standard_Failure& failure) {
        error = failure.GetMessageString() ? failure.GetMessageString() : "Open CASCADE could not fill this opening.";
        return {};
    }

    // Step 10. `points` are the guide points that project into this piece. A guide moves only the free interior pole
    // that weighs most at the guide, along N_c, never a boundary row, a ribbon row (one beside each boundary for G1,
    // two for G2) or a split row. Moving it changes the surface only where that pole's basis reaches, and that basis
    // and its first `depth` derivatives are zero on every boundary, so the asked continuity is kept.
    if (!points.empty() && max_radius > 0.0) {
        for (const std::array<double, 3>& raw : points) {
            const gp_Pnt guide(raw[0], raw[1], raw[2]);
            if (guide.Distance(centre) <= kHermiteGapMm) continue;
            try {
                GeomAPI_ProjectPointOnSurf proj(guide, surface);
                if (proj.NbPoints() > 0 && proj.LowerDistance() <= kHermiteGapMm) continue;
            } catch (const Standard_Failure&) {
            }
            try {
                surface->InsertUKnot(0.5, 1, 1e-9, Standard_False);
                surface->InsertVKnot(0.5, 1, 1e-9, Standard_False);
            } catch (const Standard_Failure&) {
            }
            const int depth = min_degree >= 5 ? 2 : 1;
            const int first_u = 2 + depth;
            const int last_u = surface->NbUPoles() - 1 - depth;
            const int first_v = 2 + depth;
            const int last_v = surface->NbVPoles() - 1 - depth;
            if (first_u > last_u || first_v > last_v) {
                error = "A guide point needs a free pole inside the patch, and this piece has none.";
                return {};
            }
            bool reached = false;
            for (int attempt = 0; attempt < 30 && !reached; ++attempt) {
                double uu = 0.5;
                double vv = 0.5;
                double off = 1e300;
                try {
                    GeomAPI_ProjectPointOnSurf proj(guide, surface);
                    if (proj.NbPoints() > 0) {
                        proj.LowerDistanceParameters(uu, vv);
                        off = proj.LowerDistance();
                    }
                } catch (const Standard_Failure&) {
                }
                if (off <= 1e-6) {
                    reached = true;
                    break;
                }
                std::vector<double> bu;
                std::vector<double> bv;
                bspline_basis(flat_knots_surface_u(surface), surface->UDegree(), surface->NbUPoles(), uu, bu);
                bspline_basis(flat_knots_surface_v(surface), surface->VDegree(), surface->NbVPoles(), vv, bv);
                int best_i = -1;
                int best_j = -1;
                double scale = 0.0;
                for (int i = first_u; i <= last_u; ++i) {
                    for (int j = first_v; j <= last_v; ++j) {
                        const double weight = bu[static_cast<size_t>(i - 1)] * bv[static_cast<size_t>(j - 1)];
                        if (weight > scale) {
                            scale = weight;
                            best_i = i;
                            best_j = j;
                        }
                    }
                }
                if (best_i < 0 || scale < 1e-8) break;
                gp_Pnt at;
                surface->D0(uu, vv, at);
                const double k = gp_Vec(at, guide).Dot(gp_Vec(centre_normal)) / scale;
                if (std::abs(k) < 1e-12) break;
                const gp_Pnt moved(surface->Pole(best_i, best_j).XYZ() + gp_Vec(centre_normal).XYZ() * k);
                if (moved.Distance(centre) > 2.0 * max_radius) {
                    error = "A guide point would land farther from the centre than the fill allows.";
                    return {};
                }
                surface->SetPole(best_i, best_j, moved);
            }
            double off = 1e300;
            try {
                GeomAPI_ProjectPointOnSurf proj(guide, surface);
                if (proj.NbPoints() > 0) off = proj.LowerDistance();
            } catch (const Standard_Failure&) {
            }
            g_guide_off = std::max(g_guide_off, off);
            if (!(off <= kHermiteGapMm)) {
                error = "A guide point is off the patch along its centre normal, so moving the free pole cannot reach it. Move the point over the opening.";
                return {};
            }
        }
    }

    BRepBuilderAPI_MakeFace maker(surface, 1e-7);
    if (!maker.IsDone() || maker.Face().IsNull()) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    TopoDS_Face face = maker.Face();
    const TopoDS_Face& support = side_i.face.IsNull() ? side_prev.face : side_i.face;
    if (!support.IsNull()) {
        gp_Pnt mid;
        gp_Vec du;
        gp_Vec dv;
        surface->D1(0.5, 0.0, mid, du, dv);
        gp_Vec n = du.Crossed(dv);
        double su = 0.0;
        double sv = 0.0;
        if (n.Magnitude() > 1e-12 && face_parameters(support, mid, su, sv)) {
            BRepAdaptor_Surface adapt(support);
            BRepLProp_SLProps props(adapt, 1, 1e-9);
            props.SetParameters(su, sv);
            if (props.IsNormalDefined()) {
                gp_Dir sn = props.Normal();
                if (support.Orientation() == TopAbs_REVERSED) sn.Reverse();
                if (n.Dot(gp_Vec(sn)) < 0.0) face.Reverse();
            }
        }
    }
    built.face = face;
    built.surface = surface;
    built.u0 = u0;
    built.u1 = u1;
    built.v0 = v0;
    built.v1 = v1;
    return built;
}

// Step 11. A G2 edge whose curvature jump is still over the bound, once knots can go no
// further, is a refusal. The face is not built. The sentence names the asked edge.
std::string refusal_sentence(
    const std::vector<EdgeReport>& reports,
    const std::vector<SidePrep>& sides) {
    std::vector<int> edges;
    AskedWorst g2;
    for (const EdgeReport& report : reports) {
        if (report.asked < 2 || !(report.jump > kHermiteJump)) continue;
        g2.any = true;
        g2.gap = std::max(g2.gap, report.gap);
        g2.angle = std::max(g2.angle, report.angle_dev);
        g2.jump = std::max(g2.jump, report.jump);
        g2.asked = 2;
        if (report.side < 0 || report.side >= static_cast<int>(sides.size())) continue;
        const std::vector<int>& ids = sides[static_cast<size_t>(report.side)].edges;
        edges.insert(edges.end(), ids.begin(), ids.end());
    }
    if (!edges.empty()) {
        std::sort(edges.begin(), edges.end());
        edges.erase(std::unique(edges.begin(), edges.end()), edges.end());
        std::ostringstream out;
        if (edges.size() == 1) {
            out << "Edge " << edges[0];
        } else {
            out << "Edges " << edges[0];
            for (size_t i = 1; i + 1 < edges.size(); ++i) out << ", " << edges[i];
            out << " and " << edges.back();
        }
        // G2 was asked, so the sentence carries the gap, the plane deviation,
        // and the curvature jump. It does not carry a raw 180° reading.
        out << ": G2 can't be reached at this curvature. " << asked_measures(g2.gap, g2.angle, g2.jump, 2);
        return out.str();
    }
    return miss_sentence(reports);
}

TopoDS_Shape fill_hermite_patch(
    const TopoDS_Shape& current,
    const std::vector<Handle(Geom_BSplineCurve)>& curves,
    const std::vector<TopoDS_Face>& faces,
    const std::vector<int>& orders,
    const std::vector<std::vector<int>>& edge_ids,
    const std::vector<std::array<double, 3>>& points,
    std::string& error) {
    const int count = static_cast<int>(curves.size());
    if (count < 3 || count > 20 || static_cast<int>(faces.size()) != count || static_cast<int>(orders.size()) != count) {
        error = "A patch needs between 2 and 20 boundary curves or edges.";
        return {};
    }
    std::vector<SidePrep> sides(static_cast<size_t>(count));
    gp_Pnt centre(0, 0, 0);
    int samples = 0;
    gp_Vec normal_sum(0, 0, 0);
    std::vector<gp_Pnt> cloud;
    int max_order = 0;
    for (int i = 0; i < count; ++i) {
        SidePrep& side = sides[static_cast<size_t>(i)];
        side.full = copy_curve(curves[static_cast<size_t>(i)]);
        reparam_01(side.full);
        side.face = faces[static_cast<size_t>(i)];
        side.order = orders[static_cast<size_t>(i)];
        side.tension = 1.0;
        if (static_cast<int>(edge_ids.size()) == count) side.edges = edge_ids[static_cast<size_t>(i)];
        max_order = std::max(max_order, side.order);
        side.from_start = half_curve(side.full, true, error);
        side.from_end = half_curve(side.full, false, error);
        if (side.from_start.IsNull() || side.from_end.IsNull()) return {};
        const double mid_param = param_at_fraction(side.full, 0.5);
        side.mid = side.full->Value(mid_param);
        gp_Pnt ignored;
        gp_Vec tangent;
        side.full->D1(mid_param, ignored, tangent);
        if (!side.face.IsNull() && side.order > 0) {
            const Transverse got = transverse_at(side.face, side.mid, tangent, i);
            if (!got.ok) {
                error = got.error;
                return {};
            }
            side.Ds = got.Ds;
            side.Dss = got.Dss;
            side.normal = got.normal;
            side.has_normal = true;
            normal_sum.Add(gp_Vec(got.normal));
        }
        for (int s = 0; s < 16; ++s) {
            const gp_Pnt p = side.full->Value(param_at_fraction(side.full, static_cast<double>(s) / 15.0));
            centre.SetXYZ(centre.XYZ() + p.XYZ());
            cloud.push_back(p);
            samples += 1;
        }
    }
    if (samples == 0) {
        error = "Open CASCADE could not fill this opening.";
        return {};
    }
    centre.SetXYZ(centre.XYZ() / static_cast<double>(samples));
    gp_Dir centre_normal(0, 0, 1);
    if (normal_sum.Magnitude() > 1e-9) {
        centre_normal = gp_Dir(normal_sum);
    } else if (cloud.size() >= 3) {
        gp_Vec n(0, 0, 0);
        for (size_t i = 0; i < cloud.size(); ++i) {
            const gp_Pnt& a = cloud[i];
            const gp_Pnt& b = cloud[(i + 1) % cloud.size()];
            n.SetX(n.X() + (a.Y() - b.Y()) * (a.Z() + b.Z()));
            n.SetY(n.Y() + (a.Z() - b.Z()) * (a.X() + b.X()));
            n.SetZ(n.Z() + (a.X() - b.X()) * (a.Y() + b.Y()));
        }
        if (n.Magnitude() > 1e-9) centre_normal = gp_Dir(n);
    }
    double max_radius = 0.0;
    for (const gp_Pnt& p : cloud) max_radius = std::max(max_radius, centre.Distance(p));

    std::vector<SplitPrep> splits(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i) {
        SidePrep& side = sides[static_cast<size_t>(i)];
        const gp_Vec toward(side.mid, centre);
        gp_Vec dir = side.has_normal ? project_off(side.Ds, gp_Vec(side.normal)) : toward;
        if (dir.Magnitude() < 1e-9) dir = project_off(toward, side.has_normal ? gp_Vec(side.normal) : gp_Vec(centre_normal));
        if (dir.Magnitude() < 1e-9) dir = toward;
        if (dir.Magnitude() < 1e-12) {
            error = "Open CASCADE could not fill this opening.";
            return {};
        }
        const double length = std::max(toward.Magnitude(), 1e-6);
        dir.Normalize();
        dir.Multiply(length);
        gp_Vec tc = project_off(toward, gp_Vec(centre_normal));
        if (tc.Magnitude() < 1e-9) tc = toward;
        tc.Normalize();
        tc.Multiply(length);
        const gp_Pnt q0 = side.mid;
        const gp_Pnt q1(side.mid.XYZ() + dir.XYZ() / 3.0);
        const gp_Pnt q2(centre.XYZ() - tc.XYZ() / 3.0);
        const gp_Pnt q3 = centre;
        splits[static_cast<size_t>(i)].curve = cubic_bezier(q0, q1, q2, q3);
        splits[static_cast<size_t>(i)].Tm = dir;
        splits[static_cast<size_t>(i)].Tc = tc;
        gp_Pnt at;
        gp_Vec d1;
        gp_Vec d2;
        splits[static_cast<size_t>(i)].curve->D2(1.0, at, d1, d2);
        splits[static_cast<size_t>(i)].A_end = d2;
        const double g = length;
        const double lambda = side.tension * g;
        splits[static_cast<size_t>(i)].A0 = side.order <= 0 ? gp_Vec(0, 0, 0) : side.Dss.Multiplied(lambda * lambda);
    }
    for (int i = 0; i < count; ++i) {
        const int prev = (i + count - 1) % count;
        const int next = (i + 1) % count;
        // Piece i along split i: R(0) is the v=0 half's end tangent, R(1) is Tc of split i-1.
        splits[static_cast<size_t>(i)].R0_here = end_derivative(sides[static_cast<size_t>(i)].from_start, true);
        splits[static_cast<size_t>(i)].R1_here = splits[static_cast<size_t>(prev)].Tc;
        splits[static_cast<size_t>(i)].A1_here = splits[static_cast<size_t>(prev)].A_end;
        // Piece i+1 along the same split: R(0) is its u=0 half's end tangent (side i from the far vertex), R(1) is Tc of split i+1.
        splits[static_cast<size_t>(i)].R0_next = end_derivative(sides[static_cast<size_t>(i)].from_end, true);
        splits[static_cast<size_t>(i)].R1_next = splits[static_cast<size_t>(next)].Tc;
        splits[static_cast<size_t>(i)].A1_next = splits[static_cast<size_t>(next)].A_end;
    }

    const int min_degree = need_degree(max_order);
    // Each guide point goes to the one piece it lies closest to, built without guides, and moves only that piece.
    g_guide_off = -1.0;
    std::vector<std::vector<std::array<double, 3>>> guides_of(static_cast<size_t>(count));
    if (!points.empty()) {
        std::vector<Handle(Geom_BSplineSurface)> bare;
        for (int i = 0; i < count; ++i) {
            const BuiltPiece piece = build_one_piece(i, count, sides, splits, centre, centre_normal, min_degree, {}, max_radius, error);
            if (piece.face.IsNull()) return {};
            bare.push_back(piece.surface);
        }
        for (const std::array<double, 3>& raw : points) {
            const gp_Pnt guide(raw[0], raw[1], raw[2]);
            int nearest = -1;
            double best = 1e300;
            for (int i = 0; i < count; ++i) {
                try {
                    GeomAPI_ProjectPointOnSurf proj(guide, bare[static_cast<size_t>(i)]);
                    if (proj.NbPoints() > 0 && proj.LowerDistance() < best) {
                        best = proj.LowerDistance();
                        nearest = i;
                    }
                } catch (const Standard_Failure&) {
                }
            }
            if (nearest < 0) {
                error = "A guide point does not lie over this opening.";
                return {};
            }
            guides_of[static_cast<size_t>(nearest)].push_back(raw);
        }
    }
    std::vector<EdgeReport> reports;
    bool too_short = false;
    std::vector<BuiltPiece> pieces;
    for (int round = 0; round <= kHermiteRefineCap; ++round) {
        pieces.clear();
        reports.clear();
        bool failed = false;
        error.clear();
        for (int i = 0; i < count; ++i) {
            BuiltPiece piece = build_one_piece(i, count, sides, splits, centre, centre_normal, min_degree, guides_of[static_cast<size_t>(i)], max_radius, error);
            if (piece.face.IsNull()) return {};
            pieces.push_back(piece);
        }
        auto consider = [&](EdgeReport report, const Handle(Geom_BSplineCurve)& along, std::vector<double>& extra) {
            report.fail = edge_fails(report);
            if (report.fail) {
                failed = true;
                if (!push_knot(extra, along, report.worst_frac, too_short) && too_short) report.short_span = true;
            }
            reports.push_back(report);
        };
        for (int i = 0; i < count; ++i) {
            const int prev = (i + count - 1) % count;
            const BuiltPiece& piece = pieces[static_cast<size_t>(i)];
            EdgeReport outer;
            outer.which = "outer";
            outer.side = i;
            outer.asked = sides[static_cast<size_t>(i)].order;
            if (!sides[static_cast<size_t>(i)].face.IsNull()) {
                for (int s = 0; s < kHermiteStations; ++s) {
                    const double frac = 0.1 + 0.8 * (static_cast<double>(s) / (kHermiteStations - 1));
                    gp_Pnt point;
                    gp_Vec du;
                    gp_Vec dv;
                    piece.surface->D1(frac, 0.0, point, du, dv);
                    double su = 0.0;
                    double sv = 0.0;
                    if (!face_parameters(sides[static_cast<size_t>(i)].face, point, su, sv)) continue;
                    const StationStat stat = measure_faces(piece.face, piece.surface, frac, 0.0, sides[static_cast<size_t>(i)].face, BRep_Tool::Surface(sides[static_cast<size_t>(i)].face), su, sv, du);
                    if (!stat.samples) continue;
                    note_station(outer, stat, frac);
                }
            }
            consider(outer, piece.v0, sides[static_cast<size_t>(i)].extra_start);

            EdgeReport outer_prev;
            outer_prev.which = "outer";
            outer_prev.side = prev;
            outer_prev.asked = sides[static_cast<size_t>(prev)].order;
            if (!sides[static_cast<size_t>(prev)].face.IsNull()) {
                for (int s = 0; s < kHermiteStations; ++s) {
                    const double frac = 0.1 + 0.8 * (static_cast<double>(s) / (kHermiteStations - 1));
                    gp_Pnt point;
                    gp_Vec du;
                    gp_Vec dv;
                    piece.surface->D1(0.0, frac, point, du, dv);
                    double su = 0.0;
                    double sv = 0.0;
                    if (!face_parameters(sides[static_cast<size_t>(prev)].face, point, su, sv)) continue;
                    const StationStat stat = measure_faces(piece.face, piece.surface, 0.0, frac, sides[static_cast<size_t>(prev)].face, BRep_Tool::Surface(sides[static_cast<size_t>(prev)].face), su, sv, dv);
                    if (!stat.samples) continue;
                    note_station(outer_prev, stat, frac);
                }
            }
            consider(outer_prev, piece.u0, sides[static_cast<size_t>(prev)].extra_end);

            const int next = (i + 1) % count;
            const BuiltPiece& other = pieces[static_cast<size_t>(next)];
            EdgeReport split;
            split.which = "split";
            split.side = i;
            split.asked = sides[static_cast<size_t>(i)].order;
            if (split.asked < 1 && max_order >= 1) split.asked = 1;
            for (int s = 0; s < kHermiteStations; ++s) {
                const double frac = 0.1 + 0.8 * (static_cast<double>(s) / (kHermiteStations - 1));
                gp_Pnt point;
                gp_Vec du;
                gp_Vec dv;
                piece.surface->D1(1.0, frac, point, du, dv);
                const StationStat stat = measure_faces(piece.face, piece.surface, 1.0, frac, other.face, other.surface, frac, 1.0, dv);
                if (!stat.samples) continue;
                note_station(split, stat, frac);
            }
            consider(split, piece.u1, splits[static_cast<size_t>(i)].extra);
        }
        double max_gap = 0.0;
        double max_angle = 0.0;
        double max_jump = 0.0;
        for (const EdgeReport& report : reports) {
            max_gap = std::max(max_gap, report.gap);
            max_angle = std::max(max_angle, report.angle);
            max_jump = std::max(max_jump, report.jump);
        }
        if (!failed || too_short || round == kHermiteRefineCap || past_deadline()) {
            note_last_fill(reports, round, failed);
            if (failed) {
                error = past_deadline() ? deadline_message() : refusal_sentence(reports, sides);
                return {};
            }
            break;
        }
    }
    TopoDS_Shape acc = current;
    for (const BuiltPiece& piece : pieces) acc = compound_with(acc, piece.face);
    return acc;
}

TopoDS_Shape fill_hermite_blend(
    const TopoDS_Shape& current,
    Handle(Geom_BSplineCurve) a,
    Handle(Geom_BSplineCurve) b,
    const TopoDS_Face& face_a,
    const TopoDS_Face& face_b,
    const std::vector<TopoDS_Face>& faces_a,
    const std::vector<TopoDS_Face>& faces_b,
    const std::vector<int>& ids_a,
    const std::vector<int>& ids_b,
    int order_a,
    int order_b,
    double tension_a,
    double tension_b,
    std::string& error) {
    if (a.IsNull() || b.IsNull()) {
        error = "A blend needs two open edges or chains. Pick one chain on each sheet.";
        return {};
    }
    // Two closed rims: run them the same way round and start them across from each other, or the blend twists.
    const auto closed_curve = [](const Handle(Geom_BSplineCurve)& curve) {
        return curve->StartPoint().Distance(curve->EndPoint()) < kHermiteGapMm;
    };
    if (closed_curve(a) && closed_curve(b)) {
        // Start b at the knot nearest a's start. A knot, not any point: a rim chain's edges meet at knots, so the
        // blend's rim keeps the sheet's own vertices and Sew matches them.
        double t = b->FirstParameter();
        double best = a->StartPoint().Distance(b->StartPoint());
        for (int k = 2; k < b->NbKnots(); ++k) {
            const double d = a->StartPoint().Distance(b->Value(b->Knot(k)));
            if (d < best - 1e-6) {
                best = d;
                t = b->Knot(k);
            }
        }
        if (t > b->FirstParameter()) {
            Handle(Geom_BSplineCurve) tail = Handle(Geom_BSplineCurve)::DownCast(b->Copy());
            Handle(Geom_BSplineCurve) head = Handle(Geom_BSplineCurve)::DownCast(b->Copy());
            tail->Segment(t, b->LastParameter());
            head->Segment(b->FirstParameter(), t);
            GeomConvert_CompCurveToBSplineCurve joined(tail);
            if (!joined.Add(head, kHermiteGapMm, Standard_True)) {
                error = "These closed rims could not be lined up. Give each rim as one closed edge.";
                return {};
            }
            b = joined.BSplineCurve();
        }
        gp_Pnt pa;
        gp_Pnt pb;
        gp_Vec ta;
        gp_Vec tb;
        a->D1(a->FirstParameter(), pa, ta);
        b->D1(b->FirstParameter(), pb, tb);
        if (ta.Dot(tb) < 0.0) {
            b->Reverse();
        }
    } else {
        const double ss = a->StartPoint().Distance(b->StartPoint());
        const double se = a->StartPoint().Distance(b->EndPoint());
        const double es = a->EndPoint().Distance(b->StartPoint());
        const double ee = a->EndPoint().Distance(b->EndPoint());
        if (se + es < ss + ee) b->Reverse();
    }
    reparam_01(a);
    reparam_01(b);
    const int order = std::max(order_a, order_b);
    const int min_u = std::max(std::max(a->Degree(), b->Degree()), 3);
    if (!unify_pair(a, b, error)) return {};
    if (a->Degree() < min_u) {
        a->IncreaseDegree(min_u);
        b->IncreaseDegree(min_u);
        if (!unify_pair(a, b, error)) return {};
    }
    const int nu = a->NbPoles();
    const int deg_v = order >= 2 ? 5 : 3;
    const int nv = deg_v + 1;
    std::vector<double> extra;
    bool too_short = false;
    Handle(Geom_BSplineSurface) surface;
    TopoDS_Face face;
    for (int round = 0; round <= kHermiteRefineCap; ++round) {
        Handle(Geom_BSplineCurve) ua = with_extra_knots(a, extra, min_u);
        Handle(Geom_BSplineCurve) ub = with_extra_knots(b, extra, min_u);
        if (!unify_pair(ua, ub, error)) return {};
        const int n = ua->NbPoles();
        const std::vector<double> flat_u = flat_knots(ua);
        const int deg_u = ua->Degree();
        TColgp_Array2OfPnt grid(1, n, 1, nv);
        for (int i = 1; i <= n; ++i) {
            grid.SetValue(i, 1, ua->Pole(i));
            grid.SetValue(i, nv, ub->Pole(i));
        }
        const EndScale v_start = scales_from_flat([&]() {
            std::vector<double> flat(static_cast<size_t>(deg_v + 1), 0.0);
            flat.insert(flat.end(), static_cast<size_t>(deg_v + 1), 1.0);
            return flat;
        }(), deg_v);
        const EndScale v_end = end_scales([&]() {
            std::vector<double> flat(static_cast<size_t>(deg_v + 1), 0.0);
            flat.insert(flat.end(), static_cast<size_t>(deg_v + 1), 1.0);
            return flat;
        }(), deg_v);
        if (!v_start.ok || !v_end.ok) {
            error = "Open CASCADE could not bridge these edges.";
            return {};
        }
        // `far` is an MSVC keyword, so the flag cannot use that name.
        auto field_at = [&](const Handle(Geom_BSplineCurve)& curve, const TopoDS_Face& support, double tension, double t, bool far_side, gp_Vec& T, gp_Vec& A) -> bool {
            gp_Pnt point;
            gp_Vec tangent;
            curve->D1(t, point, tangent);
            const TopoDS_Face support_here = face_along(far_side ? faces_b : faces_a, support, point, tangent);
            const Transverse got = transverse_at(support_here, point, tangent, far_side ? 1 : 0);
            if (!got.ok) {
                error = got.error;
                return false;
            }
            gp_Pnt other;
            (far_side ? ua : ub)->D0(t, other);
            const double g = point.Distance(other);
            if (g < kHermiteGapMm) {
                error = "These edges already meet, so there is no gap to bridge.";
                return false;
            }
            const double lambda = tension * g;
            // The two walls of a sheet are oriented the same way. Sewing then reverses
            // one of them to make one shell, so the far derivative points the other
            // way and the oriented normals agree after that reversal.
            gp_Vec Ds = got.Ds;
            // The sample has to leave along this face's own outward B. A sum of
            // the samples is not a direction: around a flat ellipse it cancels,
            // and correct ribbons get reversed.
            if (Ds.Dot(got.B) < 0.0) Ds.Reverse();
            if (far_side) Ds.Reverse();
#ifdef LIME_OCCT_TEST_HOOKS
            // Debug tests only. Reverses one side so a fold can be told from an orientation flip.
            if (g_blend_reverse_side == (far_side ? 1 : 0)) Ds.Reverse();
#endif
            T = Ds.Multiplied(lambda);
            A = got.Dss.Multiplied(lambda * lambda);
            return true;
        };
        std::vector<gp_Vec> t0(static_cast<size_t>(n));
        std::vector<gp_Vec> t1(static_cast<size_t>(n));
        std::vector<gp_Vec> a0(static_cast<size_t>(n));
        std::vector<gp_Vec> a1(static_cast<size_t>(n));
        for (int i = 0; i < n; ++i) {
            const double xi = greville_of(flat_u, deg_u, i);
            if (!field_at(ua, face_a, tension_a, xi, false, t0[static_cast<size_t>(i)], a0[static_cast<size_t>(i)])) return {};
            if (!field_at(ub, face_b, tension_b, xi, true, t1[static_cast<size_t>(i)], a1[static_cast<size_t>(i)])) return {};
        }
        for (int i = 0; i < n; ++i) {
            const gp_Pnt p0 = grid.Value(i + 1, 1);
            const gp_Pnt p1 = grid.Value(i + 1, nv);
            if (deg_v == 3) {
                grid.SetValue(i + 1, 2, gp_Pnt(p0.XYZ() + t0[static_cast<size_t>(i)].XYZ() / v_start.alpha0));
                grid.SetValue(i + 1, 3, gp_Pnt(p1.XYZ() - t1[static_cast<size_t>(i)].XYZ() / v_end.alpha0));
            } else {
                grid.SetValue(i + 1, 2, gp_Pnt(p0.XYZ() + t0[static_cast<size_t>(i)].XYZ() / v_start.alpha0));
                grid.SetValue(i + 1, 3, gp_Pnt(p0.XYZ() + t0[static_cast<size_t>(i)].XYZ() * 2.0 / v_start.alpha0 + a0[static_cast<size_t>(i)].XYZ() / (v_start.alpha0 * v_start.beta)));
                grid.SetValue(i + 1, nv - 1, gp_Pnt(p1.XYZ() - t1[static_cast<size_t>(i)].XYZ() / v_end.alpha0));
                grid.SetValue(i + 1, nv - 2, gp_Pnt(p1.XYZ() - t1[static_cast<size_t>(i)].XYZ() * 2.0 / v_end.alpha0 + a1[static_cast<size_t>(i)].XYZ() / (v_end.alpha0 * v_end.beta)));
            }
        }
        TColStd_Array1OfReal uk(1, ua->NbKnots());
        TColStd_Array1OfInteger um(1, ua->NbKnots());
        ua->Knots(uk);
        ua->Multiplicities(um);
        TColStd_Array1OfReal vk(1, 2);
        TColStd_Array1OfInteger vm(1, 2);
        vk.SetValue(1, 0.0);
        vk.SetValue(2, 1.0);
        vm.SetValue(1, deg_v + 1);
        vm.SetValue(2, deg_v + 1);
        const bool rational = ua->IsRational() || ub->IsRational();
        try {
            if (rational) {
                TColStd_Array2OfReal weights(1, n, 1, nv);
                // Hermite blend of the rim weights. The rows that carry ∂S/∂v,
                // and ∂²S/∂v² when the span is quintic, keep that rim's weight.
                // ∂w/∂v and ∂²w/∂v² are then 0 on the rim, so the Cartesian end
                // identities are the geometric derivatives. Weight 1 on those
                // rows leaves a rational circle 0.315° short of the wall.
                const int hold = deg_v >= 5 ? 3 : 2;
                for (int i = 1; i <= n; ++i) {
                    const double wa = ua->IsRational() ? ua->Weight(i) : 1.0;
                    const double wb = ub->IsRational() ? ub->Weight(i) : 1.0;
                    for (int j = 1; j <= nv; ++j) weights.SetValue(i, j, j <= hold ? wa : wb);
                }
                surface = new Geom_BSplineSurface(grid, weights, uk, vk, um, vm, deg_u, deg_v);
            } else {
                surface = new Geom_BSplineSurface(grid, uk, vk, um, vm, deg_u, deg_v);
            }
        } catch (const Standard_Failure& failure) {
            error = failure.GetMessageString() ? failure.GetMessageString() : "Open CASCADE could not bridge these edges.";
            return {};
        }
        BRepBuilderAPI_MakeFace maker(surface, 1e-7);
        if (!maker.IsDone()) {
            error = "Open CASCADE could not bridge these edges.";
            return {};
        }
        face = maker.Face();
        gp_Pnt mid;
        gp_Vec du;
        gp_Vec dv;
        surface->D1(0.5, 0.0, mid, du, dv);
        double su = 0.0;
        double sv = 0.0;
        if (dv.Magnitude() > 1e-12 && face_parameters(face_a, mid, su, sv)) {
            BRepAdaptor_Surface adapt(face_a);
            BRepLProp_SLProps props(adapt, 1, 1e-9);
            props.SetParameters(su, sv);
            if (props.IsNormalDefined()) {
                gp_Dir sn = props.Normal();
                if (face_a.Orientation() == TopAbs_REVERSED) sn.Reverse();
                if (du.Crossed(dv).Dot(gp_Vec(sn)) < 0.0) face.Reverse();
            }
        }
        // Every station is measured on its own: the gap under 1e-4 mm, the angle (step measure_rim) under 0.1° where G1
        // or G2 was asked, the curvature jump at most 1e-3 per mm where G2 was asked. A side whose wall it cannot read
        // has not met them. Nothing outside those bounds is kept, and nothing is left for Sew to sort out.
        EdgeReport ra;
        ra.which = "outer";
        ra.side = 0;
        ra.asked = order_a;
        EdgeReport rb;
        rb.which = "outer";
        rb.side = 1;
        rb.asked = order_b;
        bool fold_a = false;
        bool fold_b = false;
        for (int s = 0; s < kHermiteStations; ++s) {
            const double frac = 0.1 + 0.8 * (static_cast<double>(s) / (kHermiteStations - 1));
            const StationStat stat_a = measure_rim(surface, face, frac, 0.0, face_a, faces_a, 0);
            if (stat_a.samples) {
                note_station(ra, stat_a, frac);
                fold_a = fold_a || (order_a >= 1 && stat_a.angle > 90.0);
            }
            const StationStat stat_b = measure_rim(surface, face, frac, 1.0, face_b, faces_b, 1);
            if (stat_b.samples) {
                note_station(rb, stat_b, frac);
                fold_b = fold_b || (order_b >= 1 && stat_b.angle > 90.0);
            }
        }
        // A rim that meets no face (G0 to a bare curve) is that curve's poles, so it meets its edge exactly.
        ra.fail = !face_a.IsNull() && (edge_fails(ra) || ra.score < 0.0);
        rb.fail = !face_b.IsNull() && (edge_fails(rb) || rb.score < 0.0);
        if (fold_a || fold_b) {
            note_last_fill({ra, rb}, round, true);
            const std::string a_text = edges_phrase(ids_a, "Side A");
            const std::string b_text = edges_phrase(ids_b, "Side B");
            error = fold_a && fold_b ? a_text + " and " + b_text + " fold back into their faces."
                : (fold_a ? a_text : b_text) + " folds back into the face.";
            return {};
        }
        if (blend_folds(surface)) {
            note_last_fill({ra, rb}, round, true);
            error = "The blend folds back on itself between " + edges_phrase(ids_a, "side A") + " and "
                + edges_phrase(ids_b, "side B") + ". Pick edges that face each other, or lower the tension.";
            return {};
        }
        if (!ra.fail && !rb.fail) {
            note_last_fill({ra, rb}, round, false);
            break;
        }
        // A bound is missed: refine the worst span, and refuse once no span can take another knot.
        const EdgeReport& worst = ra.score >= rb.score ? ra : rb;
        const bool pushed = push_knot(extra, ua, worst.worst_frac, too_short);
        if (round == kHermiteRefineCap || (!pushed && too_short) || past_deadline()) {
            note_last_fill({ra, rb}, round, true);
            error = past_deadline() ? deadline_message() : miss_sentence(std::vector<EdgeReport>{ra, rb});
            return {};
        }
    }
    (void)nu;
    return compound_with(current, face);
}
