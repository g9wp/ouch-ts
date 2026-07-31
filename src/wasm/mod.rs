//! Ouch as a WASM library.
//!
//! This module is only compiled for `wasm32-unknown-unknown` with the `wasm`
//! feature. It reuses the pure-Rust codec backends (`flate2`, `lzma-rust2`,
//! `lz4_flex`, `snap`, `brotli`, `zip`, `tar`, `sevenz-rust2`) behind an
//! in-memory virtual filesystem, so a JS host never touches a real disk.

pub mod archives;
pub mod codecs;
pub mod entry;
pub mod vfs;

pub use entry::OuchWasm;
