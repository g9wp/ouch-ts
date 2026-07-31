//! Streaming (de)compression of single (non-archive) formats, driven from
//! memory. This mirrors the codec chains in `commands/{compress,decompress}.rs`
//! but only uses pure-Rust backends available on `wasm32-unknown-unknown`
//! (no bzip2/zstd/bzip3, which need a C toolchain).

use std::io::{self, Cursor, Read, Write};

use crate::{
    BUFFER_CAPACITY, Result,
    error::FinalError,
    extension::CompressionFormat,
    non_archive::lz4::MultiFrameLz4Decoder,
    utils::{LZMA_MEMLIMIT_BYTES, copy_limited_decompression},
};

/// Error returned for a format that is not available in the WASM build.
pub fn unavailable(format: &str) -> crate::Error {
    crate::Error::Custom {
        reason: FinalError::with_title(format!("The format '.{format}' is not supported by this build (WASM)."))
            .hint("Supported formats: tar, zip, 7z, gz, xz, lzma, lz, lz4, sz, br, bz2, zst (decode only), rar (decode only)"),
    }
}

/// Error returned for formats that are only decodable in the WASM build.
fn decode_only(format: &str) -> crate::Error {
    crate::Error::Custom {
        reason: FinalError::with_title(format!(
            "Compressing to '.{format}' is not available in the WASM build (decode only)."
        )),
    }
}

/// Compress `input` with a single non-archive format.
pub fn encode(format: CompressionFormat, input: &[u8], level: Option<i16>) -> Result<Vec<u8>> {
    let cursor = Cursor::new(Vec::new());
    match format {
        CompressionFormat::Gzip => {
            let level = level.map_or_else(Default::default, |l| flate2::Compression::new((l as u32).clamp(0, 9)));
            let mut encoder = flate2::write::GzEncoder::new(cursor, level);
            encoder.write_all(input)?;
            Ok(encoder.finish()?.into_inner())
        }
        CompressionFormat::Bzip => {
            use std::io::BufWriter;
            use std::{cell::RefCell, rc::Rc};

            // banzai::encode consumes the BufWriter and only returns the input
            // byte count, so capture the output through shared storage: the
            // BufWriter flushes into it when dropped.
            #[derive(Clone)]
            struct Capture(Rc<RefCell<Vec<u8>>>);
            impl Write for Capture {
                fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                    self.0.borrow_mut().extend_from_slice(buf);
                    Ok(buf.len())
                }
                fn flush(&mut self) -> io::Result<()> {
                    Ok(())
                }
            }

            let shared = Rc::new(RefCell::new(Vec::new()));
            let block_level = level.map_or(9, |l| (l as usize).clamp(1, 9));
            banzai::encode(Cursor::new(input), BufWriter::new(Capture(shared.clone())), block_level)
                .map_err(|e| crate::Error::Custom {
                    reason: FinalError::with_title("bzip2 compression failed").detail(format!("{e:?}")),
                })?;
            Ok(shared.borrow().clone())
        }
        CompressionFormat::Xz => {
            let options = level.map_or_else(Default::default, |l| {
                lzma_rust2::XzOptions::with_preset((l as u32).clamp(0, 9))
            });
            let mut writer = lzma_rust2::XzWriter::new(cursor, options)?;
            writer.write_all(input)?;
            Ok(writer.finish()?.into_inner())
        }
        CompressionFormat::Lzma => {
            let options = level.map_or_else(Default::default, |l| {
                lzma_rust2::LzmaOptions::with_preset((l as u32).clamp(0, 9))
            });
            let mut writer = lzma_rust2::LzmaWriter::new_use_header(cursor, &options, None)?;
            writer.write_all(input)?;
            Ok(writer.finish()?.into_inner())
        }
        CompressionFormat::Lzip => {
            let options = level.map_or_else(Default::default, |l| {
                lzma_rust2::LzipOptions::with_preset((l as u32).clamp(0, 9))
            });
            let mut writer = lzma_rust2::LzipWriter::new(cursor, options);
            writer.write_all(input)?;
            Ok(writer.finish()?.into_inner())
        }
        CompressionFormat::Lz4 => {
            let mut encoder = lz4_flex::frame::FrameEncoder::new(cursor);
            encoder.write_all(input)?;
            encoder
                .finish()
                .map(|cursor| cursor.into_inner())
                .map_err(|e| crate::Error::Lz4Error {
                    reason: format!("{e:?}"),
                })
        }
        CompressionFormat::Snappy => {
            let mut encoder = snap::write::FrameEncoder::new(cursor);
            encoder.write_all(input)?;
            encoder
                .into_inner()
                .map(|cursor| cursor.into_inner())
                .map_err(|e| crate::Error::IoError {
                    reason: format!("snappy: {e:?}"),
                })
        }
        CompressionFormat::Brotli => {
            let level = level.unwrap_or(11).clamp(0, 11) as u32; // Same as brotli CLI: best by default
            let win_size = 22; // 2^22 = 4 MiB window
            let mut encoder = brotli::CompressorWriter::new(cursor, BUFFER_CAPACITY, level, win_size);
            encoder.write_all(input)?;
            Ok(encoder.into_inner().into_inner())
        }
        CompressionFormat::Zstd => Err(decode_only("zst")),
        other => Err(unavailable(other.as_str())),
    }
}

/// Decompress `input` with a single non-archive format.
pub fn decode(format: CompressionFormat, input: &[u8]) -> Result<Vec<u8>> {
    let reader = Cursor::new(input);
    let decoder: Box<dyn Read> = match format {
        CompressionFormat::Gzip => Box::new(flate2::read::MultiGzDecoder::new(reader)),
        CompressionFormat::Bzip => Box::new(bzip2_rs::DecoderReader::new(reader)),
        CompressionFormat::Xz => Box::new(lzma_rust2::XzReader::new(reader, true)),
        CompressionFormat::Lzma => Box::new(lzma_rust2::LzmaReader::new_mem_limit(
            reader,
            LZMA_MEMLIMIT_BYTES,
            None,
        )?),
        CompressionFormat::Lzip => Box::new(lzma_rust2::LzipReader::new(reader)),
        CompressionFormat::Lz4 => Box::new(MultiFrameLz4Decoder::new(reader)),
        CompressionFormat::Snappy => Box::new(snap::read::FrameDecoder::new(reader)),
        CompressionFormat::Brotli => Box::new(brotli::Decompressor::new(reader, BUFFER_CAPACITY)),
        // ruzstd decodes a single zstd frame (concatenated-frame files need
        // manual frame skipping; rare in practice).
        CompressionFormat::Zstd => Box::new(
            ruzstd::decoding::StreamingDecoder::new(reader).map_err(|e| crate::Error::Custom {
                reason: FinalError::with_title("failed to decode zstd header").detail(format!("{e:?}")),
            })?,
        ),
        other => return Err(unavailable(other.as_str())),
    };

    let mut out = Vec::new();
    copy_limited_decompression(decoder, &mut out)?;
    Ok(out)
}
