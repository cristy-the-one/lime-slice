// Text plate: a name plate with its letters raised, from the letters' outline.
//
// A recipe for lime-recipe API 1.3. `text_outline` asks the host for the letters as a flat outline (the recipe crate reads no
// fonts), so a recipe can size a plate to the text, extrude the letters, or cut a stencil from them. Here the plate is the
// text's box plus a margin, and the letters stand on it.
//
//   recipe_run {path: "samples/recipes/text_plate.rs", params: {text: "LIME SLICE", size: 12}}
use lime_recipe::{ops, Json, Session};

fn main() {
    let mut s = Session::start();
    let text = s.text("text", "LIME 42").max_len(60).label("Text").get();
    let size = s.number("size", 10.0).range(4.0, 40.0).step(0.5).unit("mm").label("Capital height").get();
    let margin = s.number("margin", 3.0).range(1.0, 15.0).unit("mm").label("Margin").get();
    let thickness = s.number("plate", 2.0).range(1.0, 6.0).unit("mm").label("Plate thickness").get();
    let raise = s.number("raise", 1.0).range(0.3, 4.0).unit("mm").label("Letter height").get();
    let font = s.choice("font", &["sans", "mono", "serif", "stencil"], "sans").label("Font").get();

    let letters = match s.text_outline(&text, &font, size) {
        Ok(section) => section,
        // A letter the font lacks: the layout says which.
        Err(refused) => s.refuse(&refused.reason),
    };
    let bounds = letters.region.bbox();
    let (width, depth) = (bounds[1][0] - bounds[0][0], bounds[1][1] - bounds[0][1]);
    let plate = s.solid_new(ops::cuboid(width + 2.0 * margin, depth + 2.0 * margin, thickness)).unwrap();

    // The outline is centred on the origin of its frame, as the plate is centred on X and Y.
    let shift = [-(bounds[0][0] + bounds[1][0]) / 2.0, -(bounds[0][1] + bounds[1][1]) / 2.0];
    let op = Json::obj()
        .set("kind", "extrude")
        .set("op", "fuse")
        .set("origin", [shift[0], shift[1], thickness])
        .set("turn", [0.0, 0.0, 0.0])
        .set("depth", raise)
        .set("loops", letters.loops.clone());
    s.apply(&plate, op).unwrap();
    s.done_with(&plate, Json::obj().set("widthMm", width + 2.0 * margin).set("inkMm2", letters.area));
}
