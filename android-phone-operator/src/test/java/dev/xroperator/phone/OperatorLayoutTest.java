package dev.xroperator.phone;

import static org.junit.Assert.*;

import android.app.Activity;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.SeekBar;
import android.widget.Spinner;
import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, qualifiers = "w412dp-h915dp-port-xhdpi")
public class OperatorLayoutTest {
    private Activity activity;
    private View root;
    private SeekBar slider;

    @Before public void inflate() {
        activity = Robolectric.buildActivity(Activity.class).setup().get();
        activity.setTheme(R.style.OperatorTheme);
        activity.setContentView(R.layout.operator);
        root = activity.findViewById(R.id.drawer);
        root.measure(View.MeasureSpec.makeMeasureSpec(824, View.MeasureSpec.EXACTLY),
                     View.MeasureSpec.makeMeasureSpec(1830, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, 824, 1830);
        slider = activity.findViewById(R.id.gripper);
    }

    @Test public void permissionResultCanWakeTheNativeTrackerWithoutAFocusChange() {
        // Construct without starting NativeActivity's ARM library on the host.
        PhoneActivity bridge = Robolectric.buildActivity(PhoneActivity.class).get();
        int[] calls = {0};
        bridge.setCameraPermissionListener(() -> calls[0]++);
        bridge.onRequestPermissionsResult(8, new String[0], new int[0]);
        assertEquals(0, calls[0]);
        bridge.onRequestPermissionsResult(7, new String[0], new int[0]);
        assertEquals(1, calls[0]);
        bridge.setCameraPermissionListener(null);
        bridge.onRequestPermissionsResult(7, new String[0], new int[0]);
        assertEquals(1, calls[0]);
    }

    @Test @Config(sdk = {34, 35}) public void independentPickersAndAccessibleRange() {
        Spinner output = activity.findViewById(R.id.output);
        Spinner provider = activity.findViewById(R.id.provider);
        assertEquals("Full pose", output.getSelectedItem());
        assertEquals("Auto", provider.getSelectedItem());
        output.setSelection(1);
        provider.setSelection(2);
        assertEquals("Orientation only", output.getSelectedItem());
        assertEquals("ARCore", provider.getSelectedItem());
        assertEquals("IMU only", provider.getItemAtPosition(1));
        assertEquals("Gripper", slider.getContentDescription());
        AccessibilityNodeInfo.RangeInfo range = slider.createAccessibilityNodeInfo().getRangeInfo();
        assertEquals(0, range.getMin(), 0);
        assertEquals(100, range.getMax(), 0);
        assertEquals(View.LAYOUT_DIRECTION_LTR, slider.getLayoutDirection());
        assertTrue(slider.getThumb().getIntrinsicWidth() >= 48 * activity.getResources().getDisplayMetrics().density);
    }

    // API 34 exercises framework event splitting. Robolectric's API 35+
    // MotionEvent.split shadow omits parent offsets when copying pointer coordinates.
    @Test public void entireVerticalTrackAcceptsASecondFingerWhileDeadmanStaysDown() {
        View track = activity.findViewById(R.id.gripper_track);
        View hold = activity.findViewById(R.id.hold);
        int[] pad = location(track);
        int[] deadman = location(hold);
        float hx = deadman[0] + hold.getWidth() / 2f, hy = deadman[1] + hold.getHeight() / 2f;
        float sx = pad[0] + 2, bottom = pad[1] + track.getHeight() - 1;
        List<Integer> holdEvents = new ArrayList<>(), sliderEvents = new ArrayList<>();
        List<Float> positions = new ArrayList<>();
        hold.setOnTouchListener((v, event) -> {
            holdEvents.add(event.getActionMasked());
            v.getParent().requestDisallowInterceptTouchEvent(true);
            return true;
        });
        slider.setOnTouchListener((v, event) -> {
            sliderEvents.add(event.getActionMasked());
            positions.add((event.getX() - v.getPaddingLeft()) /
                (v.getWidth() - v.getPaddingLeft() - v.getPaddingRight()));
            v.getParent().requestDisallowInterceptTouchEvent(true);
            return true;
        });

        float travelDp = (slider.getWidth() - slider.getPaddingLeft() - slider.getPaddingRight())
            / activity.getResources().getDisplayMetrics().density;
        assertEquals(172f, travelDp, 1f);
        long down = SystemClock.uptimeMillis();
        dispatch(down, MotionEvent.ACTION_DOWN, sx, bottom);
        dispatch(down, MotionEvent.ACTION_UP, sx, bottom);
        assertEquals(List.of(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP), sliderEvents);
        sliderEvents.clear();
        positions.clear();
        dispatch(down, MotionEvent.ACTION_DOWN, hx, hy);
        dispatch(down, MotionEvent.ACTION_POINTER_DOWN | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT), hx, hy, sx, bottom);
        dispatch(down, MotionEvent.ACTION_MOVE, hx, hy, pad[0] + track.getWidth() - 2, pad[1] + track.getHeight() / 2f);
        dispatch(down, MotionEvent.ACTION_MOVE, hx, hy, sx, pad[1] + 1);
        dispatch(down, MotionEvent.ACTION_POINTER_UP | (1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT), hx, hy, sx, pad[1] - 15);
        assertEquals(List.of(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_MOVE,
            MotionEvent.ACTION_UP), sliderEvents);
        assertTrue(positions.get(0) <= 0);
        assertEquals(0.5, positions.get(1), 0.002);
        assertTrue(positions.get(2) >= 1);
        assertTrue(positions.get(3) >= 1);
        assertFalse(holdEvents.contains(MotionEvent.ACTION_UP));
        assertFalse(holdEvents.contains(MotionEvent.ACTION_CANCEL));
        dispatch(down, MotionEvent.ACTION_UP, hx, hy);
        assertEquals(Integer.valueOf(MotionEvent.ACTION_UP), holdEvents.get(holdEvents.size() - 1));
    }

    private int[] location(View view) {
        int[] location = new int[2], origin = new int[2];
        view.getLocationOnScreen(location);
        root.getLocationOnScreen(origin);
        return new int[]{location[0] - origin[0], location[1] - origin[1]};
    }

    private void dispatch(long down, int action, float... xy) {
        int count = xy.length / 2;
        MotionEvent.PointerProperties[] properties = new MotionEvent.PointerProperties[count];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
        for (int i = 0; i < count; i++) {
            properties[i] = new MotionEvent.PointerProperties();
            properties[i].id = i;
            properties[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
            coords[i].x = xy[2*i];
            coords[i].y = xy[2*i+1];
        }
        MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, count,
            properties, coords, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        try { assertTrue(root.dispatchTouchEvent(event)); }
        finally { event.recycle(); }
    }
}
