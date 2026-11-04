CODING AGENTS SHOULD NOT MODIFY THIS FILE

# XR operator

This project is supposed to become a Rust implementation of an android app for the Meta Quest 3 which should host a WebRTC server. The server should publish:

- controller pose and input state/changes
- XrBody samples (https://developers.meta.com/vr/documentation/native/android/move-body-tracking/)

Latency is more important than guaranteed delivery for teleoperation purposes. This is the reason to use WebRTC since it lets us deliver out of order and avoid retransmission.

The application does not need to render anything for now, it should just enable and use passthrough mode. 

## Implementation

The suggestion is to:

1. build an android application with Rust. 
2. ensure we can deploy the application to the Quest. 
3. implement passthrough mode and verify it works.
4. implement the webrtc server, ensure we can connect.
5. define and implement exposing the controller and button state.
6. define and implement exposing the pose stream.
7. define and implement exposing the XrBody stream.

We will need a way to verify the implementation. It will be tough to automate integration tests as it would require automating manipulation of the hardware. A virtual XR device doesn't provide much confidence in implementation correctness. The suggestion is to create a web client implemented in typescript that uses assets provided by the meta for the controller/headset/body in their docs/examples/published media for manual verification.

The implementation should happen in manageable user-verified commits. 

## Software engineering

- prefer typed languages
- use pnpm to manage node and typescript dependencies
- use a monorepo layout so every subproject goes flat under <repo>/<project>
- prefer cross platform choices where possible, do not implement untested os specific code
- prefer clean focused behavioral integration tests