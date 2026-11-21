//! The live camera check (camera plan, step 2).
//!
//! The app's process reads the camera (lockin-capture), hands each frame through a pipe to the
//! camera worker running in its sandbox (lockin-camera inside lockin-sandbox), and turns the
//! worker's answers into here, away, phone and camera-health states with the rules below.
//! Frames are only ever in memory.

pub mod clips;
pub mod peek;
pub mod rules;
pub mod session;
pub mod worker;
