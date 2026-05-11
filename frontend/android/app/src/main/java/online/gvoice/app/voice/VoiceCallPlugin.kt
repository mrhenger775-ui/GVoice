package online.gvoice.app.voice

import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "VoiceCall")
class VoiceCallPlugin : Plugin() {
  @PluginMethod
  fun startCall(call: PluginCall) {
    val channelName = call.getString("channelName") ?: "Голосовой канал"
    val muted = call.getBoolean("muted", false) ?: false
    val screenSharing = call.getBoolean("screenSharing", false) ?: false
    val livekitUrl = call.getString("livekitUrl")
    val livekitToken = call.getString("livekitToken")

    val intent = Intent(context, VoiceCallService::class.java).apply {
      action = VoiceCallService.ACTION_START
      putExtra(VoiceCallService.EXTRA_CHANNEL_NAME, channelName)
      putExtra(VoiceCallService.EXTRA_MUTED, muted)
      putExtra(VoiceCallService.EXTRA_SCREEN_SHARING, screenSharing)
      putExtra(VoiceCallService.EXTRA_LIVEKIT_URL, livekitUrl)
      putExtra(VoiceCallService.EXTRA_LIVEKIT_TOKEN, livekitToken)
    }
    startForegroundCompat(intent)

    call.resolve(JSObject().put("ok", true))
  }

  @PluginMethod
  fun updateCall(call: PluginCall) {
    val channelName = call.getString("channelName")
    val muted = call.getBoolean("muted", false) ?: false
    val screenSharing = call.getBoolean("screenSharing", false) ?: false

    val intent = Intent(context, VoiceCallService::class.java).apply {
      action = VoiceCallService.ACTION_UPDATE
      if (!channelName.isNullOrBlank()) {
        putExtra(VoiceCallService.EXTRA_CHANNEL_NAME, channelName)
      }
      putExtra(VoiceCallService.EXTRA_MUTED, muted)
      putExtra(VoiceCallService.EXTRA_SCREEN_SHARING, screenSharing)
    }
    startForegroundCompat(intent)

    call.resolve(JSObject().put("ok", true))
  }

  @PluginMethod
  fun stopCall(call: PluginCall) {
    val intent = Intent(context, VoiceCallService::class.java).apply {
      action = VoiceCallService.ACTION_STOP
    }
    context.startService(intent)
    call.resolve(JSObject().put("ok", true))
  }

  @PluginMethod
  fun getDebugState(call: PluginCall) {
    val state = VoiceCallService.snapshotDebugState()
    val result = JSObject()
    for ((key, value) in state) {
      result.put(key, value)
    }
    call.resolve(result)
  }

  private fun startForegroundCompat(intent: Intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ContextCompat.startForegroundService(context, intent)
    } else {
      context.startService(intent)
    }
  }
}
