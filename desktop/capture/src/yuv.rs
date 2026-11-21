//! Converting the camera's own YUV formats to RGB, only for the frames that are checked.
//!
//! Cameras send YUY2 or NV12. Letting Media Foundation convert every frame to RGB costs CPU on
//! frames that are thrown away (the check takes 2 of the 15 to 30 a second), so the newest frame
//! is converted here instead, when asked. BT.601 limited range, the webcam standard.

#[inline]
fn px(y: i32, u: i32, v: i32) -> [u8; 3] {
    // Fixed point (x 1024) of R = 1.164(Y-16) + 1.596V', G = 1.164(Y-16) - 0.392U' - 0.813V',
    // B = 1.164(Y-16) + 2.017U'.
    let c = (y - 16).max(0) * 1192;
    let (d, e) = (u - 128, v - 128);
    let clamp = |x: i32| ((x + 512) >> 10).clamp(0, 255) as u8;
    [clamp(c + 1634 * e), clamp(c - 401 * d - 833 * e), clamp(c + 2066 * d)]
}

/// YUY2: each 4 bytes hold two pixels as Y0 U Y1 V. `pitch` is bytes per row.
pub fn yuy2_to_rgb(src: &[u8], pitch: usize, w: usize, h: usize) -> Option<Vec<u8>> {
    if h == 0 || !w.is_multiple_of(2) || pitch < w * 2 || src.len() < pitch * (h - 1) + w * 2 {
        return None;
    }
    let mut out = vec![0u8; w * h * 3];
    for y in 0..h {
        let row = &src[y * pitch..y * pitch + w * 2];
        let o = &mut out[y * w * 3..(y + 1) * w * 3];
        for (q, dst) in row.chunks_exact(4).zip(o.chunks_exact_mut(6)) {
            let (u, v) = (q[1] as i32, q[3] as i32);
            dst[..3].copy_from_slice(&px(q[0] as i32, u, v));
            dst[3..].copy_from_slice(&px(q[2] as i32, u, v));
        }
    }
    Some(out)
}

/// NV12: a full-size Y plane, then a half-size plane of interleaved U V, both `pitch` wide.
pub fn nv12_to_rgb(src: &[u8], pitch: usize, w: usize, h: usize) -> Option<Vec<u8>> {
    if h == 0 || !w.is_multiple_of(2) || !h.is_multiple_of(2) || pitch < w || src.len() < pitch * h + pitch * (h / 2 - 1) + w {
        return None;
    }
    let (luma, chroma) = src.split_at(pitch * h);
    let mut out = vec![0u8; w * h * 3];
    for y in 0..h {
        let yr = &luma[y * pitch..y * pitch + w];
        let cr = &chroma[(y / 2) * pitch..(y / 2) * pitch + w];
        let o = &mut out[y * w * 3..(y + 1) * w * 3];
        for x in 0..w {
            let (u, v) = (cr[x & !1] as i32, cr[(x & !1) + 1] as i32);
            o[x * 3..x * 3 + 3].copy_from_slice(&px(yr[x] as i32, u, v));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: [u8; 3], b: [u8; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 2)
    }

    #[test]
    fn known_colours() {
        assert!(close(px(16, 128, 128), [0, 0, 0]));
        assert!(close(px(235, 128, 128), [255, 255, 255]));
        assert!(close(px(81, 90, 240), [255, 0, 0]));
        assert!(close(px(145, 54, 34), [0, 255, 0]));
        assert!(close(px(41, 240, 110), [0, 0, 255]));
    }

    #[test]
    fn yuy2_rows_and_padding() {
        // 2x2, red then blue on each row, rows padded to 6 bytes.
        let row = [81u8, 90, 41, 240, 0, 0];
        let src: Vec<u8> = row.iter().chain(row.iter()).copied().collect();
        let rgb = yuy2_to_rgb(&src, 6, 2, 2).unwrap();
        assert_eq!(rgb.len(), 12);
        // Shared U/V in a pair blends the two colours: just check luma order (left darker... brighter red).
        assert!(rgb[0] > rgb[2], "left pixel reddish: {:?}", &rgb[..6]);
        assert!(yuy2_to_rgb(&src, 6, 3, 2).is_none(), "odd width");
    }

    #[test]
    fn nv12_planes() {
        // 2x2 all green: Y plane then one U V pair, pitch 2.
        let src = [145u8, 145, 145, 145, 54, 34];
        let rgb = nv12_to_rgb(&src, 2, 2, 2).unwrap();
        for p in rgb.chunks_exact(3) {
            assert!(close([p[0], p[1], p[2]], [0, 255, 0]), "{p:?}");
        }
        assert!(nv12_to_rgb(&src[..5], 2, 2, 2).is_none(), "too short");
    }
}
