// Label a face: letters raised on (or engraved into) any face of the part, flat or curved.
//
// A recipe for lime-recipe API 1.3. The face is a parameter the person picks (a click in the view, or a face index over
// MCP); `curved()` lets it be a cylinder, a cone, a sphere, a torus or a freeform face as well as a flat one. With no pick the
// largest face of the part is used. The text is one history step: on a curved face the letters wrap along the surface at true
// size and stand `depth` off it, square to it.
//
//   recipe_run {path: "samples/recipes/label_a_face.rs", object, params: {face: 3, label: "LOT 42", font: "mono"}}
use lime_recipe::{Json, Lettering, Session};

fn main() {
    let mut s = Session::start();
    let face = s.face("face").curved().rule("largest").label("Face to label").get();
    let label = s.text("label", "LOT 42").max_len(80).label("Text").get();
    let font = s.choice("font", &["sans", "mono", "serif", "stencil", "stroke", "line"], "mono").label("Font").get();
    let height = s.number("height", 4.0).range(1.5, 20.0).step(0.5).unit("mm").label("Capital height").get();
    let depth = s.number("depth", 0.5).range(0.2, 3.0).step(0.1).unit("mm").label("Depth").get();
    let engrave = s.toggle("engrave", false).label("Engrave instead of raise").get();
    let part = match s.object() {
        Some(part) => part,
        None => s.refuse("Pass the part to label as object."),
    };

    let picked = s.pick_face(&part, &face).unwrap();
    let mut how = Lettering::new(height, depth).font(&font);
    if engrave {
        how = how.engrave();
    }
    // A pen font takes no weight; an outline font in Bold prints better at small sizes.
    if font != "stroke" && font != "line" && font != "stencil" {
        how = how.style("bold");
    }
    if let Err(refused) = s.lettering(&part, &picked, &label, &how) {
        // The engine's sentence says what to change: a letter the font lacks, text too long for the face, too deep for the curve.
        s.refuse(&refused.reason);
    }
    let volume = s.volume(&part).unwrap();
    s.done_with(
        &part,
        Json::obj().set("face", picked.index).set("surface", picked.kind.as_str()).set("volumeMm3", volume),
    );
}
