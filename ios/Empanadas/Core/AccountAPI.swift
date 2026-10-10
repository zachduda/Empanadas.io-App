import Foundation
import WebKit

/// The settings the native Settings screen shows. Field names are the ones
/// account_edit.php takes with account_change=settings; values are 0/1, and
/// theme is 0 (match device), 1 (light) or 2 (dark).
struct AccountSettings: Decodable, Equatable {
    var publicaccount: Int
    var starsign: Int
    var allownf: Int
    var analytics: Int
    var theme: Int
    var promoemails: Int
    var otheremails: Int
    var recapemails: Int
    var newsignins: Int
}

/// Who is signed in: the "account" object of /ios/account.php
/// (iosAccountProfile() in the site's v2/_lib.php).
struct AccountProfile: Decodable, Equatable {
    var id: Int
    var username: String
    var email: String
    var emailVerified: Bool
    /// An address change waiting on its confirmation link.
    var pendingEmail: String?
    /// The large profile picture, as the site gives it: usually a path.
    var pfp: String?
    var pfpSmall: String?
    var hasCustomPfp: Bool
    var createdAt: String?
    var birthday: String?
    var starSign: String?
    /// Linked sign-in providers, lowercased: "google", "github", "discord".
    var connections: [String]
    var twoFactor: Bool
    var passkeys: Int

    enum CodingKeys: String, CodingKey {
        case id, username, email, pfp, birthday, connections, passkeys
        case emailVerified = "email_verified"
        case pendingEmail = "pending_email"
        case pfpSmall = "pfp_small"
        case hasCustomPfp = "has_custom_pfp"
        case createdAt = "created_at"
        case starSign = "star_sign"
        case twoFactor = "two_factor"
    }

    // Lenient: a field the site adds or drops later must not cost the player
    // the whole Settings screen. Only the name is required.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        username = try c.decode(String.self, forKey: .username)
        id = (try? c.decodeIfPresent(Int.self, forKey: .id)) ?? 0
        email = (try? c.decodeIfPresent(String.self, forKey: .email)) ?? ""
        emailVerified = (try? c.decodeIfPresent(Bool.self, forKey: .emailVerified)) ?? false
        pendingEmail = try? c.decodeIfPresent(String.self, forKey: .pendingEmail)
        pfp = try? c.decodeIfPresent(String.self, forKey: .pfp)
        pfpSmall = try? c.decodeIfPresent(String.self, forKey: .pfpSmall)
        hasCustomPfp = (try? c.decodeIfPresent(Bool.self, forKey: .hasCustomPfp)) ?? (pfp != nil)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        birthday = try? c.decodeIfPresent(String.self, forKey: .birthday)
        starSign = try? c.decodeIfPresent(String.self, forKey: .starSign)
        connections = (try? c.decodeIfPresent([String].self, forKey: .connections)) ?? []
        twoFactor = (try? c.decodeIfPresent(Bool.self, forKey: .twoFactor)) ?? false
        passkeys = (try? c.decodeIfPresent(Int.self, forKey: .passkeys)) ?? 0
    }

    init(username: String, email: String, pfp: String?) {
        id = 0
        self.username = username
        self.email = email
        emailVerified = false
        pendingEmail = nil
        self.pfp = pfp
        pfpSmall = pfp
        hasCustomPfp = pfp != nil
        createdAt = nil
        birthday = nil
        starSign = nil
        connections = []
        twoFactor = false
        passkeys = 0
    }
}

/// GET /ios/account.php: the account, its settings, and the csrf token that
/// changes to them go back to /v2/account_edit.php with.
///
/// Also reads the older /v2/getdata.php?type=app_settings answer, which has
/// username, email and pfp at the top level instead of an "account" object,
/// for a site that does not have /ios/ yet.
struct AccountSnapshot: Decodable {
    var account: AccountProfile
    let hasBirthday: Bool
    var settings: AccountSettings
    var csrf: String

    var username: String { account.username }
    var email: String { account.email }

    var pictureURL: URL? {
        account.pfp.flatMap { URL(string: $0, relativeTo: SiteURLs.site)?.absoluteURL }
    }

    enum CodingKeys: String, CodingKey {
        case account, settings, csrf
        case username, email, pfp
        case hasBirthday = "has_birthday"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if c.contains(.account) {
            account = try c.decode(AccountProfile.self, forKey: .account)
        } else {
            account = AccountProfile(
                username: try c.decode(String.self, forKey: .username),
                email: (try? c.decodeIfPresent(String.self, forKey: .email)) ?? "",
                pfp: try? c.decodeIfPresent(String.self, forKey: .pfp)
            )
        }
        hasBirthday = (try? c.decodeIfPresent(Bool.self, forKey: .hasBirthday)) ?? false
        settings = try c.decode(AccountSettings.self, forKey: .settings)
        csrf = try c.decode(String.self, forKey: .csrf)
    }
}

enum AccountError: LocalizedError, Equatable {
    case signedOut
    case needsCaptcha
    case rateLimited
    case staleToken
    /// The site answered, but not with an account. The detail (the site's
    /// reason, or the HTTP status) is shown so a report says what went wrong.
    case unavailable(String)
    case server(String)
    case network

    var errorDescription: String? {
        switch self {
        case .signedOut: "You've been signed out."
        case .needsCaptcha: "Please complete a quick check first."
        case .rateLimited: "That's a lot of changes at once. Try again in a minute."
        case .staleToken: "Your session needs refreshing. Try again."
        case .unavailable(let detail): detail.isEmpty
            ? "Your account couldn't be loaded."
            : "Your account couldn't be loaded (\(detail))."
        case .server(let reason): reason.isEmpty ? "Something went wrong on our end. Try again!" : reason
        case .network: "Couldn't reach Empanadas.io. Check your connection."
        }
    }
}

/// Native requests to the site, carrying the web views' cookies and user
/// agent so the site sees the same session.
@MainActor
final class AccountAPI {
    private let session: URLSession
    private let cookieStore: WKHTTPCookieStore

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        // Cookies live in WebKit's store, not URLSession's: they are copied in
        // for each request and any the site sets are copied back.
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
        cookieStore = WKWebsiteDataStore.default().httpCookieStore
    }

    /// The signed-in account, from /ios/account.php.
    func snapshot() async throws -> AccountSnapshot {
        let (data, response) = try await send(URLRequest(url: SiteURLs.iosAccount))
        let reply = Self.iosReply(data)

        // A site without /ios/ yet: nginx's own 404 page, not our JSON.
        if response.statusCode == 404 && reply == nil {
            return try await legacySnapshot()
        }
        guard let reply else {
            throw AccountError.unavailable("HTTP \(response.statusCode)")
        }
        if reply.ok {
            do {
                return try JSONDecoder().decode(AccountSnapshot.self, from: data)
            } catch {
                throw AccountError.unavailable("unexpected reply")
            }
        }
        switch reply.reason {
        case "no_session": throw AccountError.signedOut
        default: throw AccountError.unavailable(reply.reason ?? "HTTP \(response.statusCode)")
        }
    }

    /// The answer every /ios/ endpoint gives: {"ok": Bool, "reason": String?}.
    /// Nil when the body is not that (an HTML error page, a proxy's answer).
    nonisolated static func iosReply(_ data: Data) -> (ok: Bool, reason: String?)? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let ok = object["ok"] as? Bool else { return nil }
        return (ok, object["reason"] as? String)
    }

    /// GET /v2/getdata.php?type=app_settings, which /ios/account.php replaced.
    private func legacySnapshot() async throws -> AccountSnapshot {
        let (data, response) = try await send(URLRequest(url: getDataURL("app_settings")))
        let text = plainText(data)
        switch text {
        case "no_session": throw AccountError.signedOut
        case "no_type", "unavailable", "wrong_method": throw AccountError.unavailable(text)
        default: break
        }
        do {
            return try JSONDecoder().decode(AccountSnapshot.self, from: data)
        } catch {
            throw AccountError.unavailable("HTTP \(response.statusCode)")
        }
    }

    /// One account_change=settings write, as the account page's
    /// bindSettingSelect() sends it.
    func update(_ field: String, to value: Int, csrf: String) async throws {
        try await change("settings", [(field, String(value))], csrf: csrf)
    }

    /// Deletes the account: the same account_edit.php request the account
    /// page's Danger Zone sends. The site checks the typed phrase (DELETE)
    /// itself; the Settings screen asks the player for it.
    func deleteAccount(confirmation: String, csrf: String) async throws {
        try await change("delete_account", [("cp", confirmation)], csrf: csrf)
    }

    /// POST /v2/account_edit.php, the handler behind every change on the
    /// account page (update_account() in the site's accountedit JS).
    private func change(_ action: String, _ fields: [(String, String)], csrf: String) async throws {
        var request = URLRequest(url: SiteURLs.page("/v2/account_edit.php"))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.formBody([("account_change", action)] + fields + [("csrf", csrf)])

        let (data, response) = try await send(request)
        if response.statusCode == 429 { throw AccountError.rateLimited }
        guard response.statusCode == 200 else { throw AccountError.server("Error \(response.statusCode)") }

        let reply = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if Self.intValue(reply["result"]) == 1 { return }
        let reason = reply["reason"] as? String ?? ""
        switch reason {
        case "no_session": throw AccountError.signedOut
        case "needs_captcha": throw AccountError.needsCaptcha
        case "csrf": throw AccountError.staleToken
        default: throw AccountError.server(Self.stripTags(reason))
        }
    }

    /// Does the site still consider this session signed in? Nil when it could
    /// not be asked.
    func isSignedIn() async -> Bool? {
        guard let result = try? await send(URLRequest(url: getDataURL("session"))) else { return nil }
        let (data, response) = result
        guard response.statusCode == 200 else { return nil }
        switch plainText(data) {
        case "1": return true
        case "no_session": return false
        default: return nil
        }
    }

    struct Ping { var ok: Bool; var status: Int; var pong: Bool }

    /// Same request as pingSite() in the desktop app.
    func ping() async -> Ping {
        var components = URLComponents(url: SiteURLs.page("/v2/ping.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "usingnativeapp", value: "1"),
            URLQueryItem(name: "_", value: String(Int(Date().timeIntervalSince1970 * 1000))),
        ]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 8
        guard let result = try? await send(request) else {
            return Ping(ok: false, status: 0, pong: false)
        }
        let (data, response) = result
        let ok = (200..<300).contains(response.statusCode)
        return Ping(ok: ok, status: response.statusCode, pong: ok && plainText(data) == "Pong!")
    }

    // MARK: - Plumbing

    private func getDataURL(_ type: String) -> URL {
        var components = URLComponents(url: SiteURLs.page("/v2/getdata.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "type", value: type)]
        return components.url!
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url else { throw AccountError.network }
        var request = request
        let cookies = await cookieStore.allCookies().filter { Self.cookie($0, appliesTo: url) }
        for (name, value) in HTTPCookie.requestHeaderFields(with: cookies) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue(await WebEnvironment.userAgent(), forHTTPHeaderField: "User-Agent")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AccountError.network
        }
        guard let http = response as? HTTPURLResponse else { throw AccountError.network }

        if let fields = http.allHeaderFields as? [String: String], let responseURL = http.url {
            for cookie in HTTPCookie.cookies(withResponseHeaderFields: fields, for: responseURL) {
                await cookieStore.setCookie(cookie)
            }
        }
        return (data, http)
    }

    nonisolated static func cookie(_ cookie: HTTPCookie, appliesTo url: URL) -> Bool {
        guard let host = url.host(percentEncoded: false)?.lowercased() else { return false }
        if let expires = cookie.expiresDate, expires < Date() { return false }
        if cookie.isSecure && url.scheme?.lowercased() != "https" { return false }

        var domain = cookie.domain.lowercased()
        let hostOnly = !domain.hasPrefix(".")
        if !hostOnly { domain.removeFirst() }
        let domainMatches = hostOnly ? host == domain : (host == domain || host.hasSuffix("." + domain))

        let path = url.path(percentEncoded: true).isEmpty ? "/" : url.path(percentEncoded: true)
        return domainMatches && path.hasPrefix(cookie.path)
    }

    nonisolated static func formBody(_ fields: [(String, String)]) -> Data {
        // ASCII only: CharacterSet.alphanumerics would let "é" through
        // unencoded.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return fields
            .map { name, value in
                let name = name.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                let value = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
                return name + "=" + value
            }
            .joined(separator: "&")
            .data(using: .utf8)!
    }

    private func plainText(_ data: Data) -> String {
        String(decoding: data.prefix(64), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    nonisolated private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }

    /// The site's reasons are written for SweetAlert and may carry <br> and
    /// <b>; the native alert shows plain text.
    nonisolated static func stripTags(_ html: String) -> String {
        html.replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
