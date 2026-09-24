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
}
