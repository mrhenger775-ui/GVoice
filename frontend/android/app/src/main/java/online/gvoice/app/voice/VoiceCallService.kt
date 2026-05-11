package online.gvoice.app.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import online.gvoice.app.R

class VoiceCallService : Service() {
  companion object {
    const val ACTION_START = "online.gvoice.app.voice.START"
    const val ACTION_STOP = "online.gvoice.app.voice.STOP"
    const val ACTION_UPDATE = "online.gvoice.app.voice.UPDATE"
    const val EXTRA_CHANNEL_NAME = "channelName"
    const val EXTRA_MUTED = "muted"
    const val EXTRA_SCREEN_SHARING = "screenSharing"
    const val EXTRA_LIVEKIT_URL = "livekitUrl"
    const val EXTRA_LIVEKIT_TOKEN = "livekitToken"

    private const val CHANNEL_ID = "gvoice_voice_call"
    private const val NOTIFICATION_ID = 44127

    private val debugState: MutableMap<String, Any?> = mutableMapOf(
      "serviceAlive" to false,
      "foregroundStarted" to false,
      "roomConnected" to false,
      "muted" to false,
      "keepAliveTicks" to 0,
      "lastMicEnableAtMs" to 0L,
      "lastError" to null,
      "lastEvent" to "init"
    )

    @Synchronized
    fun snapshotDebugState(): Map<String, Any?> = HashMap(debugState)

    @Synchronized
    private fun setDebug(key: String, value: Any?) {
      debugState[key] = value
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var room: Room? = null
  private var audioManager: AudioManager? = null
  private var previousAudioMode: Int = AudioManager.MODE_NORMAL
  private var previousSpeakerphone: Boolean = false
  private var previousMicMute: Boolean = false
  private var wakeLock: PowerManager.WakeLock? = null
  private var channelName: String = "Голосовой канал"
  private var muted: Boolean = false
  private var screenSharing: Boolean = false
  private var foregroundStarted = false
  private var livekitUrl: String? = null
  private var livekitToken: String? = null
  private var keepMicAliveJob: Job? = null

  override fun onCreate() {
    super.onCreate()
    setDebug("serviceAlive", true)
    setDebug("lastEvent", "onCreate")
    ensureNotificationChannel()
    acquireWakeLock()
    configureAudioForCall()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    if (ACTION_STOP == action) {
      setDebug("lastEvent", "action_stop")
      scope.launch {
        disconnectLiveKit()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
      return START_NOT_STICKY
    }

    intent?.getStringExtra(EXTRA_CHANNEL_NAME)?.trim()?.takeIf { it.isNotEmpty() }?.let {
      channelName = it
    }
    muted = intent?.getBooleanExtra(EXTRA_MUTED, muted) ?: muted
    setDebug("muted", muted)
    screenSharing = intent?.getBooleanExtra(EXTRA_SCREEN_SHARING, screenSharing) ?: screenSharing
    livekitUrl = intent?.getStringExtra(EXTRA_LIVEKIT_URL) ?: livekitUrl
    livekitToken = intent?.getStringExtra(EXTRA_LIVEKIT_TOKEN) ?: livekitToken

    startOrUpdateForeground()

    if (ACTION_START == action) {
      val url = livekitUrl
      val token = livekitToken
      if (!url.isNullOrBlank() && !token.isNullOrBlank()) {
        scope.launch {
          connectLiveKit(url, token)
          setMicMuted(muted)
          ensureMicKeepAliveLoop()
          startOrUpdateForeground()
        }
      } else {
        setDebug("lastError", "Missing livekitUrl/livekitToken in ACTION_START")
      }
    } else if (ACTION_UPDATE == action) {
      setDebug("lastEvent", "action_update")
      scope.launch {
        setMicMuted(muted)
        ensureMicKeepAliveLoop()
        startOrUpdateForeground()
      }
    }

    return START_STICKY
  }

  override fun onDestroy() {
    setDebug("serviceAlive", false)
    setDebug("lastEvent", "onDestroy")
    setDebug("foregroundStarted", false)
    setDebug("roomConnected", false)
    restoreAudioState()
    scope.cancel()
    releaseWakeLock()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private suspend fun connectLiveKit(url: String, token: String) {
    if (room != null) return
    try {
      val lkRoom = LiveKit.create(applicationContext)
      lkRoom.connect(url, token)
      room = lkRoom
      setDebug("roomConnected", true)
      setDebug("lastEvent", "livekit_connected")
      setDebug("lastError", null)
    } catch (_: Exception) {
      room = null
      setDebug("roomConnected", false)
      setDebug("lastError", "LiveKit connect failed")
      setDebug("lastEvent", "livekit_connect_failed")
    }
  }

  private suspend fun disconnectLiveKit() {
    keepMicAliveJob?.cancel()
    keepMicAliveJob = null
    try {
      room?.disconnect()
    } catch (_: Exception) {
      // ignore
    } finally {
      room = null
      setDebug("roomConnected", false)
      setDebug("lastEvent", "livekit_disconnected")
    }
  }

  private suspend fun setMicMuted(isMuted: Boolean) {
    try {
      room?.localParticipant?.setMicrophoneEnabled(!isMuted)
      setDebug("muted", isMuted)
      setDebug("lastEvent", if (isMuted) "mic_muted" else "mic_unmuted")
    } catch (_: Exception) {
      setDebug("lastError", "setMicrophoneEnabled failed")
      setDebug("lastEvent", "mic_toggle_failed")
    }
  }

  private fun ensureMicKeepAliveLoop() {
    if (muted) {
      keepMicAliveJob?.cancel()
      keepMicAliveJob = null
      return
    }
    if (keepMicAliveJob?.isActive == true) {
      return
    }
    keepMicAliveJob = scope.launch {
      while (isActive) {
        try {
          room?.localParticipant?.setMicrophoneEnabled(true)
          setDebug("lastMicEnableAtMs", System.currentTimeMillis())
          val ticks = (snapshotDebugState()["keepAliveTicks"] as? Int ?: 0) + 1
          setDebug("keepAliveTicks", ticks)
          setDebug("lastEvent", "keep_alive_tick")
        } catch (_: Exception) {
          setDebug("lastError", "keepAlive mic enable failed")
          setDebug("lastEvent", "keep_alive_failed")
        }
        delay(2000)
      }
    }
  }

  private fun startOrUpdateForeground() {
    val notification = buildNotification()
    if (!foregroundStarted) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      foregroundStarted = true
      setDebug("foregroundStarted", true)
      setDebug("lastEvent", "foreground_started")
      return
    }

    val manager = getSystemService(NotificationManager::class.java) ?: return
    manager.notify(NOTIFICATION_ID, notification)
    setDebug("lastEvent", "foreground_updated")
  }

  private fun buildNotification(): Notification {
    val status = buildString {
      append(if (muted) "Микрофон выключен" else "Микрофон включен")
      if (screenSharing) {
        append(" • Демонстрация экрана")
      }
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("GVoice: идет звонок")
      .setContentText("$channelName • $status")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun ensureNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "GVoice звонок",
      NotificationManager.IMPORTANCE_LOW
    ).apply {
      description = "Показывает активный звонок в фоне"
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun acquireWakeLock() {
    val pm = getSystemService(PowerManager::class.java) ?: return
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gvoice:voice-call").apply {
      setReferenceCounted(false)
      acquire(10 * 60 * 60 * 1000L)
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let {
      if (it.isHeld) it.release()
    }
    wakeLock = null
  }

  private fun configureAudioForCall() {
    val am = getSystemService(AudioManager::class.java) ?: return
    audioManager = am
    previousAudioMode = am.mode
    previousSpeakerphone = am.isSpeakerphoneOn
    previousMicMute = am.isMicrophoneMute

    am.mode = AudioManager.MODE_IN_COMMUNICATION
    am.isSpeakerphoneOn = false
    am.isMicrophoneMute = false
  }

  private fun restoreAudioState() {
    val am = audioManager ?: return
    try {
      am.mode = previousAudioMode
      am.isSpeakerphoneOn = previousSpeakerphone
      am.isMicrophoneMute = previousMicMute
    } catch (_: Exception) {
      // ignore
    } finally {
      audioManager = null
    }
  }
}
