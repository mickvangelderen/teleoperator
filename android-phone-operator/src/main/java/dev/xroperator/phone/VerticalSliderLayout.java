package dev.xroperator.phone;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.view.ViewGroup;

/** Lay the framework SeekBar across the full height, with increasing progress upwards.
 * Android applies this same transform to drawing, pointer dispatch and accessibility bounds. */
public final class VerticalSliderLayout extends ViewGroup {
    public VerticalSliderLayout(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        super.onMeasure(widthSpec, heightSpec);
        getChildAt(0).measure(
            MeasureSpec.makeMeasureSpec(getMeasuredHeight(), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(getMeasuredWidth(), MeasureSpec.EXACTLY));
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        View slider = getChildAt(0);
        slider.layout(0, 0, getHeight(), getWidth());
        slider.setPivotX(0);
        slider.setPivotY(0);
        slider.setRotation(-90);
        slider.setTranslationY(getHeight());
    }
}
