//! The store: opening and reaching nodes, the reply cache, keeping and evicting solids, tool objects.

use super::*;


impl Store {
    /// Give node `id` of tree `key` a solid. A join on the way first has its tool tree build the step
    /// it names, from that tree's own kept solids, so one tree's step can depend on another's.
    pub(super) fn ensure(&mut self, key: &str, id: NodeId) -> Result<usize, Failure> {
        self.ensure_from(key, id, &mut Vec::new())
    }

    /// `visiting` is the trees whose replay is under way, so a history that names itself fails plainly.
    fn ensure_from(
        &mut self,
        key: &str,
        id: NodeId,
        visiting: &mut Vec<String>,
    ) -> Result<usize, Failure> {
        // A blend's step picks first: reading a step's edges may build that step, and so part of this replay.
        let doc = doc_in(&mut self.docs, key)?;
        let picking: Vec<(NodeId, NodeId, Op)> = doc
            .unbuilt(id)?
            .into_iter()
            .filter_map(|step| {
                let node = &doc.nodes[&step];
                let op = node.op.as_ref()?;
                picks_steps(op).then(|| (step, node.parent.expect("only the root has no parent"), op.clone()))
            })
            .collect();
        let mut steps = HashMap::new();
        for (step, parent, op) in picking {
            match self.step_edges(key, parent, &op) {
                Ok(found) => {
                    steps.insert(step, found);
                }
                Err(Failure::Message(message)) => {
                    return Err(doc_in(&mut self.docs, key)?.mark_broken(step, message));
                }
                Err(failure) => return Err(failure),
            }
        }
        let doc = doc_in(&mut self.docs, key)?;
        let joins: Vec<(NodeId, ToolRef)> = doc
            .unbuilt(id)?
            .into_iter()
            .filter_map(|step| match &doc.nodes[&step].op {
                Some(Op::Join { tool, .. }) => Some((step, tool.clone())),
                _ => None,
            })
            .collect();
        let mut tools = HashMap::new();
        for (step, tool) in joins {
            match self.tool_solid(key, &tool, visiting) {
                Ok(solid) => {
                    tools.insert(step, solid);
                }
                Err(Failure::ToolMissing {
                    key: missing,
                    step: wanted,
                    ..
                }) => {
                    return Err(Failure::ToolMissing {
                        node: Some(step),
                        key: missing,
                        step: wanted,
                    })
                }
                Err(Failure::Message(message)) => {
                    return Err(doc_in(&mut self.docs, key)?.mark_broken(step, message));
                }
                Err(failure) => return Err(failure),
            }
        }
        doc_in(&mut self.docs, key)?.ensure_shape(id, &mut self.clock, &tools, &steps)
    }

    /// The solid a join on tree `key` takes from `tool`, built if it must be. A tool tree or step this
    /// engine does not hold is `ToolMissing`; one that cannot serve as a tool is a plain message.
    fn tool_solid(
        &mut self,
        key: &str,
        tool: &ToolRef,
        visiting: &mut Vec<String>,
    ) -> Result<ToolSolid, Failure> {
        if tool.key == key {
            return Err(Failure::Message("A part cannot be its own tool".into()));
        }
        if visiting.contains(&tool.key) {
            return Err(Failure::Message(CYCLE.into()));
        }
        let held = self
            .docs
            .get(&tool.key)
            .is_some_and(|doc| doc.nodes.contains_key(&tool.node));
        if !held {
            return Err(Failure::ToolMissing {
                node: None,
                key: tool.key.clone(),
                step: tool.node,
            });
        }
        visiting.push(key.to_string());
        let built = self.ensure_from(&tool.key, tool.node, visiting);
        visiting.pop();
        match built {
            Ok(_) => {}
            Err(Failure::ToolMissing { key, step, .. }) => {
                return Err(Failure::ToolMissing {
                    node: None,
                    key,
                    step,
                })
            }
            Err(Failure::Message(message)) => return Err(Failure::Message(message)),
            Err(Failure::Broken { message, .. } | Failure::GroupFailed { message, .. }) => {
                return Err(Failure::Message(format!(
                    "The tool object's step could not be rebuilt: {message}"
                )))
            }
            Err(Failure::Missing(_)) => {
                return Err(Failure::ToolMissing {
                    node: None,
                    key: tool.key.clone(),
                    step: tool.node,
                })
            }
            // Only an open says why it refused a seed; a replay never does.
            Err(failure @ Failure::SeedRefused(..)) => return Err(failure),
        }
        let shape = self.docs[&tool.key].nodes[&tool.node]
            .shape
            .as_ref()
            .expect("ensure_from built it");
        shape.editable().map_err(|_| {
            Failure::Message(
                "The tool object has surfaces but no closed solid, so it cannot be used as a tool"
                    .into(),
            )
        })?;
        Ok(ToolSolid(shape.raw()))
    }

    /// --- A5. Indexes on the current solid of the edges step `node` made, kept by `filter`. ---
    pub(super) fn step_edge_indexes(
        &mut self,
        key: String,
        node: NodeId,
        filter: EdgeFilter,
    ) -> Result<Answer, Failure> {
        let current = {
            let doc = doc_in(&mut self.docs, &key)?;
            if !doc.nodes.contains_key(&node) {
                return Err(Failure::Message(format!(
                    "Step {node} is not in this history."
                )));
            }
            let current = doc.current;
            if !doc.above(current, node) {
                return Err(Failure::Message(NOT_ABOVE.into()));
            }
            current
        };
        // The same pick a fillet stores, so the indexes are the ones that fillet would blend.
        let op = Op::Fillet {
            edges: vec![EdgePick::Step(EdgeStep {
                from_node: node,
                filter: Some(filter),
            })],
            size: 1.0,
        };
        let steps = self.step_edges(&key, current, &op)?;
        self.ensure(&key, current)?;
        let shape = doc_in(&mut self.docs, &key)?.shape(current);
        let resolved = resolve(shape, &op, &steps).map_err(|message| {
            Failure::Message(message.replace(" to fillet.", "."))
        })?;
        Ok(Answer::Plain(
            json!({ "id": current, "node": node, "edges": resolved.picks }).to_string(),
        ))
    }

    /// The edges each step that `op`, built on `parent`, takes edges from made: read once from that step's solid,
    /// which is built first if it must be. A step that is not `parent` or above it is refused.
    pub(super) fn step_edges(&mut self, key: &str, parent: NodeId, op: &Op) -> Result<Steps, Failure> {
        let mut wanted = Vec::new();
        // --- A1 group: a fillet inside the group takes edges from a step above the group. ---
        blend_step_picks(op, &mut wanted);
        let mut steps = Steps::new();
        for node in wanted {
            if steps.contains_key(&node) {
                continue;
            }
            if !doc_in(&mut self.docs, key)?.above(parent, node) {
                return Err(Failure::Message(NOT_ABOVE.into()));
            }
            let kept = doc_in(&mut self.docs, key)?
                .node(node)?
                .created
                .clone();
            let made = match kept {
                Some(made) => made,
                None => {
                    self.ensure(key, node)?;
                    let doc = doc_in(&mut self.docs, key)?;
                    let made = doc.shape(node).created_edges();
                    if let Some(at) = doc.nodes.get_mut(&node) {
                        at.created = Some(made.clone());
                    }
                    made
                }
            };
            steps.insert(node, made);
        }
        Ok(steps)
    }

    /// Whether tree `from`, or any tree its joins take a tool from, takes one from tree `key`.
    /// A tree on the way that this engine does not hold is `ToolMissing`, so the client opens it and
    /// the answer covers every tree.
    fn uses(&self, from: &ToolRef, key: &str) -> Result<bool, Failure> {
        let mut queue = vec![(from.key.clone(), from.node)];
        let mut seen = HashSet::new();
        while let Some((at, step)) = queue.pop() {
            if at == key {
                return Ok(true);
            }
            if !seen.insert(at.clone()) {
                continue;
            }
            let Some(doc) = self.docs.get(&at) else {
                return Err(Failure::ToolMissing {
                    node: None,
                    key: at,
                    step,
                });
            };
            for node in doc.nodes.values() {
                if let Some(Op::Join { tool, .. }) = &node.op {
                    queue.push((tool.key.clone(), tool.node));
                }
            }
        }
        Ok(false)
    }

    /// A new join's checks before anything is built: a rigid placement, another part, and no loop
    /// between two histories. A loop would leave each tree naming the other, so neither could ever
    /// be closed, nor its join's branch dropped. A refusal is a plain `Message`.
    pub(super) fn join_refusal(&self, key: &str, op: &Op) -> Result<(), Failure> {
        let Op::Join { tool, relative, .. } = op else {
            return Ok(());
        };
        relative.rigid().map_err(Failure::Message)?;
        if tool.key == key {
            return Err(Failure::Message("A part cannot be its own tool".into()));
        }
        if self.uses(tool, key)? {
            return Err(Failure::Message(CYCLE.into()));
        }
        Ok(())
    }

    /// Whether a join in a tree other than `key` takes its tool from one of `nodes` of `key` (any node when None).
    pub(super) fn names_tool(&self, key: &str, nodes: Option<&HashSet<NodeId>>) -> bool {
        self.docs
            .iter()
            .filter(|(other, _)| other.as_str() != key)
            .flat_map(|(_, doc)| doc.nodes.values())
            .any(|node| {
                matches!(&node.op, Some(Op::Join { tool, .. })
                    if tool.key == key && nodes.is_none_or(|nodes| nodes.contains(&tool.node)))
            })
    }

    pub(super) fn open(
        &mut self,
        key: String,
        root: Shape,
        saved: Vec<SavedNode>,
        current: NodeId,
        seed: Option<SeedSolid>,
        chord: Option<f64>,
    ) -> Result<Answer, Failure> {
        self.clock += 1;
        let mut doc = Doc::new(root, self.clock);
        for node in saved {
            if node.id == ROOT || doc.nodes.contains_key(&node.id) {
                return Err(Failure::Message(format!(
                    "Saved node {} is listed twice or replaces the root",
                    node.id
                )));
            }
            if !doc.nodes.contains_key(&node.parent) {
                return Err(Failure::Message(format!(
                    "Saved node {} comes before its parent {}",
                    node.id, node.parent
                )));
            }
            doc.insert(node.id, node.parent, node.op)?.fingerprint = node.fingerprint;
        }
        // A seed that does not read, or is not the step it names, is left out: the step is replayed instead.
        let refused = seed.and_then(|seed| {
            let used = self.clock;
            seed_node(&mut doc, seed, used).err()
        });
        self.replies.retain(|reply| reply.key != key);
        self.docs.insert(key.clone(), doc);
        // Without a chord the step is built and kept, not meshed: the caller asks for it next.
        let answer = match chord {
            Some(chord) => self.goto(key, current, chord),
            None => self.reach(key, current),
        };
        match (answer, refused) {
            (
                Ok(Answer::Held {
                    key,
                    text,
                    mut fields,
                }),
                Some(why),
            ) => {
                fields.push(("seedRefused", Part::Json(json!(why).to_string())));
                Ok(Answer::Held { key, text, fields })
            }
            (Err(failure), Some(why)) => Err(Failure::SeedRefused(Box::new(failure), why)),
            (answer, _) => answer,
        }
    }

    /// Build `id` and keep it as the current step, answering only `{id, fingerprint}` and how many steps it replayed.
    fn reach(&mut self, key: String, id: NodeId) -> Result<Answer, Failure> {
        doc_in(&mut self.docs, &key)?.broken_above(id)?;
        let replayed = self.ensure(&key, id)?;
        let doc = doc_in(&mut self.docs, &key)?;
        doc.current = id;
        let fingerprint = doc.node(id)?.fingerprint;
        Ok(Answer::Held {
            key,
            text: Arc::new(json!({ "id": id, "fingerprint": fingerprint }).to_string()),
            fields: vec![("replayed", Part::Json(replayed.to_string()))],
        })
    }

    pub(super) fn goto(&mut self, key: String, id: NodeId, chord: f64) -> Result<Answer, Failure> {
        let doc = doc_in(&mut self.docs, &key)?;
        doc.broken_above(id)?;
        doc.probe = None;
        let (text, replayed) = match self.cached_reply(&key, id, chord) {
            Some(text) => {
                let doc = doc_in(&mut self.docs, &key)?;
                if let Some(node) = doc.nodes.get_mut(&id) {
                    node.used = self.clock;
                }
                (text, 0)
            }
            None => {
                let replayed = self.ensure(&key, id)?;
                (self.reply(&key, id, chord)?, replayed)
            }
        };
        doc_in(&mut self.docs, &key)?.current = id;
        Ok(Answer::Held {
            key,
            text,
            fields: vec![("replayed", Part::Json(replayed.to_string()))],
        })
    }

    fn cached_reply(&mut self, key: &str, id: NodeId, chord: f64) -> Option<Arc<String>> {
        let chord = chord_key(chord);
        self.clock += 1;
        let reply = self
            .replies
            .iter_mut()
            .find(|reply| reply.key == key && reply.node == id && reply.chord == chord)?;
        reply.used = self.clock;
        Some(Arc::clone(&reply.text))
    }

    /// The node's reply, built and cached on first use. The node must hold its solid.
    pub(super) fn reply(&mut self, key: &str, id: NodeId, chord: f64) -> Result<Arc<String>, Failure> {
        if let Some(text) = self.cached_reply(key, id, chord) {
            return Ok(text);
        }
        let doc = doc_in(&mut self.docs, key)?;
        // --- A10. `stepFaces` rides on the cached solid reply. A face's node is the one that made it.
        let owners = doc
            .nodes
            .get(&id)
            .map(|node| node.face_owners.clone())
            .unwrap_or_default();
        let mut text = doc.shape(id).reply(id, chord)?;
        if !owners.is_empty() {
            text = with_fields(&text, &[("stepFaces", Part::Json(json!(owners).to_string()))]);
        }
        let text = Arc::new(text);
        self.remember(key, id, chord, Arc::clone(&text));
        Ok(text)
    }

    pub(super) fn remember(&mut self, key: &str, id: NodeId, chord: f64, text: Arc<String>) {
        self.replies.push(Reply {
            key: key.to_string(),
            node: id,
            chord: chord_key(chord),
            text,
            used: self.clock,
        });
    }

    /// Keep `built` as node `id` under `parent`, as an apply does: its solid, its fingerprint, and its op as stored.
    pub(super) fn keep(
        &mut self,
        key: &str,
        parent: NodeId,
        id: NodeId,
        built: Built,
    ) -> Result<serde_json::Value, Failure> {
        let fingerprint = built.kept.fingerprint();
        let stored = json!({ "id": id, "op": built.op, "fingerprint": fingerprint });
        self.clock += 1;
        let node = doc_in(&mut self.docs, key)?.insert(id, parent, built.op)?;
        node.fingerprint = Some(fingerprint);
        node.shape = Some(built.kept);
        node.used = self.clock;
        // --- A10.
        let doc = doc_in(&mut self.docs, key)?;
        stamp_faces(doc, id);
        Ok(stored)
    }

    /// A join's tool step when this engine does not hold it, as `ToolMissing`, before anything is built.
    pub(super) fn tool_held(&self, op: &Op) -> Result<(), Failure> {
        let Op::Join { tool, .. } = op else {
            return Ok(());
        };
        if self
            .docs
            .get(&tool.key)
            .is_some_and(|doc| doc.nodes.contains_key(&tool.node))
        {
            return Ok(());
        }
        Err(Failure::ToolMissing {
            node: None,
            key: tool.key.clone(),
            step: tool.node,
        })
    }

    /// The solid a join takes from its tool tree, or None for any other op.
    pub(super) fn join_tool(&mut self, key: &str, op: &Op) -> Result<Option<ToolSolid>, Failure> {
        match op {
            Op::Join { tool, .. } => self.tool_solid(key, tool, &mut Vec::new()).map(Some),
            _ => Ok(None),
        }
    }

    /// Remove `id` and everything under it. The current node moves to `id`'s parent if it was inside.
    pub(super) fn drop_branch(&mut self, key: String, id: NodeId) -> Result<Answer, Failure> {
        if id == ROOT {
            return Err(Failure::Message(
                "The root cannot be dropped. Close the tree instead.".into(),
            ));
        }
        let doc = doc_in(&mut self.docs, &key)?;
        let parent = doc.node(id)?.parent.expect("only the root has no parent");
        let gone = doc.subtree(id);
        if self.names_tool(&key, Some(&gone)) {
            return Err(Failure::Message(
                "A step of another part's history uses a step of this branch as its tool, so it cannot be deleted"
                    .into(),
            ));
        }
        let doc = doc_in(&mut self.docs, &key)?;
        doc.nodes.retain(|node, _| !gone.contains(node));
        if gone.contains(&doc.current) {
            doc.current = parent;
        }
        if doc
            .probe
            .as_ref()
            .is_some_and(|probe| gone.contains(&probe.parent))
        {
            doc.probe = None;
        }
        let current = doc.current;
        self.replies
            .retain(|reply| reply.key != key || !gone.contains(&reply.node));
        let mut dropped: Vec<NodeId> = gone.into_iter().collect();
        dropped.sort_unstable();
        Ok(Answer::Held {
            key,
            text: Arc::new(json!({ "dropped": dropped, "current": current }).to_string()),
            fields: Vec::new(),
        })
    }

    pub(super) fn evict(&mut self) {
        let mut loose: Vec<(u64, String, NodeId)> = Vec::new();
        for (key, doc) in &self.docs {
            let pinned = doc.pinned();
            for (id, node) in &doc.nodes {
                if node.shape.is_some() && !pinned.contains(id) {
                    loose.push((node.used, key.clone(), *id));
                }
            }
        }
        if loose.len() > self.limits.shapes {
            loose.sort_unstable_by_key(|(used, _, _)| *used);
            let excess = loose.len() - self.limits.shapes;
            for (_, key, id) in loose.into_iter().take(excess) {
                if let Some(node) = self
                    .docs
                    .get_mut(&key)
                    .and_then(|doc| doc.nodes.get_mut(&id))
                {
                    node.shape = None;
                }
            }
        }
        if self.replies.len() > self.limits.replies {
            self.replies
                .sort_unstable_by_key(|reply| std::cmp::Reverse(reply.used));
            self.replies.truncate(self.limits.replies);
        }
    }
}
