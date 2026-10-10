import Foundation

/// A colour as getComputedStyle() writes it: "rgb(47, 49, 63)",
/// "rgba(0, 0, 0, 0)", "rgb(47 49 63 / 0.5)", or a hex "#2f313f". The bridge
/// reports the page's background this way (pageColor in Resources/bridge.js),
/// so the space around a web view matches the page instead of a fixed colour.
/// Components are 0...1.
struct CSSColor: Equatable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double

    init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    init?(_ css: String) {
        let text = css.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard text.count <= 64 else { return nil }

        if text.hasPrefix("#") {
            guard let parsed = Self.hex(String(text.dropFirst())) else { return nil }
            self = parsed
            return
        }

        guard text.hasPrefix("rgb"), let open = text.firstIndex(of: "("), let close = text.lastIndex(of: ")"),
              open < close else { return nil }
        let inner = text[text.index(after: open)..<close]
            .replacingOccurrences(of: ",", with: " ")
            .replacingOccurrences(of: "/", with: " ")
        let parts = inner.split(separator: " ").map(String.init)
        guard parts.count == 3 || parts.count == 4 else { return nil }

        var channels: [Double] = []
        for part in parts.prefix(3) {
            guard let value = Self.number(part, scale: 255) else { return nil }
            channels.append(value)
        }
        var alpha = 1.0
        if parts.count == 4 {
            guard let value = Self.number(parts[3], scale: 1) else { return nil }
            alpha = value
        }
        self.init(red: channels[0], green: channels[1], blue: channels[2], alpha: alpha)
    }

    /// Fully or nearly see-through: says nothing about what the page looks like.
    var isTransparent: Bool { alpha < 0.05 }

    /// "50%" or a plain number out of `scale`, clamped to 0...1.
    private static func number(_ text: String, scale: Double) -> Double? {
        if text.hasSuffix("%") {
            guard let value = Double(text.dropLast()) else { return nil }
            return min(max(value / 100, 0), 1)
        }
        guard let value = Double(text), value.isFinite else { return nil }
        return min(max(value / scale, 0), 1)
    }

    private static func hex(_ digits: String) -> CSSColor? {
        var expanded = digits
        if digits.count == 3 || digits.count == 4 {
            expanded = digits.map { "\($0)\($0)" }.joined()
        }
        guard expanded.count == 6 || expanded.count == 8, let value = UInt64(expanded, radix: 16) else { return nil }
        let hasAlpha = expanded.count == 8
        let rgb = hasAlpha ? value >> 8 : value
        return CSSColor(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            alpha: hasAlpha ? Double(value & 0xFF) / 255 : 1
        )
    }
}
