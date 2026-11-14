# Unreliable on-change publication

## Motivation

An on-change update lost over an unreliable channel can leave the receiver stale indefinitely.
Reliable delivery also retransmits superseded updates, while periodic refreshes keep sending unchanged data.
The goal is to deliver the latest state eventually, while communication continues, without waiting for older states or continuing to send after receipt.

WebRTC has no `retransmit_latest` option; this needs application-level acknowledgements ([WebRTC delivery controls](https://www.w3.org/TR/webrtc/#dom-rtcdatachannelinit)).

## Rough mechanism

- Identify each state update within its subscription generation.
- Keep only the latest complete state pending and send it immediately on change.
- Retry the pending state at a controlled interval until acknowledged.
- A newer state replaces the pending state and is sent without waiting for an acknowledgement.
- The receiver applies newer states, ignores older states, and acknowledges duplicates so lost acknowledgements can be repaired.
- An acknowledgement clears pending state only if it identifies that state.
- Connection loss discards pending state.

Retry timing and the acknowledgement channel remain open design choices.
This is additional protocol behavior beyond plain `OnChange` publication.
