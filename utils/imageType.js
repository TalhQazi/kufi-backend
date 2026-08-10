/**
 * Detect an image's real format from its bytes.
 *
 * Uploads stored the type the browser reported, and for most of the catalogue that was
 * `application/octet-stream` — which browsers may refuse to render in an `<img>`. The
 * bytes themselves are unambiguous, so the declared type is only trusted when it is
 * actually an image type.
 */

/** @returns {string|null} a concrete image mime type, or null if the bytes are not an image. */
function sniffImageMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';

    // GIF87a / GIF89a
    if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';

    // RIFF....WEBP
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';

    // ISO-BMFF brands: ....ftyp{avif|heic|heif|mif1}
    if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
        if (brand.startsWith('heic') || brand.startsWith('heix')) return 'image/heic';
        if (brand.startsWith('mif1') || brand.startsWith('heif')) return 'image/heif';
    }

    // BMP
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';

    // SVG (text)
    const head = buffer.subarray(0, 256).toString('utf8').trimStart();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';

    return null;
}

/**
 * The best Content-Type for these bytes: the sniffed format, else the declared one when
 * it is a real image type, else a safe default.
 */
function resolveImageMime(buffer, declared) {
    const sniffed = sniffImageMime(buffer);
    if (sniffed) return sniffed;
    const claimed = String(declared || '').trim().toLowerCase();
    if (claimed.startsWith('image/')) return claimed;
    return 'application/octet-stream';
}

module.exports = { sniffImageMime, resolveImageMime };
