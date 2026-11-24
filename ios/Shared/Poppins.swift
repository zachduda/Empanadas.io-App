import SwiftUI

// Poppins, the site's face, in the app and the widget alike: both bundle
// Shared/Fonts and list them under UIAppFonts in their Info.plist.

/// The weights of Poppins bundled (Shared/Fonts), by PostScript name. Poppins
/// is for what carries the brand: names in the banners, card titles and the
/// big numbers. Body text, lists and controls stay the system's, as in the
/// desktop app.
enum Poppins: String, CaseIterable {
    case semibold = "Poppins-SemiBold"
    case bold = "Poppins-Bold"
    case extraBold = "Poppins-ExtraBold"
}

extension Font {
    /// Poppins at the size of `style` (or `size`), growing and shrinking with
    /// the player's text size as that style does. Its digits are
    /// proportional, so a column of numbers to line up stays in the system
    /// font with .monospacedDigit().
    static func brand(_ style: TextStyle, _ weight: Poppins = .bold, size: CGFloat? = nil) -> Font {
        .custom(weight.rawValue, size: size ?? style.defaultPointSize, relativeTo: style)
    }
}

extension Font.TextStyle {
    /// The style's size at the default text size (Large).
    var defaultPointSize: CGFloat {
        switch self {
        case .largeTitle: 34
        case .title: 28
        case .title2: 22
        case .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline: 15
        case .footnote: 13
        case .caption: 12
        case .caption2: 11
        @unknown default: 17
        }
    }
}
