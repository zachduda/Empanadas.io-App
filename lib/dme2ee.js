/*
 * End-to-end encryption for direct messages (the site's docs/MESSAGES.md). The website loads it as
 * window.dmE2EE; the desktop app requires the same file in its main process. The iOS app does the
 * same with CryptoKit (ios/Empanadas/Core/MessageCrypto.swift).
 *
 * Every device has its own P-256 ECDH key pair; the server keeps only the public halves. A
 * message is sealed with a fresh AES-256-GCM key, and that key is sealed for each device of both
 * players with ECDH from a one-time key pair, HKDF-SHA256 and AES-256-GCM.
 *
 *   {"v":1, "epk": <one-time public key>, "c": <iv|ciphertext|tag>, "k": {<device id>: <iv|sealed key|tag>}}
 *
 * All base64url without padding. A device id is the first 16 bytes of SHA-256 over the raw public
 * key, in hex. HKDF's salt is the one-time key then the device's key, its info KEY_INFO.
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
    const ECDH = { name: "ECDH", namedCurve: "P-256" };
    const enc = new TextEncoder();
    const dec = new TextDecoder();

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

    async function wrapKey(privateKey, otherRaw, salt) {
        const other = await crypto.subtle.importKey("raw", otherRaw, ECDH, false, []);
        const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: other }, privateKey, 256);
        const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(KEY_INFO) }, base, 256);
        return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
    }

    async function gcmSeal(key, plain) {
        const iv = random(12);
        return concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain)));
    }

    async function gcmOpen(key, sealed) {
        return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) }, key, sealed.subarray(12)));
    }

    /**
     * Seal text for every device in `keys` ([{device, key}], both players'). A key whose id
     * doesn't match it is left out, so the server can't swap one device's key for another's.
     */
    async function seal(text, keys) {
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
        const messageKeyBytes = random(32);
        const messageKey = await crypto.subtle.importKey("raw", messageKeyBytes, "AES-GCM", false, ["encrypt"]);
        const c = await gcmSeal(messageKey, enc.encode(String(text)));
        const once = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
        const epk = new Uint8Array(await crypto.subtle.exportKey("raw", once.publicKey));
        const k = {};
        for (const d of devices) {
            k[d.id] = toB64u(await gcmSeal(await wrapKey(once.privateKey, d.raw, concat(epk, d.raw)), messageKeyBytes));
        }
        messageKeyBytes.fill(0);
        return JSON.stringify({ v: 1, epk: toB64u(epk), c: toB64u(c), k });
    }

    /**
     * Open an envelope with this device's key ({privateKey, publicKey, device}). Throws
     * "not_for_device" when it wasn't sealed for this device (sent before it had a key), and
     * "bad_payload" when it is damaged or was tampered with.
     */
    async function open(cipher, mine) {
        let data;
        try { data = typeof cipher === "string" ? JSON.parse(cipher) : cipher; } catch (err) { throw new Error("bad_payload"); }
        if (!data || data.v !== 1 || !data.k || typeof data.k !== "object") throw new Error("bad_payload");
        const sealedKey = data.k[mine.device];
        if (typeof sealedKey !== "string") throw new Error("not_for_device");
        try {
            const epk = fromB64u(data.epk);
            const own = fromB64u(mine.publicKey);
            const messageKeyBytes = await gcmOpen(await wrapKey(mine.privateKey, epk, concat(epk, own)), fromB64u(sealedKey));
            const messageKey = await crypto.subtle.importKey("raw", messageKeyBytes, "AES-GCM", false, ["decrypt"]);
            messageKeyBytes.fill(0);
            return dec.decode(await gcmOpen(messageKey, fromB64u(data.c)));
        } catch (err) {
            throw new Error("bad_payload");
        }
    }

    return { supported, deviceId, newDeviceKey, exportPrivate, importPrivate, seal, open, toB64u, fromB64u };
});
