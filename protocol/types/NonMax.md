# NonMax

`NonMax<T>` contains every value of the integer type `T` except `T::MAX` and uses the encoding of `T`.
`Option<NonMax<T>>` uses that encoding, with `T::MAX` for absence.
Newtypes wrapping `NonMax<T>` preserve both encodings.

For the index newtypes based on `NonMax<u32>`, present values use four little-endian bytes and `ff ff ff ff` encodes an absent optional index.

Requirements: [PRO-0020](../../design/requirements/protocol/PRO-0020.md).
