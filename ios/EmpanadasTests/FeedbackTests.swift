import XCTest
@testable import Empanadas

/// The native Send Feedback screen: what /v2/ios/feedback sends
/// (tests/iosapp_test.php on the site), what the form will send (feedback.js's
/// rules), and the links that open it.
final class FeedbackTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func url(_ string: String) -> URL { URL(string: string)! }

    /// A supporter's form, as iosFeedbackForm() builds it.
    private let supporterForm = """
        {"ok":true,"api":1,"subjects":[
          {"id":1,"key":"general","label":"General Feedback","input":"message","placeholder":"What's on your mind?",
           "reply":true,"message_required":true},
          {"id":5,"key":"bug_report","label":"Bug Report","input":"message","placeholder":"What's on your mind?",
           "reply":true,"message_required":true},
          {"id":6,"key":"data_download","label":"Request Account Data Download","input":"message",
           "placeholder":"What's on your mind?","reply":true,"message_required":false},
          {"id":7,"key":"animated_pfp","label":"Request Animated Profile Pic","input":"link",
           "placeholder":"Paste a link to your .gif here.","reply":false,"message_required":true},
          {"id":8,"key":"other","label":"Other","input":"message","placeholder":"What's on your mind?",
           "reply":true,"message_required":true}],
         "default_subject":1,"min_length":6,"max_length":2000,
         "email":"me@example.com","email_verified":true,"csrf":"fbe3093522fe8a4a7b6f63ee369d11f5"}
        """

    // MARK: - The form

    func testReadsTheForm() throws {
        let form = try decode(FeedbackForm.self, supporterForm)
        XCTAssertEqual(form.subjects.map(\.id), [1, 5, 6, 7, 8])
        XCTAssertEqual(form.subjects.first?.label, "General Feedback")
        XCTAssertEqual(form.defaultSubject, 1)
        XCTAssertEqual(form.minLength, 6)
        XCTAssertEqual(form.maxLength, 2000)
        XCTAssertEqual(form.email, "me@example.com")
        XCTAssertTrue(form.emailVerified)
        XCTAssertEqual(form.csrf, "fbe3093522fe8a4a7b6f63ee369d11f5")

        let animated = try XCTUnwrap(form.subject(7))
        XCTAssertTrue(animated.asksForLink)
        XCTAssertFalse(animated.offersReply)
        XCTAssertEqual(animated.placeholder, "Paste a link to your .gif here.")
        XCTAssertFalse(try XCTUnwrap(form.subject(6)).messageRequired)
    }

    func testAFormWithFieldsMissingStillLoads() throws {
        let form = try decode(FeedbackForm.self, """
            {"ok":true,"api":1,"subjects":[{"id":2,"label":"Asking a Question"},{"id":7,"label":"Gif","input":"link"}]}
            """)
        XCTAssertEqual(form.defaultSubject, 2, "the first subject")
        XCTAssertEqual(form.minLength, 6)
        XCTAssertEqual(form.maxLength, 2000)
        XCTAssertEqual(form.email, "")
        XCTAssertEqual(form.csrf, "")
        XCTAssertTrue(form.subjects[0].offersReply)
        XCTAssertFalse(form.subjects[1].offersReply, "a link has no reply box unless the site says so")
    }

    func testAFormWithNoSubjectsIsNotAForm() {
        XCTAssertThrowsError(try decode(FeedbackForm.self, #"{"ok":true,"api":1,"subjects":[]}"#))
    }

    func testTheBuiltInFormIsTheWebsCodes() {
        // account_edit.php's feedbackSubjects(): 1-8, without the supporters' 7.
        XCTAssertEqual(FeedbackForm.builtIn.subjects.map(\.id), [1, 2, 3, 4, 5, 6, 8])
        XCTAssertEqual(FeedbackForm.builtIn.subjects.map(\.key),
                       ["general", "question", "account_problem", "api", "bug_report", "data_download", "other"])
        XCTAssertFalse(FeedbackForm.builtIn.subjects.contains(where: \.asksForLink))
    }

    func testTheSubjectALinkAskedFor() throws {
        let form = try decode(FeedbackForm.self, supporterForm)
        XCTAssertEqual(form.initialSubject(5).id, 5)
        XCTAssertEqual(form.initialSubject(nil).id, 1)
        XCTAssertEqual(form.initialSubject(3).id, 1, "not offered: the default")
        XCTAssertEqual(form.initialSubject(10).id, 1, "zachduda.com's subjects are not this form's")
    }

    // MARK: - What can be sent

    func testMessagesBetweenTheLimits() throws {
        let form = try decode(FeedbackForm.self, supporterForm)
        let general = try XCTUnwrap(form.subject(1))
        XCTAssertFalse(form.accepts("", for: general))
        XCTAssertFalse(form.accepts("hi", for: general))
        XCTAssertFalse(form.accepts("  hi  \n\n ", for: general), "spaces don't count")
        XCTAssertTrue(form.accepts("Hello!", for: general))
        XCTAssertTrue(form.accepts(String(repeating: "a", count: 2000), for: general))
        XCTAssertFalse(form.accepts(String(repeating: "a", count: 2001), for: general))
        XCTAssertTrue(form.accepts("🥟🥟🥟🥟🥟🥟", for: general), "characters, not bytes")
    }

    func testADataDownloadNeedsNoMessage() throws {
        let form = try decode(FeedbackForm.self, supporterForm)
        let download = try XCTUnwrap(form.subject(6))
        XCTAssertTrue(form.accepts("", for: download))
        XCTAssertFalse(form.accepts("hi", for: download), "but one that's there is held to the limits")
        XCTAssertTrue(form.accepts("For my records", for: download))
    }

    func testAnAnimatedPictureNeedsALink() throws {
        let form = try decode(FeedbackForm.self, supporterForm)
        let animated = try XCTUnwrap(form.subject(7))
        XCTAssertTrue(form.accepts("https://i.ibb.co/abc/me.gif", for: animated))
        XCTAssertTrue(form.accepts("  http://example.com/me.gif ", for: animated))
        XCTAssertFalse(form.accepts("my gif is great", for: animated))
        XCTAssertFalse(form.accepts("ftp://example.com/me.gif", for: animated))
        XCTAssertFalse(form.accepts("https://localhost/me.gif", for: animated))
        XCTAssertFalse(form.accepts("https://example.com/my gif.gif", for: animated))
        XCTAssertFalse(form.accepts("", for: animated))
    }

    func testTheFormSendsWhatFeedbackJSSends() {
        let body = String(decoding: AccountAPI.formBody([
            ("account_change", "feedback"), ("s", "5"), ("m", "Spin froze & I lost 3 spins"), ("nr", "1"),
            ("sso", "0"), ("csrf", "a+b/c="),
        ]), as: UTF8.self)
        XCTAssertEqual(body, "account_change=feedback&s=5&m=Spin%20froze%20%26%20I%20lost%203%20spins&nr=1&sso=0&csrf=a%2Bb%2Fc%3D")
        XCTAssertEqual(FeedbackForm.cleaned("\n  Hello there  \n"), "Hello there")
    }

    // MARK: - Links that open it

    func testTheFeedbackPageOpensTheNativeForm() {
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/feedback")), .feedback(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/feedback.php")), .feedback(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/feedback?reason=3")), .feedback(3), "Spin's Report a Problem")
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/feedback?reason=x")), .feedback(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/feedback?reason=0")), .feedback(nil))
        XCTAssertEqual(NativeRoute.of(url("https://empanadas.io/v2/feedback?sso=0")), .feedback(nil))
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/feedback?sso=1")), "zachduda.com's form stays on the web")
        XCTAssertNil(NativeRoute.of(url("https://example.com/v2/feedback")))
        XCTAssertNil(NativeRoute.of(url("https://empanadas.io/v2/feedbacks")))
    }

    func testFeedbackDeepLinks() {
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://feedback")), .feedback(nil))
        XCTAssertEqual(NativeRoute.of(deepLink: url("empanadas-io://feedback?reason=5")), .feedback(5))
        XCTAssertNil(NativeRoute.of(deepLink: url("empanadas-io://feedback/5")))
    }

    func testTheURLTheSheetIsOpenedWith() {
        XCTAssertEqual(SiteURLs.feedback(reason: nil).absoluteString, "https://empanadas.io/v2/feedback")
        XCTAssertEqual(SiteURLs.feedback(reason: 3).absoluteString, "https://empanadas.io/v2/feedback?reason=3")
        // WebSheetView reads it back to draw the form.
        XCTAssertEqual(NativeRoute.of(SiteURLs.feedback(reason: 3)), .feedback(3))
        XCTAssertEqual(SiteURLs.iosFeedback.absoluteString, "https://empanadas.io/v2/ios/feedback")
    }
}
