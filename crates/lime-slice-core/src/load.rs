use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use crate::mesh::Mesh;

pub fn load_mesh(filename: &str, bytes: &[u8]) -> Result<Mesh, String> {
    let lower = filename.to_ascii_lowercase();
    let mut mesh = if lower.ends_with(".3mf") || looks_like_zip(bytes) && !lower.ends_with(".stl") {
        load_3mf(bytes)?
    } else if lower.ends_with(".stl") || looks_like_stl(bytes) {
        load_stl(bytes)?
    } else if looks_like_zip(bytes) {
        load_3mf(bytes)?
    } else {
        return Err("unsupported mesh: use STL or 3MF".into());
    };
    if mesh.triangles.is_empty() {
        return Err("mesh contains no triangles".into());
    }
    mesh.settle_on_bed();
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

fn parse_3mf_model(xml: &str) -> Result<Mesh, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut scale = 1.0;
    let mut vertices: Vec<[f64; 3]> = Vec::new();
    let mut triangles = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                if e.name().as_ref() == b"model" {
                    scale = unit_scale(&attr_owned(&e, b"unit"));
                }
            }
            Ok(Event::Empty(e)) => {
                let name = e.name().as_ref().to_vec();
                if name == b"model" {
                    scale = unit_scale(&attr_owned(&e, b"unit"));
                } else if name == b"vertex" {
                    let x = parse_attr(&e, b"x")?;
                    let y = parse_attr(&e, b"y")?;
                    let z = parse_attr(&e, b"z")?;
                    vertices.push([x * scale, y * scale, z * scale]);
                } else if name == b"triangle" {
                    let i1 = parse_attr(&e, b"v1")? as usize;
                    let i2 = parse_attr(&e, b"v2")? as usize;
                    let i3 = parse_attr(&e, b"v3")? as usize;
                    if let (Some(a), Some(b), Some(c)) =
                        (vertices.get(i1), vertices.get(i2), vertices.get(i3))
                    {
                        let tri = [*a, *b, *c];
                        if !degenerate(&tri) {
                            triangles.push(tri);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("3MF xml: {err}")),
            _ => {}
        }
        buf.clear();
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
