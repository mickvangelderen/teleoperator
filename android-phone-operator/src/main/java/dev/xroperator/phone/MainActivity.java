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
import android.Manifest;
import android.content.pm.PackageManager;
import android.widget.ArrayAdapter;
import android.widget.AdapterView;
import android.widget.Spinner;
import com.google.ar.core.ArCoreApk;
import com.google.ar.core.exceptions.UnavailableException;
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
    private static native void nativeSetMode(int mode, boolean hasRotationSensor);
    private static final int ORIENTATION = 0, DISPLACEMENT = 1, SPATIAL = 2;
    private static final int AUTO = 0, SENSOR_ONLY = 1, ESTIMATE = 2;
    private int preference;
    private boolean resumed, permissionRequested, installRequested, enableInstall, cameraFailed;
    private String cameraMessage = "Using phone sensors";
    private Button retry;
    private ArTracking camera;
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
        preference = getPreferences(MODE_PRIVATE).getInt("tracking", AUTO);
        if (state != null) {
            permissionRequested = state.getBoolean("askedCamera");
            installRequested = state.getBoolean("askedInstall");
        }
        useSensors();
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(16)); root.setBackgroundColor(0xfff4f6fa);
        TextView title = new TextView(this); title.setText("Phone Operator"); title.setTextSize(23); title.setTextColor(0xff172b4d);
        root.addView(title);
        TextView notice = new TextView(this); notice.setTextSize(13);
        notice.setText(android.text.Html.fromHtml("This application runs on <a href=\"https://play.google.com/store/apps/details?id=com.google.ar.core\">Google Play Services for AR</a> (ARCore), which is provided by Google and governed by the <a href=\"https://policies.google.com/privacy\">Google Privacy Policy</a>. Use of ARCore is subject to <a href=\"https://policies.google.com/terms\">Google Terms of Service</a>.", android.text.Html.FROM_HTML_MODE_LEGACY));
        notice.setMovementMethod(android.text.method.LinkMovementMethod.getInstance()); root.addView(notice);
        Spinner mode = new Spinner(this);
        mode.setContentDescription("Tracking source");
        ArrayAdapter<String> choices = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item,
                new String[]{"Automatic (prefer ARCore)", "Sensors: orientation", "Sensors: estimate displacement"});
        choices.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        mode.setAdapter(choices);
        mode.setSelection(preference);
        mode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onNothingSelected(AdapterView<?> parent) {}
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position == preference) return;
                preference = position;
                getPreferences(MODE_PRIVATE).edit().putInt("tracking", preference).apply();
                stopCamera();
                useSensors();
                cameraFailed = false;
                retry.setVisibility(View.GONE);
                startCamera();
            }
        });
        root.addView(mode);
        retry = button("Retry ARCore");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(v -> {
            if (permissionRequested && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                    && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
                startActivity(new android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getPackageName())));
                return;
            }
            permissionRequested = false;
            enableInstall = true;
            installRequested = false;
            cameraFailed = false;
            startCamera();
        });
        root.addView(retry);
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
        Button recenter = button("Recenter (stops tracking)"); recenter.setTextSize(16);
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
    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putBoolean("askedCamera", permissionRequested);
        state.putBoolean("askedInstall", installRequested);
    }
    private void useSensors() {
        touching = false;
        nativeSetMode(preference == ESTIMATE ? DISPLACEMENT : ORIENTATION, sources[0] != null);
        cameraMessage = preference == ESTIMATE ? "Using estimated IMU displacement" : "Using phone orientation";
    }
    private final Runnable retryAvailability = this::startCamera;
    private void stopCamera() {
        handler.removeCallbacks(retryAvailability);
        if (camera != null) {
            camera.stop();
            camera = null;
            useSensors();
        }
    }
    private void fallback(String reason, boolean canRetry) {
        stopCamera();
        useSensors();
        cameraMessage += " · " + reason;
        retry.setVisibility(canRetry ? View.VISIBLE : View.GONE);
    }
    void cameraFailed(ArTracking sender, Exception error) {
        if (camera != sender) return;
        android.util.Log.w("PhoneOperator", "ARCore unavailable", error);
        cameraFailed = true;
        fallback("ARCore unavailable (" + error.getClass().getSimpleName() + ")", true);
    }
    private void startCamera() {
        if (!started || !resumed || !hasWindowFocus() || preference != AUTO || camera != null || cameraFailed) return;
        handler.removeCallbacks(retryAvailability);
        ArCoreApk ar = ArCoreApk.getInstance();
        ArCoreApk.Availability availability = ar.checkAvailability(this);
        if (availability == ArCoreApk.Availability.UNKNOWN_CHECKING) {
            handler.postDelayed(retryAvailability, 500);
            return;
        }
        if (!availability.isSupported()) {
            fallback("ARCore unavailable", availability.isUnknown());
            return;
        }
        if (availability != ArCoreApk.Availability.SUPPORTED_INSTALLED && !enableInstall && !installRequested) {
            fallback("Google Play Services for AR needs installation or an update", true);
            return;
        }
        try {
            if (ar.requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true;
                return;
            }
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                fallback("Camera permission needed for ARCore", true);
                if (!permissionRequested) {
                    permissionRequested = true;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, 7);
                }
                return;
            }
            retry.setVisibility(View.GONE);
            cameraMessage = "Using ARCore";
            nativeSetMode(SPATIAL, sources[0] != null);
            camera = new ArTracking(this);
            camera.start();
        } catch (UnavailableException | SecurityException e) {
            cameraFailed = true;
            fallback("ARCore unavailable (" + e.getClass().getSimpleName() + ")", true);
        }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == 7) startCamera();
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
