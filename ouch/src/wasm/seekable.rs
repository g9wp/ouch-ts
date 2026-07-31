//! Synchronous random-access reading of a JS-owned byte source.
//!
//! Archive formats keep their metadata in known places (zip central directory
//! at the end, tar 512-byte headers, 7z header at the start), and a single
//! entry can be decompressed by seeking to its data. [`JsSeekReader`] exposes
//! that to the archive parsers without ever copying the whole archive into
//! wasm memory: every read is a `read_at(offset, length) -> Uint8Array` call
//! into JS, so the host keeps the bytes (e.g. a `Uint8Array` or a file) and
//! wasm pulls only the ranges it needs.

use std::io::{self, Read, Seek, SeekFrom, Write};
use wasm_bindgen::{JsCast, prelude::*};

/// A `Read + Seek` adapter over a JS `read_at(offset, length)` function.
pub struct JsSeekReader {
    read_at: js_sys::Function,
    size: u64,
    pos: u64,
}

impl JsSeekReader {
    pub fn new(read_at: js_sys::Function, size: u64) -> Self {
        Self {
            read_at,
            size,
            pos: 0,
        }
    }
}

impl Read for JsSeekReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.size {
            return Ok(0);
        }
        let want = (buf.len() as u64).min(self.size - self.pos) as u32;
        let offset = JsValue::from_f64(self.pos as f64);
        let length = JsValue::from_f64(want as f64);
        let value = self.read_at.call2(&JsValue::NULL, &offset, &length).map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("read_at({offset:?}) failed: {e:?}"))
        })?;
        if !value.is_instance_of::<js_sys::Uint8Array>() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "read_at must return a Uint8Array",
            ));
        }
        let bytes = js_sys::Uint8Array::new(&value).to_vec();
        let n = bytes.len().min(buf.len());
        if n == 0 {
            // Source returned EOF before the requested length.
            return Ok(0);
        }
        buf[..n].copy_from_slice(&bytes[..n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for JsSeekReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let base = match from {
            SeekFrom::Start(_) => 0,
            SeekFrom::End(_) => self.size,
            SeekFrom::Current(_) => self.pos,
        };
        let delta = match from {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => n as i64,
            SeekFrom::Current(n) => n as i64,
        };
        let new_pos = base as i64 + delta;
        if new_pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before start of source",
            ));
        }
        self.pos = (new_pos as u64).min(self.size);
        Ok(self.pos)
    }
}

/// A `Write + Seek` adapter over a JS `writeAt(offset, bytes) -> newEnd`
/// function. Lets encoders that require a seekable output (zip, 7z) stream
/// into a host file (Deno/Node) instead of buffering the archive in wasm
/// memory.
pub struct JsSeekSink {
    write_at: js_sys::Function,
    size: u64,
    pos: u64,
}

impl JsSeekSink {
    pub fn new(write_at: js_sys::Function) -> Self {
        Self {
            write_at,
            size: 0,
            pos: 0,
        }
    }

    /// Total bytes written so far (the logical archive size).
    pub fn size(&self) -> u64 {
        self.size
    }
}

impl Write for JsSeekSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let bytes = js_sys::Uint8Array::from(buf);
        let offset = JsValue::from_f64(self.pos as f64);
        let end = self.write_at.call2(&JsValue::NULL, &offset, &bytes).map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("write_at failed: {e:?}"))
        })?;
        let end = end.as_f64().unwrap_or(self.pos as f64) as u64;
        self.size = self.size.max(end);
        self.pos = end;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Seek for JsSeekSink {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let base = match from {
            SeekFrom::Start(_) => 0,
            SeekFrom::End(_) => self.size,
            SeekFrom::Current(_) => self.pos,
        };
        let delta = match from {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => n as i64,
            SeekFrom::Current(n) => n as i64,
        };
        let new_pos = base as i64 + delta;
        if new_pos < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before start of sink",
            ));
        }
        self.pos = new_pos as u64;
        Ok(self.pos)
    }
}
