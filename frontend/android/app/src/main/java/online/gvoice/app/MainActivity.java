package online.gvoice.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.os.Build;
import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.content.Context;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.pm.PackageManager;
import online.gvoice.app.voice.VoiceCallPlugin;

public class MainActivity extends BridgeActivity {
  private static final int REQ_POST_NOTIFICATIONS = 7412;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(VoiceCallPlugin.class);
    super.onCreate(savedInstanceState);
    requestRuntimePermissionsIfNeeded();
  }

  private void requestRuntimePermissionsIfNeeded() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          new String[] { Manifest.permission.POST_NOTIFICATIONS },
          REQ_POST_NOTIFICATIONS
        );
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
      String packageName = getPackageName();
      if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
        try {
          Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
          intent.setData(Uri.parse("package:" + packageName));
          startActivity(intent);
        } catch (Exception ignored) {
          // Ignore if device blocks direct optimization settings intent.
        }
      }
    }
  }
}
