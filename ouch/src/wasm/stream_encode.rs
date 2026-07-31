//! Streaming (push) compression.
//!
//! The archive/codec writes into a chain of encoder layers whose innermost
//! layer buffers output into 256 KiB chunks pushed to a JS callback, so the
//! compressed output never materializes in wasm memory. Input bytes are pulled
//! from the host through the seekable reader ([`super::seekable`]), keeping
//! wasm memory bounded on both sides for every streamable format.
//!
//! Limitations: `bz2` (the pure-Rust encoder `banzai` is one-shot) and `zip` /
//! `7z` (their crates require a `Seek` output, impossible for a chunk sink).

use std::{
    io::{self, BufWriter, Write},
    rc::Rc,
};

use wasm_bindgen::prelude::*;

use crate::{BUFFER_CAPACITY, extension::CompressionFormat};

/// A writer layer that can be finalized (trailers flushed) and unwrapped.
pub trait Layer: Write {
    /// Finalize this layer, returning the next (inner) layer, or `None` at the
    /// bottom of the chain. Each encoder's trailer is flushed into its inner
    /// layer, so finishing runs outer-to-inner.
    fn finish_layer(self: Box<Self>) -> io::Result<Option<Box<dyn Layer>>>;
}

// ---------------------------------------------------------------------------
// innermost layer: chunked push sink
// ---------------------------------------------------------------------------

struct ChunkSink {
    on_chunk: js_sys::Function,
    total: Rc<std::cell::Cell<u64>>,
}

impl Write for ChunkSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let js = js_sys::Uint8Array::from(buf);
        self.on_chunk.call1(&JsValue::NULL, &js).map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("chunk callback failed: {e:?}"))
        })?;
        self.total.set(self.total.get() + buf.len() as u64);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Bottom of the chain: batches output into 256 KiB chunks for JS.
pub struct ChunkLayer {
    writer: BufWriter<ChunkSink>,
}

impl ChunkLayer {
    pub fn new(on_chunk: js_sys::Function, total: Rc<std::cell::Cell<u64>>) -> Self {
        Self {
            writer: BufWriter::with_capacity(crate::wasm::STREAM_CHUNK_SIZE, ChunkSink { on_chunk, total }),
        }
    }
}

impl Write for ChunkLayer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.writer.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

impl Layer for ChunkLayer {
    fn finish_layer(mut self: Box<Self>) -> io::Result<Option<Box<dyn Layer>>> {
        self.writer.flush()?;
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// encoder layers
// ---------------------------------------------------------------------------

macro_rules! layer_wrapper {
    ($name:ident, $inner:ty, $finish:expr) => {
        pub struct $name($inner);
        impl Write for $name {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.write(buf)
            }
            fn flush(&mut self) -> io::Result<()> {
                self.0.flush()
            }
        }
        impl Layer for $name {
            fn finish_layer(self: Box<Self>) -> io::Result<Option<Box<dyn Layer>>> {
                let this = *self;
                let inner = ($finish)(this.0)?;
                Ok(Some(inner))
            }
        }
    };
}

layer_wrapper!(
    GzW,
    flate2::write::GzEncoder<Box<dyn Layer>>,
    |e: flate2::write::GzEncoder<Box<dyn Layer>>| e.finish()
);

layer_wrapper!(
    XzW,
    lzma_rust2::XzWriter<Box<dyn Layer>>,
    |e: lzma_rust2::XzWriter<Box<dyn Layer>>| e.finish().map_err(lzma_err)
);

layer_wrapper!(
    LzmaW,
    lzma_rust2::LzmaWriter<Box<dyn Layer>>,
    |e: lzma_rust2::LzmaWriter<Box<dyn Layer>>| e.finish().map_err(lzma_err)
);

layer_wrapper!(
    LzipW,
    lzma_rust2::LzipWriter<Box<dyn Layer>>,
    |e: lzma_rust2::LzipWriter<Box<dyn Layer>>| e.finish().map_err(lzma_err)
);

layer_wrapper!(
    Lz4W,
    lz4_flex::frame::FrameEncoder<Box<dyn Layer>>,
    |e: lz4_flex::frame::FrameEncoder<Box<dyn Layer>>| {
        e.finish().map_err(|e| io::Error::new(io::ErrorKind::Other, format!("lz4: {e:?}")))
    }
);

layer_wrapper!(
    SnappyW,
    snap::write::FrameEncoder<Box<dyn Layer>>,
    |e: snap::write::FrameEncoder<Box<dyn Layer>>| {
        e.into_inner().map_err(|e| io::Error::new(io::ErrorKind::Other, format!("snappy: {e:?}")))
    }
);

layer_wrapper!(
    BrotliW,
    brotli::CompressorWriter<Box<dyn Layer>>,
    |e: brotli::CompressorWriter<Box<dyn Layer>>| -> io::Result<Box<dyn Layer>> { Ok(e.into_inner()) }
);

fn lzma_err(e: impl std::fmt::Debug) -> io::Error {
    io::Error::new(io::ErrorKind::Other, format!("lzma: {e:?}"))
}

/// Wrap `inner` with the streaming encoder for `format`. Unsupported formats
/// (bz2's `banzai` is one-shot) return an error.
pub fn wrap_layer(format: CompressionFormat, inner: Box<dyn Layer>, level: Option<i16>) -> io::Result<Box<dyn Layer>> {
    Ok(match format {
        CompressionFormat::Gzip => {
            let lvl = level.map_or_else(Default::default, |l| flate2::Compression::new((l as u32).clamp(0, 9)));
            Box::new(GzW(flate2::write::GzEncoder::new(inner, lvl)))
        }
        CompressionFormat::Xz => {
            let options = level.map_or_else(Default::default, |l| lzma_rust2::XzOptions::with_preset((l as u32).clamp(0, 9)));
            Box::new(XzW(lzma_rust2::XzWriter::new(inner, options).map_err(lzma_err)?))
        }
        CompressionFormat::Lzma => {
            let options = level.map_or_else(Default::default, |l| lzma_rust2::LzmaOptions::with_preset((l as u32).clamp(0, 9)));
            Box::new(LzmaW(lzma_rust2::LzmaWriter::new_use_header(inner, &options, None).map_err(lzma_err)?))
        }
        CompressionFormat::Lzip => {
            let options = level.map_or_else(Default::default, |l| lzma_rust2::LzipOptions::with_preset((l as u32).clamp(0, 9)));
            Box::new(LzipW(lzma_rust2::LzipWriter::new(inner, options)))
        }
        CompressionFormat::Lz4 => Box::new(Lz4W(lz4_flex::frame::FrameEncoder::new(inner))),
        CompressionFormat::Snappy => Box::new(SnappyW(snap::write::FrameEncoder::new(inner))),
        CompressionFormat::Brotli => {
            let level = level.unwrap_or(11).clamp(0, 11) as u32;
            Box::new(BrotliW(brotli::CompressorWriter::new(inner, BUFFER_CAPACITY, level, 22)))
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "compressing to .{} cannot be streamed ({}); use the VFS flow (writeFile + compress)",
                    other.as_str(),
                    if matches!(other, CompressionFormat::Bzip) {
                        "the bzip2 encoder is one-shot"
                    } else {
                        "the encoder needs a seekable output"
                    }
                ),
            ))
        }
    })
}
