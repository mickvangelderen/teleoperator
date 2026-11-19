//! SensorManager posts callbacks to the main looper used for registration.
use crate::phone::{self, Hub};
use jni::{
    JNIEnv,
    errors::Result,
    objects::{GlobalRef, JFloatArray, JObject},
};
use jni_min_helper::JniProxy;
use ndk_sys::{
    ASENSOR_TYPE_ACCELEROMETER, ASENSOR_TYPE_GAME_ROTATION_VECTOR, ASENSOR_TYPE_GYROSCOPE,
    ASENSOR_TYPE_ROTATION_VECTOR,
};
use std::sync::Arc;

pub(super) struct Sensors {
    manager: GlobalRef,
    sources: [Option<GlobalRef>; 3],
    listener: Option<JniProxy>,
}

impl Sensors {
    pub fn new(env: &mut JNIEnv, activity: &JObject) -> Result<Self> {
        let service = env.new_string("sensor")?;
        let manager = env
            .call_method(
                activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&service).into()],
            )?
            .l()?;
        let mut sources = [None, None, None];
        for (index, kinds) in [
            [
                ASENSOR_TYPE_GAME_ROTATION_VECTOR,
                ASENSOR_TYPE_ROTATION_VECTOR,
            ]
            .as_slice(),
            &[ASENSOR_TYPE_ACCELEROMETER],
            &[ASENSOR_TYPE_GYROSCOPE],
        ]
        .into_iter()
        .enumerate()
        {
            for kind in kinds {
                let sensor = env
                    .call_method(
                        &manager,
                        "getDefaultSensor",
                        "(I)Landroid/hardware/Sensor;",
                        &[(*kind).into()],
                    )?
                    .l()?;
                if !sensor.is_null() {
                    sources[index] = Some(env.new_global_ref(sensor)?);
                    break;
                }
            }
        }
        Ok(Self {
            manager: env.new_global_ref(manager)?,
            sources,
            listener: None,
        })
    }
    pub fn mask(&self) -> i32 {
        self.sources
            .iter()
            .enumerate()
            .fold(0, |mask, (i, source)| {
                mask | (i32::from(source.is_some()) << i)
            })
    }
    pub fn resume(&mut self, env: &mut JNIEnv, hub: Arc<Hub>) -> Result<()> {
        self.pause(env)?;
        let listener = JniProxy::build(
            env,
            None,
            ["android/hardware/SensorEventListener"],
            move |env, _, args| {
                if let [event] = args {
                    sample(env, event, &hub)?;
                }
                JniProxy::void(env)
            },
        )?;
        let listener = self.listener.insert(listener);
        for sensor in self.sources.iter().flatten() {
            env.call_method(
                &self.manager,
                "registerListener",
                "(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;II)Z",
                &[
                    listener.as_ref().into(),
                    sensor.as_obj().into(),
                    10000.into(),
                    0.into(),
                ],
            )?;
        }
        Ok(())
    }
    pub fn pause(&mut self, env: &mut JNIEnv) -> Result<()> {
        if let Some(listener) = self.listener.take() {
            env.call_method(
                &self.manager,
                "unregisterListener",
                "(Landroid/hardware/SensorEventListener;)V",
                &[listener.as_ref().into()],
            )?;
        }
        Ok(())
    }
}

fn sample(env: &mut JNIEnv, event: &JObject, hub: &Hub) -> Result<()> {
    let sensor = env
        .get_field(event, "sensor", "Landroid/hardware/Sensor;")?
        .l()?;
    let ty = env.call_method(sensor, "getType", "()I", &[])?.i()?;
    let kind = match ty {
        ASENSOR_TYPE_GAME_ROTATION_VECTOR | ASENSOR_TYPE_ROTATION_VECTOR => 0,
        ASENSOR_TYPE_ACCELEROMETER => 1,
        ASENSOR_TYPE_GYROSCOPE => 2,
        _ => return Ok(()),
    };
    let timestamp = env.get_field(event, "timestamp", "J")?.j()?;
    if timestamp < 0 {
        return Ok(());
    }
    let array = JFloatArray::from(env.get_field(event, "values", "[F")?.l()?);
    let count = env.get_array_length(&array)?.min(4) as usize;
    if count < 3 {
        return Ok(());
    }
    let mut v = [0.0_f32; 4];
    env.get_float_array_region(array, 0, &mut v[..count])?;
    if kind == 0 && count == 3 {
        v[3] = (1.0 - v[..3].iter().map(|n| n * n).sum::<f32>())
            .max(0.0)
            .sqrt();
    }
    if ty == ASENSOR_TYPE_ROTATION_VECTOR && env.get_field(event, "accuracy", "I")?.i()? == 0 {
        v[0] = f32::NAN;
    }
    hub.sensor(kind, timestamp as u64, v.map(f64::from), phone::now());
    Ok(())
}
