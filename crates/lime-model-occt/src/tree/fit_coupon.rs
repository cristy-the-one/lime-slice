//! The fit coupon: a stateless call that builds a small test piece for a pin or hole tolerance.

use super::*;

/// --- Split to print, the fit coupon (plan section 2, milestone 6): what the planner in `src/modeling/fit-coupon.ts`
/// lays out. A plate from the origin to `sizeMm`, holes bored into its front face along +Y, labels cut into that face,
/// and the pins that go in the holes, standing along +Z.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CouponSpec {
    size_mm: [f64; 3],
    holes: Vec<CouponHole>,
    /// Each stroke of the labels: x, z, length, angle in degrees from X.
    #[serde(default)]
    strokes: Vec<[f64; 4]>,
    #[serde(default)]
    stroke_mm: f64,
    #[serde(default)]
    engrave_mm: f64,
    #[serde(default)]
    pins: Vec<CouponPin>,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CouponHole {
    x: f64,
    z: f64,
    radius_mm: f64,
    depth_mm: f64,
    #[serde(default)]
    teardrop: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CouponPin {
    x: f64,
    y: f64,
    radius_mm: f64,
    length_mm: f64,
}

/// The coupon's plate and pins, each as `{volumeMm3, solids, valid, closed, bounds, stepB64, surfaces?}`, and the volume
/// the labels took. `files` adds each as a STEP file, `surfaces` each face's surface (a test path).
pub(super) fn fit_coupon_reply(spec: &CouponSpec, files: bool, surfaces: bool) -> Result<Value, String> {
    let _budget = GroupBudget::start();
    let holes: Vec<f64> = spec
        .holes
        .iter()
        .flat_map(|hole| {
            [
                hole.x,
                hole.z,
                hole.radius_mm,
                hole.depth_mm,
                if hole.teardrop { 1.0 } else { 0.0 },
            ]
        })
        .collect();
    let strokes: Vec<f64> = spec.strokes.iter().flatten().copied().collect();
    let pins: Vec<f64> = spec
        .pins
        .iter()
        .flat_map(|pin| [pin.x, pin.y, pin.radius_mm, pin.length_mm])
        .collect();
    let engrave = [spec.stroke_mm, spec.engrave_mm];
    let mut plate: *mut RawShape = std::ptr::null_mut();
    let mut pins_out: *mut RawShape = std::ptr::null_mut();
    let mut engraved = 0.0_f64;
    let mut error: *mut c_char = std::ptr::null_mut();
    // SAFETY: `holes` holds five numbers a hole, `strokes` four a stroke, `pins` four a pin, `engrave` two, and `size_mm` three.
    let made = unsafe {
        lime_tree_fit_coupon(
            spec.size_mm.as_ptr(),
            holes.as_ptr(),
            c_int::try_from(spec.holes.len()).map_err(|_| "Too many holes".to_string())?,
            strokes.as_ptr(),
            c_int::try_from(spec.strokes.len()).map_err(|_| "Too many strokes".to_string())?,
            engrave.as_ptr(),
            pins.as_ptr(),
            c_int::try_from(spec.pins.len()).map_err(|_| "Too many pins".to_string())?,
            &mut plate,
            &mut pins_out,
            &mut engraved,
            &mut error,
        )
    };
    let message = take_text(error);
    let plate = NonNull::new(plate).map(Shape);
    let pins_shape = NonNull::new(pins_out).map(Shape);
    let plate = match (made, plate) {
        (0, Some(plate)) => plate,
        _ => return Err(message.unwrap_or_else(|| "Open CASCADE failed".into())),
    };
    let name = if spec.name.trim().is_empty() {
        "fit-coupon".to_string()
    } else {
        spec.name.trim().to_string()
    };
    let report = |shape: &Shape, name: &str| -> Result<Value, String> {
        let check = shape.check();
        let mut one = json!({
            "volumeMm3": check.volume_mm3,
            "solids": check.solids,
            "valid": check.valid,
            "closed": check.closed,
            "bounds": shape.bounds(),
        });
        if surfaces {
            let text = take_text(unsafe { lime_tree_surfaces(shape.raw()) })
                .ok_or_else(|| "No surfaces".to_string())?;
            one["surfaces"] = serde_json::from_str(&text).map_err(|err| err.to_string())?;
        }
        if files {
            let bytes = Shape::step_bytes_of(&[shape.raw()], &[name.to_string()], &[])?;
            one["stepB64"] = json!(base64::engine::general_purpose::STANDARD.encode(&bytes));
        }
        Ok(one)
    };
    let plate_report = report(&plate, &name)?;
    let pins_report = match pins_shape.as_ref() {
        Some(pins) => {
            let mut one = report(pins, &format!("{name}-pins"))?;
            one["each"] = json!(pins
                .solids()?
                .iter()
                .map(|pin| pin.check().volume_mm3)
                .collect::<Vec<_>>());
            one
        }
        None => Value::Null,
    };
    Ok(json!({ "plate": plate_report, "pins": pins_report, "engravedMm3": engraved }))
}

/// --- Split to print, the fit coupon, for tests: the spec as JSON, the answer as `fit_coupon_reply` with each face's
/// surface and no files.
pub fn fit_coupon(spec: &str) -> Result<String, String> {
    let spec: CouponSpec = serde_json::from_str(spec).map_err(|err| err.to_string())?;
    let _store = lock();
    Ok(fit_coupon_reply(&spec, false, true)?.to_string())
}
