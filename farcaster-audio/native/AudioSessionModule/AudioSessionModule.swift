import ExpoModulesCore
import AVFoundation

public class AudioSessionModule: Module {
    public func definition() -> ModuleDefinition {
        Name("AudioSessionModule")

        AsyncFunction("configureForVoiceChat") { () -> Bool in
            let session = AVAudioSession.sharedInstance()

            do {
                try session.setCategory(
                    .playAndRecord,
                    mode: .voiceChat,
                    options: [
                        .allowBluetooth,
                        .allowBluetoothA2DP,
                        .defaultToSpeaker
                    ]
                )
                try session.setActive(true, options: .notifyOthersOnDeactivation)

                NotificationCenter.default.addObserver(
                    forName: AVAudioSession.interruptionNotification,
                    object: session,
                    queue: .main
                ) { [weak self] notification in
                    self?.handleInterruption(notification)
                }

                NotificationCenter.default.addObserver(
                    forName: AVAudioSession.routeChangeNotification,
                    object: session,
                    queue: .main
                ) { [weak self] notification in
                    self?.handleRouteChange(notification)
                }

                return true
            } catch {
                print("AVAudioSession configuration failed: \(error)")
                return false
            }
        }

        AsyncFunction("deactivate") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
                NotificationCenter.default.removeObserver(self)
                return true
            } catch {
                return false
            }
        }

        AsyncFunction("setToSpeaker") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.overrideOutputAudioPort(.speaker)
                return true
            } catch {
                return false
            }
        }

        AsyncFunction("setToEarpiece") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.overrideOutputAudioPort(.none)
                return true
            } catch {
                return false
            }
        }

        Events("onAudioInterruption", "onRouteChange")
    }

    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            sendEvent("onAudioInterruption", ["type": "began"])
        case .ended:
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    sendEvent("onAudioInterruption", ["type": "ended", "shouldResume": true])
                }
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        let currentRoute = AVAudioSession.sharedInstance().currentRoute
        let outputType = currentRoute.outputs.first?.portType.rawValue ?? "unknown"

        sendEvent("onRouteChange", [
            "reason": reason.rawValue,
            "outputType": outputType
        ])
    }
}
