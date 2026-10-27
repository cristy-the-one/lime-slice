// Open CASCADE operations (kernel.cpp) that the history tree (tree.cpp) builds its nodes with.
// This file is Lime Slice (MIT). It calls the LGPL library; the notice is third_party/occt/NOTICE.md.

#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

#include <TopAbs_ShapeEnum.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <BRepTools_History.hxx>
#include <Standard_ErrorHandler.hxx>

namespace lime_occt {

/// The refusal for a step Open CASCADE crashed inside: an access violation, an illegal instruction, or an integer
/// divide by zero that no check of ours can see coming, such as the null edge BRepOffset_Inter2d hands
/// BRepAdaptor_Curve when a wall beside raised lettering is pushed.
extern const char* const kInternalError;

// On MSVC OCC_CATCH_SIGNALS is empty (Open CASCADE defines OCC_CONVERT_SIGNALS only elsewhere): FaultScope does its work.
// The entry points that only copy numbers or free a shape (lime_tree_free, lime_tree_counts, lime_tree_fingerprint…)
// call no Open CASCADE algorithm and go without.
#if defined(_MSC_VER)
/// While alive, a hardware fault on this thread is thrown as a Standard_Failure carrying kInternalError, through the
/// frames between, with their destructors run (this needs /EHa, which build.rs sets). The previous translator comes
/// back at the end of the call.
class FaultScope {
public:
    FaultScope();
    ~FaultScope();
    FaultScope(const FaultScope&) = delete;
    FaultScope& operator=(const FaultScope&) = delete;

private:
    void* previous_;
};
/// Every bridge entry point opens its `try` with this, so a crash inside Open CASCADE refuses the step instead of
/// ending the app. The nearest `catch (const Standard_Failure&)` answers it: an op's own refusal, or the entry
/// point's kInternalError.
#define LIME_CATCH_FAULTS const lime_occt::FaultScope lime_fault_scope
#else
/// Sets the handlers once. A fault then jumps to the nearest OCC_CATCH_SIGNALS on its thread, which throws it as a
/// Standard_Failure; a fault outside one goes to the handler that was there before, such as Rust's stack overflow check.
void watch_faults();
#define LIME_CATCH_FAULTS \
    lime_occt::watch_faults(); \
    OCC_CATCH_SIGNALS
#endif

/// One shape with what was computed from it once. A shape never changes, so its volume, its face
/// and edge numbering, and its description stay valid for as long as a tree node holds it.
struct Held {
    TopoDS_Shape shape;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
    double volume = 0;
    /// The chord the faces were last meshed at. A reply at that chord meshes nothing again.
    double meshed = 0;
    /// Built from another solid: the faces it shares with that solid carry that solid's mesh, and `made` lists the
    /// others, by index from 1. Then a mesh at a chord the shared faces are already meshed at meshes only around `made`.
    bool built_on = false;
    std::vector<int> made;
    /// `describe`'s JSON, written by the first reply.
    std::string about;
    /// Each face's `{"areaMm2":…,"normal":[…]}` and each edge's length, as the reply writes them, by index, once
    /// worked out. Empty text is not worked out yet. A solid built from another takes those of the faces and edges
    /// the two share (`inherit_about`), so a step measures only what it changed.
    std::vector<std::string> face_about;
    std::vector<std::string> edge_about;
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

/// --- 3.1 F9. The step being built stops after `budget_ms` (0: no limit): a boolean or a blend polls it and fails with
/// `deadline_message()`, so a slow step is a refusal, not a killed engine.
void set_deadline(long long budget_ms);
bool past_deadline();
std::string deadline_message();
double volume_of(const TopoDS_Shape& shape);
/// Mesh the faces unless they are meshed at this chord already, and read the mesh out.
Mesh tessellate(Held& held, double chord);
/// What a reply says of the shape whatever the chord, as a JSON object: `volumeMm3`, `solid`,
/// `faces` (area and outward normal), and `edgeLengths`.
std::string describe(Held& held);
/// Give `held` the face and edge measures `from` has worked out for the faces and edges the two share.
void inherit_about(Held& held, const Held& from);
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
/// `solids` as one STEP file of free shapes in this order, each a product named by `names` (the XCAF document writer).
/// The lists have the same length; the schema, units and p-curve mode are `write_step`'s.
bool write_step_named(
    const std::vector<TopoDS_Shape>& solids,
    const std::vector<std::string>& names,
    const char* path,
    std::string& error);
/// The free shapes of a STEP file with their product names, in the file's order (the XCAF document reader).
bool read_step_named(
    const char* path,
    std::vector<std::pair<std::string, TopoDS_Shape>>& out,
    std::string& error);
/// The shape in Open CASCADE's own binary format (BinTools), without triangulation: every number as the
/// kernel holds it, and sub-shapes in the order it numbers them, so a read gives back the same faces and edges.
std::string write_brep(const TopoDS_Shape& shape);
/// A shape `write_brep` wrote. Null, with `error`, when the bytes do not read.
TopoDS_Shape read_brep(const char* data, size_t size, std::string& error);

/// A primitive solid in millimetres, turned by `rx`, then `ry`, then `rz` degrees about its centre.
/// Each kind reads its own fields; docs/step-modeler.md lists them.
struct PrimitiveSpec {
    std::string kind;
    double x = 0, y = 0, z = 0;
    double dx = 0, dy = 0, dz = 0;
    double radius = 0, height = 0;
    double rx = 0, ry = 0, rz = 0;
    /// A cone's top, a torus's tube, a tube's hole.
    double top_radius = 0, tube_radius = 0, inner_radius = 0;
    /// A wedge's top face, along X from `x`.
    double top_x = 0;
    /// A polygon prism: its side count, and its width across corners, or across flats with `flats`.
    double sides = 0, across = 0;
    bool flats = false;
    /// A box's four edges along Z rounded to this radius. 0 keeps them sharp.
    double corner_radius = 0;
};

/// The primitive, built and turned. Null, with `error` in plain words, when a size is out of range.
TopoDS_Shape make_solid(const PrimitiveSpec& spec, std::string& error);

/// `history`, when set, receives the boolean's face history (`Modified` / `Generated`) so a later step can
/// tell a face this boolean only trimmed from a face it created. Null leaves the history unfilled, as before.
TopoDS_Shape build_boolean(
    const TopoDS_Shape& current,
    const std::string& which,
    const PrimitiveSpec& tool,
    double& volume,
    std::string& error,
    Handle(BRepTools_History)* history = nullptr);
/// Another solid, placed by a rigid matrix, fused with, cut from, or intersected with `current`.
/// `place` is the 3×3 turn row by row, then the move: twelve numbers.
TopoDS_Shape build_join(
    const TopoDS_Shape& current,
    const TopoDS_Shape& tool,
    const std::string& which,
    const double* place,
    double& volume,
    std::string& error,
    Handle(BRepTools_History)* history = nullptr);
/// A hole as its op stores it, in the solid's own frame.
struct HoleSpec {
    double x = 0;
    double y = 0;
    double z = 0;
    /// Into the material. Zero drills straight down, toward −Z.
    double dx = 0;
    double dy = 0;
    double dz = 0;
    double radius = 0;
    double depth = 0;
    /// Cut to wherever the part ends along the axis. `depth` is not read.
    bool through = false;
    /// A wider, shallow bore at the entry.
    bool bore = false;
    double bore_radius = 0;
    double bore_depth = 0;
};
/// `before` is the volume of `current`; `volume` gets the result's.
TopoDS_Shape build_hole(const TopoDS_Shape& current, double before, const HoleSpec& hole, double& volume, std::string& error);
bool blend_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    double size,
    bool chamfer,
    TopoDS_Shape& built,
    double& volume,
    std::string& error);
double largest_blend(const TopoDS_Shape& current, const std::vector<TopoDS_Edge>& edges, double hi, bool chamfer);
/// A chamfer whose first distance `size` runs along `faces[i]` for `edges[i]`: the second is `second` mm with `by_angle`
/// false, else `second` degrees from that face.
bool chamfer2_build(
    const TopoDS_Shape& current,
    const std::vector<TopoDS_Edge>& edges,
    const std::vector<TopoDS_Face>& faces,
    double size,
    double second,
    bool by_angle,
    TopoDS_Shape& built,
    double& volume,
    std::string& error);
/// Faces and edges on one surface or curve merged into one. `history`, when set, takes the merge's history after its own.
TopoDS_Shape merge_same_domain(const TopoDS_Shape& shape, Handle(BRepTools_History)* history);
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
/// One solid of a partition and its volume, integrated once.
struct PartitionPiece {
    TopoDS_Shape shape;
    double volume;
};
constexpr size_t kMaxPartitionPieces = 24;
/// True when every edge of `shape`, a degenerate one aside, lies on exactly two faces: the shell has no hole and no
/// fin.
bool every_edge_shared_by_two(const TopoDS_Shape& shape);
/// Cuts `current` along every plane at once, each plane given as x, y, z, nx, ny, nz. The pieces come back in the
/// order of the planes' signs, negative first, the first plane's sign most significant. Each is one valid, closed
/// solid; if any is not, or there are more than `kMaxPartitionPieces`, nothing is returned.
/// --- Split to print, cut profiles (plan sections 6 and 7). One cut's shape, `kind` 0 straight, 1 lap, 2 tongue, 3 zig-zag, 4
/// dovetail; `u` is the cut's U, so V = W × U with W the plane's normal. A lap: `a` is how far the step carries the second
/// flat along W (signed, the side that carries it), `b` where the step sits along V from the plane's origin. A tongue: `a`
/// its width along V, `b` how far it stands along W, `c` the clearance each side, `d` the end gap, `e` the side that carries
/// it (+1 or -1), `f` and `g` its ends along U and `h` its middle along V, all from the origin. A dovetail: the same, `a` the
/// wide end's width, with `angle` its flanks' lean from W in degrees and `slide` 0 for U or 1 for V: its ends `f` and `g` and
/// its middle `h` are along the slide and across it. A zig-zag: `a` its depth along W (signed), `b` the pitch, `c` the flank's
/// lean in degrees, `d` where a period starts along U. A sketch, `kind` 5: an open chain in (U, W) from the plane's origin,
/// starting at (`c`, `d`), each segment `kChainStride` numbers of `chain`: 0 for a line or 1 for an arc, the arc's through
/// point (U, W), and the segment's end (U, W). `a` is where its segments start in the call's chain numbers, `b` how many.
struct PartitionProfile {
    int kind = 0;
    double a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, angle = 0;
    int slide = 0;
    double u[3] = {0, 0, 0};
    std::vector<double> chain;
};
constexpr int kProfileStride = 14;
constexpr int kChainStride = 5;
constexpr int kProfileSketch = 5;
bool build_partition(
    const TopoDS_Shape& current,
    const std::vector<std::array<double, 6>>& planes,
    std::vector<PartitionPiece>& pieces,
    std::string& error,
    const std::vector<PartitionProfile>& profiles = {});
/// The tongue and groove of every cut whose profile is a tongue, on the pieces the plain split made: the tongue fused
/// onto the piece that carries it, the groove, the tongue grown by the clearance and the end gap, cut from its mate.
bool build_tongues(
    std::vector<PartitionPiece>& pieces,
    const std::vector<std::array<double, 6>>& planes,
    const std::vector<PartitionProfile>& profiles,
    std::string& error);
/// --- Split to print, part numbers. One stroke of a number in the label's own U, V: its centre, its length along
/// `angle_deg` from U, as `textStrokes` in src/modeling/text.ts draws it, centred on the label.
struct NumberStroke {
    double u = 0, v = 0, length = 0, angle_deg = 0;
};
/// Each piece's strokes in partition order, the stroke width, how deep the number is cut, how far the label keeps
/// from a face's edge, and each cut's U (the direction the number reads along on its face).
struct PartitionNumbers {
    std::vector<std::vector<NumberStroke>> digits;
    std::vector<std::array<double, 3>> us;
    double width = 0, depth = 0, inset = 0;
};
/// Where a number was cut: on the face of cut `cut` (-1 for a side face), centred at `at`, the face's outward normal.
struct NumberPlace {
    int cut = -1;
    double at[3] = {0, 0, 0};
    double normal[3] = {0, 0, 0};
};
/// Engraves each piece's number on every face it has on a cut plane, where the label fits inside the face less the
/// inset, or, when no cut face has room, on its largest side face that does. A piece with no room anywhere, or whose
/// cut does not give one closed solid, keeps its shape and gets no place. `placed` has one list per piece.
void engrave_numbers(
    std::vector<PartitionPiece>& pieces,
    const std::vector<std::array<double, 6>>& planes,
    const PartitionNumbers& numbers,
    std::vector<std::vector<NumberPlace>>& placed);
/// --- Split to print, connectors (plan sections 7 and 9). One connector on cut `cut`: a dowel (holes in both pieces and a
/// pin), a plug (fused to the `side` piece, +1 positive or -1 negative, with a socket in the mate), or a hardware hole
/// (holes in both pieces, no pin). `a`, `b` are fractions of the section's box along the cut's U and V when `fraction`,
/// and millimetres from the cut's origin otherwise. `radius` is the pin's, the plug's, or half the bought part's
/// diameter; the hole is that plus `clearance`. `depth` is the pin's or the bought part's whole length (each hole takes
/// half of it plus `end_gap`), or how far a plug stands (its socket is `end_gap` deeper). `teardrop` asks for a 45° roof
/// on a hole whose axis lies within 45° of horizontal.
struct JointSpec {
    int cut = 0;
    int type = 0;
    bool fraction = true;
    double a = 0.5, b = 0.5;
    double radius = 0, clearance = 0, depth = 0, end_gap = 0;
    bool teardrop = false;
    int side = 1;
    double height = 0, angle = 0;
    int slide = 0;
};
constexpr int kJointStride = 14;
constexpr int kJointDowel = 0;
constexpr int kJointPlug = 1;
constexpr int kJointHardware = 2;
/// A key (`radius` is its width along U, `height` along V) and a dovetail (`radius` its wide end's width, `angle` its flanks'
/// lean in degrees, `slide` 0 for U or 1 for V): a prism fused to the `side` piece and its groove, grown by the clearance and
/// the end gap, cut from the mate.
constexpr int kJointKey = 3;
constexpr int kJointDovetail = 4;
/// What became of one connector: `placed`, or why it was left out, `outside` (its centre is on no cut face of two
/// pieces) or `breaks` (a tool reaches past a piece, or a result is not one valid, closed solid). `at` is its centre on the
/// cut, and `teardrop` whether its holes got the roof.
struct JointResult {
    int status = 0;
    double at[3] = {0, 0, 0};
    bool teardrop = false;
};
constexpr int kJointPlaced = 0;
constexpr int kJointOutside = 1;
constexpr int kJointBreaks = 2;
/// The pin's chamfer at each end, so it starts into its hole (plan section 7).
constexpr double kPinChamfer = 0.5;
/// Builds each connector on the pieces a partition cut, in order, each checked on the real solids; one that fails
/// leaves the pieces as they were and is reported. `us` is each cut's U, and `up` the print's up in the solid's frame,
/// which a teardrop's roof points along. `pins` gets every placed dowel's pin, standing along `up` in a row beside the
/// part, or stays null with none.
void build_joints(
    std::vector<PartitionPiece>& pieces,
    const std::vector<std::array<double, 6>>& planes,
    const std::vector<std::array<double, 3>>& us,
    const std::vector<JointSpec>& joints,
    const gp_Dir& up,
    std::vector<JointResult>& results,
    TopoDS_Shape& pins);
/// A dowel pin standing on `base` along `axis`: `radius`, `length` long, with `kPinChamfer` at each end.
TopoDS_Shape make_pin(const gp_Pnt& base, const gp_Dir& axis, double radius, double length);
/// --- Split to print, the fit coupon (plan section 2, milestone 6). A plate from the origin to `size` with blind holes
/// bored into its front face (y = 0) along +Y, the hole's roof toward +Z when `teardrop`, and labels cut into that face;
/// and the pins that go in the holes, standing along +Z on z = 0. Every hole is a `Geom_CylindricalSurface` of its radius.
struct CouponHole {
    double x = 0, z = 0, radius = 0, depth = 0;
    bool teardrop = false;
};
struct CouponPin {
    double x = 0, y = 0, radius = 0, length = 0;
};
struct FitCoupon {
    double size[3] = {0, 0, 0};
    std::vector<CouponHole> holes;
    /// Strokes of the labels in the front face's X and Z, as `NumberStroke` has them: `u` is X and `v` is Z.
    std::vector<NumberStroke> strokes;
    double stroke_width = 0, engrave_depth = 0;
    std::vector<CouponPin> pins;
};
struct FitCouponResult {
    TopoDS_Shape plate;
    TopoDS_Shape pins;
    double plate_volume = 0, pins_volume = 0;
    /// The volume the labels took from the plate.
    double engraved = 0;
};
bool build_fit_coupon(const FitCoupon& coupon, FitCouponResult& made, std::string& error);
/// A uniform scale about the centre. The result's volume is the original's times `factor` cubed.
TopoDS_Shape build_scale(const TopoDS_Shape& current, double factor, std::string& error);

/// A closed outline on a plane. `origin` and `turn` (degrees about X, then Y, then Z) are the plane's frame, as a
/// workplane's: the turn's columns are U, V, and W. `points` is u, v pairs in that plane.
struct ProfileSpec {
    double origin[3] = {0, 0, 0};
    double turn[3] = {0, 0, 0};
    std::vector<double> points;
    /// Splines through the points instead of straight edges. A point listed in `corners` is a sharp corner: the
    /// run between two corners is one spline, and two corners side by side are joined by a straight edge.
    bool smooth = false;
    std::vector<int> corners;
};

// --- K1 profile v2 (loops, arcs, holes). Distinct from ProfileSpec so other packages can edit that struct. ---

/// One edge of a loop, from the previous end (the loop's start, for the first) to `to`.
enum class ProfileSegKind { Line, Arc, Spline };

struct ProfileSeg {
    ProfileSegKind kind = ProfileSegKind::Line;
    double to[2] = {0, 0};
    /// u, v pairs. One pair for an arc, one or more for a spline, none for a line.
    std::vector<double> through;
};

/// A closed loop on the profile plane. The last segment's `to` meets `start`.
struct ProfileLoop {
    double start[2] = {0, 0};
    std::vector<ProfileSeg> segments;
};

/// One cross-section of a loft: a profile on its plane, or, with `radius` above 0, a circle about the plane's origin
/// (an ellipse with `radius_v` above 0, `radius` along U and `radius_v` along V). `loops`, when set, replaces the profile.
struct LoftSection {
    ProfileSpec profile;
    double radius = 0;
    double radius_v = 0;
    /// K1: closed loops instead of `profile`. Empty when the section uses a radius or a profile.
    std::vector<ProfileLoop> loops;
};

/// K1. Read one loop blob from `data`. `used` is how many doubles it consumed. The blob is `encode_loops` in tree.rs:
/// loop count, then each loop as start u, start v, segment count, then each segment as kind (0 line, 1 arc, 2 spline),
/// to u, to v, through count, and the through points.
bool decode_profile_loops(const double* data, int count, std::vector<ProfileLoop>& loops, int& used, std::string& error);

/// The profile pushed `depth` along W (−W when negative), or `depth` centred on the plane with `symmetric`, combined
/// with `current` by `which`. `before` is the volume of `current`; `volume` gets the result's.
TopoDS_Shape build_extrude(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileSpec& profile,
    double depth,
    bool symmetric,
    double& volume,
    std::string& error);

// --- K3: two-sided depth, draft, and up to a face. Absent on a plain extrude, which stays `build_extrude`. ---

/// Optional ends of an extrude. A flag is false when that field was not sent, and the number is then ignored.
struct ExtrudeExtent {
    /// A distance on the other side of the plane. The prism runs from −`depth2` to `depth` when `depth` is
    /// positive, and from `depth` to +`depth2` when `depth` is negative.
    bool has_depth2 = false;
    double depth2 = 0;
    /// Draft angle in degrees. Positive makes the section smaller as W increases.
    bool has_draft = false;
    double draft_deg = 0;
    /// Stop at this face of `current` instead of at `depth`.
    bool has_up_to = false;
    TopoDS_Face up_to;
};

/// `build_extrude` plus `extent`. All three flags false calls `build_extrude`, so a plain request builds as before.
TopoDS_Shape build_extrude_extent(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileSpec& profile,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    double& volume,
    std::string& error);
/// The profile turned `angle_deg` about the in-plane axis through (`axis_u`, `axis_v`) along (`dir_u`, `dir_v`),
/// combined with `current` by `which`.
TopoDS_Shape build_revolve(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const ProfileSpec& profile,
    const double* axis,
    double angle_deg,
    double& volume,
    std::string& error);
/// A solid through the sections in order, smooth or `ruled` (flat between sections), combined with `current` by
/// `which`. `before` is the volume of `current`; `volume` gets the result's.
TopoDS_Shape build_loft(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const std::vector<LoftSection>& sections,
    bool ruled,
    double& volume,
    std::string& error);

// --- K1 profile v2 builders. The point-list builders above are unchanged. ---

TopoDS_Shape build_extrude_loops(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    double depth,
    bool symmetric,
    double& volume,
    std::string& error);
/// `build_extrude_loops` plus `extent`: a second depth, a draft, or a face to stop at, on loops with arcs, splines,
/// and holes. No extent calls `build_extrude_loops`.
TopoDS_Shape build_extrude_loops_extent(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    double depth,
    bool symmetric,
    const ExtrudeExtent& extent,
    double& volume,
    std::string& error);
TopoDS_Shape build_revolve_loops(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const double origin[3],
    const double turn[3],
    const std::vector<ProfileLoop>& loops,
    const double* axis,
    double angle_deg,
    double& volume,
    std::string& error);
TopoDS_Shape build_loft_loops(
    const TopoDS_Shape& current,
    double before,
    const std::string& which,
    const std::vector<LoftSection>& sections,
    bool ruled,
    double& volume,
    std::string& error);
/// The sealed hollows and loose pieces `built` has that `from` did not, as JSON fields without braces: `voids`, each
/// a box, and `pieces`, each a box with its volume and its gap to the largest body. Empty when there are none.
std::string piece_report(const TopoDS_Shape& from, const TopoDS_Shape& built);
/// `current` hollowed to walls `thickness` thick, inward, with `open` removed.
TopoDS_Shape build_shell(
    const TopoDS_Shape& current,
    double before,
    const std::vector<TopoDS_Face>& open,
    double thickness,
    double& volume,
    std::string& error);
int count_of(const TopoDS_Shape& shape, TopAbs_ShapeEnum kind);
/// For each edge of `edges`: 1 convex, 2 concave, 0 anything else (smooth, a seam, or on one face).
std::vector<int> edge_kinds(const TopoDS_Shape& shape, const std::vector<TopoDS_Edge>& edges);

// --- K4: faceExtrude, moveFaces, faceLoops. Keep this block together. ---

/// One face of a `moveFaces`, offset `distance` along the solid's outward normal.
struct FaceOffset {
    TopoDS_Face face;
    double distance = 0;
};

/// The face extruded along its outward normal. Positive distance is fused on, negative is cut out.
/// `draft_deg` of 0 and a null `up_to` build a prism; a draft or a stop-face uses a feature prism.
TopoDS_Shape build_face_extrude(
    const TopoDS_Shape& current,
    double before,
    const TopoDS_Face& face,
    double distance,
    double draft_deg,
    const TopoDS_Face* up_to,
    double& volume,
    std::string& error);
/// The faces offset by `FaceOffset::distance`; every other face stays, and the neighbours extend or trim.
TopoDS_Shape build_move_faces(
    const TopoDS_Shape& current,
    double before,
    const std::vector<FaceOffset>& faces,
    double& volume,
    std::string& error);
/// `{origin, turn, loops}` for a flat face: D2 loops in the face's plane. Empty, and `error` set, otherwise.
std::string face_loops_json(const TopoDS_Face& face, std::string& error);

}  // namespace lime_occt
