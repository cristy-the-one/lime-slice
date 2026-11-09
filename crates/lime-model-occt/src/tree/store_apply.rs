//! The store's Apply, probe and fold calls, and the partition starts.

use serde_json::{json, Value};
use std::fmt::Write as _;
use std::sync::Arc;

use super::{
    doc_in,
    preview_step_faces,
    probe_metrics,
    root_placement,
    stamp_faces,
    transition_find,
    Doc,
    NodeId,
    LITE_FORMAT,
    Probed,
    Store,
    ROOT,
};
use super::build::{build, BuildFail, Built};
use super::group::{GroupBudget, NewGroup};
use super::ops::Op;
use super::outcome::{with_fields, write_object, Answer, Failure, Part};
use super::partition::{
    partition_fields,
    partition_keys_cover,
    piece_keys_refusal,
    piece_replies,
    pins_metrics,
    push_numbers,
    PieceKeys,
};
use super::resolve::resolve;
use super::same::{same_build, same_request};
use super::shape::Shape;

impl Store {
    pub(super) fn apply(
        &mut self,
        key: String,
        parent: NodeId,
        id: NodeId,
        op: Op,
        chord: f64,
        keys: PieceKeys,
    ) -> Result<Answer, Failure> {
        let PieceKeys {
            other: other_key,
            list: piece_keys,
            pins: pins_key,
            mesh,
        } = keys;
        if pins_key.is_some() && !matches!(op, Op::Partition { .. }) {
            return Err(Failure::Message("pinsKey is only for a split to print".into()));
        }
        if pins_key.as_deref() == Some(key.as_str())
            || pins_key
                .as_ref()
                .is_some_and(|pins| piece_keys.iter().flatten().any(|piece| piece == pins))
        {
            return Err(Failure::Message("Each piece needs a key of its own".into()));
        }
        if other_key.is_some() && !matches!(op, Op::Split { .. }) {
            return Err(Failure::Message("otherKey is only for a split".into()));
        }
        if other_key.as_deref() == Some(key.as_str()) {
            return Err(Failure::Message(
                "The split piece needs a key of its own".into(),
            ));
        }
        piece_keys_refusal(&key, &op, &piece_keys)?;
        let doc = doc_in(&mut self.docs, &key)?;
        if let Some(existing) = doc.nodes.get(&id) {
            let same = existing.parent == Some(parent)
                && existing.piece == other_key
                && existing.pieces == piece_keys
                && (existing.pins.is_none() || existing.pins == pins_key)
                && existing
                    .op
                    .as_ref()
                    .is_some_and(|stored| same_request(stored, &op));
            if same {
                return self.goto(key, id, chord);
            }
            return Err(Failure::Message(format!(
                "Node {id} is already in this tree for another step"
            )));
        }
        root_placement(parent, &op).map_err(Failure::Message)?;
        self.join_refusal(&key, &op)?;
        let replayed = self.ensure(&key, parent)?;
        let steps = self.step_edges(&key, parent, &op)?;
        let (op, reused) = {
            let doc = doc_in(&mut self.docs, &key)?;
            let probed = doc.probe.take();
            let from = doc.shape(parent);
            from.editable().map_err(Failure::Message)?;
            let op = resolve(from, &op, &steps).map_err(Failure::Message)?;
            match probed {
                Some(probed) if probed.parent == parent && same_build(&probed.op, &op.op) => {
                    (op, Some(probed.built))
                }
                _ => (op, None),
            }
        };
        let mut built = match reused {
            // The op stored is the one applied: a join's `keepTool` and its tool's name build nothing. A split to
            // print's is the one its build stored, with only the connectors that built.
            Some(reused) if matches!(reused.op, Op::Partition { .. }) => reused,
            Some(reused) => Built { op: op.op, ..reused },
            None => {
                let tool = self.join_tool(&key, &op.op)?;
                let from = doc_in(&mut self.docs, &key)?.shape(parent);
                let _budget = GroupBudget::start();
                let _new = NewGroup::start();
                build(from, op, false, tool, &steps).map_err(Failure::from)?
            }
        };
        partition_keys_cover(built.pieces.len(), &piece_keys)?;
        let doc = doc_in(&mut self.docs, &key)?;
        let fingerprint = built.kept.fingerprint();
        self.clock += 1;
        let previous = doc.current;
        let node = doc.insert(id, parent, built.op.clone())?;
        node.fingerprint = Some(fingerprint);
        node.shape = Some(built.kept);
        node.piece = other_key.clone();
        node.pieces = piece_keys.clone();
        node.pins = pins_key.clone().filter(|_| built.pins.is_some());
        node.used = self.clock;
        doc.current = id;
        // --- A10.
        stamp_faces(doc, id);
        // A recipe that meshes once at its end asks for no mesh here: the answer names the step and its fingerprint, and a
        // `goto` of the step meshes it (the same reply a mesh here would have been). The part's box is not measured: from
        // the geometry it costs about as much as the mesh it saves, so the caller keeps the box it has and grows it.
        let lite = !mesh && other_key.is_none() && piece_keys.is_empty() && pins_key.is_none();
        // The other piece is sent only to start its own tree. A split replayed without `otherKey`
        // drops it unseen.
        let rendered = if lite {
            Ok((
                Arc::new(
                    json!({ "id": id, "format": LITE_FORMAT, "fingerprint": fingerprint }).to_string(),
                ),
                None,
                Vec::new(),
            ))
        } else {
            self.reply(&key, id, chord).and_then(|text| {
            let other = match (built.other.as_mut(), &other_key) {
                (Some(other), Some(_)) => Some(other.reply(ROOT, chord)?),
                _ => None,
            };
            // --- Split to print: each piece with a key, as the split's other piece.
            let pieces = piece_replies(&mut built.pieces, &piece_keys, chord)?;
            Ok((text, other, pieces))
            })
        };
        let (text, other, pieces) = match rendered {
            Ok(rendered) => rendered,
            Err(failure) => {
                if let Some(doc) = self.docs.get_mut(&key) {
                    doc.nodes.remove(&id);
                    doc.current = previous;
                }
                self.replies
                    .retain(|reply| reply.key != key || reply.node != id);
                return Err(failure);
            }
        };
        let mut fields = vec![
            ("op", Part::Json(json!(built.op).to_string())),
            ("replayed", Part::Json(replayed.to_string())),
        ];
        if let (Some(piece), Some(other_key), Some(other)) = (built.other, other_key, other) {
            self.clock += 1;
            self.replies.retain(|reply| reply.key != other_key);
            // --- A10. The split piece starts its own tree, so every face it keeps belongs to that root.
            let owners = vec![ROOT; piece.fingerprint().faces.max(0) as usize];
            self.docs
                .insert(other_key.clone(), Doc::new(piece, self.clock));
            let other = Arc::new(with_fields(
                &other,
                &[("stepFaces", Part::Json(json!(owners).to_string()))],
            ));
            self.remember(&other_key, ROOT, chord, Arc::clone(&other));
            let key_field = ("key", Part::Json(json!(other_key).to_string()));
            fields.push(("other", Part::Object(other, vec![key_field])));
        }
        if matches!(built.op, Op::Partition { .. }) {
            fields.push(("parts", Part::Json((built.pieces.len() + 1).to_string())));
        }
        push_numbers(&mut fields, built.numbered.as_deref(), built.joined.as_ref());
        // --- I19–I20: what a combined group or an extrude of cells did.
        if let Some((name, value)) = &built.report {
            fields.push((name, Part::Json(value.to_string())));
        }
        if !piece_keys.is_empty() {
            let list = self.start_pieces(built.pieces, &piece_keys, pieces, chord);
            fields.push(("pieces", Part::Json(list)));
        }
        if let (Some(pins), Some(pins_key)) = (built.pins, pins_key) {
            let list = self.start_pins(pins, &pins_key, chord)?;
            fields.push(("pins", Part::Json(list)));
        }
        Ok(Answer::Held { key, text, fields })
    }

    /// --- Split to print. The pins start their own tree under `pins_key`, as a piece does; the answer is their reply
    /// with that `key`, cached under it.
    pub(super) fn start_pins(&mut self, mut pins: Shape, pins_key: &str, chord: f64) -> Result<String, Failure> {
        let reply = pins.reply(ROOT, chord)?;
        self.clock += 1;
        self.replies.retain(|cached| cached.key != pins_key);
        let owners = vec![ROOT; pins.fingerprint().faces.max(0) as usize];
        self.docs
            .insert(pins_key.to_string(), Doc::new(pins, self.clock));
        let text = Arc::new(with_fields(
            &reply,
            &[("stepFaces", Part::Json(json!(owners).to_string()))],
        ));
        self.remember(pins_key, ROOT, chord, Arc::clone(&text));
        let mut out = String::new();
        write_object(
            &mut out,
            &text,
            &[("key", Part::Json(json!(pins_key).to_string()))],
        );
        Ok(out)
    }

    /// --- Split to print. Each keyed piece starts its own tree, as a split's other piece does, and its reply is cached
    /// under that key. The answer is the replies in partition order from piece 2, each with its `key` and `part`
    /// number, and null for a piece sent no key.
    pub(super) fn start_pieces(
        &mut self,
        made: Vec<Shape>,
        piece_keys: &[Option<String>],
        replies: Vec<Option<String>>,
        chord: f64,
    ) -> String {
        let mut list = String::from("[");
        for (index, ((piece, reply), wanted)) in made
            .into_iter()
            .zip(replies)
            .zip(piece_keys.iter().chain(std::iter::repeat(&None)))
            .enumerate()
        {
            if index > 0 {
                list.push(',');
            }
            let (Some(piece_key), Some(reply)) = (wanted, reply) else {
                list.push_str("null");
                continue;
            };
            self.clock += 1;
            self.replies.retain(|cached| &cached.key != piece_key);
            // --- A10. A piece starts its own tree, so every face it keeps belongs to that root.
            let owners = vec![ROOT; piece.fingerprint().faces.max(0) as usize];
            self.docs
                .insert(piece_key.clone(), Doc::new(piece, self.clock));
            let text = Arc::new(with_fields(
                &reply,
                &[("stepFaces", Part::Json(json!(owners).to_string()))],
            ));
            self.remember(piece_key, ROOT, chord, Arc::clone(&text));
            write_object(
                &mut list,
                &text,
                &[
                    ("key", Part::Json(json!(piece_key).to_string())),
                    ("part", Part::Json((index + 2).to_string())),
                ],
            );
        }
        list.push(']');
        list
    }

    /// --- 3.1 F1. A composite the MCP server applied piece by piece, each piece checked, becomes one group without
    /// building every piece again: a second build of a 245-step group on a 1,700-face part ran past the group budget
    /// and threw the whole composite away. The group's faces belong to it where its pieces made them, as a built group's
    /// do, and its solid is the last piece's, which is what building the group again gives.
    pub(super) fn fold(
        &mut self,
        key: String,
        parent: NodeId,
        id: NodeId,
        op: Op,
        last: NodeId,
        chord: f64,
    ) -> Result<Answer, Failure> {
        let not_the_steps =
            || Failure::Message("The steps to fold are not the group's steps".into());
        root_placement(parent, &op).map_err(Failure::Message)?;
        let Op::Group { steps, .. } = &op else {
            return Err(Failure::Message("Only a group folds steps".into()));
        };
        let doc = doc_in(&mut self.docs, &key)?;
        if doc.nodes.contains_key(&id) {
            return Err(Failure::Message(format!(
                "Node {id} is already in this tree for another step"
            )));
        }
        let mut chain = Vec::new();
        let mut at = last;
        while at != parent {
            let node = doc.node(at)?;
            chain.push(at);
            at = node.parent.ok_or_else(not_the_steps)?;
        }
        chain.reverse();
        if chain.is_empty() || chain.len() != steps.len() {
            return Err(not_the_steps());
        }
        for (at, step) in chain.iter().zip(steps) {
            if !doc
                .node(*at)?
                .op
                .as_ref()
                .is_some_and(|stored| same_request(stored, step))
            {
                return Err(not_the_steps());
            }
        }
        let gone = doc.subtree(chain[0]);
        if gone.len() != chain.len() {
            return Err(Failure::Message(
                "A step to fold has another branch under it".into(),
            ));
        }
        if doc.node(last)?.shape.is_none() {
            return Err(Failure::Message(
                "The last step's solid is no longer held, so the group is built instead".into(),
            ));
        }
        if self.names_tool(&key, Some(&gone)) {
            return Err(Failure::Message(
                "A step of another part's history uses a step of this run as its tool".into(),
            ));
        }
        self.clock += 1;
        let used = self.clock;
        let doc = doc_in(&mut self.docs, &key)?;
        let held = doc.nodes.get_mut(&last).expect("checked above");
        let shape = held.shape.take().expect("checked above");
        let fingerprint = held.fingerprint;
        let owners: Vec<NodeId> = held
            .face_owners
            .iter()
            .map(|owner| if gone.contains(owner) { id } else { *owner })
            .collect();
        doc.nodes.retain(|node, _| !gone.contains(node));
        if doc
            .probe
            .as_ref()
            .is_some_and(|probe| gone.contains(&probe.parent))
        {
            doc.probe = None;
        }
        let node = doc.insert(id, parent, op.clone())?;
        node.fingerprint = fingerprint;
        node.shape = Some(shape);
        node.face_owners = owners;
        node.used = used;
        doc.current = id;
        self.replies
            .retain(|reply| reply.key != key || !gone.contains(&reply.node));
        let text = self.reply(&key, id, chord)?;
        let fields = vec![
            ("op", Part::Json(json!(op).to_string())),
            ("replayed", Part::Json("0".into())),
        ];
        Ok(Answer::Held { key, text, fields })
    }

    pub(super) fn probe(
        &mut self,
        key: &str,
        id: NodeId,
        op: Op,
        preview: Option<f64>,
    ) -> Result<Answer, Failure> {
        let checked = root_placement(id, &op)
            .map_err(Failure::Message)
            .and_then(|()| self.join_refusal(key, &op));
        self.ensure(key, id)?;
        doc_in(&mut self.docs, key)?.probe = None;
        let tool = match checked.and_then(|()| self.join_tool(key, &op)) {
            Ok(tool) => Ok(tool),
            Err(Failure::Message(message)) => Err(message),
            Err(failure) => return Err(failure),
        };
        let steps = match self.step_edges(key, id, &op) {
            Ok(steps) => Ok(steps),
            Err(Failure::Message(message)) => Err(message),
            Err(failure) => return Err(failure),
        };
        let doc = doc_in(&mut self.docs, key)?;
        // --- A10. Clone before the shape is borrowed: a preview face keeps its parent's node, and a new face is null.
        let parent_owners = doc
            .nodes
            .get(&id)
            .map(|node| node.face_owners.clone())
            .unwrap_or_default();
        let from = doc.shape(id);
        let mut asked = op.clone();
        let result = tool
            .and_then(|tool| steps.map(|found| (tool, found)))
            .and_then(|(tool, found)| from.editable().map(|()| (tool, found)))
            .map_err(BuildFail::plain)
            .and_then(|(tool, found)| {
                resolve(from, &op, &found)
                    .map(|resolved| (resolved, tool, found))
                    .map_err(BuildFail::plain)
            })
            .and_then(|(resolved, tool, found)| {
                asked = resolved.op.clone();
                let _budget = GroupBudget::start();
                let _new = NewGroup::start();
                build(from, resolved, true, tool, &found)
            });
        match result {
            Ok(mut built) => {
                // The shape keeps what its reply measured and meshed, so an Apply that takes it meshes nothing again.
                let shown = preview.and_then(|chord| {
                    let faces = preview_step_faces(&parent_owners, &built.kept.face_from());
                    let mut text = built.kept.reply(id, chord).ok()?;
                    // --- A10.
                    if let Some(faces) = faces {
                        text = with_fields(&text, &[("stepFaces", Part::Json(faces))]);
                    }
                    Some(text)
                });
                // --- A1 group: the same measures as one op, plus how many steps missed the solid. ---
                let skipped = matches!(built.op, Op::Group { .. }).then_some(built.skipped);
                let mut metrics = probe_metrics(from, &built.kept, skipped);
                if !built.sides.is_empty() {
                    // --- Print transitions: each edge's case, new face and reach.
                    let name = if matches!(built.op, Op::Transition { .. }) { "transition" } else { "firstFaces" };
                    let _ = write!(metrics, ",\"{name}\":{}", Value::Array(built.sides.clone()));
                }
                // --- I19–I20: what a combined group or an extrude of cells did.
                if let Some((name, value)) = &built.report {
                    let _ = write!(metrics, ",\"{name}\":{value}");
                }
                // --- Split to print: every piece's volume and box, in partition order.
                if matches!(built.op, Op::Partition { .. }) {
                    let parts: Vec<Value> = std::iter::once(&built.kept)
                        .chain(&built.pieces)
                        .map(|piece| {
                            let mut part = json!({ "volumeMm3": piece.fingerprint().volume_mm3 });
                            if let Some([x0, y0, z0, x1, y1, z1]) = piece.bounds() {
                                part["min"] = json!([x0, y0, z0]);
                                part["max"] = json!([x1, y1, z1]);
                            }
                            part
                        })
                        .collect();
                    let _ = write!(metrics, ",\"parts\":{}", Value::Array(parts));
                    if let Some(pins) = built.pins.as_ref() {
                        let _ = write!(metrics, ",\"pins\":{}", pins_metrics(pins));
                    }
                    for (name, value) in partition_fields(built.numbered.as_deref(), built.joined.as_ref()) {
                        let _ = write!(metrics, ",\"{name}\":{value}");
                    }
                }
                // A split to print's stored op keeps only the connectors that built; an Apply of the op the probe was
                // asked is the same cut.
                let probed = if matches!(built.op, Op::Partition { .. }) {
                    asked.clone()
                } else {
                    built.op.clone()
                };
                doc.probe = Some(Probed {
                    parent: id,
                    op: probed,
                    built,
                });
                Ok(Answer::Plain(match shown {
                    Some(text) => format!("{{\"ok\":true,{metrics},\"preview\":{text}}}"),
                    None => format!("{{\"ok\":true,{metrics}}}"),
                }))
            }
            Err(fail) => {
                let mut reply = json!({ "ok": false, "error": fail.message });
                if let Some(max_mm) = fail.max_mm.filter(|max| max + 1e-6 >= 0.05) {
                    reply["maxMm"] = json!(max_mm);
                }
                // --- A1 group: which step of the group failed, counting from 1. ---
                if let Some(step) = fail.failed_step {
                    reply["failedStep"] = json!(step);
                }
                Ok(Answer::Plain(reply.to_string()))
            }
        }
    }

    /// --- Print transitions, auto-find (step 5). The finder's rows on step `id`'s solid, each with the probe of `fix` on
    /// its one edge, so the op decides what it builds and what it refuses. The last probe is not kept for an Apply.
    pub(super) fn transition_find(
        &mut self,
        key: &str,
        id: NodeId,
        build: [f64; 3],
        up: [f64; 3],
        limit: f64,
        fix: Value,
    ) -> Result<Answer, Failure> {
        self.ensure(key, id)?;
        let shape = doc_in(&mut self.docs, key)?.shape(id);
        shape.editable().map_err(Failure::Message)?;
        let found = transition_find::find(shape, build, up, limit).map_err(Failure::Message)?;
        let mut rows = Vec::with_capacity(found.rows.len());
        for row in &found.rows {
            let mut asked = match &fix {
                Value::Object(fields) => Value::Object(fields.clone()),
                _ => json!({}),
            };
            asked["kind"] = json!("transition");
            asked["edges"] = json!([row.edge]);
            asked["build"] = json!(build);
            let probe = match serde_json::from_value::<Op>(asked) {
                Ok(op) => match self.probe(key, id, op, None)? {
                    Answer::Plain(text) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
                    Answer::Held { .. } => Value::Null,
                },
                Err(err) => json!({ "ok": false, "error": format!("The fix could not be read: {err}") }),
            };
            let mut answer = json!({ "ok": probe["ok"] == json!(true) });
            for field in ["error", "transition"] {
                if let Some(value) = probe.get(field) {
                    answer[field] = value.clone();
                }
            }
            let round = |value: f64| (value * 1000.0).round() / 1000.0;
            rows.push(json!({
                "edge": row.edge,
                "case": row.case,
                "lengthMm": round(row.length_mm),
                "mid": row.mid.map(round),
                "farFace": row.far,
                "nearFace": row.near,
                "farDeg": round(row.far_deg),
                "nearDeg": round(row.near_deg),
                "curved": row.curved,
                "probe": answer,
            }));
        }
        doc_in(&mut self.docs, key)?.probe = None;
        Ok(Answer::Plain(
            json!({ "id": id, "rows": rows, "curvedSkipped": found.curved.len(), "curvedEdges": found.curved })
                .to_string(),
        ))
    }
}
