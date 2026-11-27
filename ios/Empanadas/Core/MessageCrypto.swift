import CryptoKit
import Foundation
import Security

// End-to-end encrypted direct messages, as the site's
// html/Content/Code/JS/dm_e2ee.js and the desktop app's lib/dme2ee.js do it.
// Every device has its own P-256 key pair; the site keeps only the public
// halves. A message is sealed with a fresh AES-256-GCM key, and that key is
// sealed for each device of both players with ECDH from a one-time key pair,
// HKDF-SHA256 (salt: the one-time key then the device's, info: keyInfo) and
// AES-256-GCM:
//
//     {"v":1, "epk": <one-time key>, "c": <nonce|ciphertext|tag>, "k": {<device id>: <nonce|sealed key|tag>}}
//
// All base64url without padding. A device id is the first 16 bytes of
// SHA-256 over the raw (x9.63) public key, in hex.

enum MessageCrypto {
    static let keyInfo = Data("empanadas-dm/v1/key".utf8)

    /// This device's key for one account.
    struct DeviceKey {
        let privateKey: P256.KeyAgreement.PrivateKey

        var rawPublicKey: Data { privateKey.publicKey.x963Representation }
        var publicKey: String { MessageCrypto.base64URL(rawPublicKey) }
        var device: String { MessageCrypto.deviceID(rawPublicKey) }
    }

    enum Failure: Error, Equatable {
        /// Nobody to seal it for.
        case noKeys
        /// Sealed before this device had a key, or for other devices only.
        case notForDevice
        /// Damaged, tampered with, or not an envelope.
        case badPayload
    }

    static func deviceID(_ rawPublicKey: Data) -> String {
        SHA256.hash(data: rawPublicKey).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// Seals `text` for every device in `recipients` (both players'). A key
    /// whose id doesn't match it is left out, so the site can't swap one
    /// device's key for another's.
    static func seal(_ text: String, for recipients: [MessageKeys.Device]) throws -> String {
        var targets: [(id: String, raw: Data, key: P256.KeyAgreement.PublicKey)] = []
        var seen = Set<String>()
        for recipient in recipients {
            guard let raw = data(base64URL: recipient.key), raw.count == 65, raw.first == 4,
                  let key = try? P256.KeyAgreement.PublicKey(x963Representation: raw) else { continue }
            let id = deviceID(raw)
            guard id == recipient.device, seen.insert(id).inserted else { continue }
            targets.append((id, raw, key))
        }
        guard !targets.isEmpty else { throw Failure.noKeys }

        let messageKey = SymmetricKey(size: .bits256)
        guard let body = try AES.GCM.seal(Data(text.utf8), using: messageKey).combined else { throw Failure.badPayload }
        let once = P256.KeyAgreement.PrivateKey()
        let epk = once.publicKey.x963Representation
        let keyBytes = messageKey.withUnsafeBytes { Data($0) }
        var sealedKeys: [String: String] = [:]
        for target in targets {
            let wrap = try wrapKey(once, target.key, salt: epk + target.raw)
            guard let sealed = try AES.GCM.seal(keyBytes, using: wrap).combined else { throw Failure.badPayload }
            sealedKeys[target.id] = base64URL(sealed)
        }
        let envelope: [String: Any] = ["v": 1, "epk": base64URL(epk), "c": base64URL(body), "k": sealedKeys]
        let json = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        return String(decoding: json, as: UTF8.self)
    }

    /// The words in an envelope, opened with this device's key.
    static func open(_ cipher: String, with key: DeviceKey) throws -> String {
        guard let object = try? JSONSerialization.jsonObject(with: Data(cipher.utf8)) as? [String: Any],
              (object["v"] as? Int) == 1, let sealedKeys = object["k"] as? [String: Any] else { throw Failure.badPayload }
        guard let sealedKey = sealedKeys[key.device] as? String else { throw Failure.notForDevice }
        do {
            guard let epk = data(base64URL: object["epk"] as? String), let wrapped = data(base64URL: sealedKey),
                  let body = data(base64URL: object["c"] as? String) else { throw Failure.badPayload }
            let other = try P256.KeyAgreement.PublicKey(x963Representation: epk)
            let wrap = try wrapKey(key.privateKey, other, salt: epk + key.rawPublicKey)
            let messageKey = SymmetricKey(data: try AES.GCM.open(AES.GCM.SealedBox(combined: wrapped), using: wrap))
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: body), using: messageKey)
            guard let text = String(data: plain, encoding: .utf8) else { throw Failure.badPayload }
            return text
        } catch {
            throw Failure.badPayload
        }
    }

    private static func wrapKey(_ privateKey: P256.KeyAgreement.PrivateKey, _ publicKey: P256.KeyAgreement.PublicKey,
                                salt: Data) throws -> SymmetricKey {
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
        return shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: keyInfo, outputByteCount: 32)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func data(base64URL text: String?) -> Data? {
        guard let text, !text.isEmpty,
              text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded += "=" }
        return Data(base64Encoded: padded)
    }
}

/// This device's message key for each account, in the Keychain. Readable
/// after the first unlock (a reply from a notification seals in the
/// background) and never copied to another device or a backup.
enum MessageKeychain {
    private static let service = "io.empanadas.app.message-key"

    /// Tests only: kept here instead, as an unsigned test host has no Keychain.
    nonisolated(unsafe) static var inMemory: [Int: Data]?

    static func key(for account: Int) -> MessageCrypto.DeviceKey? {
        guard account > 0 else { return nil }
        if let raw = read(account), let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw) {
            return MessageCrypto.DeviceKey(privateKey: key)
        }
        let fresh = P256.KeyAgreement.PrivateKey()
        guard store(fresh.rawRepresentation, for: account) else { return nil }
        return MessageCrypto.DeviceKey(privateKey: fresh)
    }

    private static func query(_ account: Int) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: String(account)]
    }

    private static func read(_ account: Int) -> Data? {
        if let inMemory { return inMemory[account] }
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private static func store(_ raw: Data, for account: Int) -> Bool {
        if inMemory != nil { inMemory?[account] = raw; return true }
        SecItemDelete(query(account) as CFDictionary)
        var q = query(account)
        q[kSecValueData as String] = raw
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }
}
