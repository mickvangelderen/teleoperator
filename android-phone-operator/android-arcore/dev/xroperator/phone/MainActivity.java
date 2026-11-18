package dev.xroperator.phone;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.graphics.Color;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Platform adapter only: widgets, Android lifecycle and raw sensor callbacks. */
public final class MainActivity extends Activity implements SensorEventListener {
    static { System.loadLibrary("phone_operator"); }
    private static native void nativeStart(int sensorMask);
    private static native void nativeStop();
    private static native void nativeAction(int action);
    private static native void nativeSensor(int kind, long timestamp, float x, float y, float z, float w);
    private static native String nativeStatus();
    private static native int nativeFlags();
    private static native int nativePrepare(Activity activity, boolean requested);
    private static native void nativeCameraStart(Activity activity);
    private static native void nativeCameraStop();
    private static native void nativeRunSession(Activity activity);
    // Called synchronously by the Rust worker, never by the UI. Keep an app
    // class-loader Java frame on the stack for the SDK's JNI class lookups.
    public void runArCore() { nativeRunSession(this); }
    private boolean resumed, cameraStarted, installRequested, permissionRequested;
    private String cameraMessage = "Camera permission and Google Play Services for AR required";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SensorManager sensors;
    private final Sensor[] sources = new Sensor[3];
    private TextView status;
    private Button left, right, hold;
    private boolean started, touching;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!started) return;
            status.setText(cameraMessage + "\n\n" + nativeStatus());
            int flags = nativeFlags();
            boolean held = (flags & 1) != 0, isRight = (flags & 2) != 0;
            left.setText(isRight ? "Left" : "● Left");
            right.setText(isRight ? "● Right" : "Right");
            hold.setText(held ? "TRACKING\nRelease to stop" : "HOLD TO TRACK");
            hold.setBackgroundTintList(android.content.res.ColorStateList.valueOf(held ? 0xff087f5b : 0xff185abc));
            handler.postDelayed(this, 100);
        }
    };
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private Button button(String text) {
        Button b = new Button(this); b.setText(text); b.setTextSize(20); b.setAllCaps(false); return b;
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        sensors = (SensorManager)getSystemService(SENSOR_SERVICE);
        sources[0] = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (sources[0] == null) sources[0] = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        sources[1] = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        sources[2] = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        int mask = 0;
        for (int i = 0; i < sources.length; i++) if (sources[i] != null) mask |= 1 << i;
        nativeStart(mask); started = true;
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(16)); root.setBackgroundColor(0xfff4f6fa);
        TextView title = new TextView(this); title.setText("Phone Operator · ARCore Spatial"); title.setTextSize(23); title.setTextColor(0xff172b4d);
        root.addView(title);
        TextView notice = new TextView(this); notice.setTextSize(13);
        notice.setText(android.text.Html.fromHtml("This application runs on <a href=\"https://play.google.com/store/apps/details?id=com.google.ar.core\">Google Play Services for AR</a> (ARCore), which is provided by Google and governed by the <a href=\"https://policies.google.com/privacy\">Google Privacy Policy</a>. Use of ARCore is subject to <a href=\"https://policies.google.com/terms\">Google Terms of Service</a>.", android.text.Html.FROM_HTML_MODE_LEGACY));
        notice.setMovementMethod(android.text.method.LinkMovementMethod.getInstance()); root.addView(notice);
        Button retry = button("Enable camera / retry ARCore"); retry.setTextSize(16);
        retry.setOnClickListener(v -> {
            if (checkSelfPermission(android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED && permissionRequested && !shouldShowRequestPermissionRationale(android.Manifest.permission.CAMERA)) {
                startActivity(new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getPackageName()))); return;
            }
            installRequested = false; permissionRequested = false; stopCamera();
            // A replacement session has a new reference. Clear source/origin
            // immediately so a press cannot reuse the old session's fresh pose.
            nativeAction(6); nativeAction(5); startCamera();
        }); root.addView(retry);
        LinearLayout hands = new LinearLayout(this);
        left = button("Left"); right = button("Right");
        hands.addView(left, new LinearLayout.LayoutParams(0, dp(62), 1));
        hands.addView(right, new LinearLayout.LayoutParams(0, dp(62), 1)); root.addView(hands);
        left.setOnClickListener(v -> { touching = false; nativeAction(0); });
        right.setOnClickListener(v -> { touching = false; nativeAction(1); });
        hold = button("HOLD TO TRACK"); hold.setTextColor(Color.WHITE); hold.setTextSize(26);
        hold.setContentDescription("Press and hold to track. Release to stop.");
        root.addView(hold, new LinearLayout.LayoutParams(-1, dp(190)));
        // No click/toggle activation: only a single pointer continuously held inside the control.
        hold.setOnTouchListener((view, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    touching = true; nativeAction(2); break;
                case MotionEvent.ACTION_MOVE:
                    if (touching && (event.getX() < 0 || event.getY() < 0 || event.getX() >= view.getWidth() || event.getY() >= view.getHeight())) {
                        touching = false; nativeAction(4);
                    }
                    break;
                case MotionEvent.ACTION_UP:
                    touching = false; nativeAction(3); view.performClick(); break;
                case MotionEvent.ACTION_CANCEL:
                case MotionEvent.ACTION_POINTER_DOWN:
                case MotionEvent.ACTION_POINTER_UP:
                    touching = false; nativeAction(4); break;
            }
            return true;
        });
        Button recenter = button("Recenter position + heading (stops tracking)"); recenter.setTextSize(16);
        recenter.setOnClickListener(v -> { touching = false; nativeAction(9); }); root.addView(recenter);
        ScrollView scroll = new ScrollView(this); status = new TextView(this); status.setTextSize(15); status.setTextColor(0xff172b4d);
        status.setTextIsSelectable(true); status.setPadding(0, dp(8), 0, dp(12)); scroll.addView(status);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        // Account for status/navigation bars at target SDK 36 (edge-to-edge).
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
            v.setPadding(dp(20)+bars.left, dp(12)+bars.top, dp(20)+bars.right, dp(8)+bars.bottom); return insets;
        });
    }
    @Override protected void onResume() {
        super.onResume(); if (!started) return; resumed = true; nativeAction(5); startCamera();
        for (Sensor sensor : sources) if (sensor != null) sensors.registerListener(this, sensor, 10000, 0);
        handler.removeCallbacks(refresh); handler.post(refresh);
    }
    @Override protected void onPause() {
        resumed = false; stopCamera();
        if (started) { touching = false; nativeAction(6); sensors.unregisterListener(this); handler.removeCallbacks(refresh); }
        super.onPause();
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (started) { if (!focused) { touching = false; stopCamera(); } nativeAction(focused ? 7 : 8); if (focused) startCamera(); }
    }
    @Override protected void onDestroy() {
        stopCamera();
        if (started) { started = false; handler.removeCallbacks(refresh); sensors.unregisterListener(this); if (!isChangingConfigurations()) nativeStop(); }
        super.onDestroy();
    }
    private final Runnable retryAvailability = () -> startCamera();
    private void stopCamera() {
        handler.removeCallbacks(retryAvailability);
        if (cameraStarted) { cameraStarted = false; nativeCameraStop(); }
    }
    private void startCamera() {
        if (!started || !resumed || !hasWindowFocus() || cameraStarted) return;
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            cameraMessage = "Camera permission needed. Tap Enable camera to retry or open Settings.";
            if (!permissionRequested) { permissionRequested = true; requestPermissions(new String[]{android.Manifest.permission.CAMERA}, 7); }
            return;
        }
        int result = nativePrepare(this, !installRequested);
        if (result == 2) {
            cameraMessage = "Checking ARCore support…";
            handler.removeCallbacks(retryAvailability); handler.postDelayed(retryAvailability, 500); return;
        }
        if (result == 1) { installRequested = true; cameraMessage = "Complete Google Play Services for AR installation"; return; }
        if (result != 0) { cameraMessage = "ARCore unavailable (status " + result + "). Tap retry after resolving it."; return; }
        cameraMessage = "ARCore camera enabled · foreground only · port 8081";
        cameraStarted = true; nativeCameraStart(this);
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == 7) startCamera();
    }
    // Called by the attached native worker; CameraManager query does not open a camera.
    public int cameraTimestampSource(String id) {
        try {
            android.hardware.camera2.CameraManager manager = (android.hardware.camera2.CameraManager)getSystemService(CAMERA_SERVICE);
            Integer source = manager.getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
            return source == null ? -1 : source;
        } catch (Exception e) { android.util.Log.w("PhoneOperator", "Camera timestamp source unavailable", e); return -1; }
    }
    @Override public void onSensorChanged(SensorEvent event) {
        if (!started) return;
        for (int i = 0; i < sources.length; i++) if (event.sensor == sources[i]) {
            if (i == 0 && event.sensor.getType() == Sensor.TYPE_ROTATION_VECTOR && event.accuracy == SensorManager.SENSOR_STATUS_UNRELIABLE) {
                nativeSensor(0, event.timestamp, Float.NaN, 0, 0, 1); return;
            }
            float w = i == 0 ? (event.values.length >= 4 ? event.values[3] : (float)Math.sqrt(Math.max(0, 1 - event.values[0]*event.values[0] - event.values[1]*event.values[1] - event.values[2]*event.values[2]))) : 0;
            nativeSensor(i, event.timestamp, event.values[0], event.values[1], event.values[2], w); return;
        }
    }
    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { /* No fabricated confidence. */ }
}
