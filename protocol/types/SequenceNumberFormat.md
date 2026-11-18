# SequenceNumberFormat

A `u8` selecting a publication's wrapping unsigned sequence representation.

| Format | Tag | Sequence bytes |
| ------ | --- | -------------- |
| `u16` | `0x01` | 2 |
| `u32` | `0x02` | 4 |
| `u64` | `0x03` | 8 |

Other tags are invalid as a `SequenceNumberFormat`.
`Option<SequenceNumberFormat>` occupies one byte: `0x00` means absent, and `0x01` through `0x03` select the corresponding format.
There is no additional presence byte.
The sequence itself uses the selected little-endian integer, with every value valid, including the maximum.

Number publications from zero, increasing by one modulo `2^w` for width `w` each time a publication is submitted to the transport.
A repeated pending bundle is a new publication with a new sequence number.
An unsent candidate or a skipped slot consumes no number.
Replacement starts a new subscription sequence at zero.

For ordering, `a` is newer than `b` when `0 < (a - b) mod 2^w < 2^(w-1)`.
Equal numbers are duplicates; a difference of exactly half the range is ambiguous and must not advance receiver state.
Compare against the newest publication received for the subscription, not each bundle's last sequence.
This comparison assumes the forward gap and reordering distance relative to that newest publication are each less than half the sequence range.
An unchanged bundle can remain omitted for arbitrarily many publications while the subscription's sequence tracking continues.
An acknowledgment identifies an exact sent publication, not a cumulative sequence boundary.

Choose a width large enough that delayed publications and acknowledgments cannot survive sequence reuse, and retire sent-history entries before they are half the sequence range behind the latest sent publication.
The wire cannot distinguish an old acknowledgment from a new one after a full wrap, or an old publication after same-id replacement.
Use fresh subscription ids when this assumption cannot be maintained; see [replacement](../interactions/05-replacement.md).

Requirements: [PRO-0024](../../design/requirements/protocol/PRO-0024.md), [PRO-0028](../../design/requirements/protocol/PRO-0028.md).
