use super::*;

/// Flow, feed, and fan a bridge uses when the request asks. `None` on a field
/// keeps that field where overhang splitting already put it.
#[derive(Clone, Copy, Debug)]
pub struct BridgeTune {
    pub flow: Option<f64>,
    pub speed_mm_s: Option<f64>,
    /// PWM 0–255, already converted from a percent.
    pub fan_pwm: Option<u8>,
}

/// Slow unsupported spans, pin bridges, and raise the fan. The first layer is on the bed.
/// `tune` of `None` leaves bridge flow, speed, and fan where they are today.
///
/// With `bead_edge`, a span is held when at least a quarter of its bead's
/// width lies on the layer below, and its angle is read from the bead's far
/// edge. Without it, the centreline alone decides: a bead can hang wholly in
/// the air and still count as held, and the 42° band is never reached.
pub fn apply_overhang(
    paths: &mut Vec<Extrusion>,
    lower: &[Loop],
    layer_height: f64,
    line_width: f64,
    tune: Option<BridgeTune>,
    bead_edge: bool,
) {
    if lower.is_empty() || paths.is_empty() {
        return;
    }
    let margin = if bead_edge {
        Reach {
            ends: line_width * 0.65,
            hang: line_width * 0.25,
            edge: line_width * 0.5,
        }
    } else {
        Reach {
            ends: line_width * 0.65,
            hang: line_width * 0.65,
            edge: 0.0,
        }
    };
    let mut next = Vec::with_capacity(paths.len());
    for path in paths.drain(..) {
        if matches!(
            path.kind,
            PathKind::Skirt | PathKind::Support | PathKind::SupportInterface
        ) || path.points.len() < 2
        {
            next.push(path);
            continue;
        }
        next.extend(split_overhang(path, lower, layer_height, margin, tune));
    }
    *paths = next;
}

pub(super) fn split_overhang(
    path: Extrusion,
    lower: &[Loop],
    layer_height: f64,
    margin: Reach,
    tune: Option<BridgeTune>,
) -> Vec<Extrusion> {
    let pts = &path.points;
    let mut out = Vec::new();
    let mut cur: Vec<[f64; 2]> = vec![pts[0]];
    let mut cur_class = span_class(pts[0], pts[1], lower, layer_height, margin);
    for w in pts.windows(2) {
        let class = span_class(w[0], w[1], lower, layer_height, margin);
        if class_tag(class) != class_tag(cur_class) && cur.len() >= 2 {
            out.push(paint(&path, std::mem::take(&mut cur), cur_class, tune));
            cur.push(w[0]);
        }
        cur.push(w[1]);
        cur_class = class;
    }
    if cur.len() >= 2 {
        out.push(paint(&path, cur, cur_class, tune));
    }
    mark_fan_gaps(&mut out);
    if out.is_empty() {
        vec![path]
    } else {
        out
    }
}

#[derive(Clone, Copy)]
pub(super) enum SpanClass {
    Supported,
    Overhang(f64),
    Bridge,
}

pub(super) fn class_tag(c: SpanClass) -> u8 {
    match c {
        SpanClass::Supported => 0,
        SpanClass::Overhang(_) => 1,
        SpanClass::Bridge => 2,
    }
}

/// How far past the layer below a bead's centreline may reach.
#[derive(Clone, Copy)]
pub(super) struct Reach {
    /// A bridge's two ends, still anchored.
    ends: f64,
    /// The span itself, still held.
    hang: f64,
    /// From the centreline to the bead's far edge, which the angle reads.
    edge: f64,
}

pub(super) fn span_class(
    a: [f64; 2],
    b: [f64; 2],
    lower: &[Loop],
    layer_height: f64,
    margin: Reach,
) -> SpanClass {
    let mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
    let sa = supported(a, lower, margin.ends);
    let sb = supported(b, lower, margin.ends);
    let sm = supported(mid, lower, margin.ends);
    if sa && sb && !sm {
        let len = dist2(a, b).sqrt();
        if len >= 1.2 {
            return SpanClass::Bridge;
        }
    }
    let held = if margin.hang == margin.ends {
        sm
    } else {
        supported(mid, lower, margin.hang)
    };
    if held {
        return SpanClass::Supported;
    }
    let outside = outside_dist(mid, lower).max(outside_dist(a, lower)) + margin.edge;
    let angle = (outside / layer_height.max(0.05)).atan().to_degrees();
    if angle < 42.0 {
        SpanClass::Supported
    } else {
        SpanClass::Overhang(angle)
    }
}

pub(super) fn paint(
    src: &Extrusion,
    points: Vec<[f64; 2]>,
    class: SpanClass,
    tune: Option<BridgeTune>,
) -> Extrusion {
    let mut path = src.clone();
    path.points = points;
    let slow = match class {
        SpanClass::Supported => Slowdown::None,
        SpanClass::Bridge => {
            path.kind = PathKind::Bridge;
            path.fan = 255;
            path.fan_role = FanRole::Overhang { boost: 255 };
            path.strength = path.strength.min(0.7);
            Slowdown::Bridge
        }
        SpanClass::Overhang(angle) => {
            let boost = if angle >= 68.0 { 255 } else { 220 };
            path.fan = path.fan.max(boost);
            path.fan_role = FanRole::Overhang { boost };
            path.on_overhang = true;
            if angle >= 68.0 {
                Slowdown::Steep
            } else {
                Slowdown::Overhang
            }
        }
    };
    path.speed = slow.speed(path.speed);
    if let Some(cap) = &mut path.cap_feed {
        cap.slow = slow;
    }
    if let (SpanClass::Bridge, Some(tune)) = (class, tune) {
        if let Some(ratio) = tune.flow {
            path.flow *= ratio;
        }
        if let Some(pwm) = tune.fan_pwm {
            path.fan = pwm;
            path.fan_hold = true;
        }
        if let Some(speed) = tune.speed_mm_s {
            // An explicit feed replaces the 18–36 mm/s clamp, including a
            // speed the clamp would have raised. The cap must agree, or a
            // later object speed cap would put the clamp back.
            path.speed = speed;
            if let Some(cap) = &mut path.cap_feed {
                cap.feed = speed;
                cap.slow = Slowdown::None;
            }
        }
    }
    path
}

/// An overhang span that rests on support interface instead of the part:
/// printed like a bridge, never faster than it already was, and with the
/// bridge flow and fan when the request set them. Its kind stays.
pub fn rest_on_interface(path: &mut Extrusion, tune: Option<BridgeTune>) {
    let cap = path.cap_feed;
    let feed = cap.map_or(path.speed, |c| c.feed);
    let bridge = Slowdown::Bridge.speed(feed);
    if bridge < path.speed {
        path.speed = bridge;
        if let Some(cap) = &mut path.cap_feed {
            cap.slow = Slowdown::Bridge;
        }
    }
    path.fan = 255;
    path.fan_role = FanRole::Overhang { boost: 255 };
    let Some(tune) = tune else {
        return;
    };
    if let Some(ratio) = tune.flow {
        path.flow *= ratio;
    }
    if let Some(pwm) = tune.fan_pwm {
        path.fan = pwm;
        path.fan_hold = true;
    }
    if let Some(speed) = tune.speed_mm_s {
        path.speed = speed;
        if let Some(cap) = &mut path.cap_feed {
            cap.feed = speed;
            cap.slow = Slowdown::None;
        }
    }
}

/// A supported stretch shorter than this between two overhang or bridge
/// spans keeps their fan: a fan cannot spin down and up again that fast, and
/// each change is one more `M106`.
pub(super) const FAN_GAP_MM: f64 = 5.0;

/// Mark each short supported piece between two overhang pieces of one path.
pub(super) fn mark_fan_gaps(pieces: &mut [Extrusion]) {
    let raised = |p: &Extrusion| matches!(p.fan_role, FanRole::Overhang { .. });
    for i in 1..pieces.len().saturating_sub(1) {
        if raised(&pieces[i]) || !raised(&pieces[i - 1]) || !raised(&pieces[i + 1]) {
            continue;
        }
        let len: f64 = pieces[i]
            .points
            .windows(2)
            .map(|w| dist2(w[0], w[1]).sqrt())
            .sum();
        if len < FAN_GAP_MM {
            pieces[i].fan_role = FanRole::Gap;
        }
    }
}

pub(super) fn supported(p: [f64; 2], lower: &[Loop], margin: f64) -> bool {
    if in_solid(lower, p[0], p[1]) {
        return true;
    }
    outside_dist(p, lower) <= margin
}

pub(super) fn outside_dist(p: [f64; 2], lower: &[Loop]) -> f64 {
    if in_solid(lower, p[0], p[1]) {
        return 0.0;
    }
    let mut best = f64::MAX;
    for loop_ in lower {
        let n = loop_.len();
        for i in 0..n {
            let d = point_seg_dist(p, loop_[i], loop_[(i + 1) % n]);
            if d < best {
                best = d;
            }
        }
    }
    best
}

pub(super) fn point_seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let len2 = abx * abx + aby * aby;
    if len2 < 1e-12 {
        return dist2(p, a).sqrt();
    }
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    let t = t.clamp(0.0, 1.0);
    dist2(p, [a[0] + abx * t, a[1] + aby * t]).sqrt()
}

#[cfg(test)]
mod bridge_tests {
    use super::*;
    use crate::strategy::{pure, StrategyId};

    fn square(x0: f64, x1: f64) -> Vec<[f64; 2]> {
        vec![[x0, 0.0], [x1, 0.0], [x1, 10.0], [x0, 10.0]]
    }

    fn span() -> Extrusion {
        let mut path = extrusion(
            PathKind::Solid,
            &pure(StrategyId::Speed),
            vec![[2.0, 5.0], [18.0, 5.0]],
            0.45,
        );
        path.speed = 60.0;
        path.cap_feed = Some(CapFeed {
            feed: 60.0,
            slow: Slowdown::None,
        });
        path
    }

    fn bridges(tune: Option<BridgeTune>) -> Vec<Extrusion> {
        let mut paths = vec![span()];
        let lower = vec![square(0.0, 6.0), square(14.0, 20.0)];
        apply_overhang(&mut paths, &lower, 0.2, 0.45, tune, false);
        paths
            .into_iter()
            .filter(|p| p.kind == PathKind::Bridge)
            .collect()
    }

    #[test]
    fn a_span_between_two_islands_keeps_the_bridge_slowdown() {
        let found = bridges(None);
        assert_eq!(found.len(), 1);
        let path = &found[0];
        assert!((path.flow - 1.0).abs() < 1e-9);
        assert_eq!(path.fan, 255);
        assert!(!path.fan_hold);
        assert!((path.speed - 36.0).abs() < 1e-9, "speed {}", path.speed);
        let cap = path.cap_feed.expect("cap");
        assert_eq!(cap.slow, Slowdown::Bridge);
        assert!((cap.feed - 60.0).abs() < 1e-9);
    }

    #[test]
    fn a_requested_bridge_replaces_flow_speed_and_fan() {
        let found = bridges(Some(BridgeTune {
            flow: Some(0.9),
            speed_mm_s: Some(15.0),
            fan_pwm: Some(204),
        }));
        assert_eq!(found.len(), 1);
        let path = &found[0];
        assert!((path.flow - 0.9).abs() < 1e-9);
        assert!((path.speed - 15.0).abs() < 1e-9, "speed {}", path.speed);
        assert_eq!(path.fan, 204);
        assert!(path.fan_hold);
        let cap = path.cap_feed.expect("cap");
        assert_eq!(cap.slow, Slowdown::None);
        assert!((cap.feed - 15.0).abs() < 1e-9);
    }

    fn wall(points: Vec<[f64; 2]>) -> Vec<Extrusion> {
        let mut paths = vec![extrusion(
            PathKind::Outer,
            &pure(StrategyId::Toughness),
            points,
            0.45,
        )];
        apply_overhang(&mut paths, &[square(0.0, 10.0)], 0.2, 0.45, None, false);
        paths
    }

    #[test]
    fn both_overhang_bands_and_bridges_take_the_overhang_role_and_keep_their_fan() {
        // 0.35 mm out is a 60° overhang, 1 mm out a 79° one.
        for (out, boost) in [(0.35, 220), (1.0, 255)] {
            let found = wall(vec![[10.0 + out, 1.0], [10.0 + out, 9.0]]);
            assert_eq!(found.len(), 1);
            assert!(found[0].on_overhang);
            assert_eq!(found[0].fan, boost, "{out} mm out");
            assert_eq!(found[0].fan_role, FanRole::Overhang { boost });
        }
        let bridge = &bridges(None)[0];
        assert_eq!(bridge.fan_role, FanRole::Overhang { boost: 255 });
        let support = extrusion(
            PathKind::Support,
            &pure(StrategyId::Speed),
            vec![[0.0, 0.0], [1.0, 0.0]],
            0.45,
        );
        assert_eq!(support.fan_role, FanRole::Support);
    }

    #[test]
    fn a_short_supported_gap_between_overhangs_shares_their_fan() {
        // Out, back over the part, out again.
        let jog = |back: f64| {
            vec![
                [10.5, 1.0],
                [10.5, 3.0],
                [9.5, 3.0],
                [9.5, 3.0 + back],
                [10.5, 3.0 + back],
                [10.5, 5.0 + back],
            ]
        };
        let roles = |back: f64| {
            wall(jog(back))
                .iter()
                .map(|p| p.fan_role)
                .collect::<Vec<_>>()
        };
        let steep = FanRole::Overhang { boost: 255 };
        assert_eq!(roles(2.0), vec![steep, FanRole::Gap, steep], "4 mm back");
        assert_eq!(roles(5.0), vec![steep, FanRole::Part, steep], "7 mm back");
        let short = wall(jog(2.0));
        assert_eq!(short[1].fan, 150, "the gap keeps its planned fan");
    }

    fn fed_wall(out: f64) -> Vec<Extrusion> {
        let mut path = extrusion(
            PathKind::Outer,
            &pure(StrategyId::Speed),
            vec![[10.0 + out, 1.0], [10.0 + out, 9.0]],
            0.45,
        );
        path.speed = 130.0;
        path.cap_feed = Some(CapFeed {
            feed: 130.0,
            slow: Slowdown::None,
        });
        let mut paths = vec![path];
        apply_overhang(&mut paths, &[square(0.0, 10.0)], 0.2, 0.45, None, true);
        paths
    }

    #[test]
    fn a_bead_that_touches_nothing_below_is_slowed() {
        // 0.28 mm out, the whole 0.45 mm bead lies past the layer below: a
        // belt ramp stepping 0.5 mm a layer. The centreline test called it held.
        let found = fed_wall(0.28);
        assert_eq!(found.len(), 1);
        assert!(found[0].on_overhang);
        assert!(
            (found[0].speed - 130.0 * 0.32).abs() < 1e-9,
            "speed {}",
            found[0].speed
        );
        assert_eq!(found[0].cap_feed.expect("cap").slow, Slowdown::Steep);
    }

    #[test]
    fn a_bead_with_a_quarter_of_its_width_on_the_layer_below_is_held() {
        let found = fed_wall(0.15);
        assert!(
            found[0].on_overhang,
            "0.15 mm out leaves less than a quarter held"
        );
        let held = fed_wall(0.1);
        assert_eq!(held.len(), 1);
        assert!(!held[0].on_overhang);
        assert!((held[0].speed - 130.0).abs() < 1e-9);
    }

    #[test]
    fn a_span_on_support_interface_prints_like_a_bridge_but_never_faster() {
        let mut steep = fed_wall(0.28).remove(0);
        rest_on_interface(&mut steep, None);
        assert!((steep.speed - 36.0).abs() < 1e-9, "speed {}", steep.speed);
        assert_eq!(steep.cap_feed.expect("cap").slow, Slowdown::Bridge);
        assert_eq!(steep.fan, 255);
        assert_eq!(steep.kind, PathKind::Outer);
        let mut slow = fed_wall(0.28).remove(0);
        slow.speed = 20.0;
        slow.cap_feed = Some(CapFeed {
            feed: 62.5,
            slow: Slowdown::Steep,
        });
        rest_on_interface(&mut slow, None);
        assert!((slow.speed - 20.0).abs() < 1e-9, "speed {}", slow.speed);
        assert_eq!(slow.cap_feed.expect("cap").slow, Slowdown::Steep);
        let mut tuned = fed_wall(0.28).remove(0);
        rest_on_interface(
            &mut tuned,
            Some(BridgeTune {
                flow: Some(0.9),
                speed_mm_s: Some(15.0),
                fan_pwm: Some(204),
            }),
        );
        assert!((tuned.flow - 0.9).abs() < 1e-9);
        assert!((tuned.speed - 15.0).abs() < 1e-9);
        assert_eq!(tuned.fan, 204);
        assert!(tuned.fan_hold);
    }
}
