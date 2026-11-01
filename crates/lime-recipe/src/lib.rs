//! The recipe side of Lime Slice's recipe protocol, version 1.
//!
//! A recipe is a program `recipe_run` builds with `lust build --sandbox` and
//! runs. The host (the MCP server) writes one start line on stdin; the recipe
//! writes one call per line on stdout and reads one reply per line; it ends
//! with a `done` line. Every call goes to the function the matching MCP tool
//! uses, so a recipe builds what the window builds.
//!
//! No dependencies, and nothing lust does not accept: this crate is built by
//! lust for the run and by rustc in CI, and must send the same bytes under both.

use std::fmt;
use std::io::{BufRead, Write};

/// A JSON value. Objects keep their keys in insertion order.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// An empty object, to fill with `set`.
    pub fn obj() -> Json {
        Json::Obj(Vec::new())
    }

    /// This object with `key` set to `value` (replacing an earlier value).
    pub fn set(self, key: &str, value: impl Into<Json>) -> Json {
        let mut fields = match self {
            Json::Obj(fields) => fields,
            _ => Vec::new(),
        };
        let value = value.into();
        match fields.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => fields.push((key.to_string(), value)),
        }
        Json::Obj(fields)
    }

    /// The value at `key` of an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The value at a dotted path: `"metrics.volumeMm3"`, `"faces.0.index"`.
    pub fn at(&self, path: &str) -> Option<&Json> {
        let mut node = self;
        for part in path.split('.') {
            node = match node {
                Json::Arr(items) => items.get(part.parse::<usize>().ok()?)?,
                _ => node.get(part)?,
            };
        }
        Some(node)
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Json>> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }

    /// Parses one JSON text.
    pub fn parse(text: &str) -> Result<Json, String> {
        let chars: Vec<char> = text.chars().collect();
        let mut at = 0usize;
        let value = parse_value(&chars, &mut at)?;
        skip_ws(&chars, &mut at);
        if at != chars.len() {
            return Err(format!("unexpected text at {at}"));
        }
        Ok(value)
    }
}

impl fmt::Display for Json {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Json::Null => f.write_str("null"),
            Json::Bool(b) => write!(f, "{b}"),
            // `{}` of an f64 is the shortest text that reads back the same
            // number, under rustc and lust alike. NaN and infinity are not JSON.
            Json::Num(n) => {
                if n.is_finite() {
                    write!(f, "{n}")
                } else {
                    f.write_str("null")
                }
            }
            Json::Str(s) => write_str(f, s),
            Json::Arr(items) => {
                f.write_str("[")?;
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        f.write_str(",")?;
                    }
                    write!(f, "{item}")?;
                }
                f.write_str("]")
            }
            Json::Obj(fields) => {
                f.write_str("{")?;
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        f.write_str(",")?;
                    }
                    write_str(f, k)?;
                    write!(f, ":{v}")?;
                }
                f.write_str("}")
            }
        }
    }
}

fn write_str(f: &mut fmt::Formatter<'_>, s: &str) -> fmt::Result {
    f.write_str("\"")?;
    for c in s.chars() {
        match c {
            '"' => f.write_str("\\\"")?,
            '\\' => f.write_str("\\\\")?,
            '\n' => f.write_str("\\n")?,
            '\r' => f.write_str("\\r")?,
            '\t' => f.write_str("\\t")?,
            c if (c as u32) < 0x20 => write!(f, "\\u{:04x}", c as u32)?,
            c => write!(f, "{c}")?,
        }
    }
    f.write_str("\"")
}

fn skip_ws(chars: &[char], at: &mut usize) {
    while *at < chars.len() && chars[*at].is_whitespace() {
        *at += 1;
    }
}

fn expect_word(chars: &[char], at: &mut usize, word: &str, value: Json) -> Result<Json, String> {
    for w in word.chars() {
        if chars.get(*at) != Some(&w) {
            return Err(format!("expected `{word}` at {at}"));
        }
        *at += 1;
    }
    Ok(value)
}

fn parse_value(chars: &[char], at: &mut usize) -> Result<Json, String> {
    skip_ws(chars, at);
    match chars.get(*at) {
        None => Err("unexpected end".to_string()),
        Some('n') => expect_word(chars, at, "null", Json::Null),
        Some('t') => expect_word(chars, at, "true", Json::Bool(true)),
        Some('f') => expect_word(chars, at, "false", Json::Bool(false)),
        Some('"') => parse_string(chars, at).map(Json::Str),
        Some('[') => {
            *at += 1;
            let mut items = Vec::new();
            skip_ws(chars, at);
            if chars.get(*at) == Some(&']') {
                *at += 1;
                return Ok(Json::Arr(items));
            }
            loop {
                items.push(parse_value(chars, at)?);
                skip_ws(chars, at);
                match chars.get(*at) {
                    Some(',') => *at += 1,
                    Some(']') => {
                        *at += 1;
                        return Ok(Json::Arr(items));
                    }
                    _ => return Err(format!("expected `,` or `]` at {at}")),
                }
            }
        }
        Some('{') => {
            *at += 1;
            let mut fields = Vec::new();
            skip_ws(chars, at);
            if chars.get(*at) == Some(&'}') {
                *at += 1;
                return Ok(Json::Obj(fields));
            }
            loop {
                skip_ws(chars, at);
                if chars.get(*at) != Some(&'"') {
                    return Err(format!("expected a key at {at}"));
                }
                let key = parse_string(chars, at)?;
                skip_ws(chars, at);
                if chars.get(*at) != Some(&':') {
                    return Err(format!("expected `:` at {at}"));
                }
                *at += 1;
                let value = parse_value(chars, at)?;
                fields.push((key, value));
                skip_ws(chars, at);
                match chars.get(*at) {
                    Some(',') => *at += 1,
                    Some('}') => {
                        *at += 1;
                        return Ok(Json::Obj(fields));
                    }
                    _ => return Err(format!("expected `,` or `}}` at {at}")),
                }
            }
        }
        Some(_) => {
            let start = *at;
            while *at < chars.len() && (chars[*at].is_ascii_digit() || "+-.eE".contains(chars[*at])) {
                *at += 1;
            }
            let text: String = chars[start..*at].iter().collect();
            text.parse::<f64>().map(Json::Num).map_err(|_| format!("bad number `{text}` at {start}"))
        }
    }
}

fn parse_string(chars: &[char], at: &mut usize) -> Result<String, String> {
    *at += 1;
    let mut out = String::new();
    while let Some(&c) = chars.get(*at) {
        *at += 1;
        match c {
            '"' => return Ok(out),
            '\\' => {
                let e = *chars.get(*at).ok_or("unterminated escape")?;
                *at += 1;
                match e {
                    'n' => out.push('\n'),
                    'r' => out.push('\r'),
                    't' => out.push('\t'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'u' => {
                        let hex: String = chars.get(*at..*at + 4).ok_or("short \\u escape")?.iter().collect();
                        *at += 4;
                        let code = u32::from_str_radix(&hex, 16).map_err(|_| format!("bad \\u escape `{hex}`"))?;
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                    }
                    other => out.push(other),
                }
            }
            c => out.push(c),
        }
    }
    Err("unterminated string".to_string())
}

impl From<f64> for Json {
    fn from(v: f64) -> Json {
        Json::Num(v)
    }
}
impl From<f32> for Json {
    fn from(v: f32) -> Json {
        Json::Num(v as f64)
    }
}
impl From<i32> for Json {
    fn from(v: i32) -> Json {
        Json::Num(v as f64)
    }
}
impl From<i64> for Json {
    fn from(v: i64) -> Json {
        Json::Num(v as f64)
    }
}
impl From<u32> for Json {
    fn from(v: u32) -> Json {
        Json::Num(v as f64)
    }
}
impl From<u64> for Json {
    fn from(v: u64) -> Json {
        Json::Num(v as f64)
    }
}
impl From<usize> for Json {
    fn from(v: usize) -> Json {
        Json::Num(v as f64)
    }
}
impl From<bool> for Json {
    fn from(v: bool) -> Json {
        Json::Bool(v)
    }
}
impl From<&str> for Json {
    fn from(v: &str) -> Json {
        Json::Str(v.to_string())
    }
}
impl From<String> for Json {
    fn from(v: String) -> Json {
        Json::Str(v)
    }
}
impl From<[f64; 2]> for Json {
    fn from(v: [f64; 2]) -> Json {
        Json::Arr(vec![Json::Num(v[0]), Json::Num(v[1])])
    }
}
impl From<[f64; 3]> for Json {
    fn from(v: [f64; 3]) -> Json {
        Json::Arr(vec![Json::Num(v[0]), Json::Num(v[1]), Json::Num(v[2])])
    }
}
impl From<Vec<Json>> for Json {
    fn from(v: Vec<Json>) -> Json {
        Json::Arr(v)
    }
}

/// A call the host refused: the engine's sentence. `line` is where the
/// recipe made the call.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub reason: String,
    pub line: u32,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.reason)
    }
}

/// A solid the host holds, by its object handle.
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    pub object: String,
}

/// One recipe run: the start line's parameters and context, and the call counter.
pub struct Session {
    params: Json,
    context: Json,
    next_id: u64,
}

fn read_line() -> String {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap_or(0);
    line.trim_end().to_string()
}

impl Session {
    /// Reads the start line: `{"v":1,"params":{...},"context":{...}}`.
    pub fn start() -> Session {
        let start = Json::parse(&read_line()).unwrap_or(Json::Null);
        Session::from_start(&start)
    }

    /// A session from a start message already read (tests, other transports).
    pub fn from_start(start: &Json) -> Session {
        Session {
            params: start.get("params").cloned().unwrap_or(Json::obj()),
            context: start.get("context").cloned().unwrap_or(Json::obj()),
            next_id: 1,
        }
    }

    /// A number parameter, or `default` when the host did not send it.
    pub fn param_f64(&self, name: &str, default: f64) -> f64 {
        self.params.get(name).and_then(Json::as_f64).unwrap_or(default)
    }

    /// A count parameter (a number the host sent, rounded down), or `default`.
    pub fn param_u32(&self, name: &str, default: u32) -> u32 {
        self.params.get(name).and_then(Json::as_f64).map_or(default, |n| n.max(0.0) as u32)
    }

    pub fn param_bool(&self, name: &str, default: bool) -> bool {
        self.params.get(name).and_then(Json::as_bool).unwrap_or(default)
    }

    pub fn param_str(&self, name: &str, default: &str) -> String {
        self.params.get(name).and_then(Json::as_str).unwrap_or(default).to_string()
    }

    /// The context the host sent: printer, material, units, a starting object.
    pub fn context(&self) -> &Json {
        &self.context
    }

    /// The object the run starts from, when the host named one.
    pub fn object(&self) -> Option<Part> {
        self.context.get("object").and_then(Json::as_str).map(|o| Part { object: o.to_string() })
    }

    /// One call: `tool` is an MCP tool name from the host's allowlist, `args`
    /// as that tool takes them. The answer is the tool's result, or the
    /// host's refusal with the line that made the call.
    #[track_caller]
    pub fn call(&mut self, tool: &str, args: Json) -> Result<Json, Refusal> {
        let at = std::panic::Location::caller();
        let id = self.next_id;
        self.next_id += 1;
        let msg = Json::obj()
            .set("id", id)
            .set("call", tool)
            .set("args", args)
            .set("at", Json::obj().set("line", at.line()).set("col", at.column()));
        let mut out = std::io::stdout().lock();
        writeln!(out, "{msg}").unwrap();
        out.flush().unwrap();
        drop(out);
        let reply = Json::parse(&read_line()).unwrap_or(Json::Null);
        if reply.get("ok").and_then(Json::as_bool) == Some(true) {
            Ok(reply.get("result").cloned().unwrap_or(Json::Null))
        } else {
            let reason = reply.get("error").and_then(Json::as_str).unwrap_or("the host gave no answer").to_string();
            Err(Refusal { reason, line: at.line() })
        }
    }

    /// `solid_new`: a new solid on the plate (`ops::cuboid`, `ops::cylinder`, or any primitive as JSON).
    #[track_caller]
    pub fn solid_new(&mut self, primitive: Json) -> Result<Part, Refusal> {
        let line = std::panic::Location::caller().line();
        let made = self.call("solid_new", primitive)?;
        match made.get("object").and_then(Json::as_str) {
            Some(o) => Ok(Part { object: o.to_string() }),
            None => Err(Refusal { reason: "solid_new returned no object".to_string(), line }),
        }
    }

    /// `model_apply` with `probe: true`: the edit is checked first and lands only if it fits.
    #[track_caller]
    pub fn apply(&mut self, part: &Part, op: Json) -> Result<Json, Refusal> {
        self.call("model_apply", Json::obj().set("object", part.object.as_str()).set("op", op).set("probe", true))
    }

    /// `model_probe`: the edit on a copy. `metrics` holds the volume and bounds before and after.
    #[track_caller]
    pub fn probe(&mut self, part: &Part, op: Json) -> Result<Json, Refusal> {
        self.call("model_probe", Json::obj().set("object", part.object.as_str()).set("op", op))
    }

    /// The solid's volume in mm³, from a probe of an edit that changes nothing.
    #[track_caller]
    pub fn volume(&mut self, part: &Part) -> Result<f64, Refusal> {
        let line = std::panic::Location::caller().line();
        let r = self.call("model_describe", Json::obj().set("object", part.object.as_str()))?;
        r.at("volumeMm3").and_then(Json::as_f64).ok_or(Refusal { reason: "model_describe gave no volume".to_string(), line })
    }

    /// `model_check`: overhangs, thin walls, floating pieces, bed contact.
    #[track_caller]
    pub fn check(&mut self, part: &Part) -> Result<Json, Refusal> {
        self.call("model_check", Json::obj().set("object", part.object.as_str()))
    }

    /// A note the host shows with the result.
    #[track_caller]
    pub fn log(&mut self, text: &str) {
        let _ = self.call("log", Json::obj().set("text", text));
    }

    /// Ends the run: the host commits the part to the plate.
    pub fn done(self, part: &Part) {
        self.done_with(part, Json::obj())
    }

    /// Ends the run with numbers for the caller (a search ranks by them).
    pub fn done_with(self, part: &Part, metrics: Json) {
        let msg = Json::obj().set("done", Json::obj().set("object", part.object.as_str()).set("metrics", metrics));
        let mut out = std::io::stdout().lock();
        writeln!(out, "{msg}").unwrap();
        out.flush().unwrap();
    }
}

/// Builders for common primitives and ops. Anything else is a `Json` object
/// as the MCP tool takes it.
pub mod ops {
    use super::Json;

    /// A box `dx` × `dy` × `dz`, centred on X and Y, standing on Z = 0.
    pub fn cuboid(dx: f64, dy: f64, dz: f64) -> Json {
        Json::obj().set("primitive", "box").set("dx", dx).set("dy", dy).set("dz", dz)
    }

    /// A cylinder standing on Z = 0.
    pub fn cylinder(radius: f64, height: f64) -> Json {
        Json::obj().set("primitive", "cylinder").set("radius", radius).set("height", height)
    }

    /// A through hole of `diameter` mm from `origin` along `axis` (part frame).
    pub fn hole_through(origin: [f64; 3], axis: [f64; 3], diameter: f64) -> Json {
        Json::obj().set("kind", "hole").set("origin", origin).set("axis", axis).set("diameterMm", diameter).set("through", true)
    }

    /// A blind hole `depth` mm deep.
    pub fn hole(origin: [f64; 3], axis: [f64; 3], diameter: f64, depth: f64) -> Json {
        Json::obj().set("kind", "hole").set("origin", origin).set("axis", axis).set("diameterMm", diameter).set("depth", depth)
    }

    /// A boolean with a primitive placed at `origin`: `op` is "fuse", "cut" or "common".
    pub fn boolean(op: &str, primitive: Json, origin: [f64; 3]) -> Json {
        let mut fields = match primitive {
            Json::Obj(fields) => fields,
            _ => Vec::new(),
        };
        fields.retain(|(k, _)| k != "origin");
        Json::Obj(fields).set("kind", "boolean").set("op", op).set("origin", origin)
    }

    /// A fillet of `size` mm on the edges `edges` (as the MCP tool spells an edge list).
    pub fn fillet(edges: Json, size: f64) -> Json {
        Json::obj().set("kind", "fillet").set("edges", edges).set("size", size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_reads_back() {
        let v = Json::obj()
            .set("a", 1.5)
            .set("b", "q\"x\n")
            .set("c", vec![Json::Null, Json::from(true), Json::from(3u32)])
            .set("d", [0.1, 2.0, -3.25]);
        let text = v.to_string();
        assert_eq!(text, r#"{"a":1.5,"b":"q\"x\n","c":[null,true,3],"d":[0.1,2,-3.25]}"#);
        assert_eq!(Json::parse(&text).unwrap(), v);
    }

    #[test]
    fn paths_and_escapes() {
        let v = Json::parse(r#" {"m": {"volumeMm3": 4800}, "faces": [{"index": 3}], "s": "é\t"} "#).unwrap();
        assert_eq!(v.at("m.volumeMm3").and_then(Json::as_f64), Some(4800.0));
        assert_eq!(v.at("faces.0.index").and_then(Json::as_f64), Some(3.0));
        assert_eq!(v.get("s").and_then(Json::as_str), Some("é\t"));
        assert!(Json::parse("{").is_err());
    }

    #[test]
    fn ops_shapes() {
        assert_eq!(ops::cuboid(10.0, 20.0, 4.0).to_string(), r#"{"primitive":"box","dx":10,"dy":20,"dz":4}"#);
        assert_eq!(
            ops::boolean("cut", ops::cylinder(2.0, 5.0), [1.0, 0.0, 0.0]).to_string(),
            r#"{"primitive":"cylinder","radius":2,"height":5,"kind":"boolean","op":"cut","origin":[1,0,0]}"#
        );
    }
}
