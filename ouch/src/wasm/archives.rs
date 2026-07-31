//! In-memory zip/tar/7z building and unpacking for the WASM bindings.
//!
//! The native CLI's `archive/` modules read and write real files; here the
//! same crate backends (`zip`, `tar`, `sevenz-rust2`) are driven purely with
//! `io::Cursor`s and produce/consume [`Entry`] lists that the virtual
//! filesystem stores.

use std::{
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
};

use crate::{
    Result,
    error::FinalError,
    utils::{copy_limited_decompression, validate_entry_path},
};

/// One entry inside an archive: metadata plus (for files) contents.
#[derive(Debug, Clone, Default)]
pub struct Entry {
    pub path: PathBuf,
    pub data: Vec<u8>,
    pub size: u64,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<PathBuf>,
    /// Unix permission bits (best-effort).
    pub mode: u32,
}

fn unsafe_path_error(path: &Path) -> crate::Error {
    crate::Error::Custom {
        reason: FinalError::with_title("refusing to extract archive entry with unsafe path")
            .detail(format!("entry: {}", path.display())),
    }
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

/// List the contents of an in-memory zip archive (metadata only, so it also
/// works on password-protected archives without a password).
pub fn list_zip(input: &[u8], password: Option<&[u8]>) -> Result<Vec<Entry>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(input))?;
    let mut entries = Vec::with_capacity(archive.len());
    for idx in 0..archive.len() {
        let mut file = match password {
            Some(password) => archive.by_index_decrypt(idx, password)?,
            None => archive.by_index(idx)?,
        };
        entries.push(zip_file_to_meta(&mut file)?);
    }
    Ok(entries)
}

/// Unpack an in-memory zip archive into a list of entries (reads contents).
pub fn unpack_zip(input: &[u8], password: Option<&[u8]>) -> Result<Vec<Entry>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(input))?;
    let mut entries = Vec::with_capacity(archive.len());
    for idx in 0..archive.len() {
        let mut file = match password {
            Some(password) => archive.by_index_decrypt(idx, password)?,
            None => archive.by_index(idx)?,
        };
        let mut entry = zip_file_to_meta(&mut file)?;
        if entry.is_symlink {
            // Symlink targets are stored as the entry's content.
            file.read_to_end(&mut entry.data)?;
            entry.symlink_target = Some(PathBuf::from(String::from_utf8_lossy(&entry.data).into_owned()));
            entry.data.clear();
        } else if !entry.is_dir {
            copy_limited_decompression(&mut file, &mut entry.data)?;
        }
        entries.push(entry);
    }
    Ok(entries)
}

fn zip_file_to_meta<R: Read>(file: &mut zip::read::ZipFile<'_, R>) -> Result<Entry> {
    let relpath = match file.enclosed_name() {
        Some(path) => path.to_owned(),
        None => return Err(unsafe_path_error(&file.mangled_name())),
    };

    let mode = file.unix_mode().unwrap_or(0o644);
    Ok(Entry {
        path: relpath,
        size: file.size(),
        is_dir: file.is_dir(),
        is_symlink: mode & 0o170000 == 0o120000,
        mode,
        ..Default::default()
    })
}

/// Build an in-memory zip archive from the given entries.
///
/// `level` (0-9) sets the deflate level; `password` enables AES-256
/// encryption for every entry.
pub fn build_zip(entries: &[Entry], level: Option<i16>, password: Option<&str>) -> Result<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .large_file(true)
        .compression_level(level.map(i64::from));

    for entry in entries {
        let name = path_to_archive_name(&entry.path)?;
        let mut options = options;
        if let Some(password) = password {
            options = options.with_aes_encryption(zip::AesMode::Aes256, password);
        }
        if entry.is_dir {
            writer.add_directory(name, options)?;
        } else if entry.is_symlink {
            let target = entry
                .symlink_target
                .as_ref()
                .ok_or_else(|| FinalError::with_title("zip symlink entry is missing its target"))?;
            writer.add_symlink(name, path_to_archive_name(target)?, options)?;
        } else {
            let file_options = options.unix_permissions(entry.mode & 0o777);
            writer.start_file(name, file_options)?;
            writer.write_all(&entry.data)?;
        }
    }

    Ok(writer.finish()?.into_inner())
}

/// Read a single entry's contents from an in-memory zip archive.
pub fn read_zip_entry(input: &[u8], password: Option<&[u8]>, entry_name: &str) -> Result<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(input))?;
    for idx in 0..archive.len() {
        let mut file = match password {
            Some(password) => archive.by_index_decrypt(idx, password)?,
            None => archive.by_index(idx)?,
        };
        let Some(enclosed) = file.enclosed_name() else {
            continue;
        };
        if normalize_name(&enclosed) == entry_name {
            if file.is_dir() {
                return Ok(Vec::new());
            }
            let mut data = Vec::new();
            copy_limited_decompression(&mut file, &mut data)?;
            return Ok(data);
        }
    }
    Err(entry_not_found(entry_name))
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

/// List the contents of an in-memory tar archive (metadata only).
pub fn list_tar(input: &[u8]) -> Result<Vec<Entry>> {
    let mut archive = tar::Archive::new(Cursor::new(input));
    let mut entries = Vec::new();
    for file in archive.entries()? {
        let mut file = file?;
        entries.push(tar_entry_to_entry(&mut file, false)?);
    }
    Ok(entries)
}

/// Unpack an in-memory tar archive into a list of entries (reads contents).
pub fn unpack_tar(input: &[u8]) -> Result<Vec<Entry>> {
    let mut archive = tar::Archive::new(Cursor::new(input));
    let mut entries = Vec::new();
    for file in archive.entries()? {
        let mut file = file?;
        entries.push(tar_entry_to_entry(&mut file, true)?);
    }
    Ok(entries)
}

/// Read a single entry's contents from an in-memory tar archive.
pub fn read_tar_entry(input: &[u8], entry_name: &str) -> Result<Vec<u8>> {
    let mut archive = tar::Archive::new(Cursor::new(input));
    for file in archive.entries()? {
        let mut file = file?;
        let raw_path = file.path()?.into_owned();
        if normalize_name(&raw_path) == entry_name {
            match file.header().entry_type() {
                tar::EntryType::Directory => return Ok(Vec::new()),
                tar::EntryType::Symlink | tar::EntryType::Link => {
                    let target = file.link_name()?.unwrap_or_default().into_owned();
                    return Ok(target.to_string_lossy().into_owned().into_bytes());
                }
                _ => {
                    let mut data = Vec::new();
                    copy_limited_decompression(&mut file, &mut data)?;
                    return Ok(data);
                }
            }
        }
    }
    Err(entry_not_found(entry_name))
}

fn tar_entry_to_entry(entry: &mut tar::Entry<'_, Cursor<&[u8]>>, read_data: bool) -> Result<Entry> {
    let raw_path = entry.path()?.into_owned();
    let path = validate_entry_path(&raw_path).map_err(|_| unsafe_path_error(&raw_path))?;

    let mut out = Entry {
        size: entry.size(),
        mode: entry.header().mode().unwrap_or(0o644),
        ..Default::default()
    };

    match entry.header().entry_type() {
        tar::EntryType::Symlink => {
            let target = entry
                .link_name()?
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing symlink target"))?;
            out.path = path;
            out.is_symlink = true;
            out.symlink_target = Some(target.into_owned());
            out.size = 0;
            Ok(out)
        }
        tar::EntryType::Link => {
            let target = entry
                .link_name()?
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing hardlink target"))?;
            out.path = path;
            out.is_symlink = true;
            out.symlink_target = Some(target.into_owned());
            out.size = 0;
            Ok(out)
        }
        tar::EntryType::Directory => {
            out.path = path;
            out.is_dir = true;
            out.size = 0;
            Ok(out)
        }
        tar::EntryType::Regular | tar::EntryType::GNUSparse => {
            out.path = path;
            if read_data {
                copy_limited_decompression(entry, &mut out.data)?;
            }
            Ok(out)
        }
        _ => {
            Err(FinalError::with_title(format!("unsupported tar entry type {:?}", entry.header().entry_type())).into())
        }
    }
}

/// Build an in-memory tar archive from the given entries.
pub fn build_tar(entries: &[Entry]) -> Result<Vec<u8>> {
    let mut builder = tar::Builder::new(Vec::new());

    for entry in entries {
        let name = path_to_archive_name(&entry.path)?;
        if entry.is_dir {
            // Build the dir entry from a header instead of `append_dir`, which
            // stats the source path (unsupported on wasm).
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            builder.append_data(&mut header, name, io::empty())?;
        } else if entry.is_symlink {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_mode(0o777);
            header.set_size(0);
            let target = entry
                .symlink_target
                .as_ref()
                .ok_or_else(|| FinalError::with_title("tar symlink entry is missing its target"))?;
            builder.append_link(&mut header, name, target)?;
        } else {
            let mut header = tar::Header::new_gnu();
            header.set_mode(entry.mode & 0o777);
            header.set_size(entry.data.len() as u64);
            builder.append_data(&mut header, name, Cursor::new(&entry.data))?;
        }
    }

    Ok(builder.into_inner()?)
}

// ---------------------------------------------------------------------------
// 7z
// ---------------------------------------------------------------------------

fn sevenz_password(password: Option<&[u8]>) -> Result<sevenz_rust2::Password> {
    match password {
        None => Ok(sevenz_rust2::Password::empty()),
        Some(bytes) => {
            let text = std::str::from_utf8(bytes).map_err(|_| crate::Error::InvalidPassword {
                reason: "password is not valid UTF-8".into(),
            })?;
            Ok(sevenz_rust2::Password::from(text))
        }
    }
}

/// List the contents of an in-memory 7z archive.
pub fn list_7z(input: &[u8], password: Option<&[u8]>) -> Result<Vec<Entry>> {
    let mut reader = sevenz_rust2::ArchiveReader::new(Cursor::new(input), sevenz_password(password)?)?;
    let mut entries = Vec::new();
    reader.for_each_entries(|entry, _reader| {
        entries.push(Entry {
            path: PathBuf::from(entry.name()),
            size: entry.size(),
            is_dir: entry.is_directory(),
            mode: 0o644,
            ..Default::default()
        });
        Ok(true)
    })?;
    Ok(entries)
}

/// Read a single entry's contents from an in-memory 7z archive.
///
/// Uses `ArchiveReader::read_file`, which decodes only the blocks needed to
/// reach the requested entry (solid archives decode everything before it).
pub fn read_7z_entry(input: &[u8], password: Option<&[u8]>, entry_name: &str) -> Result<Vec<u8>> {
    let mut reader = sevenz_rust2::ArchiveReader::new(Cursor::new(input), sevenz_password(password)?)?;
    reader.read_file(entry_name).map_err(|err| match err {
        sevenz_rust2::Error::FileNotFound => entry_not_found(entry_name),
        other => other.into(),
    })
}

/// Unpack an in-memory 7z archive into a list of entries.
pub fn unpack_7z(input: &[u8], password: Option<&[u8]>) -> Result<Vec<Entry>> {
    let mut reader = sevenz_rust2::ArchiveReader::new(Cursor::new(input), sevenz_password(password)?)?;
    let mut entries = Vec::new();
    let mut failed: Option<crate::Error> = None;
    reader.for_each_entries(|entry, entry_reader| {
        match sevenz_entry_to_entry(entry, entry_reader) {
            Ok(entry) => {
                entries.push(entry);
                Ok(true)
            }
            Err(err) => {
                failed = Some(err);
                Ok(false) // stop iterating
            }
        }
    })?;
    if let Some(err) = failed {
        return Err(err);
    }
    Ok(entries)
}

fn sevenz_entry_to_entry(entry: &sevenz_rust2::ArchiveEntry, entry_reader: &mut dyn Read) -> Result<Entry> {
    let path = validate_entry_path(Path::new(entry.name())).map_err(|_| unsafe_path_error(Path::new(entry.name())))?;
    let mut data = Vec::new();
    if !entry.is_directory() {
        copy_limited_decompression(entry_reader, &mut data)?;
    }
    Ok(Entry {
        path,
        data,
        size: entry.size(),
        is_dir: entry.is_directory(),
        mode: 0o644,
        ..Default::default()
    })
}

/// Build an in-memory 7z archive from the given entries.
///
/// `level` (0-9) sets the LZMA2 level; `password` enables AES-256
/// encryption (with header encryption).
pub fn build_7z(entries: &[Entry], level: Option<i16>, password: Option<&str>) -> Result<Vec<u8>> {
    use sevenz_rust2::{
        EncoderConfiguration, EncoderMethod,
        encoder_options::{AesEncoderOptions, EncoderOptions, Lzma2Options},
    };

    let mut writer = sevenz_rust2::ArchiveWriter::new(Cursor::new(Vec::new()))?;

    // 7z chains methods outer-to-inner; encryption wraps the compressed data.
    let mut methods: Vec<EncoderConfiguration> = Vec::new();
    if let Some(password) = password {
        methods.push(AesEncoderOptions::new(sevenz_rust2::Password::from(password)).into());
    }
    let mut lzma2 = EncoderConfiguration::new(EncoderMethod::LZMA2);
    if let Some(level) = level {
        lzma2 = lzma2.with_options(EncoderOptions::Lzma2(
            Lzma2Options::from_level(level.clamp(0, 9) as u32),
        ));
    }
    methods.push(lzma2);
    writer.set_content_methods(methods);

    for entry in entries {
        let name = path_to_archive_name(&entry.path)?;
        if entry.is_dir {
            writer.push_archive_entry::<io::Empty>(sevenz_rust2::ArchiveEntry::new_directory(&name), None)?;
        } else {
            let data = entry.data.clone();
            writer.push_archive_entry::<Cursor<Vec<u8>>>(
                sevenz_rust2::ArchiveEntry::new_file(&name),
                Some(Cursor::new(data)),
            )?;
        }
    }
    Ok(writer.finish()?.into_inner())
}

// ---------------------------------------------------------------------------
// rar
// ---------------------------------------------------------------------------

fn parse_rar(input: &[u8], password: Option<&[u8]>) -> Result<rars::Archive> {
    let options = match password {
        Some(password) => rars::ArchiveReadOptions::with_password(password),
        None => rars::ArchiveReadOptions::new(),
    };
    rars::ArchiveReader::read_with_options(input, options).map_err(rar_err)
}

fn rar_err(err: rars::Error) -> crate::Error {
    use rars::Error as RarError;
    match err {
        RarError::NeedPassword => crate::Error::InvalidPassword {
            reason: "this rar archive needs a password".into(),
        },
        RarError::WrongPasswordOrCorruptData => crate::Error::InvalidPassword {
            reason: "wrong password or corrupt rar archive".into(),
        },
        other => crate::Error::Custom {
            reason: FinalError::with_title("failed to read rar archive").detail(format!("{other:?}")),
        },
    }
}

/// Convert a raw rar entry name (often backslash-separated, from Windows-host
/// archives) into a safe `/`-separated VFS path.
fn rar_name_to_path(name: &[u8]) -> Result<PathBuf> {
    let normalized = String::from_utf8_lossy(name).replace('\\', "/");
    validate_entry_path(Path::new(&normalized)).map_err(|_| unsafe_path_error(Path::new(&normalized)))
}

/// List the contents of an in-memory rar archive (metadata only).
pub fn list_rar(input: &[u8], password: Option<&[u8]>) -> Result<Vec<Entry>> {
    let archive = parse_rar(input, password)?;
    archive
        .members()
        .map(|member| {
            Ok(Entry {
                path: rar_name_to_path(&member.meta.name)?,
                size: member.meta.unpacked_size,
                is_dir: member.meta.is_directory,
                mode: 0o644,
                ..Default::default()
            })
        })
        .collect()
}

/// Unpack an in-memory rar archive into a list of entries (reads contents).
pub fn unpack_rar(input: &[u8], password: Option<&[u8]>) -> Result<Vec<Entry>> {
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Clone)]
    struct Sink {
        blobs: Rc<RefCell<Vec<Vec<u8>>>>,
        index: usize,
    }

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.blobs.borrow_mut()[self.index].extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let archive = parse_rar(input, password)?;
    let names = Rc::new(RefCell::new(Vec::<(Vec<u8>, bool)>::new()));
    let blobs = Rc::new(RefCell::new(Vec::<Vec<u8>>::new()));

    {
        let names_ref = Rc::clone(&names);
        let blobs_ref = Rc::clone(&blobs);
        // The callback is infallible (path safety is checked afterwards); it
        // records each member's raw name + a sink that rars streams into.
        archive
            .extract_to(password, |meta| {
                let mut names = names_ref.borrow_mut();
                let mut blobs = blobs_ref.borrow_mut();
                names.push((meta.name.clone(), meta.is_directory));
                blobs.push(Vec::new());
                Ok(Box::new(Sink {
                    blobs: Rc::clone(&blobs_ref),
                    index: names.len() - 1,
                }) as Box<dyn Write>)
            })
            .map_err(rar_err)?;
    }

    let names = Rc::try_unwrap(names).ok().unwrap().into_inner();
    let blobs = Rc::try_unwrap(blobs).ok().unwrap().into_inner();

    let mut entries = Vec::with_capacity(names.len());
    for ((name, is_dir), blob) in names.iter().zip(blobs.iter()) {
        let path = rar_name_to_path(name)?;
        let mut entry = Entry {
            path,
            size: blob.len() as u64,
            is_dir: *is_dir,
            mode: 0o644,
            ..Default::default()
        };
        if !*is_dir {
            entry.data = blob.clone();
        }
        entries.push(entry);
    }

    add_implicit_dirs(&mut entries);
    Ok(entries)
}

/// Read a single entry's contents from an in-memory rar archive (decodes the
/// whole archive; rars exposes no random-access single-member reader).
pub fn read_rar_entry(input: &[u8], password: Option<&[u8]>, entry_name: &str) -> Result<Vec<u8>> {
    let entries = unpack_rar(input, password)?;
    for entry in entries {
        if !entry.is_dir && normalize_name(&entry.path) == entry_name {
            return Ok(entry.data);
        }
    }
    Err(entry_not_found(entry_name))
}

/// Synthesize entries for parent directories the archive did not list
/// explicitly, so [`crate::wasm::entry`]'s writer creates them in the VFS.
fn add_implicit_dirs(entries: &mut Vec<Entry>) {
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
        entries.push(Entry {
            path: dir,
            is_dir: true,
            mode: 0o755,
            ..Default::default()
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Convert an entry path to the `/`-separated name used inside archives.
fn path_to_archive_name(path: &Path) -> Result<String> {
    path.to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or_else(|| FinalError::with_title("archive entry path is not valid UTF-8").into())
}

/// Normalize a path for comparison against archive entry names.
fn normalize_name(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned()
}

fn entry_not_found(name: &str) -> crate::Error {
    crate::Error::Custom {
        reason: FinalError::with_title(format!("entry not found in archive: {name}")),
    }
}
