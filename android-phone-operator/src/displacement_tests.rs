use super::*;
use crate::displacement::GRAVITY;
const MS: u64 = 1_000_000;
fn upright() -> [f64; 4] {
    let h = std::f64::consts::FRAC_1_SQRT_2;
    [h, 0., 0., h]
}
fn pair(h: &Hub, t: u64, received: u64) {
    h.sensor(0, t, upright(), received);
    h.sensor(1, t, [1., GRAVITY, 0., 0.], received);
}
fn ready() -> Arc<Hub> {
    let h = Hub::displacement_at([true; 3], "SYNTHETIC test", 0);
    h.action(Action::Resume, 1);
    h.action(Action::Focus(true), 2);
    pair(&h, 10 * MS, 10 * MS);
    h.action(Action::Hold, 11 * MS);
    pair(&h, 20 * MS, 20 * MS);
    pair(&h, 30 * MS, 30 * MS);
    h
}
fn valid(h: &Hub) -> bool {
    let s = h.state.lock().unwrap();
    matches!(
        s.snapshots[0].values[s.selected as usize * 5 + 1],
        Value::Bit(true)
    )
}
#[test]
fn estimator_pose_and_quality_share_real_timestamp_and_no_tracking_claim() {
    let h = ready();
    assert!(h.held());
    assert!(valid(&h));
    let s = h.state.lock().unwrap();
    assert_eq!(s.snapshots[0].timestamp, 30 * MS);
    assert_eq!(s.snapshots[1].timestamp, 30 * MS);
    assert!(matches!(&s.snapshots[0].values[0],Value::Numbers(v) if (v[0]-0.00005).abs()<1e-12));
    for (i, b) in [(1, true), (2, true), (3, false), (4, true), (6, false)] {
        assert!(matches!(s.snapshots[0].values[i],Value::Bit(v) if v==b));
    }
}
#[test]
fn interpolation_wait_does_not_redate_pose_to_orientation_callback() {
    let h = ready();
    h.sensor(1, 35 * MS, [1., GRAVITY, 0., 0.], 36 * MS);
    assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 30 * MS);
    h.sensor(0, 40 * MS, upright(), 42 * MS);
    assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 35 * MS);
    assert_eq!(h.state.lock().unwrap().last[0], Some(40 * MS));
    assert!(
        matches!(&h.state.lock().unwrap().snapshots[0].values[0],Value::Numbers(v) if (v[0]-0.0001125).abs()<1e-12)
    );
}
#[test]
fn every_clutch_lifecycle_exit_discards_velocity_and_never_reactivates() {
    for action in [
        Action::Release,
        Action::Cancel,
        Action::Select(Hand::Right),
        Action::Recenter,
        Action::Pause,
        Action::Focus(false),
        Action::Shutdown,
        Action::Resume,
    ] {
        let h = ready();
        assert!(
            h.state
                .lock()
                .unwrap()
                .displacement
                .as_ref()
                .unwrap()
                .estimate
                .unwrap()
                .velocity[0]
                > 0.
        );
        h.action(action, 40 * MS);
        assert!(!h.held());
        assert!(!valid(&h));
        assert!(
            h.state
                .lock()
                .unwrap()
                .displacement
                .as_ref()
                .unwrap()
                .estimate
                .is_none()
        );
        h.action(Action::Resume, 60 * MS);
        h.action(Action::Focus(true), 61 * MS);
        pair(&h, 70 * MS, 70 * MS);
        assert!(!h.held());
        h.action(Action::Hold, 71 * MS);
        assert!(h.held());
        assert!(!valid(&h));
        pair(&h, 80 * MS, 80 * MS);
        let e = h
            .state
            .lock()
            .unwrap()
            .displacement
            .as_ref()
            .unwrap()
            .estimate
            .unwrap();
        assert_eq!(e.pose.position, [0.; 3]);
        assert_eq!(e.velocity, [0.; 3]);
    }
}
#[test]
fn required_source_missing_or_lost_cancels_even_with_fresh_orientation() {
    for available in [[true, false, true], [false, true, true]] {
        let h = Hub::displacement_at(available, "missing", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 2);
        pair(&h, 10 * MS, 10 * MS);
        h.action(Action::Hold, 11 * MS);
        assert!(!h.held());
    }
    let h = ready();
    for k in 4..31 {
        h.sensor(0, k * 10 * MS, upright(), k * 10 * MS);
        h.tick(k * 10 * MS);
    }
    assert!(!h.held());
    assert!(!valid(&h));
    assert!(h.state.lock().unwrap().fresh(0, 300 * MS));
    h.sensor(1, 300 * MS, [1., GRAVITY, 0., 0.], 300 * MS);
    assert!(!h.held());
    h.action(Action::Hold, 301 * MS);
    pair(&h, 310 * MS, 310 * MS);
    assert_eq!(
        h.state
            .lock()
            .unwrap()
            .displacement
            .as_ref()
            .unwrap()
            .estimate
            .unwrap()
            .pose
            .position,
        [0.; 3]
    );
}
#[test]
fn invalid_timestamps_nan_skew_and_gaps_release_but_duplicates_do_not() {
    for (kind, t, received, v) in [
        (1, 29, 40, [1., GRAVITY, 0., 0.]),
        (1, 41, 40, [1., GRAVITY, 0., 0.]),
        (1, 40, 40, [f64::NAN, 0., 0., 0.]),
        (0, 40, 40, [f64::NAN, 0., 0., 0.]),
        (1, 56, 56, [1., GRAVITY, 0., 0.]),
        (0, 81, 81, upright()),
    ] {
        let h = ready();
        h.sensor(kind, t * MS, v, received * MS);
        assert!(!h.held(), "{kind} {t}");
        assert!(!valid(&h));
    }
    let h = ready();
    let serial = h.state.lock().unwrap().serial;
    pair(&h, 30 * MS, 40 * MS);
    assert!(h.held());
    assert_eq!(h.state.lock().unwrap().serial, serial);
    h.tick(30 * MS + STALE_NS + 1);
    assert!(!h.held());
}
#[test]
fn sensor_phase_warmup_and_fault_recovery_do_not_require_exact_timestamp_matches() {
    let h = Hub::displacement_at([true; 3], "phase offset", 0);
    h.action(Action::Resume, 1);
    h.action(Action::Focus(true), 2);
    // Acceleration starts just before the FIRST orientation: no left bracket.
    h.sensor(1, 10 * MS, [0., GRAVITY, 0., 0.], 10 * MS);
    h.sensor(0, 11 * MS, upright(), 11 * MS);
    h.sensor(1, 20 * MS, [0., GRAVITY, 0., 0.], 20 * MS);
    h.sensor(0, 21 * MS, upright(), 21 * MS);
    h.action(Action::Hold, 22 * MS);
    assert!(h.held());
    h.sensor(1, 30 * MS, [0., GRAVITY, 0., 0.], 30 * MS);
    assert!(!valid(&h));
    h.sensor(0, 31 * MS, upright(), 31 * MS);
    assert!(valid(&h));
    assert_eq!(h.state.lock().unwrap().snapshots[0].timestamp, 30 * MS);
}
#[test]
fn action_publication_barriers_do_not_starve_delayed_source_freshness() {
    for delay in [110 * MS, 200 * MS] {
        let h = Hub::displacement_at([true; 3], "delayed sensor", 0);
        h.action(Action::Resume, 1);
        h.action(Action::Focus(true), 2);
        pair(&h, 1000 * MS, 1000 * MS + delay);
        let pressed = 1000 * MS + delay + 1;
        h.action(Action::Hold, pressed);
        assert!(h.held());
        let mut last_publication = pressed;
        for k in 1..31 {
            let t = 1000 * MS + k * 10 * MS;
            pair(&h, t, t + delay);
            h.tick(t + delay);
            assert!(h.held());
            assert_eq!(valid(&h), t >= pressed);
            let s = h.state.lock().unwrap();
            assert!(s.snapshots[0].timestamp >= last_publication);
            last_publication = s.snapshots[0].timestamp;
            assert_eq!(s.last[1], Some(t));
        }
    }
}
#[test]
fn recenter_during_hold_cancels_and_heading_does_not_follow_live_orientation() {
    let h = ready();
    let before = h.state.lock().unwrap().heading;
    let q = multiply([0., 0., (0.5_f64).sin(), (0.5_f64).cos()], upright());
    h.sensor(0, 40 * MS, q, 40 * MS);
    assert_eq!(h.state.lock().unwrap().heading, before);
    h.action(Action::Recenter, 41 * MS);
    assert!(!h.held());
    assert_ne!(h.state.lock().unwrap().heading, before);
}
