//! `Store::handle`: one arm per request.

use base64::Engine;
use serde_json::json;

use super::{doc_in, lettering, rebuilt_differently, root_shape, NodeId, Store, ROOT};
use super::fit_coupon::fit_coupon_reply;
use super::group::SectionBudget;
use super::outcome::{Answer, Failure};
use super::partition::PieceKeys;
use super::request::{ExportFormat, OwnEdit, Request, ToolEdit};
use super::resolve::resolve_one_face;
use super::shape::Shape;
use super::step_solids::{named_solids_of, STEP_SOLIDS_MAX};

impl Store {
    pub(super) fn handle(&mut self, request: Request) -> Result<Answer, Failure> {
        match request {
            Request::Capabilities => Ok(Answer::Plain(
                json!({"stepMeshing": cfg!(lime_occt_step)}).to_string(),
            )),
            Request::MeshStep { data_b64, chord_mm } => {
                if !chord_mm.is_finite() || !(0.01..=2.0).contains(&chord_mm) {
                    return Err(Failure::Message(
                        "STEP chord tolerance must be from 0.01 to 2 mm".into(),
                    ));
                }
                let mut shape = root_shape(Some(data_b64), None, None, None, None)?;
                Ok(Answer::Plain(shape.reply(ROOT, chord_mm, false)?))
            }
            Request::TextFonts => Ok(Answer::Plain(lettering::fonts_reply())),
            Request::TextFontAdd { data_b64, face } => Ok(Answer::Plain(
                crate::text::user::add_reply(&data_b64, face).map_err(Failure::Message)?,
            )),
            Request::TextFontPack { id, uses } => {
                let uses: Vec<crate::text::user::Use> = uses
                    .into_iter()
                    .map(|u| crate::text::user::Use { text: u.text, style: u.style, weight: u.weight })
                    .collect();
                Ok(Answer::Plain(
                    crate::text::user::pack_reply(&id, &uses).map_err(Failure::Message)?,
                ))
            }
            Request::TextCurved {
                key,
                node,
                point,
                text,
                font,
                style,
                height,
                depth,
                cut,
                spacing,
                line_spacing,
                align,
                angle_deg,
                along,
                flip,
                wrap,
                weight,
                stroke_mm,
                line_mm,
                step_mm,
            } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let spec = crate::text::Spec {
                    text,
                    font,
                    style,
                    height,
                    spacing,
                    line_spacing,
                    align: align.unwrap_or_default(),
                    angle_deg: angle_deg.unwrap_or(0.0),
                    weight,
                    stroke_mm,
                };
                Ok(Answer::Plain(
                    lettering::curved_reply(
                        shape,
                        &spec,
                        point,
                        depth,
                        cut,
                        along.as_deref(),
                        flip.unwrap_or(false),
                        wrap.as_deref(),
                        line_mm.unwrap_or(0.4),
                        step_mm.unwrap_or(0.5),
                    )
                    .map_err(Failure::Message)?,
                ))
            }
            Request::TextLayout {
                text,
                font,
                style,
                height,
                spacing,
                line_spacing,
                align,
                angle_deg,
                weight,
                stroke_mm,
                line_mm,
                step_mm,
            } => {
                let spec = crate::text::Spec {
                    text,
                    font,
                    style,
                    height,
                    spacing,
                    line_spacing,
                    align: align.unwrap_or_default(),
                    angle_deg: angle_deg.unwrap_or(0.0),
                    weight,
                    stroke_mm,
                };
                Ok(Answer::Plain(
                    lettering::layout_reply(&spec, line_mm.unwrap_or(0.4), step_mm.unwrap_or(0.05))
                        .map_err(Failure::Message)?,
                ))
            }
            Request::FitCoupon { spec } => Ok(Answer::Plain(
                fit_coupon_reply(&spec, true, false)
                    .map_err(Failure::Message)?
                    .to_string(),
            )),
            Request::StepSolids { data_b64, files } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_b64.trim())
                    .map_err(|err| Failure::Message(err.to_string()))?;
                let solids = named_solids_of(&bytes).map_err(Failure::Message)?;
                let mut rows = Vec::with_capacity(solids.len());
                for (name, solid) in &solids {
                    let mut row = json!({ "name": name, "volumeMm3": solid.check().volume_mm3, "bounds": solid.bounds() });
                    if files {
                        let piece =
                            Shape::step_bytes_of(&[solid.raw()], std::slice::from_ref(name), &[])
                                .map_err(Failure::Message)?;
                        row["bytesBase64"] =
                            json!(base64::engine::general_purpose::STANDARD.encode(&piece));
                    }
                    rows.push(row);
                }
                Ok(Answer::Plain(json!({ "solids": rows }).to_string()))
            }
            Request::StepAssembly { data_b64 } => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data_b64.trim())
                    .map_err(|err| Failure::Message(err.to_string()))?;
                let json = Shape::read_step_assembly(&bytes).map_err(Failure::Message)?;
                Ok(Answer::Plain(json))
            }
            Request::ShapeSolids { data_b64 } => {
                let shape = root_shape(Some(data_b64), None, None, None, None)?;
                let more = format!("This shape has more than {STEP_SOLIDS_MAX} solids");
                let solids = shape
                    .solids_up_to(STEP_SOLIDS_MAX, &more)
                    .map_err(Failure::Message)?;
                let mut rows = Vec::with_capacity(solids.len());
                for solid in &solids {
                    let bytes = solid.brep_bytes().map_err(Failure::Message)?;
                    let mut row = json!({
                        "volumeMm3": solid.fingerprint().volume_mm3,
                        "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                    });
                    if let Some(bounds) = solid.bounds() {
                        row["bounds"] = json!({
                            "min": [bounds[0], bounds[1], bounds[2]],
                            "max": [bounds[3], bounds[4], bounds[5]],
                        });
                    }
                    rows.push(row);
                }
                Ok(Answer::Plain(json!({ "solids": rows }).to_string()))
            }
            Request::Open {
                key,
                data_b64,
                step_path,
                box_mm,
                primitive,
                feature,
                fingerprint,
                chord_mm,
                nodes,
                current,
                seed,
                quiet,
            } => {
                let step_root = step_path.is_some() || data_b64.as_deref().is_some_and(super::is_step_data);
                let root = root_shape(data_b64, step_path, box_mm, primitive, feature.map(|op| *op))?;
                if let Some(saved) = fingerprint {
                    let got = root.fingerprint();
                    if !saved.matches(&got) {
                        return Err(Failure::Broken {
                            node: ROOT,
                            message: rebuilt_differently(&got, &saved),
                        });
                    }
                }
                self.open(
                    key,
                    root,
                    step_root,
                    nodes,
                    current,
                    seed,
                    (!quiet).then_some(chord_mm),
                )
            }
            Request::Apply {
                key,
                parent,
                node,
                op,
                chord_mm,
                other_key,
                piece_keys,
                pins_key,
                mesh,
            } => {
                let keys = PieceKeys {
                    other: other_key,
                    list: piece_keys,
                    pins: pins_key,
                    mesh,
                };
                self.apply(key, parent, node, op, chord_mm, keys)
            }
            Request::Fold {
                key,
                parent,
                node,
                op,
                last,
                chord_mm,
            } => self.fold(key, parent, node, op, last, chord_mm),
            Request::ToolBox { op } => Ok(Answer::Plain(
                super::group::tool_box_reply(&op).map_err(Failure::Message)?,
            )),
            Request::Unfold {
                key,
                from,
                last,
                nodes,
            } => self.unfold(key, from, last, nodes),
            Request::Probe {
                key,
                node,
                op,
                preview,
                chord_mm,
            } => self.probe(&key, node, op, preview.then_some(chord_mm)),
            Request::Edit {
                key,
                parent,
                node,
                op,
                replay,
                tools,
                chord_mm,
                piece_keys,
                pins_key,
                keep_broken,
            } => {
                if keep_broken && !tools.is_empty() {
                    return Err(Failure::Message(
                        "keepBroken is only for an edit of one tree".into(),
                    ));
                }
                let mut levels = tools;
                levels.push(ToolEdit {
                    key,
                    parent,
                    node,
                    op,
                    replay,
                });
                let own = OwnEdit {
                    piece_keys,
                    pins_key,
                    keep_broken,
                };
                self.edit(levels, chord_mm, own)
            }
            Request::Goto {
                key,
                node,
                chord_mm,
            } => self.goto(key, node, chord_mm),
            Request::Drop { key, node } => self.drop_branch(key, node),
            Request::Close { key } => {
                if self.names_tool(&key, None) {
                    return Err(Failure::Message(
                        "A step of another part's history uses this part as its tool, so it stays open"
                            .into(),
                    ));
                }
                self.docs.remove(&key);
                self.replies.retain(|reply| reply.key != key);
                Ok(Answer::Plain(json!({ "ok": true }).to_string()))
            }
            Request::Distance {
                key,
                node,
                a_kind,
                a_index,
                b_kind,
                b_index,
            } => {
                self.ensure(&key, node)?;
                let distance = doc_in(&mut self.docs, &key)?
                    .shape(node)
                    .distance(&a_kind, a_index, &b_kind, b_index)
                    .map_err(Failure::Message)?;
                Ok(Answer::Plain(
                    json!({ "id": node, "distanceMm": distance }).to_string(),
                ))
            }
            // --- Print transitions, auto-find.
            Request::TransitionFind {
                key,
                node,
                build,
                up,
                limit_deg,
                fix,
            } => self.transition_find(&key, node, build, up, limit_deg, fix),
            Request::EdgeChain { key, node, edge } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let (edges, closed) = shape
                    .edge_chain(edge)
                    .ok_or_else(|| Failure::Message("That edge is not on this solid".into()))?;
                Ok(Answer::Plain(
                    json!({ "id": node, "edge": edge, "edges": edges, "closed": closed }).to_string(),
                ))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::TextTestFont { family, fs_type, variable } => {
                use crate::text::synth::Synth;
                let mut font = Synth::simple(&family).with_fs_type(fs_type);
                if let Some([min, max]) = variable {
                    font = font.variable(min, max);
                }
                Ok(Answer::Plain(
                    json!({ "dataB64": base64::engine::general_purpose::STANDARD.encode(font.bytes()) }).to_string(),
                ))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::TestNurbs { key, node } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let bytes = shape.test_nurbs().map_err(Failure::Message)?;
                Ok(Answer::Plain(
                    json!({ "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes) }).to_string(),
                ))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::TestPlace { key, node, mirror, offset } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let bytes = shape.test_place(mirror, offset).map_err(Failure::Message)?;
                Ok(Answer::Plain(
                    json!({ "dataB64": base64::engine::general_purpose::STANDARD.encode(bytes) }).to_string(),
                ))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::TestLastFill => Ok(Answer::Plain(
                super::shape::take_text(unsafe { super::ffi::lime_tree_test_last_fill() }).unwrap_or_default(),
            )),
            #[cfg(lime_occt_test_hooks)]
            Request::TestMesh { key, node, chord_mm } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let text = shape.test_mesh(chord_mm).map_err(Failure::Message)?;
                Ok(Answer::Plain(text))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::TestText { key, node, point } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let text = shape.test_text(point).map_err(Failure::Message)?;
                Ok(Answer::Plain(text))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::EvalNurbs { curve, surface } => {
                let points = match (curve, surface) {
                    (Some(curve), None) => {
                        super::shape::eval_nurbs_curve_points(&curve).map_err(Failure::Message)?
                    }
                    (None, Some(surface)) => {
                        super::shape::eval_nurbs_surface_points(&surface).map_err(Failure::Message)?
                    }
                    _ => {
                        return Err(Failure::Message(
                            "evalNurbs takes either a curve or a surface.".into(),
                        ))
                    }
                };
                Ok(Answer::Plain(json!({ "points": points }).to_string()))
            }
            // --- A5. Edges step `node` made, found on the solid the tree is showing. ---
            Request::StepEdges { key, node, filter } => self.step_edge_indexes(key, node, filter),
            // K4: the face's loops, read from the solid the node already holds.
            Request::FaceLoops { key, node, face } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let found = resolve_one_face(shape, face).map_err(Failure::Message)?;
                let mut body = shape.face_loops(found.index).map_err(Failure::Message)?;
                if let Some(fields) = body.as_object_mut() {
                    fields.insert("id".into(), json!(node));
                    fields.insert("face".into(), json!(found.index));
                }
                Ok(Answer::Plain(body.to_string()))
            }
            // --- Organic surfaces S1: lazy surface inspection (curvatures, isoparms, continuity, NURBS health).
            Request::SurfaceInspect {
                key,
                node,
                chord_mm,
                curvature,
                isoparms,
                iso_count,
            } => {
                self.ensure(&key, node)?;
                // With meshQuality "display" the per-vertex buffers describe the display mesh: they match the reply's
                // `display.positions` corner for corner (tests/surface_inspect.rs). Without it, the plate mesh.
                let display = self.display;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let text = shape.surface_inspect(node, chord_mm, curvature, isoparms, iso_count, display)?;
                Ok(Answer::Plain(text))
            }
            Request::SurfaceAt { key, node, rays } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let text = shape.surface_at(&rays).map_err(Failure::Message)?;
                Ok(Answer::Plain(text))
            }
            // --- I5, I6: read from the solid the node already holds.
            Request::FaceOutline { key, node, face, inset_mm, chord_mm, frame } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let found = resolve_one_face(shape, face).map_err(Failure::Message)?;
                let mut body = shape
                    .face_region(found.index, frame.as_ref(), inset_mm, chord_mm)
                    .map_err(Failure::Message)?;
                if let Some(fields) = body.as_object_mut() {
                    fields.insert("id".into(), json!(node));
                    fields.insert("face".into(), json!(found.index));
                }
                Ok(Answer::Plain(body.to_string()))
            }
            Request::Section { key, node, origin, normal, frame, chord_mm } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                // A damaged solid stops at the deadline with a sentence instead of holding the engine for minutes.
                let _budget = SectionBudget::start();
                let mut body = shape.section(origin, normal, &frame, chord_mm).map_err(Failure::Message)?;
                if let Some(fields) = body.as_object_mut() {
                    fields.insert("id".into(), json!(node));
                }
                Ok(Answer::Plain(body.to_string()))
            }
            #[cfg(lime_occt_test_hooks)]
            Request::TestFault { key, node } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                Err(Failure::Message(shape.test_fault()))
            }
            Request::Export {
                key,
                node,
                format,
                pieces,
                names,
                poses,
                assembly,
            } if !pieces.is_empty() || !poses.is_empty() || assembly.is_some() => {
                if format != ExportFormat::Step {
                    return Err(Failure::Message(
                        "A split to print's pieces export as STEP".into(),
                    ));
                }
                let all: Vec<(String, NodeId)> = std::iter::once((key, node))
                    .chain(pieces.into_iter().map(|at| (at.key, at.node)))
                    .collect();
                if names.len() != all.len() {
                    return Err(Failure::Message(format!(
                        "A STEP file of {} pieces needs a name for each, and {} came.",
                        all.len(),
                        names.len()
                    )));
                }
                if !poses.is_empty() && poses.len() != all.len() {
                    return Err(Failure::Message(format!(
                        "A STEP file of {} parts needs a pose for each, and {} came.",
                        all.len(),
                        poses.len()
                    )));
                }
                let mut places = Vec::with_capacity(12 * poses.len());
                for pose in &poses {
                    places.extend(pose.placement().map_err(Failure::Message)?);
                }
                // A piece whose tree this engine does not hold (a restarted engine, or a part from a project that
                // Model has not opened yet) is named as a tool to open, as a join's tool is. Missing([ROOT]) would
                // read as the exported tree itself gone, and the client would reopen the wrong tree.
                for (piece, at) in all.iter().skip(1) {
                    if !self.docs.contains_key(piece) {
                        return Err(Failure::ToolMissing {
                            node: None,
                            key: piece.clone(),
                            step: *at,
                        });
                    }
                }
                for (key, node) in &all {
                    self.ensure(key, *node)?;
                }
                let mut raw = Vec::with_capacity(all.len());
                for (key, node) in &all {
                    raw.push(doc_in(&mut self.docs, key)?.shape(*node).raw());
                }
                let (bytes, part_count) = if let Some(asm) = assembly {
                    if poses.len() != all.len() {
                        return Err(Failure::Message(format!(
                            "A STEP assembly of {} members needs a pose for each, and {} came.",
                            all.len(),
                            poses.len()
                        )));
                    }
                    if asm.parents.len() != all.len() || asm.part_ids.len() != all.len() {
                        return Err(Failure::Message(
                            "Each assembly member needs a parent and part id.".into(),
                        ));
                    }
                    // Pick one representative solid per distinct part index.
                    let num_parts = asm.part_names.len();
                    let mut part_raw: Vec<*const super::ffi::RawShape> = vec![std::ptr::null(); num_parts];
                    for (member_idx, &pid) in asm.part_ids.iter().enumerate() {
                        let Ok(u) = usize::try_from(pid) else {
                            return Err(Failure::Message("Invalid part id in assembly export.".into()));
                        };
                        if u >= num_parts {
                            return Err(Failure::Message("Part id out of range in assembly export.".into()));
                        }
                        if part_raw[u].is_null() {
                            part_raw[u] = raw[member_idx];
                        }
                    }
                    if part_raw.iter().any(|p| p.is_null()) {
                        return Err(Failure::Message("Every distinct part needs at least one member.".into()));
                    }
                    let parse_hex = |s: &str| -> Option<[f64; 3]> {
                        let hex = s.trim().strip_prefix('#')?;
                        if hex.len() != 6 {
                            return None;
                        }
                        let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
                        let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
                        let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
                        Some([f64::from(r) / 255.0, f64::from(g) / 255.0, f64::from(b) / 255.0])
                    };
                    let parsed_colors: Vec<Option<[f64; 3]>> = (0..all.len())
                        .map(|i| asm.colors.get(i).and_then(|s| parse_hex(s)))
                        .collect();
                    let bytes = Shape::step_assembly_bytes_of(
                        &asm.name,
                        &part_raw,
                        &asm.part_names,
                        &names,
                        &asm.parents,
                        &asm.part_ids,
                        &places,
                        &parsed_colors,
                    )
                    .map_err(Failure::Message)?;
                    (bytes, num_parts)
                } else {
                    let bytes = Shape::step_bytes_of(&raw, &names, &places)
                        .map_err(Failure::Message)?;
                    (bytes, raw.len())
                };
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                Ok(Answer::Plain(format!(
                    "{{\"bytesBase64\":\"{encoded}\",\"byteLength\":{},\"format\":\"step\",\"solids\":{},\"parts\":{part_count}}}",
                    bytes.len(),
                    raw.len()
                )))
            }
            Request::Export {
                key, node, format, ..
            } => {
                self.ensure(&key, node)?;
                let shape = doc_in(&mut self.docs, &key)?.shape(node);
                let bytes = match format {
                    ExportFormat::Step => shape.step_bytes(),
                    ExportFormat::Brep => shape.brep_bytes(),
                }
                .map_err(Failure::Message)?;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let format = match format {
                    ExportFormat::Step => "step",
                    ExportFormat::Brep => "brep",
                };
                Ok(Answer::Plain(format!(
                    "{{\"bytesBase64\":\"{encoded}\",\"byteLength\":{},\"format\":\"{format}\"}}",
                    bytes.len()
                )))
            }
        }
    }
}
