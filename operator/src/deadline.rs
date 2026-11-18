//! Native monotonic deadlines and level-triggered control wakeups.
pub(crate) fn now() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    assert_eq!(
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) },
        0
    );
    time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64
}

#[cfg(target_os = "android")]
pub(crate) use native::Deadline;

#[cfg(any(target_os = "android", test))]
mod native {
    #[cfg(test)]
    use super::now;
    use std::{
        io,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        sync::Arc,
    };

    fn fd(raw: i32) -> io::Result<OwnedFd> {
        if raw < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { OwnedFd::from_raw_fd(raw) })
        }
    }

    pub(crate) struct Event(OwnedFd);
    impl Event {
        pub fn notify(&self) -> io::Result<()> {
            let value = 1u64;
            loop {
                let n =
                    unsafe { libc::write(self.0.as_raw_fd(), (&value as *const u64).cast(), 8) };
                if n == 8 {
                    return Ok(());
                }
                match io::Error::last_os_error() {
                    e if e.kind() == io::ErrorKind::Interrupted => continue,
                    // The counter is full, so a wake is already pending.
                    e if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                    e => return Err(e),
                }
            }
        }
    }

    fn drain(fd: &OwnedFd) -> io::Result<()> {
        loop {
            let mut count = 0u64;
            let n = unsafe { libc::read(fd.as_raw_fd(), (&mut count as *mut u64).cast(), 8) };
            if n == 8 {
                return Ok(());
            }
            match io::Error::last_os_error() {
                e if e.kind() == io::ErrorKind::Interrupted => continue,
                e if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                e => return Err(e),
            }
        }
    }

    pub(crate) struct Deadline {
        origin: u64,
        timer: OwnedFd,
        event: Arc<Event>,
        poll: OwnedFd,
    }
    impl Deadline {
        pub fn new(origin: u64) -> io::Result<Self> {
            let timer = fd(unsafe {
                libc::timerfd_create(
                    libc::CLOCK_MONOTONIC,
                    libc::TFD_CLOEXEC | libc::TFD_NONBLOCK,
                )
            })?;
            let event = Arc::new(Event(fd(unsafe {
                libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK)
            })?));
            let poll = fd(unsafe { libc::epoll_create1(libc::EPOLL_CLOEXEC) })?;
            for (source, tag) in [(&timer, 1), (&event.0, 2)] {
                let mut interest = libc::epoll_event {
                    events: libc::EPOLLIN as u32,
                    u64: tag,
                };
                if unsafe {
                    libc::epoll_ctl(
                        poll.as_raw_fd(),
                        libc::EPOLL_CTL_ADD,
                        source.as_raw_fd(),
                        &mut interest,
                    )
                } < 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(Self {
                origin,
                timer,
                event,
                poll,
            })
        }
        pub fn event(&self) -> Arc<Event> {
            self.event.clone()
        }

        /// Arm a server-clock deadline, then wait for it or queued control work.
        /// Returns true if the timer fired (control may be ready simultaneously).
        pub fn wait(&self, deadline: Option<u64>) -> io::Result<bool> {
            let absolute = match deadline {
                Some(t) => self
                    .origin
                    .checked_add(t)
                    .filter(|t| *t <= i64::MAX as u64)
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "Deadline overflow")
                    })?,
                None => 0,
            };
            let timer = libc::itimerspec {
                it_interval: libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                },
                it_value: libc::timespec {
                    tv_sec: (absolute / 1_000_000_000) as _,
                    tv_nsec: (absolute % 1_000_000_000) as _,
                },
            };
            if unsafe {
                libc::timerfd_settime(
                    self.timer.as_raw_fd(),
                    libc::TFD_TIMER_ABSTIME,
                    &timer,
                    std::ptr::null_mut(),
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
            let mut events = [libc::epoll_event { events: 0, u64: 0 }; 2];
            loop {
                let count =
                    unsafe { libc::epoll_wait(self.poll.as_raw_fd(), events.as_mut_ptr(), 2, -1) };
                if count < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                let mut timed_out = false;
                for event in &events[..count as usize] {
                    match event.u64 {
                        1 => {
                            drain(&self.timer)?;
                            timed_out = true;
                        }
                        2 => drain(&self.event.0)?,
                        _ => unreachable!(),
                    }
                }
                return Ok(timed_out);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn queued_notification_survives_arming_and_timer_rearming() {
            let origin = now();
            let wait = Deadline::new(origin).unwrap();
            wait.event().notify().unwrap();
            assert!(!wait.wait(Some(10_000_000_000)).unwrap());
            let due = now() - origin + 1_000_000;
            assert!(wait.wait(Some(due)).unwrap());
            assert!(now() - origin >= due);
            // A consumed timer must not leak into a subsequent control-only wait.
            wait.event().notify().unwrap();
            assert!(!wait.wait(None).unwrap());
        }
        #[test]
        fn another_thread_can_interrupt_a_distant_deadline() {
            let wait = Deadline::new(now()).unwrap();
            let event = wait.event();
            let thread = std::thread::spawn(move || event.notify().unwrap());
            assert!(!wait.wait(Some(10_000_000_000)).unwrap());
            thread.join().unwrap();
        }
    }
}
