import SwiftUI

// The site's look, for the parts of the native screens that carry it:
// Poppins, the site's face, and the blue wave banner the site puts behind the
// dashboard's and the profiles' heroes (.wave-jumbo in the site's
// Content/Code/CSS/accounts.css).

// MARK: - Poppins

/// The weights of Poppins the app bundles (Resources/Fonts, listed under
/// UIAppFonts in Info.plist), by PostScript name. Poppins is for what carries
/// the brand: names in the banners, card titles and the big numbers. Body
/// text, lists and controls stay the system's, as in the desktop app.
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

// MARK: - The wave banner

/// The site's banner: a gradient from indigo at the top to blue at the
/// bottom, under the wave art of banner-bg.svg, which the site's CSS lays over
/// it at `cover`, 30% 30%. Drawn the same way here, so the waves fall where
/// the site's do on a banner of the same shape. With Increase Contrast it is
/// a shade darker, for the white on it.
struct WaveBanner: View {
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let colors = contrast == .increased
            ? [Palette.bannerTopContrast, Palette.bannerBottomContrast]
            : [Palette.bannerTop, Palette.bannerBottom]
        Canvas { context, size in
            let gradient = Gradient(colors: colors)
            context.fill(Path(CGRect(origin: .zero, size: size)),
                         with: .linearGradient(gradient, startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))

            // background-size: cover; background-position: 30% 30%.
            let art = WaveArt.size
            let scale = max(size.width / art.width, size.height / art.height)
            let drawn = CGSize(width: art.width * scale, height: art.height * scale)
            let origin = CGPoint(x: (size.width - drawn.width) * 0.3, y: (size.height - drawn.height) * 0.3)
            let transform = CGAffineTransform(translationX: origin.x, y: origin.y).scaledBy(x: scale, y: scale)
            // The art's own gradient spans the art, not the banner.
            let fill = GraphicsContext.Shading.linearGradient(
                gradient, startPoint: origin, endPoint: CGPoint(x: origin.x, y: origin.y + drawn.height))
            let wave = WaveArt.wave.applying(transform)

            var shadow = context
            shadow.opacity = 0.11
            shadow.fill(WaveArt.shadow.applying(transform), with: fill)
            context.fill(wave, with: fill)

            var swoosh = context
            swoosh.clip(to: wave)
            swoosh.opacity = 0.14
            swoosh.stroke(WaveArt.swoosh.applying(transform), with: .color(colors[0]), lineWidth: 128 * scale)
        }
        .accessibilityHidden(true)
    }
}

/// banner-bg.svg's three shapes, in its own coordinates (1920 × 1076), with
/// its transforms and smooth curves worked out to absolute points.
private enum WaveArt {
    static let size = CGSize(width: 1920.183, height: 1075.636)

    /// The top of the art, down to the wave.
    static var wave: Path {
        Path { p in
            p.move(to: pt(-0.03, 607.52))
            p.addCurve(to: pt(401.18, 768.66), control1: pt(-0.03, 607.52), control2: pt(95.24, 811.71))
            p.addCurve(to: pt(945.37, 865.56), control1: pt(707.12, 725.62), control2: pt(820.84, 736.56))
            p.addCurve(to: pt(1518.28, 932.62), control1: pt(1069.9, 994.55), control2: pt(1289.34, 973.1))
            p.addCurve(to: pt(1920.07, 1075.59), control1: pt(1747.21, 892.15), control2: pt(1878.47, 1000.78))
            p.addLine(to: pt(1919.99, -0.03))
            p.addLine(to: pt(-0.01, -0.02))
            p.closeSubpath()
        }
    }

    /// The same a little lower, faint behind it.
    static var shadow: Path {
        Path { p in
            p.move(to: pt(-0.09, 607.36))
            p.addCurve(to: pt(401.12, 798.84), control1: pt(-0.09, 607.36), control2: pt(100.34, 847.31))
            p.addCurve(to: pt(938.75, 913.78), control1: pt(701.89, 750.37), control2: pt(843.18, 808.42))
            p.addCurve(to: pt(1519.73, 966.16), control1: pt(1034.31, 1019.15), control2: pt(1290.84, 1008.11))
            p.addCurve(to: pt(1920.09, 1075.59), control1: pt(1748.63, 924.2), control2: pt(1882.9, 1007.95))
            p.addLine(to: pt(1919.72, -0.01))
            p.addLine(to: pt(-0.05, -0.04))
            p.closeSubpath()
        }
    }

    /// The broad stroke across the middle, 128 wide.
    static var swoosh: Path {
        Path { p in
            p.move(to: pt(25.63, 687.7))
            p.addCurve(to: pt(843.07, 432.67), control1: pt(25.63, 687.7), control2: pt(199.87, 295.65))
            p.addCurve(to: pt(1899.23, -31.31), control1: pt(1486.26, 569.68), control2: pt(1712.48, 510.14))
        }
    }

    private static func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: x, y: y)
    }
}

extension View {
    /// White on the wave banner, in a rounded card: the heroes of Home, the
    /// profiles and Manage Game Data.
    func waveBanner(cornerRadius: CGFloat = 24) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return foregroundStyle(.white)
            .background {
                WaveBanner()
                    .clipShape(shape)
                    .shadow(color: Palette.bannerTop.opacity(0.22), radius: 14, y: 6)
            }
    }

    /// A button on a banner, as the site's .btn-hero: white on a wash of
    /// white, with a white edge.
    func bannerCapsule() -> some View {
        font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(.white.opacity(0.16), in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.38), lineWidth: 1))
            .contentShape(Capsule())
    }

    /// A box on a banner for something to do (the site's .dash-nudge): a
    /// shade darker than the banner, with a faint white edge.
    func bannerInset(cornerRadius: CGFloat = 14) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        return background(.black.opacity(0.2), in: shape)
            .overlay(shape.strokeBorder(.white.opacity(0.2), lineWidth: 1))
    }
}

/// A profile picture on a banner: a white ring around it and a soft shadow
/// under it, so it stands off the blue.
struct BannerAvatar: View {
    let url: URL?
    var size: CGFloat

    var body: some View {
        Avatar(url: url, size: size)
            .padding(3)
            .background(.white.opacity(0.9), in: Circle())
            .shadow(color: .black.opacity(0.22), radius: 10, y: 4)
    }
}
