CODING AGENTS SHOULD NOT MODIFY THIS FILE

# XR operator

This project is supposed to become a Rust implementation of an android app for the Meta Quest 3 which should host a WebRTC server. The server should publish:

- controller pose and input state/changes
- XrBody samples (https://developers.meta.com/vr/documentation/native/android/move-body-tracking/)

Latency is more important than guaranteed delivery for teleoperation purposes. This is the reason to use WebRTC since it lets us deliver out of order and avoid retransmission.

The application does not need to render anything for now, it should just enable and use passthrough mode. 
