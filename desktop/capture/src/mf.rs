//! The Media Foundation side: listing cameras and reading frames with a source reader.
//! Everything here runs on the thread that opened the camera.

use super::{CameraInfo, CaptureError, Frame};
use std::sync::Once;
use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

const STREAM: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

impl From<windows::core::Error> for CaptureError {
    fn from(e: windows::core::Error) -> Self {
        CaptureError::Other(e.message().to_string())
    }
}

fn init() -> Result<(), CaptureError> {
    static STARTUP: Once = Once::new();
    // Each thread that touches the camera joins the multithreaded COM apartment. "Already
    // joined" answers are fine.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let mut result = Ok(());
    STARTUP.call_once(|| unsafe {
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            result = Err(CaptureError::Other(format!("Media Foundation didn't start: {}", e.message())));
        }
    });
    result
}

fn attributes(n: u32) -> Result<IMFAttributes, CaptureError> {
    let mut a: Option<IMFAttributes> = None;
    unsafe { MFCreateAttributes(&mut a, n)? };
    a.ok_or_else(|| CaptureError::Other("no attribute store".into()))
}

fn string(a: &IMFActivate, key: &windows::core::GUID) -> Option<String> {
    let mut p = PWSTR::null();
    let mut len = 0u32;
    unsafe {
        a.GetAllocatedString(key, &mut p, &mut len).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// Every video camera Windows can see, in its own order.
pub fn list() -> Result<Vec<CameraInfo>, CaptureError> {
    init()?;
    let attrs = attributes(1)?;
    let mut out = Vec::new();
    unsafe {
        attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)?;
        let mut devices: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFEnumDeviceSources(&attrs, &mut devices, &mut count)?;
        if !devices.is_null() {
            for slot in std::slice::from_raw_parts_mut(devices, count as usize) {
                // take() releases each device object once it has been read.
                if let Some(a) = slot.take() {
                    if let (Some(name), Some(id)) = (string(&a, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME), string(&a, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK)) {
                        out.push(CameraInfo { name, id });
                    }
                }
            }
            CoTaskMemFree(Some(devices as *const _));
        }
    }
    Ok(out)
}

/// An open camera. Dropping it releases the camera, so its light goes off.
pub struct Camera {
    source: IMFMediaSource,
    reader: IMFSourceReader,
    width: u32,
    height: u32,
    stride: i32,
    latest: Option<IMFSample>,
}

/// Shuts the camera down from another thread, which also wakes a read that is waiting for a
/// frame that will never come.
pub struct Shutdown(IMFMediaSource);

// Media sources live in the multithreaded apartment, and Shutdown may be called from any thread.
unsafe impl Send for Shutdown {}

impl crate::Stopper for Shutdown {
    fn stop(&self) {
        unsafe {
            let _ = self.0.Shutdown();
        }
    }
}

fn split(v: u64) -> (u32, u32) {
    ((v >> 32) as u32, v as u32)
}

impl Camera {
    /// Opens a camera by id and picks its mode closest to `width` x `height`, preferring at
    /// least 15 frames a second and formats that are cheap to convert (not MJPEG).
    pub fn open(id: &str, width: u32, height: u32) -> Result<Camera, CaptureError> {
        init()?;
        if !list()?.iter().any(|c| c.id == id) {
            return Err(CaptureError::NotFound);
        }
        unsafe {
            let attrs = attributes(2)?;
            attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)?;
            attrs.SetString(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &HSTRING::from(id))?;
            let source = MFCreateDeviceSource(&attrs).map_err(|e| CaptureError::Busy(e.message().to_string()))?;

            let rattrs = attributes(1)?;
            // Lets the reader convert the camera's own format to RGB for us.
            rattrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
            let reader = match MFCreateSourceReaderFromMediaSource(&source, &rattrs) {
                Ok(r) => r,
                Err(e) => {
                    let _ = source.Shutdown();
                    return Err(CaptureError::Busy(e.message().to_string()));
                }
            };
            let mut cam = Camera { source, reader, width: 0, height: 0, stride: 0, latest: None };
            cam.configure(width, height)?;
            Ok(cam)
        }
    }

    unsafe fn configure(&mut self, want_w: u32, want_h: u32) -> Result<(), CaptureError> {
        let r = &self.reader;
        r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        r.SetStreamSelection(STREAM, true)?;

        // Score every mode the camera offers; lower is better.
        let want = (want_w * want_h) as f64;
        let mut best: Option<(f64, IMFMediaType)> = None;
        let mut i = 0;
        while let Ok(t) = r.GetNativeMediaType(STREAM, i) {
            i += 1;
            let Ok(size) = t.GetUINT64(&MF_MT_FRAME_SIZE) else { continue };
            let (w, h) = split(size);
            let fps = t.GetUINT64(&MF_MT_FRAME_RATE).map(|v| {
                let (n, d) = split(v);
                n as f64 / d.max(1) as f64
            }).ok();
            let sub = t.GetGUID(&MF_MT_SUBTYPE).unwrap_or_default();
            let area = (w * h) as f64;
            let mut score = (area - want).abs() / want;
            if area < want * 0.5 {
                score += 2.0; // too small to see a phone
            }
            if fps.map(|f| f < 14.5).unwrap_or(false) {
                score += 1.0;
            }
            // Every frame is read (see stream.rs), so beyond 15 a second more only costs CPU.
            score += fps.map(|f| ((f - 15.0).max(0.0) / 15.0) * 0.1).unwrap_or(0.0);
            if sub == MFVideoFormat_MJPG {
                score += 0.3; // decoding JPEG costs CPU
            }
            if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
                best = Some((score, t));
            }
        }
        if let Some((_, native)) = &best {
            r.SetCurrentMediaType(STREAM, None, native)?;
        }

        let out = MFCreateMediaType()?;
        out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        r.SetCurrentMediaType(STREAM, None, &out)?;
        self.read_size()
    }

    unsafe fn read_size(&mut self) -> Result<(), CaptureError> {
        let t = self.reader.GetCurrentMediaType(STREAM)?;
        let (w, h) = split(t.GetUINT64(&MF_MT_FRAME_SIZE)?);
        self.width = w;
        self.height = h;
        self.stride = t.GetUINT32(&MF_MT_DEFAULT_STRIDE).map(|s| s as i32).unwrap_or((w * 4) as i32);
        Ok(())
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Something that can shut this camera down from another thread.
    pub fn shutdown_handle(&self) -> Shutdown {
        Shutdown(self.source.clone())
    }

    /// Waits for the next frame and returns it as RGB.
    pub fn frame(&mut self) -> Result<Frame, CaptureError> {
        crate::Source::grab(self)?;
        crate::Source::latest(self)
    }
}

impl crate::Source for Camera {
    /// Waits for the next frame and keeps it, without converting it.
    fn grab(&mut self) -> Result<(), CaptureError> {
        unsafe {
            loop {
                let mut flags = 0u32;
                let mut sample: Option<IMFSample> = None;
                self.reader.ReadSample(STREAM, 0, None, Some(&mut flags), None, Some(&mut sample))?;
                if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
                    return Err(CaptureError::Busy("the camera stopped sending pictures".into()));
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return Err(CaptureError::Other("the camera was unplugged".into()));
                }
                if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                    self.read_size()?;
                }
                let Some(sample) = sample else { continue }; // a gap in the stream, not a frame
                self.latest = Some(sample);
                return Ok(());
            }
        }
    }

    fn latest(&self) -> Result<Frame, CaptureError> {
        match &self.latest {
            Some(s) => unsafe { self.convert(s) },
            None => Err(CaptureError::Frozen),
        }
    }
}

impl Camera {

    unsafe fn convert(&self, sample: &IMFSample) -> Result<Frame, CaptureError> {
        let (w, h) = (self.width as usize, self.height as usize);
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut rgb = vec![0u8; w * h * 3];
        // Copies BGRX rows into RGB. `top` is the first row on screen; `pitch` may be negative
        // when the picture is stored bottom-up.
        let copy = |top: *const u8, pitch: isize, rgb: &mut [u8]| {
            for y in 0..h {
                let row = std::slice::from_raw_parts(top.offset(y as isize * pitch), w * 4);
                let out = &mut rgb[y * w * 3..(y + 1) * w * 3];
                for (o, px) in out.chunks_exact_mut(3).zip(row.chunks_exact(4)) {
                    o[0] = px[2];
                    o[1] = px[1];
                    o[2] = px[0];
                }
            }
        };
        if let Ok(b2) = buffer.cast::<IMF2DBuffer>() {
            let mut top = std::ptr::null_mut();
            let mut pitch = 0i32;
            b2.Lock2D(&mut top, &mut pitch)?;
            copy(top, pitch as isize, &mut rgb);
            b2.Unlock2D()?;
        } else {
            let mut p = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut p, None, Some(&mut len))?;
            let stride = self.stride as isize;
            let need = stride.unsigned_abs() * h;
            if (len as usize) < need {
                buffer.Unlock()?;
                return Err(CaptureError::Other("the camera sent a short frame".into()));
            }
            let top = if stride < 0 { p.offset(-stride * (h as isize - 1)) } else { p };
            copy(top, stride, &mut rgb);
            buffer.Unlock()?;
        }
        Ok(Frame { width: self.width, height: self.height, rgb })
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        unsafe {
            let _ = self.source.Shutdown();
        }
    }
}
