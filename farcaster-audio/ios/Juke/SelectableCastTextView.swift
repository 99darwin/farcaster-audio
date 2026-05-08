import UIKit
import React

@objc(SelectableCastTextViewManager)
class SelectableCastTextViewManager: RCTViewManager {
  override func view() -> UIView! {
    return SelectableCastTextView()
  }

  override static func requiresMainQueueSetup() -> Bool {
    return true
  }
}

class SelectableCastTextView: UIView, UITextViewDelegate {
  private let textView = UITextView()
  private var measuredHeight: CGFloat = 0

  @objc var text: NSString = "" {
    didSet { updateAttributedText() }
  }

  @objc var textColor: NSString = "#E0E0E0" {
    didSet { updateAttributedText() }
  }

  @objc var linkColor: NSString = "#855DCD" {
    didSet { updateAttributedText() }
  }

  @objc var fontSize: NSNumber = 15 {
    didSet { updateAttributedText() }
  }

  @objc var lineHeight: NSNumber = 21 {
    didSet { updateAttributedText() }
  }

  @objc var onLinkPress: RCTDirectEventBlock?
  @objc var onSizeChange: RCTDirectEventBlock?

  override init(frame: CGRect) {
    super.init(frame: frame)

    textView.backgroundColor = .clear
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.delegate = self
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.adjustsFontForContentSizeCategory = false
    textView.setContentCompressionResistancePriority(.required, for: .vertical)
    textView.setContentHuggingPriority(.required, for: .vertical)

    addSubview(textView)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    emitMeasuredHeightIfNeeded()
  }

  private func updateAttributedText() {
    let rawText = text as String
    let baseFont = UIFont.systemFont(ofSize: CGFloat(truncating: fontSize))
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.minimumLineHeight = CGFloat(truncating: lineHeight)
    paragraphStyle.maximumLineHeight = CGFloat(truncating: lineHeight)

    let attributed = NSMutableAttributedString(
      string: rawText,
      attributes: [
        .font: baseFont,
        .foregroundColor: UIColor(hexString: textColor as String) ?? .label,
        .paragraphStyle: paragraphStyle,
      ])

    let linkUIColor = UIColor(hexString: linkColor as String) ?? .systemPurple
    let fullRange = NSRange(location: 0, length: (rawText as NSString).length)
    let nsText = rawText as NSString

    if let urlRegex = try? NSRegularExpression(pattern: #"https?://[^\s<)}\]]+"#) {
      urlRegex.enumerateMatches(in: rawText, range: fullRange) { match, _, _ in
        guard let range = match?.range else { return }
        let value = nsText.substring(with: range)
        guard let url = URL(string: value) else { return }
        attributed.addAttributes([
          .link: url,
          .foregroundColor: linkUIColor,
        ], range: range)
      }
    }

    if let mentionRegex = try? NSRegularExpression(pattern: #"(?<!\w)@[\w][\w.]*[\w]|(?<!\w)@[\w]"#) {
      mentionRegex.enumerateMatches(in: rawText, range: fullRange) { match, _, _ in
        guard let range = match?.range else { return }
        let value = nsText.substring(with: range)
        let username = String(value.dropFirst())
        guard let encoded = username.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "juke-mention://\(encoded)") else { return }
        attributed.addAttributes([
          .link: url,
          .foregroundColor: linkUIColor,
        ], range: range)
      }
    }

    textView.attributedText = attributed
    textView.linkTextAttributes = [
      .foregroundColor: linkUIColor,
    ]
    emitMeasuredHeightIfNeeded()
  }

  private func emitMeasuredHeightIfNeeded() {
    guard bounds.width > 0 else { return }
    let size = textView.sizeThatFits(
      CGSize(width: bounds.width, height: CGFloat.greatestFiniteMagnitude))
    let nextHeight = ceil(size.height)
    guard abs(nextHeight - measuredHeight) >= 0.5 else { return }
    measuredHeight = nextHeight
    onSizeChange?(["height": nextHeight])
  }

  func textView(
    _ textView: UITextView,
    shouldInteractWith URL: URL,
    in characterRange: NSRange,
    interaction: UITextItemInteraction
  ) -> Bool {
    if URL.scheme == "juke-mention" {
      onLinkPress?([
        "type": "mention",
        "value": URL.host ?? "",
      ])
      return false
    }

    onLinkPress?([
      "type": "url",
      "value": URL.absoluteString,
    ])
    return false
  }
}

private extension UIColor {
  convenience init?(hexString: String) {
    var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    if hex.hasPrefix("#") {
      hex.removeFirst()
    }
    guard hex.count == 6, let value = Int(hex, radix: 16) else {
      return nil
    }
    self.init(
      red: CGFloat((value >> 16) & 0xff) / 255.0,
      green: CGFloat((value >> 8) & 0xff) / 255.0,
      blue: CGFloat(value & 0xff) / 255.0,
      alpha: 1.0)
  }
}
