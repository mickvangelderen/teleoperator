//! The requested output and provider are independent of the active acquisition source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Output {
    FullPose,
    OrientationOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Auto,
    Imu,
    ArCore,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Selection {
    pub output: Output,
    pub provider: Provider,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackingMode {
    Unavailable,
    Orientation,
    Displacement,
    Camera { output: Output, imu_fallback: bool },
}

impl Selection {
    // The old tracking picker was Auto / sensors orientation / sensors displacement.
    pub fn from_preferences(legacy: i32, output: i32, provider: i32) -> Self {
        Self {
            output: match output {
                1 => Output::OrientationOnly,
                -1 if legacy == 1 => Output::OrientationOnly,
                _ => Output::FullPose,
            },
            provider: match provider {
                1 => Provider::Imu,
                2 => Provider::ArCore,
                -1 if matches!(legacy, 1 | 2) => Provider::Imu,
                _ => Provider::Auto,
            },
        }
    }

    pub fn wants_camera(self, has_rotation: bool) -> bool {
        match self.provider {
            Provider::Imu => false,
            Provider::ArCore => true,
            Provider::Auto => self.output == Output::FullPose || !has_rotation,
        }
    }

    pub fn camera(self) -> TrackingMode {
        TrackingMode::Camera {
            output: self.output,
            imu_fallback: self.provider == Provider::Auto,
        }
    }

    pub fn without_camera(self, rotation: bool, acceleration: bool) -> TrackingMode {
        if self.provider == Provider::ArCore || !rotation {
            TrackingMode::Unavailable
        } else if self.output == Output::FullPose && acceleration {
            TrackingMode::Displacement
        } else {
            TrackingMode::Orientation
        }
    }
}

/// Android can recreate the activity while its permission or AR install UI is in front.
#[derive(Default)]
pub struct CameraPrompts {
    pub install_requested: bool,
    permission_requested: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Permission {
    Request,
    Denied,
    Granted,
}

impl CameraPrompts {
    pub fn restore(flags: u8) -> Self {
        Self {
            permission_requested: flags & 1 != 0,
            install_requested: flags & 2 != 0,
        }
    }

    pub fn save(&self) -> u8 {
        u8::from(self.permission_requested) | (u8::from(self.install_requested) << 1)
    }

    pub fn permission(&mut self, granted: bool) -> Permission {
        if granted {
            self.permission_requested = false;
            Permission::Granted
        } else if self.permission_requested {
            Permission::Denied
        } else {
            self.permission_requested = true;
            Permission::Request
        }
    }

    pub fn needs_settings(&self, denied: bool, can_prompt_again: bool) -> bool {
        self.permission_requested && denied && !can_prompt_again
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returning_from_system_dialogs_or_settings_survives_recreation() {
        let mut prompts = CameraPrompts::default();
        assert!(!prompts.install_requested);
        prompts.install_requested = true;
        let mut resumed = CameraPrompts::restore(prompts.save());
        assert!(resumed.install_requested); // requestInstall(false) on return.
        resumed.install_requested = false; // installed, including device profile data
        assert_eq!(resumed.permission(false), Permission::Request);
        let mut recreated = CameraPrompts::restore(resumed.save());
        assert_eq!(recreated.permission(false), Permission::Denied);
        assert!(!recreated.needs_settings(true, true));
        assert!(recreated.needs_settings(true, false));
        assert_eq!(recreated.permission(true), Permission::Granted);
        assert_eq!(recreated.save(), 0);
    }

    #[test]
    fn independent_selections_and_capability_fallbacks() {
        for output in [Output::FullPose, Output::OrientationOnly] {
            for provider in [Provider::Auto, Provider::Imu, Provider::ArCore] {
                let s = Selection { output, provider };
                assert_eq!(s.wants_camera(false), provider != Provider::Imu);
                assert_eq!(
                    s.wants_camera(true),
                    provider == Provider::ArCore
                        || (provider == Provider::Auto && output == Output::FullPose)
                );
                assert_eq!(s.without_camera(false, true), TrackingMode::Unavailable);
                let expected = match (provider, output) {
                    (Provider::ArCore, _) => TrackingMode::Unavailable,
                    (_, Output::FullPose) => TrackingMode::Displacement,
                    (_, Output::OrientationOnly) => TrackingMode::Orientation,
                };
                assert_eq!(s.without_camera(true, true), expected);
                assert_eq!(
                    s.without_camera(true, false),
                    if provider == Provider::ArCore {
                        TrackingMode::Unavailable
                    } else {
                        TrackingMode::Orientation
                    }
                );
            }
        }
    }

    #[test]
    fn migrates_old_picker_and_round_trips_independent_preferences() {
        for (legacy, output, provider) in [
            (0, Output::FullPose, Provider::Auto),
            (1, Output::OrientationOnly, Provider::Imu),
            (2, Output::FullPose, Provider::Imu),
        ] {
            assert_eq!(
                Selection::from_preferences(legacy, -1, -1),
                Selection { output, provider }
            );
        }
        for output in [Output::FullPose, Output::OrientationOnly] {
            for provider in [Provider::Auto, Provider::Imu, Provider::ArCore] {
                assert_eq!(
                    Selection::from_preferences(1, output as i32, provider as i32),
                    Selection { output, provider }
                );
            }
        }
    }
}
