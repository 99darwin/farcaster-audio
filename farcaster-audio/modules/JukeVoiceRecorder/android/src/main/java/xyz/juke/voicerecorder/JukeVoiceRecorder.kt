package xyz.juke.voicerecorder

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.ShortBuffer
import java.util.UUID
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

private const val SAMPLE_RATE = 48000
private const val CHANNEL_COUNT = 1
private const val BIT_RATE = 96000
private const val PEAK_BUCKETS = 200
private const val LEVEL_INTERVAL_MS = 50L
private const val MIN_DB_FLOOR = -60f
private const val NORMALIZE_TARGET = 0.95f
private const val NORMALIZE_MIN = 0.001f
private const val NORMALIZE_MAX = 0.8f
private const val CODEC_TIMEOUT_US = 10_000L

class JukeVoiceRecorderException(message: String) : CodedException(message)

class JukeVoiceRecorder : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var recorder: MediaRecorder? = null
  private var outputFile: File? = null
  private var recordingStartTimeMs: Long = 0
  private val levelHandler = Handler(Looper.getMainLooper())
  @Volatile private var levelRunnable: Runnable? = null
  private var audioFocusRequest: AudioFocusRequest? = null

  // Recorder lifecycle is single-threaded (only mutated from the JS bridge thread for
  // start/stop/cancel/trim, and read on the main thread for metering). We still guard
  // metering reads against a torn-down recorder.
  private val lock = Any()

  override fun definition() = ModuleDefinition {
    Name("JukeVoiceRecorder")

    Events("onPeakLevel")

    AsyncFunction("startRecording") {
      startRecordingInternal()
      true
    }

    AsyncFunction("stopRecording") {
      stopRecordingInternal()
    }

    AsyncFunction("cancelRecording") {
      cancelRecordingInternal()
      true
    }

    AsyncFunction("trimRecording") { filePath: String, startMs: Int, endMs: Int ->
      trimRecordingInternal(filePath, startMs, endMs)
    }

    OnDestroy {
      // Safety net: tear everything down if the module is destroyed mid-recording
      runCatching { cancelRecordingInternal() }
    }
  }

  // region recording

  private fun startRecordingInternal() {
    synchronized(lock) {
      if (recorder != null) {
        throw JukeVoiceRecorderException("Recording already in progress")
      }

      val ctx = context
      requestAudioFocus(ctx)

      val cacheDir = ctx.cacheDir
      val file = File(cacheDir, "${UUID.randomUUID()}.m4a")

      val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        MediaRecorder(ctx)
      } else {
        @Suppress("DEPRECATION")
        MediaRecorder()
      }

      try {
        mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        mediaRecorder.setAudioSamplingRate(SAMPLE_RATE)
        mediaRecorder.setAudioChannels(CHANNEL_COUNT)
        mediaRecorder.setAudioEncodingBitRate(BIT_RATE)
        mediaRecorder.setOutputFile(file.absolutePath)
        mediaRecorder.prepare()
        mediaRecorder.start()
      } catch (e: Exception) {
        runCatching { mediaRecorder.release() }
        runCatching { if (file.exists()) file.delete() }
        abandonAudioFocus(ctx)
        throw JukeVoiceRecorderException("Failed to start recording: ${e.message}")
      }

      recorder = mediaRecorder
      outputFile = file
      recordingStartTimeMs = System.currentTimeMillis()
      startLevelTimer()
    }
  }

  private fun startLevelTimer() {
    stopLevelTimer()
    val runnable = object : Runnable {
      override fun run() {
        // Skip if a stop/cancel raced ahead and cleared our reference.
        if (levelRunnable !== this) return
        val level = readNormalizedLevel() ?: return
        sendEvent("onPeakLevel", mapOf("level" to level))
        // Re-post only if we're still the active runnable.
        if (levelRunnable === this) {
          levelHandler.postDelayed(this, LEVEL_INTERVAL_MS)
        }
      }
    }
    levelRunnable = runnable
    levelHandler.postDelayed(runnable, LEVEL_INTERVAL_MS)
  }

  private fun stopLevelTimer() {
    val r = levelRunnable
    levelRunnable = null
    if (r != null) {
      levelHandler.removeCallbacks(r)
    }
  }

  /**
   * Returns null when there's no active recorder (so the timer should stop).
   * Maps amplitude (0..32767) to a 0..1 level using the same -60 dB floor as iOS.
   */
  private fun readNormalizedLevel(): Float? {
    val current = synchronized(lock) { recorder } ?: return null
    val amp: Int = try {
      current.maxAmplitude
    } catch (_: Exception) {
      0
    }
    if (amp <= 0) {
      // Mirror iOS: floor maps to 0
      return 0f
    }
    val db = (20f * log10(amp.toFloat() / 32767f))
    val normalized = (db - MIN_DB_FLOOR) / (-MIN_DB_FLOOR)
    return max(0f, min(1f, normalized))
  }

  private fun stopRecordingInternal(): Map<String, Any> {
    val (file, durationMs) = synchronized(lock) {
      val mr = recorder ?: throw JukeVoiceRecorderException("No active recording")
      stopLevelTimer()
      try {
        mr.stop()
      } catch (e: RuntimeException) {
        // MediaRecorder.stop() throws if no audio was captured. Treat as a failed recording.
        runCatching { mr.reset() }
        runCatching { mr.release() }
        recorder = null
        val staleFile = outputFile
        outputFile = null
        abandonAudioFocus(context)
        runCatching { staleFile?.delete() }
        throw JukeVoiceRecorderException("Recording failed: ${e.message}")
      }
      runCatching { mr.release() }
      recorder = null

      val file = outputFile ?: throw JukeVoiceRecorderException("Missing output file")
      outputFile = null

      val durationMs = (System.currentTimeMillis() - recordingStartTimeMs).toInt()
      abandonAudioFocus(context)
      file to durationMs
    }

    // Heavy work runs off the recorder lock. AsyncFunction is already off the main thread.
    val normalizedFile = try {
      normalizeAudio(file)
    } catch (e: Exception) {
      // Fall back to the raw recording if normalization fails for any reason.
      file
    }

    val peaks = try {
      extractPeaks(normalizedFile, PEAK_BUCKETS)
    } catch (e: Exception) {
      List(PEAK_BUCKETS) { 0f }
    }

    return mapOf(
      "filePath" to normalizedFile.absolutePath,
      "durationMs" to durationMs,
      "peaks" to peaks
    )
  }

  private fun cancelRecordingInternal() {
    synchronized(lock) {
      stopLevelTimer()
      val mr = recorder
      val file = outputFile
      recorder = null
      outputFile = null
      if (mr != null) {
        try {
          mr.stop()
        } catch (_: Exception) {
          // ignore: cancel path
        }
        runCatching { mr.reset() }
        runCatching { mr.release() }
      }
      runCatching { file?.delete() }
      abandonAudioFocus(context)
    }
  }

  // endregion

  // region trim

  private fun trimRecordingInternal(filePath: String, startMs: Int, endMs: Int): Map<String, Any> {
    if (startMs < 0 || endMs <= startMs) {
      throw JukeVoiceRecorderException("Invalid trim range")
    }

    val sourceFile = File(filePath)
    assertInsideCacheDir(sourceFile)
    if (!sourceFile.exists() || !sourceFile.isFile) {
      throw JukeVoiceRecorderException("Source file not found")
    }

    val outFile = File(context.cacheDir, "${UUID.randomUUID()}.m4a")
    trimM4a(sourceFile, outFile, startMs.toLong(), endMs.toLong())

    val peaks = try {
      extractPeaks(outFile, PEAK_BUCKETS)
    } catch (_: Exception) {
      List(PEAK_BUCKETS) { 0f }
    }

    return mapOf(
      "filePath" to outFile.absolutePath,
      "durationMs" to (endMs - startMs),
      "peaks" to peaks
    )
  }

  /**
   * Reject any path that does not canonically live under the app's cache directory.
   * Mirrors the iOS tempDir guard in trimRecording.
   */
  private fun assertInsideCacheDir(file: File) {
    val cacheCanonical = context.cacheDir.canonicalPath
    val targetCanonical = try {
      file.canonicalPath
    } catch (e: Exception) {
      throw JukeVoiceRecorderException("Invalid file path")
    }
    val prefix = if (cacheCanonical.endsWith(File.separator)) cacheCanonical else "$cacheCanonical${File.separator}"
    if (targetCanonical != cacheCanonical && !targetCanonical.startsWith(prefix)) {
      throw JukeVoiceRecorderException("Invalid file path: must be in cache directory")
    }
  }

  /**
   * Stream-copy AAC samples from source to dest for [startMs, endMs).
   * Frame-precise for AAC since access units don't depend on key frames.
   */
  private fun trimM4a(source: File, dest: File, startMs: Long, endMs: Long) {
    var extractor: MediaExtractor? = null
    var muxer: MediaMuxer? = null
    var muxerStarted = false
    try {
      extractor = MediaExtractor()
      extractor.setDataSource(source.absolutePath)

      val audioTrackIndex = findAudioTrack(extractor)
        ?: throw JukeVoiceRecorderException("No audio track in source")
      extractor.selectTrack(audioTrackIndex)
      val format = extractor.getTrackFormat(audioTrackIndex)

      muxer = MediaMuxer(dest.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val muxerTrack = muxer.addTrack(format)
      muxer.start()
      muxerStarted = true

      extractor.seekTo(startMs * 1000L, MediaExtractor.SEEK_TO_CLOSEST_SYNC)

      val bufferSize = format.getIntegerOrDefault(MediaFormat.KEY_MAX_INPUT_SIZE, 256 * 1024)
      val buffer = ByteBuffer.allocate(max(bufferSize, 64 * 1024))
      val info = MediaCodec.BufferInfo()

      val startUs = startMs * 1000L
      val endUs = endMs * 1000L

      while (true) {
        buffer.clear()
        val size = extractor.readSampleData(buffer, 0)
        if (size < 0) break
        val sampleTimeUs = extractor.sampleTime
        if (sampleTimeUs > endUs) break
        if (sampleTimeUs >= startUs) {
          info.offset = 0
          info.size = size
          info.presentationTimeUs = sampleTimeUs - startUs
          info.flags = extractor.sampleFlagsToBufferFlags()
          muxer.writeSampleData(muxerTrack, buffer, info)
        }
        if (!extractor.advance()) break
      }
    } catch (e: Exception) {
      runCatching { if (dest.exists()) dest.delete() }
      throw if (e is JukeVoiceRecorderException) e else JukeVoiceRecorderException("Trim failed: ${e.message}")
    } finally {
      if (muxer != null) {
        runCatching { if (muxerStarted) muxer.stop() }
        runCatching { muxer.release() }
      }
      runCatching { extractor?.release() }
    }
  }

  // endregion

  // region normalize

  /**
   * Decode AAC -> PCM (16-bit), find peak, optionally scale, re-encode as AAC.
   * Skips work entirely when peak < NORMALIZE_MIN (silent) or > NORMALIZE_MAX (already loud).
   */
  private fun normalizeAudio(source: File): File {
    val pcm = decodeToPcm(source)
    val shorts = pcm.asShortBuffer()
    val peakAbs = findPeakAbs(shorts)
    val peakNormalized = peakAbs.toFloat() / Short.MAX_VALUE.toFloat()

    if (peakNormalized < NORMALIZE_MIN || peakNormalized > NORMALIZE_MAX) {
      return source
    }

    val gain = (NORMALIZE_TARGET * Short.MAX_VALUE.toFloat()) / peakAbs.toFloat()
    applyGain(shorts, gain)

    val outFile = File(context.cacheDir, "${UUID.randomUUID()}.m4a")
    return try {
      encodeAac(pcm, outFile)
      // Remove the unnormalized intermediate so the cache doesn't grow unbounded.
      runCatching { source.delete() }
      outFile
    } catch (e: Exception) {
      runCatching { if (outFile.exists()) outFile.delete() }
      source
    }
  }

  /**
   * Decode the entire AAC file to a contiguous little-endian 16-bit mono PCM buffer.
   * Returns a ByteBuffer with position=0, limit=size.
   */
  private fun decodeToPcm(source: File): ByteBuffer {
    var extractor: MediaExtractor? = null
    var codec: MediaCodec? = null
    val chunks = ArrayList<ByteArray>()
    var totalSize = 0
    try {
      extractor = MediaExtractor()
      extractor.setDataSource(source.absolutePath)
      val trackIndex = findAudioTrack(extractor)
        ?: throw JukeVoiceRecorderException("No audio track")
      extractor.selectTrack(trackIndex)
      val inputFormat = extractor.getTrackFormat(trackIndex)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
        ?: throw JukeVoiceRecorderException("Missing MIME for audio track")

      codec = MediaCodec.createDecoderByType(mime)
      codec.configure(inputFormat, null, null, 0)
      codec.start()

      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false

      while (!outputDone) {
        if (!inputDone) {
          val inputBufferIndex = codec.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inputBufferIndex >= 0) {
            val inputBuffer = codec.getInputBuffer(inputBufferIndex)
              ?: throw JukeVoiceRecorderException("Null input buffer")
            inputBuffer.clear()
            val sampleSize = extractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              codec.queueInputBuffer(inputBufferIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              val presentationTimeUs = extractor.sampleTime
              codec.queueInputBuffer(inputBufferIndex, 0, sampleSize, presentationTimeUs, 0)
              extractor.advance()
            }
          }
        }

        val outputBufferIndex = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
        if (outputBufferIndex >= 0) {
          if (info.size > 0) {
            val outputBuffer = codec.getOutputBuffer(outputBufferIndex)
              ?: throw JukeVoiceRecorderException("Null output buffer")
            outputBuffer.position(info.offset)
            outputBuffer.limit(info.offset + info.size)
            val chunk = ByteArray(info.size)
            outputBuffer.get(chunk)
            chunks.add(chunk)
            totalSize += chunk.size
          }
          codec.releaseOutputBuffer(outputBufferIndex, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            outputDone = true
          }
        }
      }
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      runCatching { extractor?.release() }
    }

    val combined = ByteBuffer.allocate(totalSize).order(ByteOrder.LITTLE_ENDIAN)
    for (chunk in chunks) combined.put(chunk)
    combined.flip()
    return combined
  }

  private fun findPeakAbs(shorts: ShortBuffer): Int {
    var peak = 0
    val limit = shorts.limit()
    for (i in 0 until limit) {
      val v = abs(shorts.get(i).toInt())
      if (v > peak) peak = v
    }
    return peak
  }

  private fun applyGain(shorts: ShortBuffer, gain: Float) {
    val limit = shorts.limit()
    val maxS = Short.MAX_VALUE.toInt()
    val minS = Short.MIN_VALUE.toInt()
    for (i in 0 until limit) {
      // Math.round gives midpoint rounding away from zero, which preserves audio
      // symmetry better than truncation toward zero.
      var v = Math.round(shorts.get(i).toInt() * gain)
      if (v > maxS) v = maxS
      if (v < minS) v = minS
      shorts.put(i, v.toShort())
    }
  }

  /**
   * Encode raw PCM (mono, 48 kHz, LE 16-bit) into an AAC m4a file.
   */
  private fun encodeAac(pcm: ByteBuffer, dest: File) {
    var codec: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var muxerStarted = false
    var trackIndex = -1
    val mime = MediaFormat.MIMETYPE_AUDIO_AAC

    try {
      val format = MediaFormat.createAudioFormat(mime, SAMPLE_RATE, CHANNEL_COUNT).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
      }

      codec = MediaCodec.createEncoderByType(mime)
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()

      muxer = MediaMuxer(dest.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      val info = MediaCodec.BufferInfo()
      val bytesPerFrame = 2 * CHANNEL_COUNT // 16-bit mono
      val totalBytes = pcm.limit()
      var bytesQueued = 0
      var inputDone = false
      var outputDone = false

      while (!outputDone) {
        if (!inputDone) {
          val inputBufferIndex = codec.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inputBufferIndex >= 0) {
            val inputBuffer = codec.getInputBuffer(inputBufferIndex)
              ?: throw JukeVoiceRecorderException("Null encoder input buffer")
            inputBuffer.clear()
            val remaining = totalBytes - bytesQueued
            if (remaining <= 0) {
              codec.queueInputBuffer(inputBufferIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              val chunkSize = min(inputBuffer.capacity(), remaining)
              val slice = pcm.duplicate()
              slice.order(ByteOrder.LITTLE_ENDIAN)
              slice.position(bytesQueued)
              slice.limit(bytesQueued + chunkSize)
              inputBuffer.put(slice)
              val framesQueued = bytesQueued / bytesPerFrame
              val ptsUs = (framesQueued.toLong() * 1_000_000L) / SAMPLE_RATE
              codec.queueInputBuffer(inputBufferIndex, 0, chunkSize, ptsUs, 0)
              bytesQueued += chunkSize
            }
          }
        }

        val outputBufferIndex = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
        when {
          outputBufferIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val newFormat = codec.outputFormat
            trackIndex = muxer.addTrack(newFormat)
            muxer.start()
            muxerStarted = true
          }
          outputBufferIndex >= 0 -> {
            val outputBuffer = codec.getOutputBuffer(outputBufferIndex)
              ?: throw JukeVoiceRecorderException("Null encoder output buffer")
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              if (!muxerStarted) {
                // Defensive: shouldn't happen because INFO_OUTPUT_FORMAT_CHANGED arrives first.
                throw JukeVoiceRecorderException("Muxer not started")
              }
              outputBuffer.position(info.offset)
              outputBuffer.limit(info.offset + info.size)
              muxer.writeSampleData(trackIndex, outputBuffer, info)
            }
            codec.releaseOutputBuffer(outputBufferIndex, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
              outputDone = true
            }
          }
          // INFO_TRY_AGAIN_LATER (-1): loop
        }
      }
    } finally {
      if (muxer != null) {
        runCatching { if (muxerStarted) muxer.stop() }
        runCatching { muxer.release() }
      }
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
    }
  }

  // endregion

  // region peaks

  /**
   * Decode the file to PCM and produce [count] normalized peak buckets.
   */
  private fun extractPeaks(source: File, count: Int): List<Float> {
    val pcm = decodeToPcm(source)
    val shorts = pcm.asShortBuffer()
    val totalSamples = shorts.limit()
    if (totalSamples == 0 || count <= 0) {
      return List(count) { 0f }
    }
    val samplesPerBucket = max(1, totalSamples / count)
    val peaks = FloatArray(count)
    var bucketMax = 0f
    for (i in 0 until count) {
      val start = i * samplesPerBucket
      if (start >= totalSamples) {
        peaks[i] = 0f
        continue
      }
      val end = min(start + samplesPerBucket, totalSamples)
      var maxVal = 0
      for (j in start until end) {
        val v = abs(shorts.get(j).toInt())
        if (v > maxVal) maxVal = v
      }
      val normalized = maxVal.toFloat() / Short.MAX_VALUE.toFloat()
      peaks[i] = normalized
      if (normalized > bucketMax) bucketMax = normalized
    }
    if (bucketMax > 0f) {
      for (i in peaks.indices) {
        peaks[i] = peaks[i] / bucketMax
      }
    }
    return peaks.toList()
  }

  // endregion

  // region audio focus

  private fun requestAudioFocus(ctx: Context) {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(attrs)
        .setOnAudioFocusChangeListener { /* no-op */ }
        .build()
      audioFocusRequest = request
      runCatching { am.requestAudioFocus(request) }
    } else {
      @Suppress("DEPRECATION")
      runCatching {
        am.requestAudioFocus(
          null,
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        )
      }
    }
  }

  private fun abandonAudioFocus(ctx: Context) {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let { runCatching { am.abandonAudioFocusRequest(it) } }
      audioFocusRequest = null
    } else {
      @Suppress("DEPRECATION")
      runCatching { am.abandonAudioFocus(null) }
    }
  }

  // endregion

  // region helpers

  private fun findAudioTrack(extractor: MediaExtractor): Int? {
    for (i in 0 until extractor.trackCount) {
      val format = extractor.getTrackFormat(i)
      val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith("audio/")) return i
    }
    return null
  }
}

// region small extension helpers (file-private)

private fun MediaFormat.getIntegerOrDefault(key: String, default: Int): Int {
  // MediaFormat.containsKey is API 29+, so we just try/catch to stay compatible with API 24.
  return try {
    getInteger(key)
  } catch (_: Exception) {
    default
  }
}

private fun MediaExtractor.sampleFlagsToBufferFlags(): Int {
  var flags = 0
  if (sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
    flags = flags or MediaCodec.BUFFER_FLAG_KEY_FRAME
  }
  return flags
}

// endregion
