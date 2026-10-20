import Foundation

/// Which files saving the games for offline play fetches (OfflineGames).
/// Worked out from the games themselves, a step at a time: each game's page,
/// then the stylesheets, scripts and pictures it names, then the fonts and
/// pictures the stylesheets name and the pictures and sounds the scripts
/// name. So a game that starts asking for a new file, or for a new version
/// of one (spin.js?v=6.10.2), is saved without an app update.
///
/// The same files the site's offline worker keeps for the desktop app
/// (PRECACHE and cacheKey() in html/sw.js). Kept free of WebKit, so the
/// tests can check it directly.
enum OfflineAssets {
    /// Where it starts: the games' pages, at the addresses the player opens.
    static var pages: [URL] { Game.allCases.map(\.url) }

    /// Files a game builds the path of in script, so no page, stylesheet or
    /// script names them whole: most of Spin's sounds (playSound("zap.mp3"),
    /// one of nine "Speenz/" + n + ".mp3"), its top medals and the
    /// tutorial's Jeffs (_spin.js). Check this against the games when one
    /// gains a sound or a picture.
    static let builtInScript: [URL] = [
        "/Content/Sounds/button.mp3",
        "/Content/Sounds/error.wav",
        "/Content/Sounds/SpinGame/achievement.mp3",
        "/Content/Sounds/SpinGame/cheating_alert.mp3",
        "/Content/Sounds/SpinGame/cheating_confirmed.mp3",
        "/Content/Sounds/SpinGame/extinguish.mp3",
        "/Content/Sounds/SpinGame/golden.mp3",
        "/Content/Sounds/SpinGame/golden_active.mp3",
        "/Content/Sounds/SpinGame/locked.mp3",
        "/Content/Sounds/SpinGame/menu.mp3",
        "/Content/Sounds/SpinGame/prestige.mp3",
        "/Content/Sounds/SpinGame/timetravel.mp3",
        "/Content/Sounds/SpinGame/zap.mp3",
        "/Content/Sounds/SpinGame/Speenz/1.mp3",
        "/Content/Sounds/SpinGame/Speenz/2.mp3",
        "/Content/Sounds/SpinGame/Speenz/3.mp3",
        "/Content/Sounds/SpinGame/Speenz/4.mp3",
        "/Content/Sounds/SpinGame/Speenz/5.mp3",
        "/Content/Sounds/SpinGame/Speenz/6.mp3",
        "/Content/Sounds/SpinGame/Speenz/7.mp3",
        "/Content/Sounds/SpinGame/Speenz/8.mp3",
        "/Content/Sounds/SpinGame/Speenz/9.mp3",
        "/Content/Images/SpinGame/Medals/5.gif",
        "/Content/Images/SpinGame/Medals/6.gif",
        "/Content/Images/Jeff/jeff.gif",
        "/Content/Images/Jeff/jeffbigneck.gif",
        "/Content/Images/Jeff/jeffcoffee.gif",
        "/Content/Images/Jeff/jeffhat.gif",
        "/Content/Images/Jeff/jeffhearts.gif",
    ].map(SiteURLs.page)

    private static let fontStylesheetHost = "fonts.googleapis.com"
    private static let fontFileHost = "fonts.gstatic.com"

    /// Whether a file is one the games need offline: the site's own static
    /// files (everything under /Content/) and Google Fonts' stylesheets and
    /// the font files they name. Not the analytics tag, the clock on
    /// api.empanadas.io, or another page of the site: the games carry on
    /// without those, as they do in the desktop app's worker.
    static func isSaved(_ url: URL) -> Bool {
        guard let host = SiteURLs.host(of: url) else { return false }
        let path = url.path(percentEncoded: false)
        switch host {
        case SiteURLs.appHost:
            return path.hasPrefix("/Content/") && !isFallbackFont(path)
        case fontStylesheetHost:
            // Not the bare host a page preconnects to.
            return path.hasPrefix("/css")
        case fontFileHost:
            return path.count > 1 && !isFallbackFont(path)
        default:
            return false
        }
    }

    /// Whether to read a saved file for the files it names in turn.
    static func namesMoreFiles(_ url: URL) -> Bool {
        isStylesheet(url) || isScript(url)
    }

    static func isStylesheet(_ url: URL) -> Bool {
        SiteURLs.host(of: url) == fontStylesheetHost || url.pathExtension.lowercased() == "css"
    }

    static func isScript(_ url: URL) -> Bool {
        SiteURLs.isAppURL(url) && url.pathExtension.lowercased() == "js"
    }

    /// Every file a page's tags name (src="..." and href="..."): its
    /// stylesheets, scripts, icons and pictures. Links to other pages, the
    /// hosts it only preconnects to and anything off the site are not saved.
    static func named(inPage html: String, at page: URL) -> [URL] {
        let references = matches(attributePattern, in: html).map(decodingEntities)
        return resolved(references, against: page)
    }

    /// Every file a stylesheet names with url(...): fonts and background
    /// pictures, relative to the stylesheet (../webfonts/fa-solid-900.woff2).
    /// Only the woff2 of a font: every browser the app runs on picks it over
    /// the older formats listed after it.
    static func named(inStylesheet css: String, at stylesheet: URL) -> [URL] {
        let references = matches(stylesheetPattern, in: css).filter { reference in
            // An SVG font (fonts.svg#fontawesome), or a reference to
            // something inside the document.
            !reference.hasPrefix("#") && !(reference.contains("#") && reference.lowercased().contains(".svg"))
        }
        return resolved(references, against: stylesheet)
    }

    /// Every file of the site's a script names whole, in quotes: the
    /// pictures and sounds it loads as the game goes. Not one it builds the
    /// path of (builtInScript).
    static func named(inScript js: String, at script: URL) -> [URL] {
        resolved(matches(scriptPattern, in: js), against: script)
    }

    // MARK: - Reading

    // The patterns are nonisolated(unsafe): an NSRegularExpression never
    // changes once made and is documented as safe to use from any thread,
    // but is not marked Sendable.

    // src="..." or href="...", in either quotes or none.
    nonisolated(unsafe) private static let attributePattern = try! NSRegularExpression(
        pattern: #"\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#,
        options: [.caseInsensitive]
    )

    // url(...), in either quotes or none. data: URLs come out in resolved().
    nonisolated(unsafe) private static let stylesheetPattern = try! NSRegularExpression(
        pattern: #"url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s"'()]+))\s*\)"#,
        options: [.caseInsensitive]
    )

    // A whole path under /Content/ with a picture, sound or font's extension,
    // in quotes: "/Content/Sounds/SpinGame/zap.mp3". Not a folder
    // ("/Content/Sounds/") a script adds the rest of the path to.
    nonisolated(unsafe) private static let scriptPattern = try! NSRegularExpression(
        pattern: #"["'`](/Content/[A-Za-z0-9_\-./]+\.(?:png|gif|webp|jpe?g|svg|ico|mp3|wav|ogg|m4a|woff2))["'`]"#,
        options: [.caseInsensitive]
    )

    /// The first group that took part in each match.
    private static func matches(_ regex: NSRegularExpression, in text: String) -> [String] {
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { match in
            for group in 1..<match.numberOfRanges {
                if let range = Range(match.range(at: group), in: text) {
                    return String(text[range])
                }
            }
            return nil
        }
    }

    /// The references made absolute, without their fragments, in the order
    /// they came, once each, keeping only the files that are saved.
    private static func resolved(_ references: [String], against base: URL) -> [URL] {
        var seen = Set<URL>()
        var urls: [URL] = []
        for reference in references {
            let reference = reference.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !reference.isEmpty, let url = URL(string: reference, relativeTo: base)?.absoluteURL,
                  var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { continue }
            components.fragment = nil
            guard let file = components.url, isSaved(file), seen.insert(file).inserted else { continue }
            urls.append(file)
        }
        return urls
    }

    /// Attribute values come with their ampersands escaped
    /// (css2?family=Montserrat&amp;family=Poppins).
    private static func decodingEntities(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&#38;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
    }

    /// Font formats a stylesheet lists after woff2 for older browsers.
    private static func isFallbackFont(_ path: String) -> Bool {
        let path = path.lowercased()
        return [".ttf", ".otf", ".eot", ".woff"].contains { path.hasSuffix($0) }
    }
}
