package dev.xroperator.phone;

import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.os.SystemClock;
import com.google.ar.core.Anchor;
import com.google.ar.core.Config;
import com.google.ar.core.Frame;
import com.google.ar.core.Pose;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingState;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Serialize camera ownership, including across Activity recreation. */
final class ArTracking {
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final MainActivity activity;
    private volatile boolean stopped;

    private static native long nativeContext();
    private static native float[] nativeOriginRotation(float[] sensorPose);
    private static native void nativeFrame(long generation, long timestamp, long cameraTimestamp,
            long queryStarted, float[] sensorPose, float[] anchorPose, boolean createdOrigin);

    ArTracking(MainActivity activity) { this.activity = activity; }

    void start() {
        worker.execute(() -> {
            if (stopped) return;
            try {
                Session session = new Session(activity);
                try {
                    Config config = session.getConfig();
                    config.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
                    config.setLightEstimationMode(Config.LightEstimationMode.DISABLED);
                    // Tracking consumes poses only. API 32+ provides camera buffers without EGL.
                    config.setTextureUpdateMode(Config.TextureUpdateMode.EXPOSE_HARDWARE_BUFFER);
                    session.configure(config);
                    CameraManager manager = activity.getSystemService(CameraManager.class);
                    String id = session.getCameraConfig().getCameraId();
                    Integer clock = manager.getCameraCharacteristics(id).get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE);
                    if (!Integer.valueOf(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME).equals(clock)) {
                        throw new IllegalStateException("Camera timestamps cannot be aligned with phone sensors");
                    }
                    if (stopped) return;
                    session.resume();
                    try {
                        track(session);
                    } finally {
                        session.pause();
                    }
                } finally {
                    session.close();
                }
            } catch (Exception error) {
                activity.runOnUiThread(() -> activity.cameraFailed(this, error));
            }
        });
    }

    // When stop returns, this worker can no longer publish into a replacement source.
    synchronized void stop() { stopped = true; }

    private void track(Session session) throws Exception {
        Anchor anchor = null;
        long generation = -1, lastTimestamp = 0;
        try {
            while (!stopped) {
                long context = nativeContext();
                if (context < 0) return;
                long token = context >>> 1;
                if (generation != token && anchor != null) {
                    anchor.detach();
                    anchor = null;
                }
                generation = token;
                long before = SystemClock.elapsedRealtimeNanos();
                Frame frame = session.update();
                long timestamp = frame.getTimestamp();
                long cameraTimestamp = frame.getAndroidCameraTimestamp();
                boolean tracking = frame.getCamera().getTrackingState() == TrackingState.TRACKING;
                Pose sensor = tracking ? frame.getAndroidSensorPose() : null;
                float[] sample = components(sensor);
                boolean created = false;
                long age = SystemClock.elapsedRealtimeNanos() - timestamp;
                if ((context & 1) != 0 && anchor == null && tracking && cameraTimestamp == timestamp
                        && timestamp > lastTimestamp && age >= 0 && age <= 250_000_000L) {
                    float[] rotation = nativeOriginRotation(sample);
                    if (rotation != null) {
                        anchor = session.createAnchor(new Pose(sensor.getTranslation(), rotation));
                        created = true;
                    }
                }
                lastTimestamp = Math.max(lastTimestamp, timestamp);
                float[] origin = anchor != null && anchor.getTrackingState() == TrackingState.TRACKING
                        ? components(anchor.getPose()) : null;
                synchronized (this) {
                    if (stopped) return;
                    nativeFrame(generation, timestamp, cameraTimestamp, before, sample, origin, created);
                }
            }
        } finally {
            if (anchor != null) anchor.detach();
        }
    }

    private static float[] components(Pose pose) {
        if (pose == null) return null;
        float[] values = new float[7];
        pose.getTranslation(values, 0);
        pose.getRotationQuaternion(values, 3);
        return values;
    }
}
