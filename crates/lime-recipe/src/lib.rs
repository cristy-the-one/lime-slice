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
use std::sync::atomic::{AtomicBool, Ordering};

static NATIVE_GEOMETRY: AtomicBool = AtomicBool::new(false);

// Geometry can be used without a Session. Only a host which advertises the protocol enables this path.
fn native_geometry(args: Json) -> Option<Json> {
    if !NATIVE_GEOMETRY.load(Ordering::Relaxed) { return None; }
    // The host limits protocol lines to 1 MiB; large inputs stay in the local implementation.
    if args.to_string().len() > 512 * 1024 { return None; }
    let msg = Json::obj().set("id", 0u32).set("call", "native_geometry").set("args", args);
    tell(msg);
    let reply = Json::parse(&read_line()).ok()?;
    if reply.get("ok").and_then(Json::as_bool) == Some(true) { reply.get("result").cloned() } else { None }
}


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

    /// An array of anything that converts: `Json::arr(vec![1.0, 2.0])`, `Json::arr(points)`.
    pub fn arr<T: Into<Json>>(items: Vec<T>) -> Json {
        Json::Arr(items.into_iter().map(|v| v.into()).collect())
    }

    /// This array with `value` added at the end (an empty array when it was not one).
    pub fn push(self, value: impl Into<Json>) -> Json {
        let mut items = match self {
            Json::Arr(items) => items,
            _ => Vec::new(),
        };
        items.push(value.into());
        Json::Arr(items)
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

    /// An array of numbers, or of one-number rows (a one-column CSV), as `f64`s.
    pub fn as_f64s(&self) -> Option<Vec<f64>> {
        let mut out = Vec::new();
        for item in self.as_array()?.iter() {
            let v = match item {
                Json::Num(n) => *n,
                Json::Arr(row) if row.len() == 1 => row[0].as_f64()?,
                _ => return None,
            };
            out.push(v);
        }
        Some(out)
    }

    /// An array of `[x, y]` rows (more columns are ignored), or of `{x, y}` objects, as points.
    pub fn as_points2(&self) -> Option<Vec<[f64; 2]>> {
        let mut out = Vec::new();
        for item in self.as_array()?.iter() {
            let p = match item {
                Json::Arr(row) if row.len() >= 2 => [row[0].as_f64()?, row[1].as_f64()?],
                Json::Obj(_) => [item.get("x")?.as_f64()?, item.get("y")?.as_f64()?],
                _ => return None,
            };
            out.push(p);
        }
        Some(out)
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
impl From<Vec<f64>> for Json {
    fn from(v: Vec<f64>) -> Json {
        Json::Arr(v.into_iter().map(Json::Num).collect())
    }
}
/// An outline: `vec![[x, y], ...]` goes straight into an op's `points`.
impl From<Vec<[f64; 2]>> for Json {
    fn from(v: Vec<[f64; 2]>) -> Json {
        Json::Arr(v.into_iter().map(Json::from).collect())
    }
}
impl From<Vec<[f64; 3]>> for Json {
    fn from(v: Vec<[f64; 3]>) -> Json {
        Json::Arr(v.into_iter().map(Json::from).collect())
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

/// This crate's recipe API level, `(major, minor)` (docs/plan-recipe-plugins.md D12). A plugin records it when it
/// is saved. A minor level only adds; a plugin of a higher level than the host's crate is not built.
/// 1.0: the calls, `param_*`, `geom2d`, `lattice`, and the `section` and `apply_many` wrappers. 1.1: typed
/// parameters (`number`, `count`, `toggle`, `choice`, `text`) and describe mode. 1.2: `face` and `outline` parameters
/// a person picks (`pick_face`, `pick_outline`), `refuse`, and `bounds`. 1.3: `face(..).curved()` parameters and what a
/// picked face is (`kind`, `axis`, `radius`), `lettering` (text on a face, flat or curved) and `text_outline` (the letters
/// as a `Section`). 1.4: a picked sphere's `centre` and a round face's `axis_point`; reads answer in the frame `apply`
/// takes (model space for a moved or turned part), as they always should have. 1.5: progress and host context.
/// 1.6: batched Region unions and differences. 1.7: resumable checkpoints. 1.8: pose animations.
/// 1.9: `Animation::background`. 1.10: `Session::mesh_at_end`. 1.11: the explicit queue (`apply_later`, `flush`, `apply_now`, `queue`).
/// 1.12: `gears` (the library's involute gears, and true involute `Gear` outlines) and `ops::gear`, the kernel's gear step.
/// 1.13: `mech` (pendulum periods and lengths, docs/plan-mass-properties.md).
/// 1.14: `horology`, clock ingredients (going trains, the Graham escapement, ratchet and click, BS 978-2 cycloidal teeth, bores).
/// 1.15: reads of an animation's rig at a pose (`Rig::first_contact`, `first_contact_with`, `clearance`, `crossing`,
/// `angle`) and `anim::frame_times` (docs/plan-contact-poses.md).
/// 1.16: recipes that use plugins (docs/plan-plugin-recipes.md): `run_plugin` runs a kept plugin as a nested run and
/// hands back the parts it made (`PluginRun`); `attach`, `hinge`, `slide`, `hold`, `joint`, `turn_joint` and
/// `couple_gears` build an assembly of the parts the run made, where the host can assemble (`context.limits.canAssemble`).
/// 1.17: an animation's frames fall at whole multiples of `1/fps`, from 0 to the first at or after the end, and
/// `anim::frame_times` gives those times (docs/plan-pose-animation.md).
pub const API: (u32, u32) = (1, 17);

/// What a nested plugin run made (API 1.16): the plugin and the version that ran, the part it ended on (`done`), every
/// part it made and left on the plate, in the order made, and the numbers it ended with. The parts are this run's from
/// now on: place them, change them, or end on one of them.
#[derive(Clone, Debug, PartialEq)]
pub struct PluginRun {
    pub plugin: String,
    pub version: u32,
    pub part: Part,
    pub parts: Vec<Part>,
    pub metrics: Json,
}

impl PluginRun {
    fn from_json(r: &Json) -> Option<PluginRun> {
        let part = Part { object: r.get("object").and_then(Json::as_str)?.to_string() };
        let mut parts = Vec::new();
        if let Some(rows) = r.get("objects").and_then(Json::as_array) {
            for row in rows.iter() {
                if let Some(o) = row.as_str() {
                    parts.push(Part { object: o.to_string() });
                }
            }
        }
        if parts.is_empty() {
            parts.push(part.clone());
        }
        Some(PluginRun {
            plugin: r.at("plugin.id").and_then(Json::as_str).unwrap_or("").to_string(),
            version: r.at("plugin.version").and_then(Json::as_f64).unwrap_or(0.0) as u32,
            part,
            parts,
            metrics: r.get("metrics").cloned().unwrap_or(Json::obj()),
        })
    }
}

/// One recipe run: the start line's parameters and context, and the call counter.
pub struct Session {
    params: Json,
    context: Json,
    next_id: u64,
    /// Describe mode: the host asked only for the parameters (D4). No call reaches the engine.
    describe: bool,
}

fn read_line() -> String {
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line).unwrap_or(0);
    line.trim_end().to_string()
}

/// A line to the host that is not a call: it takes no reply.
fn tell(msg: Json) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{msg}").unwrap();
    out.flush().unwrap();
}

/// A declared parameter: what the host's form and `plugin list` show.
#[derive(Clone, Debug, PartialEq)]
pub struct ParamSpec {
    pub name: String,
    pub kind: String,
    pub default: Json,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub step: Option<f64>,
    pub unit: Option<String>,
    pub label: Option<String>,
    pub help: Option<String>,
    pub options: Vec<String>,
    pub max_len: Option<u32>,
    /// A face parameter that takes a curved face too (API 1.3).
    pub curved: bool,
}

impl ParamSpec {
    fn new(name: &str, kind: &str, default: Json) -> ParamSpec {
        ParamSpec { name: name.to_string(), kind: kind.to_string(), default, min: None, max: None, step: None, unit: None, label: None, help: None, options: Vec::new(), max_len: None, curved: false }
    }

    /// The JSON the host keeps in a plugin's header: only the settings that were given.
    pub fn to_json(&self) -> Json {
        let mut j = Json::obj().set("name", self.name.as_str()).set("kind", self.kind.as_str()).set("default", self.default.clone());
        if let Some(v) = self.min {
            j = j.set("min", v);
        }
        if let Some(v) = self.max {
            j = j.set("max", v);
        }
        if let Some(v) = self.step {
            j = j.set("step", v);
        }
        if let Some(v) = &self.unit {
            j = j.set("unit", v.as_str());
        }
        if let Some(v) = &self.label {
            j = j.set("label", v.as_str());
        }
        if let Some(v) = &self.help {
            j = j.set("help", v.as_str());
        }
        if !self.options.is_empty() {
            j = j.set("options", Json::Arr(self.options.iter().map(|o| Json::from(o.as_str())).collect()));
        }
        if let Some(v) = self.max_len {
            j = j.set("maxLen", v);
        }
        if self.curved {
            j = j.set("curved", true);
        }
        j
    }
}

/// A parameter builder's view of the run, taken when the builder is made.
struct Reader {
    given: Option<Json>,
    describe: bool,
    late: bool,
}

impl Reader {
    /// Tells the host about a parameter as it is read, and gives the value the host sent for it. In describe mode
    /// that is the declaration and nothing is sent back; after the first call it is a late declaration, which the
    /// host notes, since a form drawn before the run could not show it.
    fn declare(&self, spec: &ParamSpec, line: u32) -> Option<Json> {
        if self.describe {
            tell(Json::obj().set("describe", Json::obj().set("param", spec.to_json()).set("line", line)));
            return None;
        }
        if self.late {
            tell(Json::obj().set("late_param", Json::obj().set("name", spec.name.as_str()).set("line", line)));
        }
        self.given.clone()
    }

    /// A line for the run's notes that is not a call.
    fn note(&self, text: &str) {
        if !self.describe {
            tell(Json::obj().set("note", text));
        }
    }

    fn note_held(&self, name: &str, given: f64, held: f64) {
        let side = if given < held { "below its minimum" } else { "above its maximum" };
        self.note(&format!("{name} {given} is {side}; the run used {held}."));
    }
}

/// `s.number(name, default)`: a length, angle or ratio. Then `range`, `step`, `unit`, `label`, `help`, and `get()`.
pub struct Number {
    r: Reader,
    spec: ParamSpec,
}

/// `s.count(name, default)`: a whole number. Then `range`, `label`, `help`, and `get()`.
pub struct Count {
    r: Reader,
    spec: ParamSpec,
}

/// `s.toggle(name, default)`: on or off. Then `label`, `help`, and `get()`.
pub struct Toggle {
    r: Reader,
    spec: ParamSpec,
}

/// `s.choice(name, options, default)`: one of a few words. Then `label`, `help`, and `get()`.
pub struct Choice {
    r: Reader,
    spec: ParamSpec,
}

/// `s.text(name, default)`: a line of text (embossed lettering, say). Then `max_len`, `label`, `help`, and `get()`.
pub struct Text {
    r: Reader,
    spec: ParamSpec,
}

impl Number {
    pub fn range(mut self, min: f64, max: f64) -> Number {
        self.spec.min = Some(min);
        self.spec.max = Some(max);
        self
    }
    pub fn step(mut self, step: f64) -> Number {
        self.spec.step = Some(step);
        self
    }
    /// `mm`, `deg`, `%`, or none.
    pub fn unit(mut self, unit: &str) -> Number {
        self.spec.unit = Some(unit.to_string());
        self
    }
    pub fn label(mut self, label: &str) -> Number {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> Number {
        self.spec.help = Some(help.to_string());
        self
    }
    /// The value the host passed, held inside the range, or the default.
    #[track_caller]
    pub fn get(self) -> f64 {
        let line = std::panic::Location::caller().line();
        let default = self.spec.default.as_f64().unwrap_or(0.0);
        let given = self.r.declare(&self.spec, line).and_then(|j| j.as_f64());
        let v = given.unwrap_or(default);
        let held = hold(v, self.spec.min, self.spec.max);
        if held != v {
            self.r.note_held(&self.spec.name, v, held);
        }
        held
    }
}

impl Count {
    pub fn range(mut self, min: u32, max: u32) -> Count {
        self.spec.min = Some(min as f64);
        self.spec.max = Some(max as f64);
        self
    }
    pub fn label(mut self, label: &str) -> Count {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> Count {
        self.spec.help = Some(help.to_string());
        self
    }
    /// The value the host passed (rounded down), held inside the range, or the default.
    #[track_caller]
    pub fn get(self) -> u32 {
        let line = std::panic::Location::caller().line();
        let default = self.spec.default.as_f64().unwrap_or(0.0);
        let v = self.r.declare(&self.spec, line).and_then(|j| j.as_f64()).map_or(default, |n| n.floor());
        let held = hold(v.max(0.0), self.spec.min, self.spec.max);
        if held != v {
            self.r.note_held(&self.spec.name, v, held);
        }
        held as u32
    }
}

impl Toggle {
    pub fn label(mut self, label: &str) -> Toggle {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> Toggle {
        self.spec.help = Some(help.to_string());
        self
    }
    #[track_caller]
    pub fn get(self) -> bool {
        let line = std::panic::Location::caller().line();
        let default = self.spec.default.as_bool().unwrap_or(false);
        self.r.declare(&self.spec, line).and_then(|j| j.as_bool()).unwrap_or(default)
    }
}

impl Choice {
    pub fn label(mut self, label: &str) -> Choice {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> Choice {
        self.spec.help = Some(help.to_string());
        self
    }
    /// The option the host passed, or the default when it passed none or one not in the list.
    #[track_caller]
    pub fn get(self) -> String {
        let line = std::panic::Location::caller().line();
        let default = self.spec.default.as_str().unwrap_or("").to_string();
        match self.r.declare(&self.spec, line).and_then(|j| j.as_str().map(|t| t.to_string())) {
            Some(v) if self.spec.options.contains(&v) => v,
            Some(v) => {
                self.r.note(&format!("{} has no option {}; the run used {}.", self.spec.name, v, default));
                default
            }
            None => default,
        }
    }
}

impl Text {
    pub fn max_len(mut self, n: u32) -> Text {
        self.spec.max_len = Some(n);
        self
    }
    pub fn label(mut self, label: &str) -> Text {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> Text {
        self.spec.help = Some(help.to_string());
        self
    }
    /// The text the host passed, cut to `max_len` characters, or the default.
    #[track_caller]
    pub fn get(self) -> String {
        let line = std::panic::Location::caller().line();
        let default = self.spec.default.as_str().unwrap_or("").to_string();
        let v = self.r.declare(&self.spec, line).and_then(|j| j.as_str().map(|t| t.to_string())).unwrap_or(default);
        match self.spec.max_len {
            Some(n) if v.chars().count() > n as usize => {
                self.r.note(&format!("{} is longer than {} characters; the run used the first {}.", self.spec.name, n, n));
                v.chars().take(n as usize).collect()
            }
            _ => v,
        }
    }
}

/// `s.face(name)`: a flat face of the part, picked by the person (API 1.2). Then `rule` or `facing`, `label`, `help`,
/// and `get()`; `s.pick_face(&part, &value)` resolves it on the part as it stands.
pub struct FaceBuilder {
    r: Reader,
    spec: ParamSpec,
}

/// `s.outline(name)`: a closed region the person supplies: a sketch, a face's outline, or loops (API 1.2). Then a
/// default (`default_poly`, `default_loops`, `default_face`), `label`, `help`, and `get()`; `s.pick_outline(&value)`
/// delivers it as a `Section`.
pub struct OutlineBuilder {
    r: Reader,
    spec: ParamSpec,
}

/// A face or outline parameter's value as the run was given it (or its default): what the host resolves at a pick.
#[derive(Clone, Debug, PartialEq)]
pub struct PickParam {
    pub name: String,
    pub kind: String,
    pub value: Json,
    /// A face parameter declared `.curved()` (API 1.3).
    pub curved: bool,
}

/// A face the host resolved: its index on the part now, its outward normal, a point on it, its area, and its outline in
/// its own frame (`outline.frame`, `outline.region`, `outline.loops`), as `face_outline` gives it.
///
/// API 1.3: `kind` is `plane`, `cylinder`, `cone`, `sphere` or `other` (a torus or a freeform face; the part's face list does
/// not tell those apart), and for a cylinder or a cone `axis` and `radius`. A curved face has no one normal (`normal` is
/// zero) and no outline (`outline` is empty); `point` is a point on it, which `lettering` anchors the text at.
///
/// API 1.4: a sphere's `centre`, and a cylinder's or a cone's `axis_point` (a point on its axis; a sphere's is its centre).
/// Every point and direction here, like every read (`bounds`, `faces_find`, `surface_at`), is in the frame `apply` takes
/// its numbers in: model space, where a part `model_place` moved or turned stands. Measure, then cut at that point.
#[derive(Clone, Debug, PartialEq)]
pub struct PickedFace {
    pub index: u32,
    pub normal: [f64; 3],
    pub point: [f64; 3],
    pub area: f64,
    pub outline: Section,
    pub kind: String,
    pub axis: Option<[f64; 3]>,
    pub radius: Option<f64>,
    /// A sphere's centre (API 1.4).
    pub centre: Option<[f64; 3]>,
    /// A point on a cylinder's or a cone's axis, or a sphere's centre (API 1.4).
    pub axis_point: Option<[f64; 3]>,
}

/// The rules a face parameter may fall back on when the person picked none.
pub const FACE_RULES: [&str; 5] = ["largest", "largest_up", "largest_down", "top", "bottom"];

impl FaceBuilder {
    /// The face taken when the person picked none: `largest`, `largest_up`, `largest_down`, `top` or `bottom`.
    pub fn rule(mut self, rule: &str) -> FaceBuilder {
        let facing = self.spec.default.get("facing").cloned();
        let mut d = Json::obj().set("rule", rule);
        if let Some(f) = facing {
            d = d.set("facing", f);
        }
        self.spec.default = d;
        self
    }
    /// With `largest`: the largest flat face facing `dir` (within 5°). `rule("largest").facing([0,0,1])` is `largest_up`.
    pub fn facing(mut self, dir: [f64; 3]) -> FaceBuilder {
        let rule = self.spec.default.get("rule").and_then(Json::as_str).unwrap_or("largest").to_string();
        self.spec.default = Json::obj().set("rule", rule.as_str()).set("facing", dir);
        self
    }
    pub fn label(mut self, label: &str) -> FaceBuilder {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> FaceBuilder {
        self.spec.help = Some(help.to_string());
        self
    }
    /// The parameter takes a curved face too (API 1.3): a cylinder, a cone, a sphere, a torus or a freeform face. `pick_face`
    /// then says which (`kind`) and, for a cylinder or a cone, its `axis` and `radius`. Without it only a flat face is taken.
    pub fn curved(mut self) -> FaceBuilder {
        self.spec.curved = true;
        self
    }
    /// The face the host was given (an index, or `{normal, nearPoint}`), else the default rule. Nothing is resolved
    /// yet: `s.pick_face` does that.
    #[track_caller]
    pub fn get(self) -> PickParam {
        let line = std::panic::Location::caller().line();
        let given = self.r.declare(&self.spec, line);
        let value = match given {
            Some(Json::Null) | None => self.spec.default.clone(),
            Some(v) => v,
        };
        PickParam { name: self.spec.name.clone(), kind: "face".to_string(), value, curved: self.spec.curved }
    }
}

impl OutlineBuilder {
    /// A default outline: this polygon, drawn on the part's workplane (or the bed for a new part).
    pub fn default_poly(mut self, poly: &geom2d::Poly) -> OutlineBuilder {
        self.spec.default = Json::obj().set("loops", Json::Arr(vec![poly.to_loop()]));
        self
    }
    /// A default outline: `extrude` loops (`Profile::to_loops()`, `Poly::to_loop()`), an outline then its holes.
    pub fn default_loops(mut self, loops: Vec<Json>) -> OutlineBuilder {
        self.spec.default = Json::obj().set("loops", Json::Arr(loops));
        self
    }
    /// A default outline: the outline of the part's face the rule names (`largest_up`, say).
    pub fn default_face(mut self, rule: &str) -> OutlineBuilder {
        self.spec.default = Json::obj().set("face", Json::obj().set("rule", rule));
        self
    }
    pub fn label(mut self, label: &str) -> OutlineBuilder {
        self.spec.label = Some(label.to_string());
        self
    }
    pub fn help(mut self, help: &str) -> OutlineBuilder {
        self.spec.help = Some(help.to_string());
        self
    }
    /// The outline the host was given (`{sketch}`, `{face}` or `{loops}`), else the default.
    #[track_caller]
    pub fn get(self) -> PickParam {
        let line = std::panic::Location::caller().line();
        let given = self.r.declare(&self.spec, line);
        let value = match given {
            Some(Json::Null) | None => self.spec.default.clone(),
            Some(v) => v,
        };
        PickParam { name: self.spec.name.clone(), kind: "outline".to_string(), value, curved: false }
    }
}

/// Text on a face (API 1.3), the `text` op as a typed call: `s.lettering(&part, &face, "LOT 42", &Lettering::new(6.0, 0.8).font("mono").around())`.
/// `height` is the capitals' and `depth` how far the letters stand off the surface (raised) or go into it (`.engrave()`), square to
/// it, both in mm. `font` is a bundled id (`sans`, `mono`, `serif`, `stencil`, `stroke`, `line`) or a font already in the project;
/// no font is the single-stroke grid font on a flat face. On a cylinder or a cone `.around()` (the default) reads round the part and
/// `.axis()` up it; on a sphere, a torus or a freeform face `.u()` or `.v()` is the face's direction the baseline starts in, and
/// `.project()` pushes the letters on along the face's normal instead of wrapping them at true size.
#[derive(Clone, Debug, PartialEq)]
pub struct Lettering {
    height: f64,
    depth: f64,
    font: Option<String>,
    style: Option<String>,
    weight: Option<f64>,
    spacing: Option<f64>,
    line_spacing: Option<f64>,
    align: Option<String>,
    angle: Option<f64>,
    along: Option<String>,
    wrap: Option<String>,
    flip: bool,
    cut: bool,
    stroke_width: Option<f64>,
}

impl Lettering {
    /// Capitals `height` mm tall, standing `depth` mm off the surface.
    pub fn new(height: f64, depth: f64) -> Lettering {
        Lettering { height, depth, font: None, style: None, weight: None, spacing: None, line_spacing: None, align: None, angle: None, along: None, wrap: None, flip: false, cut: false, stroke_width: None }
    }
    pub fn font(mut self, font: &str) -> Lettering {
        self.font = Some(font.to_string());
        self
    }
    /// `regular`, `bold`, `italic` or `bold-italic`.
    pub fn style(mut self, style: &str) -> Lettering {
        self.style = Some(style.to_string());
        self
    }
    /// A variable font's weight, 100 to 900.
    pub fn weight(mut self, weight: f64) -> Lettering {
        self.weight = Some(weight);
        self
    }
    /// Added after every letter, mm.
    pub fn spacing(mut self, mm: f64) -> Lettering {
        self.spacing = Some(mm);
        self
    }
    /// Capital heights between lines (1.3 by default).
    pub fn line_spacing(mut self, heights: f64) -> Lettering {
        self.line_spacing = Some(heights);
        self
    }
    /// `left`, `centre` or `right`, for each line.
    pub fn align(mut self, align: &str) -> Lettering {
        self.align = Some(align.to_string());
        self
    }
    /// The layout turned this much, degrees.
    pub fn angle(mut self, deg: f64) -> Lettering {
        self.angle = Some(deg);
        self
    }
    /// A pen font's line width, mm.
    pub fn stroke_width(mut self, mm: f64) -> Lettering {
        self.stroke_width = Some(mm);
        self
    }
    /// Round a cylinder or a cone (the default there).
    pub fn around(mut self) -> Lettering {
        self.along = Some("around".to_string());
        self
    }
    /// Up a cylinder's or a cone's axis.
    pub fn axis(mut self) -> Lettering {
        self.along = Some("axis".to_string());
        self
    }
    /// Along the face's U (a sphere, a torus or a freeform face).
    pub fn u(mut self) -> Lettering {
        self.along = Some("u".to_string());
        self
    }
    /// Along the face's V.
    pub fn v(mut self) -> Lettering {
        self.along = Some("v".to_string());
        self
    }
    /// Push the letters onto a sphere, a torus or a freeform face along its normal, like a slide, instead of wrapping them.
    pub fn project(mut self) -> Lettering {
        self.wrap = Some("project".to_string());
        self
    }
    /// Read the other way round, upside down.
    pub fn flip(mut self) -> Lettering {
        self.flip = true;
        self
    }
    /// Cut the letters into the part instead of raising them.
    pub fn engrave(mut self) -> Lettering {
        self.cut = true;
        self
    }

    /// The fields both the op and the outline call share.
    fn common(&self, text: &str, mut j: Json) -> Json {
        j = j.set("text", text).set("height", self.height);
        if let Some(v) = &self.font {
            j = j.set("font", v.as_str());
        }
        if let Some(v) = &self.style {
            j = j.set("style", v.as_str());
        }
        if let Some(v) = self.weight {
            j = j.set("weight", v);
        }
        if let Some(v) = self.spacing {
            j = j.set("spacing", v);
        }
        if let Some(v) = self.line_spacing {
            j = j.set("lineSpacing", v);
        }
        if let Some(v) = &self.align {
            j = j.set("align", v.as_str());
        }
        if let Some(v) = self.stroke_width {
            j = j.set("strokeWidth", v);
        }
        j
    }

    /// The `text` op for `face`: `faceIndex`, and for a curved face the `point` the text is centred on.
    pub fn op(&self, text: &str, face: &PickedFace) -> Json {
        let mut j = self.common(text, Json::obj().set("kind", "text").set("faceIndex", face.index)).set("depth", self.depth);
        if face.kind != "plane" {
            j = j.set("point", face.point);
        }
        if self.cut {
            j = j.set("op", "cut");
        }
        if let Some(v) = self.angle {
            j = j.set("angleDeg", v);
        }
        if let Some(v) = &self.along {
            j = j.set("along", v.as_str());
        }
        if let Some(v) = &self.wrap {
            j = j.set("wrap", v.as_str());
        }
        if self.flip {
            j = j.set("flip", true);
        }
        j
    }

    /// The arguments of the host's `text_outline` call.
    fn outline_args(&self, text: &str) -> Json {
        let mut j = self.common(text, Json::obj());
        if let Some(v) = self.angle {
            j = j.set("angleDeg", v);
        }
        j
    }
}

fn hold(v: f64, min: Option<f64>, max: Option<f64>) -> f64 {
    let mut v = v;
    if let Some(lo) = min {
        if v < lo {
            v = lo;
        }
    }
    if let Some(hi) = max {
        if v > hi {
            v = hi;
        }
    }
    v
}

impl Session {
    /// Reads the start line: `{"v":1,"params":{...},"context":{...}}`, with `"describe":true` for describe mode.
    pub fn start() -> Session {
        let start = Json::parse(&read_line()).unwrap_or(Json::Null);
        let enabled = start.at("context.nativeGeometry").and_then(Json::as_bool) == Some(true)
            && start.get("describe").and_then(Json::as_bool) != Some(true);
        NATIVE_GEOMETRY.store(enabled, Ordering::Relaxed);
        Session::from_start(&start)
    }

    /// A session from a start message already read (tests, other transports).
    pub fn from_start(start: &Json) -> Session {
        Session {
            params: start.get("params").cloned().unwrap_or(Json::obj()),
            context: start.get("context").cloned().unwrap_or(Json::obj()),
            next_id: 1,
            describe: start.get("describe").and_then(Json::as_bool) == Some(true),
        }
    }

    /// True in describe mode: every parameter gives its default and the run ends at its first call.
    pub fn describing(&self) -> bool {
        self.describe
    }

    /// What a parameter builder needs of the run: the value the host sent, describe mode, and whether a call came first.
    fn reader(&self, name: &str) -> Reader {
        Reader { given: self.params.get(name).cloned(), describe: self.describe, late: self.next_id > 1 }
    }

    /// A number parameter: `s.number("diameter", 80.0).range(20.0, 250.0).unit("mm").label("Outer diameter").get()`.
    /// Declare every parameter before the first call, so a form can show it.
    pub fn number(&self, name: &str, default: f64) -> Number {
        Number { r: self.reader(name), spec: ParamSpec::new(name, "number", Json::from(default)) }
    }

    /// A whole-number parameter: `s.count("holes", 6).range(3, 24).get()`.
    pub fn count(&self, name: &str, default: u32) -> Count {
        Count { r: self.reader(name), spec: ParamSpec::new(name, "count", Json::from(default)) }
    }

    /// An on-or-off parameter: `s.toggle("bore", true).get()`.
    pub fn toggle(&self, name: &str, default: bool) -> Toggle {
        Toggle { r: self.reader(name), spec: ParamSpec::new(name, "toggle", Json::from(default)) }
    }

    /// One of `options`: `s.choice("edge", &["fillet", "chamfer", "sharp"], "fillet").get()`.
    pub fn choice(&self, name: &str, options: &[&str], default: &str) -> Choice {
        let mut spec = ParamSpec::new(name, "choice", Json::from(default));
        spec.options = options.iter().map(|o| o.to_string()).collect();
        Choice { r: self.reader(name), spec }
    }

    /// A text parameter: `s.text("label", "LIME").max_len(20).get()`.
    pub fn text(&self, name: &str, default: &str) -> Text {
        Text { r: self.reader(name), spec: ParamSpec::new(name, "text", Json::from(default)) }
    }

    /// A face of the part the person picks (API 1.2): `s.face("face").rule("largest_up").label("Face to cut").get()`.
    pub fn face(&self, name: &str) -> FaceBuilder {
        FaceBuilder { r: self.reader(name), spec: ParamSpec::new(name, "face", Json::Null) }
    }

    /// A closed outline the person supplies (API 1.2): `s.outline("shape").default_poly(&geom2d::rect(80.0, 60.0)).get()`.
    pub fn outline(&self, name: &str) -> OutlineBuilder {
        OutlineBuilder { r: self.reader(name), spec: ParamSpec::new(name, "outline", Json::Null) }
    }

    /// The face a `face` parameter names, resolved on `part` as it stands now. A face the person picked is found again
    /// by its normal and a point on it, so it survives a change to the steps before it; when it is gone the host
    /// refuses with a sentence naming the parameter.
    #[track_caller]
    pub fn pick_face(&mut self, part: &Part, face: &PickParam) -> Result<PickedFace, Refusal> {
        let line = std::panic::Location::caller().line();
        let mut args = Json::obj().set("param", face.name.as_str()).set("kind", "face").set("object", part.object.as_str()).set("value", face.value.clone());
        if face.curved {
            args = args.set("curved", true);
        }
        let r = self.call("pick", args)?;
        let outline = Section::all(&r).into_iter().next().ok_or(Refusal { reason: "pick gave no face".to_string(), line })?;
        Ok(PickedFace {
            index: r.get("face").and_then(Json::as_f64).unwrap_or(0.0) as u32,
            normal: vec3(r.get("normal")),
            point: vec3(r.get("nearPoint")),
            area: r.get("areaMm2").and_then(Json::as_f64).unwrap_or(0.0),
            outline,
            kind: r.get("surface").and_then(Json::as_str).unwrap_or("plane").to_string(),
            axis: r.get("axis").map(|a| vec3(Some(a))),
            radius: r.get("radiusMm").and_then(Json::as_f64),
            centre: r.get("centre").map(|c| vec3(Some(c))),
            axis_point: r.get("axisPoint").map(|a| vec3(Some(a))),
        })
    }

    /// The region an `outline` parameter names, with the frame it lies in. A face's outline is read on the run's part
    /// unless the value names another; a sketch is read from the step it names.
    #[track_caller]
    pub fn pick_outline(&mut self, outline: &PickParam) -> Result<Section, Refusal> {
        let line = std::panic::Location::caller().line();
        let mut args = Json::obj().set("param", outline.name.as_str()).set("kind", "outline").set("value", outline.value.clone());
        if let Some(o) = self.context.get("object").and_then(Json::as_str) {
            args = args.set("object", o);
        }
        let r = self.call("pick", args)?;
        Section::all(&r).into_iter().next().ok_or(Refusal { reason: "pick gave no outline".to_string(), line })
    }

    /// Text on `face` (API 1.3), one history step: the `text` op built from `how`. `face` is what `pick_face` gave, flat or curved.
    #[track_caller]
    pub fn lettering(&mut self, part: &Part, face: &PickedFace, text: &str, how: &Lettering) -> Result<Json, Refusal> {
        self.apply(part, how.op(text, face))
    }

    /// The letters of `text` in `font` at capitals `height` mm as a flat outline (API 1.3): `.region` for `geom2d`, `.loops` for
    /// `extrude`. The host lays it out, since the recipe crate reads no fonts. It is centred on the origin of a frame with U right
    /// and V up, so `.extrude("fuse", depth, section.loops.clone())` raises it, and a stencil or a fit test can use the region.
    #[track_caller]
    pub fn text_outline(&mut self, text: &str, font: &str, height: f64) -> Result<Section, Refusal> {
        self.text_outline_with(text, &Lettering::new(height, 0.0).font(font))
    }

    /// `text_outline` with the style, weight, spacing, line spacing, alignment, angle and pen width of `how` (its depth is not used).
    #[track_caller]
    pub fn text_outline_with(&mut self, text: &str, how: &Lettering) -> Result<Section, Refusal> {
        let line = std::panic::Location::caller().line();
        let r = self.call("text_outline", how.outline_args(text))?;
        Section::all(&r).into_iter().next().ok_or(Refusal { reason: "text_outline gave no outline".to_string(), line })
    }

    /// The part's bounding box, `(min, max)` in mm (API 1.2), in the frame `apply` takes: model space, where a moved part stands.
    #[track_caller]
    pub fn bounds(&mut self, part: &Part) -> Result<([f64; 3], [f64; 3]), Refusal> {
        let line = std::panic::Location::caller().line();
        let r = self.call("model_describe", Json::obj().set("object", part.object.as_str()).set("limit", 1u32))?;
        match r.get("bounds") {
            Some(b) => Ok((vec3(b.get("min")), vec3(b.get("max")))),
            None => Err(Refusal { reason: "model_describe gave no bounds".to_string(), line }),
        }
    }

    /// Ends the run with `sentence` as its plain refusal (API 1.2): nothing the run did is kept, and the person or the
    /// agent reads the sentence as the reason, with no panic line around it.
    #[track_caller]
    pub fn refuse(&self, sentence: &str) -> ! {
        let line = std::panic::Location::caller().line();
        tell(Json::obj().set("refuse", Json::obj().set("reason", sentence).set("line", line)));
        while !read_line().is_empty() {}
        panic!("{}", sentence);
    }

    /// A number parameter, or `default` when the host did not send it: `number(name, default).get()`.
    #[track_caller]
    pub fn param_f64(&self, name: &str, default: f64) -> f64 {
        self.number(name, default).get()
    }

    /// A count parameter (a number the host sent, rounded down), or `default`.
    #[track_caller]
    pub fn param_u32(&self, name: &str, default: u32) -> u32 {
        self.count(name, default).get()
    }

    #[track_caller]
    pub fn param_bool(&self, name: &str, default: bool) -> bool {
        self.toggle(name, default).get()
    }

    #[track_caller]
    pub fn param_str(&self, name: &str, default: &str) -> String {
        self.text(name, default).get()
    }

    /// The context the host sent: printer, material, units, a starting object.
    pub fn context(&self) -> &Json {
        &self.context
    }

    /// Report progress from 0.0 to 1.0 and a short description to the host.
    pub fn progress(&self, fraction: f64, message: &str) {
        if self.describe { return; }
        tell(Json::obj().set("progress", Json::obj().set("fraction", fraction).set("message", message)));
    }

    /// The object the run starts from, when the host named one.
    pub fn object(&self) -> Option<Part> {
        if self.describe {
            tell(Json::obj().set("describe", Json::obj().set("object", true)));
        }
        self.context.get("object").and_then(Json::as_str).map(|o| Part { object: o.to_string() })
    }

    /// Read the named members and joints of the assembly given to an animation.
    #[track_caller]
    pub fn rig(&mut self) -> Result<anim::Rig, Refusal> {
        let line = std::panic::Location::caller().line();
        let result = self.call("rig", Json::obj())?;
        anim::Rig::from_json(&result).ok_or(Refusal { reason: "The host gave no animation rig.".to_string(), line })
    }

    /// Send the whole animation once. On success the animation run is complete.
    #[track_caller]
    pub fn animate(&mut self, animation: &anim::Animation) -> Result<Json, Refusal> {
        let result = self.call("animate", animation.to_json())?;
        tell(Json::obj().set("done", Json::obj().set("object", "").set("metrics", Json::obj())));
        Ok(result)
    }

    /// One call: `tool` is an MCP tool name from the host's allowlist, `args`
    /// as that tool takes them. The answer is the tool's result, or the
    /// host's refusal with the line that made the call.
    #[track_caller]
    pub fn call(&mut self, tool: &str, args: Json) -> Result<Json, Refusal> {
        let at = std::panic::Location::caller();
        if self.describe {
            self.end_describe(at.line());
        }
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

    /// `data {name}`: the workspace's `<name>.json` as it is, or `<name>.csv` as rows of numbers.
    #[track_caller]
    pub fn data(&mut self, name: &str) -> Result<Json, Refusal> {
        self.call("data", Json::obj().set("name", name))
    }

    /// `data {name}` as a list of numbers (a JSON array, or a one-column CSV).
    #[track_caller]
    pub fn data_f64(&mut self, name: &str) -> Result<Vec<f64>, Refusal> {
        let line = std::panic::Location::caller().line();
        let d = self.data(name)?;
        d.as_f64s().ok_or(Refusal { reason: format!("The data {name} is not a list of numbers."), line })
    }

    /// `data {name}` as points: `[x, y]` rows (a two-column CSV) or `{x, y}` objects, ready for `geom2d::Poly::new`.
    #[track_caller]
    pub fn data_points2(&mut self, name: &str) -> Result<Vec<[f64; 2]>, Refusal> {
        let line = std::panic::Location::caller().line();
        let d = self.data(name)?;
        d.as_points2().ok_or(Refusal { reason: format!("The data {name} is not a list of [x, y] points."), line })
    }

    /// `section {object, face, insetMm}`: a flat face's outline, inset by `inset` mm (0 for the edge itself).
    /// `face` is an index (`3.0`) or `Json::obj().set("normal", [0.0, 0.0, 1.0]).set("nearPoint", [x, y, z])`.
    /// An inset that leaves nothing gives an empty region.
    #[track_caller]
    pub fn face_outline(&mut self, part: &Part, face: impl Into<Json>, inset: f64) -> Result<Section, Refusal> {
        let line = std::panic::Location::caller().line();
        let r = self.call("section", Json::obj().set("object", part.object.as_str()).set("face", face).set("insetMm", inset))?;
        Section::all(&r).into_iter().next().ok_or(Refusal { reason: "section gave no outline".to_string(), line })
    }

    /// `section {object, planes}`: the part cut by the plane through `origin` square to `normal`.
    #[track_caller]
    pub fn section(&mut self, part: &Part, origin: [f64; 3], normal: [f64; 3]) -> Result<Section, Refusal> {
        let line = std::panic::Location::caller().line();
        let plane = Json::obj().set("origin", origin).set("normal", normal);
        let r = self.call("section", Json::obj().set("object", part.object.as_str()).set("planes", Json::Arr(vec![plane])))?;
        Section::all(&r).into_iter().next().ok_or(Refusal { reason: "section gave no cut".to_string(), line })
    }

    /// `section` with any of its arguments (`planes`, `fan`, `levels`; the object is set here): one `Section` a plane.
    #[track_caller]
    pub fn sections(&mut self, part: &Part, args: Json) -> Result<Vec<Section>, Refusal> {
        let r = self.call("section", args.set("object", part.object.as_str()))?;
        Ok(Section::all(&r))
    }

    /// `model_apply_batch {combine}`: every op (`op` is "cut" or "fuse", and each op's own `op` must match) meets the
    /// part in one boolean, one history step. An op that does not fit is listed in `failures`; the rest apply.
    #[track_caller]
    pub fn apply_many(&mut self, part: &Part, op: &str, ops: Vec<Json>) -> Result<Combined, Refusal> {
        let r = self.call("model_apply_batch", Json::obj().set("object", part.object.as_str()).set("ops", Json::Arr(ops)).set("combine", op))?;
        Ok(Combined::from_json(&r))
    }

    /// API 1.11: queues `op` on `part`. Nothing is built now: the host builds queued fuses and cuts whose tools lie
    /// apart in one boolean when the part is next read, placed, applied without the queue, at `flush`, or at `done`.
    /// An op the host refuses comes back from `flush` (or ends the run at `done`) with this line, not here.
    #[track_caller]
    pub fn apply_later(&mut self, part: &Part, op: Json) -> Result<(), Refusal> {
        self.call("model_apply", Json::obj().set("object", part.object.as_str()).set("op", op).set("probe", true).set("queue", "later"))
            .map(|_| ())
    }

    /// API 1.11: builds what is queued on `part` now. `failures` lists each `apply_later` op the host refused, by its
    /// place among the ops queued since the last flush, and `Combined::lines` gives the recipe line of each.
    #[track_caller]
    pub fn flush(&mut self, part: &Part) -> Result<Combined, Refusal> {
        let r = self.call("flush", Json::obj().set("object", part.object.as_str()))?;
        Ok(Combined::from_json(&r))
    }

    /// API 1.11: builds what is queued on `part`, then `op` on its own, and answers as `apply` does (its node, its
    /// fingerprint): for a step whose own answer the recipe reads.
    #[track_caller]
    pub fn apply_now(&mut self, part: &Part, op: Json) -> Result<Json, Refusal> {
        self.call("model_apply", Json::obj().set("object", part.object.as_str()).set("op", op).set("probe", true).set("queue", "now"))
    }

    /// API 1.11: `queue(false)` asks the host to build every later `apply` of this run one by one, as it is called,
    /// instead of holding plain fuses and cuts whose answer the recipe does not read. `queue(true)` allows it again.
    /// `apply_later` always queues.
    #[track_caller]
    pub fn queue(&mut self, silent: bool) {
        if self.describe {
            return;
        }
        let line = std::panic::Location::caller().line();
        tell(Json::obj().set("queue", Json::obj().set("silent", silent).set("line", line)));
    }

    /// Describe mode ends at the first call: the host has every declared parameter and stops the program here.
    fn end_describe(&self, line: u32) {
        tell(Json::obj().set("describe", Json::obj().set("end", true).set("line", line)));
        while !read_line().is_empty() {}
        panic!("describe mode ends before the first call");
    }

    /// A note the host shows with the result.
    #[track_caller]
    pub fn log(&mut self, text: &str) {
        let _ = self.call("log", Json::obj().set("text", text));
    }

    /// Asks the host to mesh each part once, when the run ends or when a call needs the mesh, and not after every step
    /// (recipe API 1.10). The part, its solid and its mesh at the end are the same; a long run of plain steps (a
    /// boolean with a primitive, an extrude with its own plane) is faster by what the meshing between them cost.
    /// A step that reads the part's faces (a face selector, a pick, a section) meshes it first. A host that
    /// does not know the request, as the Plugins window, runs as before. Call it once, before the steps.
    #[track_caller]
    pub fn mesh_at_end(&mut self) {
        let _ = self.call("mesh_at_end", Json::obj());
    }

    /// Runs the kept plugin `id` with `params` as a nested run (API 1.16): its own build and parameters, inside this
    /// run's transaction and limits. The parts it made come back as this run's own (`PluginRun`). A refusal comes back
    /// as `Err` with the nested plugin's sentence and nothing of that nested run is left; an `Err` this recipe does not
    /// handle ends the whole run, which then takes everything back. The host runs the version this recipe ran before
    /// (pinned with its parts), else the library's current one, and never a plugin nobody approved.
    #[track_caller]
    pub fn run_plugin(&mut self, id: &str, params: Json) -> Result<PluginRun, Refusal> {
        let line = std::panic::Location::caller().line();
        let r = self.call("plugin_run", Json::obj().set("plugin", id).set("params", params))?;
        PluginRun::from_json(&r).ok_or(Refusal { reason: format!("plugin_run of {id} gave no part"), line })
    }

    /// `run_plugin` with one version of the plugin (API 1.16): the library's file of that version, or the project's copy.
    #[track_caller]
    pub fn run_plugin_version(&mut self, id: &str, version: u32, params: Json) -> Result<PluginRun, Refusal> {
        let line = std::panic::Location::caller().line();
        let r = self.call("plugin_run", Json::obj().set("plugin", id).set("version", version).set("params", params))?;
        PluginRun::from_json(&r).ok_or(Refusal { reason: format!("plugin_run of {id} gave no part"), line })
    }

    /// Puts `part` in an assembly on `parent` (API 1.16): `at` is its offset in mm and `turn` its turns about X, Y and Z
    /// in degrees, in the parent's frame. `model_place {object, to, x, y, z, turnX, turnY, turnZ}`; both parts must be
    /// this run's, and the host must allow assembling (`context.limits.canAssemble`).
    #[track_caller]
    pub fn attach(&mut self, part: &Part, parent: &Part, at: [f64; 3], turn: [f64; 3]) -> Result<Json, Refusal> {
        let args = Json::obj()
            .set("object", part.object.as_str())
            .set("to", parent.object.as_str())
            .set("x", at[0])
            .set("y", at[1])
            .set("z", at[2])
            .set("turnX", turn[0])
            .set("turnY", turn[1])
            .set("turnZ", turn[2]);
        self.call("model_place", args)
    }

    /// Sets `part`'s joint to its parent (API 1.16): `joint` as `model_place {joint}` takes it (`kind` hinge, slide,
    /// ball or held, with `pivot`, `axis`, `min`, `max`, `cone`, `zero`), or `Json::Null` to fix it again.
    #[track_caller]
    pub fn joint(&mut self, part: &Part, joint: Json) -> Result<Json, Refusal> {
        self.call("model_place", Json::obj().set("object", part.object.as_str()).set("joint", joint))
    }

    /// A hinge (API 1.16): `part` turns about `axis` through `pivot`, both in its own frame.
    #[track_caller]
    pub fn hinge(&mut self, part: &Part, pivot: [f64; 3], axis: [f64; 3]) -> Result<Json, Refusal> {
        self.joint(part, Json::obj().set("kind", "hinge").set("pivot", pivot).set("axis", axis))
    }

    /// A slide (API 1.16): `part` moves along `axis` from `pivot`, both in its own frame.
    #[track_caller]
    pub fn slide(&mut self, part: &Part, pivot: [f64; 3], axis: [f64; 3]) -> Result<Json, Refusal> {
        self.joint(part, Json::obj().set("kind", "slide").set("pivot", pivot).set("axis", axis))
    }

    /// Held (API 1.16): `part` stays where it is, and Couple gears never gives it a hinge.
    #[track_caller]
    pub fn hold(&mut self, part: &Part) -> Result<Json, Refusal> {
        self.joint(part, Json::obj().set("kind", "held"))
    }

    /// Turns `part`'s hinge to `angle` degrees from its zero (a slide: moves it `angle` mm), and a coupled train with it
    /// (API 1.16): `model_place {object, angle}`.
    #[track_caller]
    pub fn turn_joint(&mut self, part: &Part, angle: f64) -> Result<Json, Refusal> {
        self.call("model_place", Json::obj().set("object", part.object.as_str()).set("angle", angle))
    }

    /// Couples the gears of `part`'s assembly that mesh (API 1.16): `model_place {object, gears: "couple"}`, with the
    /// same checks and refusals as the tool. Gears in no assembly get a hinge and an assembly of their own. The reply
    /// lists the `couplings`, and any pair `notCoupled` or `locked` with the reason.
    #[track_caller]
    pub fn couple_gears(&mut self, part: &Part) -> Result<Json, Refusal> {
        self.call("model_place", Json::obj().set("object", part.object.as_str()).set("gears", "couple"))
    }

    /// Commit work so far and let the host resume this run after an interruption.
    #[track_caller]
    pub fn checkpoint(&mut self) -> Result<(), Refusal> {
        self.call("checkpoint", Json::obj()).map(|_| ())
    }

    /// Ends the run: the host commits the part to the plate.
    pub fn done(self, part: &Part) {
        self.done_with(part, Json::obj())
    }

    /// Ends the run with numbers for the caller (a search ranks by them).
    pub fn done_with(self, part: &Part, metrics: Json) {
        if self.describe {
            tell(Json::obj().set("describe", Json::obj().set("end", true)));
            return;
        }
        let msg = Json::obj().set("done", Json::obj().set("object", part.object.as_str()).set("metrics", metrics));
        let mut out = std::io::stdout().lock();
        writeln!(out, "{msg}").unwrap();
        out.flush().unwrap();
    }
}

fn vec3(v: Option<&Json>) -> [f64; 3] {
    let n = |i: usize| v.and_then(|a| a.as_array()).and_then(|a| a.get(i)).and_then(Json::as_f64).unwrap_or(0.0);
    [n(0), n(1), n(2)]
}

/// A plane's frame in the part frame: `origin`, and the unit axes `u`, `v` (in the plane) and `w` (its normal).
/// A point `[a, b]` of a section is `origin + a·u + b·v`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Frame {
    pub origin: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
    pub w: [f64; 3],
}

impl Frame {
    /// The part-frame point at `[a, b]` in this plane.
    pub fn point(&self, p: geom2d::Pt) -> [f64; 3] {
        let mut out = [0.0; 3];
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = self.origin[i] + p[0] * self.u[i] + p[1] * self.v[i];
        }
        out
    }
}

/// One answer of `section`: a face's outline or a plane's cut, in the plane's frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub frame: Frame,
    /// The `origin` and `turn` an `extrude` takes to draw in this frame.
    pub origin: [f64; 3],
    pub turn: [f64; 3],
    /// The area as points (curves sampled to the call's chord, 0.05 mm by default), for `geom2d`.
    pub region: geom2d::Region,
    /// The kernel's `loops`, arcs kept, ready for `extrude.loops`.
    pub loops: Json,
    /// Net area, mm².
    pub area: f64,
}

impl Section {
    /// Every section in a `section` reply, or in recipe data saved with `saveAs` (the same shape).
    pub fn all(reply: &Json) -> Vec<Section> {
        match reply.get("sections").and_then(Json::as_array) {
            Some(rows) => rows.iter().map(Section::from_json).collect(),
            None => Vec::new(),
        }
    }

    /// One section from its JSON row.
    pub fn from_json(row: &Json) -> Section {
        let frame = row.get("frame");
        let mut loops: Vec<geom2d::Poly> = Vec::new();
        if let Some(regions) = row.get("regions").and_then(Json::as_array) {
            for r in regions.iter() {
                if let Some(outer) = r.get("outer").and_then(Json::as_points2) {
                    loops.push(geom2d::Poly::new(outer));
                }
                if let Some(holes) = r.get("holes").and_then(Json::as_array) {
                    for h in holes.iter() {
                        if let Some(pts) = h.as_points2() {
                            loops.push(geom2d::Poly::new(pts));
                        }
                    }
                }
            }
        }
        Section {
            frame: Frame {
                origin: vec3(frame.and_then(|f| f.get("origin"))),
                u: vec3(frame.and_then(|f| f.get("u"))),
                v: vec3(frame.and_then(|f| f.get("v"))),
                w: vec3(frame.and_then(|f| f.get("w"))),
            },
            origin: vec3(row.get("origin")),
            turn: vec3(row.get("turn")),
            region: if loops.is_empty() { geom2d::Region::empty() } else { geom2d::Region::from_loops(&loops) },
            loops: row.get("loops").cloned().unwrap_or(Json::Arr(Vec::new())),
            area: row.get("areaMm2").and_then(Json::as_f64).unwrap_or(0.0),
        }
    }

    /// An `extrude` op that draws `loops` (one piece: an outline, then its holes) in this frame: `op` is "cut" or
    /// "fuse", `depth` along `w` (negative goes into the part).
    pub fn extrude(&self, op: &str, depth: f64, loops: Json) -> Json {
        Json::obj().set("kind", "extrude").set("op", op).set("origin", self.origin).set("turn", self.turn).set("depth", depth).set("loops", loops)
    }
}

/// What `apply_many` did: how many ops applied, and each op left out with its index in the list and why.
#[derive(Clone, Debug, PartialEq)]
pub struct Combined {
    pub applied: u32,
    pub failures: Vec<(usize, String)>,
    /// The whole reply (node, fingerprint, bounds).
    pub reply: Json,
}

impl Combined {
    /// API 1.11: the recipe line of each failure, in the order of `failures` (0 when the host did not say).
    pub fn lines(&self) -> Vec<u32> {
        let mut lines: Vec<u32> = Vec::new();
        if let Some(rows) = self.reply.get("failures").and_then(Json::as_array) {
            for f in rows.iter() {
                lines.push(f.get("line").and_then(Json::as_f64).unwrap_or(0.0) as u32);
            }
        }
        lines
    }

    pub fn from_json(r: &Json) -> Combined {
        let mut failures: Vec<(usize, String)> = Vec::new();
        if let Some(rows) = r.get("failures").and_then(Json::as_array) {
            for f in rows.iter() {
                let index = f.get("index").and_then(Json::as_f64).unwrap_or(0.0) as usize;
                failures.push((index, f.get("reason").and_then(Json::as_str).unwrap_or("").to_string()));
            }
        }
        Combined { applied: r.get("applied").and_then(Json::as_f64).unwrap_or(0.0) as u32, failures, reply: r.clone() }
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

    /// An exact 2D NURBS profile loop segment from the previous point through interior `poles` to `to`.
    /// Optional `weights` cover all poles (start, interior poles, to); `degree` defaults to 3.
    pub fn nurbs_seg(
        poles: Vec<[f64; 2]>,
        weights: Option<Vec<f64>>,
        degree: Option<u32>,
        knots: Option<Vec<f64>>,
        mults: Option<Vec<u32>>,
        to: [f64; 2],
    ) -> Json {
        let mut obj = Json::obj().set("kind", "nurbs").set("to", to);
        if !poles.is_empty() {
            obj = obj.set("poles", poles);
        }
        if let Some(w) = weights {
            obj = obj.set("weights", w);
        }
        if let Some(d) = degree {
            obj = obj.set("degree", d);
        }
        if let Some(k) = knots {
            obj = obj.set("knots", k);
        }
        if let Some(m) = mults {
            obj = obj.set("mults", Json::arr(m.into_iter().map(|v| v as f64).collect()));
        }
        obj
    }

    /// An exact 3D polyline spine curve for `sweep`.
    pub fn curve3d_polyline(points: Vec<[f64; 3]>, closed: bool) -> Json {
        let obj = Json::obj().set("kind", "polyline").set("points", points);
        if closed { obj.set("closed", true) } else { obj }
    }

    /// An exact 3D rational NURBS spine curve for `sweep`.
    pub fn curve3d_nurbs(
        poles: Vec<[f64; 3]>,
        weights: Option<Vec<f64>>,
        degree: Option<u32>,
        knots: Option<Vec<f64>>,
        mults: Option<Vec<u32>>,
        closed: bool,
    ) -> Json {
        let mut obj = Json::obj().set("kind", "nurbs").set("poles", poles);
        if let Some(w) = weights {
            obj = obj.set("weights", w);
        }
        if let Some(d) = degree {
            obj = obj.set("degree", d);
        }
        if let Some(k) = knots {
            obj = obj.set("knots", k);
        }
        if let Some(m) = mults {
            obj = obj.set("mults", Json::arr(m.into_iter().map(|v| v as f64).collect()));
        }
        if closed {
            obj = obj.set("closed", true);
        }
        obj
    }

    /// An exact kernel pipe-shell sweep (`BRepOffsetAPI_MakePipeShell`): `op` is "fuse", "cut", or "common".
    pub fn sweep(op: &str, sections: Vec<Json>, spine: Json) -> Json {
        Json::obj()
            .set("kind", "sweep")
            .set("op", op)
            .set("sections", Json::arr(sections))
            .set("spine", spine)
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

    /// A curvature-continuous ($G^2$) smooth fillet on `edges`.
    pub fn fillet_g2(edges: Json, size: f64) -> Json {
        fillet(edges, size).set("continuity", "g2")
    }

    /// A rational conic fillet of fullness `rho` (0.05..0.95) on `edges`.
    pub fn fillet_conic(edges: Json, size: f64, rho: f64) -> Json {
        fillet(edges, size).set("continuity", "conic").set("rho", rho)
    }

    /// A variable-radius fillet with `[u, radius]` stations (`u` in `0..=1`) and optional continuity (`"g1"`, `"g2"`, `"conic"`).
    pub fn fillet_variable(edges: Json, stations: &[[f64; 2]], continuity: Option<&str>) -> Json {
        let size = stations.first().map(|s| s[1]).unwrap_or(1.0);
        let mut obj = fillet(edges, size).set("variable", Json::arr(stations.iter().map(|s| Json::from(*s)).collect()));
        if let Some(c) = continuity {
            obj = obj.set("continuity", c);
        }
        obj
    }

    /// A point apex section for a controlled loft (`{ apex: [x, y, z] }`).
    pub fn loft_apex(point: [f64; 3]) -> Json {
        Json::obj().set("apex", point)
    }

    /// A controlled loft through `sections` (`op` is `"fuse"`, `"cut"`, or `"common"`).
    /// Chain `.set("guides", ...)`, `.set("startCondition", ...)`, `.set("endCondition", ...)`, `.set("closed", true)`, or `.set("smoothing", true)`.
    pub fn loft(op: &str, sections: Vec<Json>) -> Json {
        Json::obj().set("kind", "loft").set("op", op).set("sections", Json::arr(sections))
    }

    /// S4: Sheet spec extruded from a 3D curve along `dir` by `distance` mm.
    pub fn sheet_extrude_spec(curve: Json, dir: [f64; 3], distance: f64) -> Json {
        Json::obj()
            .set("mode", "extrude")
            .set("curves", Json::arr(vec![curve]))
            .set("dir", dir)
            .set("distance", distance)
    }

    /// S4: Sheet spec revolved from a 3D curve around `(axis_origin, dir)` by `angle_deg` degrees.
    pub fn sheet_revolve_spec(curve: Json, axis_origin: [f64; 3], dir: [f64; 3], angle_deg: f64) -> Json {
        Json::obj()
            .set("mode", "revolve")
            .set("curves", Json::arr(vec![curve]))
            .set("axisOrigin", axis_origin)
            .set("dir", dir)
            .set("angleDeg", angle_deg)
    }

    /// S4: Sheet spec lofted across 3D `curves` (`ruled` for straight rulings).
    pub fn sheet_loft_spec(curves: Vec<Json>, ruled: bool) -> Json {
        let mut obj = Json::obj().set("mode", "loft").set("curves", Json::arr(curves));
        if ruled {
            obj = obj.set("ruled", true);
        }
        obj
    }

    /// S4: Planar open sheet spec bounded by a closed 3D `curve`.
    pub fn sheet_planar_spec(curve: Json) -> Json {
        Json::obj().set("mode", "planar").set("curves", Json::arr(vec![curve]))
    }

    /// S4: Open sheet op built from a sheet spec (`sheet_extrude_spec`, `sheet_revolve_spec`, `sheet_loft_spec`, or `sheet_planar_spec`).
    pub fn sheet(spec: Json) -> Json {
        spec.set("kind", "sheet")
    }

    /// S4: Sew open faces/shells within tolerance (optional planar capping & solid auto-promotion).
    pub fn sew(cap_planar: bool, make_solid: bool) -> Json {
        Json::obj()
            .set("kind", "sew")
            .set("capPlanar", cap_planar)
            .set("makeSolid", make_solid)
    }

    /// S5: One side of a patch or blend. `continuity` is `"g0"`, `"g1"`, or `"g2"`.
    pub fn surface_boundary(edges: Json, continuity: &str) -> Json {
        Json::obj().set("edges", edges).set("continuity", continuity)
    }

    /// S5: Fill an opening. A clean 2–4 curve G0 boundary uses GeomFill; G1, G2, or an N-sided opening is N Hermite–Coons pieces.
    pub fn patch(boundaries: Vec<Json>) -> Json {
        Json::obj().set("kind", "patch").set("boundaries", Json::arr(boundaries))
    }

    /// S6: An M by N NURBS sheet. `poles` is one row per U index. Degree defaults to 3 when left out.
    pub fn nurbs_surface(poles: Vec<Vec<[f64; 3]>>) -> Json {
        let rows: Vec<Json> = poles.into_iter().map(Json::from).collect();
        Json::obj().set("kind", "nurbsSurface").set("poles", rows)
    }

    /// S6: a `nurbsSurface` op built field by field, for what `nurbs_surface` leaves at its defaults:
    /// `ops::NurbsSurface::new(poles).degrees(3, 2).weights(w).knots_u(vec![0.0, 0.5, 1.0], vec![4, 1, 4]).op()`.
    /// Each setter writes the field `guide {kind:"nurbsSurface"}` names, as the server takes it. The server refuses what
    /// does not fit (a degree the poles cannot carry, weights or knots that do not match, an insert past the degree).
    #[derive(Clone, Debug, PartialEq)]
    pub struct NurbsSurface {
        op: Json,
        insert_u: Vec<[f64; 2]>,
        insert_v: Vec<[f64; 2]>,
    }

    impl NurbsSurface {
        /// The grid: one row per U index, each row along V.
        pub fn new(poles: Vec<Vec<[f64; 3]>>) -> NurbsSurface {
            NurbsSurface { op: nurbs_surface(poles), insert_u: Vec::new(), insert_v: Vec::new() }
        }
        /// One weight per pole, each above 0, in the poles' rows.
        pub fn weights(self, weights: Vec<Vec<f64>>) -> NurbsSurface {
            let rows: Vec<Json> = weights.into_iter().map(Json::from).collect();
            NurbsSurface { op: self.op.set("weights", Json::arr(rows)), ..self }
        }
        /// The degree in U and in V, 1 to 8 (3 when left out).
        pub fn degrees(self, u: u32, v: u32) -> NurbsSurface {
            NurbsSurface { op: self.op.set("degreeU", u).set("degreeV", v), ..self }
        }
        /// Distinct U knots, rising, and one multiplicity per knot.
        pub fn knots_u(self, knots: Vec<f64>, mults: Vec<u32>) -> NurbsSurface {
            let mults: Vec<f64> = mults.into_iter().map(f64::from).collect();
            NurbsSurface { op: self.op.set("knotsU", knots).set("multsU", mults), ..self }
        }
        /// Distinct V knots, rising, and one multiplicity per knot.
        pub fn knots_v(self, knots: Vec<f64>, mults: Vec<u32>) -> NurbsSurface {
            let mults: Vec<f64> = mults.into_iter().map(f64::from).collect();
            NurbsSurface { op: self.op.set("knotsV", knots).set("multsV", mults), ..self }
        }
        /// Closed (periodic) in U, in V, or both. A closed direction needs at least 3 poles.
        pub fn periodic(self, u: bool, v: bool) -> NurbsSurface {
            let mut op = self.op;
            if u {
                op = op.set("periodicU", true);
            }
            if v {
                op = op.set("periodicV", true);
            }
            NurbsSurface { op, ..self }
        }
        /// Insert the U knot `param` `times` times (1 to the U degree); the surface keeps its shape. Clamped grids only.
        pub fn insert_u(mut self, param: f64, times: u32) -> NurbsSurface {
            self.insert_u.push([param, f64::from(times)]);
            self
        }
        /// Insert the V knot `param` `times` times (1 to the V degree); the surface keeps its shape. Clamped grids only.
        pub fn insert_v(mut self, param: f64, times: u32) -> NurbsSurface {
            self.insert_v.push([param, f64::from(times)]);
            self
        }
        /// Raise the U degree to `u` and the V degree to `v` (up to 8); the surface keeps its shape. Clamped grids only.
        pub fn elevate(self, u: Option<u32>, v: Option<u32>) -> NurbsSurface {
            let mut op = self.op;
            if let Some(u) = u {
                op = op.set("elevateU", u);
            }
            if let Some(v) = v {
                op = op.set("elevateV", v);
            }
            NurbsSurface { op, ..self }
        }
        /// The op to apply, or to give `solid_new` as its `feature` (a part that starts from the surface).
        pub fn op(self) -> Json {
            let mut op = self.op;
            if !self.insert_u.is_empty() {
                op = op.set("insertU", Json::arr(self.insert_u.into_iter().map(Json::from).collect()));
            }
            if !self.insert_v.is_empty() {
                op = op.set("insertV", Json::arr(self.insert_v.into_iter().map(Json::from).collect()));
            }
            op
        }
    }

    /// S5: Bridge two open edges or chains at `"g1"` or `"g2"`, with a tension on each side.
    pub fn blend_surface(a: Json, b: Json, continuity: &str, tension_a: f64, tension_b: f64) -> Json {
        Json::obj()
            .set("kind", "blendSurface")
            .set("a", a)
            .set("b", b)
            .set("continuity", continuity)
            .set("tensionA", tension_a)
            .set("tensionB", tension_b)
    }

    /// S4: Thicken an open sheet into a watertight solid wall (`direction`: `"normal"`, `"reverse"`, or `"both"`).
    pub fn thicken(thickness: f64, direction: &str) -> Json {
        Json::obj()
            .set("kind", "thicken")
            .set("thickness", thickness)
            .set("direction", direction)
    }

    /// S4: Split a solid or sheet cleanly with a sculpted surface (`keep`: `"above"`, `"below"`, or `"both"`).
    pub fn trim_split(sheet_spec: Json, keep: &str) -> Json {
        Json::obj()
            .set("kind", "trimSplit")
            .set("sheet", sheet_spec)
            .set("keep", keep)
    }

    /// S4: Replace a solid face (`face` index or selector JSON) with a sculpted NURBS surface.
    pub fn replace_face(face: Json, sheet_spec: Json) -> Json {
        Json::obj()
            .set("kind", "replaceFace")
            .set("face", face)
            .set("sheet", sheet_spec)
    }

    /// S4: Project and imprint a 3D `curve` onto `faces` (optional projection `direction`).
    pub fn split_face(faces: Vec<Json>, curve: Json, direction: Option<[f64; 3]>) -> Json {
        let mut obj = Json::obj()
            .set("kind", "splitFace")
            .set("faces", Json::arr(faces))
            .set("curve", curve);
        if let Some(d) = direction {
            obj = obj.set("direction", d);
        }
        obj
    }

    /// The kernel's gear step (API 1.12): a spur gear with true involute flanks, `thickness` mm along its axis, its base
    /// centred on `origin` (part frame), combined by `op` ("fuse", "cut" or "common"). Add `bore`, `boreShape`,
    /// `hubDiameter`, `hubHeight`, `phaseDeg` or `turn` with `.set`; guide {kind:"gear"} lists them.
    pub fn gear(op: &str, gear: &super::gears::Gear, thickness: f64, origin: [f64; 3]) -> Json {
        gear_fields(Json::obj().set("kind", "gear").set("op", op), gear, thickness).set("origin", origin)
    }

    /// A new solid that is a gear, for `solid_new`: its base on Z = 0, centred on the axis.
    pub fn gear_solid(gear: &super::gears::Gear, thickness: f64) -> Json {
        gear_fields(Json::obj().set("primitive", "gear"), gear, thickness)
    }

    fn gear_fields(base: Json, gear: &super::gears::Gear, thickness: f64) -> Json {
        base.set("teeth", gear.teeth)
            .set("module", gear.module)
            .set("thickness", thickness)
            .set("pressureDeg", gear.pressure_deg)
            .set("backlash", gear.backlash)
            .set("profileShift", gear.shift)
    }
}

/// 2D geometry for sketches and cell patterns: polygons, regions with holes,
/// booleans, offsets, rounded and chamfered corners, cleanup, and the `loops`
/// JSON `extrude` takes. Pure functions, no calls to the host.
///
/// A `Region` keeps every outline counter-clockwise and every hole clockwise,
/// so material is always on the left of a loop. Booleans and offsets accept
/// concave outlines, holes, touching edges and overlapping edges.
pub mod geom2d {
    use super::Json;
    use std::collections::HashMap;

    const PI: f64 = std::f64::consts::PI;

    /// A point or a vector, `[x, y]` in mm.
    pub type Pt = [f64; 2];

    /// Points closer than this (mm) are one point in a boolean or an offset.
    pub const SNAP: f64 = 1e-7;

    fn sub(a: Pt, b: Pt) -> Pt {
        [a[0] - b[0], a[1] - b[1]]
    }
    fn add(a: Pt, b: Pt) -> Pt {
        [a[0] + b[0], a[1] + b[1]]
    }
    fn mul(a: Pt, k: f64) -> Pt {
        [a[0] * k, a[1] * k]
    }
    fn dot(a: Pt, b: Pt) -> f64 {
        a[0] * b[0] + a[1] * b[1]
    }
    fn cross(a: Pt, b: Pt) -> f64 {
        a[0] * b[1] - a[1] * b[0]
    }
    fn len(a: Pt) -> f64 {
        a[0].hypot(a[1])
    }
    fn dist(a: Pt, b: Pt) -> f64 {
        len(sub(a, b))
    }
    fn norm(a: Pt) -> Pt {
        let l = len(a);
        if l > 0.0 { [a[0] / l, a[1] / l] } else { [0.0, 0.0] }
    }
    /// `x` held between `lo` and `hi`.
    pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
        if x < lo {
            lo
        } else if x > hi {
            hi
        } else {
            x
        }
    }

    fn turn(p: Pt, deg: f64) -> Pt {
        let (s, c) = sin_cos_deg(deg);
        [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
    }

    // Trigonometry from + - * / and sqrt only (fdlibm's kernels), so a recipe gets the same bits under
    // lust and rustc: their libm sin, cos, tan, atan2 and acos differ in the last bit for some inputs.

    #[allow(clippy::excessive_precision)]
    fn k_sin(x: f64) -> f64 {
        let z = x * x;
        let r = 0.00833333333332249 + z * (-0.0001984126982985795 + z * (2.7557313707070068e-06 + z * (-2.5050760253406863e-08 + z * 1.58969099521155e-10)));
        x + z * x * (-0.16666666666666632 + z * r)
    }

    #[allow(clippy::excessive_precision)]
    fn k_cos(x: f64) -> f64 {
        let z = x * x;
        let r = z * (0.0416666666666666 + z * (-0.001388888888887411 + z * (2.480158728947673e-05 + z * (-2.7557314351390663e-07 + z * (2.087572321298175e-09 + z * -1.1359647557788195e-11)))));
        let hz = 0.5 * z;
        let w = 1.0 - hz;
        w + (((1.0 - w) - hz) + z * r)
    }

    /// `(sin, cos)` of `n` quarter turns plus `r` (within ±π/4).
    fn quadrant(n: i64, r: f64) -> (f64, f64) {
        let (s, c) = (k_sin(r), k_cos(r));
        let (s, c) = match n.rem_euclid(4) {
            0 => (s, c),
            1 => (c, -s),
            2 => (-s, -c),
            _ => (-c, s),
        };
        (s + 0.0, c + 0.0)
    }

    /// `(sin, cos)` of an angle in degrees, exact at multiples of 90°, with the same bits under lust and rustc.
    pub fn sin_cos_deg(deg: f64) -> (f64, f64) {
        let n = (deg / 90.0).round();
        let r = (deg - 90.0 * n) * (PI / 180.0);
        quadrant(n as i64, r)
    }

    pub(crate) fn sin_cos(x: f64) -> (f64, f64) {
        let n = (x * (2.0 / PI)).round();
        let r = (x - n * 1.5707963267341256) - n * 6.077100506506192e-11;
        quadrant(n as i64, r)
    }

    #[allow(clippy::excessive_precision, clippy::approx_constant)]
    pub(crate) fn atan(x: f64) -> f64 {
        const HI: [f64; 4] = [0.4636476090008061, 0.7853981633974483, 0.982793723247329, 1.5707963267948966];
        const LO: [f64; 4] = [2.2698777452961687e-17, 3.061616997868383e-17, 1.3903311031230998e-17, 6.123233995736766e-17];
        let neg = x < 0.0;
        let mut a = x.abs();
        if a >= 7.378697629483821e19 {
            return if neg { -HI[3] - LO[3] } else { HI[3] + LO[3] };
        }
        let id: i32 = if a < 0.4375 {
            -1
        } else if a < 1.1875 {
            if a < 0.6875 {
                a = (2.0 * a - 1.0) / (2.0 + a);
                0
            } else {
                a = (a - 1.0) / (a + 1.0);
                1
            }
        } else if a < 2.4375 {
            a = (a - 1.5) / (1.0 + 1.5 * a);
            2
        } else {
            a = -1.0 / a;
            3
        };
        let z = a * a;
        let w = z * z;
        let s1 = z * (0.3333333333333293 + w * (0.14285714272503466 + w * (0.09090887133436507 + w * (0.06661073137387531 + w * (0.049768779946159324 + w * 0.016285820115365782)))));
        let s2 = w * (-0.19999999999876483 + w * (-0.11111110405462356 + w * (-0.0769187620504483 + w * (-0.058335701337905735 + w * -0.036531572744216916))));
        let v = if id < 0 {
            a - a * (s1 + s2)
        } else {
            let k = id as usize;
            HI[k] - ((a * (s1 + s2) - LO[k]) - a)
        };
        if neg { -v } else { v }
    }

    pub(crate) fn atan2(y: f64, x: f64) -> f64 {
        const PI_LO: f64 = 1.2246467991473532e-16;
        if x == 0.0 {
            return if y > 0.0 {
                PI / 2.0
            } else if y < 0.0 {
                -PI / 2.0
            } else {
                0.0
            };
        }
        let z = atan((y / x).abs());
        if x > 0.0 {
            if y < 0.0 { -z } else { z }
        } else if y < 0.0 {
            (z - PI_LO) - PI
        } else {
            PI - (z - PI_LO)
        }
    }

    /// The parameter along a..b of the point nearest `p`, and the distance to it.
    fn seg_near(p: Pt, a: Pt, b: Pt) -> (f64, f64) {
        let d = sub(b, a);
        let l2 = dot(d, d);
        let t = if l2 > 0.0 { clamp(dot(sub(p, a), d) / l2, 0.0, 1.0) } else { 0.0 };
        (t, dist(p, add(a, mul(d, t))))
    }

    /// Winding number of a closed point list around `p` (not on it).
    fn winding(pts: &[Pt], p: Pt) -> i32 {
        let n = pts.len();
        let mut w = 0;
        for i in 0..n {
            let a = pts[i];
            let b = pts[(i + 1) % n];
            let side = cross(sub(b, a), sub(p, a));
            if a[1] <= p[1] {
                if b[1] > p[1] && side > 0.0 {
                    w += 1;
                }
            } else if b[1] <= p[1] && side < 0.0 {
                w -= 1;
            }
        }
        w
    }

    fn on_boundary(pts: &[Pt], p: Pt) -> bool {
        let n = pts.len();
        (0..n).any(|i| seg_near(p, pts[i], pts[(i + 1) % n]).1 <= SNAP)
    }

    fn bbox_of(pts: &[Pt]) -> [Pt; 2] {
        if pts.is_empty() {
            return [[0.0, 0.0], [0.0, 0.0]];
        }
        let mut lo = pts[0];
        let mut hi = pts[0];
        for p in pts.iter() {
            lo = [lo[0].min(p[0]), lo[1].min(p[1])];
            hi = [hi[0].max(p[0]), hi[1].max(p[1])];
        }
        [lo, hi]
    }

    fn json_pt(p: Pt) -> Json {
        Json::from(vec![p[0], p[1]])
    }

    /// A closed outline: the last point joins the first. Counter-clockwise has positive area.
    #[derive(Clone, Debug, PartialEq, Default)]
    pub struct Poly {
        /// The corners in order.
        pub pts: Vec<Pt>,
    }

    impl From<Vec<Pt>> for Poly {
        fn from(pts: Vec<Pt>) -> Poly {
            Poly::new(pts)
        }
    }

    impl Poly {
        /// The outline through `pts`; a last point equal to the first is dropped.
        pub fn new(pts: Vec<Pt>) -> Poly {
            let mut pts = pts;
            while pts.len() > 1 && dist(pts[0], pts[pts.len() - 1]) <= SNAP {
                pts.pop();
            }
            Poly { pts }
        }

        /// Signed area in mm²: positive when counter-clockwise.
        pub fn area(&self) -> f64 {
            let n = self.pts.len();
            let mut s = 0.0;
            for i in 0..n {
                s += cross(self.pts[i], self.pts[(i + 1) % n]);
            }
            s * 0.5
        }

        /// Length of the closed outline in mm.
        pub fn perimeter(&self) -> f64 {
            let n = self.pts.len();
            (0..n).map(|i| dist(self.pts[i], self.pts[(i + 1) % n])).fold(0.0, |s, d| s + d)
        }

        /// The centre of the enclosed area (the mean of the points when there is no area).
        pub fn centroid(&self) -> Pt {
            let n = self.pts.len();
            if n == 0 {
                return [0.0, 0.0];
            }
            let a = self.area();
            if a.abs() < 1e-12 {
                let s = self.pts.iter().fold([0.0, 0.0], |acc, p| add(acc, *p));
                return mul(s, 1.0 / n as f64);
            }
            let mut c = [0.0, 0.0];
            for i in 0..n {
                let p = self.pts[i];
                let q = self.pts[(i + 1) % n];
                let k = cross(p, q);
                c = add(c, mul(add(p, q), k));
            }
            mul(c, 1.0 / (6.0 * a))
        }

        /// `[min, max]` corners of the bounding box.
        pub fn bbox(&self) -> [Pt; 2] {
            bbox_of(&self.pts)
        }

        /// True when every corner turns the same way and the outline goes round once.
        pub fn is_convex(&self) -> bool {
            let n = self.pts.len();
            if n < 3 {
                return false;
            }
            let mut sign = 0.0;
            let mut total = 0.0;
            for i in 0..n {
                let d1 = sub(self.pts[i], self.pts[(i + n - 1) % n]);
                let d2 = sub(self.pts[(i + 1) % n], self.pts[i]);
                let c = cross(d1, d2);
                total += atan2(c, dot(d1, d2));
                if c.abs() > 1e-12 * len(d1) * len(d2) {
                    if sign == 0.0 {
                        sign = c.signum();
                    } else if c.signum() != sign {
                        return false;
                    }
                }
            }
            (total.abs() - 2.0 * PI).abs() < 1e-6
        }

        /// True when `p` is inside or on the outline (non-zero winding).
        pub fn contains(&self, p: Pt) -> bool {
            on_boundary(&self.pts, p) || winding(&self.pts, p) != 0
        }

        /// The same outline the other way round.
        pub fn reversed(&self) -> Poly {
            let mut pts = self.pts.clone();
            pts.reverse();
            Poly { pts }
        }

        /// Moved by `[dx, dy]`.
        pub fn translate(&self, dx: f64, dy: f64) -> Poly {
            Poly { pts: self.pts.iter().map(|p| [p[0] + dx, p[1] + dy]).collect() }
        }

        /// Turned by `deg` (counter-clockwise) about `about`.
        pub fn rotate(&self, deg: f64, about: Pt) -> Poly {
            Poly { pts: self.pts.iter().map(|p| add(about, turn(sub(*p, about), deg))).collect() }
        }

        /// Without points closer than `tol` to the one before, without points within `tol`
        /// of the line through their neighbours, and empty when the outline is a sliver
        /// (thinner than `tol` on average: 2 × area / perimeter < `tol`).
        pub fn clean(&self, tol: f64) -> Poly {
            let mut pts: Vec<Pt> = Vec::new();
            for p in self.pts.iter() {
                if let Some(q) = pts.last() {
                    if dist(*p, *q) <= tol {
                        continue;
                    }
                }
                pts.push(*p);
            }
            while pts.len() > 1 && dist(pts[0], pts[pts.len() - 1]) <= tol {
                pts.pop();
            }
            let mut changed = true;
            while changed && pts.len() >= 3 {
                changed = false;
                let mut i = 0;
                while i < pts.len() && pts.len() >= 3 {
                    let n = pts.len();
                    let a = pts[(i + n - 1) % n];
                    let b = pts[i];
                    let c = pts[(i + 1) % n];
                    let ac = len(sub(c, a));
                    let off = if ac <= tol { 0.0 } else { cross(sub(c, a), sub(b, a)).abs() / ac };
                    if off <= tol {
                        pts.remove(i);
                        changed = true;
                    } else {
                        i += 1;
                    }
                }
            }
            let out = Poly { pts };
            if out.pts.len() < 3 || 2.0 * out.area().abs() < tol * out.perimeter() {
                return Poly::default();
            }
            out
        }

        /// This outline as a region (a self-crossing outline keeps what it winds round).
        pub fn region(&self) -> Region {
            Region::from_poly(self)
        }

        /// Every corner rounded with radius `r`, shrunk where an edge is too short (see `round_corners_with`).
        pub fn round_corners(&self, r: f64) -> Profile {
            self.round_corners_with(r, 1.0, 0.0)
        }

        /// Every corner rounded with radius `r`. A corner may use at most `max_share` of each
        /// edge beside it, and two corners never use more than the whole edge between them;
        /// the radius shrinks to fit (`Corner::Reduced`). A corner whose radius would be under
        /// `min_r`, or a straight one, stays sharp.
        pub fn round_corners_with(&self, r: f64, max_share: f64, min_r: f64) -> Profile {
            let radii = vec![r; self.pts.len()];
            let (path, corners) = corner_path(self, &radii, max_share, min_r, false);
            Profile { paths: vec![path], corners: vec![corners] }
        }

        /// Every corner cut back `d` mm along both edges, shortened where an edge is too short.
        pub fn chamfer_corners(&self, d: f64) -> Profile {
            let radii = vec![d; self.pts.len()];
            let (path, corners) = corner_path(self, &radii, 1.0, 0.0, true);
            Profile { paths: vec![path], corners: vec![corners] }
        }

        /// One loop for `extrude.loops`: `{start, segments: [{kind:"line", to}, ...]}`.
        pub fn to_loop(&self) -> Json {
            let n = self.pts.len();
            if n == 0 {
                return Json::obj().set("start", json_pt([0.0, 0.0])).set("segments", Vec::<Json>::new());
            }
            let mut segs: Vec<Json> = Vec::new();
            for k in 1..=n {
                segs.push(Json::obj().set("kind", "line").set("to", json_pt(self.pts[k % n])));
            }
            Json::obj().set("start", json_pt(self.pts[0])).set("segments", segs)
        }
    }

    /// A `w` × `h` rectangle centred on the origin, counter-clockwise from the corner at (−w/2, −h/2).
    pub fn rect(w: f64, h: f64) -> Poly {
        let (x, y) = (w / 2.0, h / 2.0);
        Poly { pts: vec![[-x, -y], [x, -y], [x, y], [-x, y]] }
    }

    /// `rect(w, h)` with every corner rounded with radius `r`.
    pub fn rounded_rect(w: f64, h: f64, r: f64) -> Profile {
        rect(w, h).round_corners(r)
    }

    /// A circle of radius `r` around the origin as `segments` straight edges, the first point on +X.
    pub fn circle(r: f64, segments: u32) -> Poly {
        let n = segments.max(3);
        Poly { pts: (0..n).map(|k| { let (s, c) = sin_cos_deg(360.0 * k as f64 / n as f64); [r * c, r * s] }).collect() }
    }

    /// How big a regular polygon is.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Size {
        /// The length of one side.
        Side(f64),
        /// Twice the distance from the centre to a side (across the flats, for an even count).
        Across(f64),
        /// Twice the distance from the centre to a corner (across the corners).
        Corners(f64),
    }

    /// A regular polygon around `centre`, its first corner at `rot_deg` from +X, counter-clockwise.
    pub fn regular(sides: u32, size: Size, centre: Pt, rot_deg: f64) -> Poly {
        let n = sides.max(3);
        let (sin_half, cos_half) = sin_cos_deg(180.0 / n as f64);
        let r = match size {
            Size::Side(s) => {
                if n == 6 { s } else { s / (2.0 * sin_half) }
            }
            Size::Across(a) => a / 2.0 / cos_half,
            Size::Corners(c) => c / 2.0,
        };
        let step = 360.0 / n as f64;
        let pts = (0..n)
            .map(|k| {
                let (s, c) = sin_cos_deg(rot_deg + step * k as f64);
                [centre[0] + r * c, centre[1] + r * s]
            })
            .collect();
        Poly { pts }
    }

    /// One piece of a `Path`: a line to a point, or an arc through a point to a point.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Seg {
        /// `Line(to)`.
        Line(Pt),
        /// `Arc(through, to)`.
        Arc(Pt, Pt),
    }

    /// A closed loop of lines and arcs from `start` back to `start`.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Path {
        /// Where the loop starts and ends.
        pub start: Pt,
        /// The pieces in order, the last ending at `start`.
        pub segs: Vec<Seg>,
    }

    /// Centre, radius, start angle and signed sweep of the arc from `p0` through `pm` to `p1`.
    fn arc_of(p0: Pt, pm: Pt, p1: Pt) -> Option<(Pt, f64, f64, f64)> {
        let b = sub(pm, p0);
        let c = sub(p1, p0);
        let dd = 2.0 * cross(b, c);
        if dd.abs() < 1e-15 {
            return None;
        }
        let u = [(c[1] * dot(b, b) - b[1] * dot(c, c)) / dd, (b[0] * dot(c, c) - c[0] * dot(b, b)) / dd];
        let centre = add(p0, u);
        let r = len(u);
        let a0 = atan2(p0[1] - centre[1], p0[0] - centre[0]);
        let a1 = atan2(p1[1] - centre[1], p1[0] - centre[0]);
        let tau = 2.0 * PI;
        let wrap = |x: f64| x - (x / tau).floor() * tau;
        let sweep = if dd > 0.0 { wrap(a1 - a0) } else { -wrap(a0 - a1) };
        Some((centre, r, a0, sweep))
    }

    impl Path {
        /// The loop for `extrude.loops`: `{start, segments}` with `line` and `arc` segments.
        pub fn to_loop(&self) -> Json {
            let mut segs: Vec<Json> = Vec::new();
            for s in self.segs.iter() {
                match s {
                    Seg::Line(to) => segs.push(Json::obj().set("kind", "line").set("to", json_pt(*to))),
                    Seg::Arc(through, to) => {
                        segs.push(Json::obj().set("kind", "arc").set("through", json_pt(*through)).set("to", json_pt(*to)))
                    }
                }
            }
            Json::obj().set("start", json_pt(self.start)).set("segments", segs)
        }

        /// The loop as straight edges: each arc split so no chord strays more than `tol` mm from it.
        pub fn to_poly(&self, tol: f64) -> Poly {
            let mut pts = vec![self.start];
            let mut at = self.start;
            for s in self.segs.iter() {
                match *s {
                    Seg::Line(to) => {
                        pts.push(to);
                        at = to;
                    }
                    Seg::Arc(through, to) => {
                        if let Some((c, r, a0, sweep)) = arc_of(at, through, to) {
                            let step = if tol > 0.0 && tol < r {
                                let z = (tol / (2.0 * r)).sqrt();
                                4.0 * atan2(z, (1.0 - z * z).sqrt())
                            } else {
                                PI / 2.0
                            };
                            let n = ((sweep.abs() / step).ceil() as usize).max(1);
                            for k in 1..n {
                                let a = a0 + sweep * k as f64 / n as f64;
                                let (sa, ca) = sin_cos(a);
                                pts.push([c[0] + r * ca, c[1] + r * sa]);
                            }
                        }
                        pts.push(to);
                        at = to;
                    }
                }
            }
            Poly::new(pts)
        }

        /// Signed area in mm², arcs counted exactly.
        pub fn area(&self) -> f64 {
            let mut s = 0.0;
            let mut at = self.start;
            for seg in self.segs.iter() {
                let to = match *seg {
                    Seg::Line(to) => to,
                    Seg::Arc(through, to) => {
                        if let Some((_, r, _, sweep)) = arc_of(at, through, to) {
                            s += r * r * (sweep - sin_cos(sweep).0);
                        }
                        to
                    }
                };
                s += cross(at, to);
                at = to;
            }
            s * 0.5
        }
    }

    /// What became of one corner when rounding or chamfering.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Corner {
        /// The size asked for.
        Full,
        /// A smaller size (the radius or the cut-back that fitted).
        Reduced(f64),
        /// Left sharp: not asked for, straight, or the fitted size was under the minimum.
        Sharp,
    }

    /// Loops of lines and arcs, outlines counter-clockwise and holes clockwise, each outline
    /// followed by its holes; `corners` reports each loop's corners in point order.
    #[derive(Clone, Debug, PartialEq, Default)]
    pub struct Profile {
        /// The loops.
        pub paths: Vec<Path>,
        /// What became of each corner, one list per loop.
        pub corners: Vec<Vec<Corner>>,
    }

    impl Profile {
        /// The first loop, for an `extrude` of one outline with no holes.
        pub fn to_loop(&self) -> Json {
            match self.paths.first() {
                Some(p) => p.to_loop(),
                None => Poly::default().to_loop(),
            }
        }

        /// One `loops` array per separate piece: its outline first, then its holes.
        pub fn to_loops(&self) -> Vec<Json> {
            let mut out: Vec<Json> = Vec::new();
            let mut cur: Vec<Json> = Vec::new();
            for p in self.paths.iter() {
                if p.area() > 0.0 && !cur.is_empty() {
                    out.push(Json::Arr(cur));
                    cur = Vec::new();
                }
                cur.push(p.to_loop());
            }
            if !cur.is_empty() {
                out.push(Json::Arr(cur));
            }
            out
        }

        /// The area in mm², arcs counted exactly.
        pub fn area(&self) -> f64 {
            self.paths.iter().map(|p| p.area()).fold(0.0, |s, a| s + a)
        }

        /// As a region of straight edges, arcs split to `tol` mm, for more booleans.
        pub fn to_region(&self, tol: f64) -> Region {
            let polys: Vec<Poly> = self.paths.iter().map(|p| p.to_poly(tol)).collect();
            resolve(&polys, &[], Fill::Positive)
        }

        /// How many corners came out `[full, reduced, sharp]`.
        pub fn counts(&self) -> [usize; 3] {
            let mut c = [0, 0, 0];
            for loop_corners in self.corners.iter() {
                for k in loop_corners.iter() {
                    match k {
                        Corner::Full => c[0] += 1,
                        Corner::Reduced(_) => c[1] += 1,
                        Corner::Sharp => c[2] += 1,
                    }
                }
            }
            c
        }
    }

    /// Rounds (or chamfers) each corner `i` of `poly` with `radii[i]` (0 leaves it sharp).
    fn corner_path(poly: &Poly, radii: &[f64], max_share: f64, min_r: f64, chamfer: bool) -> (Path, Vec<Corner>) {
        let n = poly.pts.len();
        if n < 3 {
            let start = poly.pts.first().copied().unwrap_or([0.0, 0.0]);
            let segs = poly.pts.iter().skip(1).map(|p| Seg::Line(*p)).collect();
            return (Path { start, segs }, vec![Corner::Sharp; n]);
        }
        let mut rr: Vec<f64> = vec![0.0; n];
        let mut tl: Vec<f64> = vec![0.0; n];
        let mut tan_half: Vec<f64> = vec![0.0; n];
        let mut bis: Vec<Pt> = vec![[0.0, 0.0]; n];
        let mut sin_half: Vec<f64> = vec![0.0; n];
        for i in 0..n {
            let v = poly.pts[i];
            let pv = poly.pts[(i + n - 1) % n];
            let nx = poly.pts[(i + 1) % n];
            let e1 = len(sub(pv, v));
            let e2 = len(sub(nx, v));
            let u1 = norm(sub(pv, v));
            let u2 = norm(sub(nx, v));
            let c = clamp(dot(u1, u2), -1.0, 1.0);
            let s = cross(u1, u2).abs();
            bis[i] = norm(add(u1, u2));
            let r = radii[i];
            if r <= 0.0 || s < 1e-9 {
                continue;
            }
            if c >= 0.0 {
                tan_half[i] = s / (1.0 + c);
                sin_half[i] = s / (2.0 * ((1.0 + c) / 2.0).sqrt());
            } else {
                tan_half[i] = (1.0 - c) / s;
                sin_half[i] = ((1.0 - c) / 2.0).sqrt();
            }
            let room = max_share * e1.min(e2);
            if chamfer {
                rr[i] = r.min(room);
                tl[i] = rr[i];
            } else {
                rr[i] = r.min(room * tan_half[i]);
                tl[i] = rr[i] / tan_half[i];
            }
        }
        let mut fit = vec![1.0; n];
        for i in 0..n {
            let j = (i + 1) % n;
            let l = len(sub(poly.pts[j], poly.pts[i]));
            let need = tl[i] + tl[j];
            if need > l && need > 0.0 {
                let f = l / need;
                fit[i] = f64::min(fit[i], f);
                fit[j] = f64::min(fit[j], f);
            }
        }
        let mut ins: Vec<Pt> = Vec::new();
        let mut outs: Vec<Pt> = Vec::new();
        let mut mids: Vec<Option<Pt>> = Vec::new();
        let mut corners: Vec<Corner> = Vec::new();
        for i in 0..n {
            let v = poly.pts[i];
            if fit[i] < 1.0 {
                rr[i] *= fit[i];
                tl[i] *= fit[i];
            }
            if tl[i] <= 0.0 || rr[i] < min_r || rr[i] < 1e-9 {
                ins.push(v);
                outs.push(v);
                mids.push(None);
                corners.push(Corner::Sharp);
                continue;
            }
            let u1 = norm(sub(poly.pts[(i + n - 1) % n], v));
            let u2 = norm(sub(poly.pts[(i + 1) % n], v));
            let d = if chamfer { rr[i] } else { rr[i] / tan_half[i] };
            ins.push(add(v, mul(u1, d)));
            outs.push(add(v, mul(u2, d)));
            if chamfer {
                mids.push(None);
            } else {
                mids.push(Some(add(v, mul(bis[i], rr[i] / sin_half[i] - rr[i]))));
            }
            corners.push(if rr[i] >= radii[i] * (1.0 - 1e-9) { Corner::Full } else { Corner::Reduced(rr[i]) });
        }
        let mut segs: Vec<Seg> = Vec::new();
        for k in 1..=n {
            let i = k % n;
            segs.push(Seg::Line(ins[i]));
            match mids[i] {
                Some(m) => segs.push(Seg::Arc(m, outs[i])),
                None => {
                    if dist(ins[i], outs[i]) > 0.0 {
                        segs.push(Seg::Line(outs[i]));
                    }
                }
            }
        }
        (Path { start: outs[0], segs }, corners)
    }

    /// A 2D area: outlines with holes. Outlines run counter-clockwise, holes clockwise, and
    /// each outline comes before its holes. Build one with `from_poly`, `with_holes`,
    /// `from_loops`, or a boolean.
    #[derive(Clone, Debug, PartialEq, Default)]
    pub struct Region {
        loops: Vec<Poly>,
    }

    impl From<Poly> for Region {
        fn from(p: Poly) -> Region {
            Region::from_poly(&p)
        }
    }

    impl Region {
        pub(crate) fn from_native_loops(loops: Vec<Poly>) -> Region { Region { loops } }
        /// No area.
        pub fn empty() -> Region {
            Region { loops: Vec::new() }
        }

        /// The area an outline winds round, in either direction.
        pub fn from_poly(p: &Poly) -> Region {
            let p = if p.area() < 0.0 { p.reversed() } else { p.clone() };
            resolve(&[p], &[], Fill::NonZero)
        }

        /// `outer` with `holes` taken out (either direction for each).
        pub fn with_holes(outer: &Poly, holes: &[Poly]) -> Region {
            let mut loops = vec![if outer.area() < 0.0 { outer.reversed() } else { outer.clone() }];
            for h in holes.iter() {
                loops.push(if h.area() > 0.0 { h.reversed() } else { h.clone() });
            }
            resolve(&loops, &[], Fill::Positive)
        }

        /// Loops nested any way, in any direction: inside an odd number of them is material.
        pub fn from_loops(loops: &[Poly]) -> Region {
            resolve(loops, &[], Fill::EvenOdd)
        }

        /// The loops: each outline (counter-clockwise) followed by its holes (clockwise).
        pub fn loops(&self) -> &Vec<Poly> {
            &self.loops
        }

        /// True when there is no area.
        pub fn is_empty(&self) -> bool {
            self.loops.is_empty()
        }

        /// The separate pieces, each one outline with its holes.
        pub fn pieces(&self) -> Vec<Region> {
            let mut out: Vec<Region> = Vec::new();
            for l in self.loops.iter() {
                if l.area() > 0.0 || out.is_empty() {
                    out.push(Region { loops: vec![l.clone()] });
                } else if let Some(last) = out.last_mut() {
                    last.loops.push(l.clone());
                }
            }
            out
        }

        /// Net area in mm² (holes taken off).
        pub fn area(&self) -> f64 {
            self.loops.iter().map(|l| l.area()).fold(0.0, |s, a| s + a)
        }

        /// Length of every outline and hole in mm.
        pub fn perimeter(&self) -> f64 {
            self.loops.iter().map(|l| l.perimeter()).fold(0.0, |s, p| s + p)
        }

        /// The centre of the area.
        pub fn centroid(&self) -> Pt {
            let a = self.area();
            if a.abs() < 1e-12 {
                return self.loops.first().map(|l| l.centroid()).unwrap_or([0.0, 0.0]);
            }
            let mut c = [0.0, 0.0];
            for l in self.loops.iter() {
                c = add(c, mul(l.centroid(), l.area()));
            }
            mul(c, 1.0 / a)
        }

        /// `[min, max]` corners of the bounding box.
        pub fn bbox(&self) -> [Pt; 2] {
            let pts: Vec<Pt> = self.loops.iter().flat_map(|l| l.pts.iter().copied()).collect();
            bbox_of(&pts)
        }

        /// True when `p` is in the material or on its edge.
        pub fn contains(&self, p: Pt) -> bool {
            if self.loops.iter().any(|l| on_boundary(&l.pts, p)) {
                return true;
            }
            self.loops.iter().map(|l| winding(&l.pts, p)).sum::<i32>() != 0
        }

        /// Material in either.
        pub fn union(&self, other: &Region) -> Region {
            resolve(&self.loops, &other.loops, Fill::Union)
        }

        /// Material in any of the regions, resolved in one boolean pass.
        pub fn union_all(regions: &[Region]) -> Region {
            let loops: Vec<Poly> = regions.iter().flat_map(|region| region.loops.iter().cloned()).collect();
            resolve(&loops, &[], Fill::Positive)
        }

        /// Material in any of the polygons (either direction for each), resolved in one boolean pass.
        pub fn union_polys(polys: &[Poly]) -> Region {
            if polys.is_empty() {
                return Region::empty();
            }
            let oriented: Vec<Poly> = polys
                .iter()
                .map(|p| if p.area() < 0.0 { p.reversed() } else { p.clone() })
                .collect();
            resolve(&oriented, &[], Fill::Positive)
        }

        /// Material in both.
        pub fn intersect(&self, other: &Region) -> Region {
            resolve(&self.loops, &other.loops, Fill::Intersect)
        }

        /// Material in this and not in `other`.
        pub fn difference(&self, other: &Region) -> Region {
            resolve(&self.loops, &other.loops, Fill::Difference)
        }

        /// Material in this region with every cutter removed, resolved in one boolean pass.
        pub fn difference_all(&self, others: &[Region]) -> Region {
            let loops: Vec<Poly> = others.iter().flat_map(|region| region.loops.iter().cloned()).collect();
            resolve(&self.loops, &loops, Fill::Difference)
        }

        /// Material in exactly one of the two.
        pub fn xor(&self, other: &Region) -> Region {
            resolve(&self.loops, &other.loops, Fill::Xor)
        }

        /// The material inside `shape`: the same as `intersect` with `shape`'s region, and much faster
        /// when `shape` is small against this region (a cell against a whole floor).
        pub fn clip(&self, shape: &Poly) -> Region {
            let b = shape.bbox();
            let lo = [b[0][0] - 1.0, b[0][1] - 1.0];
            let hi = [b[1][0] + 1.0, b[1][1] + 1.0];
            let near: Vec<Poly> = self.loops.iter().map(|l| window(l, lo, hi)).filter(|l| l.pts.len() >= 3).collect();
            let shape = if shape.area() < 0.0 { shape.reversed() } else { shape.clone() };
            resolve(&[shape], &near, Fill::Intersect)
        }

        /// Grown by `d` mm (shrunk when negative), the way a sketch offset does it:
        /// - an outside corner (convex in the offset direction) is rounded with radius |d|,
        ///   its centre on the original corner;
        /// - an inside corner stays sharp;
        /// - a corner whose edges are too short for that radius gets a smaller one
        ///   (`Corner::Reduced`), never a refusal.
        ///
        /// Outside corners closer together than 2|d| merge before they are rounded, so a narrow
        /// gap closes straight. A shape thinner than 2|d| disappears when shrunk.
        /// `offset_miter` keeps every corner sharp and stays a `Region`.
        pub fn offset(&self, d: f64) -> Profile {
            let grown = self.offset_miter(d);
            let mut out = Profile::default();
            for l in grown.loops.iter() {
                let n = l.pts.len();
                let radii: Vec<f64> = (0..n)
                    .map(|i| {
                        let c = cross(sub(l.pts[i], l.pts[(i + n - 1) % n]), sub(l.pts[(i + 1) % n], l.pts[i]));
                        if (d > 0.0 && c > 0.0) || (d < 0.0 && c < 0.0) { d.abs() } else { 0.0 }
                    })
                    .collect();
                let (path, corners) = corner_path(l, &radii, 1.0, 0.0, false);
                out.paths.push(path);
                out.corners.push(corners);
            }
            out
        }

        /// Grown by `d` mm (shrunk when negative) with every corner sharp: an outside corner
        /// is mitred (cut square when sharper than about 2°), an inside corner stays sharp.
        pub fn offset_miter(&self, d: f64) -> Region {
            if d == 0.0 || self.loops.is_empty() {
                return self.clone();
            }
            let raw: Vec<Poly> = self.loops.iter().map(|l| offset_loop(l, d)).collect();
            resolve(&raw, &[], Fill::Positive)
        }

        /// Every loop cleaned (`Poly::clean`); loops that become slivers are dropped.
        pub fn clean(&self, tol: f64) -> Region {
            let loops: Vec<Poly> = self.loops.iter().map(|l| l.clean(tol)).filter(|l| l.pts.len() >= 3).collect();
            resolve(&loops, &[], Fill::Positive)
        }

        /// Without the pieces whose area is under `min_area` mm².
        pub fn without_small(&self, min_area: f64) -> Region {
            let mut loops: Vec<Poly> = Vec::new();
            for p in self.pieces() {
                if p.area() >= min_area {
                    loops.extend(p.loops);
                }
            }
            Region { loops }
        }

        /// Every corner rounded with radius `r` (see `Poly::round_corners_with`).
        pub fn round_corners(&self, r: f64) -> Profile {
            self.round_corners_with(r, 1.0, 0.0)
        }

        /// Every corner rounded; the radius shrinks to fit as in `Poly::round_corners_with`.
        pub fn round_corners_with(&self, r: f64, max_share: f64, min_r: f64) -> Profile {
            let mut out = Profile::default();
            for l in self.loops.iter() {
                let p = l.round_corners_with(r, max_share, min_r);
                out.paths.extend(p.paths);
                out.corners.extend(p.corners);
            }
            out
        }

        /// Every corner cut back `d` mm along both edges.
        pub fn chamfer_corners(&self, d: f64) -> Profile {
            let mut out = Profile::default();
            for l in self.loops.iter() {
                let p = l.chamfer_corners(d);
                out.paths.extend(p.paths);
                out.corners.extend(p.corners);
            }
            out
        }

        /// Moved by `[dx, dy]`.
        pub fn translate(&self, dx: f64, dy: f64) -> Region {
            Region { loops: self.loops.iter().map(|l| l.translate(dx, dy)).collect() }
        }

        /// Turned by `deg` (counter-clockwise) about `about`.
        pub fn rotate(&self, deg: f64, about: Pt) -> Region {
            Region { loops: self.loops.iter().map(|l| l.rotate(deg, about)).collect() }
        }

        /// One `loops` array per separate piece: its outline first, then its holes.
        pub fn to_loops(&self) -> Vec<Json> {
            self.pieces().iter().map(|p| Json::Arr(p.loops.iter().map(|l| l.to_loop()).collect())).collect()
        }
    }

    /// One loop cut to the box `lo`..`hi` edge by edge (Sutherland–Hodgman). The result may run along the
    /// box's sides there and back, but it winds round every point inside the box as the loop does.
    fn window(l: &Poly, lo: Pt, hi: Pt) -> Poly {
        let mut pts = l.pts.clone();
        for side in 0..4 {
            let axis = side % 2;
            let bound = if side < 2 { lo[axis] } else { hi[axis] };
            let inside = |p: Pt| if side < 2 { p[axis] >= bound } else { p[axis] <= bound };
            let n = pts.len();
            let mut out: Vec<Pt> = Vec::new();
            for i in 0..n {
                let cur = pts[i];
                let prev = pts[(i + n - 1) % n];
                if inside(cur) != inside(prev) {
                    let t = (bound - prev[axis]) / (cur[axis] - prev[axis]);
                    let mut x = add(prev, mul(sub(cur, prev), t));
                    x[axis] = bound;
                    out.push(x);
                }
                if inside(cur) {
                    out.push(cur);
                }
            }
            pts = out;
            if pts.is_empty() {
                break;
            }
        }
        Poly { pts }
    }

    /// The raw offset of one loop: mitred outside corners, inside corners through the
    /// original point (the backward bits wind the other way and drop out in `resolve`).
    fn offset_loop(p: &Poly, d: f64) -> Poly {
        let n = p.pts.len();
        let mut out: Vec<Pt> = Vec::new();
        for i in 0..n {
            let v = p.pts[i];
            let d1 = norm(sub(v, p.pts[(i + n - 1) % n]));
            let d2 = norm(sub(p.pts[(i + 1) % n], v));
            let n1 = [d1[1], -d1[0]];
            let n2 = [d2[1], -d2[0]];
            let c = cross(d1, d2);
            if c.abs() < 1e-12 && dot(d1, d2) > 0.0 {
                out.push(add(v, mul(n1, d)));
            } else if c * d > 0.0 {
                let k = 1.0 + dot(n1, n2);
                if k > 1e-3 {
                    out.push(add(v, mul(add(n1, n2), d / k)));
                } else {
                    out.push(add(add(v, mul(n1, d)), mul(d1, d.abs())));
                    out.push(sub(add(v, mul(n2, d)), mul(d2, d.abs())));
                }
            } else {
                out.push(add(v, mul(n1, d)));
                out.push(v);
                out.push(add(v, mul(n2, d)));
            }
        }
        Poly { pts: out }
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Fill {
        Union,
        Intersect,
        Difference,
        Xor,
        NonZero,
        Positive,
        EvenOdd,
    }

    fn filled(f: Fill, a: i32, b: i32) -> bool {
        match f {
            Fill::Union => a != 0 || b != 0,
            Fill::Intersect => a != 0 && b != 0,
            Fill::Difference => a != 0 && b == 0,
            Fill::Xor => (a != 0) != (b != 0),
            Fill::NonZero => a != 0,
            Fill::Positive => a > 0,
            Fill::EvenOdd => a % 2 != 0,
        }
    }

    struct Edge {
        p: Pt,
        q: Pt,
        side: usize,
    }

    struct Group {
        u: usize,
        v: usize,
        net: [i32; 2],
        edges: Vec<usize>,
    }

    /// Points within `SNAP` of each other share one index.
    struct Pool {
        pts: Vec<Pt>,
        grid: HashMap<(i64, i64), Vec<usize>>,
    }

    impl Pool {
        fn id(&mut self, p: Pt) -> usize {
            let kx = (p[0] / SNAP).floor() as i64;
            let ky = (p[1] / SNAP).floor() as i64;
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(list) = self.grid.get(&(kx + dx, ky + dy)) {
                        for &i in list.iter() {
                            if dist(self.pts[i], p) <= SNAP {
                                return i;
                            }
                        }
                    }
                }
            }
            let id = self.pts.len();
            self.pts.push(p);
            self.grid.entry((kx, ky)).or_default().push(id);
            id
        }
    }

    pub(crate) fn loops_json(loops: &[Poly]) -> Json {
        Json::arr(loops.iter().map(|p| Json::arr(p.pts.iter().map(|q| Json::arr(vec![q[0], q[1]])).collect::<Vec<Json>>())).collect::<Vec<Json>>())
    }

    pub(crate) fn loops_from_json(value: &Json) -> Option<Vec<Poly>> {
        let rows = value.as_array()?;
        if rows.len() > 20000 { return None; }
        let mut loops = Vec::new();
        let mut count = 0usize;
        for row in rows {
            let pts = row.as_points2()?;
            count += pts.len();
            if count > 100000 || pts.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) { return None; }
            loops.push(Poly { pts });
        }
        Some(loops)
    }

    pub(crate) fn native_resolve(args: &Json) -> Option<Json> {
        let a = loops_from_json(args.get("a")?)?;
        let b = loops_from_json(args.get("b")?)?;
        if a.iter().chain(b.iter()).map(|p| p.pts.len()).sum::<usize>() > 5000 { return None; }
        let fill = match args.get("fill")?.as_str()? {
            "union" => Fill::Union, "intersect" => Fill::Intersect, "difference" => Fill::Difference,
            "xor" => Fill::Xor, "nonzero" => Fill::NonZero, "positive" => Fill::Positive,
            "evenodd" => Fill::EvenOdd, _ => return None,
        };
        Some(loops_json(&resolve_local(&a, &b, fill).loops))
    }

    /// The boolean of two loop sets under a fill rule: every edge is split where it meets
    /// another, each piece is kept where the rule fills one side and not the other, and the
    /// kept pieces are joined into loops with material on their left.
    fn resolve(a: &[Poly], b: &[Poly], fill: Fill) -> Region {
        if !super::NATIVE_GEOMETRY.load(super::Ordering::Relaxed) || a.iter().chain(b.iter()).map(|p| p.pts.len()).sum::<usize>() < 40 {
            return resolve_local(a, b, fill);
        }
        let kind = match fill { Fill::Union => "union", Fill::Intersect => "intersect", Fill::Difference => "difference", Fill::Xor => "xor", Fill::NonZero => "nonzero", Fill::Positive => "positive", Fill::EvenOdd => "evenodd" };
        let args = Json::obj().set("op", "resolve").set("fill", kind).set("a", loops_json(a)).set("b", loops_json(b));
        if let Some(reply) = super::native_geometry(args) {
            if let Some(loops) = loops_from_json(&reply) { return Region { loops }; }
        }
        resolve_local(a, b, fill)
    }

    fn resolve_local(a: &[Poly], b: &[Poly], fill: Fill) -> Region {
        let mut edges: Vec<Edge> = Vec::new();
        for (side, set) in [a, b].iter().enumerate() {
            for l in set.iter() {
                let n = l.pts.len();
                if n < 3 {
                    continue;
                }
                for i in 0..n {
                    let p = l.pts[i];
                    let q = l.pts[(i + 1) % n];
                    if dist(p, q) > SNAP {
                        edges.push(Edge { p, q, side });
                    }
                }
            }
        }
        let n = edges.len();
        let boxes: Vec<[Pt; 2]> = edges.iter().map(|e| bbox_of(&[e.p, e.q])).collect();
        let mut cuts: Vec<Vec<(f64, Pt)>> = vec![Vec::new(); n];
        // Pairs in order of their boxes' left side, so the scan for each edge stops past its right side.
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|a, b| boxes[*a][0][0].partial_cmp(&boxes[*b][0][0]).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b)));
        for oi in 0..n {
            let i = order[oi];
            for &j in order[oi + 1..].iter() {
                let (bi, bj) = (boxes[i], boxes[j]);
                if bj[0][0] > bi[1][0] + SNAP {
                    break;
                }
                if bi[0][0] > bj[1][0] + SNAP || bi[0][1] > bj[1][1] + SNAP || bj[0][1] > bi[1][1] + SNAP {
                    continue;
                }
                let (p, q, r, s) = (edges[i].p, edges[i].q, edges[j].p, edges[j].q);
                for x in [r, s] {
                    let (t, d) = seg_near(x, p, q);
                    if d <= SNAP && dist(x, p) > SNAP && dist(x, q) > SNAP {
                        cuts[i].push((t, x));
                    }
                }
                for x in [p, q] {
                    let (t, d) = seg_near(x, r, s);
                    if d <= SNAP && dist(x, r) > SNAP && dist(x, s) > SNAP {
                        cuts[j].push((t, x));
                    }
                }
                let d1 = sub(q, p);
                let d2 = sub(s, r);
                let den = cross(d1, d2);
                if den.abs() > 1e-12 * len(d1) * len(d2) {
                    let t = cross(sub(r, p), d2) / den;
                    let u = cross(sub(r, p), d1) / den;
                    if t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0 {
                        let x = add(p, mul(d1, t));
                        if dist(x, p) > SNAP && dist(x, q) > SNAP && dist(x, r) > SNAP && dist(x, s) > SNAP {
                            cuts[i].push((t, x));
                            cuts[j].push((u, x));
                        }
                    }
                }
            }
        }
        let mut pool = Pool { pts: Vec::new(), grid: HashMap::new() };
        let mut groups: Vec<Group> = Vec::new();
        let mut group_of: HashMap<(usize, usize), usize> = HashMap::new();
        for (i, e) in edges.iter().enumerate() {
            let mut c = cuts[i].clone();
            c.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut ids = vec![pool.id(e.p)];
            for (_, x) in c.iter() {
                ids.push(pool.id(*x));
            }
            ids.push(pool.id(e.q));
            for k in 0..ids.len() - 1 {
                let (u, v) = (ids[k], ids[k + 1]);
                if u == v {
                    continue;
                }
                let key = (u.min(v), u.max(v));
                let g = match group_of.get(&key) {
                    Some(g) => *g,
                    None => {
                        groups.push(Group { u: key.0, v: key.1, net: [0, 0], edges: Vec::new() });
                        group_of.insert(key, groups.len() - 1);
                        groups.len() - 1
                    }
                };
                groups[g].net[e.side] += if u < v { 1 } else { -1 };
                groups[g].edges.push(i);
            }
        }
        fn bin_of(v: f64, lo: f64, inv: f64, nbins: usize) -> usize {
            let i = ((v - lo) * inv).floor() as i64;
            if i <= 0 {
                0
            } else if (i as usize) >= nbins {
                nbins - 1
            } else {
                i as usize
            }
        }
        let use_slabs = n >= 32;
        let nbins = if use_slabs {
            clamp((n as f64).sqrt().ceil(), 8.0, 256.0) as usize
        } else {
            0
        };
        let mut min_x = 0.0;
        let mut min_y = 0.0;
        let mut inv_x = 0.0;
        let mut inv_y = 0.0;
        let mut x_bins: Vec<Vec<usize>> = Vec::new();
        let mut y_bins: Vec<Vec<usize>> = Vec::new();
        let mut x_long: Vec<usize> = Vec::new();
        let mut y_long: Vec<usize> = Vec::new();
        if use_slabs {
            min_x = boxes[0][0][0];
            let mut max_x = boxes[0][1][0];
            min_y = boxes[0][0][1];
            let mut max_y = boxes[0][1][1];
            for b in boxes.iter().skip(1) {
                if b[0][0] < min_x { min_x = b[0][0]; }
                if b[1][0] > max_x { max_x = b[1][0]; }
                if b[0][1] < min_y { min_y = b[0][1]; }
                if b[1][1] > max_y { max_y = b[1][1]; }
            }
            let span_x = max_x - min_x;
            let span_y = max_y - min_y;
            if span_x > SNAP {
                inv_x = nbins as f64 / span_x;
                x_bins = vec![Vec::new(); nbins];
            }
            if span_y > SNAP {
                inv_y = nbins as f64 / span_y;
                y_bins = vec![Vec::new(); nbins];
            }
            for (k, b) in boxes.iter().enumerate() {
                if !x_bins.is_empty() {
                    let lo = bin_of(b[0][0], min_x, inv_x, nbins);
                    let hi = bin_of(b[1][0], min_x, inv_x, nbins);
                    if hi - lo > 8 {
                        x_long.push(k);
                    } else {
                        for bin in x_bins[lo..=hi].iter_mut() {
                            bin.push(k);
                        }
                    }
                } else {
                    x_long.push(k);
                }
                if !y_bins.is_empty() {
                    let lo = bin_of(b[0][1], min_y, inv_y, nbins);
                    let hi = bin_of(b[1][1], min_y, inv_y, nbins);
                    if hi - lo > 8 {
                        y_long.push(k);
                    } else {
                        for bin in y_bins[lo..=hi].iter_mut() {
                            bin.push(k);
                        }
                    }
                } else {
                    y_long.push(k);
                }
            }
        }
        let mut kept: Vec<(usize, usize)> = Vec::new();
        for g in groups.iter() {
            // Winding just left of the piece: an axis-aligned ray from its middle into its left
            // half-plane, counting the edges it crosses (half-open, so a ray through a corner counts
            // once). Right = left - net.
            let (pu, pv) = (pool.pts[g.u], pool.pts[g.v]);
            let m = mul(add(pu, pv), 0.5);
            let d = norm(sub(pv, pu));
            let n_vec = [-d[1], d[0]];
            let horiz = n_vec[0].abs() >= n_vec[1].abs();
            let s = if horiz {
                if n_vec[0] >= 0.0 { 1.0 } else { -1.0 }
            } else if n_vec[1] >= 0.0 {
                1.0
            } else {
                -1.0
            };
            let mut left = [0i32; 2];
            let mut test_edge = |k: usize| {
                if g.edges.contains(&k) {
                    return;
                }
                let e = &edges[k];
                if horiz {
                    if (s > 0.0 && boxes[k][1][0] <= m[0]) || (s < 0.0 && boxes[k][0][0] >= m[0]) {
                        return;
                    }
                    let sa = s * (e.p[1] - m[1]);
                    let sb = s * (e.q[1] - m[1]);
                    let up = sa <= 0.0 && sb > 0.0;
                    let down = sb <= 0.0 && sa > 0.0;
                    if !up && !down {
                        return;
                    }
                    let ta = s * (e.p[0] - m[0]);
                    let tb = s * (e.q[0] - m[0]);
                    if ta + (tb - ta) * (-sa / (sb - sa)) > 0.0 {
                        left[e.side] += if up { 1 } else { -1 };
                    }
                } else {
                    if (s > 0.0 && boxes[k][1][1] <= m[1]) || (s < 0.0 && boxes[k][0][1] >= m[1]) {
                        return;
                    }
                    let sa = -s * (e.p[0] - m[0]);
                    let sb = -s * (e.q[0] - m[0]);
                    let up = sa <= 0.0 && sb > 0.0;
                    let down = sb <= 0.0 && sa > 0.0;
                    if !up && !down {
                        return;
                    }
                    let ta = s * (e.p[1] - m[1]);
                    let tb = s * (e.q[1] - m[1]);
                    if ta + (tb - ta) * (-sa / (sb - sa)) > 0.0 {
                        left[e.side] += if up { 1 } else { -1 };
                    }
                }
            };
            if !use_slabs {
                for k in 0..n {
                    test_edge(k);
                }
            } else if horiz {
                if !y_bins.is_empty() {
                    let b = bin_of(m[1], min_y, inv_y, nbins);
                    for &k in y_bins[b].iter() {
                        test_edge(k);
                    }
                }
                for &k in y_long.iter() {
                    test_edge(k);
                }
            } else {
                if !x_bins.is_empty() {
                    let b = bin_of(m[0], min_x, inv_x, nbins);
                    for &k in x_bins[b].iter() {
                        test_edge(k);
                    }
                }
                for &k in x_long.iter() {
                    test_edge(k);
                }
            }
            let right = [left[0] - g.net[0], left[1] - g.net[1]];
            let l = filled(fill, left[0], left[1]);
            let r = filled(fill, right[0], right[1]);
            if l && !r {
                kept.push((g.u, g.v));
            } else if r && !l {
                kept.push((g.v, g.u));
            }
        }
        let mut from: Vec<Vec<usize>> = vec![Vec::new(); pool.pts.len()];
        for (k, e) in kept.iter().enumerate() {
            from[e.0].push(k);
        }
        let mut used = vec![false; kept.len()];
        let mut cycles: Vec<Vec<usize>> = Vec::new();
        // Where each point sits on the walk being followed, so a walk that comes back to one of its
        // points splits that cycle off: every loop comes out simple, touching others only at points.
        let mut on_walk: Vec<usize> = vec![usize::MAX; pool.pts.len()];
        for k0 in 0..kept.len() {
            if used[k0] {
                continue;
            }
            used[k0] = true;
            let start = kept[k0].0;
            let mut ids = vec![start];
            on_walk[start] = 0;
            let mut k = k0;
            loop {
                let cur = kept[k].1;
                if on_walk[cur] != usize::MAX {
                    let j = on_walk[cur];
                    let cycle: Vec<usize> = ids[j..].to_vec();
                    for &i in cycle.iter() {
                        on_walk[i] = usize::MAX;
                    }
                    cycles.push(cycle);
                    ids.truncate(j);
                    if ids.is_empty() {
                        break;
                    }
                    on_walk[cur] = usize::MAX;
                }
                on_walk[cur] = ids.len();
                ids.push(cur);
                let din = sub(pool.pts[cur], pool.pts[kept[k].0]);
                let mut best: Option<usize> = None;
                let mut best_turn = -10.0;
                for &c in from[cur].iter() {
                    if used[c] {
                        continue;
                    }
                    let dout = sub(pool.pts[kept[c].1], pool.pts[cur]);
                    let t = if kept[c].1 == kept[k].0 { -5.0 } else { atan2(cross(din, dout), dot(din, dout)) };
                    if t > best_turn {
                        best_turn = t;
                        best = Some(c);
                    }
                }
                match best {
                    Some(c) => {
                        used[c] = true;
                        k = c;
                    }
                    None => break,
                }
            }
            for &i in ids.iter() {
                on_walk[i] = usize::MAX;
            }
        }
        let mut found: Vec<Poly> = Vec::new();
        for ids in cycles.iter() {
            let mut pts: Vec<Pt> = ids.iter().map(|&i| pool.pts[i]).collect();
            let mut changed = true;
            while changed && pts.len() >= 3 {
                changed = false;
                let mut i = 0;
                while i < pts.len() && pts.len() >= 3 {
                    let m = pts.len();
                    let a = pts[(i + m - 1) % m];
                    let c = pts[(i + 1) % m];
                    let (_, d) = seg_near(pts[i], a, c);
                    if d <= SNAP {
                        pts.remove(i);
                        changed = true;
                    } else {
                        i += 1;
                    }
                }
            }
            let p = Poly { pts };
            if p.pts.len() >= 3 && p.area().abs() > SNAP * SNAP {
                found.push(p);
            }
        }
        let mut outers: Vec<Poly> = Vec::new();
        let mut holes: Vec<Poly> = Vec::new();
        for p in found {
            if p.area() > 0.0 {
                outers.push(p);
            } else {
                holes.push(p);
            }
        }
        let outer_areas: Vec<f64> = outers.iter().map(|o| o.area()).collect();
        let outer_boxes: Vec<[Pt; 2]> = outers.iter().map(|o| o.bbox()).collect();
        let mut owned: Vec<Vec<Poly>> = vec![Vec::new(); outers.len()];
        for h in holes {
            let ha = -h.area();
            let hb = h.bbox();
            let mut best: Option<usize> = None;
            for (i, o) in outers.iter().enumerate() {
                let oa = outer_areas[i];
                if oa < ha {
                    continue;
                }
                if let Some(b) = best {
                    if oa >= outer_areas[b] {
                        continue;
                    }
                }
                let ob = outer_boxes[i];
                if hb[0][0] < ob[0][0] - SNAP || hb[1][0] > ob[1][0] + SNAP || hb[0][1] < ob[0][1] - SNAP || hb[1][1] > ob[1][1] + SNAP {
                    continue;
                }
                if !h.pts.iter().all(|p| o.contains(*p)) {
                    continue;
                }
                best = Some(i);
            }
            if let Some(b) = best {
                owned[b].push(h);
            }
        }
        let mut loops: Vec<Poly> = Vec::new();
        for (o, hs) in outers.into_iter().zip(owned) {
            loops.push(o);
            loops.extend(hs);
        }
        Region { loops }
    }

    #[cfg(test)]
    pub(crate) fn resolve_local_normal_ray_ref(a: &[Poly], b: &[Poly], kind: &str) -> Region {
        let fill = match kind {
            "union" => Fill::Union,
            "intersect" => Fill::Intersect,
            "difference" => Fill::Difference,
            "xor" => Fill::Xor,
            "nonzero" => Fill::NonZero,
            "positive" => Fill::Positive,
            "evenodd" => Fill::EvenOdd,
            _ => panic!("unknown fill {kind}"),
        };
        let mut edges: Vec<Edge> = Vec::new();
        for (side, set) in [a, b].iter().enumerate() {
            for l in set.iter() {
                let n = l.pts.len();
                if n < 3 {
                    continue;
                }
                for i in 0..n {
                    let p = l.pts[i];
                    let q = l.pts[(i + 1) % n];
                    if dist(p, q) > SNAP {
                        edges.push(Edge { p, q, side });
                    }
                }
            }
        }
        let n = edges.len();
        let boxes: Vec<[Pt; 2]> = edges.iter().map(|e| bbox_of(&[e.p, e.q])).collect();
        let mut cuts: Vec<Vec<(f64, Pt)>> = vec![Vec::new(); n];
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|a, b| boxes[*a][0][0].partial_cmp(&boxes[*b][0][0]).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b)));
        for oi in 0..n {
            let i = order[oi];
            for &j in order[oi + 1..].iter() {
                let (bi, bj) = (boxes[i], boxes[j]);
                if bj[0][0] > bi[1][0] + SNAP {
                    break;
                }
                if bi[0][0] > bj[1][0] + SNAP || bi[0][1] > bj[1][1] + SNAP || bj[0][1] > bi[1][1] + SNAP {
                    continue;
                }
                let (p, q, r, s) = (edges[i].p, edges[i].q, edges[j].p, edges[j].q);
                for x in [r, s] {
                    let (t, d) = seg_near(x, p, q);
                    if d <= SNAP && dist(x, p) > SNAP && dist(x, q) > SNAP {
                        cuts[i].push((t, x));
                    }
                }
                for x in [p, q] {
                    let (t, d) = seg_near(x, r, s);
                    if d <= SNAP && dist(x, r) > SNAP && dist(x, s) > SNAP {
                        cuts[j].push((t, x));
                    }
                }
                let d1 = sub(q, p);
                let d2 = sub(s, r);
                let den = cross(d1, d2);
                if den.abs() > 1e-12 * len(d1) * len(d2) {
                    let t = cross(sub(r, p), d2) / den;
                    let u = cross(sub(r, p), d1) / den;
                    if t > 0.0 && t < 1.0 && u > 0.0 && u < 1.0 {
                        let x = add(p, mul(d1, t));
                        if dist(x, p) > SNAP && dist(x, q) > SNAP && dist(x, r) > SNAP && dist(x, s) > SNAP {
                            cuts[i].push((t, x));
                            cuts[j].push((u, x));
                        }
                    }
                }
            }
        }
        let mut pool = Pool { pts: Vec::new(), grid: HashMap::new() };
        let mut groups: Vec<Group> = Vec::new();
        let mut group_of: HashMap<(usize, usize), usize> = HashMap::new();
        for (i, e) in edges.iter().enumerate() {
            let mut c = cuts[i].clone();
            c.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut ids = vec![pool.id(e.p)];
            for (_, x) in c.iter() {
                ids.push(pool.id(*x));
            }
            ids.push(pool.id(e.q));
            for k in 0..ids.len() - 1 {
                let (u, v) = (ids[k], ids[k + 1]);
                if u == v {
                    continue;
                }
                let key = (u.min(v), u.max(v));
                let g = match group_of.get(&key) {
                    Some(g) => *g,
                    None => {
                        groups.push(Group { u: key.0, v: key.1, net: [0, 0], edges: Vec::new() });
                        group_of.insert(key, groups.len() - 1);
                        groups.len() - 1
                    }
                };
                groups[g].net[e.side] += if u < v { 1 } else { -1 };
                groups[g].edges.push(i);
            }
        }
        let mut kept: Vec<(usize, usize)> = Vec::new();
        for g in groups.iter() {
            let (pu, pv) = (pool.pts[g.u], pool.pts[g.v]);
            let m = mul(add(pu, pv), 0.5);
            let d = norm(sub(pv, pu));
            let n_vec = [-d[1], d[0]];
            let mut left = [0i32; 2];
            for (k, e) in edges.iter().enumerate() {
                if g.edges.contains(&k) {
                    continue;
                }
                let sa = cross(n_vec, sub(e.p, m));
                let sb = cross(n_vec, sub(e.q, m));
                let up = sa <= 0.0 && sb > 0.0;
                let down = sb <= 0.0 && sa > 0.0;
                if !up && !down {
                    continue;
                }
                let ta = dot(n_vec, sub(e.p, m));
                let tb = dot(n_vec, sub(e.q, m));
                if ta + (tb - ta) * (-sa / (sb - sa)) > 0.0 {
                    left[e.side] += if up { 1 } else { -1 };
                }
            }
            let right = [left[0] - g.net[0], left[1] - g.net[1]];
            let l = filled(fill, left[0], left[1]);
            let r = filled(fill, right[0], right[1]);
            if l && !r {
                kept.push((g.u, g.v));
            } else if r && !l {
                kept.push((g.v, g.u));
            }
        }
        let mut from: Vec<Vec<usize>> = vec![Vec::new(); pool.pts.len()];
        for (k, e) in kept.iter().enumerate() {
            from[e.0].push(k);
        }
        let mut used = vec![false; kept.len()];
        let mut cycles: Vec<Vec<usize>> = Vec::new();
        let mut on_walk: Vec<usize> = vec![usize::MAX; pool.pts.len()];
        for k0 in 0..kept.len() {
            if used[k0] {
                continue;
            }
            used[k0] = true;
            let start = kept[k0].0;
            let mut ids = vec![start];
            on_walk[start] = 0;
            let mut k = k0;
            loop {
                let cur = kept[k].1;
                if on_walk[cur] != usize::MAX {
                    let j = on_walk[cur];
                    let cycle: Vec<usize> = ids[j..].to_vec();
                    for &i in cycle.iter() {
                        on_walk[i] = usize::MAX;
                    }
                    cycles.push(cycle);
                    ids.truncate(j);
                    if ids.is_empty() {
                        break;
                    }
                    on_walk[cur] = usize::MAX;
                }
                on_walk[cur] = ids.len();
                ids.push(cur);
                let din = sub(pool.pts[cur], pool.pts[kept[k].0]);
                let mut best: Option<usize> = None;
                let mut best_turn = -10.0;
                for &c in from[cur].iter() {
                    if used[c] {
                        continue;
                    }
                    let dout = sub(pool.pts[kept[c].1], pool.pts[cur]);
                    let t = if kept[c].1 == kept[k].0 { -5.0 } else { atan2(cross(din, dout), dot(din, dout)) };
                    if t > best_turn {
                        best_turn = t;
                        best = Some(c);
                    }
                }
                match best {
                    Some(c) => {
                        used[c] = true;
                        k = c;
                    }
                    None => break,
                }
            }
            for &i in ids.iter() {
                on_walk[i] = usize::MAX;
            }
        }
        let mut found: Vec<Poly> = Vec::new();
        for ids in cycles.iter() {
            let mut pts: Vec<Pt> = ids.iter().map(|&i| pool.pts[i]).collect();
            let mut changed = true;
            while changed && pts.len() >= 3 {
                changed = false;
                let mut i = 0;
                while i < pts.len() && pts.len() >= 3 {
                    let m = pts.len();
                    let a = pts[(i + m - 1) % m];
                    let c = pts[(i + 1) % m];
                    let (_, d) = seg_near(pts[i], a, c);
                    if d <= SNAP {
                        pts.remove(i);
                        changed = true;
                    } else {
                        i += 1;
                    }
                }
            }
            let p = Poly { pts };
            if p.pts.len() >= 3 && p.area().abs() > SNAP * SNAP {
                found.push(p);
            }
        }
        let mut outers: Vec<Poly> = Vec::new();
        let mut holes: Vec<Poly> = Vec::new();
        for p in found {
            if p.area() > 0.0 {
                outers.push(p);
            } else {
                holes.push(p);
            }
        }
        let mut owned: Vec<Vec<Poly>> = vec![Vec::new(); outers.len()];
        for h in holes {
            let mut best: Option<usize> = None;
            for (i, o) in outers.iter().enumerate() {
                if o.area() < -h.area() || !h.pts.iter().all(|p| o.contains(*p)) {
                    continue;
                }
                let smaller = match best {
                    Some(b) => o.area() < outers[b].area(),
                    None => true,
                };
                if smaller {
                    best = Some(i);
                }
            }
            if let Some(b) = best {
                owned[b].push(h);
            }
        }
        let mut loops: Vec<Poly> = Vec::new();
        for (o, hs) in outers.into_iter().zip(owned) {
            loops.push(o);
            loops.extend(hs);
        }
        Region { loops }
    }
}

/// Cell patterns clipped to a region: hexagons, squares, bricks, triangles, or cells
/// along a line. Each cell comes back with its centre, its piece of the region, and
/// whether the region's edge cut it.
pub mod lattice {
    use super::geom2d::{self, Poly, Pt, Region, Size};

    /// Which way a hexagon points.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Orient {
        /// A corner at the top; rows run along X, odd rows shifted half a cell.
        Pointy,
        /// A flat side at the top: the `Pointy` grid turned 90°.
        Flat,
    }

    /// One cell of a pattern.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Cell {
        /// `[column, row]` in the grid (`[k, 0]` along a line).
        pub index: [i32; 2],
        /// The centre of the whole cell, before clipping.
        pub centre: Pt,
        /// The cell's material inside the region (a clipped cell can be more than one piece).
        pub region: Region,
        /// True when the region's edge cut the cell.
        pub clipped: bool,
    }

    impl Cell {
        /// The cell's first outline (the whole cell when it has one piece and no hole).
        pub fn poly(&self) -> Poly {
            self.region.loops().first().cloned().unwrap_or_default()
        }

        /// The cell's area in mm².
        pub fn area(&self) -> f64 {
            self.region.area()
        }
    }

    /// A pattern of cells: lattice points and the cell shape around each.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Grid {
        pitch: Pt,
        shift: f64,
        shapes: Vec<Poly>,
        centres: Vec<Pt>,
        points: Vec<Pt>,
        origin: Pt,
        turn_deg: f64,
        rib: f64,
    }

    fn lattice_grid(pitch: Pt, shift: f64, shapes: Vec<Poly>, centres: Vec<Pt>) -> Grid {
        Grid { pitch, shift, shapes, centres, points: Vec::new(), origin: [0.0, 0.0], turn_deg: 0.0, rib: 0.0 }
    }

    /// Hexagons of side `side` that tile the plane (pitch √3·side across, 1.5·side between rows).
    pub fn hex(side: f64, orient: Orient) -> Grid {
        let shape = geom2d::regular(6, Size::Side(side), [0.0, 0.0], 90.0);
        let px = 3f64.sqrt() * side;
        let g = lattice_grid([px, 1.5 * side], px / 2.0, vec![shape], vec![[0.0, 0.0]]);
        match orient {
            Orient::Pointy => g,
            Orient::Flat => g.turned(90.0),
        }
    }

    /// `pitch_u` × `pitch_v` rectangles in straight rows and columns.
    pub fn rect(pitch_u: f64, pitch_v: f64) -> Grid {
        lattice_grid([pitch_u, pitch_v], 0.0, vec![geom2d::rect(pitch_u, pitch_v)], vec![[0.0, 0.0]])
    }

    /// `pitch_u` × `pitch_v` rectangles with every odd row shifted `shift` along X (bricks: `pitch_u / 2`).
    pub fn staggered(pitch_u: f64, pitch_v: f64, shift: f64) -> Grid {
        lattice_grid([pitch_u, pitch_v], shift, vec![geom2d::rect(pitch_u, pitch_v)], vec![[0.0, 0.0]])
    }

    /// Equilateral triangles of side `side`, pointing up and down in turn.
    pub fn tri(side: f64) -> Grid {
        let h = side * 3f64.sqrt() / 2.0;
        let up = Poly { pts: vec![[-side / 2.0, -h / 2.0], [side / 2.0, -h / 2.0], [0.0, h / 2.0]] };
        let down = Poly { pts: vec![[side / 2.0, h / 2.0], [-side / 2.0, h / 2.0], [0.0, -h / 2.0]] };
        lattice_grid([side / 2.0, h], 0.0, vec![up, down], vec![[0.0, -h / 6.0], [0.0, h / 6.0]])
    }

    /// `count` copies of `cell` (drawn around the origin) spaced evenly along the open line
    /// `path`, the first at its start and the last at its end (one copy sits at the middle).
    pub fn along(path: &[Pt], count: usize, cell: Poly) -> Grid {
        let mut lengths = vec![0.0];
        for i in 1..path.len() {
            let d = (path[i][0] - path[i - 1][0]).hypot(path[i][1] - path[i - 1][1]);
            lengths.push(lengths[i - 1] + d);
        }
        let total = lengths.last().copied().unwrap_or(0.0);
        let mut points: Vec<Pt> = Vec::new();
        for k in 0..count {
            let s = if count == 1 { total / 2.0 } else { total * k as f64 / (count - 1) as f64 };
            let mut i = 1;
            while i + 1 < path.len() && lengths[i] < s {
                i += 1;
            }
            if path.len() < 2 {
                points.push(path.first().copied().unwrap_or([0.0, 0.0]));
                continue;
            }
            let seg = lengths[i] - lengths[i - 1];
            let t = if seg > 0.0 { geom2d::clamp((s - lengths[i - 1]) / seg, 0.0, 1.0) } else { 0.0 };
            let (a, b) = (path[i - 1], path[i]);
            points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
        Grid { pitch: [0.0, 0.0], shift: 0.0, shapes: vec![cell], centres: vec![[0.0, 0.0]], points, origin: [0.0, 0.0], turn_deg: 0.0, rib: 0.0 }
    }

    pub(crate) fn native_cells(args: &super::Json) -> Option<super::Json> {
        fn point(v: &super::Json) -> Option<Pt> {
            let a = v.as_f64s()?;
            if a.len() != 2 || !a[0].is_finite() || !a[1].is_finite() { return None; }
            Some([a[0], a[1]])
        }
        let grid = Grid {
            pitch: point(args.get("pitch")?)?, shift: args.get("shift")?.as_f64()?,
            shapes: geom2d::loops_from_json(args.get("shapes")?)?,
            centres: args.get("centres")?.as_points2()?, points: args.get("points")?.as_points2()?,
            origin: point(args.get("origin")?)?, turn_deg: args.get("turn")?.as_f64()?, rib: args.get("rib")?.as_f64()?,
        };
        let region = Region::from_native_loops(geom2d::loops_from_json(args.get("region")?)?);
        let area = args.get("minArea")?.as_f64()?;
        if !grid.shift.is_finite() || !grid.turn_deg.is_finite() || !grid.rib.is_finite() || !area.is_finite()
            || grid.points.len() > 10000 || grid.centres.len() > 10000
            || grid.points.iter().chain(grid.centres.iter()).any(|p| !p[0].is_finite() || !p[1].is_finite()) { return None; }
        if grid.points.is_empty() && grid.pitch[0] > 0.0 && grid.pitch[1] > 0.0 && !region.is_empty() {
            let bounds = region.bbox();
            let reach = grid.shapes.iter().flat_map(|p| p.pts.iter()).fold(0.0f64, |m, p| m.max(p[0].hypot(p[1])));
            let extent = bounds.iter().map(|p| (p[0] - grid.origin[0]).hypot(p[1] - grid.origin[1])).fold(0.0f64, f64::max) + reach + grid.shift.abs();
            let nx = 2.0 * extent / grid.pitch[0] + 5.0;
            let ny = 2.0 * extent / grid.pitch[1] + 5.0;
            if !nx.is_finite() || !ny.is_finite() || nx * ny > 10000.0 { return None; }
        }
        let cells = grid.cells_local(&region, area);
        Some(super::Json::arr(cells.iter().map(|c| super::Json::obj()
            .set("index", super::Json::arr(vec![c.index[0] as f64, c.index[1] as f64]))
            .set("centre", super::Json::arr(vec![c.centre[0], c.centre[1]]))
            .set("region", geom2d::loops_json(c.region.loops())).set("clipped", c.clipped)).collect::<Vec<_>>()))
    }

    impl Grid {
        /// Leave walls `t` mm thick between cells: each cell shrinks by `t / 2` all round.
        pub fn rib(self, t: f64) -> Grid {
            Grid { rib: t, ..self }
        }

        /// Put lattice point `[0, 0]` at `origin`.
        pub fn at(self, origin: Pt) -> Grid {
            Grid { origin, ..self }
        }

        /// Turn the whole pattern by `deg` about its origin (adds to an earlier turn).
        pub fn turned(self, deg: f64) -> Grid {
            let turn_deg = self.turn_deg + deg;
            Grid { turn_deg, ..self }
        }

        fn place(&self, p: Pt) -> Pt {
            let (s, c) = geom2d::sin_cos_deg(self.turn_deg);
            if self.turn_deg == 0.0 {
                return [self.origin[0] + p[0], self.origin[1] + p[1]];
            }
            [self.origin[0] + p[0] * c - p[1] * s, self.origin[1] + p[0] * s + p[1] * c]
        }

        /// The cells that meet `region`, row by row from the lowest, each row by column;
        /// pieces under `min_area` mm² are dropped, and a cell with nothing left is skipped.
        pub fn cells(&self, region: &Region, min_area: f64) -> Vec<Cell> {
            if let Some(cells) = self.native_cells(region, min_area) { return cells; }
            self.cells_local(region, min_area)
        }

        fn native_cells(&self, region: &Region, min_area: f64) -> Option<Vec<Cell>> {
            if !super::NATIVE_GEOMETRY.load(super::Ordering::Relaxed) { return None; }
            let point = |p: Pt| super::Json::arr(vec![p[0], p[1]]);
            let args = super::Json::obj().set("op", "cells").set("pitch", point(self.pitch)).set("shift", self.shift)
                .set("shapes", geom2d::loops_json(&self.shapes))
                .set("centres", super::Json::arr(self.centres.iter().map(|p| point(*p)).collect::<Vec<_>>()))
                .set("points", super::Json::arr(self.points.iter().map(|p| point(*p)).collect::<Vec<_>>()))
                .set("origin", point(self.origin)).set("turn", self.turn_deg).set("rib", self.rib)
                .set("region", geom2d::loops_json(region.loops())).set("minArea", min_area);
            let reply = super::native_geometry(args)?;
            let mut cells = Vec::new();
            for row in reply.as_array()? {
                let i = row.get("index")?.as_f64s()?;
                let p = row.get("centre")?.as_f64s()?;
                if i.len() != 2 || p.len() != 2 { return None; }
                cells.push(Cell { index: [i[0] as i32, i[1] as i32], centre: [p[0], p[1]],
                    region: Region::from_native_loops(geom2d::loops_from_json(row.get("region")?)?),
                    clipped: row.get("clipped")?.as_bool()? });
            }
            Some(cells)
        }

        fn cells_local(&self, region: &Region, min_area: f64) -> Vec<Cell> {
            let mut out: Vec<Cell> = Vec::new();
            if region.is_empty() || self.shapes.is_empty() {
                return out;
            }
            let shapes: Vec<Poly> = self
                .shapes
                .iter()
                .map(|s| if self.rib > 0.0 { s.region().offset_miter(-self.rib / 2.0).loops().first().cloned().unwrap_or_default() } else { s.clone() })
                .collect();
            let reach = self.shapes.iter().flat_map(|s| s.pts.iter()).fold(0.0f64, |m, p| m.max(p[0].hypot(p[1])));
            let mut sites: Vec<([i32; 2], Pt)> = Vec::new();
            if !self.points.is_empty() || self.pitch[0] <= 0.0 || self.pitch[1] <= 0.0 {
                for (k, p) in self.points.iter().enumerate() {
                    sites.push(([k as i32, 0], *p));
                }
            } else {
                let rb = region.bbox();
                let (s, c) = geom2d::sin_cos_deg(-self.turn_deg);
                let mut lo = [f64::MAX, f64::MAX];
                let mut hi = [f64::MIN, f64::MIN];
                for q in [rb[0], [rb[1][0], rb[0][1]], rb[1], [rb[0][0], rb[1][1]]] {
                    let d = [q[0] - self.origin[0], q[1] - self.origin[1]];
                    let f = [d[0] * c - d[1] * s, d[0] * s + d[1] * c];
                    lo = [lo[0].min(f[0]), lo[1].min(f[1])];
                    hi = [hi[0].max(f[0]), hi[1].max(f[1])];
                }
                let (pu, pv) = (self.pitch[0], self.pitch[1]);
                let j0 = ((lo[1] - reach) / pv).floor() as i32 - 1;
                let j1 = ((hi[1] + reach) / pv).ceil() as i32 + 1;
                let i0 = ((lo[0] - reach - self.shift.abs()) / pu).floor() as i32 - 1;
                let i1 = ((hi[0] + reach + self.shift.abs()) / pu).ceil() as i32 + 1;
                for j in j0..=j1 {
                    let shift = if j.rem_euclid(2) == 1 { self.shift } else { 0.0 };
                    for i in i0..=i1 {
                        sites.push(([i, j], [i as f64 * pu + shift, j as f64 * pv]));
                    }
                }
            }
            let rb = region.bbox();
            let mut region_boxes: Vec<[Pt; 2]> = Vec::new();
            for l in region.loops().iter() {
                let n = l.pts.len();
                for i in 0..n {
                    let (a, b) = (l.pts[i], l.pts[(i + 1) % n]);
                    region_boxes.push([[a[0].min(b[0]), a[1].min(b[1])], [a[0].max(b[0]), a[1].max(b[1])]]);
                }
            }
            for (index, local) in sites {
                let k = if shapes.len() > 1 { ((index[0] + index[1]).rem_euclid(shapes.len() as i32)) as usize } else { 0 };
                let shape = &shapes[k];
                let cell = Poly { pts: shape.pts.iter().map(|p| self.place([local[0] + p[0], local[1] + p[1]])).collect() };
                let cc = self.centres.get(k).copied().unwrap_or([0.0, 0.0]);
                let centre = self.place([local[0] + cc[0], local[1] + cc[1]]);
                let cb = cell.bbox();
                if cb[0][0] > rb[1][0] || cb[1][0] < rb[0][0] || cb[0][1] > rb[1][1] || cb[1][1] < rb[0][1] {
                    continue;
                }
                let touches = region_boxes.iter().any(|b| !(b[0][0] > cb[1][0] || b[1][0] < cb[0][0] || b[0][1] > cb[1][1] || b[1][1] < cb[0][1]));
                let whole = cell.area().abs();
                let piece = if touches {
                    region.clip(&cell)
                } else if region.contains(cell.centroid()) {
                    cell.region()
                } else {
                    Region::empty()
                };
                let piece = piece.without_small(min_area);
                if piece.is_empty() {
                    continue;
                }
                let clipped = piece.loops().len() != 1 || (piece.area() - whole).abs() > 1e-9 * whole.max(1.0);
                out.push(Cell { index, centre, region: piece, clipped });
            }
            out
        }
    }
}

/// Involute spur gears and racks (API 1.12), adopted from the library ingredient `involute-gears` v1 by the process in
/// docs/plan-native-recipes.md section 5.
///
/// The ingredient's functions keep their names, their arguments and their numbers bit for bit (`gear_outline`,
/// `gear_outline_with`, `gear_tooth`, `pitch_radius`, `involute`, `mate_phase`, `mate_turn`, `dir_deg`,
/// `idler_centre`, `rack_outline`): a recipe that switches from the library copy to this one sends the same calls.
/// They use the platform's own trig, as the ingredient did, so like it they can differ in the last bit between lust
/// and rustc.
///
/// `Gear` is new: true involute flanks as splines, the root fillet the cutting rack leaves (so a small gear is undercut
/// as a cut one is), arcs at tip and root, any pressure angle and profile shift, as the `loops` an `extrude` takes. It
/// uses the crate's own trig, so it sends the same bytes under lust and rustc, and the kernel's `gear` op builds the
/// same outline from the same code.
pub mod gears {
    use super::geom2d::{atan, atan2, sin_cos, sin_cos_deg};
    use super::Json;

    // ---- involute-gears v1: same names, same bytes. ----

    pub type P2 = [f64; 2];

    pub fn involute(a: f64) -> f64 { a.tan() - a }

    /// Pitch radius of a z-tooth gear of module m.
    pub fn pitch_radius(z: u32, m: f64) -> f64 { m * z as f64 / 2.0 }

    /// One tooth centred on angle `c` (radians), counter-clockwise, root to root.
    /// 20 degree pressure angle, addendum m, dedendum 1.25 m; `backlash` mm at the pitch
    /// circle; `flank` points per flank (3 keeps a 24-tooth gear under 200 points).
    pub fn gear_tooth(z: u32, m: f64, backlash: f64, flank: usize, c: f64, pts: &mut Vec<P2>) {
        let zf = z as f64;
        let r = m * zf / 2.0;
        let rb = r * 20f64.to_radians().cos();
        let (ra, rf) = (r + m, r - 1.25 * m);
        let r0 = rf.max(rb);
        let psi = std::f64::consts::PI / (2.0 * zf) - backlash / (2.0 * r);
        let ap = (rb / r).acos();
        let half = |rho: f64| psi + involute(ap) - involute((rb / rho.max(rb)).acos());
        let gap = std::f64::consts::PI / zf - half(r0);
        let n = flank.max(2);
        let h0 = half(r0) + 0.25 * gap;
        pts.push([rf * (c - h0).cos(), rf * (c - h0).sin()]);
        for i in 0..n {
            let rho = r0 + (ra - r0) * i as f64 / (n - 1) as f64;
            let a = c - half(rho);
            pts.push([rho * a.cos(), rho * a.sin()]);
        }
        for i in 0..n {
            let rho = ra - (ra - r0) * i as f64 / (n - 1) as f64;
            let a = c + half(rho);
            pts.push([rho * a.cos(), rho * a.sin()]);
        }
        pts.push([rf * (c + h0).cos(), rf * (c + h0).sin()]);
    }

    /// A whole gear outline with tooth 0 centred on `phase_deg`: (2 + 2 * flank) points a tooth.
    pub fn gear_outline_with(z: u32, m: f64, backlash: f64, flank: usize, phase_deg: f64) -> Vec<P2> {
        let mut pts = Vec::new();
        let pitch = 2.0 * std::f64::consts::PI / z as f64;
        for t in 0..z { gear_tooth(z, m, backlash, flank, phase_deg.to_radians() + pitch * t as f64, &mut pts); }
        pts
    }

    /// gear_outline_with at 0.1 mm backlash and 3 flank points.
    pub fn gear_outline(z: u32, m: f64, phase_deg: f64) -> Vec<P2> { gear_outline_with(z, m, 0.1, 3, phase_deg) }

    /// Phase (degrees) for a mating gear of `mate_z` teeth whose centre lies in direction
    /// `dir_deg` from a gear of `own_z` teeth with tooth 0 at `own_phase_deg`, so each tooth
    /// meets a gap. Chain it along a train: drive -> idler -> output.
    pub fn mate_phase(own_phase_deg: f64, own_z: u32, dir_deg: f64, mate_z: u32) -> f64 {
        let own_pitch = 360.0 / own_z as f64;
        let f = (((dir_deg - own_phase_deg) / own_pitch) % 1.0 + 1.0) % 1.0;
        dir_deg + 180.0 - (0.5 - f) * 360.0 / mate_z as f64
    }

    /// Turn of a mating gear when its driver turns `own_turn_deg`: opposite way, by the ratio.
    pub fn mate_turn(own_turn_deg: f64, own_z: u32, mate_z: u32) -> f64 { -own_turn_deg * own_z as f64 / mate_z as f64 }

    /// Direction in degrees from a to b.
    pub fn dir_deg(a: P2, b: P2) -> f64 { (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees() }

    /// Centre of an idler that sits `d1` from `a` and `d2` from `c` (centre distances, i.e.
    /// sums of pitch radii). `left` picks the side to the left of a -> c. None if out of reach.
    pub fn idler_centre(a: P2, c: P2, d1: f64, d2: f64, left: bool) -> Option<P2> {
        let (dx, dy) = (c[0] - a[0], c[1] - a[1]);
        let d = dx.hypot(dy);
        if d > d1 + d2 || d < (d1 - d2).abs() || d == 0.0 { return None; }
        let k = (d1 * d1 - d2 * d2 + d * d) / (2.0 * d);
        let h = (d1 * d1 - k * k).max(0.0).sqrt();
        let (px, py) = (a[0] + k * dx / d, a[1] + k * dy / d);
        let s = if left { 1.0 } else { -1.0 };
        Some([px - s * h * dy / d, py + s * h * dx / d])
    }

    /// Rack outline in (u along the rack, v up), pitch line at v = 0, teeth pointing to -v.
    /// Teeth centred on `centres` (mm along u, one pitch = PI * m apart); the outline is closed
    /// at v = `back` so it overlaps the bar it is fused to. Cut the root strip first:
    /// box from the first tooth's root to the last one's, v from below the tips to 1.25 m.
    #[allow(clippy::ptr_arg)] // The library's signature, kept as it was adopted.
    pub fn rack_outline(m: f64, centres: &Vec<f64>, back: f64) -> Vec<P2> {
        let t20 = 20f64.to_radians().tan();
        let p4 = std::f64::consts::PI * m / 4.0;
        let (add, ded) = (0.9 * m, 1.25 * m);
        let (w_tip, w_root) = (p4 - add * t20, p4 + ded * t20);
        let n = centres.len();
        let mut pts: Vec<P2> = vec![[centres[0] - w_root, back]];
        for c in centres.iter() {
            pts.push([c - w_root, ded]);
            pts.push([c - w_tip, -add]);
            pts.push([c + w_tip, -add]);
            pts.push([c + w_root, ded]);
        }
        pts.push([centres[n - 1] + w_root, back]);
        pts
    }

    // ---- New in the crate: true involute gears. ----

    const PI: f64 = std::f64::consts::PI;

    /// The fewest and the most teeth a `Gear` takes.
    pub const MIN_TEETH: u32 = 6;
    pub const MAX_TEETH: u32 = 150;

    /// Steps along a root fillet and along an involute flank: the spline goes through one point more than this.
    const FILLET_STEPS: usize = 6;
    const FLANK_STEPS: usize = 8;

    /// An involute spur gear: `teeth`, `module` (mm), `pressure_deg` (20 by default), `backlash` (mm taken off each
    /// tooth's thickness at the pitch circle, 0.1 by default) and `shift` (profile shift, times the module, 0 by default).
    /// Addendum m (1 + shift), dedendum m (1.25 - shift), cut by a rack with sharp tips: a gear under about 17 teeth at
    /// 20 degrees is undercut, as a hobbed one is, and meshes without its mate's tips touching the fillet.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Gear {
        pub teeth: u32,
        pub module: f64,
        pub pressure_deg: f64,
        pub backlash: f64,
        pub shift: f64,
    }

    /// One piece of a gear's outline, after the previous piece's end: `Line(to)`, `Arc(through, to)`, or
    /// `Spline(through, to)`, as `extrude.loops` spells them.
    #[derive(Clone, Debug, PartialEq)]
    pub enum Piece {
        Line(P2),
        Arc(P2, P2),
        Spline(Vec<P2>, P2),
    }

    /// A closed outline from `start` back to `start`.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Outline {
        pub start: P2,
        pub pieces: Vec<Piece>,
    }

    /// What a piece of a flank is: the rack tip's fillet, a straight radial line, or the involute.
    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        Fillet,
        Radial,
        Involute,
    }

    /// One flank from the root circle up to the tip, in polar `(radius, half-angle from the tooth's centre line)`: each
    /// piece's points from its start to its end, the next piece starting where this one ends. The last is the involute.
    struct Side {
        pieces: Vec<(Kind, Vec<(f64, f64)>)>,
    }

    fn polar(rho: f64, angle: f64) -> P2 {
        let (s, c) = sin_cos(angle);
        [rho * c, rho * s]
    }

    impl Outline {
        /// The loop for `extrude.loops`: `{start, segments}` with line, arc and spline segments.
        pub fn to_loop(&self) -> Json {
            let pt = |p: P2| Json::from(vec![p[0], p[1]]);
            let mut segs: Vec<Json> = Vec::new();
            for piece in self.pieces.iter() {
                match piece {
                    Piece::Line(to) => segs.push(Json::obj().set("kind", "line").set("to", pt(*to))),
                    Piece::Arc(through, to) => segs.push(Json::obj().set("kind", "arc").set("through", pt(*through)).set("to", pt(*to))),
                    Piece::Spline(through, to) => {
                        let through: Vec<Json> = through.iter().map(|p| pt(*p)).collect();
                        segs.push(Json::obj().set("kind", "spline").set("through", through).set("to", pt(*to)))
                    }
                }
            }
            Json::obj().set("start", pt(self.start)).set("segments", segs)
        }
    }

    impl Gear {
        /// `teeth` of module `module` mm at 20 degrees, 0.1 mm backlash, no profile shift.
        pub fn new(teeth: u32, module: f64) -> Gear {
            Gear { teeth, module, pressure_deg: 20.0, backlash: 0.1, shift: 0.0 }
        }

        pub fn pressure(self, deg: f64) -> Gear {
            Gear { pressure_deg: deg, ..self }
        }

        pub fn backlash(self, mm: f64) -> Gear {
            Gear { backlash: mm, ..self }
        }

        /// Profile shift, times the module: positive moves the teeth out (thicker roots, no undercut), negative in.
        pub fn shift(self, x: f64) -> Gear {
            Gear { shift: x, ..self }
        }

        pub fn pitch_radius(&self) -> f64 {
            self.module * self.teeth as f64 / 2.0
        }

        pub fn base_radius(&self) -> f64 {
            self.pitch_radius() * sin_cos_deg(self.pressure_deg).1
        }

        pub fn tip_radius(&self) -> f64 {
            self.pitch_radius() + self.module * (1.0 + self.shift)
        }

        pub fn root_radius(&self) -> f64 {
            self.pitch_radius() - self.module * (1.25 - self.shift)
        }

        /// The angle between two teeth, in degrees.
        pub fn pitch_deg(&self) -> f64 {
            360.0 / self.teeth as f64
        }

        /// A tooth's thickness along the pitch circle, mm.
        pub fn pitch_thickness(&self) -> f64 {
            2.0 * self.pitch_radius() * self.psi()
        }

        /// Half a tooth's angle at the pitch circle.
        fn psi(&self) -> f64 {
            let (s, c) = sin_cos_deg(self.pressure_deg);
            let z = self.teeth as f64;
            PI / (2.0 * z) + 2.0 * self.shift * (s / c) / z - self.backlash / (2.0 * self.pitch_radius())
        }

        /// Whether the cutting rack's flank reaches below where the line of action meets the base circle, so the root of
        /// each tooth is undercut (cut into, thinner than the involute). Under 18 teeth at 20 degrees without shift.
        pub fn undercut(&self) -> bool {
            let (sa, ca) = sin_cos_deg(self.pressure_deg);
            let m = self.module;
            let w_tip = PI * m / 4.0 + self.backlash / 2.0 - 1.25 * m * (sa / ca);
            let round = (0.38 * m).min(m * (1.2 - self.shift)).min(0.95 * w_tip * ca / (1.0 - sa)).max(0.0);
            let depth = m * (1.25 - self.shift) - round * (1.0 - sa);
            self.pitch_radius() * sa - depth / sa <= 0.0
        }

        /// None when the numbers make a gear, else the sentence why not.
        pub fn refusal(&self) -> Option<String> {
            self.side().err()
        }

        fn numbers_refusal(&self) -> Option<String> {
            let ok = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
            if self.teeth < MIN_TEETH || self.teeth > MAX_TEETH {
                return Some(format!("A gear takes {MIN_TEETH} to {MAX_TEETH} teeth."));
            }
            if !ok(self.module, 0.05, 50.0) {
                return Some("A gear's module is 0.05 to 50 mm.".to_string());
            }
            if !ok(self.pressure_deg, 10.0, 30.0) {
                return Some("A gear's pressure angle is 10 to 30 degrees.".to_string());
            }
            if !ok(self.shift, -1.0, 1.0) {
                return Some("A gear's profile shift is -1 to 1, times the module.".to_string());
            }
            if !ok(self.backlash, 0.0, self.module) {
                return Some("A gear's backlash is 0 to one module, in mm at the pitch circle.".to_string());
            }
            None
        }

        /// One flank, worked out once with the spline's steps: where the rack's tip fillet meets the involute, and the
        /// points of each.
        fn side(&self) -> Result<Side, String> {
            self.side_with(FILLET_STEPS, FLANK_STEPS)
        }

        /// The flank as a rack with a rounded tip cuts it (ISO 53: dedendum 1.25 m, tip radius 0.38 m, smaller where
        /// a high pressure angle or a big shift leaves no room). The tip's round leaves the root fillet; its straight
        /// flank leaves the involute down to the form circle. When the flank's lowest point would reach past where the
        /// line of action touches the base circle, the gear is undercut: that point's path cuts into the involute, and
        /// the flank follows it up to where it crosses the involute.
        fn side_with(&self, fillet_steps: usize, flank_steps: usize) -> Result<Side, String> {
            if let Some(why) = self.numbers_refusal() {
                return Err(why);
            }
            let (sa, ca) = sin_cos_deg(self.pressure_deg);
            let tan_a = sa / ca;
            let m = self.module;
            let r = self.pitch_radius();
            let rb = r * ca;
            let ra = self.tip_radius();
            let rf = self.root_radius();
            let inv_a = tan_a - atan(tan_a);
            let psi = self.psi();
            // The involute's half-angle at radius rho (rho >= rb).
            let inv_half = |rho: f64| {
                let t = (rho * rho - rb * rb).max(0.0).sqrt() / rb;
                psi + inv_a - (t - atan(t))
            };
            if inv_half(ra) <= 0.0 {
                return Err("These teeth come to a point below the tip: use less profile shift, more teeth, or a smaller pressure angle.".to_string());
            }
            let undercut = "The undercut cuts through these teeth: use more teeth or a positive profile shift.";
            // The rack, rolling on the pitch circle: its tooth in the gap after tooth 0, its tip on the root circle. In
            // the rolling frame the pitch point is (r, 0) and the rack has moved -r s along v when the gear has turned s.
            let w_tip = PI * m / 4.0 + self.backlash / 2.0 - 1.25 * m * tan_a;
            let round = (0.38 * m).min(m * (1.2 - self.shift)).min(0.95 * w_tip * ca / (1.0 - sa)).max(0.0);
            let xc = rf + round;
            let yc = PI * m / 2.0 - w_tip + round * (1.0 - sa) / ca;
            let reach = r - xc;
            // A rolling-frame point seen from the gear, which has turned s: (radius, angle).
            let seen = |p: P2, s: f64| {
                let (sn, cs) = sin_cos(s);
                let g = [p[0] * cs - p[1] * sn, p[0] * sn + p[1] * cs];
                ((g[0] * g[0] + g[1] * g[1]).sqrt(), atan2(g[1], g[0]))
            };
            // Where the tip's round touches the gear: on the line from the pitch point through the round's centre.
            let fillet_at = |s: f64| {
                let c = [xc, yc - r * s];
                let d = [c[0] - r, c[1]];
                let l = (d[0] * d[0] + d[1] * d[1]).sqrt();
                let q = if l > 0.0 { [c[0] + round * d[0] / l, c[1] + round * d[1] / l] } else { [xc - round, c[1]] };
                seen(q, s)
            };
            // The flank's lowest point, where the round meets it, and its path.
            let low_at = |s: f64| seen([xc - round * sa, yc - r * s - round * ca], s);
            let s_root = yc / r;
            let s_low = (yc + reach * ca / sa) / r;
            let depth = r - (xc - round * sa);
            let t_form = (r * sa - depth / sa) / rb;
            let sample = |f: &dyn Fn(f64) -> (f64, f64), s0: f64, s1: f64, steps: usize| -> Vec<(f64, f64)> {
                (0..=steps).map(|i| f(s0 + (s1 - s0) * i as f64 / steps as f64)).collect()
            };
            // The involute from rho0 to rho1, evenly in its roll angle.
            let involute_from = |rho0: f64, rho1: f64| -> Vec<(f64, f64)> {
                let t_of = |rho: f64| (rho * rho - rb * rb).max(0.0).sqrt() / rb;
                let (t0, t1) = (t_of(rho0), t_of(rho1));
                (0..=flank_steps)
                    .map(|i| {
                        let t = t0 + (t1 - t0) * i as f64 / flank_steps as f64;
                        let rho = if i == 0 { rho0 } else if i == flank_steps { rho1 } else { rb * (1.0 + t * t).sqrt() };
                        (rho, psi + inv_a - (t - atan(t)))
                    })
                    .collect()
            };
            let mut pieces: Vec<(Kind, Vec<(f64, f64)>)> = Vec::new();
            // Each piece ends on the next one's first point exactly, so neighbours share it; a gap of more than a hair
            // would be a slip in the maths here, never a gear.
            let mut seam: f64 = 0.0;
            let mut join = |pieces: &mut Vec<(Kind, Vec<(f64, f64)>)>, next: (Kind, Vec<(f64, f64)>)| {
                if let Some((_, last)) = pieces.last_mut() {
                    let n = last.len() - 1;
                    let (a, b) = (polar(last[n].0, last[n].1), polar(next.1[0].0, next.1[0].1));
                    seam = seam.max(((a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1])).sqrt());
                    last[n] = next.1[0];
                }
                pieces.push(next);
            };
            if t_form > 0.0 {
                // No undercut: the round's fillet runs into the involute at the form circle, where the flank starts.
                let form = rb * (1.0 + t_form * t_form).sqrt();
                if s_low > s_root {
                    join(&mut pieces, (Kind::Fillet, sample(&fillet_at, s_root, s_low, fillet_steps)));
                } else if form > rf + 1e-9 {
                    join(&mut pieces, (Kind::Radial, vec![(rf, inv_half(form)), (form, inv_half(form))]));
                }
                join(&mut pieces, (Kind::Involute, involute_from(form, ra)));
            } else {
                // Undercut: the whole involute from the base circle is cut, and then the round and the flank's lowest
                // point cut into it. The tooth's edge is the cutter's path wherever that is nearer the middle.
                let path = |s: f64| if s <= s_low { fillet_at(s) } else { low_at(s) };
                let gap = |s: f64| {
                    let (rho, a) = path(s);
                    if rho < rb { -1.0 } else { a - inv_half(rho) }
                };
                let mut s_end = s_low.max(s_root);
                let mut step = 0.01;
                while path(s_end).0 < ra && step < 1e3 {
                    s_end += step;
                    step *= 1.5;
                }
                // Where the path crosses the involute, found on a fine walk and then bisected.
                let mut crossings: Vec<f64> = Vec::new();
                let walk = 600;
                let mut prev = (s_root, -1.0);
                for i in 1..=walk {
                    let s = s_root + (s_end - s_root) * i as f64 / walk as f64;
                    let g = gap(s);
                    if (g < 0.0) != (prev.1 < 0.0) {
                        let (mut a, mut b) = (prev.0, s);
                        for _ in 0..90 {
                            let mid = 0.5 * (a + b);
                            if (gap(mid) < 0.0) == (prev.1 < 0.0) { a = mid } else { b = mid }
                        }
                        crossings.push(b);
                    }
                    prev = (s, g);
                }
                if crossings.len() % 2 == 0 {
                    return Err(undercut.to_string());
                }
                // On the path from the root, then on the involute and the path in turn, ending on the involute.
                let mut from = s_root;
                for (k, &s) in crossings.iter().enumerate() {
                    if k % 2 == 0 {
                        for (a, b) in [(from, s.min(s_low)), (from.max(s_low), s)] {
                            if b > a {
                                let f: &dyn Fn(f64) -> (f64, f64) = if b <= s_low { &fillet_at } else { &low_at };
                                join(&mut pieces, (Kind::Fillet, sample(f, a, b, fillet_steps)));
                            }
                        }
                    } else {
                        let rho0 = pieces.last().map_or(rb, |(_, pts)| pts[pts.len() - 1].0);
                        join(&mut pieces, (Kind::Involute, involute_from(rho0, path(s).0)));
                        from = s;
                    }
                }
                let rho0 = pieces.last().map_or(rb, |(_, pts)| pts[pts.len() - 1].0);
                let crossing = (rho0, inv_half(rho0));
                if let Some((_, last)) = pieces.last_mut() {
                    let n = last.len() - 1;
                    last[n] = crossing;
                }
                join(&mut pieces, (Kind::Involute, involute_from(rho0, ra)));
            }
            if seam.is_nan() || seam > 1e-6 * m {
                return Err("The root fillet does not meet the involute for these numbers.".to_string());
            }
            if pieces.iter().any(|(_, pts)| pts.iter().any(|p| p.1 <= 0.0 || p.0 > ra + 1e-9)) {
                return Err(undercut.to_string());
            }
            pieces[0].1[0].0 = rf;
            Ok(Side { pieces })
        }

        /// The whole outline with tooth 0 centred on `phase_deg` from +U, counter-clockwise: per tooth a root arc, the
        /// root fillet each side (two splines on an undercut gear), an involute spline each side, and a tip arc.
        pub fn outline(&self, phase_deg: f64) -> Result<Outline, String> {
            let side = self.side()?;
            let z = self.teeth;
            let rf = self.root_radius();
            let root_half = side.pieces[0].1[0].1;
            let tip = *side.pieces[side.pieces.len() - 1].1.last().expect("an involute");
            let pitch = 2.0 * PI / z as f64;
            let centre = |k: u32| (phase_deg + self.pitch_deg() * k as f64) * (PI / 180.0);
            let start = polar(rf, centre(0) - root_half);
            let piece = |kind: Kind, pts: &[P2]| {
                let to = pts[pts.len() - 1];
                if kind == Kind::Radial { Piece::Line(to) } else { Piece::Spline(pts[1..pts.len() - 1].to_vec(), to) }
            };
            let mut pieces: Vec<Piece> = Vec::new();
            for k in 0..z {
                let c = centre(k);
                // Up the clockwise flank, across the tip, down the counter-clockwise flank.
                for (kind, pts) in side.pieces.iter() {
                    let pts: Vec<P2> = pts.iter().map(|p| polar(p.0, c - p.1)).collect();
                    pieces.push(piece(*kind, &pts));
                }
                pieces.push(Piece::Arc(polar(tip.0, c), polar(tip.0, c + tip.1)));
                for (kind, pts) in side.pieces.iter().rev() {
                    let pts: Vec<P2> = pts.iter().rev().map(|p| polar(p.0, c + p.1)).collect();
                    pieces.push(piece(*kind, &pts));
                }
                // Along the root to the next tooth.
                let to = if k + 1 == z { start } else { polar(rf, centre(k + 1) - root_half) };
                pieces.push(Piece::Arc(polar(rf, c + pitch / 2.0), to));
            }
            // An arc so short it bows less than a micron (a root land at a high pressure angle) is a line: the kernel
            // takes three points that close to a line for no arc at all.
            let mut from = start;
            for piece in pieces.iter_mut() {
                let to = match piece {
                    Piece::Line(to) | Piece::Arc(_, to) | Piece::Spline(_, to) => *to,
                };
                if let Piece::Arc(through, _) = piece {
                    let (a, b) = ([through[0] - from[0], through[1] - from[1]], [to[0] - from[0], to[1] - from[1]]);
                    let span = (a[0] * a[0] + a[1] * a[1]).sqrt().max((b[0] * b[0] + b[1] * b[1]).sqrt()).max(1.0);
                    if (a[0] * b[1] - a[1] * b[0]).abs() <= 1e-5 * span {
                        *piece = Piece::Line(to);
                    }
                }
                from = to;
            }
            Ok(Outline { start, pieces })
        }

        /// The outline as points: `per_flank` steps along each fillet and each involute, and the arcs in steps of at
        /// most 3 degrees. For a preview or an area; extrude `outline(..).to_loop()` for the part.
        pub fn points(&self, phase_deg: f64, per_flank: usize) -> Result<Vec<P2>, String> {
            self.points_with(phase_deg, per_flank, 3.0)
        }

        fn points_with(&self, phase_deg: f64, per_flank: usize, arc_step_deg: f64) -> Result<Vec<P2>, String> {
            let n = per_flank.max(2);
            let side = self.side_with(n, n)?;
            let mut up: Vec<(f64, f64)> = Vec::new();
            for (_, pts) in side.pieces.iter() {
                let skip = usize::from(!up.is_empty());
                up.extend(pts[skip..].iter().copied());
            }
            let z = self.teeth;
            let rf = self.root_radius();
            let pitch = 2.0 * PI / z as f64;
            let mut pts: Vec<P2> = Vec::new();
            let arc = |pts: &mut Vec<P2>, rho: f64, a0: f64, a1: f64| {
                let steps = (((a1 - a0).abs() / (arc_step_deg * PI / 180.0)).ceil() as usize).max(1);
                for i in 1..steps {
                    pts.push(polar(rho, a0 + (a1 - a0) * i as f64 / steps as f64));
                }
            };
            for k in 0..z {
                let c = (phase_deg + self.pitch_deg() * k as f64) * (PI / 180.0);
                for p in up.iter() {
                    pts.push(polar(p.0, c - p.1));
                }
                let tip = up[up.len() - 1];
                arc(&mut pts, tip.0, c - tip.1, c + tip.1);
                for p in up.iter().rev() {
                    pts.push(polar(p.0, c + p.1));
                }
                let root = up[0].1;
                arc(&mut pts, rf, c + root, c + pitch - root);
            }
            Ok(pts)
        }

        /// The outline's area, mm², from a fine polyline: a check, and what an extrude of it holds per mm.
        pub fn area(&self) -> Result<f64, String> {
            let pts = self.points_with(0.0, 400, 0.05)?;
            let n = pts.len();
            let mut a2 = 0.0;
            for i in 0..n {
                let (p, q) = (pts[i], pts[(i + 1) % n]);
                a2 += p[0] * q[1] - p[1] * q[0];
            }
            Ok(a2 / 2.0)
        }

        /// The centre distance at which this gear meshes with `other` (same module and pressure angle): the sum of the
        /// pitch radii, or with profile shift the working distance (`inv aw = inv a + 2 tan a (x1 + x2) / (z1 + z2)`).
        pub fn centre_distance(&self, other: &Gear) -> f64 {
            let a0 = self.pitch_radius() + other.pitch_radius();
            let x = self.shift + other.shift;
            if x == 0.0 {
                return a0;
            }
            let (sa, ca) = sin_cos_deg(self.pressure_deg);
            let tan_a = sa / ca;
            let target = tan_a - atan(tan_a) + 2.0 * tan_a * x / (self.teeth + other.teeth) as f64;
            // Newton on inv(w) = tan w - w, from the pressure angle.
            let mut w = self.pressure_deg * (PI / 180.0);
            for _ in 0..40 {
                let (s, c) = sin_cos(w);
                let t = s / c;
                let f = t - w - target;
                w -= f / (t * t);
            }
            a0 * ca / sin_cos(w).1
        }
    }

    /// Phase (degrees) of a ring of `ring_z` teeth for a pinion of `own_z` teeth with tooth 0 at `own_phase_deg`, whose
    /// centre lies in direction `dir_deg` from the ring's centre, so each pinion tooth meets a space of the ring. Inside
    /// a ring both turn the same way, so a pinion tooth a fraction behind the pitch point meets a space as far behind it.
    pub fn mate_phase_internal(own_phase_deg: f64, own_z: u32, dir_deg: f64, ring_z: u32) -> f64 {
        let own_pitch = 360.0 / own_z as f64;
        let f = (((dir_deg - own_phase_deg) / own_pitch) % 1.0 + 1.0) % 1.0;
        dir_deg - (f + 0.5) * 360.0 / ring_z as f64
    }

    /// How far a ring of `ring_z` teeth turns when a pinion of `own_z` teeth inside it turns `own_turn_deg`: the same
    /// way, by the tooth ratio.
    pub fn ring_turn(own_turn_deg: f64, own_z: u32, ring_z: u32) -> f64 { own_turn_deg * own_z as f64 / ring_z as f64 }

    /// How far a rack travels, mm, when a pinion of `own_z` teeth and module `m` turns `own_turn_deg`: its pitch circle
    /// rolling along the rack's pitch line, `PI m z / 360` mm a degree.
    pub fn rack_travel(own_turn_deg: f64, own_z: u32, m: f64) -> f64 { own_turn_deg * PI * m * own_z as f64 / 360.0 }

    /// A straight rack (docs/plan-gear-kinds.md, stage 3): `teeth` teeth of module `module` along its own +U, pointing to
    /// +V, the pitch line on V = 0. Straight flanks at the pressure angle, addendum m, dedendum 1.25 m, each tooth
    /// `backlash` mm thinner at the pitch line, and a bar of `back` mm under the roots. Tooth k is centred on U = k PI m.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Rack {
        pub teeth: u32,
        pub module: f64,
        pub pressure_deg: f64,
        pub backlash: f64,
    }

    impl Rack {
        /// `teeth` of module `module` mm at 20 degrees and 0.1 mm backlash.
        pub fn new(teeth: u32, module: f64) -> Rack {
            Rack { teeth, module, pressure_deg: 20.0, backlash: 0.1 }
        }

        /// One tooth to the next, mm.
        pub fn pitch_mm(&self) -> f64 {
            PI * self.module
        }

        /// Half a tooth along the pitch line, at the tip and at the root, mm.
        fn halves(&self) -> (f64, f64, f64) {
            let (sa, ca) = sin_cos_deg(self.pressure_deg);
            let tan_a = sa / ca;
            let half = self.pitch_mm() / 4.0 - self.backlash / 2.0;
            (half, half - self.module * tan_a, half + 1.25 * self.module * tan_a)
        }

        /// The rack's ends along U: half a pitch before tooth 0 and after the last tooth.
        pub fn ends(&self) -> (f64, f64) {
            (-self.pitch_mm() / 2.0, (self.teeth as f64 - 0.5) * self.pitch_mm())
        }

        /// None when the numbers make a rack, else the sentence why not.
        pub fn refusal(&self) -> Option<String> {
            let ok = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
            if self.teeth < 1 || self.teeth > 400 {
                return Some("A rack takes 1 to 400 teeth.".to_string());
            }
            if !ok(self.module, 0.05, 50.0) {
                return Some("A gear's module is 0.05 to 50 mm.".to_string());
            }
            if !ok(self.pressure_deg, 10.0, 30.0) {
                return Some("A gear's pressure angle is 10 to 30 degrees.".to_string());
            }
            if !ok(self.backlash, 0.0, self.module) {
                return Some("A gear's backlash is 0 to one module, in mm at the pitch circle.".to_string());
            }
            let (_, tip, root) = self.halves();
            if tip <= 0.0 {
                return Some("These rack teeth come to a point below the tip: use a smaller pressure angle or less backlash.".to_string());
            }
            if 2.0 * root >= self.pitch_mm() {
                return Some("These rack teeth leave no root between them: use a smaller pressure angle.".to_string());
            }
            None
        }

        /// The rack's outline, counter-clockwise: along the bar's back, up its far end, back across every tooth from the
        /// last to the first, and down its near end. `phase_mm` moves every tooth along U; `back` is the bar under the roots.
        pub fn points(&self, phase_mm: f64, back: f64) -> Result<Vec<P2>, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let m = self.module;
            let (_, tip, root) = self.halves();
            let (u0, u1) = self.ends();
            let (yr, yb) = (-1.25 * m, -1.25 * m - back);
            let mut pts: Vec<P2> = vec![[u0 + phase_mm, yb], [u1 + phase_mm, yb], [u1 + phase_mm, yr]];
            let mut k = self.teeth;
            while k > 0 {
                k -= 1;
                let c = phase_mm + k as f64 * self.pitch_mm();
                pts.push([c + root, yr]);
                pts.push([c + tip, m]);
                pts.push([c - tip, m]);
                pts.push([c - root, yr]);
            }
            pts.push([u0 + phase_mm, yr]);
            Ok(pts)
        }

        /// The outline for `extrude.loops`: straight lines.
        pub fn outline(&self, phase_mm: f64, back: f64) -> Result<Outline, String> {
            let pts = self.points(phase_mm, back)?;
            let start = pts[0];
            let mut pieces: Vec<Piece> = Vec::new();
            for p in pts[1..].iter() {
                pieces.push(Piece::Line(*p));
            }
            pieces.push(Piece::Line(start));
            Ok(Outline { start, pieces })
        }
    }

    /// An internal spur gear, a ring with its teeth pointing in (docs/plan-gear-kinds.md, stage 2). Its space between two
    /// teeth is the tooth of an external gear of the same numbers: involute flanks from the tip circle `r - m` inside
    /// to the root circle `r + 1.25 m` outside, `backlash` mm wider at the pitch circle. Below the base circle a flank is
    /// a radial line. Tooth 0 is centred on the phase. No profile shift.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Ring {
        pub teeth: u32,
        pub module: f64,
        pub pressure_deg: f64,
        pub backlash: f64,
    }

    impl Ring {
        /// `teeth` of module `module` mm at 20 degrees and 0.1 mm backlash.
        pub fn new(teeth: u32, module: f64) -> Ring {
            Ring { teeth, module, pressure_deg: 20.0, backlash: 0.1 }
        }

        pub fn pitch_radius(&self) -> f64 {
            self.module * self.teeth as f64 / 2.0
        }

        pub fn base_radius(&self) -> f64 {
            self.pitch_radius() * sin_cos_deg(self.pressure_deg).1
        }

        /// The tips of the teeth, inside: the smallest radius of the outline.
        pub fn tip_radius(&self) -> f64 {
            self.pitch_radius() - self.module
        }

        /// The bottom of the spaces, outside: the largest radius of the outline.
        pub fn root_radius(&self) -> f64 {
            self.pitch_radius() + 1.25 * self.module
        }

        pub fn pitch_deg(&self) -> f64 {
            360.0 / self.teeth as f64
        }

        /// Half a space's angle at radius `rho`, from the involute; below the base circle the flank is radial.
        fn space_half(&self, rho: f64) -> f64 {
            let (sa, ca) = sin_cos_deg(self.pressure_deg);
            let tan_a = sa / ca;
            let r = self.pitch_radius();
            let rb = r * ca;
            let psi = PI / (2.0 * self.teeth as f64) + self.backlash / (2.0 * r);
            let at = if rho < rb { rb } else { rho };
            let t = (at * at - rb * rb).max(0.0).sqrt() / rb;
            psi + (tan_a - atan(tan_a)) - (t - atan(t))
        }

        /// None when the numbers make a ring, else the sentence why not.
        pub fn refusal(&self) -> Option<String> {
            let ok = |v: f64, lo: f64, hi: f64| v.is_finite() && v >= lo && v <= hi;
            if self.teeth < 20 || self.teeth > MAX_TEETH {
                return Some(format!("A ring gear takes 20 to {MAX_TEETH} teeth."));
            }
            if !ok(self.module, 0.05, 50.0) {
                return Some("A gear's module is 0.05 to 50 mm.".to_string());
            }
            if !ok(self.pressure_deg, 10.0, 30.0) {
                return Some("A gear's pressure angle is 10 to 30 degrees.".to_string());
            }
            if !ok(self.backlash, 0.0, self.module) {
                return Some("A gear's backlash is 0 to one module, in mm at the pitch circle.".to_string());
            }
            if self.space_half(self.root_radius()) <= 0.0 {
                return Some("This ring's spaces come to a point before the root: use more teeth or a smaller pressure angle.".to_string());
            }
            let pitch = 2.0 * PI / self.teeth as f64;
            if pitch - 2.0 * self.space_half(self.tip_radius()) <= 0.0 {
                return Some("This ring's teeth come to a point at the tip: use more teeth or a smaller pressure angle.".to_string());
            }
            None
        }

        /// One space's flank from the tip circle out to the root circle, as (radius, half-angle): a radial line up to the
        /// base circle when the tip is below it, then the involute in `steps` steps of its roll angle.
        fn flank(&self, steps: usize) -> Vec<(f64, f64)> {
            let rb = self.base_radius();
            let (ra, rf) = (self.tip_radius(), self.root_radius());
            let mut out: Vec<(f64, f64)> = Vec::new();
            let start = if ra < rb { rb } else { ra };
            if ra < rb {
                out.push((ra, self.space_half(rb)));
            }
            let t_of = |rho: f64| (rho * rho - rb * rb).max(0.0).sqrt() / rb;
            let (t0, t1) = (t_of(start), t_of(rf));
            let n = if steps < 2 { 2 } else { steps };
            for i in 0..=n {
                let t = t0 + (t1 - t0) * i as f64 / n as f64;
                let rho = if i == 0 { start } else if i == n { rf } else { rb * (1.0 + t * t).sqrt() };
                out.push((rho, self.space_half(rho)));
            }
            out
        }

        /// The toothed hole as points, counter-clockwise: `per_flank` steps along each flank, the arcs in steps of at
        /// most 3 degrees. Tooth 0 is centred on `phase_deg`, so space k is centred half a pitch after tooth k.
        pub fn points(&self, phase_deg: f64, per_flank: usize) -> Result<Vec<P2>, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let flank = self.flank(per_flank);
            let pitch = 2.0 * PI / self.teeth as f64;
            let (ra, rf) = (self.tip_radius(), self.root_radius());
            let step = 3.0 * PI / 180.0;
            let mut pts: Vec<P2> = Vec::new();
            for k in 0..self.teeth {
                let c = phase_deg * (PI / 180.0) + pitch * (k as f64 + 0.5);
                for p in flank.iter() {
                    pts.push(polar(p.0, c - p.1));
                }
                let root = flank[flank.len() - 1].1;
                let steps = ((2.0 * root / step).ceil() as usize).max(1);
                for i in 1..steps {
                    pts.push(polar(rf, c - root + 2.0 * root * i as f64 / steps as f64));
                }
                for p in flank.iter().rev() {
                    pts.push(polar(p.0, c + p.1));
                }
                let tip = flank[0].1;
                let span = pitch - 2.0 * tip;
                let steps = ((span / step).ceil() as usize).max(1);
                for i in 1..steps {
                    pts.push(polar(ra, c + tip + span * i as f64 / steps as f64));
                }
            }
            Ok(pts)
        }

        /// The toothed hole for `extrude.loops`, counter-clockwise: a line for a radial flank, a spline through each
        /// involute, an arc across each root and each tooth tip.
        pub fn outline(&self, phase_deg: f64) -> Result<Outline, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let flank = self.flank(FLANK_STEPS);
            let radial = flank.len() > FLANK_STEPS + 1;
            let pitch = 2.0 * PI / self.teeth as f64;
            let (ra, rf) = (self.tip_radius(), self.root_radius());
            let centre = |k: u32| phase_deg * (PI / 180.0) + pitch * (k as f64 + 0.5);
            let tip = flank[0].1;
            let start = polar(ra, centre(0) - tip);
            let mut pieces: Vec<Piece> = Vec::new();
            let involute = if radial { &flank[1..] } else { &flank[..] };
            for k in 0..self.teeth {
                let c = centre(k);
                // Out along the clockwise flank, across the root, in along the counter-clockwise flank.
                if radial {
                    pieces.push(Piece::Line(polar(involute[0].0, c - involute[0].1)));
                }
                let out: Vec<P2> = involute.iter().map(|p| polar(p.0, c - p.1)).collect();
                pieces.push(Piece::Spline(out[1..out.len() - 1].to_vec(), out[out.len() - 1]));
                let root = involute[involute.len() - 1].1;
                pieces.push(Piece::Arc(polar(rf, c), polar(rf, c + root)));
                let back: Vec<P2> = involute.iter().rev().map(|p| polar(p.0, c + p.1)).collect();
                pieces.push(Piece::Spline(back[1..back.len() - 1].to_vec(), back[back.len() - 1]));
                if radial {
                    pieces.push(Piece::Line(polar(ra, c + tip)));
                }
                // Across the tooth's tip to the next space.
                let to = if k + 1 == self.teeth { start } else { polar(ra, centre(k + 1) - tip) };
                pieces.push(Piece::Arc(polar(ra, c + pitch / 2.0), to));
            }
            Ok(Outline { start, pieces })
        }
    }
}

/// Pendulums (API 1.13, docs/plan-mass-properties.md): a simple pendulum's period from its length and its length from a
/// period, and a compound pendulum's period from what `model_mass {about:"hinge"}` reports (its moment of inertia about
/// the hinge, its mass, and the distance from the hinge to its centre of gravity). Small swings, standard gravity, no
/// friction. Only `*`, `/` and `sqrt`, so lust and rustc give the same bits; the window's `src/mass.ts` computes the same.
///
/// A pendulum recipe can take its period as the parameter and solve its own length:
/// `let rod = mech::pendulum_length(s.number("period", 0.75).get());`
pub mod mech {
    /// Standard gravity, mm/s².
    pub const G_MM_S2: f64 = 9806.65;

    /// A simple pendulum's period in seconds for a length in mm: `2π √(L / g)`.
    pub fn pendulum_period(length_mm: f64) -> f64 {
        2.0 * std::f64::consts::PI * (length_mm / G_MM_S2).sqrt()
    }

    /// The simple pendulum's length in mm that swings with a period in seconds: `g (T / 2π)²`.
    pub fn pendulum_length(period_s: f64) -> f64 {
        let k = period_s / (2.0 * std::f64::consts::PI);
        G_MM_S2 * k * k
    }

    /// A compound pendulum's small-swing period in seconds: `2π √(I / (m g d))`, with `inertia_g_mm2` its moment of
    /// inertia about the hinge in g·mm², `mass_g` its mass in g and `d_mm` the hinge's distance to its centre of gravity.
    pub fn compound_period(inertia_g_mm2: f64, mass_g: f64, d_mm: f64) -> f64 {
        2.0 * std::f64::consts::PI * (inertia_g_mm2 / (mass_g * G_MM_S2 * d_mm)).sqrt()
    }

    /// The simple pendulum with the same period as that compound one, mm: `I / (m d)`.
    pub fn equivalent_length(inertia_g_mm2: f64, mass_g: f64, d_mm: f64) -> f64 {
        inertia_g_mm2 / (mass_g * d_mm)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_clock_note_pendulum() {
            // 139.73 mm swings in 0.75 s, the note's seconds-beating half.
            assert!((pendulum_period(139.73) - 0.75).abs() < 1e-4);
            assert!((pendulum_length(0.75) - 139.73).abs() < 0.01);
            assert!((pendulum_length(pendulum_period(321.5)) - 321.5).abs() < 1e-9);
        }

        #[test]
        fn a_rod_about_its_end() {
            // A thin uniform rod of length L hung by its end: I = m L² / 3, d = L / 2, so T = 2π √(2L / 3g).
            let (l, m) = (200.0, 3.0);
            let t = compound_period(m * l * l / 3.0, m, l / 2.0);
            assert!((t - 2.0 * std::f64::consts::PI * (2.0 * l / (3.0 * G_MM_S2)).sqrt()).abs() < 1e-12);
            assert!((equivalent_length(m * l * l / 3.0, m, l / 2.0) - 2.0 * l / 3.0).abs() < 1e-9);
            assert!((pendulum_period(equivalent_length(m * l * l / 3.0, m, l / 2.0)) - t).abs() < 1e-12);
        }
    }
}

/// External spur gears on parallel axes: whether two of them mesh, from their outlines, without a kernel.
///
/// A recipe calls `classify` or `driven_turn`. The window's gear card and `model_check` report the same verdicts
/// (`docs/collision-prototype.md`). The check stays in this crate, so lust and rustc run it: tip circles first, then
/// module and pressure angle, then the centre distance and the mating phase with a segment test on the teeth of
/// `Gear::points` that face each other. No `Region::intersect`.
pub mod gear_pair {
    use super::gears::{mate_phase, mate_phase_internal, mate_turn, rack_travel, ring_turn, Gear, Rack, Ring, P2};
    use super::geom2d::{atan2, sin_cos_deg};

    const PI: f64 = std::f64::consts::PI;

    /// Steps along each fillet and each involute for the segment test. Enough that a move of 0.06 mm along the pitch
    /// circle, inside the usual backlash, does not read as a crossing, and the flanks are still the real outline.
    const PAIR_FLANK: usize = 8;

    /// How a pair of external spur gears stands.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum PairVerdict {
        /// The tip circles do not meet, so the tooth outlines were not compared. Gears of different modules that do
        /// not reach each other are apart too.
        Apart,
        /// Centre distance and phase are in mesh, and no tooth edges cross.
        Meshing,
        /// The centres are closer than the working distance by more than both backlashes.
        TooClose,
        /// The centres are farther than the working distance by more than both backlashes, the tip circles still
        /// meet, and no tooth edges cross.
        Loose,
        /// A tooth meets a tooth: the outlines cross, or the turn is past the play of a pair in the band.
        ToothOnTooth,
        /// `Gear::points` could not build an outline. The outlines were not compared.
        Unbuildable,
        /// The gears reach each other and their modules differ, so the pair is not a mesh.
        ModuleMismatch,
        /// The gears reach each other and their pressure angles differ, so the pair is not a mesh.
        PressureMismatch,
    }

    impl PairVerdict {
        /// The name `model_check` and the gear card use.
        pub fn as_str(self) -> &'static str {
            match self {
                Self::Apart => "apart",
                Self::Meshing => "meshing",
                Self::TooClose => "tooClose",
                Self::Loose => "loose",
                Self::ToothOnTooth => "toothOnTooth",
                Self::Unbuildable => "unbuildable",
                Self::ModuleMismatch => "moduleMismatch",
                Self::PressureMismatch => "pressureMismatch",
            }
        }

        /// The teeth cannot turn through this: the centres are too close, or a tooth meets a tooth.
        pub fn interferes(self) -> bool {
            matches!(self, Self::TooClose | Self::ToothOnTooth)
        }
    }

    /// One classification. `narrow` is whether the segment test ran. `hit` is whether two edges crossed.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct PairReport {
        pub verdict: PairVerdict,
        pub narrow: bool,
        pub hit: bool,
    }

    fn clear(verdict: PairVerdict) -> PairReport {
        PairReport { verdict, narrow: false, hit: false }
    }

    /// Direction from `a` to `b`, degrees, from the crate's arctangent so lust and rustc agree.
    fn bearing_deg(a: P2, b: P2) -> f64 {
        atan2(b[1] - a[1], b[0] - a[0]) * (180.0 / PI)
    }

    fn span(a: P2, b: P2) -> f64 {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        (dx * dx + dy * dy).sqrt()
    }

    /// Phase error folded into half a tooth either way. A gear of `pitch` degrees per tooth looks the same turned by
    /// a whole tooth, and `mate_phase` jumps by one tooth when its fraction wraps, while `mate_turn` does not.
    /// `%` truncates toward zero, so a negative remainder is put back by hand.
    fn tooth_err_deg(delta: f64, pitch: f64) -> f64 {
        if pitch <= 0.0 {
            return delta;
        }
        let mut d = delta % pitch;
        let half = pitch / 2.0;
        if d > half {
            d -= pitch;
        } else if d < -half {
            d += pitch;
        }
        d
    }

    fn orient(a: P2, b: P2, c: P2) -> f64 {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    }

    /// A proper crossing of the open segments. Touching at an endpoint, or lying on the same line, is not a hit:
    /// a mesh with backlash has a gap, and a chord of a convex flank stays inside the tooth.
    fn segments_cross(a: P2, b: P2, c: P2, d: P2) -> bool {
        let o1 = orient(a, b, c);
        let o2 = orient(a, b, d);
        let o3 = orient(c, d, a);
        let o4 = orient(c, d, b);
        o1 * o2 < 0.0 && o3 * o4 < 0.0
    }

    fn boxes_apart(a: P2, b: P2, c: P2, d: P2) -> bool {
        let (ax0, ax1) = if a[0] < b[0] { (a[0], b[0]) } else { (b[0], a[0]) };
        let (ay0, ay1) = if a[1] < b[1] { (a[1], b[1]) } else { (b[1], a[1]) };
        let (bx0, bx1) = if c[0] < d[0] { (c[0], d[0]) } else { (d[0], c[0]) };
        let (by0, by1) = if c[1] < d[1] { (c[1], d[1]) } else { (d[1], c[1]) };
        ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0
    }

    fn placed(gear: &Gear, centre: P2, phase_deg: f64) -> Option<Vec<P2>> {
        let local = gear.points(phase_deg, PAIR_FLANK).ok()?;
        let mut world = Vec::new();
        for p in local {
            world.push([p[0] + centre[0], p[1] + centre[1]]);
        }
        Some(world)
    }

    /// Whether the segment `a`-`b` comes within `radius` of `centre`.
    fn reaches(a: P2, b: P2, centre: P2, radius: f64) -> bool {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let along = if len2 > 0.0 { ((centre[0] - a[0]) * dx + (centre[1] - a[1]) * dy) / len2 } else { 0.0 };
        let t = along.clamp(0.0, 1.0);
        let (px, py) = (a[0] + t * dx - centre[0], a[1] + t * dy - centre[1]);
        px * px + py * py <= radius * radius
    }

    /// The edges of a closed outline that come inside the other gear's tip circle. Two outlines can only cross
    /// there, so a pair in mesh compares the few teeth that face each other and not every tooth with every tooth.
    fn edges_within(outline: &[P2], centre: P2, radius: f64) -> Vec<(P2, P2)> {
        let n = outline.len();
        let mut edges = Vec::new();
        for i in 0..n {
            let (a, b) = (outline[i], outline[(i + 1) % n]);
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            if dx * dx + dy * dy < 1e-24 {
                continue;
            }
            if reaches(a, b, centre, radius) {
                edges.push((a, b));
            }
        }
        edges
    }

    fn outlines_cross(driver: &[P2], driver_at: P2, driver_tip: f64, driven: &[P2], driven_at: P2, driven_tip: f64) -> bool {
        if driver.len() < 2 || driven.len() < 2 {
            return false;
        }
        let near = edges_within(driver, driven_at, driven_tip + 1e-6);
        let far = edges_within(driven, driver_at, driver_tip + 1e-6);
        for edge in &near {
            let (a, b) = *edge;
            for other in &far {
                let (c, d) = *other;
                if !boxes_apart(a, b, c, d) && segments_cross(a, b, c, d) {
                    return true;
                }
            }
        }
        false
    }

    /// Classify two external spur gears. `driver_phase_deg` is tooth 0 of the driver from +U, and
    /// `driven_phase_deg` is tooth 0 of the driven gear, both in degrees in the same plane as the centres.
    ///
    /// Tip circles that do not meet are `Apart`, whatever the gears are: two stages of a train with different
    /// modules are not a fault. Gears that do reach each other are compared by module and pressure angle first,
    /// then by their outlines. The radial band is both backlashes either side of the working distance: closer is
    /// `TooClose`, and farther, with no edge crossing, is `Loose`. A segment that crosses is `ToothOnTooth` at
    /// any distance. Inside the band, play along the pitch circle, one way from the centred mesh, is half both
    /// backlashes plus `(distance - working) * tan(pressure)`: a turn past it is `ToothOnTooth` too, since the
    /// flanks touch there before two chords of the outline cross. An outline `Gear` cannot build is `Unbuildable`
    /// and `narrow` is false.
    pub fn classify(driver: &Gear, driven: &Gear, driver_at: P2, driven_at: P2, driver_phase_deg: f64, driven_phase_deg: f64) -> PairReport {
        let distance = span(driver_at, driven_at);
        let reach = driver.tip_radius() + driven.tip_radius();
        if distance > reach + 1e-9 {
            return clear(PairVerdict::Apart);
        }
        if (driver.module - driven.module).abs() > 1e-9 {
            return clear(PairVerdict::ModuleMismatch);
        }
        if (driver.pressure_deg - driven.pressure_deg).abs() > 1e-6 {
            return clear(PairVerdict::PressureMismatch);
        }
        let outlines = match (placed(driver, driver_at, driver_phase_deg), placed(driven, driven_at, driven_phase_deg)) {
            (Some(a), Some(b)) => Some((a, b)),
            _ => None,
        };
        let Some((a, b)) = outlines else {
            return clear(PairVerdict::Unbuildable);
        };
        let working = driver.centre_distance(driven);
        let backlash = driver.backlash + driven.backlash;
        let too_close = distance + 1e-9 < working - backlash;
        // Farther than the working distance by more than both backlashes. The mirror of too_close, strict, so the
        // edge itself (working + both backlashes) stays in the band.
        let loose = distance > working + backlash + 1e-9;
        let expect = mate_phase(driver_phase_deg, driver.teeth, bearing_deg(driver_at, driven_at), driven.teeth);
        let err_mm = tooth_err_deg(driven_phase_deg - expect, driven.pitch_deg()).abs() * (PI / 180.0) * driven.pitch_radius();
        let (sa, ca) = sin_cos_deg(driver.pressure_deg);
        let tan_a = if ca == 0.0 { 0.0 } else { sa / ca };
        let allowed = backlash / 2.0 + (distance - working) * tan_a;
        let past_play = err_mm > allowed + 1e-9;
        let hit = outlines_cross(&a, driver_at, driver.tip_radius(), &b, driven_at, driven.tip_radius());
        let verdict = if too_close {
            PairVerdict::TooClose
        } else if hit {
            PairVerdict::ToothOnTooth
        } else if loose {
            PairVerdict::Loose
        } else if past_play {
            PairVerdict::ToothOnTooth
        } else {
            PairVerdict::Meshing
        };
        PairReport { verdict, narrow: true, hit }
    }

    /// `classify` after the driver turns `angle_deg` from `driver_phase_deg` and the driven gear turns with it
    /// by `mate_turn`. The centres stay put. This is the turn of a meshing pair; it is not a joint in the
    /// assembly pose.
    pub fn driven_turn(driver: &Gear, driven: &Gear, driver_at: P2, driven_at: P2, driver_phase_deg: f64, driven_phase_deg: f64, angle_deg: f64) -> PairReport {
        let follow = driven_phase_deg + mate_turn(angle_deg, driver.teeth, driven.teeth);
        classify(driver, driven, driver_at, driven_at, driver_phase_deg + angle_deg, follow)
    }

    /// The edges of a closed outline that reach outside the circle of `radius` about `centre`: a pinion inside a ring
    /// can only meet the ring's teeth there.
    fn edges_beyond(outline: &[P2], centre: P2, radius: f64) -> Vec<(P2, P2)> {
        let n = outline.len();
        let mut edges = Vec::new();
        let r2 = radius * radius;
        for i in 0..n {
            let (a, b) = (outline[i], outline[(i + 1) % n]);
            let da = (a[0] - centre[0]) * (a[0] - centre[0]) + (a[1] - centre[1]) * (a[1] - centre[1]);
            let db = (b[0] - centre[0]) * (b[0] - centre[0]) + (b[1] - centre[1]) * (b[1] - centre[1]);
            if da >= r2 || db >= r2 {
                edges.push((a, b));
            }
        }
        edges
    }

    /// An external pinion inside an internal ring (docs/plan-gear-kinds.md, stage 2), both turning the same way.
    /// `pinion_phase_deg` is the pinion's tooth 0 and `ring_phase_deg` the ring's, from +U in the plane of the centres.
    ///
    /// The pinion's tips not reaching the ring's tip circle is `Apart`, and so is a pinion outside the ring. Modules and
    /// pressure angles are compared, then the working distance `m (z_ring - z_pinion) / 2`: a pinion pushed farther out
    /// than that into the ring's teeth by more than both backlashes is `TooClose`, and one held farther in is `Loose`.
    /// The mating phase is `mate_phase_internal`; inside the band a turn past the play is `ToothOnTooth`, and two edges
    /// that cross are `ToothOnTooth` at any distance. A ring with profile shift on its pinion is not covered here: the
    /// pinion's shift moves the working distance, and a pair with a shifted pinion is compared at the unshifted one.
    pub fn classify_internal(pinion: &Gear, ring: &Ring, pinion_at: P2, ring_at: P2, pinion_phase_deg: f64, ring_phase_deg: f64) -> PairReport {
        let distance = span(ring_at, pinion_at);
        if distance + pinion.tip_radius() < ring.tip_radius() - 1e-9 || distance - pinion.tip_radius() > ring.root_radius() + 1e-9 {
            return clear(PairVerdict::Apart);
        }
        if (pinion.module - ring.module).abs() > 1e-9 {
            return clear(PairVerdict::ModuleMismatch);
        }
        if (pinion.pressure_deg - ring.pressure_deg).abs() > 1e-6 {
            return clear(PairVerdict::PressureMismatch);
        }
        let a = placed(pinion, pinion_at, pinion_phase_deg);
        let b = match ring.points(ring_phase_deg, PAIR_FLANK) {
            Ok(local) => {
                let mut world = Vec::new();
                for p in local {
                    world.push([p[0] + ring_at[0], p[1] + ring_at[1]]);
                }
                Some(world)
            }
            Err(_) => None,
        };
        let (Some(a), Some(b)) = (a, b) else {
            return clear(PairVerdict::Unbuildable);
        };
        let working = ring.pitch_radius() - pinion.pitch_radius();
        let backlash = pinion.backlash + ring.backlash;
        let too_close = distance > working + backlash + 1e-9;
        let loose = distance + 1e-9 < working - backlash;
        let expect = mate_phase_internal(pinion_phase_deg, pinion.teeth, bearing_deg(ring_at, pinion_at), ring.teeth);
        let err_mm = tooth_err_deg(ring_phase_deg - expect, ring.pitch_deg()).abs() * (PI / 180.0) * ring.pitch_radius();
        let (sa, ca) = sin_cos_deg(pinion.pressure_deg);
        let tan_a = if ca == 0.0 { 0.0 } else { sa / ca };
        let allowed = backlash / 2.0 + (working - distance) * tan_a;
        let past_play = err_mm > allowed + 1e-9;
        let near = edges_beyond(&a, ring_at, ring.tip_radius() - 1e-6);
        let far = edges_within(&b, pinion_at, pinion.tip_radius() + 1e-6);
        let mut hit = false;
        for edge in &near {
            let (p, q) = *edge;
            for other in &far {
                let (c, d) = *other;
                if !boxes_apart(p, q, c, d) && segments_cross(p, q, c, d) {
                    hit = true;
                }
            }
        }
        let verdict = if too_close {
            PairVerdict::TooClose
        } else if hit {
            PairVerdict::ToothOnTooth
        } else if loose {
            PairVerdict::Loose
        } else if past_play {
            PairVerdict::ToothOnTooth
        } else {
            PairVerdict::Meshing
        };
        PairReport { verdict, narrow: true, hit }
    }

    /// `classify_internal` after the pinion turns `angle_deg` and the ring turns with it, the same way, by the tooth
    /// ratio. The centres stay put.
    pub fn internal_turn(pinion: &Gear, ring: &Ring, pinion_at: P2, ring_at: P2, pinion_phase_deg: f64, ring_phase_deg: f64, angle_deg: f64) -> PairReport {
        let follow = ring_phase_deg + ring_turn(angle_deg, pinion.teeth, ring.teeth);
        classify_internal(pinion, ring, pinion_at, ring_at, pinion_phase_deg + angle_deg, follow)
    }

    /// A pinion against a rack (docs/plan-gear-kinds.md, stage 3), in the rack's frame: the rack's teeth along +U point
    /// to +V with tooth 0 at U = `rack_phase_mm` and the pitch line on V = 0; the pinion's centre is `pinion_at`, its tooth
    /// 0 at `pinion_phase_deg` from +U. The rack's bar is taken as one module deep for the test; it never reaches a
    /// pinion that meshes.
    ///
    /// Apart when the pinion's tips stand clear of the rack's tips, or off its ends. Then module and pressure angle; then
    /// the working distance from the pitch line, the pinion's pitch radius plus its shift: nearer by more than both
    /// backlashes is `TooClose`, farther is `Loose`. The mating phase: a pinion turning one way rolls its pitch circle along
    /// the pitch line, so a tooth a fraction of a pitch behind the line's foot meets a space as far behind it. Inside the
    /// band a turn past the play is `ToothOnTooth`, and two edges that cross are `ToothOnTooth` at any distance.
    pub fn classify_rack(pinion: &Gear, rack: &Rack, pinion_at: P2, pinion_phase_deg: f64, rack_phase_mm: f64) -> PairReport {
        let m = rack.module;
        let d = pinion_at[1];
        let (u0, u1) = rack.ends();
        let (lo, hi) = (u0 + rack_phase_mm, u1 + rack_phase_mm);
        let tip = pinion.tip_radius();
        let off = if pinion_at[0] < lo { lo - pinion_at[0] } else if pinion_at[0] > hi { pinion_at[0] - hi } else { 0.0 };
        if d - tip > m + 1e-9 || off > tip + 1e-9 || d < -1.25 * m - tip {
            return clear(PairVerdict::Apart);
        }
        if (pinion.module - m).abs() > 1e-9 {
            return clear(PairVerdict::ModuleMismatch);
        }
        if (pinion.pressure_deg - rack.pressure_deg).abs() > 1e-6 {
            return clear(PairVerdict::PressureMismatch);
        }
        let a = placed(pinion, pinion_at, pinion_phase_deg);
        let b = rack.points(rack_phase_mm, m).ok();
        let (Some(a), Some(b)) = (a, b) else {
            return clear(PairVerdict::Unbuildable);
        };
        let working = pinion.pitch_radius() + pinion.shift * m;
        let backlash = pinion.backlash + rack.backlash;
        let too_close = d + 1e-9 < working - backlash;
        let loose = d > working + backlash + 1e-9;
        // The foot of the pinion's centre on the pitch line is at -90 degrees from it; turning +, the pitch point moves +U.
        let pitch = pinion.pitch_deg();
        let f = (((-90.0 - pinion_phase_deg) / pitch) % 1.0 + 1.0) % 1.0;
        let p_mm = rack.pitch_mm();
        let expect = pinion_at[0] - f * p_mm + p_mm / 2.0;
        let err_mm = tooth_err_deg(rack_phase_mm - expect, p_mm).abs();
        let (sa, ca) = sin_cos_deg(pinion.pressure_deg);
        let tan_a = if ca == 0.0 { 0.0 } else { sa / ca };
        let allowed = backlash / 2.0 + (d - working) * tan_a;
        let past_play = err_mm > allowed + 1e-9;
        let near = edges_within(&b, pinion_at, tip + 1e-6);
        let mut hit = false;
        let n = a.len();
        for i in 0..n {
            let (p, q) = (a[i], a[(i + 1) % n]);
            if p[1] > m + 1e-6 && q[1] > m + 1e-6 {
                continue;
            }
            for other in &near {
                let (c, e) = *other;
                if !boxes_apart(p, q, c, e) && segments_cross(p, q, c, e) {
                    hit = true;
                }
            }
        }
        let verdict = if too_close {
            PairVerdict::TooClose
        } else if hit {
            PairVerdict::ToothOnTooth
        } else if loose {
            PairVerdict::Loose
        } else if past_play {
            PairVerdict::ToothOnTooth
        } else {
            PairVerdict::Meshing
        };
        PairReport { verdict, narrow: true, hit }
    }

    /// `classify_rack` after the pinion turns `angle_deg` and the rack travels with it, `rack_travel` mm along +U.
    pub fn rack_turn(pinion: &Gear, rack: &Rack, pinion_at: P2, pinion_phase_deg: f64, rack_phase_mm: f64, angle_deg: f64) -> PairReport {
        let travel = rack_travel(angle_deg, pinion.teeth, rack.module);
        classify_rack(pinion, rack, pinion_at, pinion_phase_deg + angle_deg, rack_phase_mm + travel)
    }
}

/// Clock ingredients (API 1.14): what a mechanical clock needs that `gears` does not have. Pure functions, no calls,
/// the crate's own trig, so lust and rustc give the same numbers (`tests/horology.rs`, `mcp/recipe-horology.test.ts`).
/// Sizes in mm, angles in degrees unless a name says otherwise. Outlines are `gears::Outline`, closed and
/// counter-clockwise: `to_loop()` is one loop for `extrude`, `outline_points` a polyline for a preview or a check.
///
/// - Going train: `train_ratio`, `escape_period_s`, and `count_train` / `train_options`, which find tooth counts that
///   give a pendulum's period exactly.
/// - Graham (deadbeat) escapement: `EscapeWheel` (pointed teeth leaning forward) and `Graham` (the anchor, its pallets,
///   where it stands and how far it swings, and `refusal`).
/// - Winding: `Ratchet` (saw teeth) and its `click` (the pawl, with its pivot, seat angle and lift).
/// - Cycloidal clock teeth after BS 978-2: `ClockWheel` (epicycloidal addenda) and `ClockPinion` (radial flanks).
/// - Bores: `fit_clearance`, `hole`, `shaft`, `pin_bore` (ISO 286 fits) and the small bearings in `bearing`.
pub mod horology {
    use super::gears::{Outline, Piece, P2};
    use super::geom2d::{atan2, clamp, sin_cos, sin_cos_deg};

    const PI: f64 = std::f64::consts::PI;
    const DEG: f64 = PI / 180.0;

    fn polar(rho: f64, a: f64) -> P2 {
        let (s, c) = sin_cos(a);
        [rho * c, rho * s]
    }
    fn rot(p: P2, a: f64) -> P2 {
        let (s, c) = sin_cos(a);
        [p[0] * c - p[1] * s, p[0] * s + p[1] * c]
    }
    fn sub(a: P2, b: P2) -> P2 {
        [a[0] - b[0], a[1] - b[1]]
    }
    fn add(a: P2, b: P2) -> P2 {
        [a[0] + b[0], a[1] + b[1]]
    }
    fn mul(a: P2, k: f64) -> P2 {
        [a[0] * k, a[1] * k]
    }
    fn dot(a: P2, b: P2) -> f64 {
        a[0] * b[0] + a[1] * b[1]
    }
    fn cross(a: P2, b: P2) -> f64 {
        a[0] * b[1] - a[1] * b[0]
    }
    fn len(a: P2) -> f64 {
        (a[0] * a[0] + a[1] * a[1]).sqrt()
    }
    fn angle(p: P2) -> f64 {
        atan2(p[1], p[0])
    }
    fn mirror(p: P2) -> P2 {
        [p[0], -p[1]]
    }
    /// arccos and arcsin from `atan2` and `sqrt`, so lust and rustc agree to the bit.
    fn acos(x: f64) -> f64 {
        atan2((1.0 - x * x).max(0.0).sqrt(), x)
    }
    fn asin(x: f64) -> f64 {
        atan2(x, (1.0 - x * x).max(0.0).sqrt())
    }
    fn ok(v: f64, lo: f64, hi: f64) -> bool {
        v.is_finite() && v >= lo && v <= hi
    }
    /// The distance from `p` to the segment a..b.
    fn seg_dist(p: P2, a: P2, b: P2) -> f64 {
        let d = sub(b, a);
        let l2 = dot(d, d);
        let t = if l2 > 0.0 { clamp(dot(sub(p, a), d) / l2, 0.0, 1.0) } else { 0.0 };
        len(sub(p, add(a, mul(d, t))))
    }
    /// Whether the segments a..b and c..d cross (touching does not count).
    fn crosses(a: P2, b: P2, c: P2, d: P2) -> bool {
        let d1 = cross(sub(b, a), sub(c, a));
        let d2 = cross(sub(b, a), sub(d, a));
        let d3 = cross(sub(d, c), sub(a, c));
        let d4 = cross(sub(d, c), sub(b, c));
        d1 * d2 < 0.0 && d3 * d4 < 0.0
    }

    /// The points of a closed outline: lines and spline points as they are, arcs in steps of at most `arc_step_deg`. The
    /// start is not repeated at the end. For a preview, an area or a check; extrude `outline.to_loop()` for the part.
    pub fn outline_points(outline: &Outline, arc_step_deg: f64) -> Vec<P2> {
        let step = arc_step_deg.max(0.01) * DEG;
        let mut pts: Vec<P2> = vec![outline.start];
        let mut from = outline.start;
        for piece in outline.pieces.iter() {
            match piece {
                Piece::Line(to) => {
                    pts.push(*to);
                    from = *to;
                }
                Piece::Spline(through, to) => {
                    for p in through.iter() {
                        pts.push(*p);
                    }
                    pts.push(*to);
                    from = *to;
                }
                Piece::Arc(through, to) => {
                    arc_points(&mut pts, from, *through, *to, step);
                    from = *to;
                }
            }
        }
        if pts.len() > 1 {
            pts.pop();
        }
        pts
    }

    /// The arc from `a` through `b` to `c`, after `a`, in steps of at most `step` radians.
    fn arc_points(pts: &mut Vec<P2>, a: P2, b: P2, c: P2, step: f64) {
        let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
        if d.abs() < 1e-18 {
            pts.push(c);
            return;
        }
        let (a2, b2, c2) = (dot(a, a), dot(b, b), dot(c, c));
        let o = [
            (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
            (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
        ];
        let rho = len(sub(a, o));
        let ccw = cross(sub(b, a), sub(c, b)) > 0.0;
        let a0 = angle(sub(a, o));
        let mut a1 = angle(sub(c, o));
        if ccw {
            while a1 <= a0 {
                a1 += 2.0 * PI;
            }
        } else {
            while a1 >= a0 {
                a1 -= 2.0 * PI;
            }
        }
        let n = (((a1 - a0).abs() / step).ceil() as usize).max(1);
        for i in 1..n {
            pts.push(add(o, polar(rho, a0 + (a1 - a0) * i as f64 / n as f64)));
        }
        pts.push(c);
    }

    // ---- The going train. ----

    /// The ratio of a train of `(wheel teeth, pinion leaves)` stages: the product of the wheels over the product of the
    /// pinions. The note's train `[(64, 8), (50, 10), (40, 10)]` is 160.
    pub fn train_ratio(stages: &[(u32, u32)]) -> f64 {
        let mut wheels = 1.0;
        let mut pinions = 1.0;
        for s in stages.iter() {
            wheels *= s.0 as f64;
            pinions *= s.1 as f64;
        }
        wheels / pinions
    }

    /// The pendulum's period, seconds, for a train from the centre arbor (one turn an hour) to an escape wheel of
    /// `escape_teeth`: the wheel lets one tooth pass per period (two beats), so `3600 / (ratio × teeth)`. 160:1 with
    /// 30 teeth is 0.75 s; 60:1 with 30 teeth is the seconds pendulum's 2 s.
    pub fn escape_period_s(centre_to_escape_ratio: f64, escape_teeth: u32) -> f64 {
        3600.0 / (centre_to_escape_ratio * escape_teeth as f64)
    }

    /// The tooth counts `count_train` may use: wheels of `wheel_min..=wheel_max` teeth, pinions of
    /// `pinion_min..=pinion_max` leaves.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct TrainLimits {
        pub wheel_min: u32,
        pub wheel_max: u32,
        pub pinion_min: u32,
        pub pinion_max: u32,
    }

    impl TrainLimits {
        pub fn new(wheel_min: u32, wheel_max: u32, pinion_min: u32, pinion_max: u32) -> TrainLimits {
            TrainLimits { wheel_min, wheel_max, pinion_min, pinion_max }
        }

        fn refusal(&self) -> Option<String> {
            if self.pinion_min < 4 || self.pinion_max > 40 || self.pinion_min > self.pinion_max {
                return Some("Pinions take 4 to 40 leaves, the least first.".to_string());
            }
            if self.wheel_max > 400 || self.wheel_min > self.wheel_max || self.wheel_max <= self.pinion_min {
                return Some("Wheels take up to 400 teeth, the least first, and more than the smallest pinion.".to_string());
            }
            None
        }
    }

    /// A going train: `stages` from the centre arbor to the escape arbor as `(wheel teeth, pinion leaves)`, the largest
    /// ratio first, and the escape wheel's teeth.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Train {
        pub stages: Vec<(u32, u32)>,
        pub escape_teeth: u32,
    }

    impl Train {
        pub fn ratio(&self) -> f64 {
            train_ratio(&self.stages)
        }

        pub fn period_s(&self) -> f64 {
            escape_period_s(self.ratio(), self.escape_teeth)
        }
    }

    fn gcd(a: u64, b: u64) -> u64 {
        let (mut a, mut b) = (a, b);
        while b != 0 {
            let t = a % b;
            a = b;
            b = t;
        }
        a
    }

    fn pow(x: u64, n: u32) -> u64 {
        let mut r = 1;
        for _ in 0..n {
            r *= x;
        }
        r
    }

    /// Whether stage `a` comes before stage `b` in a train: a larger ratio, or the same ratio on more teeth.
    fn before(a: (u32, u32), b: (u32, u32)) -> bool {
        let (x, y) = (a.0 as u64 * b.1 as u64, b.0 as u64 * a.1 as u64);
        x > y || (x == y && a.0 > b.0)
    }

    /// The ratio a period asks, as a fraction in lowest terms with a denominator up to 10000.
    fn wanted_ratio(period_s: f64, escape_teeth: u32) -> Result<(u64, u64), String> {
        let r = 3600.0 / (period_s * escape_teeth as f64);
        if !(r.is_finite() && r > 1.0 && r <= 1e6) {
            return Err("The period and the escape wheel ask a ratio from 1 to a million to one; this one is outside.".to_string());
        }
        for q in 1..=10000u64 {
            let p = (r * q as f64).round();
            if p >= 1.0 && (p / q as f64 - r).abs() <= 1e-9 * r {
                let p = p as u64;
                let g = gcd(p, q);
                return Ok((p / g, q / g));
            }
        }
        Err("The period and the escape wheel ask a ratio that no whole tooth counts give exactly.".to_string())
    }

    /// Every train of `left` more stages from `list[start..]` (sorted, `before` order) whose ratio is `num / den`.
    #[allow(clippy::too_many_arguments)]
    fn search(list: &[(u32, u32)], limits: &TrainLimits, start: usize, left: u32, num: u64, den: u64, chosen: &mut Vec<(u32, u32)>, found: &mut Vec<Vec<(u32, u32)>>) {
        if left == 1 {
            for p in limits.pinion_min..=limits.pinion_max {
                let top = num * p as u64;
                if top % den != 0 {
                    continue;
                }
                let w = top / den;
                if w < limits.wheel_min as u64 || w > limits.wheel_max as u64 || w <= p as u64 {
                    continue;
                }
                let stage = (w as u32, p);
                if let Some(last) = chosen.last() {
                    if before(stage, *last) {
                        continue;
                    }
                }
                let mut train = chosen.clone();
                train.push(stage);
                found.push(train);
            }
            return;
        }
        for i in start..list.len() {
            let (w, p) = list[i];
            let (w64, p64) = (w as u64, p as u64);
            // The later stages are no larger than this one, so this one to the power `left` must reach the ratio; the
            // list only gets smaller from here.
            if num * pow(p64, left) > den * pow(w64, left) {
                break;
            }
            // The later stages each gear up, so what is left after this one must be more than one.
            if num * p64 <= den * w64 {
                continue;
            }
            let (n2, d2) = (num * p64, den * w64);
            let g = gcd(n2, d2);
            chosen.push((w, p));
            search(list, limits, i, left - 1, n2 / g, d2 / g, chosen, found);
            chosen.pop();
        }
    }

    /// The order `train_options` gives: the smaller largest stage (a balanced train), then the larger smallest pinion
    /// (more leaves run smoother), then fewer teeth in all, then stage by stage the larger wheel.
    fn rank(a: &[(u32, u32)], b: &[(u32, u32)]) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        let (x, y) = (a[0].0 as u64 * b[0].1 as u64, b[0].0 as u64 * a[0].1 as u64);
        if x != y {
            return if x < y { Ordering::Less } else { Ordering::Greater };
        }
        let mut pa = u32::MAX;
        let mut pb = u32::MAX;
        let mut ta = 0u32;
        let mut tb = 0u32;
        for s in a.iter() {
            pa = pa.min(s.1);
            ta += s.0 + s.1;
        }
        for s in b.iter() {
            pb = pb.min(s.1);
            tb += s.0 + s.1;
        }
        if pa != pb {
            return pb.cmp(&pa);
        }
        if ta != tb {
            return ta.cmp(&tb);
        }
        for k in 0..a.len().min(b.len()) {
            if a[k] != b[k] {
                return b[k].0.cmp(&a[k].0).then(b[k].1.cmp(&a[k].1));
            }
        }
        Ordering::Equal
    }

    /// Every train of `stages` stages (1 to 4) within `limits` whose ratio gives `period_s` with an escape wheel of
    /// `escape_teeth` exactly (the ratio `3600 / (period × teeth)`, which must be a fraction with a denominator up to
    /// 10000), best first in `count_train`'s order. Each train lists its stages largest ratio first, as they run from
    /// the centre arbor. The same input gives the same list, in the same order.
    pub fn train_options(period_s: f64, escape_teeth: u32, stages: u32, limits: &TrainLimits) -> Result<Vec<Train>, String> {
        if !(1..=4).contains(&stages) {
            return Err("A going train has 1 to 4 stages.".to_string());
        }
        if !(6..=400).contains(&escape_teeth) {
            return Err("An escape wheel takes 6 to 400 teeth.".to_string());
        }
        if let Some(why) = limits.refusal() {
            return Err(why);
        }
        let (num, den) = wanted_ratio(period_s, escape_teeth)?;
        let mut list: Vec<(u32, u32)> = Vec::new();
        for w in limits.wheel_min..=limits.wheel_max {
            for p in limits.pinion_min..=limits.pinion_max {
                if w > p {
                    list.push((w, p));
                }
            }
        }
        list.sort_by(|a, b| {
            if before(*a, *b) {
                std::cmp::Ordering::Less
            } else if before(*b, *a) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        let mut found: Vec<Vec<(u32, u32)>> = Vec::new();
        let mut chosen: Vec<(u32, u32)> = Vec::new();
        search(&list, limits, 0, stages, num, den, &mut chosen, &mut found);
        if found.is_empty() {
            return Err(format!(
                "No train of {stages} stages with wheels of {} to {} teeth and pinions of {} to {} leaves gives {num}:{den} exactly.",
                limits.wheel_min, limits.wheel_max, limits.pinion_min, limits.pinion_max
            ));
        }
        found.sort_by(|a, b| rank(a, b));
        let mut trains: Vec<Train> = Vec::new();
        for stages in found.into_iter() {
            trains.push(Train { stages, escape_teeth });
        }
        Ok(trains)
    }

    /// The best train `train_options` finds: the one whose largest stage is smallest, then with the most leaves in its
    /// smallest pinion, then with the fewest teeth. 0.75 s on 30 teeth in 3 stages of wheels 40 to 64 and pinions 8 to
    /// 10 is 160:1; the note's 64/8 × 50/10 × 40/10 is one of the options.
    pub fn count_train(period_s: f64, escape_teeth: u32, stages: u32, limits: &TrainLimits) -> Result<Train, String> {
        let mut trains = train_options(period_s, escape_teeth, stages, limits)?;
        Ok(trains.remove(0))
    }

    // ---- The Graham escapement. ----

    /// A Graham escape wheel: `teeth` pointed teeth, tips on `tip_radius`, roots on `root_radius`, turning clockwise
    /// (seen from +Z). Each tooth's front face leans forward by `lean_deg` from the radius through its tip, so the tip
    /// overhangs and a pallet touches the tip only; its back runs from the tip to the root circle so the tooth's root
    /// takes `root_share` of the pitch (1/3 by default). The gaps are arcs on the root circle. Mirror the x of every
    /// point (and reverse the order) for a wheel that turns counter-clockwise.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct EscapeWheel {
        pub teeth: u32,
        pub tip_radius: f64,
        pub root_radius: f64,
        pub lean_deg: f64,
        pub root_share: f64,
    }

    impl EscapeWheel {
        pub fn new(teeth: u32, tip_radius: f64, root_radius: f64, lean_deg: f64) -> EscapeWheel {
            EscapeWheel { teeth, tip_radius, root_radius, lean_deg, root_share: 1.0 / 3.0 }
        }

        pub fn root_share(self, share: f64) -> EscapeWheel {
            EscapeWheel { root_share: share, ..self }
        }

        /// The angle between two teeth, degrees.
        pub fn pitch_deg(&self) -> f64 {
            360.0 / self.teeth as f64
        }

        /// None when the numbers make a wheel, else the sentence why not.
        pub fn refusal(&self) -> Option<String> {
            if self.teeth < 12 || self.teeth > 200 {
                return Some("An escape wheel takes 12 to 200 teeth.".to_string());
            }
            if !ok(self.tip_radius, 1.0, 500.0) {
                return Some("An escape wheel's tip radius is 1 to 500 mm.".to_string());
            }
            if !ok(self.root_radius, 0.1 * self.tip_radius, 0.98 * self.tip_radius) {
                return Some("An escape wheel's root radius is under its tip radius, and more than a tenth of it.".to_string());
            }
            if !ok(self.lean_deg, 0.0, 30.0) {
                return Some("An escape wheel's teeth lean 0 to 30 degrees forward.".to_string());
            }
            if !ok(self.root_share, 0.1, 0.7) {
                return Some("A tooth's root takes 0.1 to 0.7 of the pitch.".to_string());
            }
            if self.root_radius <= self.tip_radius * sin_cos_deg(self.lean_deg).0 {
                return Some("The front faces lean so far they miss the root circle: lean the teeth less or cut the roots deeper.".to_string());
            }
            None
        }

        /// The polar offsets, radians counter-clockwise from a tooth's tip, of its front face's and its back's roots.
        fn roots(&self) -> (f64, f64) {
            let (r_tip, r_root) = (self.tip_radius, self.root_radius);
            let (sl, cl) = sin_cos_deg(self.lean_deg);
            // Down the front face from the tip (r_tip, 0) along (-cos lean, sin lean) to the root circle.
            let t = r_tip * cl - (r_root * r_root - r_tip * r_tip * sl * sl).max(0.0).sqrt();
            let front = angle([r_tip - t * cl, t * sl]);
            (front, front + self.root_share * 2.0 * PI / self.teeth as f64)
        }

        /// The outline with tooth 0's tip at `phase_deg` from +X: per tooth the front face, the back, and the root arc to
        /// the next tooth's front face.
        pub fn outline(&self, phase_deg: f64) -> Result<Outline, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let (front, back) = self.roots();
            let pitch = 2.0 * PI / self.teeth as f64;
            let c0 = phase_deg * DEG;
            let start = polar(self.root_radius, c0 + front);
            let mut pieces: Vec<Piece> = Vec::new();
            for k in 0..self.teeth {
                let c = c0 + pitch * k as f64;
                pieces.push(Piece::Line(polar(self.tip_radius, c)));
                pieces.push(Piece::Line(polar(self.root_radius, c + back)));
                let to = if k + 1 == self.teeth { start } else { polar(self.root_radius, c + pitch + front) };
                pieces.push(Piece::Arc(polar(self.root_radius, c + 0.5 * (back + pitch + front)), to));
            }
            Ok(Outline { start, pieces })
        }

        /// The outline as points, the root arcs in steps of at most 3 degrees.
        pub fn points(&self, phase_deg: f64) -> Result<Vec<P2>, String> {
            Ok(outline_points(&self.outline(phase_deg)?, 3.0))
        }
    }

    /// A Graham (deadbeat) anchor for `wheel`, after the classical construction (Rawlings, "The Science of Clocks and
    /// Watches"; Gazeley, "Clock and Watch Escapement Mechanics"):
    ///
    /// - The pallets embrace `span_teeth` teeth (a whole number and a half, 7.5 on 30 teeth say), so half the span is
    ///   `beta = 180° × span / teeth` at the wheel's centre. The pallets act where the tangents from the pivot touch the
    ///   tip circle, so the pivot stands `pivot_distance = tip_radius / cos(beta)` above the wheel's centre, and a tooth
    ///   there moves straight toward (entry) or away from (exit) the pivot.
    /// - Each locking face is an arc about the pivot, so a tooth resting on it pushes through the pivot and the wheel does
    ///   not recoil: the entry pallet locks on its outer face, the exit pallet on its inner one ("circular pallets": both
    ///   between the same two radii). Each impulse face is the straight end of a pallet, from its locking corner to its
    ///   let-off corner.
    /// - `lock_deg` and `impulse_deg` are turns of the anchor; `drop_deg` is a turn of the wheel, the free run from one
    ///   pallet's let-off to the other pallet's lock. A pallet is therefore half a pitch less the drop thick, in wheel
    ///   degrees (`pallet_thickness` in mm), and the anchor turns `lock + impulse` between its two let-offs
    ///   (`swing_deg`), plus `supplementary_deg` beyond each, which the locking faces are long enough for.
    ///
    /// The anchor's outline stands about its pivot at the origin in its middle position (in beat), with the wheel's
    /// centre at `(0, -pivot_distance)`: a hub of `hub_radius` round the pivot, an arm of `arm_width` down to each pallet,
    /// set as close to the wheel as `clearance` allows over the whole swing. Add the arbor's bore as a second loop.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Graham {
        pub wheel: EscapeWheel,
        pub span_teeth: f64,
        pub lock_deg: f64,
        pub impulse_deg: f64,
        pub drop_deg: f64,
        pub supplementary_deg: f64,
        pub arm_width: f64,
        pub hub_radius: f64,
        pub clearance: f64,
        pub friction: f64,
    }

    /// One pallet in the anchor's frame at its middle position: the corner where the locking face meets the impulse
    /// face, the impulse face's other end (where the tooth lets off), the locking face's radius about the pivot, and
    /// where the locking face ends at the arm.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Pallet {
        pub locking_corner: P2,
        pub letoff_corner: P2,
        pub locking_radius: f64,
        pub face_end: P2,
    }

    /// What the anchor is worked out from (radians; gamma is the angle about the pivot from straight down, positive
    /// toward the entry side).
    struct Layout {
        d: f64,
        theta_lo: f64,
        theta_hi: f64,
        rho_in: f64,
        rho_out: f64,
        alpha_e: f64,
        alpha_x: f64,
        entry: Pallet,
        exit: Pallet,
        spoke_entry: f64,
        spoke_exit: f64,
    }

    /// The point at `rho` from the pivot, `g` radians from straight down toward the entry (-X) side.
    fn at_gamma(rho: f64, g: f64) -> P2 {
        polar(rho, -g - PI / 2.0)
    }
    fn gamma(p: P2) -> f64 {
        -angle(p) - PI / 2.0
    }

    impl Graham {
        /// An anchor for `wheel` spanning `span_teeth`, with lock 1.5, impulse 2.5 and supplementary arc 2 degrees of the
        /// anchor, a drop of 1.5 degrees of the wheel, 0.2 mm clearance and friction 0.3 (plastic on plastic): more than
        /// a brass clock's, for printed parts. The hub is half the gap between the pivot and the tip circle, the arms
        /// 0.15 of the tip radius wide (at most one and a half hub radii).
        pub fn new(wheel: EscapeWheel, span_teeth: f64) -> Graham {
            let beta = PI * span_teeth / wheel.teeth as f64;
            let d = wheel.tip_radius / sin_cos(beta).1;
            let hub = 0.5 * (d - wheel.tip_radius);
            Graham {
                wheel,
                span_teeth,
                lock_deg: 1.5,
                impulse_deg: 2.5,
                drop_deg: 1.5,
                supplementary_deg: 2.0,
                arm_width: (0.15 * wheel.tip_radius).min(1.5 * hub),
                hub_radius: hub,
                clearance: 0.2,
                friction: 0.3,
            }
        }

        pub fn lock(self, deg: f64) -> Graham {
            Graham { lock_deg: deg, ..self }
        }
        pub fn impulse(self, deg: f64) -> Graham {
            Graham { impulse_deg: deg, ..self }
        }
        pub fn drop(self, wheel_deg: f64) -> Graham {
            Graham { drop_deg: wheel_deg, ..self }
        }
        pub fn supplementary(self, deg: f64) -> Graham {
            Graham { supplementary_deg: deg, ..self }
        }
        pub fn arm_width(self, mm: f64) -> Graham {
            Graham { arm_width: mm, ..self }
        }
        pub fn hub_radius(self, mm: f64) -> Graham {
            Graham { hub_radius: mm, ..self }
        }
        pub fn clearance(self, mm: f64) -> Graham {
            Graham { clearance: mm, ..self }
        }
        /// The friction coefficient between tooth and pallet: an impulse face must lean off its locking face by more than
        /// the friction angle `atan(friction)`, or a tooth sticks at the corner.
        pub fn friction(self, mu: f64) -> Graham {
            Graham { friction: mu, ..self }
        }

        /// The pivot's distance above the wheel's centre: `tip_radius / cos(180° × span / teeth)`, where the tangents
        /// from the pivot touch the tip circle at the pallets.
        pub fn pivot_distance(&self) -> f64 {
            self.wheel.tip_radius / sin_cos(PI * self.span_teeth / self.wheel.teeth as f64).1
        }

        /// How far the anchor turns from one let-off to the other: lock plus impulse, degrees. The pendulum must swing
        /// at least this, and the supplementary arc beyond each end.
        pub fn swing_deg(&self) -> f64 {
            self.lock_deg + self.impulse_deg
        }

        /// The anchor's angle (degrees, counter-clockwise, from its middle position) at the entry let-off and at the exit
        /// let-off: minus and plus half the swing.
        pub fn letoff_deg(&self) -> (f64, f64) {
            (-self.swing_deg() / 2.0, self.swing_deg() / 2.0)
        }

        fn numbers_refusal(&self) -> Option<String> {
            if let Some(why) = self.wheel.refusal() {
                return Some(why);
            }
            let twice = self.span_teeth * 2.0;
            if !twice.is_finite() || twice.round() != twice || (twice as i64) % 2 != 1 || self.span_teeth < 1.5 {
                return Some("The pallets span a whole number of teeth and a half (7.5, say), at least 1.5.".to_string());
            }
            if PI * self.span_teeth / self.wheel.teeth as f64 > 70.0 * DEG {
                return Some("The span reaches more than 70 degrees round the wheel each side of the pivot: span fewer teeth.".to_string());
            }
            if !ok(self.lock_deg, 0.1, 10.0) {
                return Some("The lock is 0.1 to 10 degrees of the anchor.".to_string());
            }
            if !ok(self.impulse_deg, 0.1, 15.0) {
                return Some("The impulse is 0.1 to 15 degrees of the anchor.".to_string());
            }
            if !(self.drop_deg.is_finite() && self.drop_deg > 0.0) {
                return Some("A drop of nothing leaves no room: a tooth leaving one pallet would strike the other.".to_string());
            }
            if self.drop_deg >= self.wheel.pitch_deg() / 2.0 {
                return Some("A drop of half a tooth pitch or more leaves the pallets no thickness.".to_string());
            }
            if !ok(self.supplementary_deg, 0.0, 20.0) {
                return Some("The supplementary arc is 0 to 20 degrees of the anchor.".to_string());
            }
            if !ok(self.clearance, 0.0, self.wheel.tip_radius) || !ok(self.friction, 0.0, 1.0) {
                return Some("The clearance is 0 mm or more, and the friction 0 to 1.".to_string());
            }
            if self.wheel.tip_radius * self.drop_deg * DEG < self.clearance {
                return Some("The drop is smaller than the clearance at the wheel's tips: use more drop or less clearance.".to_string());
            }
            if !(self.arm_width.is_finite() && self.arm_width > 0.0 && self.hub_radius.is_finite() && self.hub_radius > self.arm_width / 2.0) {
                return Some("The anchor's arms need a width, and its hub must be wider than they are.".to_string());
            }
            if self.hub_radius + self.clearance >= self.pivot_distance() - self.wheel.tip_radius {
                return Some("The anchor's hub reaches the wheel's tips: use a smaller hub or span more teeth.".to_string());
            }
            None
        }

        fn layout(&self) -> Result<Layout, String> {
            if let Some(why) = self.numbers_refusal() {
                return Err(why);
            }
            let r = self.wheel.tip_radius;
            let pitch = 2.0 * PI / self.wheel.teeth as f64;
            let d = self.pivot_distance();
            let a = pitch / 2.0 - self.drop_deg * DEG;
            let beta = PI * self.span_teeth / self.wheel.teeth as f64;
            let (theta_lo, theta_hi) = (beta - a / 2.0, beta + a / 2.0);
            // A tooth tip `theta` from the line of centres on the entry (side 1, -X) or the exit (side -1) side, seen from
            // the pivot.
            let tip = |side: f64, theta: f64| -> P2 {
                let (s, c) = sin_cos(theta);
                [-side * r * s, r * c - d]
            };
            let rho_in = len(tip(1.0, theta_lo));
            let rho_out = len(tip(1.0, theta_hi));
            let (lock, imp, supp) = (self.lock_deg * DEG, self.impulse_deg * DEG, self.supplementary_deg * DEG);
            let alpha_e = -(lock + imp) / 2.0;
            let alpha_x = (lock + imp) / 2.0;
            // Each corner meets its tooth tip with the anchor where that happens, so stands turned back by that angle in
            // the middle position.
            let e_lo = rot(tip(1.0, theta_lo), -alpha_e);
            let e_lk = rot(tip(1.0, theta_hi), -(alpha_e + imp));
            let x_lo = rot(tip(-1.0, theta_hi), -alpha_x);
            let x_lk = rot(tip(-1.0, theta_lo), -(alpha_x - imp));
            // The impulse faces must lean off the locking faces by more than the friction angle.
            for (corner, end) in [(e_lk, e_lo), (x_lk, x_lo)] {
                let u = sub(end, corner);
                let t = [-corner[1], corner[0]];
                if cross(u, t).abs() <= self.friction * dot(u, t).abs() {
                    return Err("The impulse faces lie within the friction angle of the locking faces, so a tooth would stick at the corner: use less impulse or less drop.".to_string());
                }
            }
            // Each arm as close to the wheel as the clearance allows with the anchor at its furthest swing to that side.
            let w = self.arm_width;
            let h = self.hub_radius;
            let off = |rho: f64| asin(w / (2.0 * rho));
            let need = r + self.clearance;
            let arms = "The anchor's arms cannot clear the wheel: use narrower arms, a smaller hub or less supplementary arc.";
            let far_e = rot([0.0, -d], -(alpha_x + supp));
            let clear_e = |g: f64| seg_dist(far_e, at_gamma(h, g - off(h)), at_gamma(rho_in, g - off(rho_in))) >= need;
            let (mut lo, mut hi) = (gamma(e_lk), 0.95 * PI);
            if !clear_e(hi) {
                return Err(arms.to_string());
            }
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if clear_e(mid) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            let spoke_entry = hi;
            let far_x = rot([0.0, -d], -(alpha_e - supp));
            let clear_x = |g: f64| seg_dist(far_x, at_gamma(h, g + off(h)), at_gamma(rho_in, g + off(rho_in))) >= need;
            let (mut lo, mut hi) = (-0.95 * PI, gamma(x_lk));
            if !clear_x(lo) {
                return Err(arms.to_string());
            }
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if clear_x(mid) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let spoke_exit = lo;
            if spoke_entry + off(h) >= PI || spoke_exit - off(h) <= -PI || spoke_entry - off(h) <= spoke_exit + off(h) {
                return Err(arms.to_string());
            }
            let entry = Pallet { locking_corner: e_lk, letoff_corner: e_lo, locking_radius: rho_out, face_end: at_gamma(rho_out, spoke_entry + off(rho_out)) };
            let exit = Pallet { locking_corner: x_lk, letoff_corner: x_lo, locking_radius: rho_in, face_end: at_gamma(rho_in, spoke_exit + off(rho_in)) };
            // The locking faces carry a tooth through the lock and the supplementary arc; the pallets reach past the arms.
            if gamma(entry.face_end) - gamma(e_lk) < lock + supp
                || gamma(x_lk) - gamma(exit.face_end) < lock + supp
                || spoke_entry - off(rho_in) <= gamma(e_lo)
                || spoke_exit - off(rho_out) >= gamma(x_lo)
            {
                return Err("The locking faces are shorter than the lock and the supplementary arc: use narrower arms.".to_string());
            }
            Ok(Layout { d, theta_lo, theta_hi, rho_in, rho_out, alpha_e, alpha_x, entry, exit, spoke_entry, spoke_exit })
        }

        fn anchor_from(&self, l: &Layout) -> Outline {
            let (h, w) = (self.hub_radius, self.arm_width);
            let off = |rho: f64| asin(w / (2.0 * rho));
            let arc = |rho: f64, g0: f64, g1: f64, to: P2| Piece::Arc(at_gamma(rho, 0.5 * (g0 + g1)), to);
            let (ge, gx) = (l.spoke_entry, l.spoke_exit);
            let (e, x) = (l.entry, l.exit);
            let start = at_gamma(h, PI);
            let pieces: Vec<Piece> = vec![
                // Down the hub to the entry arm, out along its far edge, round the entry locking face, the impulse face,
                // back along the pallet's inner face and the arm's near edge to the hub.
                arc(h, PI, ge + off(h), at_gamma(h, ge + off(h))),
                Piece::Line(at_gamma(l.rho_out, ge + off(l.rho_out))),
                arc(l.rho_out, ge + off(l.rho_out), gamma(e.locking_corner), e.locking_corner),
                Piece::Line(e.letoff_corner),
                arc(l.rho_in, gamma(e.letoff_corner), ge - off(l.rho_in), at_gamma(l.rho_in, ge - off(l.rho_in))),
                Piece::Line(at_gamma(h, ge - off(h))),
                // Under the hub to the exit arm, out along its near edge, round the exit locking face, the impulse face,
                // back along the pallet's outer face and the arm's far edge, and over the hub to the start.
                arc(h, ge - off(h), gx + off(h), at_gamma(h, gx + off(h))),
                Piece::Line(at_gamma(l.rho_in, gx + off(l.rho_in))),
                arc(l.rho_in, gx + off(l.rho_in), gamma(x.locking_corner), x.locking_corner),
                Piece::Line(x.letoff_corner),
                arc(l.rho_out, gamma(x.letoff_corner), gx - off(l.rho_out), at_gamma(l.rho_out, gx - off(l.rho_out))),
                Piece::Line(at_gamma(h, gx - off(h))),
                arc(h, gx - off(h), -PI, start),
            ];
            Outline { start, pieces }
        }

        /// Whether the anchor meets the wheel anywhere but at a tooth's tip, stepping through a whole beat each way: the
        /// entry pallet locked over its lock and supplementary arc, its impulse (the wheel turned so a tip lies on the
        /// face), the drop, the exit pallet locked, its impulse and its drop. The wheel is set back 0.02 degrees in
        /// each pose so the touching tip does not count.
        fn clash(&self, l: &Layout, anchor: &Outline) -> bool {
            let r = self.wheel.tip_radius;
            let a_pts = outline_points(anchor, 0.5);
            let (imp, supp, drop) = (self.impulse_deg * DEG, self.supplementary_deg * DEG, self.drop_deg * DEG);
            let pull = 0.02 * DEG;
            let up = PI / 2.0;
            // The wheel angle (radians) at which a tooth tip lies on the impulse face corner..end with the anchor at `alpha`.
            let face_tip = |corner: P2, end: P2, alpha: f64| -> Option<f64> {
                let a = add(rot(corner, alpha), [0.0, l.d]);
                let b = add(rot(end, alpha), [0.0, l.d]);
                let v = sub(b, a);
                let (qa, qb, qc) = (dot(v, v), 2.0 * dot(a, v), dot(a, a) - r * r);
                let disc = qb * qb - 4.0 * qa * qc;
                if qa <= 0.0 || disc < 0.0 {
                    return None;
                }
                for s in [(-qb - disc.sqrt()) / (2.0 * qa), (-qb + disc.sqrt()) / (2.0 * qa)] {
                    // On the face, ends included (lust has no float ranges).
                    if (s - 0.5).abs() <= 0.5 + 1e-9 {
                        return Some(angle(add(a, mul(v, s))));
                    }
                }
                None
            };
            let mut poses: Vec<(f64, f64)> = Vec::new();
            let span_e = l.alpha_x + supp - (l.alpha_e + imp);
            for k in 0..=4 {
                poses.push((up + l.theta_hi, l.alpha_e + imp + span_e * k as f64 / 4.0));
            }
            for k in 0..=6 {
                let alpha = l.alpha_e + imp - imp * k as f64 / 6.0;
                if let Some(phi) = face_tip(l.entry.locking_corner, l.entry.letoff_corner, alpha) {
                    poses.push((phi, alpha));
                }
            }
            for k in 0..=2 {
                poses.push((up + l.theta_lo - drop * k as f64 / 2.0, l.alpha_e));
            }
            let span_x = l.alpha_x - imp - (l.alpha_e - supp);
            for k in 0..=4 {
                poses.push((up + l.theta_lo - drop, l.alpha_e - supp + span_x * k as f64 / 4.0));
            }
            for k in 0..=6 {
                let alpha = l.alpha_x - imp + imp * k as f64 / 6.0;
                if let Some(phi) = face_tip(l.exit.locking_corner, l.exit.letoff_corner, alpha) {
                    poses.push((phi, alpha));
                }
            }
            for k in 0..=2 {
                poses.push((up - l.theta_hi - drop * k as f64 / 2.0, l.alpha_x));
            }
            for (phi, alpha) in poses.iter() {
                let wheel = match self.wheel.outline((phi + pull) / DEG) {
                    Ok(o) => outline_points(&o, 2.0),
                    Err(_) => return true,
                };
                let placed: Vec<P2> = a_pts.iter().map(|q| add(rot(*q, *alpha), [0.0, l.d])).collect();
                let (mut lo, mut hi) = (placed[0], placed[0]);
                for q in placed.iter() {
                    lo = [lo[0].min(q[0]), lo[1].min(q[1])];
                    hi = [hi[0].max(q[0]), hi[1].max(q[1])];
                }
                let (n, m) = (wheel.len(), placed.len());
                for i in 0..n {
                    let (a, b) = (wheel[i], wheel[(i + 1) % n]);
                    if a[0].max(b[0]) < lo[0] || a[0].min(b[0]) > hi[0] || a[1].max(b[1]) < lo[1] || a[1].min(b[1]) > hi[1] {
                        continue;
                    }
                    for j in 0..m {
                        if crosses(a, b, placed[j], placed[(j + 1) % m]) {
                            return true;
                        }
                    }
                }
            }
            false
        }

        /// None when the escapement works, else the sentence why not: a span that does not fit, a drop too small for the
        /// clearance, impulse faces a tooth would stick on, arms that cannot clear the wheel, or a pallet that meets a
        /// tooth anywhere but at its tip somewhere in the beat.
        pub fn refusal(&self) -> Option<String> {
            self.anchor().err()
        }

        /// The anchor's outline about its pivot at the origin, in its middle position, the wheel's centre at
        /// `(0, -pivot_distance)`: hub arcs, straight arms, the pallets' arcs about the pivot (the locking faces) and
        /// their straight impulse faces. Refused as `refusal` says.
        pub fn anchor(&self) -> Result<Outline, String> {
            let l = self.layout()?;
            let outline = self.anchor_from(&l);
            if self.clash(&l, &outline) {
                return Err("A pallet meets the wheel away from the tooth tips: lean the teeth further forward, cut the roots deeper, or use less lock, impulse or supplementary arc.".to_string());
            }
            Ok(outline)
        }

        /// The anchor's outline as points, its arcs in steps of at most `arc_step_deg`.
        pub fn anchor_points(&self, arc_step_deg: f64) -> Result<Vec<P2>, String> {
            Ok(outline_points(&self.anchor()?, arc_step_deg))
        }

        /// The entry pallet and the exit pallet, in the anchor's frame at its middle position.
        pub fn pallets(&self) -> Result<(Pallet, Pallet), String> {
            let l = self.layout()?;
            Ok((l.entry, l.exit))
        }

        /// A pallet's thickness, mm: the radial width of both pallets about the pivot (half a pitch less the drop, in
        /// wheel degrees, at the tip circle).
        pub fn pallet_thickness(&self) -> Result<f64, String> {
            let l = self.layout()?;
            Ok(l.rho_out - l.rho_in)
        }

        /// A pose to place the parts in: the wheel's phase (tooth 0's tip, degrees from +X, for `EscapeWheel::outline`)
        /// and the anchor's angle (degrees, counter-clockwise about its pivot) just after the exit let-off, a tooth
        /// resting on the entry pallet's locking face by the full lock.
        pub fn rest_pose(&self) -> Result<(f64, f64), String> {
            let l = self.layout()?;
            Ok((90.0 + l.theta_hi / DEG, l.alpha_x / DEG))
        }
    }

    // ---- Ratchet and click. ----

    /// A ratchet wheel: `teeth` saw teeth between `tip_radius` and `root_radius`. Each tooth has a radial face and a
    /// straight back from the root of the face before it to its tip. Tooth 0's radial face stands at `phase_deg`; the
    /// wheel turns freely clockwise under its click and is held counter-clockwise. Mirror for the other hand.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Ratchet {
        pub teeth: u32,
        pub tip_radius: f64,
        pub root_radius: f64,
    }

    /// A click's size: `length` from the middle of the tooth face it bears on to its pivot, along the tangent there;
    /// `hub_radius` round the pivot; `rise` how far its face stands above the tips; `seat_gap` how far its nose stays
    /// off the root.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct Click {
        pub length: f64,
        pub hub_radius: f64,
        pub rise: f64,
        pub seat_gap: f64,
    }

    /// A click worked out for a ratchet: its `outline` about its pivot at the origin with its nose along +X, the `pivot`
    /// in the ratchet's frame, `seat_deg` (turn the outline by this about its pivot, then move it to `pivot`, and its
    /// nose sits in tooth 0's notch), `lift_deg` (the further turn about the pivot, counter-clockwise positive, that
    /// lifts the nose to the tip circle as the ratchet is wound), and `nose`, the nose's lowest point in the click's frame.
    #[derive(Clone, Debug, PartialEq)]
    pub struct ClickPlacement {
        pub outline: Outline,
        pub pivot: P2,
        pub seat_deg: f64,
        pub lift_deg: f64,
        pub nose: P2,
    }

    impl Ratchet {
        pub fn new(teeth: u32, tip_radius: f64, root_radius: f64) -> Ratchet {
            Ratchet { teeth, tip_radius, root_radius }
        }

        pub fn pitch_deg(&self) -> f64 {
            360.0 / self.teeth as f64
        }

        pub fn refusal(&self) -> Option<String> {
            if self.teeth < 6 || self.teeth > 200 {
                return Some("A ratchet takes 6 to 200 teeth.".to_string());
            }
            if !ok(self.tip_radius, 1.0, 500.0) || !ok(self.root_radius, 0.3 * self.tip_radius, 0.97 * self.tip_radius) {
                return Some("A ratchet's tip radius is 1 to 500 mm, its root radius 0.3 to 0.97 of it.".to_string());
            }
            None
        }

        /// The outline, counter-clockwise: from each radial face's root, the back up to the next tip, then that radial
        /// face down to its root.
        pub fn outline(&self, phase_deg: f64) -> Result<Outline, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let pitch = 2.0 * PI / self.teeth as f64;
            let c0 = phase_deg * DEG;
            let start = polar(self.root_radius, c0);
            let mut pieces: Vec<Piece> = Vec::new();
            for k in 1..=self.teeth {
                let c = c0 + pitch * k as f64;
                pieces.push(Piece::Line(polar(self.tip_radius, c)));
                pieces.push(Piece::Line(if k == self.teeth { start } else { polar(self.root_radius, c) }));
            }
            Ok(Outline { start, pieces })
        }

        pub fn points(&self, phase_deg: f64) -> Result<Vec<P2>, String> {
            Ok(outline_points(&self.outline(phase_deg)?, 3.0))
        }

        /// A click of `length` with the proportions of the tooth depth h: hub radius h, rise 0.6 h, seat gap 0.1 h.
        pub fn click_size(&self, length: f64) -> Click {
            let h = self.tip_radius - self.root_radius;
            Click { length, hub_radius: h, rise: 0.6 * h, seat_gap: 0.1 * h }
        }

        /// The click for this ratchet with tooth 0's face at `phase_deg`. Its face lies on that radial face from
        /// `seat_gap` above the root to `rise` above the tips; its underside runs parallel to the next tooth's back; its
        /// edges run tangent to its hub. The pivot lies on the tangent through the middle of the face it bears on, so
        /// the face's push passes through the pivot and does not throw the click out (the usual rule for a click).
        pub fn click(&self, phase_deg: f64, click: &Click) -> Result<ClickPlacement, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let (big, small) = (self.tip_radius, self.root_radius);
            let h = big - small;
            if !ok(click.length, 0.5 * h, 20.0 * big) || !ok(click.hub_radius, 0.05 * h, 10.0 * h) || !ok(click.rise, 0.05 * h, 5.0 * h) || !ok(click.seat_gap, 0.0, 0.5 * h) {
                return Err("A click is 0.5 tooth depths to 20 tip radii long, with a hub of 0.05 to 10 depths, a rise of 0.05 to 5 depths and a seat gap under half a depth.".to_string());
            }
            let pitch = 2.0 * PI / self.teeth as f64;
            let c = phase_deg * DEG;
            let (sc, cc) = sin_cos(c);
            let nose = polar(small + click.seat_gap, c);
            let top = polar(big + click.rise, c);
            let mid = polar(0.5 * (small + click.seat_gap + big), c);
            let pivot = add(mid, mul([-sc, cc], click.length));
            if len(pivot) - click.hub_radius <= big + click.seat_gap {
                return Err("The click's hub reaches the ratchet's teeth: make the click longer or its hub smaller.".to_string());
            }
            // The underside: from the nose, parallel to the next tooth's back, out to halfway up the rise.
            let back = sub(polar(big, c + pitch), polar(small, c));
            let v = mul(back, 1.0 / len(back));
            let rho_u = big + 0.5 * click.rise;
            let kv = dot(nose, v);
            let under = add(nose, mul(v, -kv + (kv * kv - dot(nose, nose) + rho_u * rho_u).sqrt()));
            // Tangent points on the hub from a point outside it: the one with the hub on the left going to it (`to_hub`),
            // or coming from it.
            let tangent = |from: P2, to_hub: bool| -> Option<P2> {
                let dd = len(sub(from, pivot));
                if dd <= click.hub_radius {
                    return None;
                }
                let base = angle(sub(from, pivot));
                let o = acos(click.hub_radius / dd);
                for a in [base + o, base - o] {
                    let t = add(pivot, polar(click.hub_radius, a));
                    let left = if to_hub { cross(sub(t, from), sub(pivot, from)) } else { cross(sub(from, t), sub(pivot, t)) };
                    if left > 0.0 {
                        return Some(t);
                    }
                }
                None
            };
            let thick = "The click's nose is wider than its hub's reach: make the click longer or its hub smaller.";
            let t_up = tangent(top, true).ok_or(thick.to_string())?;
            let t_low = tangent(under, false).ok_or(thick.to_string())?;
            if seg_dist([0.0, 0.0], t_low, under) < big {
                return Err("The click's arm dips into the ratchet's teeth: make the click longer.".to_string());
            }
            let a0 = angle(sub(t_up, pivot));
            let mut a1 = angle(sub(t_low, pivot));
            while a1 <= a0 {
                a1 += 2.0 * PI;
            }
            let seat = angle(sub(mid, pivot));
            let local = |p: P2| rot(sub(p, pivot), -seat);
            let start = local(nose);
            let pieces = vec![
                Piece::Line(local(top)),
                Piece::Line(local(t_up)),
                Piece::Arc(local(add(pivot, polar(click.hub_radius, 0.5 * (a0 + a1)))), local(t_low)),
                Piece::Line(local(under)),
                Piece::Line(start),
            ];
            // The lift: the turn about the pivot, the way that moves the nose outward, that brings it to the tip circle.
            let k = sub(nose, pivot);
            let (kl, cl) = (len(k), len(pivot));
            let cos_d = (cl * cl + kl * kl - big * big) / (2.0 * cl * kl);
            if cos_d.is_nan() || cos_d.abs() > 1.0 {
                return Err("The click cannot lift its nose clear of the tips: make it longer.".to_string());
            }
            let toward = angle(mul(pivot, -1.0));
            let ak = angle(k);
            let outward = dot(nose, [-k[1], k[0]]) > 0.0;
            let mut lift = 4.0 * PI;
            for a in [toward + acos(cos_d), toward - acos(cos_d)] {
                let mut turn = if outward { a - ak } else { ak - a };
                while turn <= 0.0 {
                    turn += 2.0 * PI;
                }
                while turn > 2.0 * PI {
                    turn -= 2.0 * PI;
                }
                if turn < lift {
                    lift = turn;
                }
            }
            let lift_deg = if outward { lift / DEG } else { -lift / DEG };
            Ok(ClickPlacement { outline: Outline { start, pieces }, pivot, seat_deg: seat / DEG, lift_deg, nose: start })
        }
    }

    // ---- Cycloidal clock teeth (BS 978-2). ----

    /// How a pinion leaf's top is rounded (BS 978-2): a half circle (round top), or two arcs meeting in a point (medium
    /// and high ogival). The standard recommends high for 6 or 7 leaves, medium for 8 or 9, round for 10 or more.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum LeafTop {
        Round,
        Medium,
        High,
    }

    /// A clock wheel of `teeth` and `module` that drives a pinion of `pinion_leaves`, with BS 978-2 proportions (as
    /// derived in S. Parks, "Designing Cycloidal Gears", from the standard): tooth and space each half the circular
    /// pitch (pi/2 m) on the pitch circle; addenda the true epicycloid rolled by a circle of half the pinion's pitch
    /// radius, which meshes with the pinion's radial flanks, cut at 0.95 of the height where the two flanks meet (the
    /// standard's "practical addendum") with an arc on the tip circle; radial flanks below the pitch circle down to a
    /// dedendum of pi/2 m, and arcs on the root circle. The points on the flanks lie on the epicycloid exactly; the
    /// standard's drawing aid, an arc of radius 1.4 addenda, is not used. Root corners are sharp.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct ClockWheel {
        pub teeth: u32,
        pub module: f64,
        pub pinion_leaves: u32,
    }

    /// Steps along each epicycloidal flank: the spline goes through one point more than this.
    const CYCLOID_STEPS: usize = 8;

    impl ClockWheel {
        pub fn new(teeth: u32, module: f64, pinion_leaves: u32) -> ClockWheel {
            ClockWheel { teeth, module, pinion_leaves }
        }

        pub fn pitch_radius(&self) -> f64 {
            self.module * self.teeth as f64 / 2.0
        }

        pub fn refusal(&self) -> Option<String> {
            if self.teeth < 12 || self.teeth > 400 {
                return Some("A clock wheel takes 12 to 400 teeth.".to_string());
            }
            if self.pinion_leaves < 6 || self.pinion_leaves > 20 || self.pinion_leaves > self.teeth {
                return Some("A clock wheel drives a pinion of 6 to 20 leaves, no more than its own teeth.".to_string());
            }
            if !ok(self.module, 0.1, 10.0) {
                return Some("A clock wheel's module is 0.1 to 10 mm.".to_string());
            }
            None
        }

        /// The epicycloid traced by a circle of radius m z_p / 4 rolling outside the pitch circle, from the pitch point
        /// (r, 0), after a roll of `t` radians about the wheel's centre.
        fn cycloid(&self, t: f64) -> P2 {
            let big = self.pitch_radius();
            let g = self.module * self.pinion_leaves as f64 / 4.0;
            let (s1, c1) = sin_cos(t);
            let (s2, c2) = sin_cos((big + g) / g * t);
            [(big + g) * c1 - g * c2, (big + g) * s1 - g * s2]
        }

        /// The roll at which a flank, starting half a tooth (pi / 2z) from the tooth's centre line, reaches it.
        fn meeting(&self) -> f64 {
            let half = PI / (2.0 * self.teeth as f64);
            let g = self.module * self.pinion_leaves as f64 / 4.0;
            let (mut lo, mut hi) = (0.0, PI * g / self.pitch_radius());
            for _ in 0..100 {
                let mid = 0.5 * (lo + hi);
                if angle(self.cycloid(mid)) < half {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            hi
        }

        /// The full addendum, in modules: where the two epicycloids of a tooth meet (BS 978-2's f_a).
        pub fn addendum_factor(&self) -> f64 {
            (len(self.cycloid(self.meeting())) - self.pitch_radius()) / self.module
        }

        /// The practical addendum, mm: 0.95 of the full one.
        pub fn addendum(&self) -> f64 {
            0.95 * self.addendum_factor() * self.module
        }

        pub fn dedendum(&self) -> f64 {
            PI / 2.0 * self.module
        }

        pub fn tip_radius(&self) -> f64 {
            self.pitch_radius() + self.addendum()
        }

        pub fn root_radius(&self) -> f64 {
            self.pitch_radius() - self.dedendum()
        }

        /// The centre distance to its pinion: the pitch circles touch, m (z + z_p) / 2.
        pub fn centre_distance(&self) -> f64 {
            self.module * (self.teeth + self.pinion_leaves) as f64 / 2.0
        }

        /// The pinion this wheel drives, with the leaf top given and the standard's dedendum: the wheel's practical
        /// addendum and 0.4 m of clearance.
        pub fn pinion(&self, top: LeafTop) -> ClockPinion {
            ClockPinion { leaves: self.pinion_leaves, module: self.module, top, dedendum: 0.95 * self.addendum_factor() + 0.4 }
        }

        /// One flank, tooth centred on +X, clockwise side: from the pitch circle up to the tip circle, evenly in roll.
        fn flank(&self, steps: usize) -> Vec<P2> {
            let half = PI / (2.0 * self.teeth as f64);
            let tip = self.tip_radius();
            let (mut lo, mut hi) = (0.0, self.meeting());
            for _ in 0..100 {
                let mid = 0.5 * (lo + hi);
                if len(self.cycloid(mid)) < tip {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            let end = hi;
            let mut pts: Vec<P2> = vec![polar(self.pitch_radius(), -half)];
            for i in 1..=steps {
                pts.push(rot(self.cycloid(end * i as f64 / steps as f64), -half));
            }
            pts
        }

        fn outline_with(&self, phase_deg: f64, steps: usize) -> Result<Outline, String> {
            if let Some(why) = self.refusal() {
                return Err(why);
            }
            let up = self.flank(steps.max(2));
            let n = up.len();
            let half = PI / (2.0 * self.teeth as f64);
            let pitch = 2.0 * PI / self.teeth as f64;
            let (rf, tip) = (self.root_radius(), self.tip_radius());
            let c0 = phase_deg * DEG;
            let start = polar(rf, c0 - half);
            let mut pieces: Vec<Piece> = Vec::new();
            for k in 0..self.teeth {
                let c = c0 + pitch * k as f64;
                pieces.push(Piece::Line(rot(up[0], c)));
                pieces.push(Piece::Spline(up[1..n - 1].iter().map(|p| rot(*p, c)).collect(), rot(up[n - 1], c)));
                pieces.push(Piece::Arc(polar(tip, c), rot(mirror(up[n - 1]), c)));
                pieces.push(Piece::Spline(up[1..n - 1].iter().rev().map(|p| rot(mirror(*p), c)).collect(), rot(mirror(up[0]), c)));
                pieces.push(Piece::Line(polar(rf, c + half)));
                let to = if k + 1 == self.teeth { start } else { polar(rf, c + pitch - half) };
                pieces.push(Piece::Arc(polar(rf, c + pitch / 2.0), to));
            }
            Ok(Outline { start, pieces })
        }

        /// The outline with tooth 0 centred on `phase_deg`: per tooth a radial flank, the epicycloid as a spline, the tip
        /// arc, the other epicycloid and radial flank, and the root arc. Mesh a pinion with `gears::mate_phase`.
        pub fn outline(&self, phase_deg: f64) -> Result<Outline, String> {
            self.outline_with(phase_deg, CYCLOID_STEPS)
        }

        /// The outline as points, `per_flank` steps along each epicycloid and the arcs in steps of at most 3 degrees.
        pub fn points(&self, phase_deg: f64, per_flank: usize) -> Result<Vec<P2>, String> {
            Ok(outline_points(&self.outline_with(phase_deg, per_flank)?, 3.0))
        }
    }

    /// A clock pinion of `leaves` and `module` with BS 978-2 proportions: leaves 1.05 m thick on the pitch circle for 6
    /// to 10 leaves, 1.25 m for 11 or more; radial flanks (along radii from the centre, which the wheel's epicycloid
    /// meshes with) from the root circle, `dedendum` modules below the pitch circle, up to the pitch circle; the top
    /// by `top`, as the standard's table gives its height f_a and arc radius f_r (round 0.525 and 0.525, or 0.625 and
    /// 0.625 from 11 leaves; medium 0.670 and 0.700, or 0.805 and 0.840; high 0.855 and 1.050, or 1.050 and 1.250).
    /// Each side of the top is an arc of radius f_r from the flank's top to the leaf's point, so a round top is a half
    /// circle to within the difference between a chord and an arc. `ClockWheel::pinion` gives the dedendum to mesh.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct ClockPinion {
        pub leaves: u32,
        pub module: f64,
        pub top: LeafTop,
        pub dedendum: f64,
    }

    impl ClockPinion {
        pub fn new(leaves: u32, module: f64, top: LeafTop, dedendum: f64) -> ClockPinion {
            ClockPinion { leaves, module, top, dedendum }
        }

        pub fn pitch_radius(&self) -> f64 {
            self.module * self.leaves as f64 / 2.0
        }

        /// A leaf's thickness on the pitch circle, mm.
        pub fn leaf_thickness(&self) -> f64 {
            (if self.leaves <= 10 { 1.05 } else { 1.25 }) * self.module
        }

        /// The top's height and arc radius in modules (f_a, f_r).
        fn factors(&self) -> (f64, f64) {
            let small = self.leaves <= 10;
            match self.top {
                LeafTop::Round => {
                    if small {
                        (0.525, 0.525)
                    } else {
                        (0.625, 0.625)
                    }
                }
                LeafTop::Medium => {
                    if small {
                        (0.670, 0.700)
                    } else {
                        (0.805, 0.840)
                    }
                }
                LeafTop::High => {
                    if small {
                        (0.855, 1.050)
                    } else {
                        (1.050, 1.250)
                    }
                }
            }
        }

        pub fn addendum(&self) -> f64 {
            self.factors().0 * self.module
        }

        pub fn tip_radius(&self) -> f64 {
            self.pitch_radius() + self.addendum()
        }

        pub fn root_radius(&self) -> f64 {
            self.pitch_radius() - self.dedendum * self.module
        }

        pub fn refusal(&self) -> Option<String> {
            self.top_arc().err()
        }

        /// The clockwise side's top arc for a leaf centred on +X: (the flank's top on the pitch circle, the arc's middle,
        /// the leaf's point).
        fn top_arc(&self) -> Result<(P2, P2, P2), String> {
            if self.leaves < 6 || self.leaves > 20 {
                return Err("A clock pinion takes 6 to 20 leaves.".to_string());
            }
            if !ok(self.module, 0.1, 10.0) {
                return Err("A clock pinion's module is 0.1 to 10 mm.".to_string());
            }
            if !ok(self.dedendum, 0.5, 3.0) || self.root_radius() <= 0.2 * self.pitch_radius() {
                return Err("A clock pinion's dedendum is 0.5 to 3 modules, leaving a root.".to_string());
            }
            let rp = self.pitch_radius();
            let (fa, fr) = self.factors();
            let eta = self.leaf_thickness() / (2.0 * rp);
            let a = polar(rp, -eta);
            let b = [rp + fa * self.module, 0.0];
            let rho = fr * self.module;
            let chord = sub(b, a);
            let half = len(chord) / 2.0;
            if rho < half {
                return Err("This leaf top cannot reach from the flank to the point.".to_string());
            }
            let midc = mul(add(a, b), 0.5);
            let n = mul([-chord[1], chord[0]], 1.0 / len(chord));
            let o = (rho * rho - half * half).sqrt();
            let inside = [rp - 0.5 * self.module, 0.0];
            let side = cross(chord, sub(inside, a));
            let centre = if cross(chord, mul(n, o)) * side > 0.0 { add(midc, mul(n, o)) } else { sub(midc, mul(n, o)) };
            let through = add(centre, mul(sub(midc, centre), rho / len(sub(midc, centre))));
            Ok((a, through, b))
        }

        /// The outline with leaf 0 centred on `phase_deg`: per leaf a radial flank, the two top arcs, the other radial
        /// flank, and the root arc.
        pub fn outline(&self, phase_deg: f64) -> Result<Outline, String> {
            let (a, through, b) = self.top_arc()?;
            let eta = self.leaf_thickness() / (2.0 * self.pitch_radius());
            let pitch = 2.0 * PI / self.leaves as f64;
            let rf = self.root_radius();
            let c0 = phase_deg * DEG;
            let start = polar(rf, c0 - eta);
            let mut pieces: Vec<Piece> = Vec::new();
            for k in 0..self.leaves {
                let c = c0 + pitch * k as f64;
                pieces.push(Piece::Line(rot(a, c)));
                pieces.push(Piece::Arc(rot(through, c), rot(b, c)));
                pieces.push(Piece::Arc(rot(mirror(through), c), rot(mirror(a), c)));
                pieces.push(Piece::Line(polar(rf, c + eta)));
                let to = if k + 1 == self.leaves { start } else { polar(rf, c + pitch - eta) };
                pieces.push(Piece::Arc(polar(rf, c + pitch / 2.0), to));
            }
            Ok(Outline { start, pieces })
        }

        pub fn points(&self, phase_deg: f64) -> Result<Vec<P2>, String> {
            Ok(outline_points(&self.outline(phase_deg)?, 3.0))
        }
    }

    // ---- Bores. ----

    /// A fit between a printed bore and a steel part, as the ISO 286 hole-basis fit it is named after: `Running` H9/d9
    /// (free running), `Sliding` H7/h6 (located, slides by hand), `Press` H7/p6 (pressed in).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Fit {
        Running,
        Sliding,
        Press,
    }

    /// Steel pin (arbor) diameters a clock commonly uses, mm.
    pub const STEEL_PINS: [f64; 4] = [1.0, 1.5, 2.0, 3.0];

    /// The small ball bearings `bearing` knows.
    pub const BEARINGS: [&str; 20] = [
        "608", "623", "624", "625", "626", "683", "684", "685", "693", "694", "695", "MR63", "MR74", "MR83", "MR84", "MR85", "MR95", "MR104", "MR105", "MR115",
    ];

    /// The mean diametral clearance of `fit` at `nominal_mm` (over 30 mm, the 18 to 30 mm row).
    fn clearance_row(nominal_mm: f64, fit: Fit) -> f64 {
        let row = if nominal_mm <= 3.0 {
            0
        } else if nominal_mm <= 6.0 {
            1
        } else if nominal_mm <= 10.0 {
            2
        } else if nominal_mm <= 18.0 {
            3
        } else {
            4
        };
        let table: [f64; 5] = match fit {
            Fit::Running => [0.045, 0.060, 0.076, 0.093, 0.117],
            Fit::Sliding => [0.008, 0.010, 0.012, 0.0145, 0.017],
            Fit::Press => [-0.004, -0.010, -0.012, -0.0145, -0.018],
        };
        table[row]
    }

    /// The mean diametral clearance of `fit` at a nominal size over 0 to 30 mm, mm, from the ISO 286 tolerance grades
    /// (negative is interference): Running H9/d9 0.045 to 0.117, Sliding H7/h6 0.008 to 0.017, Press H7/p6 -0.004 to
    /// -0.018, by the ISO size rows (to 3, 6, 10, 18 and 30 mm). None outside 0 to 30 mm.
    pub fn fit_clearance(nominal_mm: f64, fit: Fit) -> Option<f64> {
        if !(nominal_mm > 0.0 && nominal_mm <= 30.0) {
            return None;
        }
        Some(clearance_row(nominal_mm, fit))
    }

    /// A printed hole for a steel part of `nominal_mm`: the nominal size, the fit's clearance, and `allowance_mm`, how
    /// much this printer and material make a hole of that size undersize (measure it, with a fit coupon say; the
    /// fit's clearance is microns, the allowance is usually tenths). None outside 0 to 30 mm.
    pub fn hole(nominal_mm: f64, fit: Fit, allowance_mm: f64) -> Option<f64> {
        fit_clearance(nominal_mm, fit).map(|c| nominal_mm + c + allowance_mm)
    }

    /// A printed shaft for a steel bore of `nominal_mm` (a bearing's inner ring, say): the nominal size less the fit's
    /// clearance and less `allowance_mm`, how much this printer makes a shaft oversize. None outside 0 to 30 mm.
    pub fn shaft(nominal_mm: f64, fit: Fit, allowance_mm: f64) -> Option<f64> {
        fit_clearance(nominal_mm, fit).map(|c| nominal_mm - c - allowance_mm)
    }

    /// The bore for a steel pin of `pin_mm` (1, 1.5, 2 or 3 mm in `STEEL_PINS`, or any size to 30 mm): `hole`.
    pub fn pin_bore(pin_mm: f64, fit: Fit, allowance_mm: f64) -> Option<f64> {
        hole(pin_mm, fit, allowance_mm)
    }

    /// A deep-groove ball bearing: its name, bore, outer diameter and width, mm (ISO 15 dimension series).
    #[derive(Clone, Debug, PartialEq)]
    pub struct Bearing {
        pub name: String,
        pub bore: f64,
        pub outer: f64,
        pub width: f64,
    }

    /// The bearing of that name (one of `BEARINGS`: 608, 623 to 626, 683 to 685, 693 to 695, MR63, MR74, MR83, MR84,
    /// MR85, MR95, MR104, MR105, MR115), or None.
    pub fn bearing(name: &str) -> Option<Bearing> {
        let (bore, outer, width) = match name {
            "608" => (8.0, 22.0, 7.0),
            "623" => (3.0, 10.0, 4.0),
            "624" => (4.0, 13.0, 5.0),
            "625" => (5.0, 16.0, 5.0),
            "626" => (6.0, 19.0, 6.0),
            "683" => (3.0, 7.0, 3.0),
            "684" => (4.0, 9.0, 4.0),
            "685" => (5.0, 11.0, 5.0),
            "693" => (3.0, 8.0, 4.0),
            "694" => (4.0, 11.0, 4.0),
            "695" => (5.0, 13.0, 4.0),
            "MR63" => (3.0, 6.0, 2.5),
            "MR74" => (4.0, 7.0, 2.5),
            "MR83" => (3.0, 8.0, 3.0),
            "MR84" => (4.0, 8.0, 3.0),
            "MR85" => (5.0, 8.0, 2.5),
            "MR95" => (5.0, 9.0, 3.0),
            "MR104" => (4.0, 10.0, 4.0),
            "MR105" => (5.0, 10.0, 4.0),
            "MR115" => (5.0, 11.0, 4.0),
            _ => return None,
        };
        Some(Bearing { name: name.to_string(), bore, outer, width })
    }

    impl Bearing {
        /// The printed seat for the outer ring: `hole` of the outer diameter (`Press` to hold it, `Sliding` to glue it).
        pub fn seat(&self, fit: Fit, allowance_mm: f64) -> f64 {
            self.outer + clearance_row(self.outer, fit) + allowance_mm
        }

        /// A printed shaft for the inner ring: `shaft` of the bore.
        pub fn shaft(&self, fit: Fit, allowance_mm: f64) -> f64 {
            self.bore - clearance_row(self.bore, fit) - allowance_mm
        }
    }
}

/// Executes the recipe's geometry algorithms in the native host, without using the recipe protocol itself.
pub fn native_geometry_request(text: &str) -> Option<String> {
    let args = Json::parse(text).ok()?;
    let result = match args.get("op")?.as_str()? {
        "resolve" => geom2d::native_resolve(&args),
        "cells" => lattice::native_cells(&args),
        _ => None,
    }?;
    Some(result.to_string())
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
    fn arrays() {
        let outline: Vec<[f64; 2]> = vec![[0.0, 0.0], [1.5, 0.0], [0.0, 2.0]];
        assert_eq!(Json::from(outline.clone()).to_string(), "[[0,0],[1.5,0],[0,2]]");
        assert_eq!(Json::arr(outline).to_string(), "[[0,0],[1.5,0],[0,2]]");
        assert_eq!(Json::arr(vec![1u32, 2]).push("x").to_string(), r#"[1,2,"x"]"#);
        assert_eq!(Json::Null.push(1.0).to_string(), "[1]");
    }

    #[test]
    fn data_shapes() {
        assert_eq!(Json::parse("[1, 2.5, -3]").unwrap().as_f64s(), Some(vec![1.0, 2.5, -3.0]));
        assert_eq!(Json::parse("[[1], [2]]").unwrap().as_f64s(), Some(vec![1.0, 2.0]));
        assert_eq!(Json::parse("[[1, 2]]").unwrap().as_f64s(), None);
        assert_eq!(Json::parse("[[1, 2, 9], [3, 4]]").unwrap().as_points2(), Some(vec![[1.0, 2.0], [3.0, 4.0]]));
        assert_eq!(Json::parse(r#"[{"x": 1, "y": 2}]"#).unwrap().as_points2(), Some(vec![[1.0, 2.0]]));
        assert_eq!(Json::parse("[1, 2]").unwrap().as_points2(), None);
        assert_eq!(Json::parse(r#"{"a": 1}"#).unwrap().as_f64s(), None);
    }

    #[test]
    fn section_reads_a_reply() {
        let reply = Json::parse(
            r#"{"ok":true,"sections":[{"frame":{"origin":[0,0,10],"u":[1,0,0],"v":[0,1,0],"w":[0,0,1]},"origin":[0,0,10],"turn":[0,0,0],
            "loops":[{"start":[-5,-5],"segments":[]}],"regions":[{"outer":[[-5,-5],[5,-5],[5,5],[-5,5]],"holes":[[[-1,-1],[-1,1],[1,1],[1,-1]]]}],"areaMm2":96}]}"#,
        )
        .unwrap();
        let all = Section::all(&reply);
        assert_eq!(all.len(), 1);
        let s = &all[0];
        assert_eq!(s.frame.w, [0.0, 0.0, 1.0]);
        assert_eq!(s.frame.point([2.0, 3.0]), [2.0, 3.0, 10.0]);
        assert!((s.region.area() - 96.0).abs() < 1e-9);
        assert_eq!(s.area, 96.0);
        assert_eq!(s.loops.as_array().map(|l| l.len()), Some(1));
        let op = s.extrude("cut", -2.0, s.loops.clone());
        assert_eq!(op.get("turn").map(|t| t.to_string()), Some("[0,0,0]".to_string()));
        assert!(Section::all(&Json::obj()).is_empty());
    }

    #[test]
    fn typed_params_json() {
        let s = Session::from_start(&Json::obj());
        let n = s.number("diameter", 80.0).range(20.0, 250.0).step(0.5).unit("mm").label("Outer diameter");
        assert_eq!(n.spec.to_json().to_string(), r#"{"name":"diameter","kind":"number","default":80,"min":20,"max":250,"step":0.5,"unit":"mm","label":"Outer diameter"}"#);
        let c = s.count("holes", 6).range(3, 24).help("Bolt holes");
        assert_eq!(c.spec.to_json().to_string(), r#"{"name":"holes","kind":"count","default":6,"min":3,"max":24,"help":"Bolt holes"}"#);
        assert_eq!(s.toggle("bore", true).spec.to_json().to_string(), r#"{"name":"bore","kind":"toggle","default":true}"#);
        assert_eq!(
            s.choice("edge", &["fillet", "chamfer"], "fillet").spec.to_json().to_string(),
            r#"{"name":"edge","kind":"choice","default":"fillet","options":["fillet","chamfer"]}"#
        );
        assert_eq!(s.text("label", "LIME").max_len(20).spec.to_json().to_string(), r#"{"name":"label","kind":"text","default":"LIME","maxLen":20}"#);
        assert_eq!(API, (1, 17));
    }

    #[test]
    fn a_nested_plugin_run_reads_its_parts() {
        let r = Json::parse(r#"{"ok":true,"object":"obj_3","objects":["obj_2","obj_3"],"metrics":{"teeth":40},"plugin":{"id":"gear-on-arbor","version":2}}"#).unwrap();
        let run = PluginRun::from_json(&r).unwrap();
        assert_eq!(run.plugin, "gear-on-arbor");
        assert_eq!(run.version, 2);
        assert_eq!(run.part, Part { object: "obj_3".to_string() });
        assert_eq!(run.parts.len(), 2);
        assert_eq!(run.metrics.get("teeth").and_then(Json::as_f64), Some(40.0));
        // A host that names only the part it ended on: that part is the one made.
        let one = PluginRun::from_json(&Json::parse(r#"{"object":"obj_9"}"#).unwrap()).unwrap();
        assert_eq!(one.parts, vec![Part { object: "obj_9".to_string() }]);
        assert!(PluginRun::from_json(&Json::parse("{}").unwrap()).is_none());
    }

    #[test]
    fn typed_params_values() {
        let s = Session::from_start(&Json::parse(r#"{"params":{"d":300,"n":4.7,"m":1,"b":false,"e":"round","t":"abcdef","old":2.5}}"#).unwrap());
        assert_eq!(s.number("d", 80.0).range(20.0, 250.0).get(), 250.0);
        assert_eq!(s.number("missing", 80.0).range(20.0, 250.0).get(), 80.0);
        assert_eq!(s.count("n", 6).range(3, 24).get(), 4);
        assert_eq!(s.count("m", 6).range(3, 24).get(), 3);
        assert!(!s.toggle("b", true).get());
        assert_eq!(s.choice("e", &["fillet", "chamfer"], "fillet").get(), "fillet");
        assert_eq!(s.text("t", "x").max_len(3).get(), "abc");
        assert_eq!(s.param_f64("old", 1.0), 2.5);
        assert_eq!(s.param_u32("n", 1), 4);
    }

    #[test]
    fn picked_params_json() {
        let s = Session::from_start(&Json::obj());
        let f = s.face("face").rule("largest_up").label("Face to cut");
        assert_eq!(f.spec.to_json().to_string(), r#"{"name":"face","kind":"face","default":{"rule":"largest_up"},"label":"Face to cut"}"#);
        let g = s.face("side").facing([1.0, 0.0, 0.0]).rule("largest");
        assert_eq!(g.spec.to_json().to_string(), r#"{"name":"side","kind":"face","default":{"rule":"largest","facing":[1,0,0]}}"#);
        assert_eq!(s.face("any").spec.to_json().to_string(), r#"{"name":"any","kind":"face","default":null}"#);
        let o = s.outline("shape").default_poly(&geom2d::rect(4.0, 2.0)).help("A sketch or a face");
        assert_eq!(
            o.spec.to_json().to_string(),
            r#"{"name":"shape","kind":"outline","default":{"loops":[{"start":[-2,-1],"segments":[{"kind":"line","to":[2,-1]},{"kind":"line","to":[2,1]},{"kind":"line","to":[-2,1]},{"kind":"line","to":[-2,-1]}]}]},"help":"A sketch or a face"}"#
        );
        assert_eq!(s.outline("rim").default_face("top").spec.to_json().to_string(), r#"{"name":"rim","kind":"outline","default":{"face":{"rule":"top"}}}"#);
        assert_eq!(FACE_RULES.len(), 5);
    }

    #[test]
    fn a_curved_face_parameter_says_so_and_a_flat_one_does_not() {
        let s = Session::from_start(&Json::obj());
        assert_eq!(
            s.face("wall").curved().label("Wall").spec.to_json().to_string(),
            r#"{"name":"wall","kind":"face","default":null,"label":"Wall","curved":true}"#
        );
        assert_eq!(s.face("top").rule("top").spec.to_json().to_string(), r#"{"name":"top","kind":"face","default":{"rule":"top"}}"#);
        let p = s.face("wall").curved().get();
        assert!(p.curved);
        assert!(!s.face("top").get().curved);
        // A curved face is kept by its surface and a point.
        let given = Session::from_start(&Json::parse(r#"{"params":{"wall":{"surface":"cylinder","nearPoint":[-20,0,20]}}}"#).unwrap());
        assert_eq!(given.face("wall").curved().get().value.to_string(), r#"{"surface":"cylinder","nearPoint":[-20,0,20]}"#);
    }

    fn face_of(kind: &str, index: u32) -> PickedFace {
        PickedFace {
            index,
            normal: if kind == "plane" { [0.0, 0.0, 1.0] } else { [0.0; 3] },
            point: [-20.0, 0.0, 20.0],
            area: 10.0,
            outline: Section::from_json(&Json::obj()),
            kind: kind.to_string(),
            axis: None,
            radius: None,
            centre: None,
            axis_point: None,
        }
    }

    #[test]
    fn lettering_is_the_text_op_with_the_fields_given() {
        let flat = Lettering::new(6.0, 0.8).font("mono").style("bold").align("left").spacing(0.2).op("LOT 42", &face_of("plane", 3));
        assert_eq!(
            flat.to_string(),
            r#"{"kind":"text","faceIndex":3,"text":"LOT 42","height":6,"font":"mono","style":"bold","spacing":0.2,"align":"left","depth":0.8}"#
        );
        let round = Lettering::new(5.0, 0.6).font("line").around().flip().engrave().angle(10.0).op("Lime", &face_of("cylinder", 1));
        assert_eq!(
            round.to_string(),
            r#"{"kind":"text","faceIndex":1,"text":"Lime","height":5,"font":"line","depth":0.6,"point":[-20,0,20],"op":"cut","angleDeg":10,"along":"around","flip":true}"#
        );
        let sphere = Lettering::new(4.0, 0.5).u().project().stroke_width(0.5).op("A", &face_of("sphere", 2));
        assert_eq!(sphere.get("wrap").and_then(Json::as_str), Some("project"));
        assert_eq!(sphere.get("strokeWidth").and_then(Json::as_f64), Some(0.5));
        assert_eq!(sphere.get("along").and_then(Json::as_str), Some("u"));
    }

    #[test]
    fn the_outline_call_takes_the_layout_fields_and_no_depth() {
        let how = Lettering::new(10.0, 0.0).font("sans").style("bold").line_spacing(1.5);
        assert_eq!(how.outline_args("LIME").to_string(), r#"{"text":"LIME","height":10,"font":"sans","style":"bold","lineSpacing":1.5}"#);
    }

    #[test]
    fn picked_params_values() {
        let s = Session::from_start(&Json::parse(r#"{"params":{"face":{"normal":[0,0,1],"nearPoint":[1,2,3]},"n":4,"shape":{"sketch":7}}}"#).unwrap());
        let f = s.face("face").rule("largest").get();
        assert_eq!(f.kind, "face");
        assert_eq!(f.value.to_string(), r#"{"normal":[0,0,1],"nearPoint":[1,2,3]}"#);
        assert_eq!(s.face("n").get().value.to_string(), "4");
        assert_eq!(s.face("missing").rule("top").get().value.to_string(), r#"{"rule":"top"}"#);
        assert_eq!(s.outline("shape").get().value.to_string(), r#"{"sketch":7}"#);
        assert_eq!(s.outline("none").get().value, Json::Null);
    }

    #[test]
    fn combined_reads_failures() {
        let r = Json::parse(r#"{"ok":true,"applied":3,"failures":[{"index":1,"reason":"no"}]}"#).unwrap();
        let c = Combined::from_json(&r);
        assert_eq!(c.applied, 3);
        assert_eq!(c.failures, vec![(1, "no".to_string())]);
    }

    #[test]
    fn a_flush_gives_each_refusal_its_line() {
        // API 1.11: `flush` answers the explicit queue's refusals by their place and recipe line.
        let r = Json::parse(r#"{"ok":true,"applied":2,"failures":[{"index":1,"reason":"no","line":41},{"index":3,"reason":"nor"}]}"#).unwrap();
        let c = Combined::from_json(&r);
        assert_eq!(c.applied, 2);
        assert_eq!(c.failures, vec![(1, "no".to_string()), (3, "nor".to_string())]);
        assert_eq!(c.lines(), vec![41, 0]);
        assert_eq!(Combined::from_json(&Json::obj()).lines(), Vec::<u32>::new());
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

#[cfg(test)]
mod geom_tests {
    use super::geom2d::*;
    use super::lattice;
    use std::f64::consts::PI;

    fn near(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    fn sq(x0: f64, y0: f64, s: f64) -> Region {
        Region::from_poly(&rect(s, s).translate(x0 + s / 2.0, y0 + s / 2.0))
    }

    /// Area by counting a fine grid of sample points: an independent check of a boolean.
    fn sampled_area(r: &Region, lo: Pt, hi: Pt, n: usize) -> f64 {
        let (dx, dy) = ((hi[0] - lo[0]) / n as f64, (hi[1] - lo[1]) / n as f64);
        let mut inside = 0;
        for i in 0..n {
            for j in 0..n {
                if r.contains([lo[0] + (i as f64 + 0.5) * dx + 1.234e-5, lo[1] + (j as f64 + 0.5) * dy + 2.345e-5]) {
                    inside += 1;
                }
            }
        }
        inside as f64 * dx * dy
    }

    #[test]
    fn own_trigonometry_matches_std() {
        for k in -4000..4000 {
            let deg = k as f64 * 0.37;
            let (s, c) = sin_cos_deg(deg);
            let turned = (deg - 360.0 * (deg / 360.0).round()).to_radians();
            assert!(near(s, turned.sin(), 4e-16) && near(c, turned.cos(), 4e-16), "{deg}");
        }
        assert_eq!(sin_cos_deg(90.0), (1.0, 0.0));
        assert_eq!(sin_cos_deg(-180.0), (0.0, -1.0));
        assert_eq!(sin_cos_deg(450.0), (1.0, 0.0));
        let hex = regular(6, Size::Side(10.0), [0.0, 0.0], 90.0);
        assert_eq!(hex.pts[0], [0.0, 10.0]);
    }

    #[test]
    fn shapes_and_measures() {
        let r = rect(4.0, 2.0);
        assert_eq!(r.area(), 8.0);
        assert_eq!(r.perimeter(), 12.0);
        assert_eq!(r.bbox(), [[-2.0, -1.0], [2.0, 1.0]]);
        assert_eq!(r.translate(3.0, 1.0).centroid(), [3.0, 1.0]);
        assert!(r.is_convex());
        assert!(r.contains([0.0, 0.0]) && r.contains([2.0, 0.5]) && !r.contains([2.1, 0.0]));
        assert_eq!(r.reversed().area(), -8.0);
        let hex = regular(6, Size::Side(10.0), [0.0, 0.0], 90.0);
        assert!(near(hex.area(), 1.5 * 3f64.sqrt() * 100.0, 1e-9));
        assert!(near(hex.pts[0][1], 10.0, 1e-12) && near(hex.pts[0][0], 0.0, 1e-12));
        let flats = regular(6, Size::Across(10.0), [0.0, 0.0], 0.0);
        assert!(near(flats.bbox()[1][1] * 2.0, 10.0, 1e-9));
        let corners = regular(5, Size::Corners(10.0), [1.0, 2.0], 0.0);
        assert!(near(corners.pts[0][0], 6.0, 1e-12));
        let sq5 = regular(4, Size::Side(5.0), [0.0, 0.0], 45.0);
        assert!(near(sq5.area(), 25.0, 1e-9));
        assert!(near(circle(10.0, 720).area(), PI * 100.0, 0.01));
        let l = Poly::new(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [10.0, 10.0], [10.0, 20.0], [0.0, 20.0], [0.0, 0.0]]);
        assert_eq!(l.pts.len(), 6);
        assert!(!l.is_convex());
        assert!(!l.contains([15.0, 15.0]) && l.contains([5.0, 15.0]) && l.contains([10.0, 15.0]));
        let bowtie = Poly::new(vec![[0.0, 0.0], [2.0, 2.0], [2.0, 0.0], [0.0, 2.0]]);
        assert!(!bowtie.is_convex());
        assert_eq!(Poly::default().area(), 0.0);
        assert_eq!(Poly::default().centroid(), [0.0, 0.0]);
    }

    #[test]
    fn batched_region_booleans_preserve_union_and_holes() {
        let a = sq(0.0, 0.0, 6.0);
        let b = sq(4.0, 1.0, 4.0);
        let c = sq(2.0, 3.0, 4.0);
        let batch = Region::union_all(&[a.clone(), b.clone(), c.clone()]);
        let folded = a.union(&b).union(&c);
        assert!(near(batch.area(), folded.area(), 1e-8));
        let cut = a.difference_all(&[b.clone(), c.clone()]);
        let folded_cut = a.difference(&b).difference(&c);
        assert!(near(cut.area(), folded_cut.area(), 1e-8));
        let ring = sq(0.0, 0.0, 10.0).difference(&sq(2.0, 2.0, 6.0));
        let fill = sq(3.0, 3.0, 2.0);
        let merged = Region::union_all(&[ring.clone(), fill.clone()]);
        assert!(near(merged.area(), ring.union(&fill).area(), 1e-8));
        assert!(merged.contains([4.0, 4.0]));
        assert!(!merged.contains([6.0, 6.0]));
        assert!(Region::union_all(&[]).is_empty());
        assert!(near(a.difference_all(&[]).area(), a.area(), 1e-8));
    }

    #[test]
    fn union_polys_and_slab_winding_match_sequential_union() {
        assert!(Region::union_polys(&[]).is_empty());
        // Enough overlapping curved loops (> 32 edges) to exercise the slab-bucketed winding pass
        // with both horizontal and vertical rays and nested holes.
        let mut polys = Vec::new();
        for i in 0..5 {
            let x = i as f64 * 1.4;
            let p = circle(1.2, 24).translate(x, (i % 2) as f64 * 0.4);
            // Flip alternating orientations to verify union_polys normalizes winding.
            polys.push(if i % 2 == 0 { p } else { p.reversed() });
        }
        let batch = Region::union_polys(&polys);
        let mut folded = Region::empty();
        for p in &polys {
            folded = folded.union(&Region::from_poly(p));
        }
        assert!(near(batch.area(), folded.area(), 1e-6));
        let ring = circle(6.0, 48);
        let inner = circle(3.0, 32);
        let inner_area = inner.area();
        let cut = Region::with_holes(&ring, &[inner]);
        assert!(near(cut.area(), ring.area() - inner_area, 1e-6));
        assert!(!cut.contains([0.0, 0.0]));
        assert!(cut.contains([4.5, 0.0]));
    }

    #[test]
    fn slab_resolve_matches_reference_on_grid_rectangles_and_slots() {
        // Canonical loop representation so we compare exact kept polygons (not just areas).
        fn canon(r: &Region) -> Vec<Vec<[i64; 2]>> {
            let mut loops: Vec<Vec<[i64; 2]>> = r
                .loops()
                .iter()
                .map(|l| {
                    let mut pts: Vec<[i64; 2]> = l
                        .pts
                        .iter()
                        .map(|p| [(p[0] * 1e6).round() as i64, (p[1] * 1e6).round() as i64])
                        .collect();
                    if let Some((min_i, _)) = pts.iter().enumerate().min_by_key(|(_, p)| *p) {
                        pts.rotate_left(min_i);
                    }
                    pts
                })
                .collect();
            loops.sort();
            loops
        }

        // Deterministic PRNG (xorshift64) on a coarse integer/half-integer grid where edges and
        // vertices deliberately align with horizontal/vertical rays and slab bin boundaries.
        let mut seed = 0x51a8_beef_cafe_1234u64;
        let mut next_u64 = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let grid_rect = |rng: &mut dyn FnMut() -> u64| -> Poly {
            let x = (rng() % 12) as f64 * 0.5;
            let y = (rng() % 12) as f64 * 0.5;
            let w = (1 + rng() % 6) as f64 * 0.5;
            let h = (1 + rng() % 6) as f64 * 0.5;
            Poly::new(vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
        };
        let grid_slot = |rng: &mut dyn FnMut() -> u64| -> Poly {
            let x = (rng() % 10) as f64 * 0.5;
            let y = (rng() % 10) as f64 * 0.5;
            let len_s = (2 + rng() % 6) as f64 * 0.5;
            let r = (1 + rng() % 3) as f64 * 0.25;
            let horiz = (rng() & 1) == 0;
            let n = 8usize;
            let mut pts = Vec::with_capacity(2 * n + 2);
            if horiz {
                for i in 0..=n {
                    let a = -PI / 2.0 + PI * i as f64 / n as f64;
                    pts.push([x + len_s + r * a.cos(), y + r * a.sin()]);
                }
                for i in 0..=n {
                    let a = PI / 2.0 + PI * i as f64 / n as f64;
                    pts.push([x + r * a.cos(), y + r * a.sin()]);
                }
            } else {
                for i in 0..=n {
                    let a = PI * i as f64 / n as f64;
                    pts.push([x + r * a.cos(), y + len_s + r * a.sin()]);
                }
                for i in 0..=n {
                    let a = PI + PI * i as f64 / n as f64;
                    pts.push([x + r * a.cos(), y + r * a.sin()]);
                }
            }
            Poly::new(pts)
        };

        let mut checked = 0usize;
        let mut slab_cases = 0usize;
        // 1,000 cases x 3 ops (union, difference, intersect) = 3,000 boolean checks across
        // coarse-grid axis-aligned rectangles and rounded slots, including multi-shape sets >= 32 edges.
        for case in 0..1000usize {
            let count_a = if case % 3 == 0 { 10 } else { 3 };
            let count_b = if case % 3 == 0 { 8 } else { 3 };
            let mut set_a = Vec::with_capacity(count_a);
            let mut set_b = Vec::with_capacity(count_b);
            for k in 0..count_a {
                if (case + k) % 4 == 0 {
                    set_a.push(grid_slot(&mut next_u64));
                } else {
                    set_a.push(grid_rect(&mut next_u64));
                }
            }
            for k in 0..count_b {
                if (case + k) % 4 == 1 {
                    set_b.push(grid_slot(&mut next_u64));
                } else {
                    set_b.push(grid_rect(&mut next_u64));
                }
            }
            let ra = Region::union_polys(&set_a);
            let rb = Region::union_polys(&set_b);
            let edge_count: usize = ra.loops().iter().chain(rb.loops().iter()).map(|l| l.pts.len()).sum();
            if edge_count >= 32 {
                slab_cases += 1;
            }
            for (kind, actual) in [
                ("union", ra.union(&rb)),
                ("difference", ra.difference(&rb)),
                ("intersect", ra.intersect(&rb)),
            ] {
                let expected = resolve_local_normal_ray_ref(ra.loops(), rb.loops(), kind);
                assert_eq!(
                    canon(&actual),
                    canon(&expected),
                    "case {case} ({kind}, edges={edge_count}) differed"
                );
                checked += 1;
            }
        }
        assert_eq!(checked, 3000);
        assert!(slab_cases > 300, "expected >= 32-edge slab cases, got {slab_cases}");
    }

    #[test]
    fn booleans_of_squares() {
        let a = sq(0.0, 0.0, 2.0);
        let b = sq(1.0, 1.0, 2.0);
        assert!(near(a.union(&b).area(), 7.0, 1e-9));
        assert_eq!(a.union(&b).loops().len(), 1);
        assert_eq!(a.union(&b).loops()[0].pts.len(), 8);
        assert!(near(a.intersect(&b).area(), 1.0, 1e-9));
        assert!(near(a.difference(&b).area(), 3.0, 1e-9));
        assert!(near(a.xor(&b).area(), 6.0, 1e-9));
        assert_eq!(a.xor(&b).pieces().len(), 2);
        // Sharing a whole edge: one outline, the shared edge and its split points gone.
        let c = sq(2.0, 0.0, 2.0);
        let u = a.union(&c);
        assert_eq!(u.loops().len(), 1);
        assert_eq!(u.loops()[0].pts.len(), 4);
        assert!(near(u.area(), 8.0, 1e-9));
        assert!(a.intersect(&c).is_empty());
        // Touching at one corner: two pieces.
        let d = sq(2.0, 2.0, 2.0);
        assert_eq!(a.union(&d).pieces().len(), 2);
        assert!(near(a.union(&d).area(), 8.0, 1e-9));
        // The same square twice.
        assert!(near(a.union(&a).area(), 4.0, 1e-9));
        assert!(a.difference(&a).is_empty());
        assert!(near(a.intersect(&a).area(), 4.0, 1e-9));
        // Missing entirely.
        let far = sq(10.0, 10.0, 1.0);
        assert!(a.intersect(&far).is_empty());
        assert!(near(a.difference(&far).area(), 4.0, 1e-9));
        assert!(near(Region::empty().union(&a).area(), 4.0, 1e-9));
        // Hexagons that only share an edge.
        let h1 = Region::from_poly(&regular(6, Size::Side(20.0), [0.0, 0.0], 90.0));
        let h2 = Region::from_poly(&regular(6, Size::Side(20.0), [20.0 * 3f64.sqrt(), 0.0], 90.0));
        assert!(h1.intersect(&h2).is_empty(), "{:?}", h1.intersect(&h2));
        assert_eq!(h1.union(&h2).loops().len(), 1);
        assert!(Region::empty().intersect(&a).is_empty());
    }

    #[test]
    fn booleans_with_holes_and_concave_outlines() {
        let big = sq(0.0, 0.0, 10.0);
        let small = sq(3.0, 3.0, 4.0);
        let ring = big.difference(&small);
        assert_eq!(ring.loops().len(), 2);
        assert!(ring.loops()[0].area() > 0.0 && ring.loops()[1].area() < 0.0);
        assert_eq!(ring.pieces().len(), 1);
        assert!(near(ring.area(), 84.0, 1e-9));
        assert!(!ring.contains([5.0, 5.0]) && ring.contains([1.0, 5.0]) && ring.contains([3.0, 5.0]));
        // Filling the hole back gives the square again, as one loop.
        let filled = ring.union(&small);
        assert_eq!(filled.loops().len(), 1);
        assert!(near(filled.area(), 100.0, 1e-9));
        // An island in the hole.
        let island = sq(4.0, 4.0, 2.0);
        let with_island = ring.union(&island);
        assert_eq!(with_island.pieces().len(), 2);
        assert!(near(with_island.area(), 88.0, 1e-9));
        // A bar across the ring cuts it in two.
        let bar = Region::from_poly(&rect(2.0, 20.0).translate(5.0, 5.0));
        let halves = ring.difference(&bar);
        assert_eq!(halves.pieces().len(), 2);
        assert!(near(halves.area(), 84.0 - 2.0 * 6.0, 1e-9));
        // A concave L against a square across its notch.
        let l = Region::from_poly(&Poly::new(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [10.0, 10.0], [10.0, 20.0], [0.0, 20.0]]));
        let s = sq(5.0, 5.0, 10.0);
        assert!(near(l.intersect(&s).area(), 75.0, 1e-9));
        assert!(near(l.union(&s).area(), 300.0 + 25.0, 1e-9));
        assert!(near(l.difference(&s).area(), 300.0 - 75.0, 1e-9));
        let lo = [-1.0, -1.0];
        let hi = [21.0, 21.0];
        for r in [l.intersect(&s), l.union(&s), l.difference(&s), l.xor(&s), ring.difference(&bar)] {
            let sampled = sampled_area(&r, lo, hi, 440);
            assert!(near(sampled, r.area(), 0.5), "{} vs {}", sampled, r.area());
        }
    }

    #[test]
    fn booleans_of_curved_and_star_shapes() {
        let c = Region::from_poly(&circle(10.0, 96));
        let star: Vec<Pt> = (0..10)
            .map(|k| {
                let r = if k % 2 == 0 { 14.0 } else { 5.0 };
                let a = (90.0 + 36.0 * k as f64).to_radians();
                [r * a.cos(), r * a.sin()]
            })
            .collect();
        let s = Region::from_poly(&Poly::new(star));
        let i = c.intersect(&s);
        let u = c.union(&s);
        let d = c.difference(&s);
        assert!(near(i.area() + u.area(), c.area() + s.area(), 1e-6));
        assert!(near(d.area(), c.area() - i.area(), 1e-6));
        assert_eq!(d.pieces().len(), 5);
        assert_eq!(s.difference(&c).pieces().len(), 5);
        let lo = [-15.0, -15.0];
        let hi = [15.0, 15.0];
        for r in [&i, &u, &d] {
            assert!(near(sampled_area(r, lo, hi, 600), r.area(), 0.6));
        }
    }

    /// Random outlines on a coarse grid, so edges overlap, cross at corners and touch: the
    /// area identities of the four booleans hold and the results' loops are valid inputs again.
    #[test]
    fn random_grid_outlines() {
        let mut seed: u64 = 12345;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) % n) as f64
        };
        for round in 0..400 {
            let mut make = || {
                let k = 3 + next(6) as usize;
                let pts: Vec<Pt> = (0..k).map(|_| [next(7) * 2.0, next(7) * 2.0]).collect();
                Poly::new(pts)
            };
            let a = Region::from_poly(&make());
            let pb = make();
            let b = Region::from_poly(&pb);
            assert!(near(a.clip(&pb).area(), a.intersect(&b).area(), 1e-9), "round {round}: clip");
            let (u, i, d, x) = (a.union(&b), a.intersect(&b), a.difference(&b), a.xor(&b));
            assert!(near(u.area() + i.area(), a.area() + b.area(), 1e-9), "round {round}: {a:?} {b:?}");
            assert!(near(d.area(), a.area() - i.area(), 1e-9), "round {round}");
            assert!(near(x.area(), u.area() - i.area(), 1e-9), "round {round}");
            for r in [&u, &i, &d, &x] {
                for l in r.loops().iter() {
                    assert!(l.pts.len() >= 3);
                    assert!((0..l.pts.len()).all(|p| (p + 1..l.pts.len()).all(|q| l.pts[p] != l.pts[q])), "round {round}: a loop touches itself");
                }
                assert!(near(r.union(&Region::empty()).area(), r.area(), 1e-9), "round {round}: not stable");
            }
            let grown = a.offset_miter(0.7);
            let shrunk = a.offset_miter(-0.4);
            assert!(grown.area() >= a.area() - 1e-9 && shrunk.area() <= a.area() + 1e-9, "round {round}");
            assert!(shrunk.loops().iter().all(|l| l.pts.iter().all(|p| a.contains(*p))), "round {round}: shrunk outside");
            assert!(a.offset(0.7).to_region(0.001).difference(&grown).area() < 1e-6, "round {round}: rounded beyond mitred");
            if round % 30 == 0 {
                assert!(near(sampled_area(&d, [0.0, 0.0], [12.0, 12.0], 240), d.area(), 0.3), "round {round}: {} vs {}
A {:?}
B {:?}
D {:?}", sampled_area(&d, [0.0, 0.0], [12.0, 12.0], 240), d.area(), a, b, d);
            }
        }
    }

    #[test]
    fn degenerate_input() {
        let flat = Region::from_poly(&Poly::new(vec![[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]]));
        assert!(flat.is_empty());
        let two = Region::from_poly(&Poly::new(vec![[0.0, 0.0], [1.0, 0.0]]));
        assert!(two.is_empty());
        // A loop that touches itself at one point is two pieces.
        let touch = Poly::new(vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [2.0, 1.0], [2.0, 2.0], [1.0, 2.0], [1.0, 1.0], [0.0, 1.0]]);
        let r = Region::from_poly(&touch);
        assert_eq!(r.pieces().len(), 2);
        assert!(near(r.area(), 2.0, 1e-12));
        // A self-crossing bow tie keeps both lobes.
        let bowtie = Region::from_poly(&Poly::new(vec![[0.0, 0.0], [2.0, 2.0], [2.0, 0.0], [0.0, 2.0]]));
        assert_eq!(bowtie.pieces().len(), 2);
        assert!(near(bowtie.area(), 2.0, 1e-12));
        // A hole drawn on the outline's edge leaves a U.
        let u = Region::with_holes(&rect(4.0, 4.0).translate(2.0, 2.0), &[rect(2.0, 2.0).translate(2.0, 1.0)]);
        assert_eq!(u.loops().len(), 1);
        assert!(near(u.area(), 12.0, 1e-12));
        // Nested any way round: even-odd.
        let nest = Region::from_loops(&[rect(10.0, 10.0), rect(6.0, 6.0), rect(2.0, 2.0)]);
        assert_eq!(nest.pieces().len(), 2);
        assert!(near(nest.area(), 100.0 - 36.0 + 4.0, 1e-12));
    }

    #[test]
    fn corners_round_and_chamfer() {
        let r = rect(20.0, 10.0).round_corners(2.0);
        assert_eq!(r.counts(), [4, 0, 0]);
        assert!(near(r.area(), 200.0 - (4.0 - PI) * 4.0, 1e-9));
        let json = r.to_loop().to_string();
        assert!(json.starts_with(r#"{"start":[-8,-5],"segments":[{"kind":"line","to":[8,-5]},{"kind":"arc","through":["#), "{json}");
        // Edges shorter than the radius: each corner shrinks to fit.
        let thin = rect(10.0, 1.0).round_corners(2.0);
        assert!(thin.corners[0].iter().all(|c| matches!(c, Corner::Reduced(r) if near(*r, 0.5, 1e-12))));
        assert!(near(thin.area(), 10.0 - (4.0 - PI) * 0.25, 1e-9));
        // A share limit and a minimum radius, as the honeycomb recipe rounds its cells.
        let capped = rect(10.0, 1.0).round_corners_with(2.0, 0.45, 0.0);
        assert_eq!(capped.counts(), [0, 4, 0]);
        assert!(capped.corners[0].iter().all(|c| matches!(c, Corner::Reduced(r) if near(*r, 0.45, 1e-12))));
        let sharp = rect(10.0, 1.0).round_corners_with(2.0, 0.45, 0.5);
        assert_eq!(sharp.counts(), [0, 0, 4]);
        assert_eq!(sharp.to_loop().to_string(), rect(10.0, 1.0).to_loop().to_string());
        // A concave corner is rounded the other way: material is added.
        let l = Poly::new(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [10.0, 10.0], [10.0, 20.0], [0.0, 20.0]]);
        let lr = l.round_corners(1.0);
        assert_eq!(lr.counts(), [6, 0, 0]);
        assert!(near(lr.area(), 300.0 - 5.0 * (4.0 - PI) / 4.0 + (4.0 - PI) / 4.0, 1e-9));
        let ch = rect(10.0, 10.0).chamfer_corners(1.0);
        assert_eq!(ch.counts(), [4, 0, 0]);
        assert!(near(ch.area(), 100.0 - 2.0, 1e-9));
        assert_eq!(ch.paths[0].segs.len(), 8);
        let ch_short = rect(10.0, 1.0).chamfer_corners(1.0);
        assert!(ch_short.corners[0].iter().all(|c| matches!(c, Corner::Reduced(r) if near(*r, 0.5, 1e-12))));
        let rr = rounded_rect(30.0, 20.0, 5.0);
        assert!(near(rr.area(), 600.0 - (4.0 - PI) * 25.0, 1e-9));
        let back = rr.to_region(0.001);
        assert!(near(back.area(), rr.area(), 0.03), "{} vs {}", back.area(), rr.area());
        assert!(near(rr.to_region(1e-5).area(), rr.area(), 3e-4));
        assert!(back.contains([0.0, 0.0]) && !back.contains([14.9, 9.9]));
    }

    // The three corner fixtures shared with the sketch card's Offset (docs/plan-sketch-for-people.md, 7a).
    #[test]
    fn offset_fixture_outside_corner() {
        let square = Region::from_poly(&rect(20.0, 20.0).translate(10.0, 10.0));
        let grown = square.offset(2.0);
        assert_eq!(grown.counts(), [4, 0, 0]);
        assert!(near(grown.area(), 400.0 + 4.0 * 20.0 * 2.0 + PI * 4.0, 1e-9));
        // Each arc is centred on the original corner: the corner at (20, 20) bulges to (21.414, 21.414).
        let s = 2.0 / 2f64.sqrt();
        let arcs: Vec<Pt> = grown.paths[0]
            .segs
            .iter()
            .filter_map(|g| match g {
                Seg::Arc(m, _) => Some(*m),
                Seg::Line(_) => None,
            })
            .collect();
        assert!(arcs.iter().any(|m| near(m[0], 20.0 + s, 1e-9) && near(m[1], 20.0 + s, 1e-9)), "{arcs:?}");
        let shrunk = square.offset(-2.0);
        assert_eq!(shrunk.counts(), [0, 0, 4]);
        assert!(near(shrunk.area(), 256.0, 1e-9));
    }

    #[test]
    fn offset_fixture_inside_corner() {
        let l = Region::from_poly(&Poly::new(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [10.0, 10.0], [10.0, 20.0], [0.0, 20.0]]));
        let grown = l.offset(1.0);
        assert_eq!(grown.counts(), [5, 0, 1]);
        let path = &grown.paths[0];
        let ends: Vec<Pt> = path
            .segs
            .iter()
            .map(|g| match g {
                Seg::Line(to) => *to,
                Seg::Arc(_, to) => *to,
            })
            .collect();
        assert!(ends.contains(&[11.0, 11.0]), "{ends:?}");
        assert!(near(grown.area(), 300.0 + 80.0 - 1.0 + 1.25 * PI, 1e-9));
        // Shrinking: the inside corner becomes the outside one and is the only one rounded.
        let shrunk = l.offset(-1.0);
        assert_eq!(shrunk.counts(), [1, 0, 5]);
    }

    #[test]
    fn offset_fixture_short_edge_corner() {
        // A 1 mm step: grown by 2, the corner above it has 1 mm of edge, so its radius is reduced to 1.
        let step = Region::from_poly(&Poly::new(vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [11.0, 10.0], [11.0, 11.0], [0.0, 11.0]]));
        let grown = step.offset(2.0);
        assert_eq!(grown.counts(), [4, 1, 1]);
        assert!(grown.corners[0].iter().any(|c| matches!(c, Corner::Reduced(r) if near(*r, 1.0, 1e-9))), "{:?}", grown.corners);
        assert!(grown.area() > step.area());
    }

    #[test]
    fn offsets() {
        let ring = sq(0.0, 0.0, 10.0).difference(&sq(3.0, 3.0, 4.0));
        let m = ring.offset_miter(-1.0);
        assert!(near(m.area(), 64.0 - 36.0, 1e-9));
        assert_eq!(m.loops().len(), 2);
        assert!(ring.offset_miter(-2.0).area() < 1e-9);
        assert!(sq(0.0, 0.0, 2.0).offset(-1.5).paths.is_empty());
        assert!(near(sq(0.0, 0.0, 2.0).offset_miter(1.0).area(), 16.0, 1e-9));
        assert_eq!(ring.offset(0.0).paths.len(), 2);
        // Growing two squares 4 mm apart by 2.5: they join.
        let two = sq(0.0, 0.0, 10.0).union(&sq(14.0, 0.0, 10.0));
        assert_eq!(two.offset_miter(2.5).pieces().len(), 1);
        assert_eq!(two.offset_miter(1.5).pieces().len(), 2);
        // A circle grows by the distance.
        let c = Region::from_poly(&circle(10.0, 360)).offset_miter(2.0);
        assert!(near(c.area(), PI * 144.0, 0.05));
        // A dumbbell shrunk past its neck comes apart.
        let bell = sq(0.0, 0.0, 10.0).union(&sq(20.0, 0.0, 10.0)).union(&Region::from_poly(&rect(12.0, 2.0).translate(15.0, 5.0)));
        assert_eq!(bell.pieces().len(), 1);
        assert_eq!(bell.offset_miter(-1.5).pieces().len(), 2);
    }

    #[test]
    fn cleanup() {
        let messy = Poly::new(vec![[0.0, 0.0], [0.01, 0.0], [5.0, 0.0], [10.0, 0.001], [10.0, 10.0], [0.0, 10.0], [0.0, 5.0]]);
        assert_eq!(messy.clean(0.05).pts, vec![[0.0, 0.0], [10.0, 0.001], [10.0, 10.0], [0.0, 10.0]]);
        let sliver = Poly::new(vec![[0.0, 0.0], [10.0, 0.0], [10.0, 0.02], [0.0, 0.02]]);
        assert!(sliver.clean(0.05).pts.is_empty());
        assert_eq!(sliver.clean(0.01).pts.len(), 4);
        let spike = Poly::new(vec![[0.0, 0.0], [10.0, 0.0], [20.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]);
        assert_eq!(spike.clean(1e-6).pts.len(), 4);
        let r = Region::from_loops(&[rect(10.0, 10.0), sliver.translate(-20.0, 0.0)]);
        assert_eq!(r.loops().len(), 2);
        assert_eq!(r.clean(0.05).loops().len(), 1);
    }

    #[test]
    fn loops_json() {
        let p = Poly::new(vec![[0.0, 0.0], [1.5, 0.0], [0.0, 2.0]]);
        assert_eq!(
            p.to_loop().to_string(),
            r#"{"start":[0,0],"segments":[{"kind":"line","to":[1.5,0]},{"kind":"line","to":[0,2]},{"kind":"line","to":[0,0]}]}"#
        );
        let ring = sq(0.0, 0.0, 10.0).difference(&sq(3.0, 3.0, 4.0)).union(&sq(20.0, 0.0, 2.0));
        let loops = ring.to_loops();
        assert_eq!(loops.len(), 2);
        assert_eq!(loops[0].as_array().map(|a| a.len()), Some(2));
        assert_eq!(loops[1].as_array().map(|a| a.len()), Some(1));
        let rounded = ring.round_corners(0.5).to_loops();
        assert_eq!(rounded.iter().map(|l| l.as_array().map(|a| a.len()).unwrap_or(0)).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(rounded[0].at("1.segments.1.kind").and_then(|k| k.as_str()), Some("arc"));
    }

    #[test]
    fn lattices() {
        let floor = Region::from_poly(&rect(100.0, 60.0));
        let cells = lattice::hex(10.0, lattice::Orient::Pointy).cells(&floor, 0.0);
        let total: f64 = cells.iter().map(|c| c.area()).sum();
        assert!(near(total, 6000.0, 1e-6));
        assert!(cells.iter().any(|c| !c.clipped) && cells.iter().any(|c| c.clipped));
        let full = cells.iter().find(|c| c.index == [0, 0]).unwrap();
        assert!(!full.clipped && near(full.area(), 1.5 * 3f64.sqrt() * 100.0, 1e-9));
        assert_eq!(full.centre, [0.0, 0.0]);
        let odd = cells.iter().find(|c| c.index == [0, 1]).unwrap();
        assert!(near(odd.centre[0], 3f64.sqrt() * 5.0, 1e-12) && near(odd.centre[1], 15.0, 1e-12));
        // Walls: a 2.4 mm rib leaves a pocket of side 10 - 2.4/√3.
        let pockets = lattice::hex(10.0, lattice::Orient::Pointy).rib(2.4).cells(&floor, 12.0);
        let p0 = pockets.iter().find(|c| c.index == [0, 0]).unwrap();
        let a2 = 10.0 - 2.4 / 3f64.sqrt();
        assert!(near(p0.area(), 1.5 * 3f64.sqrt() * a2 * a2, 1e-9));
        assert!(pockets.iter().all(|c| c.area() >= 12.0));
        // Flat hexagons: a flat side on top.
        let flat = lattice::hex(10.0, lattice::Orient::Flat).cells(&floor, 0.0);
        let f0 = flat.iter().find(|c| c.index == [0, 0]).unwrap();
        assert!(near(f0.region.bbox()[1][1], 3f64.sqrt() * 5.0, 1e-9));
        // Squares fill exactly, bricks and triangles tile too.
        let squares = lattice::rect(10.0, 10.0).at([5.0, 5.0]).cells(&floor, 0.0);
        assert_eq!(squares.len(), 60);
        assert!(squares.iter().all(|c| !c.clipped));
        let bricks: f64 = lattice::staggered(10.0, 5.0, 5.0).cells(&floor, 0.0).iter().map(|c| c.area()).sum();
        assert!(near(bricks, 6000.0, 1e-6));
        let tris = lattice::tri(10.0).cells(&floor, 0.0);
        assert!(near(tris.iter().map(|c| c.area()).sum::<f64>(), 6000.0, 1e-6));
        let t0 = tris.iter().find(|c| c.index == [0, 0]).unwrap();
        assert!(near(t0.centre[1], -10.0 * 3f64.sqrt() / 12.0, 1e-12));
        // A ring: no cell in the hole.
        let ring = floor.difference(&Region::from_poly(&rect(40.0, 30.0)));
        let ring_cells = lattice::rect(5.0, 5.0).cells(&ring, 0.0);
        assert!(near(ring_cells.iter().map(|c| c.area()).sum::<f64>(), 6000.0 - 1200.0, 1e-6));
        // Along a line, and a turned grid.
        let pegs = lattice::along(&[[0.0, 0.0], [30.0, 0.0], [30.0, 40.0]], 8, circle(1.0, 24)).cells(&Region::from_poly(&rect(200.0, 200.0)), 0.0);
        assert_eq!(pegs.len(), 8);
        assert!(near(pegs[7].centre[0], 30.0, 1e-12) && near(pegs[7].centre[1], 40.0, 1e-12));
        assert!(near(pegs[1].centre[0], 10.0, 1e-12));
        let turned = lattice::rect(10.0, 10.0).turned(45.0).at([1.0, 1.0]).cells(&floor, 0.0);
        assert!(near(turned.iter().map(|c| c.area()).sum::<f64>(), 6000.0, 1e-6));
        // An empty region, and slivers dropped by min_area.
        assert!(lattice::hex(10.0, lattice::Orient::Pointy).cells(&Region::empty(), 0.0).is_empty());
        let few = lattice::rect(10.0, 10.0).cells(&Region::from_poly(&rect(10.5, 10.5)), 3.0);
        assert_eq!(few.len(), 1);
    }
}

/// A declarative pose animation. The host owns sampling, limits and rendering (recipe API 1.8).
pub mod anim {
    use super::{Json, Refusal, Session};

    /// One joint target in the member's part frame, or a model-space Reach target.
    #[derive(Clone, Debug, PartialEq)]
    pub enum Aim {
        Degrees(f64), Rest, Aligned, Min, Max, Fraction(f64),
        Rotation([f64; 4]), Reach { at: [f64; 3], to: [f64; 3] },
    }
    impl From<f64> for Aim { fn from(value: f64) -> Self { Aim::Degrees(value) } }
    impl Aim {
        fn json(&self) -> Json {
            match self {
                Aim::Degrees(value) => Json::from(*value),
                Aim::Rest => Json::from("rest"), Aim::Aligned => Json::from("aligned"),
                Aim::Min => Json::from("min"), Aim::Max => Json::from("max"),
                Aim::Fraction(value) => Json::obj().set("fraction", *value),
                Aim::Rotation(q) => Json::obj().set("rotation", Json::arr(q.to_vec())),
                Aim::Reach { at, to } => Json::obj().set("reach", Json::obj().set("at", *at).set("to", *to)),
            }
        }
    }

    /// The easing into a key. The default is linear.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Ease { Linear, InOut }
    impl Ease { fn name(self) -> &'static str { match self { Ease::Linear => "linear", Ease::InOut => "inOut" } } }

    /// Names matching a wildcard union. The original pattern goes to the host, which refuses an empty group.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Group { pattern: String, names: Vec<String> }
    impl Group { pub fn names(&self) -> &[String] { &self.names } }

    /// A joint and its parent, as supplied by the host. All angles are degrees.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Member {
        pub name: String, pub parent: Option<String>, pub joint: Option<String>,
        pub angle: Option<f64>, pub min: Option<f64>, pub max: Option<f64>, pub cone: Option<f64>, pub aligned: Option<f64>,
    }
    #[derive(Clone, Debug, PartialEq)]
    pub struct Rig { pub members: Vec<Member> }
    impl Rig {
        pub(crate) fn from_json(value: &Json) -> Option<Self> {
            let rows = value.get("members")?.as_array()?;
            let mut members = Vec::new();
            for row in rows {
                let joint = row.get("joint");
                members.push(Member {
                    name: row.get("name")?.as_str()?.to_string(),
                    parent: row.get("parent").and_then(Json::as_str).map(str::to_string),
                    joint: joint.and_then(|j| j.get("kind")).and_then(Json::as_str).map(str::to_string),
                    angle: joint.and_then(|j| j.get("angle")).and_then(Json::as_f64),
                    min: joint.and_then(|j| j.get("min")).and_then(Json::as_f64),
                    max: joint.and_then(|j| j.get("max")).and_then(Json::as_f64),
                    cone: joint.and_then(|j| j.get("cone")).and_then(Json::as_f64),
                    aligned: row.get("aligned").and_then(Json::as_f64),
                });
            }
            Some(Rig { members })
        }
        pub fn group(&self, pattern: &str) -> Group {
            let mut names = Vec::new();
            for member in &self.members {
                if pattern.split('|').any(|one| matches(one.trim(), &member.name)) { names.push(member.name.clone()); }
            }
            Group { pattern: pattern.to_string(), names }
        }

        /// Recipe API 1.15: drive `member`'s joint from where it stands at `at`, in `dir` (1 or -1, the joint's own
        /// sense), until a part it moves first touches any part that stays, within 360 degrees (a slide: its limit) and
        /// 0.01 mm. `None` when nothing is met. Nothing moves: the script keys what it reads.
        #[track_caller]
        pub fn first_contact(&self, s: &mut Session, at: &Pose, member: &str, dir: i32) -> Result<Option<Touch>, Refusal> {
            let line = std::panic::Location::caller().line();
            read_contact(s, at, &ContactAsk::new(member, dir), line)
        }

        /// `first_contact` with a named part to touch, a range and a tolerance.
        #[track_caller]
        pub fn first_contact_with(&self, s: &mut Session, at: &Pose, ask: &ContactAsk) -> Result<Option<Touch>, Refusal> {
            let line = std::panic::Location::caller().line();
            read_contact(s, at, ask, line)
        }

        /// The least distance between two members' meshes at `at`, mm: 0.0 when they touch or cross.
        #[track_caller]
        pub fn clearance(&self, s: &mut Session, at: &Pose, a: &str, b: &str) -> Result<f64, Refusal> {
            let line = std::panic::Location::caller().line();
            let reply = s.call("rig_clearance", Json::obj().set("pose", at.read_json()).set("a", a).set("b", b))?;
            reply.get("mm").and_then(Json::as_f64).ok_or(Refusal { reason: "The host gave no clearance.".to_string(), line })
        }

        /// Whether two members cross at `at`, by the mesh pass the frames are checked with.
        #[track_caller]
        pub fn crossing(&self, s: &mut Session, at: &Pose, a: &str, b: &str) -> Result<bool, Refusal> {
            let line = std::panic::Location::caller().line();
            let reply = s.call("rig_clearance", Json::obj().set("pose", at.read_json()).set("a", a).set("b", b))?;
            reply.get("crossing").and_then(Json::as_bool).ok_or(Refusal { reason: "The host gave no crossing.".to_string(), line })
        }

        /// A member's hinge angle (degrees) or slide travel (mm) at `at`: a gear train's follower as its lead turns it.
        #[track_caller]
        pub fn angle(&self, s: &mut Session, at: &Pose, member: &str) -> Result<f64, Refusal> {
            let line = std::panic::Location::caller().line();
            let reply = s.call("rig_angle", Json::obj().set("pose", at.read_json()).set("member", member))?;
            reply.get("angle").and_then(Json::as_f64).ok_or(Refusal { reason: "The host gave no angle.".to_string(), line })
        }
    }

    /// What a contact read found (API 1.15): the driven joint's value at first contact (degrees, or mm for a slide), the
    /// moving part and the part it touches, the clearance left (mm, at most the tolerance), and the first value found
    /// crossing.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Touch { pub angle: f64, pub moving: String, pub other: String, pub clearance_mm: f64, pub past: f64 }

    /// A contact read's question (API 1.15): the member to drive and its direction, and optionally the part to touch
    /// (default any part that stays), the range (degrees or mm) and the tolerance (mm).
    #[derive(Clone, Debug, PartialEq)]
    pub struct ContactAsk { member: String, dir: i32, against: Option<String>, max: Option<f64>, tolerance: Option<f64> }
    impl ContactAsk {
        pub fn new(member: &str, dir: i32) -> Self { ContactAsk { member: member.to_string(), dir, against: None, max: None, tolerance: None } }
        pub fn against(mut self, name: &str) -> Self { self.against = Some(name.to_string()); self }
        pub fn max(mut self, value: f64) -> Self { self.max = Some(value); self }
        pub fn tolerance(mut self, mm: f64) -> Self { self.tolerance = Some(mm); self }
        pub(crate) fn json(&self, at: &Pose) -> Json {
            let mut out = Json::obj().set("pose", at.read_json()).set("member", self.member.as_str()).set("dir", self.dir);
            if let Some(name) = &self.against { out = out.set("against", name.as_str()); }
            if let Some(value) = self.max { out = out.set("max", value); }
            if let Some(mm) = self.tolerance { out = out.set("tolerance", mm); }
            out
        }
    }

    fn no_answer(line: u32) -> Refusal { Refusal { reason: "The host gave no contact answer.".to_string(), line } }

    #[track_caller]
    fn read_contact(s: &mut Session, at: &Pose, ask: &ContactAsk, line: u32) -> Result<Option<Touch>, Refusal> {
        let reply = s.call("rig_contact", ask.json(at))?;
        let contact = reply.get("contact").and_then(Json::as_bool).ok_or(no_answer(line))?;
        if !contact { return Ok(None); }
        let angle = reply.get("angle").and_then(Json::as_f64).ok_or(no_answer(line))?;
        let moving = reply.get("moving").and_then(Json::as_str).ok_or(no_answer(line))?.to_string();
        let other = reply.get("other").and_then(Json::as_str).ok_or(no_answer(line))?.to_string();
        let clearance_mm = reply.get("clearanceMm").and_then(Json::as_f64).ok_or(no_answer(line))?;
        let past = reply.get("past").and_then(Json::as_f64).ok_or(no_answer(line))?;
        Ok(Some(Touch { angle, moving, other, clearance_mm, past }))
    }

    /// The times the host samples an animation's frames at (API 1.15; whole multiples of `1/fps` since 1.17): frame `k`
    /// at exactly `k / fps` for `k = 0 ..= n`, where `n = ceil(end * fps)` is the first whole frame at or after `end` (an
    /// end within a millionth of a frame past a grid time ends on it). An end between two grid times is shown by the next
    /// one, which holds the final pose. `end = 0` is one frame at 0. A key on each of these times is shown as keyed, with
    /// nothing interpolated between; `k as f64 / fps as f64` is the same number.
    pub fn frame_times(fps: u32, end: f64) -> Vec<f64> {
        let rate = fps as f64;
        let mut last = (end * rate - 1e-6).ceil();
        if last < 0.0 { last = 0.0; }
        let n = last as u64;
        let mut times = Vec::new();
        let mut k = 0u64;
        while k <= n {
            times.push(k as f64 / rate);
            k += 1;
        }
        times
    }
    fn matches(pattern: &str, name: &str) -> bool {
        let pieces: Vec<&str> = pattern.split('*').collect();
        if pieces.len() == 1 { return pattern == name; }
        if !name.starts_with(pieces[0]) || !name.ends_with(pieces[pieces.len() - 1]) { return false; }
        let mut from = pieces[0].len();
        for piece in pieces.iter().skip(1) {
            match name[from..].find(piece) { Some(at) => from += at + piece.len(), None => return false }
        }
        from <= name.len()
    }

    /// A sparse pose: unmentioned joints keep the value interpolated by the host.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Pose { rest: bool, set: Vec<(String, Aim)>, colors: Vec<(String, String)> }
    impl Default for Pose { fn default() -> Self { Self::new() } }
    impl Pose {
        pub fn new() -> Self { Pose { rest: false, set: Vec::new(), colors: Vec::new() } }
        pub fn rest() -> Self { Pose { rest: true, set: Vec::new(), colors: Vec::new() } }
        pub fn set(mut self, name: &str, aim: impl Into<Aim>) -> Self { self.set.push((name.to_string(), aim.into())); self }
        pub fn set_all(mut self, group: &Group, aim: Aim) -> Self { self.set.push((group.pattern.clone(), aim)); self }
        /// A colour change at this key is a cut, not an interpolation.
        pub fn colour(mut self, name: &str, hex: &str) -> Self { self.colors.push((name.to_string(), hex.to_string())); self }
        /// The pose a read of the rig is taken at (API 1.15): rest and the named aims, as a key at time 0 would pose them.
        pub(crate) fn read_json(&self) -> Json {
            let (set, _) = self.json();
            Json::obj().set("rest", self.rest).set("set", set)
        }
        fn json(&self) -> (Json, Json) {
            let mut set = Json::obj(); let mut colors = Json::obj();
            for (name, aim) in &self.set { set = set.set(name, aim.json()); }
            for (name, color) in &self.colors { colors = colors.set(name, color.as_str()); }
            (set, colors)
        }
    }

    /// A camera direction from the assembly toward the camera, with an optional up direction.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Camera { direction: [f64; 3], up: Option<[f64; 3]> }
    impl Camera {
        pub fn looking(x: f64, y: f64, z: f64) -> Self { Camera { direction: [x, y, z], up: None } }
        pub fn up(mut self, x: f64, y: f64, z: f64) -> Self { self.up = Some([x, y, z]); self }
        fn json(&self) -> Json { let mut out = Json::obj().set("direction", self.direction); if let Some(up) = self.up { out = out.set("up", up); } out }
    }
    #[derive(Clone, Debug, PartialEq)]
    pub struct Key { t: f64, line: u32, pose: Pose, ease: Ease, hold: f64 }
    impl Key {
        pub fn ease(&mut self, ease: Ease) -> &mut Self { self.ease = ease; self }
        pub fn hold(&mut self, seconds: f64) -> &mut Self { self.hold = seconds; self }
        fn json(&self) -> Json {
            let (set, colors) = self.pose.json();
            Json::obj().set("t", self.t).set("line", self.line).set("rest", self.pose.rest).set("set", set).set("colors", colors).set("ease", self.ease.name()).set("hold", self.hold)
        }
    }
    /// Keys and presentation for one animation; no pose is changed until the host runs it.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Animation { fps: u32, keys: Vec<Key>, camera: Option<Camera>, colors: Vec<(String, String)>, background: Option<String> }
    impl Animation {
        pub fn new(fps: u32) -> Self { Animation { fps, keys: Vec::new(), camera: None, colors: Vec::new(), background: None } }
        #[track_caller]
        pub fn key(&mut self, time: f64, pose: Pose) -> &mut Key {
            self.keys.push(Key { t: time, line: std::panic::Location::caller().line(), pose, ease: Ease::Linear, hold: 0.0 });
            self.keys.last_mut().unwrap()
        }
        pub fn camera(&mut self, camera: Camera) -> &mut Self { self.camera = Some(camera); self }
        pub fn colour(&mut self, name: &str, hex: &str) -> &mut Self { self.colors.push((name.to_string(), hex.to_string())); self }
        /// The frames' background, "#rrggbb" (recipe API 1.9). The host refuses any other form; a caller's own choice overrides it.
        pub fn background(&mut self, hex: &str) -> &mut Self { self.background = Some(hex.to_string()); self }
        pub fn to_json(&self) -> Json {
            let mut colors = Json::obj();
            for (name, color) in &self.colors { colors = colors.set(name, color.as_str()); }
            let mut out = Json::obj().set("fps", self.fps).set("keys", Json::Arr(self.keys.iter().map(Key::json).collect())).set("colors", colors);
            if let Some(camera) = &self.camera { out = out.set("camera", camera.json()); }
            if let Some(background) = &self.background { out = out.set("background", background.as_str()); }
            out
        }
    }
}

#[cfg(test)]
mod animation_tests {
    use super::{anim::{frame_times, Aim, Animation, ContactAsk, Ease, Pose, Rig}, Json};

    #[test]
    fn animation_encodes_keys_and_rig_groups() {
        let rig = Rig::from_json(&Json::obj().set("members", Json::arr(vec![
            Json::obj().set("name", "Finger 1 root").set("parent", "Palm").set("joint", Json::obj().set("kind", "hinge").set("angle", 12).set("min", -90).set("max", 90)).set("aligned", 15),
            Json::obj().set("name", "Finger 2 claw"),
        ]))).unwrap();
        let group = rig.group("Finger 1 *|Finger 2 *");
        assert_eq!(group.names().len(), 2);
        assert_eq!(rig.members[0].aligned, Some(15.0));
        let mut anim = Animation::new(12);
        anim.key(1.0, Pose::rest().set_all(&group, Aim::Aligned).colour("Finger 1 root", "#ff0000")).ease(Ease::InOut).hold(0.5);
        let data = anim.to_json();
        assert_eq!(data.at("fps").and_then(Json::as_f64), Some(12.0));
        assert_eq!(data.at("keys.0.set.Finger 1 *|Finger 2 *").and_then(Json::as_str), Some("aligned"));
        assert_eq!(data.at("keys.0.colors.Finger 1 root").and_then(Json::as_str), Some("#ff0000"));
        assert_eq!(data.at("keys.0.hold").and_then(Json::as_f64), Some(0.5));
        assert!(data.at("keys.0.line").and_then(Json::as_f64).unwrap() > 0.0);
    }

    #[test]
    fn background_is_sent_only_when_set() {
        let mut anim = Animation::new(12);
        assert!(anim.to_json().at("background").is_none(), "a 1.8 animation must send the same call as before");
        anim.background("#204060");
        assert_eq!(anim.to_json().at("background").and_then(Json::as_str), Some("#204060"));
    }

    #[test]
    fn frame_times_are_the_hosts() {
        // The host (src/pose-anim.ts, frameTimes): frame k at k / fps for k = 0 ..= ceil(end * fps). The same cases are
        // asserted there, so the two cannot drift apart.
        assert_eq!(frame_times(12, 0.0), vec![0.0]);
        assert_eq!(frame_times(4, 0.1), vec![0.0, 0.25]);
        let times = frame_times(12, 3.0);
        assert_eq!(times.len(), 37);
        assert_eq!(times[0], 0.0);
        assert_eq!(times[36], 3.0);
        for (k, time) in times.iter().enumerate() { assert_eq!(time.to_bits(), (k as f64 / 12.0).to_bits()); }
        // Off the grid, the end is shown by the next whole frame.
        let off = frame_times(12, 2.95);
        assert_eq!(off.len(), 37);
        assert_eq!(off[36], 3.0);
        // Within a millionth of a frame past the grid is rounding, not another frame.
        assert_eq!(frame_times(12, 35.0 / 12.0).len(), 36);
        assert_eq!(frame_times(30, 0.1 + 0.2).len(), 10);
    }

    #[test]
    fn contact_reads_send_the_pose_as_a_key_would() {
        let at = Pose::new().set("Anchor", 8.0).colour("Anchor", "#ff0000");
        let read = at.read_json();
        assert_eq!(read.at("set.Anchor").and_then(Json::as_f64), Some(8.0));
        assert_eq!(read.get("rest").and_then(Json::as_bool), Some(false));
        assert!(read.get("colors").is_none(), "a read takes no colours");
        let ask = ContactAsk::new("Wheel", -1).against("Pallet").max(30.0).tolerance(0.005).json(&at);
        assert_eq!(ask.get("member").and_then(Json::as_str), Some("Wheel"));
        assert_eq!(ask.get("dir").and_then(Json::as_f64), Some(-1.0));
        assert_eq!(ask.get("against").and_then(Json::as_str), Some("Pallet"));
        assert_eq!(ask.get("max").and_then(Json::as_f64), Some(30.0));
        assert_eq!(ask.get("tolerance").and_then(Json::as_f64), Some(0.005));
        assert!(ContactAsk::new("Wheel", 1).json(&at).get("against").is_none(), "any part, unless one is named");
    }

    #[test]
    fn s3_fillet_v2_and_loft_v2_ops_build_expected_json() {
        use crate::ops;
        let f_g2 = ops::fillet_g2(Json::arr(vec![Json::from(0.0)]), 3.0);
        assert_eq!(f_g2.get("continuity").and_then(Json::as_str), Some("g2"));
        let f_conic = ops::fillet_conic(Json::arr(vec![Json::from(0.0)]), 4.0, 0.7);
        assert_eq!(f_conic.get("continuity").and_then(Json::as_str), Some("conic"));
        assert_eq!(f_conic.get("rho").and_then(Json::as_f64), Some(0.7));
        let f_var = ops::fillet_variable(Json::arr(vec![Json::from(0.0)]), &[[0.0, 1.0], [1.0, 4.0]], Some("g2"));
        assert_eq!(f_var.get("continuity").and_then(Json::as_str), Some("g2"));
        assert_eq!(f_var.at("variable.1.1").and_then(Json::as_f64), Some(4.0));
        let apex = ops::loft_apex([0.0, 0.0, 20.0]);
        assert_eq!(apex.at("apex.2").and_then(Json::as_f64), Some(20.0));
        let loft = ops::loft("fuse", vec![apex]).set("closed", true).set("smoothing", true);
        assert_eq!(loft.get("kind").and_then(Json::as_str), Some("loft"));
        assert_eq!(loft.get("closed").and_then(Json::as_bool), Some(true));
        assert_eq!(loft.get("smoothing").and_then(Json::as_bool), Some(true));
    }

    #[test]
    fn s5_patch_and_blend_ops_build_expected_json() {
        use crate::ops;
        let side = ops::surface_boundary(Json::arr(vec![Json::from(0.0)]), "g1");
        let patch = ops::patch(vec![side.clone(), ops::surface_boundary(Json::arr(vec![Json::from(1.0)]), "g2")]);
        assert_eq!(patch.get("kind").and_then(Json::as_str), Some("patch"));
        assert_eq!(patch.at("boundaries.1.continuity").and_then(Json::as_str), Some("g2"));
        let blend = ops::blend_surface(side, ops::surface_boundary(Json::arr(vec![Json::from(2.0)]), "g1"), "g1", 1.0, 1.4);
        assert_eq!(blend.get("kind").and_then(Json::as_str), Some("blendSurface"));
        assert_eq!(blend.get("continuity").and_then(Json::as_str), Some("g1"));
        assert_eq!(blend.get("tensionB").and_then(Json::as_f64), Some(1.4));
        let surface = ops::nurbs_surface(vec![vec![[0.0, 0.0, 0.0], [0.0, 10.0, 0.0]], vec![[10.0, 0.0, 0.0], [10.0, 10.0, 1.0]]]);
        assert_eq!(surface.get("kind").and_then(Json::as_str), Some("nurbsSurface"));
        assert_eq!(surface.at("poles.1.1.2").and_then(Json::as_f64), Some(1.0));
        let grid: Vec<Vec<[f64; 3]>> = (0..4).map(|u| (0..4).map(|v| [f64::from(u) * 10.0, f64::from(v) * 10.0, 0.0]).collect()).collect();
        let built = ops::NurbsSurface::new(grid.clone())
            .weights(vec![vec![1.0; 4]; 4])
            .degrees(3, 2)
            .knots_u(vec![0.0, 1.0], vec![4, 4])
            .knots_v(vec![0.0, 0.5, 1.0], vec![3, 1, 3])
            .insert_u(0.5, 1)
            .elevate(None, Some(3))
            .op();
        assert_eq!(built.get("kind").and_then(Json::as_str), Some("nurbsSurface"));
        assert_eq!(built.at("weights.3.3").and_then(Json::as_f64), Some(1.0));
        assert_eq!(built.get("degreeU").and_then(Json::as_f64), Some(3.0));
        assert_eq!(built.get("degreeV").and_then(Json::as_f64), Some(2.0));
        assert_eq!(built.at("multsV.1").and_then(Json::as_f64), Some(1.0));
        assert_eq!(built.at("insertU.0.1").and_then(Json::as_f64), Some(1.0));
        assert_eq!(built.get("elevateV").and_then(Json::as_f64), Some(3.0));
        assert!(built.get("elevateU").is_none() && built.get("insertV").is_none());
        let closed = ops::NurbsSurface::new(grid).periodic(true, false).op();
        assert_eq!(closed.get("periodicU").and_then(Json::as_bool), Some(true));
        assert!(closed.get("periodicV").is_none());
    }

    #[test]
    fn s4_open_sheet_ops_build_expected_json() {
        use crate::ops;
        let c = ops::curve3d_nurbs(vec![[0.0, 0.0, 0.0], [10.0, 0.0, 4.0], [20.0, 0.0, 0.0]], None, Some(2), None, None, false);
        let spec = ops::sheet_extrude_spec(c.clone(), [0.0, 1.0, 0.0], 20.0);
        let sh = ops::sheet(spec.clone());
        assert_eq!(sh.get("kind").and_then(Json::as_str), Some("sheet"));
        assert_eq!(sh.get("mode").and_then(Json::as_str), Some("extrude"));
        assert_eq!(sh.get("distance").and_then(Json::as_f64), Some(20.0));
        let sew = ops::sew(true, true);
        assert_eq!(sew.get("kind").and_then(Json::as_str), Some("sew"));
        assert_eq!(sew.get("capPlanar").and_then(Json::as_bool), Some(true));
        let thick = ops::thicken(2.5, "both");
        assert_eq!(thick.get("kind").and_then(Json::as_str), Some("thicken"));
        assert_eq!(thick.get("thickness").and_then(Json::as_f64), Some(2.5));
        assert_eq!(thick.get("direction").and_then(Json::as_str), Some("both"));
        let ts = ops::trim_split(spec.clone(), "below");
        assert_eq!(ts.get("kind").and_then(Json::as_str), Some("trimSplit"));
        assert_eq!(ts.get("keep").and_then(Json::as_str), Some("below"));
        let rf = ops::replace_face(Json::from(5.0), spec);
        assert_eq!(rf.get("kind").and_then(Json::as_str), Some("replaceFace"));
        assert_eq!(rf.get("face").and_then(Json::as_f64), Some(5.0));
        let sf = ops::split_face(vec![Json::from(5.0)], c, Some([0.0, 0.0, -1.0]));
        assert_eq!(sf.get("kind").and_then(Json::as_str), Some("splitFace"));
        assert_eq!(sf.at("direction.2").and_then(Json::as_f64), Some(-1.0));
    }
}
