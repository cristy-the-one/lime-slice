//! The two-grid cycle's smoothing on a GPU, through wgpu.
//!
//! The smoothing is nearly all of an iteration's fine-grid products: two
//! Chebyshev passes of `SMOOTHING_DEGREE` products each, against one product
//! for the conjugate gradients themselves. It runs here in f32, since WGSL
//! has no f64. The conjugate gradients and the coarse correction stay on the
//! CPU in f64, and the CG is the flexible kind, so a preconditioner that
//! rounds in f32 slows it slightly but can't stop it short of its tolerance.
//!
//! One cycle is two submissions: the pre-smoothing and its residual, read
//! back for the coarse correction; then the correction written in, the
//! post-smoothing, and the result read back.

use std::sync::{mpsc, OnceLock};

use wgpu::util::DeviceExt;

use super::{Csr, SMOOTHING_DEGREE};
use crate::error::SimError;

const WORKGROUP: u32 = 256;

const SHADER: &str = r#"
struct Params {
    n: u32,
    step: u32,
    theta: f32,
    pad: u32,
    // (keep, push, 0, 0) for each Chebyshev step.
    coef: array<vec4<f32>, 32>,
}

// Row starts (n + 1), then the column of every value.
@group(0) @binding(0) var<storage, read> rows_cols: array<u32>;
@group(0) @binding(1) var<storage, read> vals: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> x: array<f32>;
@group(0) @binding(4) var<storage, read_write> d: array<f32>;
@group(0) @binding(5) var<storage, read_write> s: array<f32>;
@group(0) @binding(6) var<storage, read> w: array<f32>;
@group(0) @binding(7) var<storage, read_write> e: array<f32>;
@group(0) @binding(8) var<uniform> p: Params;

fn row(id: vec3<u32>, groups: vec3<u32>) -> u32 {
    return id.x + id.y * groups.x * 256u;
}

// s = A x
@compute @workgroup_size(256)
fn product(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    let base = p.n + 1u;
    var sum = 0.0;
    for (var k = rows_cols[i]; k < rows_cols[i + 1u]; k = k + 1u) {
        sum = sum + vals[k] * x[rows_cols[base + k]];
    }
    s[i] = sum;
}

// x = 0, d = D⁻¹ b / θ
@compute @workgroup_size(256)
fn start_zero(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    x[i] = 0.0;
    d[i] = b[i] * w[i] / p.theta;
}

// d = D⁻¹ (b − s) / θ, with s = A x
@compute @workgroup_size(256)
fn start_from(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    d[i] = (b[i] - s[i]) * w[i] / p.theta;
}

// x += d
@compute @workgroup_size(256)
fn step_x(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    x[i] = x[i] + d[i];
}

// d = keep d + push D⁻¹ (b − s), with s = A x
@compute @workgroup_size(256)
fn step_d(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    let c = p.coef[p.step];
    d[i] = c.x * d[i] + c.y * (b[i] - s[i]) * w[i];
}

// e = b − s, with s = A x: the residual the coarse grid corrects
@compute @workgroup_size(256)
fn residual(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    e[i] = b[i] - s[i];
}

// x += e: the coarse correction
@compute @workgroup_size(256)
fn correct(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) g: vec3<u32>) {
    let i = row(id, g);
    if (i >= p.n) { return; }
    x[i] = x[i] + e[i];
}
"#;

/// The fine matrix, its diagonal and the smoothing's vectors on a GPU.
pub(super) struct GpuSmoother {
    device: wgpu::Device,
    queue: wgpu::Queue,
    n: usize,
    groups: (u32, u32),
    b: wgpu::Buffer,
    x: wgpu::Buffer,
    e: wgpu::Buffer,
    readback: wgpu::Buffer,
    /// One bind group per Chebyshev step: they differ only in the step.
    binds: Vec<wgpu::BindGroup>,
    pipes: Pipes,
    /// The adapter's name, for the note.
    pub name: String,
}

struct Pipes {
    product: wgpu::ComputePipeline,
    start_zero: wgpu::ComputePipeline,
    start_from: wgpu::ComputePipeline,
    step_x: wgpu::ComputePipeline,
    step_d: wgpu::ComputePipeline,
    residual: wgpu::ComputePipeline,
    correct: wgpu::ComputePipeline,
}

impl GpuSmoother {
    /// The matrix on this process's GPU, or `None` when there is no adapter
    /// or it can't hold the matrix.
    pub(super) fn new(a: &Csr, inv_diag: &[f64], lambda: (f64, f64)) -> Option<Self> {
        let n = a.nrows;
        let nnz = a.vals.len();
        if n == 0 || n + 1 + nnz > u32::MAX as usize {
            return None;
        }
        let gpu = context()?;
        let biggest = ((n + 1 + nnz) * 4) as u64;
        if u64::from(gpu.limits.max_storage_buffer_binding_size) < biggest
            || gpu.limits.max_buffer_size < biggest
        {
            return None;
        }
        let (device, queue) = (gpu.device.clone(), gpu.queue.clone());
        let storage = |label, words: usize| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (words * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let rows_cols = storage("rows and columns", n + 1 + nnz);
        let vals = storage("values", nnz);
        let w = storage("inverse diagonal", n);
        let mut at = 0u64;
        upload(&device, &queue, &rows_cols, &mut at, a.row_ptr.iter().map(|&r| r as u32));
        upload(&device, &queue, &rows_cols, &mut at, a.cols.iter().copied());
        upload(&device, &queue, &vals, &mut 0, a.vals.iter().map(|&v| v as f32));
        upload(&device, &queue, &w, &mut 0, inv_diag.iter().map(|&v| v as f32));
        let vector = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (n * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            })
        };
        let (b, x, d, s, e) = (vector("b"), vector("x"), vector("d"), vector("s"), vector("e"));
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (n * 4) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // The Chebyshev recurrence's coefficients, as `TwoLevelPcg::smooth`
        // computes them.
        let (lo, hi) = lambda;
        let theta = 0.5 * (hi + lo);
        let delta = 0.5 * (hi - lo);
        let sigma = theta / delta;
        let mut rho = 1.0 / sigma;
        let mut coef = [[0.0f32; 4]; 32];
        for c in coef.iter_mut().take(SMOOTHING_DEGREE) {
            let rho_next = 1.0 / (2.0 * sigma - rho);
            *c = [(rho_next * rho) as f32, (2.0 * rho_next / delta) as f32, 0.0, 0.0];
            rho = rho_next;
        }

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("smoothing"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let entry = |binding, read_only: Option<bool>| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: match read_only {
                Some(read_only) => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Storage { read_only },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                None => wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("smoothing"),
            entries: &[
                entry(0, Some(true)),
                entry(1, Some(true)),
                entry(2, Some(true)),
                entry(3, Some(false)),
                entry(4, Some(false)),
                entry(5, Some(false)),
                entry(6, Some(true)),
                entry(7, Some(false)),
                entry(8, None),
            ],
        });
        let binds = (0..SMOOTHING_DEGREE.max(1))
            .map(|step| {
                let mut params: Vec<u8> = Vec::with_capacity(16 + 32 * 16);
                params.extend_from_slice(&(n as u32).to_le_bytes());
                params.extend_from_slice(&(step as u32).to_le_bytes());
                params.extend_from_slice(&(theta as f32).to_le_bytes());
                params.extend_from_slice(&0u32.to_le_bytes());
                for c in &coef {
                    for v in c {
                        params.extend_from_slice(&v.to_le_bytes());
                    }
                }
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("params"),
                    contents: &params,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let buffers = [&rows_cols, &vals, &b, &x, &d, &s, &w, &e, &uniform];
                let entries: Vec<wgpu::BindGroupEntry> = buffers
                    .iter()
                    .enumerate()
                    .map(|(i, buffer)| wgpu::BindGroupEntry {
                        binding: i as u32,
                        resource: buffer.as_entire_binding(),
                    })
                    .collect();
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("smoothing"),
                    layout: &layout,
                    entries: &entries,
                })
            })
            .collect();
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("smoothing"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipe = |name: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let pipes = Pipes {
            product: pipe("product"),
            start_zero: pipe("start_zero"),
            start_from: pipe("start_from"),
            step_x: pipe("step_x"),
            step_d: pipe("step_d"),
            residual: pipe("residual"),
            correct: pipe("correct"),
        };
        let total = (n as u32).div_ceil(WORKGROUP);
        let groups = if total <= 65_535 {
            (total, 1)
        } else {
            (65_535, total.div_ceil(65_535))
        };
        Some(Self {
            device,
            queue,
            n,
            groups,
            b,
            x,
            e,
            readback,
            binds,
            pipes,
            name: gpu.name.clone(),
        })
    }

    /// One two-grid cycle: smooth `A z = r` from zero, hand the residual to
    /// `coarse` for its correction, add it, smooth again, and return `z`.
    pub(super) fn cycle(
        &self,
        r: &[f64],
        z: &mut [f64],
        coarse: impl FnOnce(&[f64]) -> Result<Vec<f64>, SimError>,
    ) -> Result<(), SimError> {
        let r32: Vec<f32> = r.iter().map(|&v| v as f32).collect();
        self.queue.write_buffer(&self.b, 0, as_bytes(&r32));
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            self.run(&mut pass, &self.pipes.start_zero, 0);
            self.smooth(&mut pass);
            self.run(&mut pass, &self.pipes.product, 0);
            self.run(&mut pass, &self.pipes.residual, 0);
        }
        let residual = self.read(encoder, &self.e)?;
        let correction = coarse(&residual)?;
        let e32: Vec<f32> = correction.iter().map(|&v| v as f32).collect();
        self.queue.write_buffer(&self.e, 0, as_bytes(&e32));
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            self.run(&mut pass, &self.pipes.correct, 0);
            self.run(&mut pass, &self.pipes.product, 0);
            self.run(&mut pass, &self.pipes.start_from, 0);
            self.smooth(&mut pass);
        }
        let out = self.read(encoder, &self.x)?;
        z.copy_from_slice(&out);
        Ok(())
    }

    /// The Chebyshev steps after `d` is set: `x += d`, then `s = A x` and the
    /// next `d`, `SMOOTHING_DEGREE` times.
    fn smooth(&self, pass: &mut wgpu::ComputePass) {
        for step in 0..SMOOTHING_DEGREE {
            self.run(pass, &self.pipes.step_x, step);
            if step + 1 == SMOOTHING_DEGREE {
                break;
            }
            self.run(pass, &self.pipes.product, step);
            self.run(pass, &self.pipes.step_d, step);
        }
    }

    fn run(&self, pass: &mut wgpu::ComputePass, pipe: &wgpu::ComputePipeline, step: usize) {
        pass.set_pipeline(pipe);
        pass.set_bind_group(0, &self.binds[step], &[]);
        pass.dispatch_workgroups(self.groups.0, self.groups.1, 1);
    }

    /// Submit `encoder` with a copy of `from` behind it, and read it back.
    fn read(&self, mut encoder: wgpu::CommandEncoder, from: &wgpu::Buffer) -> Result<Vec<f64>, SimError> {
        let bytes = (self.n * 4) as u64;
        encoder.copy_buffer_to_buffer(from, 0, &self.readback, 0, bytes);
        self.queue.submit(Some(encoder.finish()));
        let slice = self.readback.slice(..);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |done| {
            let _ = tx.send(done);
        });
        let lost = || SimError::new("The GPU stopped answering during the iterative solve.");
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|_| lost())?;
        rx.recv().map_err(|_| lost())?.map_err(|_| lost())?;
        let out = {
            let data = slice.get_mapped_range();
            data.chunks_exact(4)
                .map(|c| f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]])))
                .collect()
        };
        self.readback.unmap();
        Ok(out)
    }
}

/// This process's GPU, opened once: opening one takes about a second (DX12)
/// to three (Vulkan), which a study shouldn't pay twice.
struct Context {
    device: wgpu::Device,
    queue: wgpu::Queue,
    limits: wgpu::Limits,
    name: String,
}

static CONTEXT: OnceLock<Option<Context>> = OnceLock::new();

/// Open the GPU on another thread, so it is ready by the time a study's
/// second cell size needs it.
pub(super) fn warm_up() {
    if CONTEXT.get().is_none() {
        std::thread::spawn(|| {
            context();
        });
    }
}

pub(super) fn available() -> bool {
    context().is_some()
}

fn context() -> Option<&'static Context> {
    CONTEXT.get_or_init(open).as_ref()
}

fn open() -> Option<Context> {
    // DX12 opens in a third of Vulkan's time on Windows.
    let backends = if cfg!(windows) {
        wgpu::Backends::DX12
    } else {
        wgpu::Backends::PRIMARY
    };
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends,
        ..wgpu::InstanceDescriptor::from_env_or_default()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .ok()?;
    let info = adapter.get_info();
    let have = adapter.limits();
    if info.device_type == wgpu::DeviceType::Cpu || have.max_storage_buffers_per_shader_stage < 8 {
        return None;
    }
    let limits = wgpu::Limits {
        max_storage_buffers_per_shader_stage: 8,
        max_storage_buffer_binding_size: have.max_storage_buffer_binding_size,
        max_buffer_size: have.max_buffer_size,
        ..wgpu::Limits::downlevel_defaults()
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("lime-sim smoothing"),
        required_limits: limits.clone(),
        ..Default::default()
    }))
    .ok()?;
    Some(Context {
        device,
        queue,
        limits,
        name: info.name,
    })
}

/// Write `values` into `buffer` from word `at` on, 64 MB at a time, waiting
/// for each, so the host never holds a whole copy of the matrix.
fn upload<T: Copy>(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    buffer: &wgpu::Buffer,
    at: &mut u64,
    values: impl Iterator<Item = T>,
) {
    const CHUNK: usize = 16 << 20;
    let mut chunk: Vec<T> = Vec::with_capacity(CHUNK);
    let flush = |chunk: &mut Vec<T>, at: &mut u64| {
        queue.write_buffer(buffer, *at * 4, as_bytes(chunk));
        queue.submit(None);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        *at += chunk.len() as u64;
        chunk.clear();
    };
    for v in values {
        chunk.push(v);
        if chunk.len() == CHUNK {
            flush(&mut chunk, at);
        }
    }
    if !chunk.is_empty() {
        flush(&mut chunk, at);
    }
}

/// The bytes of a slice of plain numbers, as a buffer takes them.
fn as_bytes<T: Copy>(values: &[T]) -> &[u8] {
    // SAFETY: f32 and u32 have no padding and every bit pattern is a valid
    // byte; the slice is read only for as long as `values` is borrowed.
    unsafe { std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values)) }
}
