import ExpoModulesCore
import AVFoundation
import Accelerate

public class JukeVoiceRecorder: Module {
    private var recorder: AVAudioRecorder?
    private var levelTimer: Timer?
    private var recordingStartTime: Date?
    private var outputURL: URL?

    public func definition() -> ModuleDefinition {
        Name("JukeVoiceRecorder")

        Events("onPeakLevel")

        AsyncFunction("startRecording") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .spokenAudio,
                options: [.allowBluetoothHFP, .defaultToSpeaker]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let fileName = UUID().uuidString + ".m4a"
            let tempDir = FileManager.default.temporaryDirectory
            let url = tempDir.appendingPathComponent(fileName)
            self.outputURL = url

            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 96000,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ]

            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            recorder.record()
            self.recorder = recorder
            self.recordingStartTime = Date()

            self.levelTimer = Timer.scheduledTimer(
                withTimeInterval: 0.05,
                repeats: true
            ) { [weak self] _ in
                guard let self = self,
                      let recorder = self.recorder,
                      recorder.isRecording else { return }
                recorder.updateMeters()
                let power = recorder.averagePower(forChannel: 0)
                let minDb: Float = -60
                let normalized = max(0, min(1, (power - minDb) / (-minDb)))
                self.sendEvent("onPeakLevel", ["level": normalized])
            }

            return true
        }

        AsyncFunction("stopRecording") { () -> [String: Any] in
            guard let recorder = self.recorder, recorder.isRecording else {
                throw NSError(
                    domain: "JukeVoiceRecorder",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No active recording"]
                )
            }

            self.levelTimer?.invalidate()
            self.levelTimer = nil

            recorder.stop()

            let durationMs: Int
            if let startTime = self.recordingStartTime {
                durationMs = Int(Date().timeIntervalSince(startTime) * 1000)
            } else {
                durationMs = 0
            }
            let rawURL = recorder.url
            self.recorder = nil

            // Reset audio session to playback mode
            try? session.setCategory(.playback, mode: .default, options: [])

            // Normalize audio to maximize loudness
            let normalizedURL = try await self.normalizeAudio(from: rawURL)
            let peaks = try self.extractPeaks(from: normalizedURL, count: 200)

            return [
                "filePath": normalizedURL.path,
                "durationMs": durationMs,
                "peaks": peaks
            ]
        }

        AsyncFunction("cancelRecording") { () -> Bool in
            self.levelTimer?.invalidate()
            self.levelTimer = nil

            if let recorder = self.recorder {
                recorder.stop()
                recorder.deleteRecording()
                self.recorder = nil
            }

            // Reset audio session to playback mode
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .default, options: [])

            return true
        }

        AsyncFunction("trimRecording") { (filePath: String, startMs: Int, endMs: Int) -> [String: Any] in
            let sourceURL = URL(fileURLWithPath: filePath)

            let tempDir = FileManager.default.temporaryDirectory.path
            guard filePath.hasPrefix(tempDir) else {
                throw NSError(domain: "JukeVoiceRecorder", code: 6,
                    userInfo: [NSLocalizedDescriptionKey: "Invalid file path: must be in temp directory"])
            }

            let asset = AVURLAsset(url: sourceURL)

            let startTime = CMTime(value: CMTimeValue(startMs), timescale: 1000)
            let endTime = CMTime(value: CMTimeValue(endMs), timescale: 1000)
            let timeRange = CMTimeRange(start: startTime, end: endTime)

            let composition = AVMutableComposition()
            guard let track = asset.tracks(withMediaType: .audio).first,
                  let compositionTrack = composition.addMutableTrack(
                      withMediaType: .audio,
                      preferredTrackID: kCMPersistentTrackID_Invalid
                  ) else {
                throw NSError(
                    domain: "JukeVoiceRecorder",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to create composition"]
                )
            }

            try compositionTrack.insertTimeRange(timeRange, of: track, at: .zero)

            let outputFileName = UUID().uuidString + ".m4a"
            let outputURL = FileManager.default.temporaryDirectory
                .appendingPathComponent(outputFileName)

            guard let exporter = AVAssetExportSession(
                asset: composition,
                presetName: AVAssetExportPresetAppleM4A
            ) else {
                throw NSError(
                    domain: "JukeVoiceRecorder",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to create export session"]
                )
            }

            exporter.outputURL = outputURL
            exporter.outputFileType = .m4a

            await exporter.export()

            guard exporter.status == .completed else {
                throw exporter.error ?? NSError(
                    domain: "JukeVoiceRecorder",
                    code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "Export failed"]
                )
            }

            let durationMs = endMs - startMs
            let peaks = try self.extractPeaks(from: outputURL, count: 200)

            return [
                "filePath": outputURL.path,
                "durationMs": durationMs,
                "peaks": peaks
            ]
        }
    }

    /// Normalize audio to peak amplitude, then re-encode as AAC.
    /// Target peak at 0.95 to avoid clipping.
    private func normalizeAudio(from sourceURL: URL) async throws -> URL {
        let file = try AVAudioFile(forReading: sourceURL)
        let format = file.processingFormat
        let frameCount = AVAudioFrameCount(file.length)

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return sourceURL // fallback to original
        }
        try file.read(into: buffer)

        guard let channelData = buffer.floatChannelData?[0] else {
            return sourceURL
        }

        let sampleCount = Int(buffer.frameLength)

        // Find peak amplitude using Accelerate
        var peak: Float = 0
        vDSP_maxmgv(channelData, 1, &peak, vDSP_Length(sampleCount))

        // If already loud enough or silent, skip normalization
        if peak < 0.001 || peak > 0.8 {
            return sourceURL
        }

        // Scale to target peak of 0.95
        var gain = Float(0.95) / peak
        vDSP_vsmul(channelData, 1, &gain, channelData, 1, vDSP_Length(sampleCount))

        // Write normalized PCM to a new file, then export as AAC
        let normalizedFileName = UUID().uuidString + ".m4a"
        let normalizedURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(normalizedFileName)

        // Write as CAF first (lossless intermediate), then export to AAC
        let cafFileName = UUID().uuidString + ".caf"
        let cafURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(cafFileName)

        let outFile = try AVAudioFile(
            forWriting: cafURL,
            settings: format.settings,
            commonFormat: format.commonFormat,
            interleaved: format.isInterleaved
        )
        try outFile.write(from: buffer)

        // Export CAF → AAC M4A
        let asset = AVURLAsset(url: cafURL)
        guard let exporter = AVAssetExportSession(
            asset: asset,
            presetName: AVAssetExportPresetAppleM4A
        ) else {
            // Cleanup and fallback
            try? FileManager.default.removeItem(at: cafURL)
            return sourceURL
        }

        exporter.outputURL = normalizedURL
        exporter.outputFileType = .m4a

        await exporter.export()

        // Cleanup intermediate CAF
        try? FileManager.default.removeItem(at: cafURL)

        if exporter.status == .completed {
            // Remove original quiet file
            try? FileManager.default.removeItem(at: sourceURL)
            return normalizedURL
        }

        return sourceURL // fallback
    }

    /// Extract normalized peaks from an audio file
    private func extractPeaks(from url: URL, count: Int) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let frameCount = UInt32(file.length)

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: frameCount
        ) else {
            throw NSError(
                domain: "JukeVoiceRecorder",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create audio buffer"]
            )
        }

        try file.read(into: buffer)

        guard let channelData = buffer.floatChannelData?[0] else {
            return Array(repeating: 0, count: count)
        }

        let totalSamples = Int(buffer.frameLength)
        let samplesPerPeak = max(1, totalSamples / count)
        var peaks = [Float]()

        for i in 0..<count {
            let start = i * samplesPerPeak
            let end = min(start + samplesPerPeak, totalSamples)
            var maxVal: Float = 0
            for j in start..<end {
                let val = abs(channelData[j])
                if val > maxVal { maxVal = val }
            }
            peaks.append(maxVal)
        }

        let maxPeak = peaks.max() ?? 1
        if maxPeak > 0 {
            peaks = peaks.map { $0 / maxPeak }
        }

        return peaks
    }
}
