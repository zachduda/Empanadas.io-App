import WebKit

/// Saves every game for offline play while the app is open with a
/// connection, so a game the player has never opened still starts without
/// one.
///
/// A game opened offline starts from the copy in WebKit's cache
/// (WebPage.loadFromCache), which used to hold only the games played online
/// before, and of those only the files they had asked for so far. This
/// fills it with all of them: each game's page and every stylesheet, script,
/// picture, sound and font it loads (OfflineAssets), fetched from a page of
/// the site's own in a web view nobody sees. Every web view shares the
/// default website data store, so the game player finds them there.
///
/// It is brought up to date at most every refreshInterval, and each time
/// asks the site whether a saved file has changed rather than fetching it
/// again, so after the first save it costs little. The desktop app does the
/// same with the site's service worker (lib/offline.js), which WKWebView
/// only runs for App-Bound Domains (see ios/README.md).
@MainActor
@Observable
final class OfflineGames {
    /// When every game was last saved whole. Nil if never on this install,
    /// or the cache has been cleared since.
    private(set) var savedAt: Date?
    private(set) var isSaving = false

    var isSaved: Bool { savedAt != nil }

    /// How often the saved games are brought up to date, at most.
    static let refreshInterval: TimeInterval = 6 * 60 * 60

    /// The save under way. A save that finds it has been replaced (forget())
    /// leaves no trace.
    @ObservationIgnored private var saveID: UUID?

    init() {
        savedAt = OfflineGamesRecord.savedAt
    }

    private var isDue: Bool {
        guard let savedAt else { return true }
        // An update may know of files the last version did not
        // (OfflineAssets.builtInScript).
        if OfflineGamesRecord.version != AppConfig.version { return true }
        return Date().timeIntervalSince(savedAt) >= Self.refreshInterval || savedAt > Date()
    }

    /// Saves the games, unless they were saved lately or are being saved
    /// now. The caller checks there is a connection worth using.
    func saveIfDue() {
        guard saveID == nil, isDue else { return }
        let id = UUID()
        saveID = id
        isSaving = true
        Task {
            let complete = await GameFileFetcher().fetchAll()
            guard saveID == id else { return }
            saveID = nil
            isSaving = false
            // Not when a file of the site's could not be fetched: the next
            // chance tries again.
            if complete {
                let now = Date()
                OfflineGamesRecord.saved(at: now)
                savedAt = now
            }
        }
    }

    /// WebKit's cache was emptied (Settings' Clear Cache), and the saved
    /// games with it.
    func forget() {
        saveID = nil
        isSaving = false
        savedAt = nil
        OfflineGamesRecord.forget()
    }
}

/// When the games were last saved whole, and by which version of the app,
/// kept across launches. The screenshot tests write it too, so that their
/// models never fetch from the site.
enum OfflineGamesRecord {
    static var savedAt: Date? {
        UserDefaults.standard.object(forKey: Preferences.offlineGamesSavedAtKey) as? Date
    }

    static var version: String? {
        UserDefaults.standard.string(forKey: Preferences.offlineGamesVersionKey)
    }

    static func saved(at date: Date = Date()) {
        UserDefaults.standard.set(date, forKey: Preferences.offlineGamesSavedAtKey)
        UserDefaults.standard.set(AppConfig.version, forKey: Preferences.offlineGamesVersionKey)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: Preferences.offlineGamesSavedAtKey)
        UserDefaults.standard.removeObject(forKey: Preferences.offlineGamesVersionKey)
    }
}

/// A web view nobody sees, on a blank page of the site's own, that fetches
/// the games' files so WebKit keeps them in its cache. A page at
/// https://empanadas.io, because WebKit keeps a cached file for the site
/// whose page asked for it: the game player, on the same site, finds them.
@MainActor
private final class GameFileFetcher: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var opening: CheckedContinuation<Bool, Never>?

    /// Each round's files are read for the files they name, up to this many
    /// rounds: pages, then their stylesheets and scripts, then the fonts in
    /// those (Google Fonts' stylesheet, then its font files).
    private static let rounds = 4

    override init() {
        // No bridge: nothing on this page is the player's to see.
        webView = WKWebView(frame: .zero, configuration: WebEnvironment.makeConfiguration(bridge: false))
        super.init()
        webView.navigationDelegate = self
    }

    /// Fetches every game's files. False if any of the site's could not be
    /// fetched (no connection, the site down); Google Fonts not answering
    /// does not count, since the games fall back to a system font.
    func fetchAll() async -> Bool {
        guard await open() else { return false }

        let pages = Set(OfflineAssets.pages)
        var seen = Set<URL>()
        var complete = true
        var next = OfflineAssets.pages + OfflineAssets.builtInScript

        for _ in 0..<Self.rounds {
            let batch = next.filter { seen.insert($0).inserted }
            guard !batch.isEmpty else { break }
            let reads = batch.filter { pages.contains($0) || OfflineAssets.namesMoreFiles($0) }
            guard let results = await fetch(batch, reading: reads) else { return false }

            next = []
            for (url, result) in zip(batch, results) {
                if SiteURLs.isAppURL(url) && Self.failed(result, isPage: pages.contains(url)) {
                    complete = false
                }
                guard let text = result.text else { continue }
                if pages.contains(url) {
                    next += OfflineAssets.named(inPage: text, at: url)
                } else if OfflineAssets.isStylesheet(url) {
                    next += OfflineAssets.named(inStylesheet: text, at: url)
                } else if OfflineAssets.isScript(url) {
                    next += OfflineAssets.named(inScript: text, at: url)
                }
            }
        }
        return complete
    }

    private struct FetchResult {
        /// 0: no answer at all.
        let status: Int
        /// The file, for the ones asked to be read.
        let text: String?
    }

    /// A file of the site's that could not be had. A 404 is not that: a
    /// file the games no longer ask for, with nothing to save.
    private static func failed(_ result: FetchResult, isPage: Bool) -> Bool {
        if result.status == 0 || result.status >= 500 { return true }
        return isPage && !(200..<300).contains(result.status)
    }

    // Runs in the blank page: fetches every file, a few at a time, and hands
    // back each one's status, and the text of those in `reads`. cache:
    // 'no-cache' asks the site whether a saved copy is still current (a 304
    // keeps it) rather than trusting it or fetching it whole again. Every
    // body is read to the end, so WebKit has all of it to keep.
    private static let script = """
        const wanted = new Set(reads);
        const results = new Array(urls.length);
        let next = 0;
        async function one(url) {
          try {
            const response = await fetch(url, {
              cache: 'no-cache',
              credentials: 'same-origin',
              signal: AbortSignal.timeout(30000),
            });
            if (response.ok && wanted.has(url)) {
              return { status: response.status, text: await response.text() };
            }
            await response.arrayBuffer();
            return { status: response.status, text: null };
          } catch (error) {
            return { status: 0, text: null };
          }
        }
        async function worker() {
          while (next < urls.length) {
            const index = next++;
            results[index] = await one(urls[index]);
          }
        }
        await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
        return results;
        """

    /// One result per URL, in order, or nil if the page could not run the
    /// script (its process went away).
    private func fetch(_ urls: [URL], reading reads: [URL]) async -> [FetchResult]? {
        let arguments: [String: Any] = [
            "urls": urls.map(\.absoluteString),
            "reads": reads.map(\.absoluteString),
        ]
        guard let value = try? await webView.callAsyncJavaScript(Self.script, arguments: arguments, contentWorld: .page),
              let list = value as? [[String: Any]], list.count == urls.count else { return nil }
        return list.map { item in
            FetchResult(status: (item["status"] as? NSNumber)?.intValue ?? 0, text: item["text"] as? String)
        }
    }

    // MARK: - The blank page

    private func open() async -> Bool {
        await withCheckedContinuation { continuation in
            opening = continuation
            webView.loadHTMLString("<!doctype html><title>Empanadas.io</title>", baseURL: SiteURLs.site)
        }
    }

    private func opened(_ success: Bool) {
        opening?.resume(returning: success)
        opening = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        // The blank page, and nothing after it.
        opening == nil ? .cancel : .allow
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        opened(true)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        opened(false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        opened(false)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        opened(false)
    }
}
