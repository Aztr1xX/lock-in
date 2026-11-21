//! What the computer is, and how much CPU time this process has used.

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Machine {
    pub cpu: String,
    pub threads: usize,
    pub gpus: Vec<String>,
}

pub fn describe() -> Machine {
    Machine {
        cpu: cpu_name().unwrap_or_else(|| "unknown CPU".into()),
        threads: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        gpus: gpus(),
    }
}

/// CPU time this process has used so far (all threads, user plus kernel), in milliseconds.
#[cfg(windows)]
pub fn cpu_ms() -> f64 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let (mut a, mut b, mut k, mut u) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe {
        if GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u).is_err() {
            return 0.0;
        }
    }
    let t =
        |f: FILETIME| ((f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64) as f64 / 10_000.0;
    t(k) + t(u)
}

#[cfg(unix)]
pub fn cpu_ms() -> f64 {
    let mut r: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut r) } != 0 {
        return 0.0;
    }
    let t = |v: libc::timeval| v.tv_sec as f64 * 1000.0 + v.tv_usec as f64 / 1000.0;
    t(r.ru_utime) + t(r.ru_stime)
}

#[cfg(windows)]
fn cpu_name() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let mut buf = [0u16; 256];
    let mut len = (buf.len() * 2) as u32;
    let r = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"),
            w!("ProcessorNameString"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if r.is_err() {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]).trim().to_string())
}

#[cfg(unix)]
fn cpu_name() -> Option<String> {
    let info = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    info.lines()
        .find(|l| l.starts_with("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim().to_string())
}

/// Names of the graphics chips Windows knows about, in its own order.
#[cfg(windows)]
fn gpus() -> Vec<String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let mut names = Vec::new();
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return names;
    };
    let mut i = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            let n = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            names.push(String::from_utf16_lossy(&desc.Description[..n]));
        }
        i += 1;
    }
    names
}

#[cfg(unix)]
fn gpus() -> Vec<String> {
    Vec::new()
}
