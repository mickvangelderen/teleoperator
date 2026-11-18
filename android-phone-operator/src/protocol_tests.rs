use super::*;
fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../protocol/testdata/specification-v1.json"
    ))
    .unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn number(v: &serde_json::Value) -> u64 {
    v.as_str()
        .map(|s| s.parse().unwrap())
        .unwrap_or_else(|| v.as_u64().unwrap())
}
fn optional(v: &serde_json::Value) -> Option<u64> {
    (!v.is_null()).then(|| number(v))
}
fn fixture_capabilities(v: &serde_json::Value) -> Capabilities {
    let index = |v: &serde_json::Value, field: &str| v[field].as_u64().map(|n| n as u32);
    Capabilities {
        groups: v["sample_groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["max_sample_rate_hz"].as_f64().unwrap() as f32)
            .collect(),
        descriptors: v["sample_descriptors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| Descriptor {
                id: d["id"].as_str().unwrap().into(),
                name: d["name"].as_str().unwrap().into(),
                description: d["description"].as_str().unwrap().into(),
                kind: d["kind"].as_u64().unwrap() as u8,
                group: index(d, "group").unwrap(),
                formats: d["supported_formats"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|f| f.as_u64().unwrap() as u8)
                    .collect(),
                spaces: d["supported_spaces"].as_array().map_or_else(Vec::new, |s| {
                    s.iter().map(|v| v.as_u64().unwrap() as u8).collect()
                }),
                press_count_sample: index(d, "press_count_sample"),
                release_count_sample: index(d, "release_count_sample"),
                touch_count_sample: index(d, "touch_count_sample"),
                untouch_count_sample: index(d, "untouch_count_sample"),
                position_valid_sample: index(d, "position_valid_sample"),
                orientation_valid_sample: index(d, "orientation_valid_sample"),
                position_tracked_sample: index(d, "position_tracked_sample"),
                orientation_tracked_sample: index(d, "orientation_tracked_sample"),
                confidence_sample: index(d, "confidence_sample"),
                revision_of: index(d, "revision_of"),
            })
            .collect(),
        skeletons: v["skeletons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                s["joints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|j| Joint {
                        parent: index(j, "parent").unwrap(),
                        pose_sample: index(j, "pose_sample").unwrap(),
                        rest_pose_sample: index(j, "rest_pose_sample").unwrap(),
                    })
                    .collect()
            })
            .collect(),
    }
}
fn encode_value(value: &Value, kind: u8, format: u8) -> Option<Vec<u8>> {
    let mut buffer = Vec::new();
    encode_value_into(value, kind, format, &mut buffer)?;
    Some(buffer)
}
#[test]
fn all_formats_and_invalid_source_values() {
    for entry in fixture()["formats"].as_array().unwrap() {
        let f = entry["format"].as_u64().unwrap() as u8;
        let n = entry["value"].as_str().unwrap();
        let value = match f {
            1 => Value::Bit(true),
            2..=5 => Value::Unsigned(n.parse().unwrap()),
            6..=9 => Value::Signed(n.parse().unwrap()),
            _ => Value::Numbers(vec![n.parse().unwrap()]),
        };
        assert_eq!(
            encode_value(&value, 1, f).unwrap(),
            hex(entry["hex"].as_str().unwrap())
        );
    }
    assert!(encode_value(&Value::Unsigned(256), 1, 2).is_none());
    assert_eq!(encode_value(&Value::Unsigned(256), 3, 2).unwrap(), [0]);
    assert!(encode_value(&Value::Signed(128), 1, 6).is_none());
    for f in [10, 11, 12, 13] {
        for n in [
            f64::NAN,
            f64::INFINITY,
            -0.1,
            1.1,
            1.0 + f64::EPSILON,
            -f64::EPSILON,
        ] {
            assert!(encode_value(&Value::Numbers(vec![n]), 8, f).is_none());
        }
    }
    assert_eq!(
        encode_value(&Value::Numbers(vec![2.5 / 255.]), 8, 12).unwrap(),
        [2]
    );
    assert_eq!(
        encode_value(&Value::Numbers(vec![3.5 / 255.]), 8, 12).unwrap(),
        [4]
    );
    assert!(encode_value(&Value::Numbers(vec![f64::NAN]), 1, 11).is_some());
    for f in [10, 11] {
        let tolerance: f64 = if f == 10 { 1e-5 } else { 1e-12 };
        for (error, expected) in [(tolerance / 2., true), (tolerance * 2., false)] {
            assert_eq!(
                valid_numbers(10, f, &[0., 0., 0., 0., 0., 0., (1. + error).sqrt()]),
                expected
            );
        }
        assert!(!valid_numbers(10, f, &[0.; 7]));
    }
}

fn timing(v: &serde_json::Value) -> Timing {
    Timing {
        interval: number(&v["interval"]),
        phase: number(&v["phase"]),
        prediction_offset: number(&v["prediction_offset"]),
    }
}
fn fixture_request(v: &serde_json::Value) -> Request {
    Request {
        id: number(&v["subscription_id"]) as u32,
        group: number(&v["group"]) as u32,
        channel: number(&v["channel"]) as u8,
        interval: number(&v["interval"]),
        phase: number(&v["phase"]),
        prediction_offset: number(&v["prediction_offset"]),
        sequence_number_format: SequenceNumberFormat::from_tag(
            v["sequence_number_format"].as_u64().unwrap_or(0) as u8,
        )
        .unwrap(),
        bundles: v["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bundle| {
                bundle
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| SampleBinding {
                        descriptor: number(&s["descriptor"]) as u32,
                        format: number(&s["format"]) as u8,
                        space: s["reference_space"].as_u64().unwrap_or(0) as u8,
                    })
                    .collect()
            })
            .collect(),
    }
}
fn request(name: &str) -> (Capabilities, Request) {
    let f = fixture();
    let setup = &f["requests"][name];
    (
        fixture_capabilities(&f["capabilities"][setup["capabilities"].as_str().unwrap()]),
        fixture_request(&setup["value"]),
    )
}
fn session(name: &str) -> Session {
    let (c, r) = request(name);
    let mut s = Session::new(c);
    s.handle(Message::Offer(vec![1]), 0).unwrap();
    s.handle(Message::Subscribe(r), 0).unwrap();
    s
}
#[test]
fn independent_control_and_publication_vectors() {
    let f = fixture();
    for record in f["records"].as_array().unwrap() {
        let v = &record["value"];
        let id = || number(&v["subscription_id"]) as u32;
        let message = match record["tag"].as_u64().unwrap() {
            1 => Message::Offer(
                v["supported_versions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| number(n) as u16)
                    .collect(),
            ),
            2 => Message::Selection(number(&v["selected_version"]) as u16),
            3 => {
                let mut c = f["capabilities"][record["capabilities"].as_str().unwrap()].clone();
                if let Some(skeletons) = record.get("skeletons") {
                    c["skeletons"] = skeletons.clone();
                }
                let c = fixture_capabilities(&c);
                c.validate().unwrap();
                Message::Capabilities(c.into())
            }
            4 => {
                let (c, r) = request(record["request"].as_str().unwrap());
                let wire = hex(record["hex"].as_str().unwrap());
                assert_eq!(decode_subscription(&wire[1..], &c).unwrap(), r);
                for end in 0..wire.len() - 1 {
                    assert!(decode_subscription(&wire[1..=end], &c).is_err());
                }
                c.validate_request(&r).unwrap();
                Message::Subscribe(r)
            }
            5 => Message::Accepted { id: id() },
            6 => Message::Rejected {
                id: id(),
                reason: v["reason"].as_str().map(str::to_owned),
            },
            7 => Message::Unsubscribe { id: id() },
            8 => Message::Ended {
                id: id(),
                reason: v["reason"].as_str().unwrap().into(),
            },
            12 => Message::UpdateSchedule {
                id: id(),
                timing: timing(v),
            },
            tag => panic!("Unexpected record {tag}"),
        };
        let expected = hex(record["hex"].as_str().unwrap());
        assert_eq!(encode(&message), expected, "{}", record["name"]);
        if matches!(
            message,
            Message::Offer(_) | Message::Unsubscribe { .. } | Message::UpdateSchedule { .. }
        ) {
            assert_eq!(decode_client(&expected).unwrap(), message);
        }
    }
    for publication in f["publications"].as_array().unwrap() {
        let v = &publication["value"];
        for name in publication["requests"].as_array().unwrap() {
            let (c, r) = request(name.as_str().unwrap());
            let bundles = v["bundles"]
                .as_array()
                .unwrap()
                .iter()
                .zip(&r.bundles)
                .map(|(bundle, bindings)| {
                    bundle.as_array().map(|bundle| {
                        let values = bundle
                            .iter()
                            .zip(bindings)
                            .map(|(v, b)| match b.format {
                                1 => Value::Bit(v.as_bool().unwrap()),
                                2..=5 => Value::Unsigned(number(v)),
                                6..=9 => Value::Signed(v.as_i64().unwrap()),
                                _ => Value::Numbers(v.as_array().map_or_else(
                                    || vec![v.as_f64().unwrap()],
                                    |parts| parts.iter().map(|v| v.as_f64().unwrap()).collect(),
                                )),
                            })
                            .collect::<Vec<_>>();
                        encode_bundle(&c, bindings, &values).unwrap()
                    })
                })
                .collect::<Vec<_>>();
            let body = publication_body(
                r.id,
                number(&v["acquired_at"]),
                optional(&v["predicted_for"]),
                r.sequence_number_format,
                optional(&v["sequence_number"]),
                &bundles.iter().map(|b| b.as_deref()).collect::<Vec<_>>(),
            )
            .unwrap();
            let mut expected = hex(publication["hex"].as_str().unwrap());
            if publication["name"] == "ignored_bitmap_padding" {
                // Independent corpus deliberately sets ignored high bits; writer emits canonical zero padding.
                expected[23] &= 3;
                expected[24] &= 1;
                expected[26] &= 1;
            }
            assert_eq!(
                encode(&Message::Publication(body)),
                expected,
                "{} / {name}",
                publication["name"]
            );
        }
    }
    for d in f["datagrams"].as_array().unwrap() {
        let v = &d["value"];
        let bytes = hex(d["hex"].as_str().unwrap());
        match d["tag"].as_u64().unwrap() {
            11 => assert_eq!(
                clock_response(
                    number(&v["request_id"]) as u32,
                    number(&v["received_at"]),
                    number(&v["sent_at"])
                ),
                bytes
            ),
            13 => {
                let (_, r) = request(d["request"].as_str().unwrap());
                assert_eq!(
                    decode_acknowledgment(&bytes, r.sequence_number_format.unwrap()).unwrap(),
                    (r.id, number(&v["sequence_number"]))
                );
                for end in 0..bytes.len() {
                    assert!(
                        decode_acknowledgment(&bytes[..end], r.sequence_number_format.unwrap())
                            .is_err()
                    );
                }
            }
            10 => {}
            tag => panic!("Unknown datagram {tag}"),
        }
    }
}
fn observed(state: &mut PublicationState, values: Vec<Vec<u8>>, number: u64) {
    state.observe(EncodedAcquisition {
        number,
        acquired_at: number,
        predicted_for: None,
        bundles: values,
    });
}
fn pending(state: &PublicationState) -> Vec<usize> {
    state
        .states
        .iter()
        .enumerate()
        .skip(1)
        .filter_map(|(i, s)| s.pending.then_some(i))
        .collect()
}
#[test]
fn independent_ack_loss_delay_supersession_and_wrap_traces() {
    for trace in fixture()["acknowledgment_traces"].as_array().unwrap() {
        for channel in [1, 2] {
            let (_, mut r) = request("mixed");
            let count = trace["steps"][0]["acquire"].as_array().unwrap().len();
            r.channel = channel;
            r.bundles = vec![vec![]; count + 1];
            if trace["continuous"].as_bool().unwrap() {
                r.bundles[0].push(SampleBinding {
                    descriptor: 0,
                    format: 1,
                    space: 0,
                });
            }
            r.sequence_number_format = SequenceNumberFormat::from_tag(
                trace["sequence_format"].as_u64().unwrap_or(0) as u8,
            )
            .unwrap();
            let mut state = PublicationState::new(&r, 0);
            state.next_sequence = number(&trace["initial_sequence"]);
            state.history_limit = number(&trace["history_limit"]) as usize;
            for (n, step) in trace["steps"].as_array().unwrap().iter().enumerate() {
                if let Some(acquire) = step.get("acquire") {
                    let mut values = vec![if r.bundles[0].is_empty() {
                        vec![]
                    } else {
                        vec![1]
                    }];
                    values.extend(
                        acquire
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| hex(v.as_str().unwrap())),
                    );
                    observed(&mut state, values, n as u64);
                }
                if let Some(expected) = step.get("publish") {
                    let candidate = state.candidate();
                    if expected.is_null() {
                        assert!(candidate.is_none());
                    } else {
                        let candidate = candidate.unwrap();
                        assert_eq!(candidate.sequence, Some(number(&expected["sequence"])));
                        let included = std::iter::once(0)
                            .chain(candidate.revisions.iter().map(|(i, _)| *i))
                            .collect::<Vec<_>>();
                        assert_eq!(
                            included,
                            expected["included"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|v| number(v) as usize)
                                .collect::<Vec<_>>()
                        );
                        state.submitted(candidate);
                    }
                }
                if let Some(ack) = step.get("ack") {
                    state.acknowledge(number(ack));
                }
                if let Some(expected) = step.get("pending") {
                    assert_eq!(
                        pending(&state),
                        expected
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| number(v) as usize)
                            .collect::<Vec<_>>(),
                        "{} step {n}",
                        trace["name"]
                    );
                }
            }
        }
    }
}
#[test]
fn observed_aba_and_change_during_send_never_acknowledge_new_state() {
    let (_, r) = request("mixed");
    let mut state = PublicationState::new(&r, 0);
    observed(&mut state, vec![vec![0], vec![1], vec![2]], 1);
    let candidate = state.candidate().unwrap();
    observed(&mut state, vec![vec![0], vec![3], vec![2]], 2);
    observed(&mut state, vec![vec![0], vec![1], vec![2]], 3);
    state.submitted(candidate);
    state.acknowledge(0);
    assert_eq!(pending(&state), vec![1]);
    let candidate = state.candidate().unwrap();
    state.submitted(candidate);
    state.acknowledge(1);
    assert!(pending(&state).is_empty());
}
#[test]
fn bounded_history_retires_half_range_even_during_continuous_only_sends() {
    for format in [
        SequenceNumberFormat::U16,
        SequenceNumberFormat::U32,
        SequenceNumberFormat::U64,
    ] {
        let (_, mut r) = request("mixed");
        r.sequence_number_format = Some(format);
        let mut state = PublicationState::new(&r, 0);
        observed(&mut state, vec![vec![0], vec![1], vec![2]], 1);
        for _ in 0..1000 {
            let candidate = state.candidate().unwrap();
            state.submitted(candidate);
        }
        assert!(state.history.len() <= SENT_HISTORY_LIMIT);
        state.acknowledge(0);
        assert_eq!(pending(&state), vec![1, 2]);
        state.acknowledge(999);
        assert!(pending(&state).is_empty());
        state.next_sequence = 998 + format.half();
        let candidate = state.candidate().unwrap();
        state.submitted(candidate);
        assert!(state.history.is_empty());
        state.next_sequence = format.mask();
        let c = state.candidate().unwrap();
        assert_eq!(c.sequence, Some(format.mask()));
        state.submitted(c);
        assert_eq!(state.candidate().unwrap().sequence, Some(0));
    }
}
#[test]
fn independent_timing_initial_targets_updates_and_cached_retries() {
    let (_, mut r) = request("mixed");
    for example in fixture()["schedule_examples"].as_array().unwrap() {
        let t = timing(example);
        let next = t.next_at(number(&example["now"]));
        assert_eq!(next, optional(&example["next_publication_time"]));
        assert_eq!(
            next.and_then(|n| t.target_at(n)),
            optional(&example["target_time"])
        );
    }
    for e in fixture()["initial_target_examples"].as_array().unwrap() {
        let t = timing(e);
        r.interval = t.interval;
        r.phase = t.phase;
        r.prediction_offset = t.prediction_offset;
        let state = PublicationState::new(&r, number(&e["opportunity_time"]));
        assert_eq!(
            state.requested_target(number(&e["opportunity_time"])),
            optional(&e["requested_target"])
        );
    }
    r.interval = 20;
    r.phase = 5;
    r.prediction_offset = 0;
    let mut state = PublicationState::new(&r, 100);
    assert!(!state.opportunity(101)); // no acquisition yet
    observed(&mut state, vec![vec![0], vec![1], vec![2]], 10);
    assert!(state.opportunity(105));
    assert!(!state.opportunity(105));
    assert_eq!(state.next_wake(), Some(125));
    let candidate = state.candidate().unwrap();
    state.submitted(candidate);
    assert!(state.opportunity(181));
    assert!(!state.opportunity(181));
    assert_eq!(state.next_wake(), Some(185));
    let candidate = state.candidate().unwrap();
    assert_eq!(candidate.sequence, Some(1));
    assert_eq!(&candidate.body[4..12], &10u64.to_le_bytes());
    state.update(
        Timing {
            interval: 30,
            phase: 8,
            prediction_offset: 50,
        },
        182,
    );
    assert_eq!(state.next_wake(), Some(188));
    assert!(!state.opportunity(182));
    assert_eq!(state.next_sequence, 1);
    state.acknowledge(0);
    assert!(pending(&state).is_empty());
    assert!(state.opportunity(188)); // no immediate repeat after update
    // An unsent candidate consumes no sequence; a skipped slot also consumes none.
    assert_eq!(state.candidate().unwrap().sequence, Some(1));
}
#[test]
fn independent_reliable_control_outcomes() {
    for case in fixture()["message_outcomes"].as_array().unwrap() {
        let bytes = hex(case["hex"].as_str().unwrap());
        if case["channel"] != 2 || bytes.first() == Some(&9) {
            continue;
        } // publication reception belongs to the client
        let name = case["request"].as_str().unwrap_or("mixed");
        let (c, r) = request(name);
        let mut s = Session::new(c);
        s.handle(Message::Offer(vec![1]), 0).unwrap();
        if case.get("request").is_some() && case["subscription_state"] != "ended" {
            s.handle(Message::Subscribe(r.clone()), 0).unwrap();
        }
        if let Some(n) = case["limits"]["max_publication_bytes"].as_u64() {
            s.packet_limit = n as usize;
        }
        if let Some(n) = case["limits"]["max_publication_rate_hz"].as_f64() {
            s.max_publication_rate_hz = n;
        }
        let limit = case["limits"]["max_message_bytes"]
            .as_u64()
            .map_or(MAX_CLIENT_MESSAGE, |n| n as usize);
        let result = decode_client_with_limit(&bytes, limit).and_then(|m| s.handle(m, 0));
        let outcome = match result {
            Err(_) => "close_connection",
            Ok(replies) => match replies.first() {
                Some(Message::Rejected { .. }) => "reject_subscription",
                Some(Message::Ended { .. }) => "terminate_subscription",
                None => "ignore_update",
                _ => "unexpected",
            },
        };
        assert_eq!(
            outcome,
            case["outcome"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        if outcome == "reject_subscription" {
            assert_eq!(s.active[&r.id].request, r);
        }
    }
}
#[test]
fn replacement_and_fresh_id_isolation_on_both_channels() {
    for channel in [1, 2] {
        let mut s = session("mixed");
        let mut r = s.active[&11].request.clone();
        r.channel = channel;
        let old = s.active[&11].publication.clone();
        observed(&mut old.lock().unwrap(), vec![vec![0], vec![1], vec![2]], 1);
        let candidate = old.lock().unwrap().candidate().unwrap();
        old.lock().unwrap().submitted(candidate);
        r.id = 12;
        s.handle(Message::Subscribe(r.clone()), 0).unwrap();
        let fresh = s.active[&12].publication.clone();
        observed(
            &mut fresh.lock().unwrap(),
            vec![vec![0], vec![1], vec![2]],
            1,
        );
        let candidate = fresh.lock().unwrap().candidate().unwrap();
        fresh.lock().unwrap().submitted(candidate);
        s.acknowledge(&[13, 11, 0, 0, 0, 0, 0]);
        assert_eq!(pending(&fresh.lock().unwrap()), vec![1, 2]);
        let replies = s.handle(Message::Subscribe(r), 1).unwrap();
        assert_eq!(replies, vec![Message::Accepted { id: 12 }]);
        assert!(!std::sync::Arc::ptr_eq(&fresh, &s.active[&12].publication));
        assert_eq!(s.active[&12].publication.lock().unwrap().next_sequence, 0);
        assert_eq!(
            pending(&s.active[&12].publication.lock().unwrap()),
            vec![1, 2]
        );
    }
}
#[test]
fn capability_references_hierarchies_spaces_and_repeated_bindings() {
    let (mut c, mut r) = request("quality");
    c.validate().unwrap();
    let repeated = r.bundles[1][0].clone();
    r.bundles[1].push(repeated);
    c.validate_request(&r).unwrap();
    let original = c.clone();
    c.skeletons[0][0].parent = 1;
    assert!(c.validate().is_err());
    c = original.clone();
    c.skeletons[0].push(Joint {
        parent: 2,
        pose_sample: 16,
        rest_pose_sample: 17,
    });
    assert!(c.validate().is_err());
    c = original.clone();
    c.skeletons.clear();
    assert!(c.validate().is_err());
    c = original.clone();
    c.descriptors[0].press_count_sample = Some(2);
    assert!(c.validate().is_err());
    c = original.clone();
    c.groups[0] = f32::NAN;
    assert!(c.validate().is_err());
    c = original.clone();
    c.descriptors[0].formats = vec![4];
    assert!(c.validate().is_err());
    c = original.clone();
    c.descriptors[14].revision_of = Some(900);
    assert!(c.validate().is_err());
    for case in fixture()["capability_cases"].as_array().unwrap() {
        let mut value = fixture()["capabilities"]["device"].clone();
        value["skeletons"] = case["skeletons"].clone();
        for (index, spaces) in case["descriptor_spaces"].as_object().unwrap() {
            value["sample_descriptors"][index.parse::<usize>().unwrap()]["supported_spaces"] =
                spaces.clone();
        }
        assert_eq!(
            fixture_capabilities(&value).validate().is_ok(),
            case["valid"].as_bool().unwrap()
        );
    }
    // Acquisition rates do not cap publication frequency.
    c = original;
    c.groups[0] = 1.;
    r.interval = 5_000_000;
    let mut s = Session::new(c);
    s.handle(Message::Offer(vec![1]), 0).unwrap();
    assert_eq!(
        s.handle(Message::Subscribe(r), 0).unwrap(),
        vec![Message::Accepted { id: 8 }]
    );
}

#[test]
fn server_acknowledgment_discard_vectors_preserve_live_pending_state() {
    let f = fixture();
    let mut count = 0;
    for case in f["message_outcomes"].as_array().unwrap() {
        let bytes = hex(case["hex"].as_str().unwrap());
        if case["channel"] != 1 || bytes.first() != Some(&13) {
            continue;
        }
        count += 1;
        let name = case["request"].as_str().unwrap();
        let s = session(name);
        let (_, r) = request(name);
        let state = s.active[&r.id].publication.clone();
        observed(
            &mut state.lock().unwrap(),
            vec![vec![0]; r.bundles.len()],
            1,
        );
        for _ in 0..2 {
            let c = state.lock().unwrap().candidate().unwrap();
            state.lock().unwrap().submitted(c);
        }
        let before = format!("{:?}", state.lock().unwrap());
        s.acknowledge(&bytes);
        assert_eq!(
            format!("{:?}", state.lock().unwrap()),
            before,
            "{}",
            case["name"]
        );
        if let Some(format) = r.sequence_number_format {
            let mut ack = vec![13];
            ack.extend(r.id.to_le_bytes());
            ack.extend(&0u64.to_le_bytes()[..format.width()]);
            s.acknowledge(&ack);
            assert!(
                pending(&state.lock().unwrap()).is_empty(),
                "A real exact ACK proves that the discard check had live pending state"
            );
        }
    }
    assert_eq!(count, 4);
    // Exercise expiration through the public session dispatch, too.
    let s = session("mixed");
    let state = s.active[&11].publication.clone();
    observed(
        &mut state.lock().unwrap(),
        vec![vec![0], vec![1], vec![2]],
        1,
    );
    for _ in 0..=SENT_HISTORY_LIMIT {
        let c = state.lock().unwrap().candidate().unwrap();
        state.lock().unwrap().submitted(c);
    }
    s.acknowledge(&[13, 11, 0, 0, 0, 0, 0]);
    assert_eq!(pending(&state.lock().unwrap()), vec![1, 2]);
    let last = SENT_HISTORY_LIMIT as u16;
    let mut ack = vec![13, 11, 0, 0, 0];
    ack.extend(last.to_le_bytes());
    s.acknowledge(&ack);
    assert!(pending(&state.lock().unwrap()).is_empty());
}
#[test]
fn one_admission_policy_controls_subscriptions_updates_and_source_checks() {
    let (c, mut r) = request("mixed");
    let mut s = Session::new(c);
    s.handle(Message::Offer(vec![1]), 0).unwrap();
    s.max_publication_rate_hz = 1000.;
    r.interval = 1_000_000;
    let mut calls = 0;
    let replies = s
        .handle_with_source(Message::Subscribe(r.clone()), 0, |_| {
            calls += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(replies, vec![Message::Accepted { id: 11 }]);
    assert_eq!(calls, 1);
    s.handle(
        Message::UpdateSchedule {
            id: 11,
            timing: Timing {
                interval: 2_000_000,
                phase: 0,
                prediction_offset: 0,
            },
        },
        0,
    )
    .unwrap();
    assert_eq!(
        s.active[&11].request.interval, 2_000_000,
        "No second hardcoded 200 Hz admission policy"
    );
    let before = s.active[&11].publication.clone();
    let rejected = s
        .handle_with_source(Message::Subscribe(r.clone()), 0, |_| {
            Err("Source unavailable".into())
        })
        .unwrap();
    assert!(matches!(&rejected[..], [Message::Rejected { id: 11, .. }]));
    assert!(Arc::ptr_eq(&before, &s.active[&11].publication));
    r.channel = 3;
    assert!(
        s.handle_with_source(Message::Subscribe(r), 0, |_| panic!(
            "Malformed requests cannot reach source admission"
        ))
        .is_err()
    );
}
