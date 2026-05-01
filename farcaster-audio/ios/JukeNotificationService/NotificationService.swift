import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent

        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        // DIAGNOSTIC — remove once PFP path is confirmed.
        // Prepend top-level userInfo keys + extracted image URL prefix so we
        // can see on-device what the APNs payload actually contains.
        let userInfo = request.content.userInfo
        let keys = userInfo.keys
            .compactMap { $0 as? String }
            .sorted()
            .joined(separator: ",")
        let urlString = Self.extractImageURL(from: userInfo)
        let urlSnippet = urlString.map { String($0.prefix(40)) } ?? "nil"
        content.body = "[keys=\(keys)][img=\(urlSnippet)] " + content.body

        guard let urlString = urlString, let url = URL(string: urlString) else {
            contentHandler(content)
            return
        }

        URLSession.shared.downloadTask(with: url) { tmp, _, error in
            defer { contentHandler(content) }
            if let error = error {
                let msg = String(error.localizedDescription.prefix(30))
                content.body = "[err=\(msg)] " + content.body
                return
            }
            guard let tmp = tmp else {
                content.body = "[err=no-tmp] " + content.body
                return
            }
            let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
            let dst = tmp.deletingLastPathComponent()
                .appendingPathComponent("\(UUID().uuidString).\(ext)")
            try? FileManager.default.moveItem(at: tmp, to: dst)
            if let attachment = try? UNNotificationAttachment(identifier: "pfp", url: dst) {
                content.attachments = [attachment]
            } else {
                content.body = "[err=attach-failed] " + content.body
            }
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler = contentHandler, let content = bestAttemptContent {
            contentHandler(content)
        }
    }

    private static func extractImageURL(from userInfo: [AnyHashable: Any]) -> String? {
        if let rich = userInfo["richContent"] as? [String: Any],
           let image = rich["image"] as? String, !image.isEmpty {
            return image
        }
        if let body = userInfo["body"] as? [String: Any],
           let rich = body["richContent"] as? [String: Any],
           let image = rich["image"] as? String, !image.isEmpty {
            return image
        }
        return nil
    }
}
