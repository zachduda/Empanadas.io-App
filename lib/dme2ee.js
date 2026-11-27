/*
 * End-to-end encryption for direct messages (the site's docs/MESSAGES.md). The website loads it as
 * window.dmE2EE; the desktop app requires the same file in its main process. The iOS app does the
 * same with CryptoKit (ios/Empanadas/Core/MessageCrypto.swift).
 *
 * Every device has its own P-256 ECDH key pair; the server keeps only the public halves. A
 * message is sealed with a fresh AES-256-GCM key, and that key is sealed for each device of both
 * players.
 *
 *   {"v":3, "epk": <one-time key>, "spk": <sending device's key>, "c": <iv|ciphertext|tag>,
 *    "k": {<device id>: <iv|sealed key|tag>}, "m": <commitment>}
 *
 * All base64url without padding. A device id is the first 16 bytes of SHA-256 over the raw public
 * key, in hex. c seals franking key (32 bytes) | length of the words (2 bytes, big-endian) | the
 * words (UTF-8) | zeros, to a multiple of PAD bytes, so its size says little about the words. m is
 * HMAC-SHA256 under the franking key over COMMIT\n<sender>\n<recipient>\n<nonce>\n<words>: a
 * reader checks it before showing anything, and a reader reporting the message hands the site the
 * words and the franking key, so the site can check that the sender sent exactly those words.
 * c is sealed with additional data CONTEXT_V3\n<sender>\n<recipient>\n<nonce>\n | m (the
 * players' uuids as 32 lowercase hex digits, the message's nonce), so an envelope moved to
 * another conversation, direction or message doesn't open. Each sealed key comes from HKDF-SHA256
 * over ECDH(one-time, device) | ECDH(sending device, device), salt epk | spk | the device's key,
 * info KEY_INFO_V3, with SHA-256(c) as additional data: only the sending device (or the device it
 * is for) could have made it, and only for that c.
 *
 * Still opened: v2 (no m, no padding; c bound to CONTEXT\n<sender>\n<recipient>\n<nonce>, info
 * KEY_INFO_V2) and v1 (no spk; the sealed key from ECDH(one-time, device) alone, salt epk | device
 * key, info KEY_INFO, nothing bound), from clients before them.
 */
(function (root, factory) {
    "use strict";
    if (typeof module === "object" && module.exports) {
        module.exports = factory(globalThis.crypto);
    } else {
        root.dmE2EE = factory(root.crypto);
    }
})(typeof self !== "undefined" ? self : this, function (crypto) {
    "use strict";

    const KEY_INFO = "empanadas-dm/v1/key";
    const KEY_INFO_V2 = "empanadas-dm/v2/key";
    const KEY_INFO_V3 = "empanadas-dm/v3/key";
    const CONTEXT = "empanadas-dm/v2";
    const CONTEXT_V3 = "empanadas-dm/v3";
    const COMMIT = "empanadas-dm/v3/commit";
    // What v3 pads to (DM_PAD on the site).
    const PAD = 256;
    // The longest message, as the site counts it (DM_MAX_LENGTH, Unicode code points).
    const MAX_CHARS = 1000;
    const ECDH = { name: "ECDH", namedCurve: "P-256" };
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    // v3's words are exactly what was committed to: nothing replaced, nothing dropped.
    const exact = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

    function supported() {
        return !!(crypto && crypto.subtle && crypto.getRandomValues);
    }

    function toB64u(bytes) {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function fromB64u(text) {
        if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("bad_payload");
        let padded = text.replace(/-/g, "+").replace(/_/g, "/");
        while (padded.length % 4 !== 0) padded += "=";
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function concat(...parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        return out;
    }

    function random(n) {
        return crypto.getRandomValues(new Uint8Array(n));
    }

    /**
     * A message as the site keeps plain text (dmBody()): Unix line ends, a tab as a space, no
     * control characters but the line break, none that reorder the text around them, no spaces
     * at the end of a line, at most one blank line in a row, nothing around it. The site can't
     * tidy what it can't read, so the sender does before sealing and every reader after opening.
     */
    function tidy(text) {
        return String(text === undefined || text === null ? "" : text)
            .replace(/\r\n?/g, "\n").replace(/\t/g, " ")
            .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
            .replace(/[ \u00A0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    // How long the site counts a message as: code points, not UTF-16 units.
    function length(text) {
        return Array.from(String(text)).length;
    }

    // What a reader shows: tidied, and no longer than the site would have taken it.
    function shown(text) {
        const out = tidy(text);
        if (!out) return "\u2026";
        const chars = Array.from(out);
        return chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS - 1).join("").trimEnd() + "\u2026" : out;
    }

    function player(id) {
        return String(id || "").toLowerCase().replace(/-/g, "");
    }

    function named(ctx) {
        if (!ctx || !/^[0-9a-f]{32}$/.test(player(ctx.sender)) || !/^[0-9a-f]{32}$/.test(player(ctx.recipient))) throw new Error("bad_context");
        return player(ctx.sender) + "\n" + player(ctx.recipient) + "\n" + String(ctx.nonce || "");
    }

    // What c is bound to: who sent it to whom, under which nonce (and in v3, m).
    function context(ctx) {
        return enc.encode(CONTEXT + "\n" + named(ctx));
    }

    function contextV3(ctx, m) {
        return concat(enc.encode(CONTEXT_V3 + "\n" + named(ctx) + "\n"), m);
    }

    // What m is over, for words already UTF-8.
    function committed(ctx, words) {
        return concat(enc.encode(COMMIT + "\n" + named(ctx) + "\n"), words);
    }

    async function hmacKey(raw) {
        return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    }

    // franking key | length | words | zeros, to a multiple of PAD.
    function padded(franking, words) {
        if (words.length > 0xFFFF) throw new Error("too_long");
        const size = Math.ceil((34 + words.length) / PAD) * PAD;
        const out = new Uint8Array(size);
        out.set(franking, 0);
        out[32] = words.length >> 8;
        out[33] = words.length & 0xFF;
        out.set(words, 34);
        return out;
    }

    // The franking key and the words of an opened v3 c, or throws.
    function unpadded(plain) {
        if (plain.length < PAD || plain.length % PAD !== 0) throw new Error("bad_payload");
        const n = (plain[32] << 8) | plain[33];
        if (34 + n > plain.length) throw new Error("bad_payload");
        for (let i = 34 + n; i < plain.length; i++) if (plain[i] !== 0) throw new Error("bad_payload");
        return { franking: plain.slice(0, 32), words: plain.slice(34, 34 + n) };
    }

    async function deviceId(publicKey) {
        const raw = typeof publicKey === "string" ? fromB64u(publicKey) : publicKey;
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
        return Array.from(hash.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    }

    // extractable: the desktop app keeps its key in a file; a browser keeps the CryptoKey itself.
    async function newDeviceKey(extractable) {
        const pair = await crypto.subtle.generateKey(ECDH, !!extractable, ["deriveBits"]);
        const publicKey = toB64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
        return { privateKey: pair.privateKey, publicKey, device: await deviceId(publicKey) };
    }

    async function exportPrivate(privateKey) {
        return crypto.subtle.exportKey("jwk", privateKey);
    }

    async function importPrivate(jwk) {
        return crypto.subtle.importKey("jwk", jwk, ECDH, true, ["deriveBits"]);
    }

    async function ecdh(privateKey, otherRaw) {
        const other = await crypto.subtle.importKey("raw", otherRaw, ECDH, false, []);
        return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: other }, privateKey, 256));
    }

    async function hkdfKey(ikm, salt, info) {
        const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, base, 256);
        return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
    }

    async function wrapKey(privateKey, otherRaw, salt) {
        return hkdfKey(await ecdh(privateKey, otherRaw), salt, KEY_INFO);
    }

    // v2: ECDH(a, x) | ECDH(b, y). Sealing, (one-time, device) and (sending device, device);
    // opening, (device, one-time) and (device, sending device).
    async function wrapKeyV2(a, xRaw, b, yRaw, salt, info) {
        return hkdfKey(concat(await ecdh(a, xRaw), await ecdh(b, yRaw)), salt, info || KEY_INFO_V2);
    }

    function gcmParams(iv, aad) {
        return aad ? { name: "AES-GCM", iv, additionalData: aad } : { name: "AES-GCM", iv };
    }

    async function gcmSeal(key, plain, aad) {
        const iv = random(12);
        return concat(iv, new Uint8Array(await crypto.subtle.encrypt(gcmParams(iv, aad), key, plain)));
    }

    async function gcmOpen(key, sealed, aad) {
        return new Uint8Array(await crypto.subtle.decrypt(gcmParams(sealed.subarray(0, 12), aad), key, sealed.subarray(12)));
    }

    async function sha256(bytes) {
        return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    }

    /**
     * Seal text for every device in `keys` ([{device, key}], both players'). A key whose id
     * doesn't match it is left out. With `from` ({from: this device's key, sender, recipient,
     * nonce}) a v3 envelope, which every client from v3 on makes; without, v1 (tests only).
     */
    async function seal(text, keys, from) {
        const devices = [];
        const seen = new Set();
        for (const k of keys || []) {
            if (!k || typeof k.key !== "string") continue;
            let raw;
            try { raw = fromB64u(k.key); } catch (err) { continue; }
            if (raw.length !== 65 || raw[0] !== 4) continue;
            const id = await deviceId(raw);
            if (id !== k.device || seen.has(id)) continue;
            seen.add(id);
            devices.push({ id, raw });
        }
        if (!devices.length) throw new Error("no_keys");
        const words = from ? tidy(text) : String(text);
        if (from && !words) throw new Error("empty");
        const spk = from ? fromB64u(from.from.publicKey) : null;
        let plain = enc.encode(words), aad = null, m = null;
        if (from) {
            const franking = random(32);
            m = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(franking), committed(from, plain)));
            aad = contextV3(from, m);
            plain = padded(franking, plain);
            franking.fill(0);
        }
        const messageKeyBytes = random(32);
        const messageKey = await crypto.subtle.importKey("raw", messageKeyBytes, "AES-GCM", false, ["encrypt"]);
        const c = await gcmSeal(messageKey, plain, aad);
        const once = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
        const epk = new Uint8Array(await crypto.subtle.exportKey("raw", once.publicKey));
        const bound = from ? await sha256(c) : null;
        const k = {};
        for (const d of devices) {
            const wrap = from
                ? await wrapKeyV2(once.privateKey, d.raw, from.from.privateKey, d.raw, concat(epk, spk, d.raw), KEY_INFO_V3)
                : await wrapKey(once.privateKey, d.raw, concat(epk, d.raw));
            k[d.id] = toB64u(await gcmSeal(wrap, messageKeyBytes, bound));
        }
        messageKeyBytes.fill(0);
        return JSON.stringify(from
            ? { v: 3, epk: toB64u(epk), spk: toB64u(spk), c: toB64u(c), k, m: toB64u(m) }
            : { v: 1, epk: toB64u(epk), c: toB64u(c), k });
    }

    /**
     * Open an envelope with this device's key ({privateKey, publicKey, device}). A v2 or v3 one
     * needs `ctx` ({sender, recipient, nonce}: who the site says sent it to whom), and opens only
     * if that is what it was sealed as; a v3 one also only if its words are what m commits to.
     * Throws "not_for_device" when it wasn't sealed for this device (sent before it had a key),
     * and "bad_payload" when it is damaged, was tampered with or moved.
     *
     * @return {Promise<{text: string, words: string, franking: string|null, v: number}>} text
     * tidied as the site would have kept it (shown()), for showing; words exactly as sealed and
     * franking (v3) for a report the site can check.
     */
    async function opening(cipher, mine, ctx) {
        let data;
        try { data = typeof cipher === "string" ? JSON.parse(cipher) : cipher; } catch (err) { throw new Error("bad_payload"); }
        if (!data || ![1, 2, 3].includes(data.v) || !data.k || typeof data.k !== "object") throw new Error("bad_payload");
        const sealedKey = data.k[mine.device];
        if (typeof sealedKey !== "string") throw new Error("not_for_device");
        try {
            const epk = fromB64u(data.epk);
            const own = fromB64u(mine.publicKey);
            const c = fromB64u(data.c);
            let messageKeyBytes, aad = null, m = null;
            if (data.v >= 2) {
                const spk = fromB64u(data.spk);
                if (spk.length !== 65 || spk[0] !== 4) throw new Error("bad_payload");
                if (data.v === 3) {
                    m = fromB64u(data.m);
                    if (m.length !== 32) throw new Error("bad_payload");
                    aad = contextV3(ctx, m);
                } else {
                    aad = context(ctx);
                }
                const wrap = await wrapKeyV2(mine.privateKey, epk, mine.privateKey, spk, concat(epk, spk, own), data.v === 3 ? KEY_INFO_V3 : KEY_INFO_V2);
                messageKeyBytes = await gcmOpen(wrap, fromB64u(sealedKey), await sha256(c));
            } else {
                messageKeyBytes = await gcmOpen(await wrapKey(mine.privateKey, epk, concat(epk, own)), fromB64u(sealedKey));
            }
            const messageKey = await crypto.subtle.importKey("raw", messageKeyBytes, "AES-GCM", false, ["decrypt"]);
            messageKeyBytes.fill(0);
            const plain = await gcmOpen(messageKey, c, aad);
            if (data.v !== 3) {
                const words = dec.decode(plain);
                return { text: shown(words), words, franking: null, v: data.v };
            }
            const inside = unpadded(plain);
            if (!(await crypto.subtle.verify("HMAC", await hmacKey(inside.franking), m, committed(ctx, inside.words)))) throw new Error("bad_payload");
            const words = exact.decode(inside.words);
            return { text: shown(words), words, franking: toB64u(inside.franking), v: 3 };
        } catch (err) {
            throw new Error("bad_payload");
        }
    }

    // What opening() shows.
    async function open(cipher, mine, ctx) {
        return (await opening(cipher, mine, ctx)).text;
    }

    // The device that sealed a v2 or v3 envelope (its id), or null for v1 and anything else.
    async function sealedBy(cipher) {
        try {
            const data = typeof cipher === "string" ? JSON.parse(cipher) : cipher;
            return data && (data.v === 2 || data.v === 3) ? await deviceId(data.spk) : null;
        } catch (err) {
            return null;
        }
    }

    return { supported, deviceId, newDeviceKey, exportPrivate, importPrivate, seal, open, opening, sealedBy, tidy, length, shown, MAX_CHARS, PAD, toB64u, fromB64u };
});
