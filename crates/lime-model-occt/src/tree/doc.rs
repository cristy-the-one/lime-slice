//! One document of the store: its nodes, which solids are held, and rebuilding a node from its nearest kept ancestor.

use std::collections::{HashMap, HashSet};

use super::{
    rebuilt_differently,
    root_placement,
    stamp_faces,
    Doc,
    Node,
    NodeId,
    PATH_PIN_EVERY,
    ROOT,
};
use super::build::{build, ToolSolid};
use super::ops::Op;
use super::outcome::Failure;
use super::resolve::{resolve, Steps};
use super::shape::Shape;

impl Doc {
    pub(super) fn new(root: Shape, used: u64) -> Doc {
        let fingerprint = root.fingerprint();
        let mut nodes = HashMap::new();
        nodes.insert(
            ROOT,
            Node {
                parent: None,
                op: None,
                shape: Some(root),
                fingerprint: Some(fingerprint),
                broken: None,
                piece: None,
                pieces: Vec::new(),
                pins: None,
                created: None,
                face_owners: Vec::new(),
                seeded: false,
                depth: 0,
                used,
            },
        );
        let mut doc = Doc {
            nodes,
            current: ROOT,
            probe: None,
        };
        // --- A10. A root made every face it has.
        stamp_faces(&mut doc, ROOT);
        doc
    }

    pub(super) fn node(&self, id: NodeId) -> Result<&Node, Failure> {
        self.nodes.get(&id).ok_or(Failure::Missing(vec![id]))
    }

    pub(super) fn insert(&mut self, id: NodeId, parent: NodeId, op: Op) -> Result<&mut Node, Failure> {
        root_placement(parent, &op).map_err(Failure::Message)?;
        let depth = self.node(parent)?.depth + 1;
        let node = self.nodes.entry(id).or_insert(Node {
            parent: Some(parent),
            op: Some(op),
            shape: None,
            fingerprint: None,
            broken: None,
            piece: None,
            pieces: Vec::new(),
            pins: None,
            created: None,
            face_owners: Vec::new(),
            seeded: false,
            depth,
            used: 0,
        });
        Ok(node)
    }

    pub(super) fn held(&self) -> Vec<NodeId> {
        let mut held: Vec<NodeId> = self
            .nodes
            .iter()
            .filter(|(_, node)| node.shape.is_some())
            .map(|(id, _)| *id)
            .collect();
        held.sort_unstable();
        held
    }

    /// Whether `node` is `id` or a step above it.
    pub(super) fn above(&self, id: NodeId, node: NodeId) -> bool {
        let mut at = Some(id);
        while let Some(step) = at {
            if step == node {
                return true;
            }
            at = self.nodes.get(&step).and_then(|found| found.parent);
        }
        false
    }

    /// The root, the current node, every eighth node on the path between them, and every seeded node.
    pub(super) fn pinned(&self) -> HashSet<NodeId> {
        let mut pinned = HashSet::from([ROOT, self.current]);
        pinned.extend(
            self.nodes
                .iter()
                .filter(|(_, node)| node.seeded)
                .map(|(id, _)| *id),
        );
        let mut at = Some(self.current);
        while let Some(id) = at {
            let Some(node) = self.nodes.get(&id) else {
                break;
            };
            if node.depth % PATH_PIN_EVERY == 0 {
                pinned.insert(id);
            }
            at = node.parent;
        }
        pinned
    }

    /// `id` and every node under it.
    pub(super) fn subtree(&self, id: NodeId) -> HashSet<NodeId> {
        let mut found = HashSet::from([id]);
        loop {
            let before = found.len();
            for (child, node) in &self.nodes {
                if node.parent.is_some_and(|up| found.contains(&up)) {
                    found.insert(*child);
                }
            }
            if found.len() == before {
                return found;
            }
        }
    }

    /// No solid under a broken node stays usable: each would have been built from a solid that
    /// no longer rebuilds the same.
    pub(super) fn mark_broken(&mut self, id: NodeId, message: String) -> Failure {
        let under = self.subtree(id);
        for node in &under {
            if let Some(node) = self.nodes.get_mut(node) {
                node.shape = None;
                node.seeded = false;
            }
        }
        if let Some(node) = self.nodes.get_mut(&id) {
            node.broken = Some(message.clone());
        }
        if self
            .probe
            .as_ref()
            .is_some_and(|probe| under.contains(&probe.parent))
        {
            self.probe = None;
        }
        Failure::Broken { node: id, message }
    }

    /// The first broken node from `id` up to the root, as the failure a call on `id` answers.
    pub(super) fn broken_above(&self, id: NodeId) -> Result<(), Failure> {
        let mut at = Some(id);
        while let Some(step) = at {
            let node = self.node(step)?;
            if let Some(message) = &node.broken {
                return Err(Failure::Broken {
                    node: step,
                    message: message.clone(),
                });
            }
            at = node.parent;
        }
        Ok(())
    }

    /// The steps from `id` up to the nearest ancestor that holds its solid, `id` first: what a
    /// replay of `id` builds.
    pub(super) fn unbuilt(&self, id: NodeId) -> Result<Vec<NodeId>, Failure> {
        let mut chain = Vec::new();
        let mut at = id;
        loop {
            let node = self.node(at)?;
            if let Some(message) = &node.broken {
                return Err(Failure::Broken {
                    node: at,
                    message: message.clone(),
                });
            }
            if node.shape.is_some() {
                return Ok(chain);
            }
            chain.push(at);
            at = node.parent.expect("the root always holds its solid");
        }
    }

    /// Give `id` a solid, replaying from the nearest ancestor that has one. `tools` holds the
    /// solid each join step on the way takes from its tool tree, and `steps` the edges each blend
    /// on the way takes from an earlier step (`Store::ensure`).
    /// Returns how many steps were replayed. Only solids are built here, never replies.
    pub(super) fn ensure_shape(
        &mut self,
        id: NodeId,
        clock: &mut u64,
        tools: &HashMap<NodeId, ToolSolid>,
        steps: &HashMap<NodeId, Steps>,
    ) -> Result<usize, Failure> {
        let chain = self.unbuilt(id)?;
        let replayed = chain.len();
        for step in chain.into_iter().rev() {
            let (parent, op, expected) = {
                let node = &self.nodes[&step];
                (
                    node.parent.expect("only the root has no parent"),
                    node.op.clone().expect("only the root has no op"),
                    node.fingerprint,
                )
            };
            let built = {
                let from = self
                    .nodes
                    .get_mut(&parent)
                    .and_then(|node| node.shape.as_mut())
                    .expect("the parent was built first");
                let none = Steps::new();
                let found = steps.get(&step).unwrap_or(&none);
                resolve(from, &op, found).and_then(|op| {
                    build(from, op, false, tools.get(&step).copied(), found)
                        .map_err(|fail| fail.message)
                })
            };
            let built = match built {
                Ok(built) => built,
                Err(message) => return Err(self.mark_broken(step, message)),
            };
            let got = built.kept.fingerprint();
            if let Some(expected) = expected {
                if !expected.matches(&got) {
                    return Err(self.mark_broken(step, rebuilt_differently(&got, &expected)));
                }
            }
            *clock += 1;
            let node = self.nodes.get_mut(&step).expect("step is in the tree");
            node.fingerprint = Some(got);
            node.op = Some(built.op);
            node.shape = Some(built.kept);
            node.used = *clock;
            // --- A10. Faces this replay made belong to this step; the rest keep the node that made them.
            stamp_faces(self, step);
        }
        *clock += 1;
        if let Some(node) = self.nodes.get_mut(&id) {
            node.used = *clock;
        }
        Ok(replayed)
    }

    pub(super) fn shape(&mut self, id: NodeId) -> &mut Shape {
        self.nodes
            .get_mut(&id)
            .and_then(|node| node.shape.as_mut())
            .expect("ensure_shape ran first")
    }
}
