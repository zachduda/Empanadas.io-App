import CryptoKit
import Foundation
import Security

// End-to-end encrypted direct messages, as the site's
// html/Content/Code/JS/dm_e2ee.js and the desktop app's lib/dme2ee.js do it.
// Every device has its own P-256 key pair; the site keeps only the public
// halves. A message is sealed with a fresh AES-256-GCM key, and that key is
// sealed for each device of both players:
//
//     {"v":2, "epk": <one-time key>, "spk": <sending device's key>, "c": <nonce|ciphertext|tag>, "k": {<device id>: <nonce|sealed key|tag>}}
//
// All base64url without padding. A device id is the first 16 bytes of
// SHA-256 over the raw (x9.63) public key, in hex. c is sealed with
// additional data Context.data ("empanadas-dm/v2", the sender's and the
// recipient's uuids and the message's nonce, a line each), so an envelope
// moved to another conversation, direction or message doesn't open. Each
// sealed key comes from HKDF-SHA256 over ECDH(one-time, device) |
// ECDH(sending device, device) (salt: epk | spk | the device's key, info:
// keyInfoV2) with SHA-256(c) as additional data: only the sending device (or
// the device it is for) could have made it, and only for that c.
//
// v1 (no spk; ECDH(one-time, device) alone, salt epk | device key, info
// keyInfo, nothing bound) still opens, from clients before v2.

enum MessageCrypto {
    static let keyInfo = Data("empanadas-dm/v1/key".utf8)
    static let keyInfoV2 = Data("empanadas-dm/v2/key".utf8)

    /// Who the site says sent a message to whom, under which nonce: what a v2
    /// envelope is bound to.
    struct Context: Equatable, Sendable {
        let sender: String
        let recipient: String
        let nonce: String

        init(sender: String, recipient: String, nonce: String?) {
            self.sender = Self.player(sender)
            self.recipient = Self.player(recipient)
            self.nonce = nonce ?? ""
        }

        static func player(_ id: String) -> String {
            id.replacingOccurrences(of: "-", with: "").lowercased()
        }

        var isValid: Bool {
            [sender, recipient].allSatisfy { $0.count == 32 && $0.allSatisfy(\.isHexDigit) }
        }

        var data: Data {
            Data(("empanadas-dm/v2\n" + sender + "\n" + recipient + "\n" + nonce).utf8)
        }
    }

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
    /// whose id doesn't match it is left out. With `sender` (this device's
    /// key) and `context`, a v2 envelope, which the app always makes; without,
    /// v1 (tests only).
    static func seal(_ text: String, for recipients: [MessageKeys.Device],
                     from sender: DeviceKey? = nil, context: Context? = nil) throws -> String {
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
        if sender != nil {
            guard let context, context.isValid else { throw Failure.badPayload }
        }
        let words = sender == nil ? text : MessageText.cleaned(text)

        let messageKey = SymmetricKey(size: .bits256)
        let box: AES.GCM.SealedBox
        if let context, sender != nil {
            box = try AES.GCM.seal(Data(words.utf8), using: messageKey, authenticating: context.data)
        } else {
            box = try AES.GCM.seal(Data(words.utf8), using: messageKey)
        }
        guard let body = box.combined else { throw Failure.badPayload }
        let once = P256.KeyAgreement.PrivateKey()
        let epk = once.publicKey.x963Representation
        let keyBytes = messageKey.withUnsafeBytes { Data($0) }
        let bound = Data(SHA256.hash(data: body))
        var sealedKeys: [String: String] = [:]
        for target in targets {
            let sealed: Data?
            if let sender {
                let wrap = try wrapKeyV2(once, target.key, sender.privateKey, target.key, salt: epk + sender.rawPublicKey + target.raw)
                sealed = try AES.GCM.seal(keyBytes, using: wrap, authenticating: bound).combined
            } else {
                sealed = try AES.GCM.seal(keyBytes, using: try wrapKey(once, target.key, salt: epk + target.raw)).combined
            }
            guard let sealed else { throw Failure.badPayload }
            sealedKeys[target.id] = base64URL(sealed)
        }
        var envelope: [String: Any] = ["v": sender == nil ? 1 : 2, "epk": base64URL(epk), "c": base64URL(body), "k": sealedKeys]
        if let sender { envelope["spk"] = sender.publicKey }
        let json = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        return String(decoding: json, as: UTF8.self)
    }

    /// The words in an envelope, opened with this device's key and tidied as
    /// the site would have kept them (MessageText.shown). A v2 one needs
    /// `context`, what the site says it is, and opens only if it was sealed as
    /// that.
    static func open(_ cipher: String, with key: DeviceKey, context: Context? = nil) throws -> String {
        guard let object = try? JSONSerialization.jsonObject(with: Data(cipher.utf8)) as? [String: Any],
              let version = object["v"] as? Int, version == 1 || version == 2,
              let sealedKeys = object["k"] as? [String: Any] else { throw Failure.badPayload }
        guard let sealedKey = sealedKeys[key.device] as? String else { throw Failure.notForDevice }
        do {
            guard let epk = data(base64URL: object["epk"] as? String), let wrapped = data(base64URL: sealedKey),
                  let body = data(base64URL: object["c"] as? String) else { throw Failure.badPayload }
            let other = try P256.KeyAgreement.PublicKey(x963Representation: epk)
            let plain: Data
            if version == 2 {
                guard let context, context.isValid, let spkRaw = data(base64URL: object["spk"] as? String),
                      spkRaw.count == 65, spkRaw.first == 4 else { throw Failure.badPayload }
                let spk = try P256.KeyAgreement.PublicKey(x963Representation: spkRaw)
                let wrap = try wrapKeyV2(key.privateKey, other, key.privateKey, spk, salt: epk + spkRaw + key.rawPublicKey)
                let keyBytes = try AES.GCM.open(AES.GCM.SealedBox(combined: wrapped), using: wrap, authenticating: Data(SHA256.hash(data: body)))
                plain = try AES.GCM.open(AES.GCM.SealedBox(combined: body), using: SymmetricKey(data: keyBytes), authenticating: context.data)
            } else {
                let wrap = try wrapKey(key.privateKey, other, salt: epk + key.rawPublicKey)
                let messageKey = SymmetricKey(data: try AES.GCM.open(AES.GCM.SealedBox(combined: wrapped), using: wrap))
                plain = try AES.GCM.open(AES.GCM.SealedBox(combined: body), using: messageKey)
            }
            guard let text = String(data: plain, encoding: .utf8) else { throw Failure.badPayload }
            return MessageText.shown(text)
        } catch {
            throw Failure.badPayload
        }
    }

    /// v2: HKDF over ECDH(a, x) | ECDH(b, y). Sealing, (one-time, device) and
    /// (sending device, device); opening, (device, one-time) and (device,
    /// sending device).
    private static func wrapKeyV2(_ a: P256.KeyAgreement.PrivateKey, _ x: P256.KeyAgreement.PublicKey,
                                  _ b: P256.KeyAgreement.PrivateKey, _ y: P256.KeyAgreement.PublicKey,
                                  salt: Data) throws -> SymmetricKey {
        let first = try a.sharedSecretFromKeyAgreement(with: x).withUnsafeBytes { Data($0) }
        let second = try b.sharedSecretFromKeyAgreement(with: y).withUnsafeBytes { Data($0) }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: first + second), salt: salt,
                                      info: keyInfoV2, outputByteCount: 32)
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
///
/// A key is only ever made when the Keychain says there is none: any other
/// answer (locked before the first unlock, or anything else it can't do now)
/// is no key for now, asked again next time, and never a new key in place of
/// the one there, which would leave everything sealed for it unreadable here.
enum MessageKeychain {
    private static let service = "io.empanadas.app.message-key"

    /// Tests only: kept here instead, as an unsigned test host has no Keychain.
    nonisolated(unsafe) static var inMemory: [Int: Data]?
    /// Tests only: what the Keychain answers instead of the item, as a locked one would.
    nonisolated(unsafe) static var failReads: OSStatus?

    private enum Stored {
        case found(Data)
        case missing
        case unavailable
    }

    static func key(for account: Int) -> MessageCrypto.DeviceKey? {
        guard account > 0 else { return nil }
        switch read(account) {
        case .found(let raw):
            return (try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw)).map { MessageCrypto.DeviceKey(privateKey: $0) }
        case .unavailable:
            return nil
        case .missing:
            let fresh = P256.KeyAgreement.PrivateKey()
            switch add(fresh.rawRepresentation, for: account) {
            case errSecSuccess:
                return MessageCrypto.DeviceKey(privateKey: fresh)
            case errSecDuplicateItem:
                // Made meanwhile (a notification's reply, say): that one.
                guard case .found(let raw) = read(account) else { return nil }
                return (try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw)).map { MessageCrypto.DeviceKey(privateKey: $0) }
            default:
                return nil
            }
        }
    }

    private static func query(_ account: Int) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: String(account)]
    }

    private static func read(_ account: Int) -> Stored {
        if let failReads { return failReads == errSecItemNotFound ? .missing : .unavailable }
        if let inMemory { return inMemory[account].map(Stored.found) ?? .missing }
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        switch SecItemCopyMatching(q as CFDictionary, &item) {
        case errSecSuccess: return (item as? Data).map(Stored.found) ?? .unavailable
        case errSecItemNotFound: return .missing
        default: return .unavailable
        }
    }

    /// Added, never written over: errSecDuplicateItem when there is one.
    private static func add(_ raw: Data, for account: Int) -> OSStatus {
        if inMemory != nil {
            if inMemory?[account] != nil { return errSecDuplicateItem }
            inMemory?[account] = raw
            return errSecSuccess
        }
        var q = query(account)
        q[kSecValueData as String] = raw
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil)
    }
}
