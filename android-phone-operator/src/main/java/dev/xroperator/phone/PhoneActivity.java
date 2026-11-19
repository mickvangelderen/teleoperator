package dev.xroperator.phone;

import android.Manifest;
import android.app.NativeActivity;

/** NativeActivity has no NDK callback for permission results. */
public final class PhoneActivity extends NativeActivity {
    private static final int CAMERA_REQUEST = 7;
    private Runnable cameraPermissionListener;

    public void setCameraPermissionListener(Runnable listener) {
        cameraPermissionListener = listener;
    }

    public void requestCameraPermission() {
        requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants);
        if (requestCode == CAMERA_REQUEST && cameraPermissionListener != null) {
            cameraPermissionListener.run();
        }
    }
}
