import Foundation

/// One announcement, as api.empanadas.io/v1/updates.php gives it: the post
/// the site's Updates page shows.
struct Announcement: Decodable, Equatable, Identifiable {
    struct Author: Decodable, Equatable {
        var username = "Someone"
        var uuid: String?
        var isAdmin = false
        /// A path on the site, usually.
        var pfp: String?

        var pictureURL: URL? { SiteURLs.resolve(pfp) }

        /// Their profile's id, when it is one.
        var playerID: String? {
            uuid.flatMap { PlayerID.isValid($0) ? $0 : nil }
        }

        enum CodingKeys: String, CodingKey {
            case username, uuid, pfp
            case isAdmin = "is_admin"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            username = c.lenient(.username, "Someone")
            uuid = try? c.decodeIfPresent(String.self, forKey: .uuid)
            isAdmin = c.lenient(.isAdmin, false)
            pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
        }
    }

    var id: String
    /// Plain text: the site's may carry entities (&#39;).
    var title: String
    /// The body as the admin panel saved it: HTML.
    var content: String
    /// When, as the site words it.
    var date: String
    /// When it was last changed, if it was.
    var edited: String?
    var author: Author
    /// `content`, read once, ready to draw.
    var blocks: [PostBlock]

    enum CodingKeys: String, CodingKey {
        case id, title, content, date, edited, author
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Numbers once, six letters and digits now.
        if let text = try? c.decode(String.self, forKey: .id) {
            id = text
        } else {
            id = try String(c.decode(Int.self, forKey: .id))
        }
        title = PostHTML.plainText(c.lenient(.title, ""))
        content = c.lenient(.content, "")
        date = PostHTML.plainText(c.lenient(.date, ""))
        // false when it never was.
        edited = (try? c.decodeIfPresent(String.self, forKey: .edited)).map(PostHTML.plainText)
        author = c.lenient(.author, Author())
        blocks = PostHTML.blocks(content)
    }

    /// Whether `id` could be an announcement's: what a ?post= link or a deep
    /// link may carry.
    static func isID(_ id: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        return (1...64).contains(id.count) && id.unicodeScalars.allSatisfy(allowed.contains)
    }
}

/// The API's whole answer: one post (none past the last, or for an id that
/// isn't one), where it sits, and how many there are.
struct AnnouncementReply: Decodable {
    var post: Announcement?
    /// How many posts are newer than this one: 0 for the newest. For an id,
    /// where that post is.
    var page: Int
    var total: Int

    enum CodingKeys: String, CodingKey {
        case found, page, total
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if c.lenient(.found, false) {
            post = try Announcement(from: decoder)
        } else {
            post = nil
        }
        page = c.lenient(.page, 0)
        total = c.lenient(.total, 0)
    }
}

/// One piece of an announcement's body.
enum PostBlock: Equatable {
    case paragraph(AttributedString)
    /// <h1> to <h6>.
    case heading(AttributedString, level: Int)
    /// One item of a list: its bullet or number ("" for a second paragraph
    /// of the same item), and how deep the list is, 0 for one at the top.
    case listItem(marker: String, text: AttributedString, depth: Int)
    case quote(AttributedString)
    /// <pre>: as written, in a fixed-width font.
    case preformatted(String)
    case image(URL, alt: String)
    case rule
}

/// Announcements are written as HTML in the admin panel, and the site puts
/// them on its page as written. This reads the part of HTML a post uses
/// (paragraphs and line breaks, bold, italics, links, headings, lists,
/// quotes, pictures) into blocks the app draws in its own type: at the
/// reader's text size, in light and dark. What it doesn't draw comes out as
/// its text (a table), or a link (an embedded video); a script or a style,
/// not at all.
enum PostHTML {
    static func blocks(_ html: String) -> [PostBlock] {
        var builder = Builder()
        for token in tokens(html) {
            builder.add(token)
        }
        return builder.finish()
    }

    /// The text alone, tags taken out and entities read: a title.
    static func plainText(_ html: String) -> String {
        let text = tokens(html).reduce(into: "") { text, token in
            if case .text(let piece) = token { text += piece }
        }
        return decodeEntities(collapse(text)).trimmingCharacters(in: .whitespaces)
    }

    /// The page the posts are on, which a relative link in one is relative to.
    static let base = SiteURLs.page("/updates")

    /// A link in a post, made absolute. The web and email; not javascript:,
    /// and not a spot on the page itself.
    static func link(_ href: String?) -> URL? {
        guard let href = href?.trimmingCharacters(in: .whitespacesAndNewlines), !href.isEmpty, !href.hasPrefix("#"),
              let url = URL(string: href, relativeTo: base)?.absoluteURL,
              let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) else { return nil }
        return url
    }

    /// A picture in a post: https only, as App Transport Security wants.
    static func image(_ src: String?) -> URL? {
        guard let url = link(src), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }

    // MARK: - Reading the HTML

    enum Token: Equatable {
        case text(String)
        /// A start tag: its name, lowercased, and its attributes.
        case open(String, [String: String])
        case close(String)
    }

    /// What is inside these is not text, and may have a "<" that is not a
    /// tag in it.
    private static let rawText: Set<String> = ["script", "style", "title", "textarea", "noscript", "xmp"]

    static func tokens(_ html: String) -> [Token] {
        var tokens: [Token] = []
        var text = ""
        var i = html.startIndex
        while i < html.endIndex {
            guard html[i] == "<" else {
                text.append(html[i])
                i = html.index(after: i)
                continue
            }
            let rest = html[i...]
            if rest.hasPrefix("<!--") {
                i = rest.range(of: "-->")?.upperBound ?? html.endIndex
                continue
            }
            guard let tag = tag(at: rest) else {
                // "I <3 empanadas".
                text.append("<")
                i = html.index(after: i)
                continue
            }
            if !text.isEmpty {
                tokens.append(.text(text))
                text = ""
            }
            i = tag.end
            guard let token = tag.token else { continue }
            tokens.append(token)
            if case .open(let name, _) = token, rawText.contains(name) {
                let close = html[i...].range(of: "</" + name, options: .caseInsensitive)
                i = close.flatMap { html[$0.upperBound...].firstIndex(of: ">") }.map { html.index(after: $0) }
                    ?? html.endIndex
                tokens.append(.close(name))
            }
        }
        if !text.isEmpty { tokens.append(.text(text)) }
        return tokens
    }

    /// The tag `s` starts with (at its "<"), and where it ends. Nil when the
    /// "<" doesn't start a tag. A nil token for one of no interest
    /// (<!doctype html>).
    private static func tag(at s: Substring) -> (token: Token?, end: String.Index)? {
        var i = s.index(after: s.startIndex)
        guard i < s.endIndex else { return nil }
        let closing = s[i] == "/"
        if closing { i = s.index(after: i) }
        guard i < s.endIndex else { return nil }
        let declaration = !closing && (s[i] == "!" || s[i] == "?")
        guard declaration || (s[i].isASCII && s[i].isLetter) else { return nil }

        // The first ">" that isn't in a quoted attribute.
        var j = i
        var quote: Character?
        while j < s.endIndex {
            let c = s[j]
            if let open = quote {
                if c == open { quote = nil }
            } else if c == "\"" || c == "'" {
                quote = c
            } else if c == ">" {
                break
            }
            j = s.index(after: j)
        }
        guard j < s.endIndex else { return nil }
        let end = s.index(after: j)
        if declaration { return (nil, end) }

        let inside = s[i..<j]
        let name = inside.prefix { $0.isASCII && ($0.isLetter || $0.isNumber) }
        if closing { return (.close(name.lowercased()), end) }
        return (.open(name.lowercased(), attributes(inside.dropFirst(name.count))), end)
    }

    private static func attributes(_ s: Substring) -> [String: String] {
        var result: [String: String] = [:]
        var i = s.startIndex
        while true {
            while i < s.endIndex, s[i].isWhitespace || s[i] == "/" { i = s.index(after: i) }
            guard i < s.endIndex else { break }
            let nameStart = i
            while i < s.endIndex, !s[i].isWhitespace, s[i] != "=", s[i] != "/" { i = s.index(after: i) }
            let name = s[nameStart..<i].lowercased()

            var value = ""
            var k = i
            while k < s.endIndex, s[k].isWhitespace { k = s.index(after: k) }
            if k < s.endIndex, s[k] == "=" {
                i = s.index(after: k)
                while i < s.endIndex, s[i].isWhitespace { i = s.index(after: i) }
                if i < s.endIndex, s[i] == "\"" || s[i] == "'" {
                    let open = s[i]
                    let start = s.index(after: i)
                    let close = s[start...].firstIndex(of: open) ?? s.endIndex
                    value = String(s[start..<close])
                    i = close < s.endIndex ? s.index(after: close) : close
                } else {
                    let start = i
                    while i < s.endIndex, !s[i].isWhitespace { i = s.index(after: i) }
                    value = String(s[start..<i])
                }
            }
            if !name.isEmpty, result[name] == nil {
                result[name] = decodeEntities(value)
            }
        }
        return result
    }

    /// HTML's white space: any run of spaces, tabs and line breaks is one
    /// space. A no-break space (&nbsp;) isn't white space here.
    static func collapse(_ text: String) -> String {
        let space: Set<Character> = [" ", "\t", "\n", "\r", "\r\n", "\u{0C}"]
        var result = ""
        var pending = false
        for c in text {
            if space.contains(c) {
                pending = true
            } else {
                if pending { result.append(" ") }
                pending = false
                result.append(c)
            }
        }
        if pending { result.append(" ") }
        return result
    }

    private static let named: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{00A0}",
        "hellip": "…", "mdash": "—", "ndash": "–", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”",
        "laquo": "«", "raquo": "»", "bull": "•", "middot": "·", "copy": "©", "reg": "®", "trade": "™",
        "deg": "°", "times": "×", "divide": "÷", "plusmn": "±", "frac12": "½", "frac14": "¼", "frac34": "¾",
        "euro": "€", "pound": "£", "cent": "¢", "yen": "¥", "iexcl": "¡", "iquest": "¿", "hearts": "♥",
        "larr": "←", "rarr": "→", "uarr": "↑", "darr": "↓", "para": "¶", "sect": "§",
        "aacute": "á", "eacute": "é", "iacute": "í", "oacute": "ó", "uacute": "ú", "ntilde": "ñ", "uuml": "ü",
        "Aacute": "Á", "Eacute": "É", "Iacute": "Í", "Oacute": "Ó", "Uacute": "Ú", "Ntilde": "Ñ", "Uuml": "Ü",
        "ensp": "\u{2002}", "emsp": "\u{2003}", "thinsp": "\u{2009}", "zwnj": "\u{200C}", "zwj": "\u{200D}",
        "shy": "\u{00AD}",
    ]

    /// &amp;, &#39;, &#x1F389; and the like, read. One it doesn't know is
    /// left as written.
    static func decodeEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        var result = ""
        var i = text.startIndex
        while let amp = text[i...].firstIndex(of: "&") {
            result += text[i..<amp]
            let after = text.index(after: amp)
            if let semicolon = text[after...].prefix(32).firstIndex(of: ";"),
               let decoded = entity(text[after..<semicolon]) {
                result += decoded
                i = text.index(after: semicolon)
            } else {
                result += "&"
                i = after
            }
        }
        result += text[i...]
        return result
    }

    private static func entity(_ name: Substring) -> String? {
        guard name.hasPrefix("#") else { return named[String(name)] }
        let digits = name.dropFirst()
        let value = digits.hasPrefix("x") || digits.hasPrefix("X")
            ? UInt32(digits.dropFirst(), radix: 16)
            : UInt32(digits, radix: 10)
        guard let value, value != 0, let scalar = Unicode.Scalar(value) else { return nil }
        return String(Character(scalar))
    }

    // MARK: - Into blocks

    /// Paragraphs and the like: each starts a block of its own.
    private static let blockElements: Set<String> = [
        "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "address", "center",
        "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr",
        "caption", "form", "fieldset", "legend", "hgroup", "body", "html",
    ]

    /// What these hold is never shown on the page (a video's text for
    /// browsers without video), or isn't text (a drawing).
    private static let hiddenElements: Set<String> = [
        "iframe", "video", "audio", "object", "svg", "canvas", "template", "head", "map", "select",
    ]

    private static let headings: Set<String> = ["h1", "h2", "h3", "h4", "h5", "h6"]

    private struct Builder {
        private var blocks: [PostBlock] = []
        /// The block being written.
        private var text = AttributedString()
        /// At the start of a block or just after a line break, where white
        /// space in the HTML shows as nothing.
        private var atLineStart = true
        /// White space came last: a space, unless the block or line ends first.
        private var pendingSpace = false

        private var bold = 0
        private var italic = 0
        private var code = 0
        private var strike = 0
        private var links: [URL?] = []
        private var heading: Int?
        private var quote = 0
        private var pre = 0
        private var lists: [(ordered: Bool, next: Int)] = []
        /// The bullet or number of a list item whose text hasn't come yet.
        private var marker: String?
        /// The elements around this point whose content isn't shown.
        private var hidden: [String] = []
        /// A <video> or <audio> without a src: its first <source> has it.
        private var awaitingSource = false

        mutating func add(_ token: Token) {
            switch token {
            case .text(let raw):
                if hidden.isEmpty { write(raw) }
            case .open(let name, let attributes):
                if hidden.isEmpty {
                    open(name, attributes)
                } else {
                    if name == "source", awaitingSource {
                        awaitingSource = false
                        media(attributes["src"])
                    }
                    if PostHTML.hiddenElements.contains(name) { hidden.append(name) }
                }
            case .close(let name):
                if hidden.isEmpty {
                    close(name)
                } else if let index = hidden.lastIndex(of: name) {
                    hidden.removeSubrange(index...)
                    if hidden.isEmpty { awaitingSource = false }
                }
            }
        }

        mutating func finish() -> [PostBlock] {
            endBlock()
            while blocks.first == .rule { blocks.removeFirst() }
            while blocks.last == .rule { blocks.removeLast() }
            return blocks
        }

        private mutating func open(_ name: String, _ attributes: [String: String]) {
            switch name {
            case "br": lineBreak()
            case "b", "strong": bold += 1
            case "i", "em", "cite", "dfn", "var": italic += 1
            case "code", "kbd", "samp", "tt": code += 1
            case "s", "strike", "del": strike += 1
            case "a": links.append(PostHTML.link(attributes["href"]))
            case "blockquote":
                endBlock()
                quote += 1
            case "pre":
                endBlock()
                pre += 1
            case "ul", "ol":
                endBlock()
                let start = attributes["start"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) } ?? 1
                lists.append((ordered: name == "ol", next: name == "ol" ? start : 1))
            case "li":
                endBlock()
                marker = nextMarker()
            case "hr":
                endBlock()
                blocks.append(.rule)
            case "img":
                picture(attributes)
            case "iframe", "video", "audio", "embed", "object":
                if let source = attributes["src"] ?? attributes["data"] {
                    media(source)
                } else if name == "video" || name == "audio" {
                    awaitingSource = true
                }
                if PostHTML.hiddenElements.contains(name) { hidden.append(name) }
            case "td", "th":
                if !atLineStart { pendingSpace = true }
            case _ where PostHTML.headings.contains(name):
                endBlock()
                heading = Int(name.dropFirst())
            case _ where PostHTML.blockElements.contains(name):
                endBlock()
            case _ where PostHTML.hiddenElements.contains(name):
                hidden.append(name)
            default:
                break
            }
        }

        private mutating func close(_ name: String) {
            switch name {
            case "br": lineBreak()
            case "b", "strong": bold = max(0, bold - 1)
            case "i", "em", "cite", "dfn", "var": italic = max(0, italic - 1)
            case "code", "kbd", "samp", "tt": code = max(0, code - 1)
            case "s", "strike", "del": strike = max(0, strike - 1)
            case "a": _ = links.popLast()
            case "blockquote":
                endBlock()
                quote = max(0, quote - 1)
            case "pre":
                endBlock()
                pre = max(0, pre - 1)
            case "ul", "ol":
                endBlock()
                _ = lists.popLast()
                marker = nil
            case "li":
                endBlock()
                marker = nil
            case _ where PostHTML.headings.contains(name):
                endBlock()
                heading = nil
            case _ where PostHTML.blockElements.contains(name):
                endBlock()
            default:
                break
            }
        }

        private mutating func nextMarker() -> String {
            guard let depth = lists.indices.last else { return "•" }
            guard lists[depth].ordered else { return ["•", "◦", "–"][depth % 3] }
            defer { lists[depth].next += 1 }
            return "\(lists[depth].next)."
        }

        private var style: AttributeContainer {
            var container = AttributeContainer()
            var intent: InlinePresentationIntent = []
            if bold > 0 { intent.insert(.stronglyEmphasized) }
            if italic > 0 { intent.insert(.emphasized) }
            if code > 0 { intent.insert(.code) }
            if strike > 0 { intent.insert(.strikethrough) }
            if !intent.isEmpty { container.inlinePresentationIntent = intent }
            if let last = links.last, let url = last { container.link = url }
            return container
        }

        private mutating func write(_ raw: String) {
            if pre > 0 {
                var raw = raw
                // A line break straight after <pre> isn't part of it.
                if text.characters.isEmpty, raw.first == "\n" || raw.first == "\r\n" { raw.removeFirst() }
                append(PostHTML.decodeEntities(raw))
                return
            }
            var words = PostHTML.collapse(raw)
            if words.hasPrefix(" ") {
                words.removeFirst()
                if !atLineStart { pendingSpace = true }
            }
            let spaceAfter = words.hasSuffix(" ")
            if spaceAfter { words.removeLast() }
            guard !words.isEmpty else { return }
            if pendingSpace { text.append(AttributedString(" ")) }
            append(PostHTML.decodeEntities(words))
            pendingSpace = spaceAfter
        }

        private mutating func append(_ string: String) {
            text.append(AttributedString(string, attributes: style))
            atLineStart = false
            pendingSpace = false
        }

        private mutating func lineBreak() {
            text.append(AttributedString("\n"))
            atLineStart = true
            pendingSpace = false
        }

        private mutating func picture(_ attributes: [String: String]) {
            let alt = (attributes["alt"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            // Twemoji's picture of an emoji, copied from a page that drew
            // them: the emoji itself.
            let classes = (attributes["class"] ?? "").split(separator: " ")
            if classes.contains("emoji"), !alt.isEmpty {
                if pendingSpace { text.append(AttributedString(" ")) }
                append(alt)
                return
            }
            guard let url = PostHTML.image(attributes["src"]) else { return }
            endBlock()
            blocks.append(.image(url, alt: alt))
        }

        /// An embedded video or the like, as a link to it.
        private mutating func media(_ source: String?) {
            guard let url = PostHTML.link(source), let host = url.host(percentEncoded: false) else { return }
            endBlock()
            var container = AttributeContainer()
            container.link = url
            let site = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
            blocks.append(.paragraph(AttributedString("View on \(site)", attributes: container)))
        }

        /// What has been written since the last block ended becomes one,
        /// whatever the HTML around it makes it.
        private mutating func endBlock() {
            defer {
                text = AttributedString()
                atLineStart = true
                pendingSpace = false
            }
            // A line break at either end of a block shows as nothing.
            while text.characters.last == "\n" { text.characters.removeLast() }
            while text.characters.first == "\n" { text.characters.removeFirst() }
            guard text.characters.contains(where: { !$0.isWhitespace }) else { return }

            if pre > 0 {
                blocks.append(.preformatted(String(text.characters)))
            } else if let heading {
                blocks.append(.heading(text, level: heading))
            } else if marker != nil || !lists.isEmpty {
                blocks.append(.listItem(marker: marker ?? "", text: text, depth: max(0, lists.count - 1)))
                marker = nil
            } else if quote > 0 {
                blocks.append(.quote(text))
            } else {
                blocks.append(.paragraph(text))
            }
        }
    }
}
