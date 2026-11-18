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
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SensorManager sensors;
    private final Sensor[] sources = new Sensor[3];
    private TextView status;
    private Button left, right, hold;
    private boolean started, touching;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!started) return;
            status.setText(nativeStatus());
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
        TextView title = new TextView(this); title.setText("Phone Operator · Experimental"); title.setTextSize(23); title.setTextColor(0xff172b4d);
        root.addView(title);
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
        Button recenter = button("Recenter heading (stops tracking)"); recenter.setTextSize(16);
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
        super.onResume(); if (!started) return; nativeAction(5);
        for (Sensor sensor : sources) if (sensor != null) sensors.registerListener(this, sensor, 10000, 0);
        handler.removeCallbacks(refresh); handler.post(refresh);
    }
    @Override protected void onPause() {
        if (started) { touching = false; nativeAction(6); sensors.unregisterListener(this); handler.removeCallbacks(refresh); }
        super.onPause();
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (started) { if (!focused) touching = false; nativeAction(focused ? 7 : 8); }
    }
    @Override protected void onDestroy() {
        if (started) { started = false; handler.removeCallbacks(refresh); sensors.unregisterListener(this); if (!isChangingConfigurations()) nativeStop(); }
        super.onDestroy();
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
