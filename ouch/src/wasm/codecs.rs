//! Streaming (de)compression of single (non-archive) formats, driven from
//! memory. This mirrors the codec chains in `commands/{compress,decompress}.rs`
//! but only uses pure-Rust backends available on `wasm32-unknown-unknown`
//! (no bzip2/zstd/bzip3, which need a C toolchain).

use std::io::{Cursor, Read, Write};

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
            .hint("Supported formats: tar, zip, 7z, gz, xz, lzma, lz, lz4, sz, br"),
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
        other => Err(unavailable(other.as_str())),
    }
}

/// Decompress `input` with a single non-archive format.
pub fn decode(format: CompressionFormat, input: &[u8]) -> Result<Vec<u8>> {
    let reader = Cursor::new(input);
    let decoder: Box<dyn Read> = match format {
        CompressionFormat::Gzip => Box::new(flate2::read::MultiGzDecoder::new(reader)),
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
        other => return Err(unavailable(other.as_str())),
    };

    let mut out = Vec::new();
    copy_limited_decompression(decoder, &mut out)?;
    Ok(out)
}
