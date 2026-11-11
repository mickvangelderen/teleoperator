use base64::{Engine, prelude::BASE64_STANDARD};
use bytes::Bytes;
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const FILE_BYTES: u64 = 64 * 1024 * 1024;
const FILES: usize = 4;
const QUEUE: usize = 1024;

// Numeric timestamps are milliseconds in the acquisition Hub epoch.
// Serialization and file I/O run on a dedicated writer thread.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Event {
    Acquisition {
        sample: u64,
        acquired_ms: f64,
        body_available: bool,
    },
    Packet {
        peer: u64,
        channel: &'static str,
        action: &'static str,
        #[serde(serialize_with = "packet_base64")]
        data: Bytes,
        buffered_bytes: usize,
    },
}

fn packet_base64<S: serde::Serializer>(bytes: &Bytes, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&BASE64_STANDARD.encode(bytes))
}

#[derive(Serialize)]
struct Entry {
    sequence: u64,
    at_ms: f64,
    dropped_events: u64,
    #[serde(flatten)]
    event: Event,
}

struct Writer {
    sender: SyncSender<Entry>,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct Diagnostics {
    writer: Mutex<Option<Writer>>,
    sequence: AtomicU64,
    dropped: Arc<AtomicU64>,
}

impl Diagnostics {
    pub fn start(&self, directory: &Path, session: &str, source: &str) -> io::Result<()> {
        let mut writer = self.writer.lock().unwrap();
        if writer.is_some() {
            return Err(io::Error::other("Diagnostics already started"));
        }
        let header = serde_json::to_vec(&serde_json::json!({
            "kind": "session", "version": 2, "session": session, "source": source,
            "started_unix_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "clock": "Hub monotonic milliseconds"
        }))?;
        let mut log = RotatingLog::new(directory, header, FILE_BYTES)?;
        let (sender, receiver) = mpsc::sync_channel::<Entry>(QUEUE);
        let dropped = self.dropped.clone();
        let task = std::thread::Builder::new().name("xr-diagnostics".into()).spawn(move || {
            let result = (|| -> io::Result<()> {
                let mut flushed = Instant::now();
                loop {
                    match receiver.recv_timeout(Duration::from_secs(1)) {
                        Ok(entry) => log.write(&serde_json::to_vec(&entry)?)?,
                        Err(mpsc::RecvTimeoutError::Timeout) => {},
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    if flushed.elapsed() >= Duration::from_secs(1) {
                        log.file.flush()?;
                        flushed = Instant::now();
                    }
                }
                log.write(&serde_json::to_vec(&serde_json::json!({"kind": "recording-end", "dropped_events": dropped.load(Ordering::Relaxed)}))?)?;
                log.file.flush()
            })();
            if let Err(error) = result { log::error!("Quest diagnostic recording failed: {error}"); }
        })?;
        *writer = Some(Writer { sender, task });
        log::info!("Diagnostic recording: {}", directory.display());
        Ok(())
    }

    pub fn record(&self, at_ns: i64, event: Event) {
        let writer = self.writer.lock().unwrap();
        let Some(writer) = writer.as_ref() else {
            return;
        };
        let entry = Entry {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            at_ms: at_ns as f64 / 1e6,
            dropped_events: self.dropped.load(Ordering::Relaxed),
            event,
        };
        // A slow disk must never make acquisition or WebRTC wait. Gaps and the cumulative
        // count identify lost diagnostics separately from dropped tracking publications.
        if writer.sender.try_send(entry).is_err()
            && self.dropped.fetch_add(1, Ordering::Relaxed) == 0
        {
            log::warn!("Diagnostic events dropped: writer queue full or unavailable");
        }
    }

    pub fn stop(&self) {
        let writer = self.writer.lock().unwrap().take();
        if let Some(Writer { sender, task }) = writer {
            drop(sender);
            if task.join().is_err() {
                log::error!("Diagnostic writer panicked");
            }
        }
    }
}

impl Drop for Diagnostics {
    fn drop(&mut self) {
        self.stop();
    }
}

struct RotatingLog {
    directory: PathBuf,
    header: Vec<u8>,
    file: BufWriter<File>,
    bytes: u64,
    limit: u64,
}

impl RotatingLog {
    fn open(directory: &Path) -> io::Result<BufWriter<File>> {
        fs::create_dir_all(directory)?;
        for i in (1..FILES).rev() {
            match fs::rename(
                directory.join(format!("trace.{}.jsonl", i - 1)),
                directory.join(format!("trace.{i}.jsonl")),
            ) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(BufWriter::with_capacity(
            64 * 1024,
            File::create(directory.join("trace.0.jsonl"))?,
        ))
    }

    fn new(directory: &Path, header: Vec<u8>, limit: u64) -> io::Result<Self> {
        let file = Self::open(directory)?;
        let mut log = Self {
            directory: directory.to_owned(),
            header,
            file,
            bytes: 0,
            limit,
        };
        log.header()?;
        Ok(log)
    }

    fn header(&mut self) -> io::Result<()> {
        self.file.write_all(&self.header)?;
        self.file.write_all(b"\n")?;
        self.bytes = self.header.len() as u64 + 1;
        self.file.flush()
    }

    fn write(&mut self, line: &[u8]) -> io::Result<()> {
        if self.bytes + line.len() as u64 + 1 > self.limit {
            self.file.flush()?;
            self.file = Self::open(&self.directory)?;
            self.header()?;
        }
        self.file.write_all(line)?;
        self.file.write_all(b"\n")?;
        self.bytes += line.len() as u64 + 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("xr-diagnostics-{name}-{}", std::process::id()))
    }

    #[test]
    fn rotation_retains_complete_lines_and_session_headers_with_a_fixed_budget() {
        let dir = directory("rotation");
        let _ = fs::remove_dir_all(&dir);
        let header = br#"{"kind":"session","session":"test"}"#.to_vec();
        let mut log = RotatingLog::new(&dir, header.clone(), 128).unwrap();
        for n in 0..100 {
            log.write(&serde_json::to_vec(&serde_json::json!({"sequence": n})).unwrap())
                .unwrap();
        }
        log.file.flush().unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), FILES);
        let mut sequences = Vec::new();
        for i in (0..FILES).rev() {
            let bytes = fs::read(dir.join(format!("trace.{i}.jsonl"))).unwrap();
            assert!(bytes.len() <= 128);
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.ends_with('\n'));
            assert_eq!(text.lines().next().unwrap().as_bytes(), header);
            for line in text.lines().skip(1) {
                sequences.push(
                    serde_json::from_str::<serde_json::Value>(line).unwrap()["sequence"]
                        .as_u64()
                        .unwrap(),
                );
            }
        }
        assert!(sequences.windows(2).all(|p| p[1] == p[0] + 1));
        assert_eq!(sequences.last(), Some(&99));
        drop(log);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shutdown_flushes_local_trace_and_queue_overflow_does_not_block_producers() {
        let dir = directory("writer");
        let _ = fs::remove_dir_all(&dir);
        let trace = Diagnostics::default();
        trace.start(&dir, "session", "test").unwrap();
        trace.record(
            5_000_000,
            Event::Acquisition {
                sample: 1,
                acquired_ms: 4.,
                body_available: true,
            },
        );
        let packet = Bytes::from_static(&[0, 1, 127, 128, 255]);
        trace.record(
            6_000_000,
            Event::Packet {
                peer: 1,
                channel: "tracking",
                action: "skip-buffer",
                data: packet.clone(),
                buffered_bytes: 65_536,
            },
        );
        trace.stop();
        let text = fs::read_to_string(dir.join("trace.0.jsonl")).unwrap();
        let records: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(records[1]["sequence"], 1);
        assert_eq!(records[1]["at_ms"], 5.);
        assert_eq!(records[2]["action"], "skip-buffer");
        assert_eq!(
            BASE64_STANDARD
                .decode(records[2]["data"].as_str().unwrap())
                .unwrap(),
            packet,
        );
        assert_eq!(records.last().unwrap()["kind"], "recording-end");
        let (sender, receiver) = mpsc::sync_channel(1);
        *trace.writer.lock().unwrap() = Some(Writer {
            sender,
            task: std::thread::spawn(|| {}),
        });
        for sample in 2..=3 {
            trace.record(
                0,
                Event::Acquisition {
                    sample,
                    acquired_ms: 0.,
                    body_available: true,
                },
            );
        }
        assert_eq!(trace.dropped.load(Ordering::Relaxed), 1);
        receiver.recv().unwrap();
        trace.record(
            0,
            Event::Acquisition {
                sample: 4,
                acquired_ms: 0.,
                body_available: true,
            },
        );
        assert_eq!(receiver.recv().unwrap().dropped_events, 1);
        trace.stop();
        fs::remove_dir_all(dir).unwrap();
    }
}
