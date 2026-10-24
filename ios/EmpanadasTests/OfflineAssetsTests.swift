import XCTest
@testable import Empanadas

/// What saving the games for offline play fetches (OfflineAssets), checked
/// against excerpts of the site's own pages, stylesheets and scripts. A miss
/// here is a game that starts offline without its styles, pictures or sounds.
final class OfflineAssetsTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }
    private func strings(_ urls: [URL]) -> [String] { urls.map(\.absoluteString) }

    private let spin = URL(string: "https://empanadas.io/spin")!

    func testStartsFromEveryGamesPage() {
        XCTAssertEqual(strings(OfflineAssets.pages), [
            "https://empanadas.io/spin",
            "https://empanadas.io/flappy",
            "https://empanadas.io/tower",
        ])
    }

    func testSavesTheSitesFilesAndGoogleFonts() {
        XCTAssertTrue(OfflineAssets.isSaved(url("https://empanadas.io/Content/Code/JS/spin.js")))
        XCTAssertTrue(OfflineAssets.isSaved(url("https://empanadas.io/Content/Code/CSS/spin.css?v=6.10.2")))
        XCTAssertTrue(OfflineAssets.isSaved(url("https://empanadas.io/Content/Sounds/SpinGame/Speenz/1.mp3")))
        XCTAssertTrue(OfflineAssets.isSaved(url("https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&display=swap")))
        XCTAssertTrue(OfflineAssets.isSaved(url("https://fonts.gstatic.com/s/poppins/v22/pxiByp8kv8JHgFVrLGT9Z1xlFQ.woff2")))
    }

    func testLeavesEverythingElseAlone() {
        XCTAssertFalse(OfflineAssets.isSaved(url("https://empanadas.io/v2/dashboard")), "another page")
        XCTAssertFalse(OfflineAssets.isSaved(url("https://empanadas.io/v2/getdata.php")), "the save")
        XCTAssertFalse(OfflineAssets.isSaved(url("https://api.empanadas.io/time")), "the clock")
        XCTAssertFalse(OfflineAssets.isSaved(url("https://www.googletagmanager.com/gtag/js?id=G-B50QZ2MPN0")))
        XCTAssertFalse(OfflineAssets.isSaved(url("https://fonts.googleapis.com")), "a preconnect")
        XCTAssertFalse(OfflineAssets.isSaved(url("https://fonts.gstatic.com/")), "a preconnect")
        XCTAssertFalse(OfflineAssets.isSaved(url("http://empanadas.io/Content/Code/JS/spin.js")), "plain http")
        XCTAssertFalse(OfflineAssets.isSaved(url("https://empanadas.io.example.com/Content/x.png")), "a lookalike")
        XCTAssertFalse(OfflineAssets.isSaved(url("https://empanadas.io/Content/Icons/fa/webfonts/fa-solid-900.ttf")),
                       "a font's older format")
    }

    func testReadsWhatAPageNames() {
        // From the site's spin.html.
        let html = """
            <link rel="icon" type="image/png" sizes="32x32" href="/Content/Icons/favicon-32x32.png" crossorigin="anonymous">
            <link href='/favicon.ico' rel='shortcut icon' crossorigin="anonymous" type='image/x-icon'/>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link rel="stylesheet" href="/Content/Code/CSS/core.css" crossorigin="anonymous" media="print" onload="this.media='all'; this.onload=null;">
            <link id="css" rel="stylesheet" href="/Content/Code/CSS/spin.css?v=6.10.2" media="print">
            <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700&amp;family=Poppins:wght@300;400&display=swap" rel="stylesheet">
            <script async src="https://www.googletagmanager.com/gtag/js?id=G-B50QZ2MPN0"></script>
            <img id="loadimg" class="slowspin" src="/Content/Images/empanada.webp" width="100" height="100">
            <p>Join our <a href="/discord" target="_blank">support discord</a></p>
            <a class="srow" name="signed_in_content" href="/v2/feedback?reason=3" target="_blank">
            <img src="/Content/Icons/pepper.png" width="20" height="20" alt="">
            <img src=/Content/Images/blank.png alt="Rank">
            <svg class="pick"><use href="#i-pick"/></svg>
            <img src="/Content/Icons/pepper.png" width="37" alt="Pepper">
            <script src="/Content/Code/JS/howler.js"></script>
            <script src="/Content/Code/JS/spin.js" async defer></script>
            """
        XCTAssertEqual(strings(OfflineAssets.named(inPage: html, at: spin)), [
            "https://empanadas.io/Content/Icons/favicon-32x32.png",
            "https://empanadas.io/Content/Code/CSS/core.css",
            "https://empanadas.io/Content/Code/CSS/spin.css?v=6.10.2",
            "https://fonts.googleapis.com/css2?family=Montserrat:wght@700&family=Poppins:wght@300;400&display=swap",
            "https://empanadas.io/Content/Images/empanada.webp",
            "https://empanadas.io/Content/Icons/pepper.png",
            "https://empanadas.io/Content/Images/blank.png",
            "https://empanadas.io/Content/Code/JS/howler.js",
            "https://empanadas.io/Content/Code/JS/spin.js",
        ])
    }

    func testReadsAStylesheetsFontsAndPictures() {
        let stylesheet = url("https://empanadas.io/Content/Icons/fa/css/all.min.css")
        let css = """
            @font-face{font-family:"Font Awesome 6 Free";src:url(../webfonts/fa-solid-900.woff2) format("woff2"),url(../webfonts/fa-solid-900.ttf) format("truetype")}
            @font-face{font-family:"Old";src:url('../webfonts/old.eot');src:url("../webfonts/old.svg#fontawesome") format("svg")}
            .banner{background:url( "/Content/Icons/banner-bg.svg" )}
            .dot{background-image:url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg'%3e%3c/svg%3e")}
            .mask{mask:url(#fade)}
            .again{background:url(../webfonts/fa-solid-900.woff2)}
            """
        XCTAssertEqual(strings(OfflineAssets.named(inStylesheet: css, at: stylesheet)), [
            "https://empanadas.io/Content/Icons/fa/webfonts/fa-solid-900.woff2",
            "https://empanadas.io/Content/Icons/banner-bg.svg",
        ])
    }

    func testReadsGoogleFontsFiles() {
        let stylesheet = url("https://fonts.googleapis.com/css2?family=Poppins:wght@500&display=swap")
        let css = """
            /* latin */
            @font-face {
              font-family: 'Poppins';
              font-style: normal;
              font-weight: 500;
              font-display: swap;
              src: url(https://fonts.gstatic.com/s/poppins/v22/pxiByp8kv8JHgFVrLGT9Z1xlFQ.woff2) format('woff2');
            }
            """
        XCTAssertEqual(strings(OfflineAssets.named(inStylesheet: css, at: stylesheet)), [
            "https://fonts.gstatic.com/s/poppins/v22/pxiByp8kv8JHgFVrLGT9Z1xlFQ.woff2",
        ])
    }

    func testReadsTheSoundsAndPicturesAScriptNamesWhole() {
        let script = url("https://empanadas.io/Content/Code/JS/spin.js")
        // Shaped like the site's minified spin.js and flappy.js.
        let js = """
            const aerr=new Audio("/Content/Sounds/error.wav"),jingle=new Audio('/Content/Sounds/SpinGame/spinwin.mp3');
            const MEDAL_PATH="/Content/Images/SpinGame/Medals/";let r={img:MEDAL_PATH+"5.gif"};
            fetch(`/Content/Sounds/gameoversound.mp3`);rankimg.src="/Content/Images/blank.png";
            let path="/Content/Sounds/";playSound("zap.mp3");x.href="/v2/dashboard";
            """
        XCTAssertEqual(strings(OfflineAssets.named(inScript: js, at: script)), [
            "https://empanadas.io/Content/Sounds/error.wav",
            "https://empanadas.io/Content/Sounds/SpinGame/spinwin.mp3",
            "https://empanadas.io/Content/Sounds/gameoversound.mp3",
            "https://empanadas.io/Content/Images/blank.png",
        ])
    }

    func testTheFilesSpinBuildsThePathOfAreTheSitesOwn() {
        XCTAssertFalse(OfflineAssets.builtInScript.isEmpty)
        for file in OfflineAssets.builtInScript {
            XCTAssertTrue(OfflineAssets.isSaved(file), file.absoluteString)
        }
        XCTAssertEqual(Set(strings(OfflineAssets.builtInScript)).count, OfflineAssets.builtInScript.count, "listed twice")
        XCTAssertTrue(strings(OfflineAssets.builtInScript).contains("https://empanadas.io/Content/Sounds/SpinGame/Speenz/9.mp3"))
    }

    func testReadsStylesheetsAndTheSitesScriptsForMoreFiles() {
        XCTAssertTrue(OfflineAssets.namesMoreFiles(url("https://empanadas.io/Content/Code/CSS/tower.css?v=1.9")))
        XCTAssertTrue(OfflineAssets.namesMoreFiles(url("https://empanadas.io/Content/Code/JS/tower.js?v=1.9")))
        XCTAssertTrue(OfflineAssets.namesMoreFiles(url("https://fonts.googleapis.com/css2?family=Poppins:wght@500")))
        XCTAssertFalse(OfflineAssets.namesMoreFiles(url("https://empanadas.io/Content/Images/empanada.webp")))
        XCTAssertFalse(OfflineAssets.namesMoreFiles(url("https://empanadas.io/Content/Sounds/button.mp3")))
    }
}
