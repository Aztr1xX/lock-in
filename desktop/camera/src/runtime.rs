//! Loading ONNX Runtime and opening a model on the CPU or the graphics chip.

use ort::ep;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Where a model runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Engine {
    /// One CPU thread: the honest cost in "share of one core".
    Cpu1,
    /// All CPU cores, ONNX Runtime's default: the fastest answer on a CPU.
    Cpu,
    /// DirectML on the fastest graphics chip.
    Gpu,
    /// DirectML on the most power-saving graphics chip (the built-in one on a laptop).
    GpuLow,
}

impl Engine {
    pub const ALL: [Engine; 4] = [Engine::Cpu1, Engine::Cpu, Engine::Gpu, Engine::GpuLow];

    pub fn key(self) -> &'static str {
        match self {
            Engine::Cpu1 => "cpu1",
            Engine::Cpu => "cpu",
            Engine::Gpu => "gpu",
            Engine::GpuLow => "gpu-low",
        }
    }

    pub fn from_key(s: &str) -> Option<Engine> {
        Engine::ALL.into_iter().find(|e| e.key() == s)
    }

    pub fn is_gpu(self) -> bool {
        matches!(self, Engine::Gpu | Engine::GpuLow)
    }

    pub fn describe(self) -> &'static str {
        match self {
            Engine::Cpu1 => "one CPU core",
            Engine::Cpu => "all CPU cores",
            Engine::Gpu => "the graphics chip",
            Engine::GpuLow => "the power-saving graphics chip",
        }
    }
}

/// Finds a file shipped next to this exe (or given on the command line).
pub fn beside_exe(name: &str) -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(name))).unwrap_or_else(|| PathBuf::from(name))
}

/// Loads ONNX Runtime from the DLL shipped with the app, never one found elsewhere on the PC
/// (Windows ships its own copies of onnxruntime.dll and DirectML.dll in System32).
pub fn load(ort_path: Option<&Path>) -> Result<ort::environment::Environment, String> {
    let default = beside_exe(if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so" });
    let path = ort_path.map(Path::to_path_buf).unwrap_or(default);
    if !path.exists() {
        return Err(format!("ONNX Runtime is missing ({})", path.display()));
    }
    if cfg!(windows) {
        // Loading DirectML by full path first makes onnxruntime.dll use this copy.
        let dml = path.with_file_name("DirectML.dll");
        if dml.exists() {
            let _ = ort::util::preload_dylib(&dml);
        }
    }
    let builder = ort::init_from(&path).map_err(|e| format!("could not load ONNX Runtime: {e}"))?;
    builder.with_name("lockin-camera").build().map_err(|e| format!("could not start ONNX Runtime: {e}"))
}

/// Opens one model on one engine. Fails (instead of quietly falling back to the CPU) if the
/// graphics chip can't be used, so a "GPU" number is always a real GPU number.
pub fn open(env: &ort::environment::Environment, model: &Path, engine: Engine) -> Result<Session, String> {
    let err = |e: ort::Error<ort::session::builder::SessionBuilder>| e.to_string();
    let mut b = Session::builder(env)
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(err)?
        // Two checks a second leave the threads idle most of the time; spinning while idle
        // would burn a core for nothing.
        .with_intra_op_spinning(false)
        .map_err(err)?
        .with_inter_op_spinning(false)
        .map_err(err)?;
    b = match engine {
        Engine::Cpu1 => b.with_intra_threads(1).map_err(err)?,
        Engine::Cpu => b,
        Engine::Gpu | Engine::GpuLow => {
            let pref = if engine == Engine::Gpu {
                ep::directml::PerformancePreference::HighPerformance
            } else {
                ep::directml::PerformancePreference::MinimumPower
            };
            let dml = ep::DirectML::default().with_performance_preference(pref).build().error_on_failure();
            b.with_memory_pattern(false)
                .map_err(err)?
                .with_parallel_execution(false)
                .map_err(err)?
                .with_execution_providers([dml])
                .map_err(err)?
        }
    };
    b.commit_from_file(model).map_err(|e| e.to_string())
}
