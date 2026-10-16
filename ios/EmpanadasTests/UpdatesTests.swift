import XCTest
@testable import Empanadas

/// The native Updates screen: what api.empanadas.io/v1/updates.php sends
/// (html/api/v1/updates.php on the site), how a post's HTML is read, what
/// the bell counts, and the links that open it.
final class UpdatesTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }

    private func reply(_ json: String) throws -> AnnouncementReply {
        try JSONDecoder().decode(AnnouncementReply.self, from: Data(json.utf8))
    }

    private func blocks(_ html: String) -> [PostBlock] {
        PostHTML.blocks(html)
    }

    /// Each block's text, or a word for what it is.
    private func outline(_ blocks: [PostBlock]) -> [String] {
        blocks.map { block in
            switch block {
            case .paragraph(let text): "p: " + String(text.characters)
            case .heading(let text, let level): "h\(level): " + String(text.characters)
            case .listItem(let marker, let text, let depth): "li\(depth) \(marker) " + String(text.characters)
            case .quote(let text): "quote: " + String(text.characters)
            case .preformatted(let text): "pre: " + text
            case .image(let url, let alt): "img: \(url.absoluteString) \(alt)"
            case .rule: "hr"
            }
        }
    }

    private func text(_ block: PostBlock?) -> AttributedString? {
        switch block {
        case .paragraph(let text)?, .quote(let text)?: text
        case .heading(let text, _)?: text
        case .listItem(_, let text, _)?: text
        default: nil
        }
    }

    /// The parts of `text` with `intent` on them.
    private func runs(_ text: AttributedString?, _ intent: InlinePresentationIntent) -> [String] {
        guard let text else { return [] }
        return text.runs.compactMap { run in
            guard run.inlinePresentationIntent?.contains(intent) == true else { return nil }
            return String(text[run.range].characters)
        }
    }

    /// The links in `text`, by their text.
    private func links(_ text: AttributedString?) -> [String: URL] {
        guard let text else { return [:] }
        var links: [String: URL] = [:]
        for run in text.runs {
            if let link = run.link { links[String(text[run.range].characters)] = link }
        }
        return links
    }

    // MARK: - The API's answer

    /// As updates.php builds it, with the strTimeDiff() dates.
    private let post = """
        {"id":"k3n9q2","title":"What&#39;s New &amp; Improved","content":"<p>Spin got <b>faster</b>.</p>",
         "date":"3 days ago","edited":"2 days ago",
         "author":{"username":"zach","uuid":"11111111-2222-3333-4444-555555555555","is_admin":true,
                   "pfp":"/pfp/sm/zach.png","default_pfp":false},
         "found":true,"page":0,"total":12,"last_checked":1760000000}
        """

    func testReadsAPost() throws {
        let reply = try reply(post)
        let post = try XCTUnwrap(reply.post)
        XCTAssertEqual(post.id, "k3n9q2")
        XCTAssertEqual(post.title, "What's New & Improved", "the entities read")
        XCTAssertEqual(post.date, "3 days ago")
        XCTAssertEqual(post.edited, "2 days ago")
        XCTAssertEqual(post.author.username, "zach")
        XCTAssertTrue(post.author.isAdmin)
        XCTAssertEqual(post.author.playerID, "11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(post.author.pictureURL, url("https://empanadas.io/pfp/sm/zach.png"))
        XCTAssertEqual(outline(post.blocks), ["p: Spin got faster."])
        XCTAssertEqual(reply.page, 0)
        XCTAssertEqual(reply.total, 12)
    }

    func testAPostNeverEditedAndAnOldNumberID() throws {
        let post = try XCTUnwrap(try reply("""
            {"id":7,"title":"Hi","content":"Hello","date":"1 year ago","edited":false,
             "author":{"username":"Someone","uuid":null,"is_admin":false,"default_pfp":true,
                       "pfp":"/Content/Images/defaultpfp.png"},"found":true,"page":3,"total":4}
            """).post)
        XCTAssertEqual(post.id, "7")
        XCTAssertNil(post.edited)
        XCTAssertNil(post.author.playerID, "no profile to open")
    }

    func testPastTheLastPost() throws {
        let reply = try reply(#"{"found":false,"page":12,"total":12,"last_checked":1760000000}"#)
        XCTAssertNil(reply.post)
        XCTAssertEqual(reply.page, 12)
        XCTAssertEqual(reply.total, 12)
    }

    func testAsksAsTheSitesPageDoes() {
        XCTAssertEqual(SiteURLs.updatesAPI(), url("https://api.empanadas.io/v1/updates.php?v=1&page=0"))
        XCTAssertEqual(SiteURLs.updatesAPI(page: 3), url("https://api.empanadas.io/v1/updates.php?v=1&page=3"))
        XCTAssertEqual(SiteURLs.updatesAPI(post: "k3n9q2"),
                       url("https://api.empanadas.io/v1/updates.php?v=1&page=0&post=k3n9q2"))
        XCTAssertEqual(SiteURLs.queryValue("sc", in: SiteURLs.updatesAPI()), nil)
        XCTAssertNotNil(SiteURLs.queryValue("sc", in: SiteURLs.updatesAPI(fresh: true)), "past the cache")
    }

    // MARK: - A post's HTML

    func testParagraphsAndLineBreaks() {
        XCTAssertEqual(outline(blocks("<p>One</p><p>Two<br>lines<br/></p>")), ["p: One", "p: Two\nlines"])
        XCTAssertEqual(outline(blocks("Just text, as typed\n  into the box.")), ["p: Just text, as typed into the box."],
                       "white space is one space, as on the page")
        XCTAssertEqual(outline(blocks("Before<div>inside</div>after")), ["p: Before", "p: inside", "p: after"])
        XCTAssertEqual(outline(blocks("<p>  </p><p></p>")), [], "nothing to show")
        XCTAssertEqual(outline(blocks("A<br><br>B")), ["p: A\n\nB"])
    }

    func testSpacesAroundTags() {
        XCTAssertEqual(outline(blocks("<b>one</b> <i>two</i>")), ["p: one two"])
        XCTAssertEqual(outline(blocks("Read <a href=\"/spin\">this </a>now")), ["p: Read this now"])
        XCTAssertEqual(outline(blocks("<p> padded </p>")), ["p: padded"])
        XCTAssertEqual(outline(blocks("a&nbsp;&nbsp;b")), ["p: a\u{00A0}\u{00A0}b"], "a no-break space stays")
    }

    func testBoldItalicsAndCode() {
        let body = text(blocks("<p>Now <strong>twice</strong> as <em>fast</em>, <b><i>both</i></b> and <code>x</code>.</p>").first)
        XCTAssertEqual(runs(body, .stronglyEmphasized), ["twice", "both"])
        XCTAssertEqual(runs(body, .emphasized), ["fast", "both"])
        XCTAssertEqual(runs(body, .code), ["x"])
        XCTAssertEqual(runs(text(blocks("<s>old</s> new").first), .strikethrough), ["old"])
    }

    func testLinks() {
        let body = text(blocks("""
            <a href="/spin">Spin</a>, <a href='https://discord.gg/abc'>Discord</a>,
            <a href=mailto:hi@empanadas.io>mail</a>, <a href="javascript:alert(1)">no</a>, <a href="#top">top</a>
            """).first)
        let found = links(body)
        XCTAssertEqual(found["Spin"], url("https://empanadas.io/spin"), "relative to the Updates page")
        XCTAssertEqual(found["Discord"], url("https://discord.gg/abc"))
        XCTAssertEqual(found["mail"], url("mailto:hi@empanadas.io"))
        XCTAssertNil(found["no"])
        XCTAssertNil(found["top"])
        XCTAssertEqual(found.count, 3)
    }

    func testHeadingsQuotesAndRules() {
        XCTAssertEqual(outline(blocks("<h2>Big News</h2>Text<hr><blockquote>Quoted</blockquote><h4>Small</h4>")),
                       ["h2: Big News", "p: Text", "hr", "quote: Quoted", "h4: Small"])
        XCTAssertEqual(outline(blocks("<hr>Middle<hr>")), ["p: Middle"], "no line at either end")
    }

    func testLists() {
        XCTAssertEqual(outline(blocks("<ul><li>Spin</li><li>Flappy</li></ul>After")),
                       ["li0 • Spin", "li0 • Flappy", "p: After"])
        XCTAssertEqual(outline(blocks("<ol start=\"3\"><li>Three<li>Four</ol>")), ["li0 3. Three", "li0 4. Four"],
                       "an <li> left open closes at the next")
        XCTAssertEqual(outline(blocks("<ul><li>Top<ul><li>Inner</li></ul></li><li>Next</li></ul>")),
                       ["li0 • Top", "li1 ◦ Inner", "li0 • Next"])
        XCTAssertEqual(outline(blocks("<ol><li><p>First</p><p>more</p></li></ol>")), ["li0 1. First", "li0  more"],
                       "a second paragraph of an item has no number")
    }

    func testPictures() {
        XCTAssertEqual(outline(blocks("Look:<img src=\"/Content/Images/banner.png\" alt=\"The banner\">Nice")),
                       ["p: Look:", "img: https://empanadas.io/Content/Images/banner.png The banner", "p: Nice"])
        XCTAssertEqual(outline(blocks("<img src=\"http://example.com/a.png\"><img src=\"\">")), [], "https only")
        XCTAssertEqual(outline(blocks("Yay <img class=\"emoji\" alt=\"🎉\" src=\"https://twemoji/1f389.svg\"> done")),
                       ["p: Yay 🎉 done"], "Twemoji's picture is the emoji")
    }

    func testWhatIsNotShown() {
        XCTAssertEqual(outline(blocks("<script>if (a<b) alert(1)</script>Hi<style>p{color:red}</style>")), ["p: Hi"])
        XCTAssertEqual(outline(blocks("A<!-- note -->B<!DOCTYPE html>")), ["p: AB"])
        XCTAssertEqual(outline(blocks("<iframe src=\"https://www.youtube.com/embed/xyz\">fallback</iframe>")),
                       ["p: View on youtube.com"], "an embed is a link to it")
        XCTAssertEqual(outline(blocks("<video><source src=\"https://cdn.example.com/a.mp4\">Old browser</video>")),
                       ["p: View on cdn.example.com"])
        XCTAssertEqual(outline(blocks("<svg><text>drawn</text></svg>Text")), ["p: Text"])
    }

    func testTextThatLooksLikeATag() {
        XCTAssertEqual(outline(blocks("I <3 empanadas & 2 < 3")), ["p: I <3 empanadas & 2 < 3"])
        XCTAssertEqual(outline(blocks("Unclosed <b")), ["p: Unclosed <b"])
        XCTAssertEqual(outline(blocks("<pre>\n  keep  this\n</pre>")), ["pre:   keep  this"])
    }

    func testEntities() {
        XCTAssertEqual(PostHTML.decodeEntities("&amp; &lt;b&gt; &quot;hi&quot; &#39;s &#x1F389; &#127790; &hellip;"),
                       "& <b> \"hi\" 's 🎉 🌮 …")
        XCTAssertEqual(PostHTML.decodeEntities("&unknown; & &#xZZ; &"), "&unknown; & &#xZZ; &", "left as written")
        XCTAssertEqual(PostHTML.plainText("<b>Bold</b> &amp; plain "), "Bold & plain")
    }

    // MARK: - The bell

    func testUnreadCount() {
        XCTAssertEqual(UpdatesModel.unread(newest: "c", seen: "c", seenAt: 0), 0, "seen the newest")
        XCTAssertEqual(UpdatesModel.unread(newest: "c", seen: "a", seenAt: 2), 2, "two posted since")
        XCTAssertEqual(UpdatesModel.unread(newest: "c", seen: "a", seenAt: nil), 1, "the one seen was taken down")
        XCTAssertEqual(UpdatesModel.unread(newest: "c", seen: "a", seenAt: 0), 1, "something is new")
        XCTAssertEqual(UpdatesModel.unread(newest: nil, seen: "a", seenAt: nil), 0, "nothing posted at all")
        XCTAssertEqual(UpdatesModel.unread(newest: "c", seen: nil, seenAt: nil), 0, "never looked")
    }

    func testWhichPostsAreMarkedNew() {
        XCTAssertEqual(UpdatesModel.newCount(ids: ["c", "b", "a"], seen: "a", unread: 2), 2)
        XCTAssertEqual(UpdatesModel.newCount(ids: ["c", "b", "a"], seen: "c", unread: 0), 0)
        XCTAssertEqual(UpdatesModel.newCount(ids: ["c"], seen: "a", unread: 2), 1, "the rest aren't read yet")
        XCTAssertEqual(UpdatesModel.newCount(ids: ["c", "b", "x"], seen: "a", unread: 2), 2, "as many as the bell said")
        XCTAssertEqual(UpdatesModel.newCount(ids: ["c", "b"], seen: "a", unread: 0), 1, "at least the newest")
        XCTAssertEqual(UpdatesModel.newCount(ids: ["c", "b"], seen: nil, unread: 0), 0, "the first time")
        XCTAssertEqual(UpdatesModel.newCount(ids: [], seen: "a", unread: 3), 0)
    }

    // MARK: - Links that open it

    func testTheUpdatesPageOpensNatively() {
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/updates")), .updates(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/updates.html")), .updates(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/updates?post=k3n9q2")), .updates("k3n9q2"))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/updates?post=<b>")), .updates(nil), "not an id")
        XCTAssertNil(NativeRoute.of(url("https://example.com/updates")))
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/updates/old")))
    }

    func testDeepLinks() {
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://updates")), .updates(nil))
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://updates/k3n9q2")), .updates("k3n9q2"))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://updates/a/b")))
    }

    func testAnnouncementIDs() {
        XCTAssertTrue(Announcement.isID("k3n9q2"))
        XCTAssertTrue(Announcement.isID("42"))
        XCTAssertFalse(Announcement.isID(""))
        XCTAssertFalse(Announcement.isID("a b"))
        XCTAssertFalse(Announcement.isID(String(repeating: "a", count: 65)))
    }
}
