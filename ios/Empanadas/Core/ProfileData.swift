import Foundation

// What the native profiles and Find Friends read from the site:
// /v2/ios/profile (iosProfile() and iosProfileFriend() in the site's
// v2/_lib.php) and /v2/ios/search (iosSearchResult()). Lenient, as
// Dashboard is: a field the site adds or drops later must not cost the player
// the whole screen. Only the name is required.

/// How the viewer stands with a player. The site's words, except "self",
/// which Swift keeps for itself.
enum Relationship: String, Decodable, Equatable {
    case me = "self"
    case friends
    /// The viewer asked; the player has not answered.
    case outgoing
    /// The player asked; the viewer has not answered.
    case incoming
    /// Neither friends nor a request. Not `none`, which reads as
    /// Optional.none wherever one of these is optional.
    case stranger = "none"

    init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = Relationship(rawValue: raw) ?? .stranger
    }
}

/// A player's profile id as the site writes it ("ab12cd34-..."), or the
/// 32 hex digits account_edit.php takes (uuid=).
enum PlayerID {
    /// The id without its dashes, lowercased. Nil if it is not one.
    static func raw(_ id: String) -> String? {
        let hex = id.replacingOccurrences(of: "-", with: "").lowercased()
        guard hex.count == 32, hex.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) })
        else { return nil }
        return hex
    }

    static func isValid(_ id: String) -> Bool {
        raw(id) != nil
    }

    /// The same player, however each was written.
    static func same(_ a: String, _ b: String) -> Bool {
        guard let a = raw(a), let b = raw(b) else { return false }
        return a == b
    }
}

/// GET /v2/ios/profile: one player, as the site shows them to the viewer.
struct PlayerProfile: Decodable, Equatable {
    struct Presence: Decodable, Equatable {
        /// "online", "idle" or "offline".
        var state = "offline"
        /// "Online", "Idle", "3 days ago".
        var label = ""

        enum CodingKeys: String, CodingKey { case state, label }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = c.lenient(.state, "offline")
            label = c.lenient(.label, "")
        }
    }

    struct StarSign: Decodable, Equatable {
        var name = ""
        /// "♌".
        var symbol = ""
        var blurb = ""

        enum CodingKeys: String, CodingKey { case name, symbol, blurb }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = c.lenient(.name, "")
            symbol = c.lenient(.symbol, "")
            blurb = c.lenient(.blurb, "")
        }
    }

    /// The "profile" object: who they are.
    struct Player: Decodable, Equatable {
        var id = ""
        var username = ""
        /// The large picture, usually a path on the site.
        var pfp: String?
        var defaultPfp = false
        var isSelf = false
        var admin = false
        var supporter = false
        /// Friends only, and the viewer is not one: nothing but the name,
        /// the picture and the badges.
        var isPrivate = false
        /// Only ever given for the player's own profile.
        var emailVerified: Bool?
        /// "2024-01-02 03:04:05", the site's time zone.
        var memberSince: String?
        var days: Int?
        /// Only to friends and to themselves.
        var presence: Presence?
        var bio: String?
        var starSign: StarSign?

        enum CodingKeys: String, CodingKey {
            case id, username, pfp, admin, supporter, days, presence, bio
            case defaultPfp = "default_pfp"
            case isSelf = "is_self"
            case isPrivate = "private"
            case emailVerified = "email_verified"
            case memberSince = "member_since"
            case starSign = "star_sign"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            username = try c.decode(String.self, forKey: .username)
            id = c.lenient(.id, "")
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
            defaultPfp = c.lenient(.defaultPfp, false)
            isSelf = c.lenient(.isSelf, false)
            admin = c.lenient(.admin, false)
            supporter = c.lenient(.supporter, false)
            isPrivate = c.lenient(.isPrivate, false)
            emailVerified = try? c.decodeIfPresent(Bool.self, forKey: .emailVerified)
            memberSince = try? c.decodeIfPresent(String.self, forKey: .memberSince)
            days = try? c.decodeIfPresent(Int.self, forKey: .days)
            presence = try? c.decodeIfPresent(Presence.self, forKey: .presence)
            bio = (try? c.decodeIfPresent(String.self, forKey: .bio)).flatMap { $0.isEmpty ? nil : $0 }
            starSign = try? c.decodeIfPresent(StarSign.self, forKey: .starSign)
        }

        var pictureURL: URL? { SiteURLs.resolve(pfp) }

        /// "October 2024", from member_since.
        var memberSinceMonth: String? {
            guard let memberSince, memberSince.count >= 7 else { return nil }
            let parts = memberSince.prefix(7).split(separator: "-").compactMap { Int($0) }
            guard parts.count == 2, (1...12).contains(parts[1]) else { return nil }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "America/New_York") ?? .current
            guard let date = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 15)) else {
                return nil
            }
            return date.formatted(.dateTime.month(.wide).year())
        }
    }

    struct Experience: Decodable, Equatable {
        struct Part: Decodable, Equatable, Identifiable {
            var label = ""
            var xp = 0
            var percent = 0

            var id: String { label }

            enum CodingKeys: String, CodingKey { case label, xp, percent }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                label = c.lenient(.label, "")
                xp = c.lenient(.xp, 0)
                percent = c.lenient(.percent, 0)
            }
        }

        var total = 0
        var rank = ""
        var icon = ""
        /// "10 - 100 XP".
        var range = ""
        var next: Int?
        var nextRank: String?
        var progress = 0.0
        /// What earned it, biggest first.
        var breakdown: [Part] = []

        enum CodingKeys: String, CodingKey {
            case total, rank, icon, range, next, progress, breakdown
            case nextRank = "next_rank"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            total = c.lenient(.total, 0)
            rank = c.lenient(.rank, "")
            icon = c.lenient(.icon, "")
            range = c.lenient(.range, "")
            next = try? c.decodeIfPresent(Int.self, forKey: .next)
            nextRank = try? c.decodeIfPresent(String.self, forKey: .nextRank)
            progress = c.lenient(.progress, 0.0)
            breakdown = c.lenient(.breakdown, [])
        }
    }

    struct Stats: Decodable, Equatable {
        struct Spin: Decodable, Equatable {
            var lifetime = 0
            var current = 0
            var ascends = 0
            var prestige = 0

            enum CodingKeys: String, CodingKey { case lifetime, current, ascends, prestige }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                lifetime = c.lenient(.lifetime, 0)
                current = c.lenient(.current, 0)
                ascends = c.lenient(.ascends, 0)
                prestige = c.lenient(.prestige, 0)
            }
        }

        /// Flappy and Tower. Tower also counts streaks and perfect drops.
        struct Score: Decodable, Equatable {
            var high = 0
            var played = 0
            var recent = 0
            var bestStreak: Int?
            var perfects: Int?

            enum CodingKeys: String, CodingKey {
                case high, played, recent, perfects
                case bestStreak = "best_streak"
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                high = c.lenient(.high, 0)
                played = c.lenient(.played, 0)
                recent = c.lenient(.recent, 0)
                bestStreak = try? c.decodeIfPresent(Int.self, forKey: .bestStreak)
                perfects = try? c.decodeIfPresent(Int.self, forKey: .perfects)
            }
        }

        struct Peppers: Decodable, Equatable {
            var current = 0
            /// Current plus everything spent in the games.
            var lifetime = 0

            enum CodingKeys: String, CodingKey { case current, lifetime }

            init() {}

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                current = c.lenient(.current, 0)
                lifetime = c.lenient(.lifetime, 0)
            }
        }

        /// Nil for a game never played.
        var spin: Spin?
        var flappy: Score?
        var tower: Score?
        var peppers = Peppers()
        var pumpkins = 0
        var pumpkinSeason = false

        enum CodingKeys: String, CodingKey {
            case spin, flappy, tower, peppers, pumpkins
            case pumpkinSeason = "pumpkin_season"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            spin = try? c.decodeIfPresent(Spin.self, forKey: .spin)
            flappy = try? c.decodeIfPresent(Score.self, forKey: .flappy)
            tower = try? c.decodeIfPresent(Score.self, forKey: .tower)
            peppers = c.lenient(.peppers, Peppers())
            pumpkins = c.lenient(.pumpkins, 0)
            pumpkinSeason = c.lenient(.pumpkinSeason, false)
        }

        var hasPlayed: Bool { spin != nil || flappy != nil || tower != nil }
    }

    struct Friend: Decodable, Equatable, Identifiable {
        var username = ""
        /// Their profile id.
        var playerID = ""
        var pfp: String?
        var defaultPfp = false
        /// .friends, or a request: .incoming (to the profile's owner) or
        /// .outgoing (from them). Requests are only listed on your own.
        var relation: Relationship = .friends
        /// Only on your own profile.
        var state: String?
        var label: String?
        /// This row is the viewer.
        var isYou = false

        var id: String { playerID.isEmpty ? username : playerID }

        enum CodingKeys: String, CodingKey {
            case username, pfp, relation, state, label
            case playerID = "id"
            case defaultPfp = "default_pfp"
            case isYou = "is_you"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            username = c.lenient(.username, "")
            playerID = c.lenient(.playerID, "")
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
            defaultPfp = c.lenient(.defaultPfp, false)
            relation = c.lenient(.relation, .friends)
            state = try? c.decodeIfPresent(String.self, forKey: .state)
            label = try? c.decodeIfPresent(String.self, forKey: .label)
            isYou = c.lenient(.isYou, false)
        }

        var pictureURL: URL? { SiteURLs.resolve(pfp) }
    }

    struct Friends: Decodable, Equatable {
        /// Accepted friends, all of them (the list stops at a few hundred).
        var total = 0
        /// Requests waiting on the viewer: only on their own profile.
        var pending = 0
        var list: [Friend] = []

        enum CodingKeys: String, CodingKey { case total, pending, list }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            total = c.lenient(.total, 0)
            pending = c.lenient(.pending, 0)
            // One bad row must not take the list with it.
            list = c.lenient(.list, [Lenient<Friend>]()).compactMap(\.value)
        }

        var accepted: [Friend] { list.filter { $0.relation == .friends } }
        var incoming: [Friend] { list.filter { $0.relation == .incoming } }
        var outgoing: [Friend] { list.filter { $0.relation == .outgoing } }
    }

    private struct RelationshipInfo: Decodable {
        var state: Relationship = .stranger
        var acceptsRequests = true

        enum CodingKeys: String, CodingKey {
            case state
            case acceptsRequests = "accepts_requests"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = c.lenient(.state, .stranger)
            acceptsRequests = c.lenient(.acceptsRequests, true)
        }
    }

    var player: Player
    var relationship: Relationship
    /// Whether the player takes new friend requests.
    var acceptsRequests: Bool
    /// Nil on a profile the viewer may not see.
    var xp: Experience?
    var stats: Stats?
    var friends: Friends?
    /// The session's token, for the friend buttons and the bio. Blank in the
    /// copy kept on disk.
    var csrf: String

    enum CodingKeys: String, CodingKey {
        case relationship, xp, stats, friends, csrf
        case player = "profile"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        player = try c.decode(Player.self, forKey: .player)
        let info = c.lenient(.relationship, RelationshipInfo())
        relationship = player.isSelf ? .me : info.state
        acceptsRequests = info.acceptsRequests
        xp = try? c.decodeIfPresent(Experience.self, forKey: .xp)
        stats = try? c.decodeIfPresent(Stats.self, forKey: .stats)
        friends = try? c.decodeIfPresent(Friends.self, forKey: .friends)
        csrf = c.lenient(.csrf, "")
    }

    var isSelf: Bool { relationship == .me }

    /// The web page for this profile, to share.
    var webURL: URL? {
        player.id.isEmpty ? nil : SiteURLs.playerProfile(id: player.id)
    }
}

/// GET /v2/ios/search: one page of players whose name has the search in it.
struct PlayerSearch: Decodable, Equatable {
    struct Result: Decodable, Equatable, Identifiable {
        /// Their profile id.
        var playerID = ""
        var username = ""
        var pfp: String?
        var defaultPfp = false
        var admin = false
        var supporter = false
        var vip = false
        var isPrivate = false
        var relation: Relationship = .stranger
        var acceptsRequests = true

        var id: String { playerID.isEmpty ? username : playerID }

        enum CodingKeys: String, CodingKey {
            case username, pfp, admin, supporter, vip, relation
            case playerID = "id"
            case defaultPfp = "default_pfp"
            case isPrivate = "private"
            case acceptsRequests = "accepts_requests"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            username = try c.decode(String.self, forKey: .username)
            playerID = c.lenient(.playerID, "")
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
            defaultPfp = c.lenient(.defaultPfp, false)
            admin = c.lenient(.admin, false)
            supporter = c.lenient(.supporter, false)
            vip = c.lenient(.vip, false)
            isPrivate = c.lenient(.isPrivate, false)
            relation = c.lenient(.relation, .stranger)
            acceptsRequests = c.lenient(.acceptsRequests, true)
        }

        var pictureURL: URL? { SiteURLs.resolve(pfp) }
    }

    var query = ""
    var page = 0
    var hasMore = false
    var results: [Result] = []

    enum CodingKeys: String, CodingKey {
        case query, page, results
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = c.lenient(.query, "")
        page = c.lenient(.page, 0)
        hasMore = c.lenient(.hasMore, false)
        results = c.lenient(.results, [Lenient<Result>]()).compactMap(\.value)
    }

    /// What the site accepts as a search (iosSearchTerm()): 2 to 16
    /// characters once the ones it strips are out. Nil when it would refuse.
    static func term(_ text: String) -> String? {
        var term = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for stripped in ["'", "\"", ",", ";", "<", ">", "%", "&", "*", "__"] {
            term = term.replacingOccurrences(of: stripped, with: "")
        }
        // The site counts bytes (strlen).
        return (2...16).contains(term.utf8.count) ? term : nil
    }
}

/// Decodes an element without throwing, so a malformed one is dropped alone.
struct Lenient<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}
