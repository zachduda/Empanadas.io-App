import Foundation

// Direct messages between friends, from /v2/app/messages.php (the site's
// v2/_messages.php and docs/MESSAGES.md). Lenient, as the other answers are: a
// field the site adds or drops later must not cost the player the screen, and
// one bad row must not take the list with it.

/// The other player in a conversation (dmPerson()). Presence only for a friend.
struct MessagePerson: Decodable, Equatable, Hashable {
    /// Their profile id.
    var playerID = ""
    var username = ""
    var pfp: String?
    var defaultPfp = false
    var relation: Relationship = .stranger
    /// "online", "idle" or "offline"; nil unless friends.
    var state: String?
    /// "Online", "Idle", "3 days ago"; nil unless friends.
    var label: String?

    enum CodingKeys: String, CodingKey {
        case username, pfp, relation, state, label
        case playerID = "id"
        case defaultPfp = "default_pfp"
    }

    init(playerID: String, username: String, pfp: String? = nil) {
        self.playerID = playerID
        self.username = username
        self.pfp = pfp
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        username = try c.decode(String.self, forKey: .username)
        playerID = c.lenient(.playerID, "")
        pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
        defaultPfp = c.lenient(.defaultPfp, false)
        relation = c.lenient(.relation, .stranger)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
    }

    var pictureURL: URL? { SiteURLs.resolve(pfp) }
    var isOnline: Bool { state == "online" }
}

/// Each player's reaction to a message, as the site's dmReactions() allows.
struct MessageReactions: Decodable, Equatable, Hashable {
    var mine: String?
    var theirs: String?

    /// What a message can be reacted with, until the site says otherwise.
    static let all = ["\u{1F44D}", "\u{2764}\u{FE0F}", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}"]

    enum CodingKeys: String, CodingKey { case mine, theirs }

    init(mine: String? = nil, theirs: String? = nil) {
        self.mine = mine
        self.theirs = theirs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mine = (try? c.decodeIfPresent(String.self, forKey: .mine)) ?? nil
        theirs = (try? c.decodeIfPresent(String.self, forKey: .theirs)) ?? nil
    }

    var isEmpty: Bool { mine == nil && theirs == nil }
}

/// One message (dmMessage()). `read`: the one it was sent to has read it.
/// An encrypted one comes with its envelope in `cipher`, which AccountAPI
/// opens into `text` (or marks `sealed` when this device can't).
struct DirectMessage: Decodable, Equatable, Identifiable, Hashable {
    var id = 0
    var fromMe = false
    var text = ""
    var sent: Date?
    var read = false
    var cipher: String?
    var edited: Date?
    var deleted = false
    /// Until when the sender can edit it; nil for someone else's.
    var editableUntil: Date?
    /// Encrypted, and not for this device (sent before it had a key).
    var sealed = false
    /// Not a message but a note in the conversation: "e2ee_on" or "e2ee_off",
    /// one of them turned encryption on or off.
    var kind: String?
    /// The message this one answers.
    var replyTo: Int?
    var reactions = MessageReactions()
    /// The sending device's id for it, which its envelope is bound to (and an
    /// edit of it too).
    var nonce: String?

    var encrypted: Bool { cipher != nil }

    enum CodingKeys: String, CodingKey {
        case id, text, sent, read, cipher, edited, deleted, kind, reactions, nonce
        case fromMe = "from_me"
        case editableUntil = "editable_until"
        case replyTo = "reply_to"
    }

    init(id: Int, fromMe: Bool, text: String, sent: Date?, read: Bool = false) {
        self.id = id
        self.fromMe = fromMe
        self.text = text
        self.sent = sent
        self.read = read
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        fromMe = c.lenient(.fromMe, false)
        text = c.lenient(.text, "")
        sent = Self.date(c, .sent)
        read = c.lenient(.read, false)
        cipher = (try? c.decodeIfPresent(String.self, forKey: .cipher)) ?? nil
        edited = Self.date(c, .edited)
        deleted = c.lenient(.deleted, false)
        editableUntil = Self.date(c, .editableUntil)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        replyTo = (try? c.decodeIfPresent(Int.self, forKey: .replyTo)) ?? nil
        reactions = c.lenient(.reactions, MessageReactions())
        nonce = (try? c.decodeIfPresent(String.self, forKey: .nonce)) ?? nil
    }

    private static func date(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> Date? {
        guard let seconds = (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    /// What the bubble says.
    var shownText: String {
        if deleted { return "Message deleted" }
        if sealed { return "\u{1F512} Can't be read on this device" }
        return text
    }

    /// Still the sender's to edit, by the site's clock (`serverNow`).
    func canEdit(serverNow: Date) -> Bool {
        guard kind == nil, fromMe, id > 0, !deleted, !sealed, let editableUntil else { return false }
        return serverNow < editableUntil
    }
}

/// Whether a conversation is end-to-end encrypted: off until either player
/// turns it on, then on for both. `by`: "me" or "them", whoever last changed it.
struct ConversationEncryption: Decodable, Equatable {
    var on = false
    var by: String?

    enum CodingKeys: String, CodingKey { case on, by }

    init(on: Bool = false, by: String? = nil) {
        self.on = on
        self.by = by
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = c.lenient(.on, false)
        by = (try? c.decodeIfPresent(String.self, forKey: .by)) ?? nil
    }
}

/// POST action=e2ee: the conversation's encryption now.
struct EncryptionChange: Decodable {
    var e2ee: ConversationEncryption
}

/// Every device a message is sealed for: both players' (GET ?with=).
struct MessageKeys: Decodable, Equatable {
    struct Device: Decodable, Equatable, Hashable {
        var device: String
        var key: String
    }

    var mine: [Device] = []
    var theirs: [Device] = []

    var all: [Device] { mine + theirs }

    enum CodingKeys: String, CodingKey { case mine, theirs }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mine = c.lenient(.mine, [Lenient<Device>]()).compactMap(\.value)
        theirs = c.lenient(.theirs, [Lenient<Device>]()).compactMap(\.value)
    }
}

/// One row of the inbox (dmConversation()).
struct Conversation: Decodable, Equatable, Identifiable {
    struct Last: Decodable, Equatable {
        var id = 0
        var fromMe = false
        var preview = ""
        var sent: Date?
        var read = false
        /// The last message's envelope, for AccountAPI to open into `preview`.
        var cipher: String?
        /// What the envelope is bound to, with who sent it.
        var nonce: String?
        var deleted = false

        enum CodingKeys: String, CodingKey {
            case id, preview, sent, read, cipher, deleted, nonce
            case fromMe = "from_me"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.lenient(.id, 0)
            fromMe = c.lenient(.fromMe, false)
            preview = c.lenient(.preview, "")
            sent = (try? c.decodeIfPresent(Double.self, forKey: .sent)).map { Date(timeIntervalSince1970: $0) }
            read = c.lenient(.read, false)
            cipher = (try? c.decodeIfPresent(String.self, forKey: .cipher)) ?? nil
            nonce = (try? c.decodeIfPresent(String.self, forKey: .nonce)) ?? nil
            deleted = c.lenient(.deleted, false)
            if deleted { preview = "Message deleted" }
        }
    }

    var with: MessagePerson
    var last = Last()
    var unread = 0
    var canMessage = false
    /// Why not, in the site's words: not_friends, blocked, unavailable.
    var reason: String?

    var id: String { with.playerID.isEmpty ? with.username : with.playerID }

    enum CodingKeys: String, CodingKey {
        case with, last, unread, reason
        case canMessage = "can_message"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        with = try c.decode(MessagePerson.self, forKey: .with)
        last = c.lenient(.last, Last())
        unread = max(0, c.lenient(.unread, 0))
        canMessage = c.lenient(.canMessage, false)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// GET /v2/app/messages.php: the inbox.
struct Inbox: Decodable, Equatable {
    var conversations: [Conversation] = []
    var unread = 0
    /// Players the viewer blocked, to unblock.
    var blocked: [MessagePerson] = []
    var maxLength = MessageText.maxLength
    /// The session's token. Blank in a copy kept on disk.
    var csrf = ""
    /// The account's uuid, as envelopes name players.
    var me: String?
    /// With device=: whether the site has this device's key.
    var deviceKnown: Bool?

    enum CodingKeys: String, CodingKey {
        case conversations, unread, blocked, csrf, me
        case maxLength = "max_length"
        case deviceKnown = "device_known"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversations = c.lenient(.conversations, [Lenient<Conversation>]()).compactMap(\.value)
        unread = max(0, c.lenient(.unread, 0))
        blocked = c.lenient(.blocked, [Lenient<MessagePerson>]()).compactMap(\.value)
        maxLength = c.lenient(.maxLength, MessageText.maxLength)
        csrf = c.lenient(.csrf, "")
        me = (try? c.decodeIfPresent(String.self, forKey: .me)) ?? nil
        deviceKnown = (try? c.decodeIfPresent(Bool.self, forKey: .deviceKnown)) ?? nil
    }
}

/// Devices a conversation's messages are sealed for that this device hadn't
/// seen before (AccountAPI's book of them): said in the conversation, since
/// the site is the one handing out the keys.
struct NewDevices: Equatable, Sendable {
    var theirs = 0
    var mine = 0
}

/// GET /v2/app/messages.php?with=<id>: one conversation, oldest first.
struct MessageThread: Decodable, Equatable {
    var with: MessagePerson
    var canMessage = false
    var reason: String?
    /// The viewer blocked them.
    var blocked = false
    var messages: [DirectMessage] = []
    /// Older messages remain (?before=).
    var hasMore = false
    /// The newest of the viewer's messages the other player has read.
    var seenUpTo = 0
    var maxLength = MessageText.maxLength
    var csrf = ""
    /// Both players' devices, to seal the next message for.
    var keys = MessageKeys()
    var e2ee = ConversationEncryption()
    /// The site's clock when it answered: the next poll's `since`, and when
    /// an edit is still allowed.
    var now: Date?
    /// With `since`: messages edited or deleted since then.
    var changed: [DirectMessage] = []
    /// When the other player read the newest of the viewer's they have read.
    var seenAt: Date?
    /// The other player is typing to the viewer now.
    var typing = false
    /// What a message can be reacted with.
    var reactions = MessageReactions.all
    /// The account's uuid, as envelopes name players.
    var me: String?
    /// With device=: whether the site has this device's key.
    var deviceKnown: Bool?
    /// Devices of either player this device hadn't seen (AccountAPI), while
    /// the conversation is encrypted.
    var newDevices: NewDevices?

    enum CodingKeys: String, CodingKey {
        case with, reason, blocked, messages, csrf, keys, now, changed, e2ee, typing, reactions, me
        case canMessage = "can_message"
        case hasMore = "has_more"
        case seenUpTo = "seen_up_to"
        case maxLength = "max_length"
        case seenAt = "seen_at"
        case deviceKnown = "device_known"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        with = try c.decode(MessagePerson.self, forKey: .with)
        canMessage = c.lenient(.canMessage, false)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        blocked = c.lenient(.blocked, false)
        messages = c.lenient(.messages, [Lenient<DirectMessage>]()).compactMap(\.value)
        hasMore = c.lenient(.hasMore, false)
        seenUpTo = c.lenient(.seenUpTo, 0)
        maxLength = c.lenient(.maxLength, MessageText.maxLength)
        csrf = c.lenient(.csrf, "")
        keys = c.lenient(.keys, MessageKeys())
        e2ee = c.lenient(.e2ee, ConversationEncryption())
        now = (try? c.decodeIfPresent(Double.self, forKey: .now)).map { Date(timeIntervalSince1970: $0) }
        changed = c.lenient(.changed, [Lenient<DirectMessage>]()).compactMap(\.value)
        seenAt = (try? c.decodeIfPresent(Double.self, forKey: .seenAt)).map { Date(timeIntervalSince1970: $0) }
        typing = c.lenient(.typing, false)
        let offered = c.lenient(.reactions, [String]())
        reactions = offered.isEmpty ? MessageReactions.all : offered
        me = (try? c.decodeIfPresent(String.self, forKey: .me)) ?? nil
        deviceKnown = (try? c.decodeIfPresent(Bool.self, forKey: .deviceKnown)) ?? nil
    }
}

/// POST action=edit or delete: the message as it is now.
struct ChangedMessage: Decodable {
    var message: DirectMessage
}

/// POST action=send: the message as the site stored it.
struct SentMessage: Decodable {
    var message: DirectMessage
    /// The nonce had been used: this is the message stored the first time.
    var duplicate = false

    enum CodingKeys: String, CodingKey { case message, duplicate }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        message = try c.decode(DirectMessage.self, forKey: .message)
        duplicate = c.lenient(.duplicate, false)
    }
}

/// What the site may say a message can't be sent for, and what the screens
/// say instead.
struct MessageRefusal: LocalizedError, Equatable {
    /// The site's reason: not_friends, blocked, unavailable, unverified,
    /// rate_limited, too_long, empty, not_found, self, no_keys, keys_changed,
    /// too_late, deleted, encryption_required, invalid.
    let reason: String
    var name = ""
    var maxLength = MessageText.maxLength
    /// With keys_changed, no_keys and encryption_required: the devices there are now.
    var keys: MessageKeys?
    /// With encryption_required: the conversation was turned on meanwhile.
    var e2ee: ConversationEncryption?
    /// With encryption_required: the message being edited was encrypted, so the edit must be.
    var sealed = false
    /// The HTTP status it came with, when it came from the site.
    var status: Int?

    static let reasons: Set<String> = [
        "not_friends", "blocked", "unavailable", "unverified", "rate_limited", "too_long", "empty", "not_found", "self",
        "no_keys", "keys_changed", "too_late", "deleted", "encryption_required", "invalid",
    ]

    /// The other player can't be sent anything from here on (the box goes).
    /// Only the site saying no (403): "unavailable" with a 5xx, from a site
    /// from before server_error, is its own trouble and a retry away.
    var closesConversation: Bool {
        ["not_friends", "blocked", "unavailable", "unverified"].contains(reason) && (status ?? 403) == 403
    }

    static func == (a: MessageRefusal, b: MessageRefusal) -> Bool {
        a.reason == b.reason && a.name == b.name && a.maxLength == b.maxLength
    }

    var errorDescription: String? {
        Self.text(reason, name: name, maxLength: maxLength)
    }

    /// The words for a reason, about `name` ("them" without one).
    static func text(_ reason: String?, name: String = "", maxLength: Int = MessageText.maxLength) -> String {
        let who = name.isEmpty ? "them" : name
        switch reason {
        case "not_friends": return "You can only message friends. Add \(who) as a friend to message them."
        case "blocked": return "You blocked \(who). Unblock them to send a message."
        case "unavailable": return "You can't message \(who) right now."
        case "unverified": return "Verify your email address to send messages."
        case "rate_limited": return "You're sending messages too quickly. Wait a minute and try again."
        case "too_long": return "That message is too long. Keep it under \(maxLength.formatted()) characters."
        case "empty": return "Type a message first."
        case "not_found": return "That couldn't be found."
        case "self": return "You can't message yourself."
        case "no_keys": return (name.isEmpty ? "They have" : name + " has") + " no device set up for encrypted messages right now. They need to open Messages on the website or an updated app, or you can turn encryption off."
        case "keys_changed": return "Their devices changed. Try again."
        case "too_late": return "Messages can only be edited for a minute after they're sent."
        case "deleted": return "That message was deleted."
        case "encryption_required": return "This conversation is end-to-end encrypted now. Try again."
        case "invalid": return "That message couldn't be sent. Try again."
        default: return "You can't message \(who)."
        }
    }
}

/// What a report can say is wrong with a message (dmReportReasons()).
enum ReportReason: String, CaseIterable, Identifiable {
    case spam
    case harassment
    case inappropriate
    case other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .spam: "Spam"
        case .harassment: "Harassment or Bullying"
        case .inappropriate: "Inappropriate Content"
        case .other: "Something Else"
        }
    }
}

/// A message as the site will keep it, and the device's id for one.
enum MessageText {
    /// The most a message holds (DM_MAX_LENGTH); the site says so with each
    /// answer too.
    static let maxLength = 1000

    /// Tidied as the site tidies it (dmBody()), for counting and sending:
    /// Unix line ends, a tab as a space, no spaces at the end of a line, at
    /// most one blank line in a row, nothing around it. The site has the last
    /// word on the rest.
    static func cleaned(_ text: String) -> String {
        var out = text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: "\t", with: " ")
        out = withoutControls(out)
        out = out.replacingOccurrences(of: "[ \u{00A0}]+\n", with: "\n", options: .regularExpression)
        out = out.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// No control characters but the line break, and none of the ones that
    /// reorder the text around them (they can make a message read as
    /// something else), as dmBody() leaves it.
    static func withoutControls(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            let v = scalar.value
            let drop = v == 0xFEFF || (v <= 0x1F && v != 0x0A) || (0x7F...0x9F).contains(v)
                || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
            if !drop { scalars.append(scalar) }
        }
        return String(scalars)
    }

    /// An encrypted message as it is shown: the site can't tidy what it
    /// can't read, so the reader does, and cuts it at the longest the site
    /// would have taken.
    static func shown(_ text: String) -> String {
        let out = cleaned(text)
        guard !out.isEmpty else { return "\u{2026}" }
        let scalars = Array(out.unicodeScalars)
        guard scalars.count > maxLength else { return out }
        var cut = String.UnicodeScalarView()
        cut.append(contentsOf: scalars.prefix(maxLength - 1))
        return String(String(cut).reversed().drop(while: \.isWhitespace).reversed()) + "\u{2026}"
    }

    /// How long the site counts a message as: characters, which for the site
    /// are Unicode scalars (mb_strlen), not the grapheme clusters
    /// String.count gives (one emoji with a skin tone is two of them).
    static func length(_ text: String) -> Int {
        cleaned(text).unicodeScalars.count
    }

    /// The first `scalars` code points of `text`, as the site cuts it (never
    /// half of one).
    static func prefix(_ text: String, scalars: Int) -> String {
        var view = String.UnicodeScalarView()
        view.append(contentsOf: text.unicodeScalars.prefix(max(0, scalars)))
        return String(view)
    }

    /// The device's id for one message, kept across its retries so the site
    /// stores it once: 32 hex digits.
    static func nonce() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    static func isNonce(_ value: String) -> Bool {
        (8...32).contains(value.count) && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}
