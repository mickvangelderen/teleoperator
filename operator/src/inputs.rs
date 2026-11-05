use crate::protocol::wire;
use flatbuffers::{FlatBufferBuilder as Builder, WIPOffset};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InputType {
    Boolean,
    Scalar,
    Vector2,
}
#[derive(Clone, Debug)]
pub enum Value {
    Boolean {
        value: bool,
        presses: u64,
        releases: u64,
    },
    Scalar(f32),
    Vector2([f32; 2]),
}
#[derive(Clone, Debug)]
pub struct Input {
    pub active: bool,
    pub changed_at: Option<i64>,
    pub value: Value,
}
#[derive(Clone, Copy)]
pub struct Definition {
    pub source: &'static str,
    pub id: &'static str,
    pub path: &'static str,
    pub kind: InputType,
    pub label: &'static str,
}

pub fn definitions() -> Vec<Definition> {
    let mut result = Vec::new();
    for source in ["left", "right"] {
        for (id, path, kind, label) in [
            (
                "primary/click",
                if source == "left" {
                    "x/click"
                } else {
                    "a/click"
                },
                InputType::Boolean,
                if source == "left" { "X" } else { "A" },
            ),
            (
                "primary/touch",
                if source == "left" {
                    "x/touch"
                } else {
                    "a/touch"
                },
                InputType::Boolean,
                "Primary touch",
            ),
            (
                "secondary/click",
                if source == "left" {
                    "y/click"
                } else {
                    "b/click"
                },
                InputType::Boolean,
                if source == "left" { "Y" } else { "B" },
            ),
            (
                "secondary/touch",
                if source == "left" {
                    "y/touch"
                } else {
                    "b/touch"
                },
                InputType::Boolean,
                "Secondary touch",
            ),
            (
                "squeeze/click",
                "squeeze/value",
                InputType::Boolean,
                "Grip pressed",
            ),
            ("squeeze/value", "squeeze/value", InputType::Scalar, "Grip"),
            (
                "thumbrest/touch",
                "thumbrest/touch",
                InputType::Boolean,
                "Thumbrest touch",
            ),
            (
                "thumbstick/click",
                "thumbstick/click",
                InputType::Boolean,
                "Stick click",
            ),
            (
                "thumbstick/touch",
                "thumbstick/touch",
                InputType::Boolean,
                "Stick touch",
            ),
            (
                "thumbstick/value",
                "thumbstick",
                InputType::Vector2,
                "Stick",
            ),
            (
                "trigger/click",
                "trigger/value",
                InputType::Boolean,
                "Trigger pressed",
            ),
            (
                "trigger/touch",
                "trigger/touch",
                InputType::Boolean,
                "Trigger touch",
            ),
            (
                "trigger/value",
                "trigger/value",
                InputType::Scalar,
                "Trigger",
            ),
        ] {
            result.push(Definition {
                source,
                id,
                path,
                kind,
                label,
            });
        }
        if source == "left" {
            result.push(Definition {
                source,
                id: "menu/click",
                path: "menu/click",
                kind: InputType::Boolean,
                label: "Menu",
            });
        }
    }
    result.sort_by_key(|d| (d.source, d.id));
    result
}
impl Input {
    pub fn inactive(kind: InputType) -> Self {
        Self {
            active: false,
            changed_at: None,
            value: match kind {
                InputType::Boolean => Value::Boolean {
                    value: false,
                    presses: 0,
                    releases: 0,
                },
                InputType::Scalar => Value::Scalar(0.),
                InputType::Vector2 => Value::Vector2([0.; 2]),
            },
        }
    }
    pub fn count_from(&mut self, previous: &Self) {
        if let (
            Value::Boolean {
                value,
                presses,
                releases,
            },
            Value::Boolean {
                value: old,
                presses: old_presses,
                releases: old_releases,
            },
        ) = (&mut self.value, &previous.value)
        {
            *presses = *old_presses;
            *releases = *old_releases;
            if self.active && previous.active && value != old {
                if *value {
                    *presses = presses.checked_add(1).expect("Press counter exhausted");
                } else {
                    *releases = releases.checked_add(1).expect("Release counter exhausted");
                }
            }
        }
    }
}
pub fn definition<'a>(b: &mut Builder<'a>, d: &Definition) -> WIPOffset<wire::InputDefinition<'a>> {
    let source = b.create_string(d.source);
    let id = b.create_string(d.id);
    let meaning = b.create_string(d.label);
    let unit = b.create_string(if d.kind == InputType::Boolean {
        "boolean"
    } else {
        "normalized"
    });
    let label = b.create_string(d.label);
    let min = wire::Vec2::new(
        if d.kind == InputType::Vector2 {
            -1.
        } else {
            0.
        },
        if d.kind == InputType::Vector2 {
            -1.
        } else {
            0.
        },
    );
    let max = wire::Vec2::new(1., if d.kind == InputType::Vector2 { 1. } else { 0. });
    wire::InputDefinition::create(
        b,
        &wire::InputDefinitionArgs {
            source_id: Some(source),
            input_id: Some(id),
            hand: if d.source == "left" {
                wire::Hand::Left
            } else {
                wire::Hand::Right
            },
            value_type: match d.kind {
                InputType::Boolean => wire::InputType::Boolean,
                InputType::Scalar => wire::InputType::Scalar,
                InputType::Vector2 => wire::InputType::Vector2,
            },
            meaning: Some(meaning),
            unit: Some(unit),
            minimum: Some(&min),
            maximum: Some(&max),
            device_label: Some(label),
        },
    )
}
pub fn settings<'a>(
    b: &mut Builder<'a>,
    indices: &[usize],
) -> WIPOffset<wire::ControllerSettings<'a>> {
    let definitions = definitions();
    let inputs: Vec<_> = indices
        .iter()
        .map(|&i| {
            let d = definitions[i];
            let source = b.create_string(d.source);
            let id = b.create_string(d.id);
            wire::ControlSelection::create(
                b,
                &wire::ControlSelectionArgs {
                    source_id: Some(source),
                    input_id: Some(id),
                },
            )
        })
        .collect();
    let inputs = b.create_vector(&inputs);
    wire::ControllerSettings::create(
        b,
        &wire::ControllerSettingsArgs {
            inputs: Some(inputs),
        },
    )
}
pub fn capabilities<'a>(b: &mut Builder<'a>) -> WIPOffset<wire::ControllerCapabilities<'a>> {
    let definitions = definitions();
    let sources: Vec<_> = ["left", "right"]
        .iter()
        .map(|source| {
            let id = b.create_string(source);
            let profile = b.create_string("/interaction_profiles/oculus/touch_controller");
            wire::ControllerSource::create(
                b,
                &wire::ControllerSourceArgs {
                    source_id: Some(id),
                    hand: if *source == "left" {
                        wire::Hand::Left
                    } else {
                        wire::Hand::Right
                    },
                    interaction_profile: Some(profile),
                },
            )
        })
        .collect();
    let sources = b.create_vector(&sources);
    let inputs: Vec<_> = definitions.iter().map(|d| definition(b, d)).collect();
    let inputs = b.create_vector(&inputs);
    wire::ControllerCapabilities::create(
        b,
        &wire::ControllerCapabilitiesArgs {
            sources: Some(sources),
            inputs: Some(inputs),
        },
    )
}
pub fn value<'a>(b: &mut Builder<'a>, input: &Input) -> WIPOffset<wire::ControllerValue<'a>> {
    let (kind, value) = match input.value {
        Value::Boolean {
            value,
            presses,
            releases,
        } => (
            wire::InputValue::BooleanValue,
            wire::BooleanValue::create(
                b,
                &wire::BooleanValueArgs {
                    value,
                    press_count: presses,
                    release_count: releases,
                },
            )
            .as_union_value(),
        ),
        Value::Scalar(value) => (
            wire::InputValue::ScalarValue,
            wire::ScalarValue::create(b, &wire::ScalarValueArgs { value }).as_union_value(),
        ),
        Value::Vector2(value) => (
            wire::InputValue::Vector2Value,
            wire::Vector2Value::create(
                b,
                &wire::Vector2ValueArgs {
                    value: Some(&wire::Vec2::new(value[0], value[1])),
                },
            )
            .as_union_value(),
        ),
    };
    wire::ControllerValue::create(
        b,
        &wire::ControllerValueArgs {
            is_active: input.active,
            last_change_at: input.changed_at,
            value_type: kind,
            value: Some(value),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transitions_count_during_acquisition_and_reactivation_only_rebaselines() {
        let mut previous = Input::inactive(InputType::Boolean);
        for (active, value, expected) in [
            (true, true, (0, 0)),
            (true, false, (0, 1)),
            (true, true, (1, 1)),
            (false, false, (1, 1)),
            (true, false, (1, 1)),
            (true, true, (2, 1)),
        ] {
            let mut input = Input {
                active,
                changed_at: None,
                value: Value::Boolean {
                    value,
                    presses: 0,
                    releases: 0,
                },
            };
            input.count_from(&previous);
            if let Value::Boolean {
                presses, releases, ..
            } = input.value
            {
                assert_eq!((presses, releases), expected);
            }
            previous = input;
        }
    }
}
