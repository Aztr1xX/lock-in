//! Camera capture with Windows Media Foundation.
//!
//! The camera is read by the app's own process instead of its window, because WebView2 slows
//! down and can unload a hidden or minimised window, and a study app spends most of its time
//! minimised. Frames stay in memory: they are handed to the camera worker and dropped.

/// One camera Windows knows about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CameraInfo {
    /// The name people see, like "NVIDIA Broadcast" or "Integrated Camera".
    pub name: String,
    /// Windows' stable id for the device (its symbolic link).
    pub id: String,
}

/// One picture: tightly packed RGB, top row first.
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

impl Frame {
    /// Average brightness, 0 to 255. Used to tell a covered camera or a dark room.
    pub fn brightness(&self) -> f32 {
        let px = self.rgb.chunks_exact(3).step_by(7);
        let (sum, n) = px.fold((0u64, 0u64), |(s, n), p| (s + (p[0] as u64 * 299 + p[1] as u64 * 587 + p[2] as u64 * 114) / 1000, n + 1));
        if n == 0 { 0.0 } else { sum as f32 / n as f32 }
    }

    /// How different two frames are, 0 (identical) to 255. Used to tell a frozen picture.
    pub fn difference(&self, other: &Frame) -> f32 {
        if self.rgb.len() != other.rgb.len() {
            return 255.0;
        }
        let (sum, n) = self.rgb.iter().zip(&other.rgb).step_by(13).fold((0u64, 0u64), |(s, n), (a, b)| (s + a.abs_diff(*b) as u64, n + 1));
        if n == 0 { 0.0 } else { sum as f32 / n as f32 }
    }
}

#[derive(Debug)]
pub enum CaptureError {
    /// No camera with that id is plugged in.
    NotFound,
    /// Another app has the camera to itself, or Windows' privacy settings block it.
    Busy(String),
    Other(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::NotFound => write!(f, "That camera isn't plugged in"),
            CaptureError::Busy(e) => write!(f, "The camera is in use by another app or blocked in Windows privacy settings ({e})"),
            CaptureError::Other(e) => write!(f, "{e}"),
        }
    }
}

#[cfg(windows)]
mod mf;
#[cfg(windows)]
pub use mf::{list, Camera};

#[cfg(not(windows))]
mod other {
    use super::*;
    pub fn list() -> Result<Vec<CameraInfo>, CaptureError> {
        Ok(Vec::new())
    }
    pub struct Camera;
    impl Camera {
        pub fn open(_id: &str, _width: u32, _height: u32) -> Result<Camera, CaptureError> {
            Err(CaptureError::NotFound)
        }
        pub fn frame(&mut self) -> Result<Frame, CaptureError> {
            Err(CaptureError::NotFound)
        }
        pub fn size(&self) -> (u32, u32) {
            (0, 0)
        }
    }
}
#[cfg(not(windows))]
pub use other::{list, Camera};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brightness_and_difference() {
        let black = Frame { width: 2, height: 2, rgb: vec![0; 12] };
        let white = Frame { width: 2, height: 2, rgb: vec![255; 12] };
        assert_eq!(black.brightness(), 0.0);
        assert!((white.brightness() - 255.0).abs() < 1.0);
        assert_eq!(black.difference(&black), 0.0);
        assert_eq!(black.difference(&white), 255.0);
    }
}
