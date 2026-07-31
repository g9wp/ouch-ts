//! Synchronous random-access reading of a JS-owned byte source.
//!
//! Archive formats keep their metadata in known places (zip central directory
//! at the end, tar 512-byte headers, 7z header at the start), and a single
//! entry can be decompressed by seeking to its data. [`JsSeekReader`] exposes
//! that to the archive parsers without ever copying the whole archive into
//! wasm memory: every read is a `read_at(offset, length) -> Uint8Array` call
//! into JS, so the host keeps the bytes (e.g. a `Uint8Array` or a file) and
//! wasm pulls only the ranges it needs.

use std::io::{self, Read, Seek, SeekFrom};
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
