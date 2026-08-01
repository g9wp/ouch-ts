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

/// Bytes pulled from JS in a single `read_at` call when refilling the internal
/// buffer. This is the wasm<->JS crossing granularity: archive parsers read in
/// small chunks (`io::copy` uses 8 KiB, zip's inflate decoder reads less), so
/// buffering here collapses many crossings into one. Kept moderate so that
/// seek-skipping (tar headers, zip metadata) does not pull too much data
/// beyond what the parser asked for.
const READ_BUFFER_SIZE: usize = 128 * 1024;

/// A `Read + Seek` adapter over a JS `read_at(offset, length)` function.
///
/// Cold reads (after a seek, or the first read of a region) are served
/// directly. Only a read that continues exactly where a previous read ended
/// (a sequential access pattern, e.g. streaming an entry) starts buffering, so
/// small parser reads collapse into one larger JS call without inflating
/// seek-skipped or metadata reads.
pub struct JsSeekReader {
    read_at: js_sys::Function,
    size: u64,
    pos: u64,
    /// Bytes already pulled from JS, starting at archive offset `buf_start`.
    buf: Vec<u8>,
    buf_start: u64,
    /// Archive offset just past the end of the last read (or 0 when none).
    last_end: u64,
}

impl JsSeekReader {
    pub fn new(read_at: js_sys::Function, size: u64) -> Self {
        Self {
            read_at,
            size,
            pos: 0,
            buf: Vec::new(),
            buf_start: 0,
            last_end: 0,
        }
    }

    fn call_read_at(&self, offset: u64, want: u32) -> io::Result<Vec<u8>> {
        let offset_js = JsValue::from_f64(offset as f64);
        let length = JsValue::from_f64(want as f64);
        let value = self.read_at.call2(&JsValue::NULL, &offset_js, &length).map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("read_at({offset_js:?}) failed: {e:?}"))
        })?;
        if !value.is_instance_of::<js_sys::Uint8Array>() {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "read_at must return a Uint8Array",
            ));
        }
        Ok(js_sys::Uint8Array::new(&value).to_vec())
    }

    /// Pull up to `READ_BUFFER_SIZE` bytes at `self.pos` from JS into `self.buf`.
    fn refill(&mut self) -> io::Result<()> {
        if self.pos >= self.size {
            self.buf.clear();
            self.buf_start = self.pos;
            return Ok(());
        }
        let want = (READ_BUFFER_SIZE as u64).min(self.size - self.pos) as u32;
        self.buf = self.call_read_at(self.pos, want)?;
        self.buf_start = self.pos;
        Ok(())
    }
}

impl Read for JsSeekReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.size {
            return Ok(0);
        }
        // Serve from the internal buffer when the read lands inside it.
        if let Some(off) = self.pos.checked_sub(self.buf_start) {
            let off = off as usize;
            if off < self.buf.len() {
                let n = (self.buf.len() - off).min(buf.len());
                buf[..n].copy_from_slice(&self.buf[off..off + n]);
                self.pos += n as u64;
                self.last_end = self.pos;
                return Ok(n);
            }
        }
        // A read that continues exactly where the previous one ended starts a
        // buffered region (sequential pattern); otherwise it is a cold read.
        if self.pos == self.last_end && buf.len() < READ_BUFFER_SIZE {
            self.refill()?;
            let n = self.buf.len().min(buf.len());
            if n == 0 {
                return Ok(0);
            }
            buf[..n].copy_from_slice(&self.buf[..n]);
            self.pos += n as u64;
            self.last_end = self.pos;
            return Ok(n);
        }
        // Cold read: serve directly from JS, remembering where it ended.
        let want = (buf.len() as u64).min(self.size - self.pos) as u32;
        let bytes = self.call_read_at(self.pos, want)?;
        let n = bytes.len().min(buf.len());
        if n == 0 {
            return Ok(0);
        }
        buf[..n].copy_from_slice(&bytes[..n]);
        self.pos += n as u64;
        self.last_end = self.pos;
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
        // Keep the buffer when the new position is still inside it; the next
        // read then hits cached bytes instead of a fresh JS call. last_end is
        // left as-is: a seek breaks the sequential continuation, so a read
        // right after a seek stays cold unless it matches last_end.
        if self.pos < self.buf_start || self.pos - self.buf_start > self.buf.len() as u64 {
            self.buf.clear();
            self.buf_start = 0;
        }
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
