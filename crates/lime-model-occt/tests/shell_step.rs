//! STEP files from mesh converters carry closed shells of loose facets and no solid.
//! Three 10 mm cubes written that way, two sharing a wall and one wound inside out,
//! open as 3000 mm³ that splits, cuts, and drills. A shell with a gap, or one that
//! crosses itself, opens for measuring only.

use std::fmt::Write as _;
use std::path::PathBuf;

use serde_json::Value;

type Triangle = [[f64; 3]; 3];

const VIEW_ONLY: &str =
    "This STEP file has surfaces but no closed solid, so it can be measured but not edited.";

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|err| panic!("not JSON ({err}): {text}"))
}

fn near(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.05,
        "{actual} is not near {expected}"
    );
}

fn volume(json: &Value) -> f64 {
    assert!(json.get("error").is_none(), "{json}");
    json["volumeMm3"].as_f64().expect("volume")
}

/// Twelve outward triangles of an axis-aligned box, two per side, top side first.
fn box_triangles(min: [f64; 3], max: [f64; 3]) -> Vec<Triangle> {
    let p = |x: usize, y: usize, z: usize| {
        [
            if x == 0 { min[0] } else { max[0] },
            if y == 0 { min[1] } else { max[1] },
            if z == 0 { min[2] } else { max[2] },
        ]
    };
    let quads = [
        [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
        [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
        [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
        [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
        [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
        [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    ];
    quads
        .iter()
        .flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]])
        .collect()
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn unit(v: [f64; 3]) -> [f64; 3] {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / length, v[1] / length, v[2] / length]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// One product per shell, each facet a FACE_SURFACE with its own edges, as ImageToStl.com writes them.
fn facet_step(shells: &[Vec<Triangle>]) -> String {
    let mut data = String::new();
    let mut next = 100;
    let mut add = |data: &mut String, entity: String| {
        next += 1;
        writeln!(data, "#{next}={entity};").unwrap();
        next
    };
    let point = |p: [f64; 3]| format!("CARTESIAN_POINT('',({:?},{:?},{:?}))", p[0], p[1], p[2]);
    let direction = |d: [f64; 3]| format!("DIRECTION('',({:?},{:?},{:?}))", d[0], d[1], d[2]);
    for (index, triangles) in shells.iter().enumerate() {
        let mut faces = Vec::new();
        for t in triangles {
            let vertices: Vec<usize> = t
                .iter()
                .map(|p| {
                    let at = add(&mut data, point(*p));
                    add(&mut data, format!("VERTEX_POINT('',#{at})"))
                })
                .collect();
            let mut oriented = Vec::new();
            for i in 0..3 {
                let (a, b) = (t[i], t[(i + 1) % 3]);
                let start = add(&mut data, point(a));
                let dir = add(&mut data, direction(unit(sub(b, a))));
                let vector = add(&mut data, format!("VECTOR('',#{dir},1.0)"));
                let line = add(&mut data, format!("LINE('',#{start},#{vector})"));
                let edge = add(
                    &mut data,
                    format!(
                        "EDGE_CURVE('',#{},#{},#{line},.T.)",
                        vertices[i],
                        vertices[(i + 1) % 3]
                    ),
                );
                oriented.push(add(&mut data, format!("ORIENTED_EDGE('',*,*,#{edge},.T.)")));
            }
            let refs: Vec<String> = oriented.iter().map(|e| format!("#{e}")).collect();
            let edge_loop = add(&mut data, format!("EDGE_LOOP('',({}))", refs.join(",")));
            let bound = add(&mut data, format!("FACE_BOUND('',#{edge_loop},.T.)"));
            let origin = add(&mut data, point(t[0]));
            let normal = add(
                &mut data,
                direction(unit(cross(sub(t[1], t[0]), sub(t[2], t[0])))),
            );
            let x_axis = add(&mut data, direction(unit(sub(t[1], t[0]))));
            let axes = add(
                &mut data,
                format!("AXIS2_PLACEMENT_3D('',#{origin},#{normal},#{x_axis})"),
            );
            let plane = add(&mut data, format!("PLANE('',#{axes})"));
            faces.push(add(
                &mut data,
                format!("FACE_SURFACE('',(#{bound}),#{plane},.T.)"),
            ));
        }
        let refs: Vec<String> = faces.iter().map(|f| format!("#{f}")).collect();
        let shell = add(&mut data, format!("CLOSED_SHELL('',({}))", refs.join(",")));
        let model = add(
            &mut data,
            format!("SHELL_BASED_SURFACE_MODEL('',(#{shell}))"),
        );
        let product = add(
            &mut data,
            format!("PRODUCT('part{index}','part{index}','',(#13))"),
        );
        let formation = add(
            &mut data,
            format!(
                "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#{product},.NOT_KNOWN.)"
            ),
        );
        let definition = add(
            &mut data,
            format!("PRODUCT_DEFINITION('','',#{formation},#1)"),
        );
        let shape = add(
            &mut data,
            format!("PRODUCT_DEFINITION_SHAPE('','',#{definition})"),
        );
        let representation = add(
            &mut data,
            format!("MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(#{model},#9),#3)"),
        );
        add(
            &mut data,
            format!("SHAPE_DEFINITION_REPRESENTATION(#{shape},#{representation})"),
        );
    }
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('shells','2026-10-14T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN_CC2'));
ENDSEC;
DATA;
#1=PRODUCT_DEFINITION_CONTEXT('',#4,'design');
#2=APPLICATION_PROTOCOL_DEFINITION('INTERNATIONAL STANDARD','automotive_design',1994,#4);
#3=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#5))GLOBAL_UNIT_ASSIGNED_CONTEXT((#6,#7,#8))REPRESENTATION_CONTEXT('NONE','WORKSPACE'));
#4=APPLICATION_CONTEXT(' ');
#5=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.0E-006),#6,'','');
#6=(NAMED_UNIT(#11)LENGTH_UNIT()SI_UNIT(.MILLI.,.METRE.));
#7=(NAMED_UNIT(#12)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#8=(NAMED_UNIT(#12)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.));
#9=AXIS2_PLACEMENT_3D('',#14,#15,#16);
#11=DIMENSIONAL_EXPONENTS(1.0,0.0,0.0,0.0,0.0,0.0,0.0);
#12=DIMENSIONAL_EXPONENTS(0.0,0.0,0.0,0.0,0.0,0.0,0.0);
#13=PRODUCT_CONTEXT('',#4,'mechanical');
#14=CARTESIAN_POINT('',(0.0,0.0,0.0));
#15=DIRECTION('',(0.0,0.0,1.0));
#16=DIRECTION('',(1.0,0.0,0.0));
{data}ENDSEC;
END-ISO-10303-21;
"
    )
}

fn write_step(name: &str, shells: &[Vec<Triangle>]) -> PathBuf {
    let path = std::env::temp_dir().join(format!("lime-shell-{name}-{}.step", std::process::id()));
    std::fs::write(&path, facet_step(shells)).expect("write step");
    path
}

fn plane(origin: [f64; 3], normal: [f64; 3]) -> lime_model_occt::Plane {
    lime_model_occt::Plane { origin, normal }
}

fn cutter(origin: [f64; 3], size: [f64; 3]) -> lime_model_occt::Tool {
    lime_model_occt::Tool {
        origin,
        size,
        radius: 0.0,
        height: 0.0,
        turn: [0.0; 3],
    }
}

#[test]
fn facet_shells_open_as_editable_solids() {
    if parse(&lime_model_occt::open_box(1.0, 1.0, 1.0))
        .get("error")
        .is_some()
    {
        assert!(
            std::env::var_os("LIME_REQUIRE_OCCT").is_none(),
            "OCCT was required"
        );
        return;
    }

    let whole = box_triangles([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let touching = box_triangles([10.0, 0.0, 0.0], [20.0, 10.0, 10.0]);
    let inverted: Vec<Triangle> = box_triangles([40.0, 0.0, 0.0], [50.0, 10.0, 10.0])
        .into_iter()
        .map(|t| [t[0], t[2], t[1]])
        .collect();
    let path = write_step("cubes", &[whole.clone(), touching, inverted]);
    let opened = parse(&lime_model_occt::open_step(&path, 0.1));
    near(volume(&opened), 3000.0);
    let id = opened["id"].as_i64().expect("id") as i32;

    let split = parse(&lime_model_occt::split(
        id,
        plane([25.0, 5.0, 5.0], [0.0, 0.0, 1.0]),
        0.1,
    ));
    near(volume(&split), 1500.0);
    near(volume(&split["other"]), 1500.0);
    near(volume(&parse(&lime_model_occt::undo(id, 0.1))), 3000.0);

    let cut = parse(&lime_model_occt::boolean(
        id,
        "cut",
        "box",
        cutter([5.0, -1.0, -1.0], [10.0, 12.0, 12.0]),
        0.1,
    ));
    near(volume(&cut), 2000.0);
    near(volume(&parse(&lime_model_occt::undo(id, 0.1))), 3000.0);

    let drilled = parse(&lime_model_occt::hole(id, [45.0, 5.0, 10.0], 2.0, 4.0, 0.1));
    near(volume(&drilled), 3000.0 - std::f64::consts::PI * 16.0);
    let _ = std::fs::remove_file(&path);

    let gap: Vec<Triangle> = whole.iter().skip(1).copied().collect();
    let crossed: Vec<Triangle> = whole
        .iter()
        .map(|t| {
            t.map(|p| {
                if p == [10.0, 10.0, 10.0] {
                    [10.0, 10.0, -5.0]
                } else {
                    p
                }
            })
        })
        .collect();
    for (name, shell) in [("gap", gap), ("crossed", crossed)] {
        let path = write_step(name, &[shell]);
        let opened = parse(&lime_model_occt::open_step(&path, 0.1));
        assert!(opened.get("error").is_none(), "{name}: {opened}");
        let id = opened["id"].as_i64().expect("id") as i32;
        let refusals = [
            lime_model_occt::split(id, plane([5.0, 5.0, 5.0], [0.0, 0.0, 1.0]), 0.1),
            lime_model_occt::boolean(
                id,
                "cut",
                "box",
                cutter([-1.0, -1.0, -1.0], [6.0, 12.0, 12.0]),
                0.1,
            ),
            lime_model_occt::hole(id, [5.0, 5.0, 10.0], 2.0, 4.0, 0.1),
            lime_model_occt::fillet(id, 0, 1.0, 0.1),
        ];
        for refusal in refusals {
            assert_eq!(parse(&refusal)["error"].as_str(), Some(VIEW_ONLY), "{name}");
        }
        let _ = std::fs::remove_file(&path);
    }
}
