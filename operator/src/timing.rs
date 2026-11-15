//! Recent elapsed-time measurements; these never change protocol timestamps.
use serde_json::{Value, json};

const HISTORY: usize = 60;

#[derive(Clone, Debug)]
pub(crate) struct History {
    values: [i64; HISTORY],
    count: usize,
    next: usize,
}
impl Default for History {
    fn default() -> Self {
        Self {
            values: [0; HISTORY],
            count: 0,
            next: 0,
        }
    }
}
impl History {
    pub fn record(&mut self, value: i64) {
        self.values[self.next] = value;
        self.next = (self.next + 1) % HISTORY;
        self.count = (self.count + 1).min(HISTORY);
    }
    pub fn percentile(&self, percentile: usize) -> i64 {
        if self.count == 0 {
            return 0;
        }
        let mut sorted = self.values;
        sorted[..self.count].sort_unstable();
        sorted[(self.count * percentile)
            .div_ceil(100)
            .saturating_sub(1)
            .min(self.count - 1)]
    }
    pub fn summary(&self) -> Value {
        let n = self.count.max(1) as f64;
        let mean = self.values[..self.count]
            .iter()
            .map(|v| *v as f64)
            .sum::<f64>()
            / n;
        let variance = self.values[..self.count]
            .iter()
            .map(|v| (*v as f64 - mean).powi(2))
            .sum::<f64>()
            / n;
        json!({"n": self.count, "mean_us": mean / 1e3, "stddev_us": variance.sqrt() / 1e3,
            "p50_us": self.percentile(50) as f64 / 1e3, "p90_us": self.percentile(90) as f64 / 1e3,
            "p99_us": self.percentile(99) as f64 / 1e3})
    }
}

/// A missed attempt supplies only a lower bound: remaining work was not timed.
/// Expand its budget until an entire attempt can be observed, then use recent
/// complete costs. Cache the estimate so deadline scans do not sort histories.
#[derive(Default)]
pub(crate) struct Preparation {
    observations: History,
    lead: u64,
}
impl Preparation {
    pub fn lead(&self) -> u64 {
        self.lead
    }
    pub fn observe(&mut self, elapsed: u64, completed: bool) {
        // Expired attempts are lower bounds, but omitting them would bias the
        // percentile toward fast attempts precisely when the deadline is tight.
        self.observations.record(elapsed.min(i64::MAX as u64) as i64);
        if completed {
            // Adapt immediately to a cost increase. One clock tick keeps an
            // exactly predicted completion before a zero-delay deadline.
            self.lead = (self.observations.percentile(90).max(0) as u64)
                .max(elapsed)
                .saturating_add(1);
        } else {
            self.lead = self.lead.max(elapsed.saturating_mul(2).saturating_add(1));
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CaptureTiming {
    pub publication_at: Option<u64>,
    pub target_at: Option<i64>,
    pub intended_wake_at: u64,
    pub wake_at: u64,
    pub started_at: u64,
    pub completed_at: u64,
}

#[derive(Default)]
pub(crate) struct Diagnostics {
    last_report: u64,
    selection_lateness: History,
    acquisition_queue: History,
    acquisition: History,
    handoff: History,
    encoding: History,
    submission: History,
    total: History,
    publication_error: History,
    represented_error: History,
    prediction_lead: History,
}
impl Diagnostics {
    pub fn record(
        &mut self,
        capture: &CaptureTiming,
        sender_at: u64,
        encoded_at: u64,
        submitted_at: u64,
        acquired_at: i64,
        represented_at: Option<i64>,
    ) -> Option<Value> {
        self.selection_lateness
            .record(capture.wake_at.saturating_sub(capture.intended_wake_at) as i64);
        self.acquisition_queue
            .record(capture.started_at.saturating_sub(capture.wake_at) as i64);
        self.acquisition
            .record(capture.completed_at.saturating_sub(capture.started_at) as i64);
        self.handoff
            .record(sender_at.saturating_sub(capture.completed_at) as i64);
        self.encoding
            .record(encoded_at.saturating_sub(sender_at) as i64);
        self.submission
            .record(submitted_at.saturating_sub(encoded_at) as i64);
        self.total.record(submitted_at as i64 - acquired_at);
        if let Some(p) = capture.publication_at {
            self.publication_error
                .record(submitted_at as i64 - p as i64);
        }
        if let Some(r) = represented_at {
            self.prediction_lead.record(r - acquired_at);
            if let Some(target) = capture.target_at {
                self.represented_error.record(r - target);
            }
        }
        if submitted_at.saturating_sub(self.last_report) < 5_000_000_000 {
            return None;
        }
        self.last_report = submitted_at;
        Some(
            json!({"selection_lateness": self.selection_lateness.summary(), "acquisition_queue": self.acquisition_queue.summary(), "acquisition": self.acquisition.summary(),
            "sender_handoff": self.handoff.summary(), "encoding": self.encoding.summary(),
            "transport_submission": self.submission.summary(), "acquisition_to_submission": self.total.summary(),
            "publication_error": self.publication_error.summary(), "represented_minus_acquired": self.prediction_lead.summary(), "represented_minus_target": self.represented_error.summary()}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_tracks_recent_work_without_retaining_old_stalls_forever() {
        let mut h = History::default();
        assert_eq!(h.percentile(90), 0);
        for _ in 0..60 {
            h.record(100);
        }
        h.record(10_000);
        assert_eq!(h.percentile(90), 100);
        for _ in 0..60 {
            h.record(50);
        }
        assert_eq!(h.percentile(99), 50);
    }
}
