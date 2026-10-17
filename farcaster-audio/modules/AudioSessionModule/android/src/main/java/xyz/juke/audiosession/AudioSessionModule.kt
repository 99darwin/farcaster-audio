package xyz.juke.audiosession

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "AudioSessionModule"

private const val EVENT_INTERRUPTION = "onAudioInterruption"
private const val EVENT_ROUTE_CHANGE = "onRouteChange"

// Rough iOS parity for route-change "reason" — outputType is the load-bearing field.
private const val ROUTE_REASON_NEW_DEVICE_AVAILABLE = 1
private const val ROUTE_REASON_OLD_DEVICE_UNAVAILABLE = 2

class AudioSessionModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val mainHandler = Handler(Looper.getMainLooper())

  // Serializes mutation of saved-state + listener fields so concurrent JS
  // calls (e.g. configureForVoiceChat racing deactivate) can't leak listeners.
  private val stateLock = Any()

  // Saved state captured at first activation so deactivate() can restore it.
  private var savedMode: Int? = null
  private var savedSpeakerphoneOn: Boolean? = null

  // Active platform listeners — null when not registered.
  private var focusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var deviceCallback: AudioDeviceCallback? = null

  override fun definition() = ModuleDefinition {
    Name("AudioSessionModule")

    Events(EVENT_INTERRUPTION, EVENT_ROUTE_CHANGE)

    AsyncFunction<Boolean>("configureForVoiceChat") {
      configureForVoiceChat()
    }

    AsyncFunction<Boolean>("configureForPlayback") {
      configureForPlayback()
    }

    AsyncFunction<Boolean>("deactivate") {
      deactivate()
    }

    AsyncFunction<Boolean>("setToSpeaker") {
      setToSpeaker()
    }

    AsyncFunction<Boolean>("setToEarpiece") {
      setToEarpiece()
    }

    OnDestroy {
      // Defense-in-depth: ensure we never leak listeners if the module is
      // torn down without an explicit deactivate() call from JS.
      synchronized(stateLock) {
        try {
          teardownCallbacks()
          restoreSavedState()
        } catch (t: Throwable) {
          Log.w(TAG, "OnDestroy cleanup failed", t)
        }
      }
    }
  }

  // region Public actions

  private fun configureForVoiceChat(): Boolean = synchronized(stateLock) {
    try {
      val am = audioManager

      // Save prior state once so repeated calls don't clobber the original values.
      if (savedMode == null) {
        savedMode = am.mode
        @Suppress("DEPRECATION")
        savedSpeakerphoneOn = am.isSpeakerphoneOn
      }

      am.mode = AudioManager.MODE_IN_COMMUNICATION

      requestVoiceFocus(am)
      defaultToSpeaker(am)
      registerDeviceCallback(am)

      true
    } catch (t: Throwable) {
      Log.e(TAG, "configureForVoiceChat failed", t)
      false
    }
  }

  private fun configureForPlayback(): Boolean = synchronized(stateLock) {
    try {
      val am = audioManager

      if (savedMode == null) {
        savedMode = am.mode
        @Suppress("DEPRECATION")
        savedSpeakerphoneOn = am.isSpeakerphoneOn
      }

      am.mode = AudioManager.MODE_NORMAL
      requestMediaFocus(am)
      true
    } catch (t: Throwable) {
      Log.e(TAG, "configureForPlayback failed", t)
      false
    }
  }

  private fun deactivate(): Boolean = synchronized(stateLock) {
    try {
      teardownCallbacks()
      restoreSavedState()
      true
    } catch (t: Throwable) {
      Log.e(TAG, "deactivate failed", t)
      false
    }
  }

  private fun setToSpeaker(): Boolean = synchronized(stateLock) {
    try {
      val am = audioManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val speaker = am.availableCommunicationDevices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        }
        if (speaker != null) {
          am.setCommunicationDevice(speaker)
          return@synchronized true
        }
      }
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = true
      true
    } catch (t: Throwable) {
      Log.e(TAG, "setToSpeaker failed", t)
      false
    }
  }

  private fun setToEarpiece(): Boolean = synchronized(stateLock) {
    try {
      val am = audioManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val earpiece = am.availableCommunicationDevices.firstOrNull {
          it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
        }
        if (earpiece != null) {
          am.setCommunicationDevice(earpiece)
          return@synchronized true
        }
        // No earpiece available (e.g. tablet) — fall back to clearing speaker.
        am.clearCommunicationDevice()
      }
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = false
      true
    } catch (t: Throwable) {
      Log.e(TAG, "setToEarpiece failed", t)
      false
    }
  }

  // endregion

  // region Audio focus

  private fun requestVoiceFocus(am: AudioManager) {
    // Drop any prior focus request so we don't leak listeners on repeated calls.
    abandonFocus(am)
    val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
      handleFocusChange(focusChange)
    }
    focusListener = listener

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attrs)
        .setOnAudioFocusChangeListener(listener, mainHandler)
        .build()
      focusRequest = request
      am.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(
        listener,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN
      )
    }
  }

  private fun requestMediaFocus(am: AudioManager) {
    abandonFocus(am)
    val listener = AudioManager.OnAudioFocusChangeListener { focusChange ->
      handleFocusChange(focusChange)
    }
    focusListener = listener

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attrs)
        .setOnAudioFocusChangeListener(listener, mainHandler)
        .build()
      focusRequest = request
      am.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(
        listener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN
      )
    }
  }

  private fun abandonFocus(am: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { am.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      focusListener?.let { am.abandonAudioFocus(it) }
    }
    focusRequest = null
    focusListener = null
  }

  private fun handleFocusChange(focusChange: Int) {
    when (focusChange) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        sendEvent(EVENT_INTERRUPTION, mapOf("type" to "began"))
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        sendEvent(
          EVENT_INTERRUPTION,
          mapOf("type" to "ended", "shouldResume" to true)
        )
      }
    }
  }

  // endregion

  // region Routing

  private fun defaultToSpeaker(am: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val speaker = am.availableCommunicationDevices.firstOrNull {
        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
      }
      if (speaker != null) {
        am.setCommunicationDevice(speaker)
        return
      }
    }
    @Suppress("DEPRECATION")
    am.isSpeakerphoneOn = true
  }

  private fun registerDeviceCallback(am: AudioManager) {
    if (deviceCallback != null) return
    val cb = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
        emitRouteChange(ROUTE_REASON_NEW_DEVICE_AVAILABLE)
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
        emitRouteChange(ROUTE_REASON_OLD_DEVICE_UNAVAILABLE)
      }
    }
    deviceCallback = cb
    am.registerAudioDeviceCallback(cb, mainHandler)
  }

  private fun emitRouteChange(reason: Int) {
    val outputType = currentOutputType()
    sendEvent(
      EVENT_ROUTE_CHANGE,
      mapOf("reason" to reason, "outputType" to outputType)
    )
  }

  private fun currentOutputType(): String {
    val am = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      am.communicationDevice?.let { return mapDeviceType(it.type) }
    }
    val devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    // Prefer non-builtin (bluetooth / wired headset) over speaker/earpiece.
    val preferred = devices.firstOrNull {
      it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
        it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
        it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
        it.type == AudioDeviceInfo.TYPE_USB_HEADSET
    } ?: devices.firstOrNull()
    return preferred?.let { mapDeviceType(it.type) } ?: "unknown"
  }

  private fun mapDeviceType(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Receiver"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Headphones"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Headphones"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BluetoothHFP"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BluetoothA2DP"
    AudioDeviceInfo.TYPE_USB_HEADSET -> "USBAudio"
    AudioDeviceInfo.TYPE_USB_DEVICE -> "USBAudio"
    AudioDeviceInfo.TYPE_HEARING_AID -> "HearingAid"
    else -> "unknown"
  }

  // endregion

  // region Cleanup

  private fun teardownCallbacks() {
    val am = audioManager
    deviceCallback?.let {
      try {
        am.unregisterAudioDeviceCallback(it)
      } catch (t: Throwable) {
        Log.w(TAG, "unregisterAudioDeviceCallback failed", t)
      }
    }
    deviceCallback = null
    abandonFocus(am)
  }

  private fun restoreSavedState() {
    val am = audioManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        am.clearCommunicationDevice()
      } catch (t: Throwable) {
        Log.w(TAG, "clearCommunicationDevice failed", t)
      }
    }
    savedSpeakerphoneOn?.let {
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = it
    }
    savedMode?.let { am.mode = it }
    savedMode = null
    savedSpeakerphoneOn = null
  }

  // endregion
}
