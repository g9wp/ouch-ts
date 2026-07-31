//! A tiny in-memory virtual filesystem backing the WASM bindings.
//!
//! Ouch is a CLI that reads and writes real files, but a WASM host (browser
//! or Node) has no such thing. The JS side registers input files here with
//! [`write_file`] and reads outputs back with [`read_file`] / [`walk`]. All
//! paths use `/` as the separator and are relative to a virtual root.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

/// Metadata + contents of a single virtual file or directory.
#[derive(Debug, Clone, Default)]
pub struct VFile {
    /// File contents (empty for directories and symlinks).
    pub data: Vec<u8>,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Symlink target, if [`VFile::is_symlink`].
    pub symlink_target: Option<PathBuf>,
    /// Unix permission bits, best-effort only.
    pub mode: u32,
}

impl VFile {
    fn file(data: Vec<u8>) -> Self {
        Self {
            data,
            is_dir: false,
            is_symlink: false,
            symlink_target: None,
            mode: 0o644,
        }
    }

    fn dir() -> Self {
        Self {
            is_dir: true,
            mode: 0o755,
            ..Default::default()
        }
    }
}

fn vfs() -> &'static Mutex<HashMap<PathBuf, VFile>> {
    static VFS: OnceLock<Mutex<HashMap<PathBuf, VFile>>> = OnceLock::new();
    VFS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Write (or overwrite) a file, creating parent directories implicitly.
pub fn write_file(path: &Path, data: Vec<u8>) {
    let mut vfs = vfs().lock().unwrap();
    vfs.insert(path.to_path_buf(), VFile::file(data));
}

/// Write a symlink entry (its target is stored as metadata, contents are empty).
pub fn write_symlink(path: &Path, target: PathBuf) {
    let mut vfs = vfs().lock().unwrap();
    let mut file = VFile::file(Vec::new());
    file.is_symlink = true;
    file.symlink_target = Some(target);
    file.mode = 0o777;
    vfs.insert(path.to_path_buf(), file);
}

/// Create a directory, including all parents.
pub fn create_dir_all(path: &Path) {
    let mut vfs = vfs().lock().unwrap();
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        vfs.entry(current.clone()).or_insert_with(VFile::dir);
    }
}

pub fn read_file(path: &Path) -> Option<Vec<u8>> {
    vfs()
        .lock()
        .unwrap()
        .get(path)
        .and_then(|f| (!f.is_dir).then(|| f.data.clone()))
}

pub fn metadata(path: &Path) -> Option<VFile> {
    vfs().lock().unwrap().get(path).cloned()
}

/// Like [`metadata`], but also treats paths that are an ancestor of stored
/// files as directories (the VFS stores files flat, without dir entries).
pub fn metadata_or_implicit_dir(path: &Path) -> Option<VFile> {
    if let Some(file) = metadata(path) {
        return Some(file);
    }
    let prefix = format!("{}/", path.to_string_lossy());
    let has_children = vfs()
        .lock()
        .unwrap()
        .keys()
        .any(|p| p.to_string_lossy().starts_with(&prefix));
    has_children.then(VFile::dir)
}

pub fn exists(path: &Path) -> bool {
    vfs().lock().unwrap().contains_key(path)
}

/// Remove a file or directory from the virtual filesystem.
pub fn remove(path: &Path) {
    let mut vfs = vfs().lock().unwrap();
    let path_str = path.to_string_lossy();
    // Remove the node itself and everything underneath it.
    vfs.retain(|p, _| {
        let p_str = p.to_string_lossy();
        p != path && !p_str.starts_with(&format!("{path_str}/"))
    });
}

/// List every path currently stored in the virtual filesystem, sorted.
pub fn list_all() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vfs().lock().unwrap().keys().cloned().collect();
    out.sort();
    out
}

/// List paths stored under `dir` (recursively), sorted.
pub fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vfs()
        .lock()
        .unwrap()
        .keys()
        .filter(|p| p.starts_with(dir))
        .cloned()
        .collect();
    out.sort();
    out
}

/// Remove everything from the virtual filesystem.
pub fn clear() {
    vfs().lock().unwrap().clear();
}
