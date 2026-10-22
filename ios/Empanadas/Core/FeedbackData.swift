import Foundation

/// GET /v2/ios/feedback: the feedback form the native Send Feedback
/// screen draws (iosFeedbackForm() in the site's v2/_lib.php), and the csrf
/// token the answer goes back to /v2/account_edit.php with.
struct FeedbackForm: Decodable, Equatable {
    var subjects: [Subject]
    var defaultSubject: Int
    var minLength: Int
    var maxLength: Int
    /// Where a reply goes. Empty when the site did not say.
    var email: String
    var emailVerified: Bool
    var csrf: String

    /// One choice under Feedback Type. `id` is the code account_edit.php
    /// takes (account_change=feedback, field s).
    struct Subject: Decodable, Equatable, Hashable, Identifiable {
        var id: Int
        var key: String
        var label: String
        /// A link to a .gif (an animated profile picture) instead of a
        /// message, as feedback.js asks for one.
        var asksForLink: Bool
        var placeholder: String
        /// Whether "I'd like a reply" is offered.
        var offersReply: Bool
        var messageRequired: Bool

        enum CodingKeys: String, CodingKey {
            case id, key, label, input, placeholder, reply
            case messageRequired = "message_required"
        }

        init(id: Int, key: String, label: String, asksForLink: Bool = false,
             placeholder: String = "What's on your mind?", offersReply: Bool = true, messageRequired: Bool = true) {
            self.id = id
            self.key = key
            self.label = label
            self.asksForLink = asksForLink
            self.placeholder = placeholder
            self.offersReply = offersReply
            self.messageRequired = messageRequired
        }

        // Lenient past id and label, as AccountProfile is: a field the site
        // adds or drops later must not cost the player the form.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(Int.self, forKey: .id)
            label = try c.decode(String.self, forKey: .label)
            key = (try? c.decodeIfPresent(String.self, forKey: .key)) ?? ""
            asksForLink = (try? c.decodeIfPresent(String.self, forKey: .input)) == "link"
            placeholder = (try? c.decodeIfPresent(String.self, forKey: .placeholder)) ?? "What's on your mind?"
            offersReply = (try? c.decodeIfPresent(Bool.self, forKey: .reply)) ?? !asksForLink
            messageRequired = (try? c.decodeIfPresent(Bool.self, forKey: .messageRequired)) ?? true
        }
    }

    enum CodingKeys: String, CodingKey {
        case subjects, email, csrf
        case defaultSubject = "default_subject"
        case minLength = "min_length"
        case maxLength = "max_length"
        case emailVerified = "email_verified"
    }

    init(subjects: [Subject], defaultSubject: Int = 1, minLength: Int = 6, maxLength: Int = 2000,
         email: String = "", emailVerified: Bool = false, csrf: String = "") {
        self.subjects = subjects
        self.defaultSubject = defaultSubject
        self.minLength = minLength
        self.maxLength = maxLength
        self.email = email
        self.emailVerified = emailVerified
        self.csrf = csrf
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        subjects = try c.decode([Subject].self, forKey: .subjects)
        guard !subjects.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .subjects, in: c, debugDescription: "no subjects")
        }
        defaultSubject = (try? c.decodeIfPresent(Int.self, forKey: .defaultSubject)) ?? subjects[0].id
        minLength = (try? c.decodeIfPresent(Int.self, forKey: .minLength)) ?? 6
        maxLength = (try? c.decodeIfPresent(Int.self, forKey: .maxLength)) ?? 2000
        email = (try? c.decodeIfPresent(String.self, forKey: .email)) ?? ""
        emailVerified = (try? c.decodeIfPresent(Bool.self, forKey: .emailVerified)) ?? false
        csrf = (try? c.decodeIfPresent(String.self, forKey: .csrf)) ?? ""
    }

    /// The form as v2/feedback.php has it, for a site without
    /// /v2/ios/feedback yet. Without the supporters' animated picture
    /// subject: whether the player may ask for one is the site's to say.
    static let builtIn = FeedbackForm(subjects: [
        Subject(id: 1, key: "general", label: "General Feedback"),
        Subject(id: 2, key: "question", label: "Asking a Question"),
        Subject(id: 3, key: "account_problem", label: "Game or Account Problem"),
        Subject(id: 4, key: "api", label: "API Related"),
        Subject(id: 5, key: "bug_report", label: "Bug Report"),
        Subject(id: 6, key: "data_download", label: "Request Account Data Download", messageRequired: false),
        Subject(id: 8, key: "other", label: "Other"),
    ])

    /// Game or Account Problem: the subject the games' own Report a Problem
    /// links pick (/v2/feedback?reason=3), and the Games tab's too.
    static let gameProblem = 3

    func subject(_ id: Int?) -> Subject? {
        subjects.first { $0.id == id }
    }

    /// The subject a link asked for (v2/feedback?reason=3), else the
    /// default, else the first.
    func initialSubject(_ reason: Int?) -> Subject {
        subject(reason) ?? subject(defaultSubject) ?? subjects[0]
    }

    /// The message as it will be sent: trimmed.
    static func cleaned(_ message: String) -> String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether the message can be sent for this subject: feedback.js's
    /// runTests(). A link for an animated picture; otherwise between the
    /// limits (or nothing at all, for a data download).
    func accepts(_ message: String, for subject: Subject) -> Bool {
        let message = Self.cleaned(message)
        if subject.asksForLink { return Self.isLink(message) }
        if message.isEmpty { return !subject.messageRequired }
        return (minLength...max(minLength, maxLength)).contains(message.count)
    }

    /// An http(s) link to a host with a dot in it, as feedback.js's linkrgx
    /// wants.
    static func isLink(_ text: String) -> Bool {
        guard !text.contains(where: \.isWhitespace),
              let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host(percentEncoded: false), host.contains("."),
              !host.hasPrefix("."), !host.hasSuffix(".") else { return false }
        return true
    }
}
