//! wasm-bindgen entry points.
//!
//! Exposes ouch's core (de)compression as a JS library. All file I/O goes
//! through the in-memory virtual filesystem ([`super::vfs`]); the host
//! registers inputs with `vfs_write_file` and reads outputs with
//! `vfs_read_file` / `vfs_list`.

use std::path::{Path, PathBuf};

use wasm_bindgen::prelude::*;

use crate::{
    Result,
    error::FinalError,
    extension::{self, CompressionFormat, split_first_compression_format},
    wasm::{archives, codecs, seekable, vfs},
};

fn js_error(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}

/// Ouch library entry point.
#[wasm_bindgen]
pub struct OuchWasm;

#[wasm_bindgen]
impl OuchWasm {
    /// Ouch version (from Cargo.toml).
    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }

    /// Formats available in this WASM build (pure-Rust codecs only).
    pub fn supported_formats() -> Vec<String> {
        [
            "tar", "zip", "7z", "gz", "xz", "lzma", "lz", "lz4", "sz", "br", "bz2", "zst", "rar",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    // ------------------------------------------------------------------
    // Virtual filesystem management
    // ------------------------------------------------------------------

    /// Write (or overwrite) a file in the virtual filesystem.
    pub fn vfs_write_file(path: &str, data: &[u8]) -> Result<(), JsError> {
        vfs::write_file(Path::new(path), data.to_vec());
        Ok(())
    }

    /// Read a file from the virtual filesystem.
    pub fn vfs_read_file(path: &str) -> Result<Vec<u8>, JsError> {
        vfs::read_file(Path::new(path)).ok_or_else(|| {
            js_error(FinalError::with_title(format!(
                "file not found in virtual filesystem: {path}"
            )))
        })
    }

    /// Check whether a path exists in the virtual filesystem.
    pub fn vfs_exists(path: &str) -> Result<bool, JsError> {
        Ok(vfs::exists(Path::new(path)))
    }

    /// Check whether a path is a directory in the virtual filesystem.
    pub fn vfs_is_dir(path: &str) -> Result<bool, JsError> {
        Ok(vfs::metadata(Path::new(path)).is_some_and(|f| f.is_dir))
    }

    /// List every path in the virtual filesystem (sorted).
    pub fn vfs_list() -> Result<Vec<String>, JsError> {
        Ok(vfs::list_all()
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    }

    /// Remove a path (and everything under it) from the virtual filesystem.
    pub fn vfs_remove(path: &str) -> Result<(), JsError> {
        vfs::remove(Path::new(path));
        Ok(())
    }

    /// Clear the whole virtual filesystem.
    pub fn vfs_clear() -> Result<(), JsError> {
        vfs::clear();
        Ok(())
    }

    // ------------------------------------------------------------------
    // Operations
    // ------------------------------------------------------------------

    /// Compress the given VFS files into `args.output`.
    ///
    /// The output format comes from `args.output`'s extension (e.g.
    /// `out.tar.gz`) unless `args.format` is set.
    pub fn compress(args: CompressArgs) -> Result<JsValue, JsError> {
        run_compress(&args)
            .map_err(js_error)
            .and_then(|(output, output_size, entries)| {
                let obj = js_sys::Object::new();
                js_sys::Reflect::set(&obj, &JsValue::from_str("output"), &JsValue::from_str(&output))
                    .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("output_size"),
                    &JsValue::from_f64(output_size as f64),
                )
                .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                js_sys::Reflect::set(&obj, &JsValue::from_str("entries"), &JsValue::from_f64(entries as f64))
                    .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                Ok(obj.into())
            })
    }

    /// Stream-compress JS-owned files: input bytes are pulled from each file's
    /// `read_at` callback and output chunks are pushed to `on_chunk`, so
    /// neither side ever holds the whole archive in wasm memory. Supports tar
    /// (with stream layers like `tar.gz`) and single-stream formats; zip/7z/
    /// bz2 need the VFS flow (their encoders require seekable or buffered
    /// output).
    pub fn compress_from(
        files: Vec<CompressFileArgs>,
        args: CompressFromArgs,
        on_chunk: js_sys::Function,
    ) -> Result<JsValue, JsError> {
        run_compress_from(&files, &args, on_chunk)
            .map_err(js_error)
            .and_then(|(output, output_size, entries)| {
                let obj = js_sys::Object::new();
                js_sys::Reflect::set(&obj, &JsValue::from_str("output"), &JsValue::from_str(&output))
                    .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("output_size"),
                    &JsValue::from_f64(output_size as f64),
                )
                .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                js_sys::Reflect::set(&obj, &JsValue::from_str("entries"), &JsValue::from_f64(entries as f64))
                    .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                Ok(obj.into())
            })
    }

    /// Decompress the given VFS files.
    ///
    /// Output files are written into the virtual filesystem; the result is
    /// `{ files_unpacked, entries: [{ path, size, is_dir, is_symlink, symlink_target? }] }`.
    pub fn decompress(args: DecompressArgs) -> Result<JsValue, JsError> {
        run_decompress(&args)
            .map_err(js_error)
            .and_then(|(entries, files_unpacked)| {
                let obj = js_sys::Object::new();
                js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("entries"),
                    &JsValue::from(js_sys::Array::from_iter(entries.into_iter().map(entry_to_js))),
                )
                .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                js_sys::Reflect::set(
                    &obj,
                    &JsValue::from_str("files_unpacked"),
                    &JsValue::from_f64(files_unpacked as f64),
                )
                .map_err(|e| JsError::new(&format!("failed to build result: {e:?}")))?;
                Ok(obj.into())
            })
    }

    /// List the contents of the given archives, returning an array of entry
    /// objects: `{ archive, path, size, is_dir, is_symlink, symlink_target? }`.
    pub fn list(args: ListArgs) -> Result<Vec<JsValue>, JsError> {
        run_list(&args).map_err(js_error).map(|entries| {
            entries
                .into_iter()
                .map(|(archive, entry)| {
                    let obj = entry_to_js(entry);
                    js_sys::Reflect::set(&obj, &JsValue::from_str("archive"), &JsValue::from_str(&archive))
                        .expect("setting js object property");
                    obj
                })
                .collect()
        })
    }

    /// Read a single entry's contents from an archive without extracting
    /// everything else (see [`ReadEntryArgs`]).
    pub fn read_entry(args: ReadEntryArgs) -> Result<Vec<u8>, JsError> {
        run_read_entry(&args).map_err(js_error)
    }

    /// Stream one entry's contents out of an archive (or single-file format)
    /// in bounded chunks. `on_chunk` is called once per chunk with a fresh
    /// `Uint8Array`; the call returns after the last chunk.
    pub fn stream_entry(args: StreamEntryArgs, on_chunk: js_sys::Function) -> Result<(), JsError> {
        run_stream_entry(&args, on_chunk).map_err(js_error)
    }

    /// List the contents of an archive held by a JS-side random-access source
    /// (`read_at(offset, length) -> Uint8Array`, `size` bytes total). Only the
    /// metadata blocks are pulled from the host, so the whole archive never
    /// enters wasm memory.
    pub fn seekable_list(
        args: SeekableArgs,
        read_at: js_sys::Function,
        size: f64,
    ) -> Result<Vec<JsValue>, JsError> {
        run_seekable_list(&args, read_at, size as u64).map_err(js_error).map(|entries| {
            entries
                .into_iter()
                .map(|(archive, entry)| {
                    let obj = entry_to_js(entry);
                    js_sys::Reflect::set(&obj, &JsValue::from_str("archive"), &JsValue::from_str(&archive))
                        .expect("setting js object property");
                    obj
                })
                .collect()
        })
    }

    /// Read a single entry from an archive held by a JS-side random-access
    /// source; only that entry's data is pulled from the host.
    pub fn seekable_read_entry(
        args: SeekableArgs,
        read_at: js_sys::Function,
        size: f64,
    ) -> Result<Vec<u8>, JsError> {
        run_seekable_read_entry(&args, read_at, size as u64).map_err(js_error)
    }

    /// Stream one entry from an archive held by a JS-side random-access
    /// source in bounded chunks.
    pub fn seekable_stream_entry(
        args: SeekableArgs,
        read_at: js_sys::Function,
        size: f64,
        on_chunk: js_sys::Function,
    ) -> Result<(), JsError> {
        run_seekable_stream_entry(&args, read_at, size as u64, on_chunk).map_err(js_error)
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// Arguments for [`OuchWasm::compress`].
#[wasm_bindgen]
#[derive(Default)]
pub struct CompressArgs {
    #[wasm_bindgen(skip)]
    pub files: Vec<String>,
    #[wasm_bindgen(skip)]
    pub output: String,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
    #[wasm_bindgen(skip)]
    pub level: Option<i16>,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
}

#[wasm_bindgen]
impl CompressArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(files: Vec<String>, output: String) -> Self {
        Self {
            files,
            output,
            ..Default::default()
        }
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }

    pub fn set_level(&mut self, level: i16) {
        self.level = Some(level);
    }

    /// Enable AES-256 encryption (zip and 7z only).
    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }
}

/// Arguments for [`OuchWasm::compress_from`].
#[wasm_bindgen]
#[derive(Default)]
pub struct CompressFromArgs {
    #[wasm_bindgen(skip)]
    pub output: String,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
    #[wasm_bindgen(skip)]
    pub level: Option<i16>,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
}

#[wasm_bindgen]
impl CompressFromArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(output: String) -> Self {
        Self {
            output,
            ..Default::default()
        }
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }

    pub fn set_level(&mut self, level: i16) {
        self.level = Some(level);
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }
}

/// One input file for [`OuchWasm::compress_from`]: its bytes are pulled from
/// `read_at(offset, length) -> Uint8Array` (exactly `size` bytes).
#[wasm_bindgen]
#[derive(Default)]
pub struct CompressFileArgs {
    #[wasm_bindgen(skip)]
    pub name: String,
    #[wasm_bindgen(skip)]
    pub size: f64,
    #[wasm_bindgen(skip)]
    pub mode: u32,
    #[wasm_bindgen(skip)]
    pub is_dir: bool,
    #[wasm_bindgen(skip)]
    pub read_at: js_sys::Function,
}

#[wasm_bindgen]
impl CompressFileArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, size: f64, read_at: js_sys::Function) -> Self {
        Self {
            name,
            size,
            read_at,
            mode: 0o644,
            ..Default::default()
        }
    }

    pub fn set_mode(&mut self, mode: u32) {
        self.mode = mode;
    }

    pub fn set_dir(&mut self, is_dir: bool) {
        self.is_dir = is_dir;
    }
}

/// Arguments for [`OuchWasm::decompress`].
#[wasm_bindgen]
#[derive(Default)]
pub struct DecompressArgs {
    #[wasm_bindgen(skip)]
    pub files: Vec<String>,
    #[wasm_bindgen(skip)]
    pub output_dir: Option<String>,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
    #[wasm_bindgen(skip)]
    pub overwrite: bool,
}

#[wasm_bindgen]
impl DecompressArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(files: Vec<String>) -> Self {
        Self {
            files,
            overwrite: true, // WASM scenarios default to overwriting
            ..Default::default()
        }
    }

    pub fn set_output_dir(&mut self, dir: String) {
        self.output_dir = Some(dir);
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }

    pub fn set_overwrite(&mut self, overwrite: bool) {
        self.overwrite = overwrite;
    }
}

/// Arguments for [`OuchWasm::list`].
#[wasm_bindgen]
#[derive(Default)]
pub struct ListArgs {
    #[wasm_bindgen(skip)]
    pub archives: Vec<String>,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
}

#[wasm_bindgen]
impl ListArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(archives: Vec<String>) -> Self {
        Self {
            archives,
            ..Default::default()
        }
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }
}

/// Arguments for [`OuchWasm::read_entry`].
#[wasm_bindgen]
#[derive(Default)]
pub struct ReadEntryArgs {
    #[wasm_bindgen(skip)]
    pub archive: String,
    #[wasm_bindgen(skip)]
    pub entry: String,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
}

#[wasm_bindgen]
impl ReadEntryArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(archive: String, entry: String) -> Self {
        Self {
            archive,
            entry,
            ..Default::default()
        }
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }
}

/// Arguments for [`OuchWasm::stream_entry`]. For single-file formats (gz, xz,
/// bz2, ...) `entry` is ignored.
#[wasm_bindgen]
#[derive(Default)]
pub struct StreamEntryArgs {
    #[wasm_bindgen(skip)]
    pub archive: String,
    #[wasm_bindgen(skip)]
    pub entry: String,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
}

#[wasm_bindgen]
impl StreamEntryArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(archive: String, entry: String) -> Self {
        Self {
            archive,
            entry,
            ..Default::default()
        }
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }
}

/// Arguments for the seekable (JS-backed random-access) operations. `name`
/// (e.g. "archive.zip") is used to infer the format; `entry` is ignored by
/// [`OuchWasm::seekable_list`].
#[wasm_bindgen]
#[derive(Default)]
pub struct SeekableArgs {
    #[wasm_bindgen(skip)]
    pub name: String,
    #[wasm_bindgen(skip)]
    pub entry: String,
    #[wasm_bindgen(skip)]
    pub password: Option<String>,
    #[wasm_bindgen(skip)]
    pub format: Option<String>,
}

#[wasm_bindgen]
impl SeekableArgs {
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, entry: String) -> Self {
        Self {
            name,
            entry,
            ..Default::default()
        }
    }

    pub fn set_password(&mut self, password: String) {
        self.password = Some(password);
    }

    pub fn set_format(&mut self, format: String) {
        self.format = Some(format);
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

fn format_from_path_or_flag(path: &str, flag: Option<&str>) -> Result<Vec<extension::Extension>> {
    let formats = if let Some(flag) = flag {
        extension::parse_format_flag(flag)
    } else {
        extension::extensions_from_path(Path::new(path))
    }?;
    if formats.is_empty() {
        return Err(crate::Error::Custom {
            reason: FinalError::with_title(format!("cannot infer a format from '{path}'"))
                .hint("pass `format`, e.g. \"zip\" or \"tar.gz\""),
        });
    }
    Ok(formats)
}

fn read_input(path: &str) -> Result<Vec<u8>> {
    vfs::read_file(Path::new(path)).ok_or_else(|| crate::Error::Custom {
        reason: FinalError::with_title(format!("file not found in virtual filesystem: {path}")),
    })
}

/// Decode every non-archive layer except the first one (in reverse order).
fn decode_layers(bytes: &[u8], formats: &[CompressionFormat]) -> Result<Vec<u8>> {
    let mut out = bytes.to_vec();
    for format in formats.iter().rev() {
        out = codecs::decode(*format, &out)?;
    }
    Ok(out)
}

fn entry_to_js(entry: archives::Entry) -> JsValue {
    let obj = js_sys::Object::new();
    let set = |key: &str, value: JsValue| {
        js_sys::Reflect::set(&obj, &JsValue::from_str(key), &value).expect("setting js object property");
    };
    set("path", JsValue::from_str(&entry.path.to_string_lossy()));
    set("size", JsValue::from_f64(entry.size as f64));
    set("is_dir", JsValue::from_bool(entry.is_dir));
    set("is_symlink", JsValue::from_bool(entry.is_symlink));
    if let Some(target) = &entry.symlink_target {
        set("symlink_target", JsValue::from_str(&target.to_string_lossy()));
    }
    obj.into()
}

/// Collect the VFS entries for a set of input paths (mirrors ouch: archives
/// store paths relative to each input's parent directory, keeping the
/// top-level name for directories).
fn collect_input_entries(inputs: &[String]) -> Result<Vec<archives::Entry>> {
    let mut entries = Vec::new();
    for input in inputs {
        let root = Path::new(input);
        let meta = vfs::metadata_or_implicit_dir(root).ok_or_else(|| crate::Error::Custom {
            reason: FinalError::with_title(format!("file not found in virtual filesystem: {input}")),
        })?;

        if meta.is_dir {
            for path in vfs::walk(root) {
                let rel = path
                    .strip_prefix(root.parent().unwrap_or_else(|| Path::new("")))
                    .unwrap_or(&path)
                    .to_path_buf();
                if let Some(file) = vfs::metadata(&path) {
                    entries.push(entry_from_vfile(rel, &file));
                }
            }
        } else {
            let name = root
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| root.to_path_buf());
            entries.push(entry_from_vfile(name, &meta));
        }
    }

    sort_and_add_implicit_dirs(&mut entries);
    Ok(entries)
}

fn entry_from_vfile(rel: PathBuf, file: &vfs::VFile) -> archives::Entry {
    if file.is_symlink {
        archives::Entry {
            path: rel,
            is_symlink: true,
            symlink_target: file.symlink_target.clone(),
            mode: file.mode,
            ..Default::default()
        }
    } else if file.is_dir {
        archives::Entry {
            path: rel,
            is_dir: true,
            mode: file.mode,
            ..Default::default()
        }
    } else {
        archives::Entry {
            path: rel,
            data: file.data.clone(),
            size: file.data.len() as u64,
            mode: file.mode,
            ..Default::default()
        }
    }
}

/// Make directories sort before the files inside them and synthesize entries
/// for implicit parent directories, so nested trees extract cleanly.
fn sort_and_add_implicit_dirs(entries: &mut Vec<archives::Entry>) {
    let existing: std::collections::HashSet<PathBuf> = entries.iter().map(|e| e.path.clone()).collect();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.iter() {
        let mut parent = entry.path.parent();
        while let Some(p) = parent {
            if !p.as_os_str().is_empty() && !existing.contains(p) && !dirs.contains(&p.to_path_buf()) {
                dirs.push(p.to_path_buf());
            }
            parent = p.parent();
        }
    }
    for dir in dirs {
        entries.push(archives::Entry {
            path: dir,
            is_dir: true,
            mode: 0o755,
            ..Default::default()
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
}

fn run_compress(args: &CompressArgs) -> Result<(String, u64, usize)> {
    if args.files.is_empty() {
        return Err(FinalError::with_title("no files to compress").into());
    }

    let formats = format_from_path_or_flag(&args.output, args.format.as_deref())?;
    if formats.is_empty() {
        return Err(
            FinalError::with_title(format!("cannot infer a format from output path '{}'", args.output))
                .hint("use `format` to specify one, e.g. \"tar.gz\"")
                .into(),
        );
    }

    let (first, rest) = split_first_compression_format(&formats);
    let entries = collect_input_entries(&args.files)?;

    let mut bytes = match first {
        CompressionFormat::Tar => archives::build_tar(&entries)?,
        CompressionFormat::Zip => archives::build_zip(&entries, args.level, args.password.as_deref())?,
        CompressionFormat::SevenZip => archives::build_7z(&entries, args.level, args.password.as_deref())?,
        CompressionFormat::Rar => {
            return Err(FinalError::with_title("compressing to rar is not supported").into())
        }
        non_archive => {
            if entries.len() != 1 || entries[0].is_dir {
                return Err(
                    FinalError::with_title("a single file is required to compress into a non-archive format").into(),
                );
            }
            codecs::encode(non_archive, &entries[0].data, args.level)?
        }
    };

    for format in rest.iter().rev() {
        bytes = codecs::encode(*format, &bytes, args.level)?;
    }

    vfs::write_file(Path::new(&args.output), bytes.clone());
    Ok((args.output.clone(), bytes.len() as u64, entries.len()))
}

/// Stream-compress files pulled from JS. The encoder chain (sink + wrapping
/// layers) pushes output chunks to `on_chunk`; each input file is read through
/// a seekable reader, so neither the inputs nor the archive materialize in
/// wasm memory. Only formats with streamable encoders are supported (tar with
/// stream layers, and single-stream codecs); see [`crate::wasm::stream_encode`].
fn run_compress_from(
    files: &[CompressFileArgs],
    args: &CompressFromArgs,
    on_chunk: js_sys::Function,
) -> Result<(String, u64, usize)> {
    use crate::wasm::{seekable, stream_encode, stream_encode::Layer};

    let formats = format_from_path_or_flag(&args.output, args.format.as_deref())?;
    let (first, rest) = split_first_compression_format(&formats);
    if files.is_empty() {
        return Err(FinalError::with_title("no files to compress").into());
    }

    let total = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let mut top: Box<dyn Layer> = Box::new(stream_encode::ChunkLayer::new(
        on_chunk,
        std::rc::Rc::clone(&total),
    ));
    for format in rest.iter().rev() {
        top = stream_encode::wrap_layer(*format, top, args.level).map_err(io_err)?;
    }

    match first {
        CompressionFormat::Zip | CompressionFormat::SevenZip => {
            return Err(FinalError::with_title(format!(
                "streaming compression to .{} is not supported",
                first.as_str()
            ))
            .hint("the encoder needs a seekable output; use the VFS flow (writeFile + compress) instead")
            .into());
        }
        CompressionFormat::Rar => {
            return Err(FinalError::with_title("compressing to rar is not supported").into());
        }
        CompressionFormat::Tar => {
            let mut builder = tar::Builder::new(top);
            for file in files {
                let mut header = tar::Header::new_gnu();
                header.set_mode(file.mode & 0o777);
                if file.is_dir {
                    header.set_entry_type(tar::EntryType::Directory);
                    header.set_size(0);
                    builder.append_data(&mut header, &file.name, std::io::empty())?;
                } else {
                    header.set_size(file.size as u64);
                    let mut reader = seekable::JsSeekReader::new(file.read_at.clone(), file.size as u64);
                    builder.append_data(&mut header, &file.name, &mut reader)?;
                }
            }
            top = builder.into_inner()?;
        }
        non_archive => {
            top = stream_encode::wrap_layer(non_archive, top, args.level).map_err(io_err)?;
            if files.len() != 1 || files[0].is_dir {
                return Err(
                    FinalError::with_title("a single file is required to compress into a non-archive format").into(),
                );
            }
            let mut reader = seekable::JsSeekReader::new(files[0].read_at.clone(), files[0].size as u64);
            std::io::copy(&mut reader, &mut top)?;
        }
    }

    // Finish the encoder chain outer-to-inner: each layer flushes its trailer
    // into the next, ending with the chunk sink's final flush.
    let mut cur: Option<Box<dyn Layer>> = Some(top);
    while let Some(layer) = cur {
        cur = layer.finish_layer()?;
    }

    Ok((args.output.clone(), total.get(), files.len()))
}

fn io_err(e: std::io::Error) -> crate::Error {
    crate::Error::Custom {
        reason: FinalError::with_title("streaming compression failed").detail(format!("{e:?}")),
    }
}

fn run_decompress(args: &DecompressArgs) -> Result<(Vec<archives::Entry>, u64)> {
    let mut outputs = Vec::new();
    let mut files_unpacked = 0u64;

    for file in &args.files {
        let formats = format_from_path_or_flag(file, args.format.as_deref())?;
        let (first, rest) = split_first_compression_format(&formats);
        let input = read_input(file)?;
        let decoded = decode_layers(&input, &rest)?;
        let password = args.password.as_deref().map(|p| p.as_bytes());

        // Where outputs land (mirrors ouch's default wrapper-dir behavior).
        let is_archive = matches!(
            first,
            CompressionFormat::Tar | CompressionFormat::Zip | CompressionFormat::SevenZip | CompressionFormat::Rar
        );
        let output_root = match &args.output_dir {
            Some(dir) => PathBuf::from(dir),
            None if is_archive => {
                // "archive.tar.gz" -> "archive"
                extension::separate_known_extensions_from_name(Path::new(file))
                    .map(|(stem, _)| stem.to_path_buf())
                    .unwrap_or_else(|_| PathBuf::from(file).with_extension(""))
            }
            None => PathBuf::new(),
        };

        match first {
            CompressionFormat::Tar => {
                let entries = archives::unpack_tar(&decoded)?;
                files_unpacked += write_entries(&output_root, &entries, args.overwrite, &mut outputs)? as u64;
            }
            CompressionFormat::Zip => {
                let entries = archives::unpack_zip(&decoded, password)?;
                files_unpacked += write_entries(&output_root, &entries, args.overwrite, &mut outputs)? as u64;
            }
            CompressionFormat::SevenZip => {
                let entries = archives::unpack_7z(&decoded, password)?;
                files_unpacked += write_entries(&output_root, &entries, args.overwrite, &mut outputs)? as u64;
            }
            CompressionFormat::Rar => {
                let entries = archives::unpack_rar(&decoded, password)?;
                files_unpacked += write_entries(&output_root, &entries, args.overwrite, &mut outputs)? as u64;
            }
            non_archive => {
                // Decode the first (and only) non-archive layer.
                let decoded = codecs::decode(non_archive, &decoded)?;
                let output_name = Path::new(file)
                    .with_extension("")
                    .file_name()
                    .unwrap_or_default()
                    .to_owned();
                let output_path = output_root.join(output_name);
                write_output_file(&output_path, decoded, args.overwrite, &mut outputs)?;
                files_unpacked += 1;
            }
        }
    }

    Ok((outputs, files_unpacked))
}

fn write_entries(
    output_root: &Path,
    entries: &[archives::Entry],
    overwrite: bool,
    outputs: &mut Vec<archives::Entry>,
) -> Result<usize> {
    let mut count = 0;
    for entry in entries {
        let full_path = output_root.join(&entry.path);
        if entry.is_dir {
            vfs::create_dir_all(&full_path);
            outputs.push(output_meta(entry, full_path));
        } else if entry.is_symlink {
            if let Some(target) = &entry.symlink_target {
                if !overwrite && vfs::exists(&full_path) {
                    return Err(
                        FinalError::with_title(format!("output file already exists: {}", full_path.display())).into(),
                    );
                }
                vfs::write_symlink(&full_path, target.clone());
                outputs.push(output_meta(entry, full_path));
                count += 1;
            }
        } else {
            write_output_file(&full_path, entry.data.clone(), overwrite, outputs)?;
            count += 1;
        }
    }
    Ok(count)
}

fn output_meta(entry: &archives::Entry, full_path: PathBuf) -> archives::Entry {
    let mut meta = entry.clone();
    meta.path = full_path;
    meta.data.clear();
    meta
}

fn write_output_file(path: &Path, data: Vec<u8>, overwrite: bool, outputs: &mut Vec<archives::Entry>) -> Result<()> {
    if !overwrite && vfs::exists(path) {
        return Err(
            FinalError::with_title(format!("output file already exists: {}", path.display()))
                .hint("pass overwrite = true to replace existing files")
                .into(),
        );
    }
    vfs::write_file(path, data);
    outputs.push(archives::Entry {
        path: path.to_path_buf(),
        size: vfs::read_file(path).map(|d| d.len() as u64).unwrap_or(0),
        ..Default::default()
    });
    Ok(())
}

fn run_list(args: &ListArgs) -> Result<Vec<(String, archives::Entry)>> {
    let mut all = Vec::new();
    for archive in &args.archives {
        let formats = format_from_path_or_flag(archive, args.format.as_deref())?;
        let (first, rest) = split_first_compression_format(&formats);
        let input = read_input(archive)?;
        let decoded = decode_layers(&input, &rest)?;
        let password = args.password.as_deref().map(|p| p.as_bytes());

        match first {
            CompressionFormat::Tar => {
                for entry in archives::list_tar(&decoded)? {
                    all.push((archive.clone(), entry));
                }
            }
            CompressionFormat::Zip => {
                for entry in archives::list_zip(&decoded, password)? {
                    all.push((archive.clone(), entry));
                }
            }
            CompressionFormat::SevenZip => {
                for entry in archives::list_7z(&decoded, password)? {
                    all.push((archive.clone(), entry));
                }
            }
            CompressionFormat::Rar => {
                for entry in archives::list_rar(&decoded, password)? {
                    all.push((archive.clone(), entry));
                }
            }
            non_archive => {
                // Report the decoded size for non-archive formats.
                let decoded = codecs::decode(non_archive, &decoded)?;
                all.push((
                    archive.clone(),
                    archives::Entry {
                        path: PathBuf::from(archive),
                        size: decoded.len() as u64,
                        ..Default::default()
                    },
                ));
            }
        }
    }
    Ok(all)
}

fn run_read_entry(args: &ReadEntryArgs) -> Result<Vec<u8>> {
    let formats = format_from_path_or_flag(&args.archive, args.format.as_deref())?;
    let (first, rest) = split_first_compression_format(&formats);
    let input = read_input(&args.archive)?;
    let decoded = decode_layers(&input, &rest)?;
    let password = args.password.as_deref().map(|p| p.as_bytes());
    let entry_name = args.entry.replace('\\', "/");

    match first {
        CompressionFormat::Tar => archives::read_tar_entry(&decoded, &entry_name),
        CompressionFormat::Zip => archives::read_zip_entry(&decoded, password, &entry_name),
        CompressionFormat::SevenZip => archives::read_7z_entry(&decoded, password, &entry_name),
        CompressionFormat::Rar => archives::read_rar_entry(&decoded, password, &entry_name),
        // A single non-archive file is its own only "entry".
        non_archive => codecs::decode(non_archive, &decoded),
    }
}

/// Chain the `rest` codec decoders around `input`, outermost layer first.
/// E.g. for "tar.gz.xz" (`rest = [Gzip, Xz]`) this wraps xz, then gz.
fn chain_input_reader<'a>(input: &'a [u8], rest: &[CompressionFormat]) -> Result<Box<dyn std::io::Read + 'a>> {
    let mut reader: Box<dyn std::io::Read + 'a> = Box::new(std::io::Cursor::new(input));
    for format in rest.iter().rev() {
        reader = codecs::wrap_decoder(*format, reader)?;
    }
    Ok(reader)
}

/// Stream one entry's (or a single file's) contents to `on_chunk` in bounded
/// chunks. Decoder state lives entirely inside this call, so wasm memory stays
/// at chunk size regardless of the entry's uncompressed size (7z and rar are
/// inherently sequential and decode through their own whole-member readers).
fn run_stream_entry(args: &StreamEntryArgs, on_chunk: js_sys::Function) -> Result<()> {
    let formats = format_from_path_or_flag(&args.archive, args.format.as_deref())?;
    let (first, rest) = split_first_compression_format(&formats);
    let input = read_input(&args.archive)?;
    let password = args.password.as_deref().map(|p| p.as_bytes());
    let entry_name = args.entry.replace('\\', "/");

    // A failed JS call means the consumer cancelled the stream.
    let mut emit = move |chunk: &[u8]| -> Result<()> {
        let js = js_sys::Uint8Array::from(chunk);
        on_chunk.call1(&JsValue::NULL, &js).map_err(|e| crate::Error::Custom {
            reason: FinalError::with_title("stream was cancelled").detail(format!("{e:?}")),
        })?;
        Ok(())
    };

    match first {
        CompressionFormat::Tar => {
            let reader = chain_input_reader(&input, &rest)?;
            archives::pump_tar_chained(reader, &entry_name, &mut emit)
        }
        CompressionFormat::Zip => {
            // Zip needs a seekable source; decode any wrapping layers first.
            let decoded = if rest.is_empty() { input } else { decode_layers(&input, &rest)? };
            archives::pump_zip_entry(std::io::Cursor::new(decoded), password, &entry_name, &mut emit)
        }
        CompressionFormat::SevenZip => {
            let decoded = if rest.is_empty() { input } else { decode_layers(&input, &rest)? };
            archives::pump_7z_entry(&decoded, password, &entry_name, &mut emit)
        }
        CompressionFormat::Rar => {
            let decoded = if rest.is_empty() { input } else { decode_layers(&input, &rest)? };
            archives::pump_rar_entry(&decoded, password, &entry_name, Box::new(emit))
        }
        non_archive => {
            // Single-stream formats chain every codec without buffering.
            let mut reader = chain_input_reader(&input, &rest)?;
            reader = codecs::wrap_decoder(non_archive, reader)?;
            archives::pump_read(&mut reader, &mut emit)
        }
    }
}

// ---------------------------------------------------------------------------
// Seekable (JS-backed random-access) operations
// ---------------------------------------------------------------------------

fn seekable_split(args: &SeekableArgs) -> Result<(CompressionFormat, Vec<CompressionFormat>)> {
    let formats = format_from_path_or_flag(&args.name, args.format.as_deref())?;
    Ok(split_first_compression_format(&formats))
}

/// Pull the whole source into memory (rar has no random-access reader).
fn seekable_read_all(reader: &mut dyn std::io::Read) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    crate::utils::copy_limited_decompression(reader, &mut out)?;
    Ok(out)
}

fn seekable_wrapped_error() -> crate::Error {
    crate::Error::Custom {
        reason: FinalError::with_title("wrapped zip/7z/rar archives are not supported with a seekable source")
            .hint("use a tar.* chain, or load the archive into the virtual filesystem instead"),
    }
}

/// Wrap a seekable reader in the `rest` codec decoders (for tar.* chains).
fn seekable_tar_reader(
    read_at: js_sys::Function,
    size: u64,
    rest: &[CompressionFormat],
) -> Result<Box<dyn std::io::Read>> {
    let mut reader: Box<dyn std::io::Read> = Box::new(seekable::JsSeekReader::new(read_at, size));
    for format in rest.iter().rev() {
        reader = codecs::wrap_decoder(*format, reader)?;
    }
    Ok(reader)
}

fn run_seekable_list(
    args: &SeekableArgs,
    read_at: js_sys::Function,
    size: u64,
) -> Result<Vec<(String, archives::Entry)>> {
    let (first, rest) = seekable_split(args)?;
    let password = args.password.as_deref().map(|p| p.as_bytes());
    let name = args.name.clone();
    let mut all = Vec::new();

    match first {
        CompressionFormat::Tar => {
            if rest.is_empty() {
                // Uncompressed tar: headers are read, file data is seek-skipped.
                for entry in archives::list_tar_seekable(seekable::JsSeekReader::new(read_at, size))? {
                    all.push((name.clone(), entry));
                }
            } else {
                // tar.gz / tar.xz / ...: the whole chain decodes sequentially.
                let reader = seekable_tar_reader(read_at, size, &rest)?;
                for entry in archives::list_tar_chained(reader)? {
                    all.push((name.clone(), entry));
                }
            }
        }
        CompressionFormat::Zip if rest.is_empty() => {
            for entry in archives::list_zip_reader(seekable::JsSeekReader::new(read_at, size), password)? {
                all.push((name.clone(), entry));
            }
        }
        CompressionFormat::SevenZip if rest.is_empty() => {
            for entry in archives::list_7z_reader(seekable::JsSeekReader::new(read_at, size), password)? {
                all.push((name.clone(), entry));
            }
        }
        CompressionFormat::Rar if rest.is_empty() => {
            let mut reader = seekable::JsSeekReader::new(read_at, size);
            let input = seekable_read_all(&mut reader)?;
            for entry in archives::list_rar(&input, password)? {
                all.push((name.clone(), entry));
            }
        }
        _ => return Err(seekable_wrapped_error()),
    }
    Ok(all)
}

fn run_seekable_read_entry(
    args: &SeekableArgs,
    read_at: js_sys::Function,
    size: u64,
) -> Result<Vec<u8>> {
    let (first, rest) = seekable_split(args)?;
    let password = args.password.as_deref().map(|p| p.as_bytes());
    let entry_name = args.entry.replace('\\', "/");

    match first {
        CompressionFormat::Tar => {
            if rest.is_empty() {
                archives::read_tar_entry_seekable(seekable::JsSeekReader::new(read_at, size), &entry_name)
            } else {
                archives::read_tar_entry_chained(seekable_tar_reader(read_at, size, &rest)?, &entry_name)
            }
        }
        CompressionFormat::Zip if rest.is_empty() => {
            archives::read_zip_entry_reader(seekable::JsSeekReader::new(read_at, size), password, &entry_name)
        }
        CompressionFormat::SevenZip if rest.is_empty() => {
            archives::read_7z_entry_reader(seekable::JsSeekReader::new(read_at, size), password, &entry_name)
        }
        CompressionFormat::Rar if rest.is_empty() => {
            let mut reader = seekable::JsSeekReader::new(read_at, size);
            let input = seekable_read_all(&mut reader)?;
            archives::read_rar_entry(&input, password, &entry_name)
        }
        _ => Err(seekable_wrapped_error()),
    }
}

fn run_seekable_stream_entry(
    args: &SeekableArgs,
    read_at: js_sys::Function,
    size: u64,
    on_chunk: js_sys::Function,
) -> Result<()> {
    let (first, rest) = seekable_split(args)?;
    let password = args.password.as_deref().map(|p| p.as_bytes());
    let entry_name = args.entry.replace('\\', "/");

    let mut emit = move |chunk: &[u8]| -> Result<()> {
        let js = js_sys::Uint8Array::from(chunk);
        on_chunk.call1(&JsValue::NULL, &js).map_err(|e| crate::Error::Custom {
            reason: FinalError::with_title("stream was cancelled").detail(format!("{e:?}")),
        })?;
        Ok(())
    };

    match first {
        CompressionFormat::Tar => {
            if rest.is_empty() {
                archives::pump_tar_seekable(seekable::JsSeekReader::new(read_at, size), &entry_name, &mut emit)
            } else {
                archives::pump_tar_chained(seekable_tar_reader(read_at, size, &rest)?, &entry_name, &mut emit)
            }
        }
        CompressionFormat::Zip if rest.is_empty() => {
            archives::pump_zip_entry(seekable::JsSeekReader::new(read_at, size), password, &entry_name, &mut emit)
        }
        CompressionFormat::SevenZip if rest.is_empty() => {
            archives::pump_7z_entry_reader(seekable::JsSeekReader::new(read_at, size), password, &entry_name, &mut emit)
        }
        CompressionFormat::Rar if rest.is_empty() => {
            let mut reader = seekable::JsSeekReader::new(read_at, size);
            let input = seekable_read_all(&mut reader)?;
            archives::pump_rar_entry(&input, password, &entry_name, Box::new(emit))
        }
        _ => Err(seekable_wrapped_error()),
    }
}
