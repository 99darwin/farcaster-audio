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

        guard let urlString = Self.extractImageURL(from: request.content.userInfo),
              let url = URL(string: urlString) else {
            contentHandler(content)
            return
        }

        URLSession.shared.downloadTask(with: url) { tmp, _, _ in
            defer { contentHandler(content) }
            guard let tmp = tmp else { return }
            let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
            let dst = tmp.deletingLastPathComponent()
                .appendingPathComponent("\(UUID().uuidString).\(ext)")
            try? FileManager.default.moveItem(at: tmp, to: dst)
            if let attachment = try? UNNotificationAttachment(identifier: "pfp", url: dst) {
                content.attachments = [attachment]
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
