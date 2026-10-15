use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use serde::Serialize;

use crate::mesh::Mesh;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshPreview {
    pub triangles: usize,
    pub min: [f64; 3],
    pub max: [f64; 3],
    /// XYZ triples, millimetres, already seated on Z = 0.
    pub positions: Vec<f32>,
    /// How far the file was lowered to seat it: its own Z is `positions` Z plus this. X and Y are the file's.
    pub seat_mm: f64,
}

pub fn mesh_preview(filename: &str, bytes: &[u8]) -> Result<MeshPreview, String> {
    mesh_preview_tol(filename, bytes, 0.0)
}

pub fn mesh_preview_tol(
    filename: &str,
    bytes: &[u8],
    step_tolerance_mm: f64,
) -> Result<MeshPreview, String> {
    let mut mesh = load_slice_mesh_tol(filename, bytes, true, step_tolerance_mm)?;
    let (raw_min, _) = mesh.bounds().ok_or("empty mesh")?;
    mesh.settle_on_bed();
    // `settle_on_bed` leaves a mesh within a nanometre of the bed where it is.
    let seat_mm = if raw_min[2].abs() < 1e-9 { 0.0 } else { raw_min[2] };
    let (min, max) = mesh.bounds().ok_or("empty mesh")?;
    let mut positions = Vec::with_capacity(mesh.triangles.len() * 9);
    for tri in &mesh.triangles {
        for v in tri {
            positions.push(v[0] as f32);
            positions.push(v[1] as f32);
            positions.push(v[2] as f32);
        }
    }
    Ok(MeshPreview {
        triangles: mesh.triangle_count(),
        min,
        max,
        positions,
        seat_mm,
    })
}

pub fn load_mesh(filename: &str, bytes: &[u8]) -> Result<Mesh, String> {
    load_slice_mesh(filename, bytes, false)
}

/// Load a mesh for slicing.
///
/// When `pose_after` is set, the bytes are the scaled canonical frame and a
/// rigid pose places them afterwards, so they are not seated on the bed here.
/// STEP files tessellate at [`crate::step::STEP_TOLERANCE_DEFAULT_MM`].
pub fn load_slice_mesh(filename: &str, bytes: &[u8], pose_after: bool) -> Result<Mesh, String> {
    load_slice_mesh_tol(filename, bytes, pose_after, 0.0)
}

/// Like [`load_slice_mesh`], with an explicit STEP chord tolerance in millimetres.
///
/// `step_tolerance_mm` of `0` uses the default. STL and 3MF ignore it.
pub fn load_slice_mesh_tol(
    filename: &str,
    bytes: &[u8],
    pose_after: bool,
    step_tolerance_mm: f64,
) -> Result<Mesh, String> {
    let lower = filename.to_ascii_lowercase();
    let mut mesh = if lower.ends_with(".step") || lower.ends_with(".stp") {
        crate::step::load_step(bytes, step_tolerance_mm)?
    } else if lower.ends_with(".3mf") || looks_like_zip(bytes) && !lower.ends_with(".stl") {
        load_3mf(bytes)?
    } else if lower.ends_with(".stl") || looks_like_stl(bytes) {
        load_stl(bytes)?
    } else if looks_like_zip(bytes) {
        load_3mf(bytes)?
    } else {
        return Err("unsupported mesh: use STL, 3MF, or STEP".into());
    };
    if mesh.triangles.is_empty() {
        return Err("mesh contains no triangles".into());
    }
    if !pose_after {
        mesh.settle_on_bed();
    }
    Ok(mesh)
}

fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.len() > 4 && bytes[0] == b'P' && bytes[1] == b'K'
}

fn looks_like_stl(bytes: &[u8]) -> bool {
    let n = bytes.len();
    if n >= 84 {
        let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
        if n == 84 + count * 50 && count > 0 {
            return true;
        }
    }
    let head = std::str::from_utf8(&bytes[..bytes.len().min(64)]).unwrap_or("");
    head.trim_start().to_ascii_lowercase().starts_with("solid")
}

pub fn load_stl(bytes: &[u8]) -> Result<Mesh, String> {
    if bytes.len() >= 84 {
        let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
        if bytes.len() == 84 + count * 50 && count > 0 {
            return load_stl_binary(bytes, count);
        }
    }
    load_stl_ascii(bytes)
}

fn load_stl_binary(bytes: &[u8], count: usize) -> Result<Mesh, String> {
    let mut triangles = Vec::with_capacity(count);
    for i in 0..count {
        let base = 84 + i * 50;
        let mut tri = [[0.0; 3]; 3];
        for (v, vertex) in tri.iter_mut().enumerate() {
            for (c, coord) in vertex.iter_mut().enumerate() {
                let o = base + 12 + v * 12 + c * 4;
                *coord = f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as f64;
            }
        }
        if !degenerate(&tri) {
            triangles.push(tri);
        }
    }
    Ok(Mesh { triangles })
}

fn load_stl_ascii(bytes: &[u8]) -> Result<Mesh, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "ASCII STL is not UTF-8".to_string())?;
    let mut triangles = Vec::new();
    let mut verts = Vec::with_capacity(3);
    for line in text.lines() {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("vertex") {
            let src = &line[line.len() - rest.len()..];
            let mut nums = src.split_whitespace();
            let x: f64 = nums
                .next()
                .ok_or("vertex missing x")?
                .parse()
                .map_err(|_| "bad vertex")?;
            let y: f64 = nums
                .next()
                .ok_or("vertex missing y")?
                .parse()
                .map_err(|_| "bad vertex")?;
            let z: f64 = nums
                .next()
                .ok_or("vertex missing z")?
                .parse()
                .map_err(|_| "bad vertex")?;
            verts.push([x, y, z]);
            if verts.len() == 3 {
                let tri = [verts[0], verts[1], verts[2]];
                if !degenerate(&tri) {
                    triangles.push(tri);
                }
                verts.clear();
            }
        }
    }
    if triangles.is_empty() {
        return Err("ASCII STL contained no triangles".into());
    }
    Ok(Mesh { triangles })
}

fn degenerate(tri: &[[f64; 3]; 3]) -> bool {
    let ax = tri[1][0] - tri[0][0];
    let ay = tri[1][1] - tri[0][1];
    let az = tri[1][2] - tri[0][2];
    let bx = tri[2][0] - tri[0][0];
    let by = tri[2][1] - tri[0][1];
    let bz = tri[2][2] - tri[0][2];
    let cx = ay * bz - az * by;
    let cy = az * bx - ax * bz;
    let cz = ax * by - ay * bx;
    cx * cx + cy * cy + cz * cz < 1e-16
}

fn load_3mf(bytes: &[u8]) -> Result<Mesh, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("3MF zip: {e}"))?;
    let mut model_xml = None;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| format!("3MF entry: {e}"))?;
        let name = file.name().to_ascii_lowercase();
        if name.ends_with(".model") {
            let mut s = String::new();
            file.read_to_string(&mut s)
                .map_err(|e| format!("3MF read: {e}"))?;
            model_xml = Some(s);
            break;
        }
    }
    let xml = model_xml.ok_or("3MF archive has no 3D model part")?;
    parse_3mf_model(&xml)
}

#[derive(Clone, Default)]
struct ThreeMfObject {
    id: String,
    triangles: Vec<[[f64; 3]; 3]>,
    components: Vec<(String, [[f64; 3]; 4])>,
}

fn identity_transform() -> [[f64; 3]; 4] {
    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]]
}

fn parse_transform(raw: &str, scale: f64) -> Option<[[f64; 3]; 4]> {
    if raw.trim().is_empty() {
        return None;
    }
    let vals: Vec<f64> = raw
        .split_whitespace()
        .filter_map(|t| t.parse::<f64>().ok())
        .collect();
    if vals.len() != 12 {
        return None;
    }
    Some([
        [vals[0], vals[1], vals[2]],
        [vals[3], vals[4], vals[5]],
        [vals[6], vals[7], vals[8]],
        [vals[9] * scale, vals[10] * scale, vals[11] * scale],
    ])
}

fn mul_transform(parent: &[[f64; 3]; 4], child: &[[f64; 3]; 4]) -> [[f64; 3]; 4] {
    let mut out = [[0.0; 3]; 4];
    for r in 0..3 {
        for c in 0..3 {
            out[r][c] =
                child[r][0] * parent[0][c] + child[r][1] * parent[1][c] + child[r][2] * parent[2][c];
        }
    }
    for c in 0..3 {
        out[3][c] = child[3][0] * parent[0][c]
            + child[3][1] * parent[1][c]
            + child[3][2] * parent[2][c]
            + parent[3][c];
    }
    out
}

fn apply_transform(pt: [f64; 3], m: &[[f64; 3]; 4]) -> [f64; 3] {
    [
        pt[0] * m[0][0] + pt[1] * m[1][0] + pt[2] * m[2][0] + m[3][0],
        pt[0] * m[0][1] + pt[1] * m[1][1] + pt[2] * m[2][1] + m[3][1],
        pt[0] * m[0][2] + pt[1] * m[1][2] + pt[2] * m[2][2] + m[3][2],
    ]
}

fn det3(m: &[[f64; 3]; 4]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn emit_3mf_object(
    obj_id: &str,
    xf: &[[f64; 3]; 4],
    objects: &[ThreeMfObject],
    depth: usize,
    out: &mut Vec<[[f64; 3]; 3]>,
) {
    if depth > 16 {
        return;
    }
    let Some(obj) = objects.iter().find(|o| o.id == obj_id) else {
        return;
    };
    let is_identity = *xf == identity_transform();
    let flip = !is_identity && det3(xf) < 0.0;
    for tri in &obj.triangles {
        let mut t = if is_identity {
            *tri
        } else {
            [
                apply_transform(tri[0], xf),
                apply_transform(tri[1], xf),
                apply_transform(tri[2], xf),
            ]
        };
        if flip {
            t.swap(1, 2);
        }
        if !degenerate(&t) {
            out.push(t);
        }
    }
    for (comp_id, comp_xf) in &obj.components {
        let combined = mul_transform(xf, comp_xf);
        emit_3mf_object(comp_id, &combined, objects, depth + 1, out);
    }
}

fn parse_3mf_model(xml: &str) -> Result<Mesh, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut scale = 1.0;
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut objects: Vec<ThreeMfObject> = Vec::new();
    let mut current_obj: Option<ThreeMfObject> = None;
    let mut build_items: Vec<(String, [[f64; 3]; 4])> = Vec::new();

    let handle_tag = |e: &quick_xml::events::BytesStart<'_>,
                          is_start: bool,
                          scale: &mut f64,
                          vertices: &mut Vec<[f64; 3]>,
                          objects: &mut Vec<ThreeMfObject>,
                          current_obj: &mut Option<ThreeMfObject>,
                          build_items: &mut Vec<(String, [[f64; 3]; 4])>|
     -> Result<(), String> {
        let local = e.local_name();
        let name = local.as_ref();
        if name == b"model" {
            *scale = unit_scale(&attr_owned(e, b"unit"));
        } else if name == b"object" {
            if let Some(prev) = current_obj.take() {
                objects.push(prev);
            }
            vertices.clear();
            let id = attr_owned(e, b"id");
            let obj = ThreeMfObject {
                id,
                ..Default::default()
            };
            if is_start {
                *current_obj = Some(obj);
            } else {
                objects.push(obj);
            }
        } else if name == b"mesh" {
            vertices.clear();
        } else if name == b"vertex" {
            let x = parse_attr(e, b"x")?;
            let y = parse_attr(e, b"y")?;
            let z = parse_attr(e, b"z")?;
            vertices.push([x * *scale, y * *scale, z * *scale]);
        } else if name == b"triangle" {
            let i1 = parse_attr(e, b"v1")? as usize;
            let i2 = parse_attr(e, b"v2")? as usize;
            let i3 = parse_attr(e, b"v3")? as usize;
            if let (Some(a), Some(b), Some(c)) =
                (vertices.get(i1), vertices.get(i2), vertices.get(i3))
            {
                let tri = [*a, *b, *c];
                if !degenerate(&tri) {
                    if let Some(obj) = current_obj.as_mut() {
                        obj.triangles.push(tri);
                    } else {
                        let mut anon = ThreeMfObject::default();
                        anon.triangles.push(tri);
                        *current_obj = Some(anon);
                    }
                }
            }
        } else if name == b"component" {
            let comp_id = attr_owned(e, b"objectid");
            let xf = parse_transform(&attr_owned(e, b"transform"), *scale)
                .unwrap_or_else(identity_transform);
            if !comp_id.is_empty() {
                if let Some(obj) = current_obj.as_mut() {
                    obj.components.push((comp_id, xf));
                }
            }
        } else if name == b"item" {
            let obj_id = attr_owned(e, b"objectid");
            let xf = parse_transform(&attr_owned(e, b"transform"), *scale)
                .unwrap_or_else(identity_transform);
            if !obj_id.is_empty() {
                build_items.push((obj_id, xf));
            }
        }
        Ok(())
    };

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                handle_tag(
                    &e,
                    true,
                    &mut scale,
                    &mut vertices,
                    &mut objects,
                    &mut current_obj,
                    &mut build_items,
                )?;
            }
            Ok(Event::Empty(e)) => {
                handle_tag(
                    &e,
                    false,
                    &mut scale,
                    &mut vertices,
                    &mut objects,
                    &mut current_obj,
                    &mut build_items,
                )?;
            }
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == b"object" {
                    if let Some(obj) = current_obj.take() {
                        objects.push(obj);
                    }
                    vertices.clear();
                } else if e.local_name().as_ref() == b"mesh" {
                    vertices.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("3MF xml: {err}")),
            _ => {}
        }
        buf.clear();
    }
    if let Some(obj) = current_obj.take() {
        objects.push(obj);
    }

    let mut triangles = Vec::new();
    if !build_items.is_empty() {
        for (obj_id, xf) in &build_items {
            emit_3mf_object(obj_id, xf, &objects, 0, &mut triangles);
        }
    }
    if triangles.is_empty() {
        let id_xf = identity_transform();
        for obj in &objects {
            if !obj.id.is_empty() {
                emit_3mf_object(&obj.id, &id_xf, &objects, 0, &mut triangles);
            } else {
                triangles.extend(obj.triangles.iter().copied());
            }
        }
    }
    if triangles.is_empty() {
        return Err("3MF model contained no triangles".into());
    }
    Ok(Mesh { triangles })
}

fn attr_owned(e: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> String {
    e.attributes()
        .flatten()
        .find(|a| a.key.as_ref() == key)
        .and_then(|a| String::from_utf8(a.value.into_owned()).ok())
        .unwrap_or_default()
}

fn parse_attr(e: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Result<f64, String> {
    let raw = attr_owned(e, key);
    if raw.is_empty() {
        return Err(format!(
            "3MF element missing {}",
            String::from_utf8_lossy(key)
        ));
    }
    raw.parse::<f64>()
        .map_err(|_| format!("bad 3MF number '{raw}'"))
}

fn unit_scale(unit: &str) -> f64 {
    match unit.to_ascii_lowercase().as_str() {
        "micron" => 0.001,
        "millimeter" | "" => 1.0,
        "centimeter" => 10.0,
        "meter" => 1000.0,
        "inch" => 25.4,
        "foot" => 304.8,
        _ => 1.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ascii_stl(z: [f64; 3]) -> Vec<u8> {
        format!(
            "solid t\nfacet normal 0 0 1\nouter loop\nvertex 1.5 2 {}\nvertex 11.5 2 {}\nvertex 1.5 12 {}\nendloop\nendfacet\nendsolid t\n",
            z[0], z[1], z[2]
        )
        .into_bytes()
    }

    #[test]
    fn mesh_preview_reports_how_far_it_lowered_the_file() {
        let high = mesh_preview("high.stl", &ascii_stl([712.5, 713.0, 720.0])).unwrap();
        assert_eq!(high.seat_mm, 712.5);
        assert_eq!(high.min[2], 0.0);
        assert_eq!(&high.positions[..3], &[1.5, 2.0, 0.0]);
        let low = mesh_preview("low.stl", &ascii_stl([-3.0, -2.0, 5.0])).unwrap();
        assert_eq!(low.seat_mm, -3.0);
        assert_eq!(low.positions[8], 8.0);
        let seated = mesh_preview("bed.stl", &ascii_stl([0.0, 1.0, 2.0])).unwrap();
        assert_eq!(seated.seat_mm, 0.0);
        let json = serde_json::to_value(&high).unwrap();
        assert_eq!(json["seatMm"], 712.5);
    }

    #[test]
    fn parse_3mf_resets_vertices_per_object_and_applies_build_transforms() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="10" y="0" z="0" />
          <vertex x="0" y="10" z="0" />
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" />
        </triangles>
      </mesh>
    </object>
    <object id="2" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="5" />
          <vertex x="20" y="0" z="5" />
          <vertex x="0" y="20" z="5" />
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" />
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 50 0 0" />
  </build>
</model>"#;
        let mesh = parse_3mf_model(xml).expect("parse 3mf");
        assert_eq!(mesh.triangles.len(), 2);
        assert_eq!(mesh.triangles[0][1], [10.0, 0.0, 0.0]);
        assert_eq!(mesh.triangles[1][0], [50.0, 0.0, 5.0]);
        assert_eq!(mesh.triangles[1][1], [70.0, 0.0, 5.0]);
        assert_eq!(mesh.triangles[1][2], [50.0, 20.0, 5.0]);
    }

    #[test]
    fn parse_3mf_resolves_component_hierarchy() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="10" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="5" y="0" z="0" />
          <vertex x="0" y="5" z="0" />
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2" />
        </triangles>
      </mesh>
    </object>
    <object id="20" type="model">
      <components>
        <component objectid="10" transform="1 0 0 0 1 0 0 0 1 15 0 0" />
      </components>
    </object>
  </resources>
  <build>
    <item objectid="20" transform="1 0 0 0 1 0 0 0 1 0 25 0" />
  </build>
</model>"#;
        let mesh = parse_3mf_model(xml).expect("parse component 3mf");
        assert_eq!(mesh.triangles.len(), 1);
        assert_eq!(mesh.triangles[0][0], [15.0, 25.0, 0.0]);
        assert_eq!(mesh.triangles[0][1], [20.0, 25.0, 0.0]);
        assert_eq!(mesh.triangles[0][2], [15.0, 30.0, 0.0]);
    }
}
