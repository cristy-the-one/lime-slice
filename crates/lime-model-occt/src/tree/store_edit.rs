//! The store's edit of an earlier step, forking and replaying the steps above it.

use serde_json::json;
use std::collections::HashSet;

use super::{doc_in, root_placement, NodeId, Store, ROOT, ROOT_ONLY};
use super::build::{build, Built};
use super::group::{GroupBudget, NewGroup};
use super::ops::Op;
use super::outcome::{Answer, Failure, Part};
use super::partition::{partition_keys_cover, piece_keys_refusal, piece_replies, push_numbers};
use super::request::{Forked, OwnEdit, Tip, ToolEdit};
use super::resolve::resolve;
use super::same::same_build;

impl Store {
    /// An edited step and the steps under it, in one call: `op` on `parent` as the new node `id`, a sibling of the step
    /// edited, then each of `replay` on the one before it. A replayed step that no longer builds is kept, broken, the steps
    /// after it unbuilt under it, and the tree shows the last step that built, the only one tessellated. A failure before
    /// anything is kept (the edited step itself, or a tool tree this engine lacks) leaves the tree as it was.
    ///
    /// `levels` is the tool trees' edits, deepest first, then the tree's own last, all under the one lock. Each after the
    /// first is a join that takes the tip of the one before. A tool step that no longer builds is kept broken as in any
    /// replay, and so is the join above it, which has no tool to take. A failure of the edited op, or of a join whose tool
    /// built, keeps nothing in any tree, unless `keepBroken` asks to keep it broken (`OwnEdit`).
    pub(super) fn edit(&mut self, levels: Vec<ToolEdit>, chord: f64, own: OwnEdit) -> Result<Answer, Failure> {
        self.edit_checks(&levels)?;
        let last = levels.last().expect("an edit has its own tree last");
        piece_keys_refusal(&last.key, &last.op, &own.piece_keys)?;
        let mut kept: Vec<(String, HashSet<NodeId>, NodeId)> = Vec::new();
        let result = self.edit_levels(&levels, chord, &own, &mut kept);
        if result.is_err() {
            for (key, fresh, previous) in kept {
                if let Some(doc) = self.docs.get_mut(&key) {
                    doc.nodes.retain(|node, _| !fresh.contains(node));
                    doc.current = previous;
                }
                self.replies
                    .retain(|reply| reply.key != key || !fresh.contains(&reply.node));
            }
        }
        result
    }

    /// Everything an edit refuses before it builds: ids already taken, a `root` step out of place, a join that loops, a
    /// tool tree or step this engine lacks, and a tool edit that does not feed the join above it.
    fn edit_checks(&self, levels: &[ToolEdit]) -> Result<(), Failure> {
        let last = levels.len() - 1;
        let mut trees = HashSet::new();
        for (at, level) in levels.iter().enumerate() {
            if !trees.insert(level.key.as_str()) {
                return Err(Failure::Message("One edit changes each tree once".into()));
            }
            let held = self.docs.get(&level.key);
            let Some(doc) = held.filter(|doc| doc.nodes.contains_key(&level.parent)) else {
                // The tree's own parent missing is for the client to restore; a tool tree comes back as a tool does.
                if at == last {
                    return Err(Failure::Missing(vec![if held.is_some() {
                        level.parent
                    } else {
                        ROOT
                    }]));
                }
                return Err(Failure::ToolMissing {
                    node: None,
                    key: level.key.clone(),
                    step: level.parent,
                });
            };
            let mut fresh = HashSet::new();
            for new in level.ids() {
                if new == ROOT || doc.nodes.contains_key(&new) || !fresh.insert(new) {
                    return Err(Failure::Message(format!(
                        "Node {new} is already in this tree for another step"
                    )));
                }
            }
            root_placement(level.parent, &level.op).map_err(Failure::Message)?;
            if level
                .replay
                .iter()
                .any(|step| matches!(step.op, Op::Root { .. }))
            {
                return Err(Failure::Message(ROOT_ONLY.into()));
            }
            let fed = at.checked_sub(1).map(|below| &levels[below]);
            if let Some(below) = fed {
                let feeds = matches!(&level.op, Op::Join { tool, .. } if tool.key == below.key && tool.node == below.tip());
                if !feeds {
                    return Err(Failure::Message(
                        "Each tool tree's edit must feed the join above it".into(),
                    ));
                }
            }
            for (index, op) in std::iter::once(&level.op)
                .chain(level.replay.iter().map(|step| &step.op))
                .enumerate()
            {
                self.join_refusal(&level.key, op)?;
                // The join fed from below takes a step this edit makes.
                if !(index == 0 && fed.is_some()) {
                    self.tool_held(op)?;
                }
            }
        }
        Ok(())
    }

    /// Each level in turn, deepest first: its parent built, its op, then its replay. `kept` gets each tree's new ids and
    /// the node it showed, as soon as anything of it may be kept, so a failure can take them all back.
    fn edit_levels(
        &mut self,
        levels: &[ToolEdit],
        chord: f64,
        own_edit: &OwnEdit,
        kept: &mut Vec<(String, HashSet<NodeId>, NodeId)>,
    ) -> Result<Answer, Failure> {
        let piece_keys = own_edit.piece_keys.as_slice();
        let last = levels.len() - 1;
        let mut tools = Vec::new();
        let mut below: Option<Tip> = None;
        for (at, level) in levels.iter().enumerate() {
            let key = level.key.as_str();
            let own = at == last;
            let replayed = match self.ensure(key, level.parent) {
                Ok(count) => count,
                Err(failure) if own => return Err(failure),
                Err(Failure::Broken { message, .. }) => {
                    return Err(Failure::Message(format!(
                        "The tool object's step could not be rebuilt: {message}"
                    )))
                }
                Err(Failure::Missing(_)) => {
                    return Err(Failure::ToolMissing {
                        node: None,
                        key: key.to_string(),
                        step: level.parent,
                    })
                }
                Err(failure) => return Err(failure),
            };
            let first = match &below {
                // The tool step this join takes did not build, so neither does the join: it is kept broken.
                Some(Err(message)) => Err((
                    level.op.clone(),
                    format!("The tool object's step could not be rebuilt: {message}"),
                )),
                _ => match self.edited(key, level.parent, &level.op) {
                    Ok(built) => Ok(built),
                    // --- Split to print (D9). A rebuilt piece's first later step is kept, broken, with the rest.
                    Err(Failure::Message(message) | Failure::GroupFailed { message, .. })
                        if own && own_edit.keep_broken =>
                    {
                        Err((level.op.clone(), message))
                    }
                    Err(failure) => return Err(failure),
                },
            };
            // --- Split to print (D9). The edited step's pieces start their trees once the edit is kept.
            let mut pieces = Vec::new();
            let mut numbered = None;
            let mut pins = None;
            let mut joined = None;
            let first = first.map(|mut built| {
                if own {
                    pieces = std::mem::take(&mut built.pieces);
                    numbered = built.numbered.take();
                    pins = built.pins.take();
                    joined = built.joined.take();
                }
                built
            });
            if own {
                partition_keys_cover(pieces.len(), piece_keys)?;
            }
            let previous = doc_in(&mut self.docs, key)?.current;
            kept.push((key.to_string(), level.ids().collect(), previous));
            let replay = level
                .replay
                .iter()
                .map(|step| (step.id, step.op.clone()))
                .collect();
            let (tip, built, broken) = self.fork(key, level.parent, level.node, first, replay)?;
            if !own {
                let mut part = json!({ "key": key, "built": built });
                if let Some((node, error)) = &broken {
                    part["broken"] = json!({ "id": node, "error": error });
                }
                tools.push(part);
                below = Some(match broken {
                    None => Ok(tip),
                    Some((_, error)) => Err(error),
                });
                continue;
            }
            let doc = doc_in(&mut self.docs, key)?;
            doc.current = tip;
            let pins_key = own_edit.pins_key.clone().filter(|_| pins.is_some());
            if let Some(node) = doc.nodes.get_mut(&level.node) {
                node.pieces = piece_keys.to_vec();
                node.pins = pins_key.clone();
            }
            let text = self.reply(key, tip, chord)?;
            let replies = piece_replies(&mut pieces, piece_keys, chord)?;
            let mut fields = vec![
                (
                    "built",
                    Part::Json(serde_json::Value::Array(built).to_string()),
                ),
                ("replayed", Part::Json(replayed.to_string())),
            ];
            if matches!(level.op, Op::Partition { .. }) {
                fields.push(("parts", Part::Json((pieces.len() + 1).to_string())));
            }
            push_numbers(&mut fields, numbered.as_deref(), joined.as_ref());
            if !piece_keys.is_empty() {
                let list = self.start_pieces(pieces, piece_keys, replies, chord);
                fields.push(("pieces", Part::Json(list)));
            }
            if let (Some(pins), Some(pins_key)) = (pins, pins_key) {
                let list = self.start_pins(pins, &pins_key, chord)?;
                fields.push(("pins", Part::Json(list)));
            }
            if let Some((node, error)) = broken {
                fields.push((
                    "broken",
                    Part::Json(json!({ "id": node, "error": error }).to_string()),
                ));
            }
            if !tools.is_empty() {
                fields.push((
                    "tools",
                    Part::Json(serde_json::Value::Array(tools).to_string()),
                ));
            }
            return Ok(Answer::Held {
                key: key.to_string(),
                text,
                fields,
            });
        }
        unreachable!("an edit has its own tree last")
    }

    /// The edited op built on `parent`, which holds its solid: a kept probe of it if there is one, as Apply takes it.
    fn edited(&mut self, key: &str, parent: NodeId, op: &Op) -> Result<Built, Failure> {
        let steps = self.step_edges(key, parent, op)?;
        let (op, reused) = {
            let doc = doc_in(&mut self.docs, key)?;
            let probed = doc.probe.take();
            let from = doc.shape(parent);
            from.editable().map_err(Failure::Message)?;
            let op = resolve(from, op, &steps).map_err(Failure::Message)?;
            match probed {
                Some(probed) if probed.parent == parent && same_build(&probed.op, &op.op) => {
                    (op, Some(probed.built))
                }
                _ => (op, None),
            }
        };
        match reused {
            Some(reused) => Ok(Built { op: op.op, ..reused }),
            None => {
                let tool = self.join_tool(key, &op.op)?;
                let from = doc_in(&mut self.docs, key)?.shape(parent);
                // The edited step is typed now, as an Apply's is: it has the budget; the steps it replays do not.
                let _budget = GroupBudget::start();
                let _new = NewGroup::start();
                build(from, op, false, tool, &steps).map_err(Failure::from)
            }
        }
    }

    /// The new branch of an edit: its first step kept as `id` under `parent`, built or broken, then each replayed step
    /// on the last that built, until one fails; it and the rest are kept unbuilt, it marked broken. Returns the last step
    /// that built (`parent` when the first did not), each built step as stored, and the broken step with why.
    fn fork(
        &mut self,
        key: &str,
        parent: NodeId,
        id: NodeId,
        first: Result<Built, (Op, String)>,
        replay: Vec<(NodeId, Op)>,
    ) -> Result<Forked, Failure> {
        let mut built = Vec::new();
        let mut broken: Option<(NodeId, String)> = None;
        // The last step that built, and the last step kept, built or not.
        let (mut last, mut tail) = (parent, id);
        match first {
            Ok(first) => {
                built.push(self.keep(key, parent, id, first)?);
                last = id;
            }
            Err((op, message)) => {
                doc_in(&mut self.docs, key)?.insert(id, parent, op)?.broken = Some(message.clone());
                broken = Some((id, message));
            }
        }
        for (step, op) in replay {
            if broken.is_none() {
                match self.replay_step(key, last, &op) {
                    Ok(done) => {
                        built.push(self.keep(key, last, step, done)?);
                        last = step;
                        tail = step;
                        continue;
                    }
                    Err(Failure::Message(message) | Failure::GroupFailed { message, .. }) => {
                        broken = Some((step, message))
                    }
                    Err(failure) => return Err(failure),
                }
            }
            let node = doc_in(&mut self.docs, key)?.insert(step, tail, op)?;
            if let Some((_, message)) = broken.as_ref().filter(|(at, _)| *at == step) {
                node.broken = Some(message.clone());
            }
            tail = step;
        }
        Ok((last, built, broken))
    }

    /// One replayed step built on node `from`, which holds its solid. A step that cannot be built is a `Message`; a
    /// tool tree this engine lacks stays `ToolMissing`, so the client opens it and the whole edit is asked again.
    fn replay_step(&mut self, key: &str, from: NodeId, op: &Op) -> Result<Built, Failure> {
        let tool = self.join_tool(key, op)?;
        let steps = self.step_edges(key, from, op)?;
        let from = doc_in(&mut self.docs, key)?.shape(from);
        let op = resolve(from, op, &steps).map_err(Failure::Message)?;
        build(from, op, false, tool, &steps).map_err(Failure::from)
    }
}
