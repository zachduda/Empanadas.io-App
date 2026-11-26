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

/// One message (dmMessage()). `read`: the one it was sent to has read it.
struct DirectMessage: Decodable, Equatable, Identifiable, Hashable {
    var id = 0
    var fromMe = false
    var text = ""
    var sent: Date?
    var read = false

    enum CodingKeys: String, CodingKey {
        case id, text, sent, read
        case fromMe = "from_me"
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
        sent = (try? c.decodeIfPresent(Double.self, forKey: .sent)).map { Date(timeIntervalSince1970: $0) }
        read = c.lenient(.read, false)
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

        enum CodingKeys: String, CodingKey {
            case id, preview, sent, read
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

    enum CodingKeys: String, CodingKey {
        case conversations, unread, blocked, csrf
        case maxLength = "max_length"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversations = c.lenient(.conversations, [Lenient<Conversation>]()).compactMap(\.value)
        unread = max(0, c.lenient(.unread, 0))
        blocked = c.lenient(.blocked, [Lenient<MessagePerson>]()).compactMap(\.value)
        maxLength = c.lenient(.maxLength, MessageText.maxLength)
        csrf = c.lenient(.csrf, "")
    }
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

    enum CodingKeys: String, CodingKey {
        case with, reason, blocked, messages, csrf
        case canMessage = "can_message"
        case hasMore = "has_more"
        case seenUpTo = "seen_up_to"
        case maxLength = "max_length"
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
    }
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
    /// rate_limited, too_long, empty, not_found, self.
    let reason: String
    var name = ""
    var maxLength = MessageText.maxLength

    static let reasons: Set<String> = [
        "not_friends", "blocked", "unavailable", "unverified", "rate_limited", "too_long", "empty", "not_found", "self",
    ]

    /// The other player can't be sent anything from here on (the box goes).
    var closesConversation: Bool {
        ["not_friends", "blocked", "unavailable", "unverified"].contains(reason)
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
        out = out.replacingOccurrences(of: "[ \u{00A0}]+\n", with: "\n", options: .regularExpression)
        out = out.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// How long the site counts a message as: characters, which for the site
    /// are Unicode scalars (mb_strlen), not the grapheme clusters
    /// String.count gives (one emoji with a skin tone is two of them).
    static func length(_ text: String) -> Int {
        cleaned(text).unicodeScalars.count
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
