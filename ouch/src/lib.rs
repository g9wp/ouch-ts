//! Ouch, as a library.
//!
//! The native CLI (`src/main.rs`) and the WASM bindings (`src/wasm`) share
//! this crate root. The CLI-only modules (`commands`, `cli`, `sandbox`,
//! `check`, `archive`) are gated behind the `cli` feature so that a WASM
//! build (`--no-default-features --features wasm`) only pulls in the
//! pure-Rust codecs and bindings.

pub mod accessible;
pub mod error;
pub mod extension;
pub mod list;
pub mod non_archive;
pub mod utils;

#[cfg(feature = "cli")]
pub mod archive;
#[cfg(feature = "cli")]
pub mod check;
#[cfg(feature = "cli")]
pub mod cli;
#[cfg(feature = "cli")]
pub mod commands;
#[cfg(feature = "cli")]
pub mod sandbox;

#[cfg(all(target_family = "wasm", feature = "wasm"))]
pub mod wasm;

use std::{env, path::PathBuf, sync::LazyLock};

#[cfg(feature = "cli")]
use self::cli::CliArgs;
pub use self::error::{Error, FinalError, Result};
#[cfg(feature = "cli")]
use self::utils::QuestionAction;
use self::utils::QuestionPolicy;
/// Size of the buffers used when (de)compressing streams.
pub const BUFFER_CAPACITY: usize = 1024 * 32;

/// Current directory, canonicalized for consistent path comparisons across platforms.
///
/// On WASM there is no working directory, so this falls back to the virtual root.
static INITIAL_CURRENT_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    let Ok(dir) = env::current_dir() else {
        return PathBuf::from("/");
    };
    utils::canonicalize(&dir).unwrap_or(dir)
});
