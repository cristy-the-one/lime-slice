/// Triangle soup in millimeters. Z-up, right-handed.
#[derive(Clone, Debug)]
pub struct Mesh {
    pub triangles: Vec<[[f64; 3]; 3]>,
}

impl Mesh {
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }

    pub fn bounds(&self) -> Option<([f64; 3], [f64; 3])> {
        let mut iter = self.triangles.iter().flat_map(|t| t.iter());
        let first = *iter.next()?;
        let mut min = first;
        let mut max = first;
        for v in iter {
            for i in 0..3 {
                min[i] = min[i].min(v[i]);
                max[i] = max[i].max(v[i]);
            }
        }
        Some((min, max))
    }

    /// Drop the model onto the bed so the lowest vertex sits at Z = 0.
    pub fn settle_on_bed(&mut self) {
        let Some((min, _)) = self.bounds() else {
            return;
        };
        if min[2].abs() < 1e-9 {
            return;
        }
        for tri in &mut self.triangles {
            for v in tri.iter_mut() {
                v[2] -= min[2];
            }
        }
    }

    /// `placed = R * (v - pivot) + translation`. `rotation` is row-major.
    ///
    /// Scale stays in the vertex positions. This is only a rigid move, so a
    /// nozzle error measured before the call is still the print-space error.
    pub fn rigid_move(&self, rotation: &[f64; 9], pivot: [f64; 3], translation: [f64; 3]) -> Mesh {
        let r = rotation;
        let [px, py, pz] = pivot;
        let [tx, ty, tz] = translation;
        let mut triangles = Vec::with_capacity(self.triangles.len());
        for tri in &self.triangles {
            let mut out = [[0.0; 3]; 3];
            for (slot, v) in out.iter_mut().zip(tri.iter()) {
                let x = v[0] - px;
                let y = v[1] - py;
                let z = v[2] - pz;
                slot[0] = r[0] * x + r[1] * y + r[2] * z + tx;
                slot[1] = r[3] * x + r[4] * y + r[5] * z + ty;
                slot[2] = r[6] * x + r[7] * y + r[8] * z + tz;
            }
            triangles.push(out);
        }
        Mesh { triangles }
    }
}
